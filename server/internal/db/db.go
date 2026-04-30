// Package db 负责打开和配置 BookFree 使用的 SQLite 数据库连接。
//
// 对 Go 初学者来说，可以把这个包理解为“数据库连接工厂”：
// - main.go 启动时会调用 db.Open(cfg.DBURL)；
// - Open 会把配置中的数据库地址转换成 SQLite 驱动能识别的 DSN；
// - 然后创建 *sql.DB；
// - 最后设置连接池参数，并通过 PingContext 验证数据库是否可用。
//
// 这里虽然文件名叫 db.go，但它并不直接写业务 SQL。
// 真正的业务查询分散在 books、auth、notes、search 等 internal 包里。
// 本包只负责“怎么连接 SQLite”。
//
// 为什么 BookFree 默认使用 SQLite？
// 1. 自托管简单：一个数据库文件即可备份和迁移；
// 2. 常驻内存低：不需要额外启动 PostgreSQL/MySQL 服务；
// 3. 对个人阅读器、小团队部署来说足够可靠；
// 4. 配合 WAL、FTS5 可以支持书籍元数据、笔记、全文搜索等核心能力。
//
// 这也符合本项目的约束：Go 单体后端 + 轻量部署 + 空闲/轻负载内存尽量控制在 50MB 内。
package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"time"

	/*
	 * 这是一个“匿名导入”。
	 *
	 * Go 语法里 `_ "包名"` 表示：
	 * - 导入这个包；
	 * - 但当前文件不直接通过包名调用它；
	 * - 只需要它执行 init() 注册副作用。
	 *
	 * github.com/mattn/go-sqlite3 会在 init() 中把名为 "sqlite3" 的数据库驱动
	 * 注册到 database/sql 标准库里。
	 *
	 * 因此后面才能写：
	 *
	 *   sql.Open("sqlite3", dsn)
	 *
	 * mattn/go-sqlite3 底层通过 CGO 调用 libsqlite3。
	 * 项目的测试和构建需要保留 sqlite_fts5、sqlite_omit_load_extension 等 build tags。
	 */
	_ "github.com/mattn/go-sqlite3"
)

// Open 根据传入的 rawURL 打开 SQLite 数据库，并返回标准库的 *sql.DB。
//
// *sql.DB 容易让初学者误解：
// 它不是“一个数据库连接”，而是 Go 标准库提供的“数据库连接池句柄”。
// 后续业务代码拿着这个 *sql.DB 执行 Query/Exec 时，标准库会在内部管理连接复用。
//
// 本函数主要做四件事：
// 1. buildDSN：把用户配置的数据库 URL 转成 sqlite3 驱动 DSN；
// 2. sql.Open：创建数据库句柄；
// 3. SetMaxOpenConns 等：限制连接池大小，降低内存占用；
// 4. PingContext：尽早验证数据库能连通，避免第一次请求才暴露错误。
//
// IMPORTANT（历史审计问题 P0-04）：
// foreign_keys、busy_timeout、journal_mode、synchronous 等 SQLite PRAGMA
// 必须写进 DSN query string，让 mattn/go-sqlite3 在“每一个新连接”上执行。
//
// 以前如果只通过 db.ExecContext("PRAGMA foreign_keys=ON") 设置，
// 只能保证当前取出的那条连接生效。连接池里后续新建的连接可能没有开启外键约束。
// 对 BookFree 来说，这可能导致删除 books 后，book_assets / book_chunks 等表留下孤儿数据。
func Open(rawURL string) (*sql.DB, error) {
	dsn, err := buildDSN(rawURL)
	if err != nil {
		return nil, err
	}

	/*
	 * sql.Open 并不会立刻真正连接数据库。
	 *
	 * 它只是根据驱动名和 DSN 创建一个 *sql.DB 句柄。
	 * 真正建立连接通常发生在 Ping 或第一次查询时。
	 */
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	/*
	 * 连接池限制：这是 BookFree 低内存设计的一部分。
	 *
	 * SQLite 的特点：
	 * - 允许多个读者；
	 * - 但同一时间通常只有一个写者；
	 * - 连接开太多并不会让写入变快；
	 * - 每个连接还可能持有自己的 statement cache、页缓存等资源。
	 *
	 * 因此这里采用非常保守的连接池：
	 * - MaxOpenConns=2：最多两个打开连接，通常足够支持一个写和一个读；
	 * - MaxIdleConns=1：空闲时最多保留一个连接，减少常驻资源；
	 * - ConnMaxLifetime=0：不按固定寿命强制重建连接；
	 * - ConnMaxIdleTime=5min：空闲太久的连接可以被回收。
	 */
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(5 * time.Minute)

	/*
	 * 用带超时的 context 验证数据库可用。
	 *
	 * context.WithTimeout 表示：
	 * - 最多等待 5 秒；
	 * - 如果数据库路径不可访问、DSN 错误或 PRAGMA 设置失败，会尽早返回错误；
	 * - 不会让程序启动阶段无限卡住。
	 */
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		/*
		 * 如果 Ping 失败，需要关闭已经创建的 *sql.DB，
		 * 避免泄漏内部资源。
		 */
		_ = db.Close()
		return nil, fmt.Errorf("ping db: %w", err)
	}

	return db, nil
}

