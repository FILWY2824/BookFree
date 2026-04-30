// Package books 负责书籍相关的后端能力。
//
// 这个包里主要有三类代码：
// 1. handlers.go：HTTP 接口层，负责接收请求、返回 JSON；
// 2. store.go：数据库访问层，负责查询/删除 books 表等数据；
// 3. upload.go/file.go：上传原始文件、读取原始文件。
//
// 本文件 store.go 只做“数据访问”，也就是常说的 DAL（Data Access Layer）。
// 它不直接处理 HTTP，也不直接操作浏览器请求；这样可以让代码边界更清楚：
// - handler 关心“这个接口要返回什么”；
// - store 关心“SQL 怎么查、查出来怎么转成 Go 结构体”；
// - storage 关心“文件存在磁盘哪里”。
//
// 低内存设计说明：
// - 查询书籍列表时设置 LIMIT 1000，避免一次性加载无限数据；
// - 只把数据库行转换为轻量 DTO，不把书籍正文或文件内容读入内存；
// - 删除书籍时只收集 storage_key 字符串，真正文件删除在 handler 后台完成。
package books

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"bookfree/internal/models"
)

// rowToBook 把数据库查询出来的一行 books 数据转换成前端/API 使用的 models.Book。
//
// 为什么需要这个函数？
// 数据库中的字段类型和 API 返回给前端的字段类型并不完全一样：
// - authors 在数据库里是 JSON 字符串，例如 ["鲁迅","周作人"]；
// - authors 在 Go/API 里是 []string；
// - language、publisher、cover_storage_key、error 这些字段在数据库里可能为 NULL；
// - 在 Go 里要用 sql.NullString 判断“是真的空字符串”还是“数据库 NULL”。
//
// 把这些转换逻辑集中在一个函数里，可以避免 ListByUser、FindByID 等函数重复写同样代码。
func rowToBook(
	id, title, authorsJSON string,
	language, publisher, coverKey, errorMsg sql.NullString,
	format, status string,
	sizeBytes, createdAt, updatedAt int64,
) models.Book {
	var authors []string

	// authorsJSON 来自 books.authors 字段。
	//
	// 正常情况下它是一个 JSON 数组字符串，比如：
	//   ["作者 A","作者 B"]
	//
	// json.Unmarshal 会把它解析到 []string。
	// 如果解析失败，说明历史数据或导入数据可能不是标准 JSON；
	// 此时兜底成 []string{authorsJSON}，至少前端还能显示出原始内容。
	if authorsJSON != "" {
		if err := json.Unmarshal([]byte(authorsJSON), &authors); err != nil || authors == nil {
			authors = []string{authorsJSON}
		}
	}

	// 先填充必填字段。
	// 这些字段在 books 表中通常不应为 NULL。
	b := models.Book{
		ID:        id,
		Title:     title,
		Authors:   authors,
		Format:    format,
		SizeBytes: sizeBytes,
		Status:    status,
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
	}

	// sql.NullString 的用法：
	// - Valid == true：数据库里有值，可以安全读取 .String；
	// - Valid == false：数据库里是 NULL，不应把空字符串误当成真实值。
	//
	// models.Book 中这些字段是 *string，nil 会在 JSON 中表现为缺失或 null，
	// 前端可以据此判断“没有这个信息”。
	if language.Valid {
		b.Language = &language.String
	}
	if publisher.Valid {
		b.Publisher = &publisher.String
	}
	if coverKey.Valid {
		b.CoverStorageKey = &coverKey.String
	}
	if errorMsg.Valid {
		b.Error = &errorMsg.String
	}
	return b
}

