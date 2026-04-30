// Package progress 负责“阅读进度”的读取与保存。
//
// 对阅读器产品来说，阅读进度是核心数据之一：
//   - 用户打开一本书时，需要恢复到上次读到的位置；
//   - 用户翻章、翻页、滚动或 EPUB 定位变化时，需要把新位置保存起来；
//   - Web 端和未来 Android 端都应该复用同一套后端进度接口。
//
// 本包提供两类接口：
//   - GET /api/books/{id}/progress：读取当前用户对某本书的进度；
//   - PUT /api/books/{id}/progress：保存/更新当前用户对某本书的进度。
//
// 低内存设计说明：
//   - 进度记录是很小的一行数据库数据；
//   - 后端不需要在内存里维护“在线用户当前读到哪里”；
//   - 每次读写都直接落 SQLite，服务重启后进度仍然存在，也不会增加常驻内存。
package progress

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"bookfree/internal/auth"
	"bookfree/internal/response"
)

// Handler 是 progress 模块的 HTTP 处理器。
//
// 它只依赖数据库和运行环境标记，说明阅读进度本身不需要文件存储、AI 服务等重依赖。
type Handler struct {
	// DB 是 database/sql 的连接池句柄。
	//
	// reading_progress 表保存每个用户、每本书的一条进度记录。
	DB *sql.DB

	// IsProd 控制错误响应是否隐藏内部细节。
	IsProd bool
}

// progressDTO 是后端返回给前端的阅读进度结构。
//
// 为什么这里有多个定位字段？
// 因为不同书籍格式的“位置”概念不一样：
//   - EPUB：通常更适合用 locator / CFI 这类稳定定位符；
//   - TXT：可以用 chapterId 或 chapterOrder 表示当前章节；
//   - PDF：更适合用 pageNo 表示页码；
//   - 旧版本逻辑：曾主要依赖 chapterOrder，所以仍保留兼容字段。
//
// 字段说明：
//   - Locator：更精确的阅读定位符，例如 EPUB CFIv2 或段落锚点；
//   - ChapterID：当前章节 id，比 chapterOrder 更稳定；
//   - ChapterOrder：章节顺序号，兼容旧逻辑；
//   - PageNo：PDF 页码；
//   - Percent：整本书阅读百分比，约定范围是 0 到 1；
//   - LastReadAt：最后阅读时间，Unix 秒时间戳。
type progressDTO struct {
	Locator      *string `json:"locator,omitempty"`
	ChapterID    *string `json:"chapterId,omitempty"`
	ChapterOrder *int    `json:"chapterOrder,omitempty"`
	PageNo       *int    `json:"pageNo,omitempty"`
	Percent      float64 `json:"percent"`
	LastReadAt   int64   `json:"lastReadAt"`
}

