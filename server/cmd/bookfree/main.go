// bookfree 是 BookFree 后端的“单二进制入口程序”。
//
// 对初学者来说，可以把这个文件理解为 Go 后端的 main.tsx：
// - 前端 main.tsx 负责把 React 应用挂载到浏览器页面；
// - 后端 main.go 负责把数据库、文件存储、路由、中间件等模块组装起来，启动 HTTP 服务。
//
// 这个项目以前有过 Next.js 全栈进程；现在 Go 后端承担：
// 1. 打开 SQLite 数据库；
// 2. 执行数据库迁移；
// 3. 打开本地文件存储；
// 4. 注册所有 /api/* 后端接口；
// 5. 在同一个 HTTP 服务中托管前端 SPA 静态文件。
//
// 常用运行方式：
//
//	./bookfree-server              启动 HTTP 服务，正常部署时使用
//	./bookfree-server migrate      只执行数据库迁移，然后退出
//	./bookfree-server backfill-fts 为旧数据补充全文搜索字段
//	./bookfree-server make-admin   把某个用户提升为管理员
//	./bookfree-server version      打印版本号
//
// 所有配置都来自环境变量，具体见：
// - server/internal/config/config.go
// - 项目根目录 .env.example
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"bookfree/internal/auth"
	"bookfree/internal/config"
	"bookfree/internal/db"
	httpsrv "bookfree/internal/http"
	"bookfree/internal/logger"
	"bookfree/internal/search"
	"bookfree/internal/security"
	"bookfree/internal/storage"
	"bookfree/webdist"
)

// version 保存当前二进制的版本号。
//
// 默认值是 "dev"，表示本地开发构建。
// 正式构建时，Makefile / CI 可以通过 Go 的 ldflags 注入真实版本：
//
//	go build -ldflags="-X main.version=v1.2.3"
//
// 这样不需要在代码里手动改版本号，二进制运行时就能知道自己是什么版本。
var version = "dev"

// main 是 Go 可执行程序的入口函数。
//
// Go 语言约定：
// - 可执行程序必须使用 package main；
// - 程序启动后会自动调用 main()；
// - main() 没有参数、没有返回值；
// - 如果要表示启动失败，通常打印错误并 os.Exit(1)。
func main() {
	// 这里设置 Go runtime 的软内存目标。
	//
	// BookFree 的后端目标之一是“常驻内存尽量控制在 50MB 内”。
	// 因此在用户没有手动设置 GOMEMLIMIT / GOGC 时，项目给出偏保守的默认值。
	//
	// GOMEMLIMIT：
	// - Go 1.19+ 引入的运行时软内存限制；
	// - 当堆内存接近这个值时，GC 会更积极地回收；
	// - 注意它不是操作系统级硬限制，不等于 Linux cgroup / systemd MemoryMax。
	//
	// GOGC：
	// - 控制 GC 触发频率；
	// - 默认值通常是 100；
	// - 这里设为 30，意味着更频繁 GC，用一些 CPU 换更低峰值内存；
	// - 对上传、搜索等短时内存波动场景更友好。
	//
	// 这两个环境变量都允许部署者覆盖：
	// - 如果机器内存宽裕，可以调大以减少 GC；
	// - 如果机器内存非常紧张，可以保持或进一步收紧。
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(48 << 20)
	}
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(30)
	}

	// run() 返回 error，main() 统一负责打印错误和设置退出码。
	//
	// 这种写法比在各处直接 os.Exit 更利于测试和维护：
	// - 业务函数只需要 return err；
	// - 程序入口统一决定错误怎么展示；
	// - defer 也更容易正确执行。
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "bookfree:", err)
		os.Exit(1)
	}
}