// ListByUser 返回某个用户的书籍列表，按创建时间倒序排列。
//
// 对应前端场景：
// - LibraryPage 打开书架；
// - 调用 GET /api/books；
// - handler 调用 ListByUser；
// - 返回 books 数组给前端渲染 BookCard。
//
// 为什么参数里必须有 userID？
// BookFree 支持多用户，所有书籍数据都必须按 user_id 隔离。
// 任何“不带 userID 的查询”都可能造成越权读取。
func ListByUser(ctx context.Context, db *sql.DB, userID string) ([]models.Book, error) {
	// QueryContext 会执行 SQL 并返回多行结果。
	//
	// ctx 来自 HTTP 请求：
	// - 如果用户断开连接；
	// - 或者服务器主动取消请求；
	// 数据库查询也可以尽快停止，避免浪费资源。
	rows, err := db.QueryContext(ctx, `
		SELECT id, title, authors, language, publisher, cover_storage_key,
		       format, size_bytes, status, error, created_at, updated_at
		FROM books
		WHERE user_id = ?
		ORDER BY created_at DESC
		LIMIT 1000
	`, userID)
	if err != nil {
		return nil, err
	}
	// rows.Close 必须调用，否则底层数据库连接可能一直被占用。
	// 在低连接池配置下，如果忘记 Close，很容易导致后续请求等待连接。
	defer rows.Close()

	// 预分配容量 32 是一个小优化：
	// - 大多数用户书架不会一开始就有上千本书；
	// - 先分配少量空间，后续不够再自动扩容；
	// - 避免一上来为 LIMIT 1000 分配过多内存。
	out := make([]models.Book, 0, 32)

	// rows.Next 逐行读取结果，不会一次性把所有行都扫描到结构体。
	for rows.Next() {
		var (
			id, title, authors, format, status string
			lang, pub, cover, errMsg           sql.NullString
			size, created, updated             int64
		)

		// Scan 的参数顺序必须和 SELECT 字段顺序完全一致。
		if err := rows.Scan(&id, &title, &authors, &lang, &pub, &cover,
			&format, &size, &status, &errMsg, &created, &updated); err != nil {
			return nil, err
		}

		// 把数据库字段转换成统一的 models.Book。
		out = append(out, rowToBook(id, title, authors, lang, pub, cover, errMsg,
			format, status, size, created, updated))
	}

	// rows.Err 用来检查遍历过程中是否出现错误。
	// 注意：即使 QueryContext 成功，遍历过程中也可能因为连接中断等原因报错。
	return out, rows.Err()
}