// buildDSN 把用户传入的数据库地址转换成 mattn/go-sqlite3 驱动使用的 DSN。
//
// DSN 可以简单理解为“数据库连接字符串”。
// 对 SQLite 来说，它通常长这样：
//
//	./data/bookfree.db?_foreign_keys=on&_journal_mode=WAL
//
// 本函数会额外加入一组默认 PRAGMA 参数，确保每个 SQLite 连接都采用同样的行为。
func buildDSN(rawURL string) (string, error) {
	/*
	 * 去掉首尾空白，避免 .env 中误写空格。
	 */
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", fmt.Errorf("db: empty URL")
	}

	/*
	 * 当前这个 Go 构建只支持本地 SQLite 文件，不支持远程 libsql/Turso URL。
	 *
	 * 这样做的原因：
	 * - 保持部署简单；
	 * - 避免引入额外远程数据库客户端和网络连接复杂度；
	 * - 更符合 50MB 常驻内存约束。
	 *
	 * 如果未来确实要支持远程 libsql，建议单独做一个 storage/db driver 抽象，
	 * 不要在这里混入大量远程数据库逻辑。
	 */
	if strings.HasPrefix(rawURL, "libsql://") || strings.HasPrefix(rawURL, "https://") {
		return "", fmt.Errorf("db: remote libsql URL %q not supported by this build", rawURL)
	}

	/*
	 * 支持 file: 前缀。
	 *
	 * 例如配置：
	 *   file:./data/bookfree.db
	 *
	 * 这里会转换成：
	 *   ./data/bookfree.db
	 *
	 * mattn/go-sqlite3 可以直接识别本地路径。
	 */
	path := strings.TrimPrefix(rawURL, "file:")

	var userParams url.Values

	/*
	 * 如果用户自己在 DBURL 里带了 query 参数，也要保留。
	 *
	 * 例如：
	 *   file:./data/bookfree.db?_busy_timeout=10000
	 *
	 * 这里会拆成：
	 * - path: ./data/bookfree.db
	 * - userParams: _busy_timeout=10000
	 */
	if i := strings.IndexByte(path, '?'); i >= 0 {
		var err error
		userParams, err = url.ParseQuery(path[i+1:])
		if err != nil {
			return "", fmt.Errorf("db: parse url params: %w", err)
		}
		path = path[:i]
	} else {
		userParams = url.Values{}
	}

	/*
	 * mattn/go-sqlite3 支持一些以下划线开头的 DSN 参数。
	 * 这些参数会在驱动创建每个新连接时应用到 SQLite。
	 *
	 * 默认值解释：
	 *
	 * _foreign_keys=on
	 *   开启外键约束。没有它，SQLite 默认可能不强制检查外键，
	 *   删除书籍时就可能留下关联表孤儿数据。
	 *
	 * _busy_timeout=5000
	 *   当数据库被短暂锁住时，最多等待 5000ms。
	 *   SQLite 单写者模型下，短暂锁等待是正常的。
	 *
	 * _journal_mode=WAL
	 *   使用 Write-Ahead Logging。
	 *   WAL 通常能让读写并发体验更好：读者不容易被写者阻塞。
	 *
	 * _synchronous=NORMAL
	 *   在可靠性和性能之间取平衡。
	 *   对个人自托管应用来说通常比 FULL 更合适。
	 *
	 * _cache_size=-2048
	 *   SQLite cache_size 为负数时表示 KiB。
	 *   -2048 大约是 2MiB，避免 SQLite 页缓存占用过多常驻内存。
	 *
	 * _temp_store=MEMORY
	 *   临时数据放内存中，可减少临时文件 IO。
	 *   注意这不是无限制缓存；配合较小 cache_size 和小连接池，内存仍可控。
	 */
	defaults := map[string]string{
		"_foreign_keys": "on",
		"_busy_timeout": "5000",
		"_journal_mode": "WAL",
		"_synchronous":  "NORMAL",
		"_cache_size":   "-2048", // 2 MiB
		"_temp_store":   "MEMORY",
	}

	/*
	 * 只有当用户没有显式设置某个参数时，才写入默认值。
	 *
	 * 这让高级用户可以通过 BOOKFREE_DB_URL 覆盖某些 SQLite 行为，
	 * 例如把 _busy_timeout 调大。
	 */
	for k, v := range defaults {
		if !userParams.Has(k) {
			userParams.Set(k, v)
		}
	}

	/*
	 * 最后重新拼回 path?query 的形式。
	 *
	 * userParams.Encode() 会负责 URL 编码和参数排序。
	 */
	return path + "?" + userParams.Encode(), nil
}