// run 负责解析配置、分发命令、启动服务。
//
// 可以把它理解为后端启动流程的“总调度函数”：
// 1. 读取环境变量配置；
// 2. 初始化日志级别；
// 3. 检查是否传入子命令；
// 4. 如果是子命令就执行后退出；
// 5. 如果没有子命令，就按默认模式启动 HTTP 服务。
func run() error {
	// config.Load() 会读取 BOOKFREE_* 等环境变量，并填充默认值。
	// 如果生产环境缺少必要密钥，会在这里直接报错，避免服务用不安全配置启动。
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// 日志级别来自配置，例如 debug/info/warn/error。
	// 这样开发环境可以输出更详细日志，生产环境可以保持较少噪音。
	logger.SetLevel(cfg.LogLevel)

	// os.Args 是命令行参数。
	// os.Args[0] 是程序自身路径，所以真正的参数从 os.Args[1:] 开始。
	args := os.Args[1:]
	if len(args) > 0 {
		switch args[0] {
		case "version":
			fmt.Println(resolvedVersion())
			return nil
		case "help", "-h", "--help":
			printHelp()
			return nil
		case "migrate":
			return cmdMigrate(cfg)
		case "backfill-fts":
			return cmdBackfillFTS(cfg)
		case "make-admin":
			if len(args) < 2 {
				return errors.New("usage: bookfree-server make-admin <email>")
			}
			return cmdMakeAdmin(cfg, args[1])
		default:
			// 未知子命令不直接失败，而是记录 warning 后继续按默认方式启动服务。
			// 这保留了以前部署脚本可能传入额外参数时的兼容性。
			logger.Warn("boot.unknown_subcommand", logger.Fields{"arg": args[0]})
			// Fall through to serve.
		}
	}

	// 启动日志只放“运维需要知道”的摘要信息。
	//
	// 注意 dbURL 通过 redactURL 脱敏，避免把数据库 token 打到日志里。
	logger.Info("boot", logger.Fields{
		"version":     resolvedVersion(),
		"env":         cfg.Env,
		"addr":        cfg.Addr,
		"dbURL":       redactURL(cfg.DBURL),
		"storageDir":  cfg.StorageDir,
		"maxUploadMB": cfg.MaxUploadMB,
		"webdistDir":  cfg.WebDistDir,
	})
	return cmdServe(cfg)
}

// printHelp 打印命令行帮助。
//
// 这里使用反引号 `...` 定义 Go 的原始字符串字面量，
// 里面可以直接写多行文本，不需要为每个换行加 \n。
func printHelp() {
	fmt.Println(`bookfree-server — low-memory Go backend for the BookFree reader.

Subcommands:
  (no args)             start the HTTP server
  migrate               apply pending DB migrations and exit
  backfill-fts          populate FTS5 tables from existing rows
  make-admin <email>    promote a user to role=admin
  version               print version
  help                  show this help

Configuration is via environment variables. See .env.example.`)
}

// cmdServe 是“正常启动服务”的主流程。
//
// 它会完成这些事情：
// 1. 调用 bootstrap 打开数据库、迁移、打开存储；
// 2. 创建 session 管理器；
// 3. 根据环境决定是否允许注册；
// 4. 组装 RouterDeps，把依赖传给路由层；
// 5. 创建根 HTTP handler；
// 6. 监听系统信号，支持优雅退出；
// 7. 启动 HTTP 服务。
func cmdServe(cfg *config.Config) error {
	// bootstrap 返回后端运行所需的三个基础依赖：
	// - database：SQLite 连接池；
	// - deriver：用于加密/派生密钥；
	// - store：本地文件存储。
	database, deriver, store, err := bootstrap(cfg)
	if err != nil {
		return err
	}

	// defer 表示“函数返回前执行”。
	// 服务结束时关闭数据库连接池，释放文件描述符等资源。
	defer database.Close()

	// session store 负责登录态。
	//
	// BookFree 不是把 JWT token 存在 localStorage，
	// 而是使用服务端 session + Cookie：
	// - 登录成功后后端写 Cookie；
	// - 前端请求自动带上 Cookie；
	// - 中间件从 Cookie 找到当前用户。
	sessions := auth.NewStore(database, cfg.SessionCookie, cfg.IsProduction())

	// 默认策略：
	// - development：允许注册，方便本地调试；
	// - production：默认不开放注册，避免公网部署被陌生人注册。
	//
	// BOOKFREE_ALLOW_REGISTRATION 可以显式覆盖：
	// - 1/true：允许注册；
	// - 0/false：禁止注册。
	allowRegister := !cfg.IsProduction()
	if v := os.Getenv("BOOKFREE_ALLOW_REGISTRATION"); v == "1" || v == "true" {
		allowRegister = true
	} else if v == "0" || v == "false" {
		allowRegister = false
	}

	// RouterDeps 是依赖注入对象。
	//
	// Go 项目中常见做法是：
	// - main.go 负责创建真实依赖；
	// - handler/service 只接收接口或结构体；
	// - 这样路由层不需要自己读取环境变量，也不需要知道依赖怎么创建。
	//
	// 对未来 Android 客户端也很重要：
	// 只要这里注册的 /api/* 接口稳定，Web 和 Android 都可以复用同一套后端能力。
	deps := httpsrv.RouterDeps{
		DB:                database,
		Storage:           store,
		Sessions:          sessions,
		KeyDeriver:        deriver,
		IsProd:            cfg.IsProduction(),
		Version:           resolvedVersion(),
		StartedAt:         time.Now(),
		WebDistFS:         webdistOrNil(),
		WebDistDir:        cfg.WebDistDir,
		MaxUploadMB:       cfg.MaxUploadMB,
		AllowRegistration: allowRegister,
		TrustedProxies:    httpsrv.ParseTrustedProxies(cfg.TrustedProxies),
	}

	// httpsrv.New 会注册所有 API 路由、中间件和前端静态资源 fallback，
	// 返回一个标准库 http.Handler。
	handler := httpsrv.New(deps)

	// signal.NotifyContext 创建一个会在收到系统信号时自动取消的 context。
	//
	// 常见触发方式：
	// - 本地按 Ctrl+C：os.Interrupt；
	// - Docker / systemd 停止服务：SIGTERM。
	//
	// context 被取消后，httpsrv.Run 可以执行优雅关闭，
	// 避免请求处理到一半时被硬杀。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return httpsrv.Run(ctx, cfg.Addr, handler)
}