// FindByID 返回当前用户拥有的一本书。
//
// 如果书不存在，返回 (nil, nil)，而不是把 sql.ErrNoRows 直接抛给上层。
// 这样 handler 可以很自然地写：
//
//	if book == nil { 返回 404 }
//
// 为什么 SQL 里同时写 id = ? AND user_id = ?：
// - id 用来定位书；
// - user_id 用来做权限隔离；
// - 即使用户猜到别人的 bookID，也无法查到不属于自己的书。
func FindByID(ctx context.Context, db *sql.DB, userID, bookID string) (*models.Book, error) {
	// QueryRowContext 用于最多返回一行的查询。
	// LIMIT 1 是额外的保险，也让 SQL 意图更明确。
	row := db.QueryRowContext(ctx, `
		SELECT id, title, authors, language, publisher, cover_storage_key,
		       format, size_bytes, status, error, created_at, updated_at
		FROM books
		WHERE id = ? AND user_id = ?
		LIMIT 1
	`, bookID, userID)

	var (
		id, title, authors, format, status string
		lang, pub, cover, errMsg           sql.NullString
		size, created, updated             int64
	)

	if err := row.Scan(&id, &title, &authors, &lang, &pub, &cover,
		&format, &size, &status, &errMsg, &created, &updated); err != nil {
		// sql.ErrNoRows 是“没有查到数据”的正常业务结果。
		// 它不代表数据库坏了，所以转换成 nil, nil 交给 handler 返回 404。
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	b := rowToBook(id, title, authors, lang, pub, cover, errMsg,
		format, status, size, created, updated)
	return &b, nil
}

// listAssetKeys 返回某本书关联的所有 storage_key。
//
// 这个函数只在删除书籍时使用，并且必须在 DELETE books 之前调用。
//
// 原因：
// - 数据库中可能设置了 ON DELETE CASCADE；
// - 一旦 books 行被删除，book_assets 等依赖行也会一起被删除；
// - 如果先删数据库再查 storage_key，就找不到需要删除哪些文件了。
//
// 为什么同时查两处？
// 1. book_assets.storage_key：上传的原始文件等正式资产；
// 2. books.cover_storage_key：封面字段是冗余字段，不一定在 book_assets 中有对应行。
//
// 如果遗漏其中任何一个来源，都可能造成磁盘文件残留。
func listAssetKeys(ctx context.Context, tx *sql.Tx, userID, bookID string) ([]string, error) {
	var keys []string

	// 先从 book_assets 表收集所有已记录资产。
	rows, err := tx.QueryContext(ctx,
		`SELECT storage_key FROM book_assets WHERE book_id = ? AND user_id = ?`,
		bookID, userID)
	if err != nil {
		return nil, err
	}

	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			// 如果中途 Scan 失败，要先关闭 rows，再返回错误。
			// 这里不用 defer，是因为后面还要立即检查 Close 错误。
			rows.Close()
			return nil, err
		}
		if k != "" {
			keys = append(keys, k)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	// 再从 books 表读取封面 key。
	// 封面可能是单独字段，不一定也存在 book_assets。
	var cover sql.NullString
	err = tx.QueryRowContext(ctx,
		`SELECT cover_storage_key FROM books WHERE id = ? AND user_id = ?`,
		bookID, userID).Scan(&cover)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if cover.Valid && cover.String != "" {
		keys = append(keys, cover.String)
	}

	return keys, nil
}

// Delete 删除一本书的数据库记录，并返回需要删除的存储文件 key。
//
// 返回值说明：
// - ok=false：没有找到这本书，handler 应返回 404；
// - keys：删除数据库前收集到的文件 key，handler 会用它们删除磁盘/对象存储文件；
// - err：数据库操作失败。
//
// 为什么 Delete 只删除数据库，不直接删除文件？
// 这是为了把“数据库事务”和“外部文件系统操作”分开：
// - 数据库支持事务，可以 Commit/Rollback；
// - 文件系统通常不能和 SQLite 放在同一个事务里；
// - 如果混在一起，失败恢复会很复杂。
//
// 所以本函数只保证数据库一致性：
// - 先在事务里收集 keys；
// - 删除 books 行；
// - 依赖外键 cascade 删除章节、chunks、进度、笔记等依赖数据；
// - Commit 成功后，把 keys 返回给 handler，让 handler 异步清理文件。
func Delete(ctx context.Context, db *sql.DB, userID, bookID string) (ok bool, keys []string, err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, nil, err
	}

	// defer Rollback 是 Go 中常见事务写法：
	// - 如果后面任何一步 return，Rollback 会撤销未提交事务；
	// - 如果 Commit 已经成功，Rollback 会变成 no-op 或返回错误；
	// - 这里忽略 Rollback 错误，因为真正需要关注的是前面的业务错误或 Commit 错误。
	defer tx.Rollback() //nolint:errcheck — Commit() makes Rollback a no-op.

	// 必须在 DELETE 前收集文件 key，否则级联删除后依赖表可能已经没了。
	keys, err = listAssetKeys(ctx, tx, userID, bookID)
	if err != nil {
		return false, nil, err
	}

	// 删除 books 主表记录。
	// WHERE 同时包含 id 和 user_id，避免用户删除不属于自己的书。
	res, err := tx.ExecContext(ctx,
		`DELETE FROM books WHERE id = ? AND user_id = ?`,
		bookID, userID)
	if err != nil {
		return false, nil, err
	}

	// RowsAffected 告诉我们实际删除了几行。
	// n == 0 表示这本书不存在，或不属于当前用户。
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, nil, nil
	}

	// 提交事务后，数据库里的书籍及关联行才算真正删除成功。
	if err := tx.Commit(); err != nil {
		return false, nil, err
	}

	// 注意：这里只返回 keys，不删除文件。
	// 文件删除由 handler.go 的 dropStorageKeys 在后台完成。
	return true, keys, nil
}
