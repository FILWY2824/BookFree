// Package notes 负责 BookFree 的“标注/高亮”和“笔记”接口。
//
// 相关路由主要分两组：
//
//  1. 单本书内的标注/笔记：
//     GET    /api/books/{id}/highlights   → 列出某本书的高亮/下划线/波浪线/删除线
//     POST   /api/books/{id}/highlights   → 给某本书新增一个标注
//     DELETE /api/highlights/{id}         → 删除一个标注，实际是软删除
//
//     GET    /api/books/{id}/notes        → 列出某本书的笔记
//     POST   /api/books/{id}/notes        → 给某本书新增一个笔记
//     PUT    /api/notes/{id}              → 修改笔记正文
//     DELETE /api/notes/{id}              → 删除一个笔记，实际是软删除
//
//  2. 跨书的汇总页面：
//     GET    /api/highlights              → 列出当前用户所有书的标注
//     GET    /api/notes                   → 列出当前用户所有书的笔记
//
// 这些接口都必须按 user_id 隔离数据。也就是说：
//   - 用户 A 只能看到/创建/删除自己的标注和笔记；
//   - 即使用户 A 猜到了用户 B 的 note id/highlight id，也无法操作；
//   - 找不到或不属于当前用户时，统一返回“不存在”。
//
// 与前端的关系：
//   - apps/web/src/reader/TxtReader.tsx 会在打开一本书时调用 listHighlights/listNotes；
//   - 用户选择文字后，SelectionToolbar 会触发 createHighlight/createNote；
//   - 用户点击已有标注时，可以修改颜色、编辑笔记或删除；
//   - apps/web/src/pages/NotesPage.tsx 会调用跨书汇总接口显示“标注与笔记”。
//
// 低内存设计说明：
//   - 标注和笔记都是 SQLite 中的小行数据，不在 Go 进程内做常驻缓存；
//   - 列表接口有限制 LIMIT，避免一次返回无限数据；
//   - 笔记全文搜索的 search_text 在写入/更新时生成，查询时走 SQLite FTS5，
//     避免每次搜索都把所有笔记加载到内存。
package notes

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"bookfree/internal/auth"
	"bookfree/internal/response"
	"bookfree/internal/search"
	"bookfree/internal/security"
)

// Handler 是 notes 模块的 HTTP 处理器依赖容器。
//
// 字段说明：
//   - DB：SQLite 连接池句柄。所有标注/笔记读写都直接落库，不保存在内存。
//   - IsProd：是否生产环境。传给 response.FailSafe，用于控制错误响应是否隐藏内部细节。
type Handler struct {
	DB     *sql.DB
	IsProd bool
}

// ── highlights ───────────────────────────────────────────────────────
//
// highlight 在本项目里不只表示“黄色高亮”，而是泛指一段被用户选中的文字标注。
// 它可以有不同 style：
//   - highlight：背景色高亮
//   - underline：下划线
//   - wavy：波浪线
//   - strike：删除线
//
// 注意：笔记 note 可以关联到 highlight。也就是说，用户选择一段文字后：
//   - 只做颜色标记：创建 highlight；
//   - 对这段文字写笔记：创建 highlight + 创建 note，并让 note.highlight_id 指向 highlight.id。

// highlightDTO 是返回给前端的标注结构。
//
// DTO = Data Transfer Object，即“接口传输对象”。
// 它不一定和数据库字段完全一一对应，而是适合前端直接消费的 JSON 形状。
type highlightDTO struct {
	ID     string `json:"id"`
	BookID string `json:"bookId"`

	// ChapterID 对 TXT/EPUB 这类章节型阅读器有用。
	// 用 *string 是为了让没有章节信息时 JSON 可以省略该字段。
	ChapterID *string `json:"chapterId,omitempty"`

	// PageNo 对 PDF 这类分页型阅读器有用。
	PageNo *int `json:"pageNo,omitempty"`

	// Locator 是定位这段文字的关键字段。
	//
	// 前端 reader 会把用户选区编码成 locator，例如 CFIv2/段落锚点。
	// 下次打开书时，TxtReader 会根据 locator 找回 DOM Range，再把该范围包成高亮 span。
	Locator string `json:"locator"`

	// SelectedText 是用户当时选中的原文，既用于 UI 展示，也用于 locator 恢复失败时做兜底理解。
	SelectedText string `json:"selectedText"`

	// Color 是颜色名，而不是 CSS 颜色值。
	// 前端会把 yellow/red/green 等映射成实际主题色。
	Color string `json:"color"`

	// Style 是标注样式。它和前端 HighlightStyle union 保持一致。
	//
	// migration 0019 增加了 style 字段。旧数据可能没有 style，因此数据库层通常会给默认值
	// highlight。接口始终返回 style，前端就不需要自己猜默认样式。
	Style string `json:"style"`

	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
}