// cmdMigrate 只执行数据库迁移，然后退出。
//
// 用途：
// - 部署前先检查数据库迁移是否能成功；
// - CI 或运维脚本中单独跑迁移；
// - 不启动 HTTP 服务，不占用端口。
func cmdMigrate(cfg *config.Config) error {
	database, _, _, err := bootstrap(cfg)
	if err != nil {
		return err
	}
	defer database.Close()
	logger.Info("migrate.done", nil)
	return nil
}

// cmdBackfillFTS 用于为旧数据回填全文搜索字段。
//
// 背景：
// - 新版搜索使用 SQLite FTS5；
// - 迁移 0020_fts_search.sql 增加了 search_text 字段和触发器；
// - 旧数据可能没有 search_text；
// - 这个命令会读取旧的 book_chunks / notes 文本，计算适合搜索的文本，再 UPDATE 回去。
//
// 为什么可以安全重跑/中断：
// - 查询条件是 WHERE search_text IS NULL；
// - 已处理过的行不会重复处理；
// - 如果执行到一半中断，下次会从剩余未处理行继续。
func cmdBackfillFTS(cfg *config.Config) error {
	database, _, _, err := bootstrap(cfg)
	if err != nil {
		return err
	}
	defer database.Close()

	ctx := context.Background()
	if n, err := backfillSearchText(ctx, database, "book_chunks", "id", "text"); err != nil {
		return fmt.Errorf("book_chunks: %w", err)
	} else {
		logger.Info("backfill.book_chunks", logger.Fields{"updated": n})
	}
	if n, err := backfillSearchText(ctx, database, "notes", "id", "body"); err != nil {
		return fmt.Errorf("notes: %w", err)
	} else {
		logger.Info("backfill.notes", logger.Fields{"updated": n})
	}
	return nil
}

// backfillSearchText 分批更新某张表的 search_text 字段。
//
// 参数说明：
// - ctx：用于取消数据库操作；
// - database：SQLite 连接池；
// - table：要处理的表名，例如 book_chunks；
// - idCol：主键列名，例如 id；
// - textCol：原始文本列名，例如 text/body。
//
// 为什么分批处理：
// - 一次性加载所有书籍和笔记可能占用大量内存；
// - 每批 500 行能控制内存峰值；
// - 对 50MB 常驻内存目标更友好。
//
// 为什么使用事务：
// - 一批更新要么全部成功，要么全部回滚；
// - 减少 SQLite 写入开销；
// - 触发器会在 UPDATE 后自动同步 FTS5 表。
func backfillSearchText(ctx context.Context, database *sql.DB, table, idCol, textCol string) (int, error) {
	const batch = 500
	updated := 0
	for {
		// 注意：table/idCol/textCol 不是用户输入，而是代码内部固定传入的表名/列名。
		// 如果这些值来自 HTTP 请求，就不能直接 fmt.Sprintf 拼 SQL，否则会有 SQL 注入风险。
		rows, err := database.QueryContext(ctx, fmt.Sprintf(
			`SELECT %s, %s FROM %s WHERE search_text IS NULL LIMIT %d`,
			idCol, textCol, table, batch))
		if err != nil {
			return updated, err
		}

		// 只把当前批次读进内存，避免大文档/大量笔记导致内存暴涨。
		var ids, texts []string
		for rows.Next() {
			var id, txt string
			if err := rows.Scan(&id, &txt); err != nil {
				rows.Close()
				return updated, err
			}
			ids = append(ids, id)
			texts = append(texts, txt)
		}
		rows.Close()
		if len(ids) == 0 {
			break
		}

		tx, err := database.BeginTx(ctx, nil)
		if err != nil {
			return updated, err
		}

		// PrepareContext 会预编译 SQL。
		// 后面循环只替换 ? 参数，避免重复解析 SQL，也能避免文本内容导致 SQL 注入。
		stmt, err := tx.PrepareContext(ctx, fmt.Sprintf(
			`UPDATE %s SET search_text = ? WHERE %s = ?`, table, idCol))
		if err != nil {
			tx.Rollback()
			return updated, err
		}
		for i, id := range ids {
			// search.SearchText 会把原始文本转换成更适合 FTS/CJK 搜索的形式。
			if _, err := stmt.ExecContext(ctx, search.SearchText(texts[i]), id); err != nil {
				stmt.Close()
				tx.Rollback()
				return updated, err
			}
			updated++
		}
		stmt.Close()
		if err := tx.Commit(); err != nil {
			return updated, err
		}

		// 每处理约 5000 行输出一次进度，避免日志过多。
		if updated%5000 < batch {
			logger.Info("backfill.progress", logger.Fields{"table": table, "rows": updated})
		}
	}
	return updated, nil
}