// HandleGet 处理：GET /api/books/{id}/progress
//
// 作用：读取当前登录用户对某本书的保存进度。
//
// 前端使用方式：
//   - ReaderPage 打开书籍时调用；
//   - 如果有 locator/chapterId/pageNo，则恢复到对应位置；
//   - 如果没有保存过进度，则从开头开始读。
//
// 特别注意：没有进度记录时返回 200，而不是 404。
// 原因：
//   - “从未读过这本书”不是错误；
//   - 前端加载逻辑更简单，不需要把 404 当正常情况特殊处理；
//   - 返回 percent=0 就能表达“从头开始”。
func (h *Handler) HandleGet(w http.ResponseWriter, r *http.Request) {
	// 当前用户来自认证中间件写入的 context。
	user := auth.UserFromContext(r.Context())

	// 路由模板中的 {id} 表示 bookID。
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// reading_progress 表以 (user_id, book_id) 表示“某用户对某书”的进度。
	//
	// 这里没有额外查 books 表确认 ownership：
	// - 进度表本身按 user_id + book_id 查询；
	// - 如果没有该用户的进度记录，就返回默认 0；
	// - 保存进度时会严格校验书籍归属，避免伪造写入。
	row := h.DB.QueryRowContext(r.Context(), `
		SELECT locator, chapter_id, chapter_order, page_no, percent, last_read_at
		FROM reading_progress
		WHERE user_id = ? AND book_id = ?
		LIMIT 1
	`, user.ID, bookID)

	var (
		// locator/chapter_id 可能为 NULL，用 sql.NullString 表示。
		locator   sql.NullString
		chapterID sql.NullString

		// chapter_order/page_no 可能为 NULL，用 sql.NullInt64 表示。
		// SQLite 整数扫描到 Go 中通常用 int64，再转成前端 DTO 的 int。
		chapterOrder, pageNo sql.NullInt64

		percent    float64
		lastReadAt int64
	)
	if err := row.Scan(&locator, &chapterID, &chapterOrder, &pageNo, &percent, &lastReadAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// 没读过时返回默认进度，而不是错误。
			response.OK(w, map[string]any{"progress": progressDTO{Percent: 0}})
			return
		}
		response.FailSafe(w, "progress.get", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// 把数据库行转换成 JSON DTO。
	//
	// NULL 字段不设置指针，配合 omitempty 就不会出现在 JSON 中。
	dto := progressDTO{Percent: percent, LastReadAt: lastReadAt}
	if locator.Valid {
		dto.Locator = &locator.String
	}
	if chapterID.Valid {
		dto.ChapterID = &chapterID.String
	}
	if chapterOrder.Valid {
		v := int(chapterOrder.Int64)
		dto.ChapterOrder = &v
	}
	if pageNo.Valid {
		v := int(pageNo.Int64)
		dto.PageNo = &v
	}
	response.OK(w, map[string]any{"progress": dto})
}

// HandlePut 处理：PUT /api/books/{id}/progress
//
// 作用：保存或更新当前用户对某本书的阅读进度。
//
// “保存或更新”在数据库里通常叫 upsert：
//   - 如果 reading_progress 中还没有这一行，就 INSERT；
//   - 如果已经有同一个 (user_id, book_id)，就 UPDATE。
//
// migration 0003 中把 (user_id, book_id) 声明为主键，
// 所以这里可以使用 SQLite 的 INSERT ... ON CONFLICT DO UPDATE。
func (h *Handler) HandlePut(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// 请求体字段都设计成指针，是为了区分：
	//   - 字段不存在 / null：写入 SQL NULL；
	//   - 字段存在且有值：写入该值。
	//
	// Percent 也是指针，因为前端可能只想保存某些定位字段。
	var body struct {
		Locator      *string  `json:"locator"`
		ChapterID    *string  `json:"chapterId"`
		ChapterOrder *int     `json:"chapterOrder"`
		PageNo       *int     `json:"pageNo"`
		Percent      *float64 `json:"percent"`
	}

	// 限制 JSON 请求体最大 4KiB。
	//
	// 阅读进度只是一小段定位信息，不应该很大。
	// MaxBytesReader 可以防止恶意客户端提交超大 body 占用内存。
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}

	// Percent 约定范围是 0 到 1。
	//
	// 前端正常情况下会传合法值，但后端仍然要兜底校验：
	// - 小于 0 的按 0；
	// - 大于 1 的按 1。
	pct := 0.0
	if body.Percent != nil {
		pct = *body.Percent
		if pct < 0 {
			pct = 0
		}
		if pct > 1 {
			pct = 1
		}
	}

	// Unix 秒时间戳足够表达最后阅读时间。
	// 不使用 time.Time 直接入 JSON，可以让前端/Android 处理更简单。
	now := time.Now().Unix()

	// 写入进度前必须确认这本书属于当前用户。
	//
	// 如果不做这一步，攻击者可能构造 bookID，
	// 给别人的书写入一条自己的 progress，造成脏数据或越权迹象。
	var exists int
	if err := h.DB.QueryRowContext(r.Context(),
		`SELECT 1 FROM books WHERE id = ? AND user_id = ? LIMIT 1`,
		bookID, user.ID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
			return
		}
		response.FailSafe(w, "progress.put.owns", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// INSERT ... ON CONFLICT DO UPDATE 是 SQLite 的 upsert 写法。
	//
	// excluded.xxx 表示“本次 INSERT 试图写入的新值”。
	// 当主键 (user_id, book_id) 已存在时，就用新值覆盖旧值。
	_, err := h.DB.ExecContext(r.Context(), `
		INSERT INTO reading_progress (user_id, book_id, locator, chapter_id, chapter_order, page_no, percent, last_read_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, book_id) DO UPDATE SET
			locator       = excluded.locator,
			chapter_id    = excluded.chapter_id,
			chapter_order = excluded.chapter_order,
			page_no       = excluded.page_no,
			percent       = excluded.percent,
			last_read_at  = excluded.last_read_at,
			updated_at    = excluded.updated_at
	`,
		user.ID, bookID,
		toNullStr(body.Locator),
		toNullStr(body.ChapterID),
		toNullInt(body.ChapterOrder),
		toNullInt(body.PageNo),
		pct,
		now, now,
	)
	if err != nil {
		response.FailSafe(w, "progress.put", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	response.OK(w, map[string]any{"saved": true})
}

// toNullStr 把 *string 转换成 database/sql 能理解的参数。
//
// 返回 any 是因为 ExecContext 的参数类型就是 ...any。
//
// 转换规则：
//   - nil 指针 → nil → SQL NULL；
//   - 非 nil 指针 → 字符串值。
func toNullStr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// toNullInt 把 *int 转换成 database/sql 能理解的参数。
//
// 转换规则与 toNullStr 一样：
//   - nil 指针 → SQL NULL；
//   - 非 nil 指针 → 整数值。
func toNullInt(i *int) any {
	if i == nil {
		return nil
	}
	return *i
}