// highlightCreate 是创建标注时前端提交的请求体。
//
// 与 highlightDTO 相比，它不需要 ID/BookID/CreatedAt 等字段：
//   - ID 由后端 security.RandomID 生成；
//   - BookID 从 URL 路径 /api/books/{id}/highlights 读取；
//   - user_id 从登录 session 中读取；
//   - 时间戳由后端生成。
type highlightCreate struct {
	ChapterID    *string `json:"chapterId,omitempty"`
	PageNo       *int    `json:"pageNo,omitempty"`
	Locator      string  `json:"locator"`
	SelectedText string  `json:"selectedText"`
	Color        string  `json:"color"`
	Style        string  `json:"style,omitempty"`
}

// HandleListHighlights 处理：GET /api/books/{id}/highlights。
//
// 用途：阅读器打开一本书时，加载这本书已有的所有标注，然后前端把它们重新渲染到正文里。
//
// 重要点：
//   - WHERE user_id = ? AND book_id = ?：保证只能读自己的书内标注；
//   - deleted_at IS NULL：软删除的数据不再返回；
//   - LIMIT 5000：避免极端情况下单次响应过大。
//     对普通阅读场景，单本书 5000 条标注已经非常多。
func (h *Handler) HandleListHighlights(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")

	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT id, book_id, chapter_id, page_no, locator, selected_text, color, style, created_at, updated_at
		FROM highlights
		WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL
		ORDER BY created_at ASC
		LIMIT 5000
	`, user.ID, bookID)
	if err != nil {
		response.FailSafe(w, "highlights.list", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()

	out := make([]highlightDTO, 0, 32)
	for rows.Next() {
		var d highlightDTO

		// 数据库里的 chapter_id/page_no 可以为 NULL。
		// Go 的普通 string/int 无法表示 SQL NULL，因此需要 sql.NullString/sql.NullInt64。
		var chapter sql.NullString
		var page sql.NullInt64

		if err := rows.Scan(&d.ID, &d.BookID, &chapter, &page, &d.Locator,
			&d.SelectedText, &d.Color, &d.Style, &d.CreatedAt, &d.UpdatedAt); err != nil {
			response.FailSafe(w, "highlights.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if chapter.Valid {
			s := chapter.String
			d.ChapterID = &s
		}
		if page.Valid {
			n := int(page.Int64)
			d.PageNo = &n
		}
		out = append(out, d)
	}

	// rows.Err 用于检查迭代过程中是否出现延迟错误。
	// 当前代码原本没有检查，为保持逻辑不变不新增返回分支；你后续可以考虑补充。
	response.OK(w, map[string]any{"highlights": out})
}

// HandleCreateHighlight 处理：POST /api/books/{id}/highlights。
//
// 用途：用户在阅读器里选中文字并点击“高亮/下划线/波浪线/删除线”时创建标注。
//
// 安全与校验：
//   - 先 ownsBook 确认当前用户拥有这本书；
//   - request body 限制 64KiB，避免超大 selectedText 占用内存；
//   - selectedText 和 locator 必填；
//   - color/style 不合法时使用安全默认值。
func (h *Handler) HandleCreateHighlight(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")

	if !ownsBook(r, h.DB, user.ID, bookID) {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	var body highlightCreate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}

	body.SelectedText = strings.TrimSpace(body.SelectedText)
	body.Locator = strings.TrimSpace(body.Locator)
	if body.SelectedText == "" || body.Locator == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "selectedText 与 locator 必填")
		return
	}

	if !validColor(body.Color) {
		body.Color = "yellow"
	}
	if !validStyle(body.Style) {
		body.Style = "highlight"
	}

	id := security.RandomID()
	now := time.Now().Unix()

	if _, err := h.DB.ExecContext(r.Context(), `
		INSERT INTO highlights (id, user_id, book_id, chapter_id, page_no, locator,
		                        selected_text, color, style, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, id, user.ID, bookID,
		nullStrPtr(body.ChapterID), nullIntPtr(body.PageNo),
		body.Locator, body.SelectedText, body.Color, body.Style, now, now); err != nil {
		response.FailSafe(w, "highlights.create", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// Created 表示 HTTP 201，比普通 OK 更符合“创建了一条新资源”的语义。
	response.Created(w, map[string]any{
		"highlight": highlightDTO{
			ID:           id,
			BookID:       bookID,
			ChapterID:    body.ChapterID,
			PageNo:       body.PageNo,
			Locator:      body.Locator,
			SelectedText: body.SelectedText,
			Color:        body.Color,
			Style:        body.Style,
			CreatedAt:    now,
			UpdatedAt:    now,
		},
	})
}

// HandleDeleteHighlight 处理：DELETE /api/highlights/{id}。
//
// 删除策略：软删除。
// 即不真正 DELETE 行，而是设置 deleted_at。
//
// 为什么软删除？
//   - 避免误删后无法排查；
//   - 未来可以做回收站/撤销；
//   - 对搜索索引和关联数据更温和。
//
// 当前列表接口都会加 deleted_at IS NULL，因此软删除后前端就看不到它。
func (h *Handler) HandleDeleteHighlight(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	hlID := r.PathValue("id")
	now := time.Now().Unix()

	res, err := h.DB.ExecContext(r.Context(), `
		UPDATE highlights SET deleted_at = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND deleted_at IS NULL
	`, now, now, hlID, user.ID)
	if err != nil {
		response.FailSafe(w, "highlights.delete", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	n, _ := res.RowsAffected()
	if n == 0 {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "高亮不存在")
		return
	}

	response.OK(w, map[string]any{"deleted": true})
}

// ── notes ────────────────────────────────────────────────────────────
//
// note 表示用户写下的笔记文本。
// 它可以：
//   - 关联到某个 highlight：highlight_id 非空；
//   - 独立定位到某段文字：locator + selected_text；
//   - 按 book_id/chapter_id/page_no 和具体书籍位置关联。

// noteDTO 是返回给前端的笔记结构。
type noteDTO struct {
	ID     string `json:"id"`
	BookID string `json:"bookId"`

	// HighlightID 表示这条笔记依附在哪个标注上。
	// 如果为空，说明它是没有绑定 highlight 的独立笔记。
	HighlightID *string `json:"highlightId,omitempty"`

	ChapterID *string `json:"chapterId,omitempty"`
	PageNo    *int    `json:"pageNo,omitempty"`

	// Locator 用于回到书中对应位置。
	Locator string `json:"locator"`

	// SelectedText 是写笔记时选中的原文，可以为空。
	SelectedText *string `json:"selectedText,omitempty"`

	// Body 是笔记正文。
	Body string `json:"body"`

	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
}

// noteCreate 是创建笔记时前端提交的请求体。
type noteCreate struct {
	HighlightID  *string `json:"highlightId,omitempty"`
	ChapterID    *string `json:"chapterId,omitempty"`
	PageNo       *int    `json:"pageNo,omitempty"`
	Locator      string  `json:"locator"`
	SelectedText *string `json:"selectedText,omitempty"`
	Body         string  `json:"body"`
}

// HandleListNotes 处理：GET /api/books/{id}/notes。
//
// 用途：阅读器打开一本书时，加载这本书下的笔记。
// TxtReader 会根据 highlightId 判断某个标注是否带有笔记，从而显示不同样式。
func (h *Handler) HandleListNotes(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")

	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT id, book_id, highlight_id, chapter_id, page_no, locator,
		       selected_text, body, created_at, updated_at
		FROM notes
		WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL
		ORDER BY created_at DESC
		LIMIT 5000
	`, user.ID, bookID)
	if err != nil {
		response.FailSafe(w, "notes.list", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()

	out := make([]noteDTO, 0, 32)
	for rows.Next() {
		var d noteDTO
		var hl, chapter, sel sql.NullString
		var page sql.NullInt64

		if err := rows.Scan(&d.ID, &d.BookID, &hl, &chapter, &page,
			&d.Locator, &sel, &d.Body, &d.CreatedAt, &d.UpdatedAt); err != nil {
			response.FailSafe(w, "notes.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if hl.Valid {
			s := hl.String
			d.HighlightID = &s
		}
		if chapter.Valid {
			s := chapter.String
			d.ChapterID = &s
		}
		if sel.Valid {
			s := sel.String
			d.SelectedText = &s
		}
		if page.Valid {
			n := int(page.Int64)
			d.PageNo = &n
		}
		out = append(out, d)
	}

	response.OK(w, map[string]any{"notes": out})
}

// HandleListAllNotes 处理：GET /api/notes。
//
// 用途：笔记汇总页展示“当前用户所有书籍里的笔记”。
// 与单本书接口不同，这里会 JOIN books 表，把 bookTitle 一起返回，方便前端展示：
//   - 笔记内容；
//   - 来自哪本书；
//   - 点击后跳回对应书籍。
//
// LIMIT 1000 是低内存/低带宽保护：
// 如果一个用户有海量笔记，后续更适合做分页，而不是一次性全部返回。
func (h *Handler) HandleListAllNotes(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())

	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT n.id, n.book_id, b.title, n.chapter_id, n.locator,
		       n.selected_text, n.body, n.created_at, n.updated_at
		FROM notes n
		JOIN books b ON b.id = n.book_id AND b.user_id = n.user_id
		WHERE n.user_id = ? AND n.deleted_at IS NULL
		ORDER BY n.updated_at DESC
		LIMIT 1000
	`, user.ID)
	if err != nil {
		response.FailSafe(w, "notes.all", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()

	// 这个 dto 只在当前函数使用，因此定义在函数内部。
	// 好处是不会污染 package 顶层命名，也能清楚表达“这是 /api/notes 的响应形状”。
	type dto struct {
		ID           string  `json:"id"`
		BookID       string  `json:"bookId"`
		BookTitle    string  `json:"bookTitle"`
		ChapterID    *string `json:"chapterId,omitempty"`
		Locator      string  `json:"locator"`
		SelectedText *string `json:"selectedText,omitempty"`
		Body         string  `json:"body"`
		CreatedAt    int64   `json:"createdAt"`
		UpdatedAt    int64   `json:"updatedAt"`
	}

	out := make([]dto, 0, 32)
	for rows.Next() {
		var d dto
		var chapter, sel sql.NullString

		if err := rows.Scan(&d.ID, &d.BookID, &d.BookTitle, &chapter,
			&d.Locator, &sel, &d.Body, &d.CreatedAt, &d.UpdatedAt); err != nil {
			response.FailSafe(w, "notes.all.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if chapter.Valid {
			s := chapter.String
			d.ChapterID = &s
		}
		if sel.Valid {
			s := sel.String
			d.SelectedText = &s
		}
		out = append(out, d)
	}

	response.OK(w, map[string]any{"notes": out})
}

// HandleListAllHighlights 处理：GET /api/highlights。
//
// 用途：跨书汇总当前用户的所有标注。
// NotesPage 可以同时请求 /api/highlights 和 /api/notes，然后在前端按 book、时间、locator
// 合并展示“标注与笔记”。
//
// 为什么 LIMIT 2000？
//   - 标注通常比笔记更多；
//   - 2000 条响应已经足以覆盖普通用户；
//   - 防止一次性返回过大 JSON，影响小内存后端和浏览器渲染。
//
// 如果未来要支持重度用户，应增加分页参数，例如 cursor/limit。
func (h *Handler) HandleListAllHighlights(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())

	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT hl.id, hl.book_id, b.title, hl.chapter_id, hl.page_no,
		       hl.locator, hl.selected_text, hl.color, hl.style,
		       hl.created_at, hl.updated_at
		FROM highlights hl
		JOIN books b ON b.id = hl.book_id AND b.user_id = hl.user_id
		WHERE hl.user_id = ? AND hl.deleted_at IS NULL
		ORDER BY hl.updated_at DESC
		LIMIT 2000
	`, user.ID)
	if err != nil {
		response.FailSafe(w, "highlights.all", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()

	type dto struct {
		ID           string  `json:"id"`
		BookID       string  `json:"bookId"`
		BookTitle    string  `json:"bookTitle"`
		ChapterID    *string `json:"chapterId,omitempty"`
		PageNo       *int    `json:"pageNo,omitempty"`
		Locator      string  `json:"locator"`
		SelectedText string  `json:"selectedText"`
		Color        string  `json:"color"`
		Style        string  `json:"style"`
		CreatedAt    int64   `json:"createdAt"`
		UpdatedAt    int64   `json:"updatedAt"`
	}

	out := make([]dto, 0, 32)
	for rows.Next() {
		var d dto
		var chapter sql.NullString
		var page sql.NullInt64

		if err := rows.Scan(&d.ID, &d.BookID, &d.BookTitle, &chapter, &page,
			&d.Locator, &d.SelectedText, &d.Color, &d.Style,
			&d.CreatedAt, &d.UpdatedAt); err != nil {
			response.FailSafe(w, "highlights.all.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if chapter.Valid {
			s := chapter.String
			d.ChapterID = &s
		}
		if page.Valid {
			n := int(page.Int64)
			d.PageNo = &n
		}
		out = append(out, d)
	}

	response.OK(w, map[string]any{"highlights": out})
}

// HandleCreateNote 处理：POST /api/books/{id}/notes。
//
// 用途：在某本书里创建一条笔记。
// 前端可能有两种路径：
//   - 用户先创建高亮，再给高亮写笔记：HighlightID 非空；
//   - 用户直接选择文字写笔记：前端通常会先创建 highlight，再创建 note。
//
// 这里会同步写入 search_text：
//   - search.SearchText(body.Body) 会生成适合 SQLite FTS5 的索引文本；
//   - 后续 /api/search 搜笔记时不需要实时分词所有笔记。
func (h *Handler) HandleCreateNote(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")

	if !ownsBook(r, h.DB, user.ID, bookID) {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	var body noteCreate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}

	body.Body = strings.TrimSpace(body.Body)
	body.Locator = strings.TrimSpace(body.Locator)
	if body.Body == "" || body.Locator == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "body 与 locator 必填")
		return
	}

	id := security.RandomID()
	now := time.Now().Unix()
	searchText := search.SearchText(body.Body)

	if _, err := h.DB.ExecContext(r.Context(), `
		INSERT INTO notes (id, user_id, book_id, highlight_id, chapter_id, page_no, locator,
		                   selected_text, body, search_text, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, id, user.ID, bookID,
		nullStrPtr(body.HighlightID), nullStrPtr(body.ChapterID), nullIntPtr(body.PageNo),
		body.Locator, nullStrPtr(body.SelectedText), body.Body, searchText, now, now); err != nil {
		response.FailSafe(w, "notes.create", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	response.Created(w, map[string]any{
		"note": noteDTO{
			ID:           id,
			BookID:       bookID,
			HighlightID:  body.HighlightID,
			ChapterID:    body.ChapterID,
			PageNo:       body.PageNo,
			Locator:      body.Locator,
			SelectedText: body.SelectedText,
			Body:         body.Body,
			CreatedAt:    now,
			UpdatedAt:    now,
		},
	})
}

// HandleUpdateNote 处理：PUT /api/notes/{id}。
//
// 用途：修改笔记正文。
// 注意这里只允许改 body，不允许改 book_id、locator、highlight_id 等定位字段。
// 这能降低接口复杂度，也避免用户编辑正文时不小心破坏定位关系。
//
// 更新 body 时必须同步更新 search_text，否则全文搜索会搜到旧内容。
func (h *Handler) HandleUpdateNote(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	noteID := r.PathValue("id")

	var body struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}

	body.Body = strings.TrimSpace(body.Body)
	if body.Body == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "body 不能为空")
		return
	}

	now := time.Now().Unix()
	searchText := search.SearchText(body.Body)

	res, err := h.DB.ExecContext(r.Context(), `
		UPDATE notes SET body = ?, search_text = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND deleted_at IS NULL
	`, body.Body, searchText, now, noteID, user.ID)
	if err != nil {
		response.FailSafe(w, "notes.update", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	n, _ := res.RowsAffected()
	if n == 0 {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "笔记不存在")
		return
	}

	response.OK(w, map[string]any{"updated": true})
}

// HandleDeleteNote 处理：DELETE /api/notes/{id}。
//
// 和 highlight 一样，这里也是软删除：设置 deleted_at，而不是物理删除行。
// 列表接口和搜索接口会忽略 deleted_at 非空的数据。
func (h *Handler) HandleDeleteNote(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	noteID := r.PathValue("id")
	now := time.Now().Unix()

	res, err := h.DB.ExecContext(r.Context(), `
		UPDATE notes SET deleted_at = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND deleted_at IS NULL
	`, now, now, noteID, user.ID)
	if err != nil {
		response.FailSafe(w, "notes.delete", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	n, _ := res.RowsAffected()
	if n == 0 {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "笔记不存在")
		return
	}

	response.OK(w, map[string]any{"deleted": true})
}

// ── helpers ──────────────────────────────────────────────────────────

// ownsBook 检查某本书是否属于当前用户。
//
// 多数“按 book 创建资源”的接口都应该先调用它，例如：
//   - 给书创建高亮；
//   - 给书创建笔记。
//
// 返回 false 的情况包括：
//   - bookID 为空；
//   - 数据库查不到；
//   - 查询出错。
//
// 这里把数据库错误也当成 false，是为了在 helper 中保持简单。
// 真正需要区分数据库错误的场景，可以改成返回 (bool, error)。
func ownsBook(r *http.Request, db *sql.DB, userID, bookID string) bool {
	if bookID == "" {
		return false
	}

	var n int
	err := db.QueryRowContext(r.Context(),
		`SELECT 1 FROM books WHERE id = ? AND user_id = ? LIMIT 1`,
		bookID, userID).Scan(&n)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false
		}
		return false
	}
	return n == 1
}

// validColor 限制前端能写入的颜色枚举。
//
// 为什么不允许任意字符串？
//   - 防止把任意 CSS/脏数据写进数据库；
//   - 保证前端主题映射简单稳定；
//   - 方便未来 Android 端复用同一套颜色语义。
func validColor(c string) bool {
	switch c {
	case "yellow", "red", "green", "blue", "purple", "orange":
		return true
	}
	return false
}

// validStyle 限制 highlight.style 的枚举值。
//
// 它必须和：
//   - migration 0019 支持的值；
//   - 前端 HighlightStyle 类型；
//   - SelectionToolbar 中的样式按钮
//
// 保持一致。
func validStyle(s string) bool {
	switch s {
	case "highlight", "underline", "wavy", "strike":
		return true
	}
	return false
}

// nullStrPtr 把 *string 转换成 SQL 参数。
//   - nil 或空字符串 → SQL NULL；
//   - 非空字符串 → TEXT。
//
// ExecContext 的参数类型是 any，所以这里返回 any。
func nullStrPtr(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}

// nullIntPtr 把 *int 转换成 SQL 参数。
//   - nil → SQL NULL；
//   - 非 nil → INTEGER。
func nullIntPtr(i *int) any {
	if i == nil {
		return nil
	}
	return *i
}