// cmdMakeAdmin 把指定 email 的用户提升为管理员。
//
// 管理员权限目前用于例如 AI 限额设置等需要更高权限的操作。
// 这里用命令行完成提升，避免在产品早期就做复杂后台管理页面。
func cmdMakeAdmin(cfg *config.Config, email string) error {
	database, _, _, err := bootstrap(cfg)
	if err != nil {
		return err
	}
	defer database.Close()
	res, err := database.ExecContext(context.Background(),
		`UPDATE users SET role = 'admin', updated_at = unixepoch() WHERE LOWER(email) = LOWER(?)`,
		email)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("no user with email %q", email)
	}
	logger.Info("make_admin.done", logger.Fields{"email": email})
	return nil
}

// bootstrap 创建后端运行所需的基础设施。
//
// 这个函数的名字常用于表示“启动前的引导流程”。
// 它把 main.go 中重复的初始化步骤集中起来，供：
// - 正常 serve；
// - migrate；
// - backfill-fts；
// - make-admin；
// 这些命令复用。
//
// 返回值：
// - *sql.DB：数据库连接池；
// - *security.KeyDeriver：密钥派生器，用于加密敏感配置等；
// - storage.Storage：文件存储接口，目前是本地磁盘实现；
// - error：任一步失败都返回错误。
func bootstrap(cfg *config.Config) (*sql.DB, *security.KeyDeriver, storage.Storage, error) {
	database, err := db.Open(cfg.DBURL)
	if err != nil {
		return nil, nil, nil, err
	}

	// 数据库迁移最多等待 30 秒，避免坏配置时程序无限卡住。
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.Migrate(ctx, database); err != nil {
		_ = database.Close()
		return nil, nil, nil, fmt.Errorf("migrate: %w", err)
	}

	// KeyDeriver 使用 AppSecret 派生稳定密钥。
	// 这样数据库中保存的第三方 AI Provider Key 等敏感信息可以被加密。
	deriver := security.NewKeyDeriver(cfg.AppSecret)

	// 当前构建使用本地文件存储。
	// 上传的原始书籍文件会保存在 cfg.StorageDir 目录下。
	store, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		_ = database.Close()
		return nil, nil, nil, err
	}
	return database, deriver, store, nil
}

// webdistOrNil 返回嵌入到 Go 二进制里的前端静态文件系统。
//
// Go 的 embed 可以把构建后的前端 dist 文件打进后端二进制，
// 这样部署时只需要一个 bookfree-server 文件。
//
// 如果当前构建没有嵌入前端资源，返回 nil，
// 路由层会根据 WebDistDir 或其他 fallback 决定如何服务前端。
func webdistOrNil() fs.FS {
	if !webdist.Has() {
		return nil
	}
	return webdist.FS()
}

// resolvedVersion 返回最终展示给用户/健康检查的版本号。
//
// 优先级：
// 1. 构建时通过 ldflags 注入的 version；
// 2. Go build info 中的模块版本；
// 3. 本地开发默认 "dev"。
func resolvedVersion() string {
	if version != "dev" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

// redactURL 在写日志前隐藏数据库 URL 中的敏感信息。
//
// 有些数据库 URL 会把 token 放在：
// - userinfo，例如 https://token@host；
// - query 参数，例如 ?authToken=xxx。
//
// 日志里不能出现这些值，否则日志文件泄露时就等于泄露数据库访问权限。
func redactURL(s string) string {
	u, err := url.Parse(s)
	if err != nil {
		return s
	}
	if u.User != nil {
		u.User = url.User(u.User.Username())
	}
	if q := u.Query(); q.Has("authToken") {
		q.Set("authToken", "REDACTED")
		u.RawQuery = q.Encode()
	}
	return u.String()
}
