// Package chapters 负责“章节读取”和“目录读取”这两组接口。
//
// 在 BookFree 的阅读链路中，一本书上传并 ingest 之后，会被拆成：
//   - books：书籍元数据，例如标题、作者、格式、状态；
//   - book_chapters：章节列表与章节正文；
//   - books.toc：解析器提取出的层级目录 JSON。
//
// 本包提供的接口主要被前端 ReaderPage / TocDrawer / TxtReader 使用：
//   - GET /api/books/{id}/chapters/list：读取章节索引，不含正文；
//   - GET /api/books/{id}/chapters/{chapterId}：读取某一章正文；
//   - GET /api/books/{id}/toc：读取层级目录，若没有层级目录则退化为章节列表。
//
// 低内存设计说明：
//   - 章节列表接口只读取 id/title/href 等轻量字段，不读取正文；
//   - 单章正文接口一次只读取用户正在看的那一章，不把整本书所有章节加载进内存；
//   - TOC 如果已经存为 JSON 字符串，则直接透传给响应，避免每次请求都反序列化再序列化。
package chapters

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"bookfree/internal/auth"
	"bookfree/internal/response"
)

// Handler 是 chapters 模块的 HTTP 处理器。
//
// 它和 books.Handler、progress.Handler 类似：
//   - 不在全局变量里直接拿数据库；
//   - 而是由 main.go/router.go 创建时把依赖注入进来；
//   - 这样更容易测试，也方便未来 Android 复用同一套 HTTP API。
type Handler struct {
	// DB 是 database/sql 的数据库连接池句柄。
	//
	// 注意：*sql.DB 不是“一条连接”，而是 Go 标准库维护的连接池入口。
	// 这里所有章节查询都通过 DB 发往 SQLite。
	DB *sql.DB

	// IsProd 表示当前是否生产环境。
	//
	// response.FailSafe 会根据它决定是否把真实错误细节暴露给前端。
	// 生产环境隐藏内部错误可以避免泄露 SQL、路径等敏感信息。
	IsProd bool
}

// HandleList 处理：GET /api/books/{id}/chapters/list
//
// 作用：返回某本书的“章节索引”，也就是章节 id、顺序、标题、href。
// 它不返回章节正文，因此非常轻量。
//
// 前端使用位置：
//   - ReaderPage 打开书籍后会先请求章节列表；
//   - TxtReader 用章节列表知道“上一章/下一章”应该跳到哪里；
//   - 如果书籍没有独立 TOC，前端也可以用章节列表构造基础目录。
//
// 返回形状大致是：
//
//	{
//	  "ok": true,
//	  "data": {
//	    "chapters": [
//	      { "id": "...", "ord": 0, "title": "第一章", "href": "chapter1.html" }
//	    ]
//	  }
//	}
//
// 权限说明：
//   - 必须用当前登录用户 user.ID + bookID 检查 ownership；
//   - 不能只按 bookID 查，否则用户可能猜到别人书籍 id 后读取章节列表。
func (h *Handler) HandleList(w http.ResponseWriter, r *http.Request) {
	// auth.RequireUser 中间件会把当前用户放入 context。
	// 这里取出来用于所有权校验和 user_id 过滤。
	user := auth.UserFromContext(r.Context())

	// Go 1.22 的 ServeMux 支持从路由模板中取路径参数。
	// 该接口在 router.go 中注册为 /api/books/{id}/chapters/list。
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// 先确认这本书属于当前用户。
	//
	// 虽然后面的 SELECT book_chapters 也带了 user_id 条件，
	// 但这里提前返回“书籍不存在”，可以让错误语义更清晰：
	// “没有这本书”与“这本书没有章节”不是同一件事。
	if !ownsBook(r, h.DB, user.ID, bookID) {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	// 只查询章节索引字段，不查询 html/text 正文。
	//
	// 这对内存很重要：
	// - 一本书可能有很多章；
	// - 每章正文可能很长；
	// - 列表页/目录页只需要标题和顺序，不需要正文。
	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT id, ord, title, href
		FROM book_chapters
		WHERE book_id = ? AND user_id = ?
		ORDER BY ord ASC
	`, bookID, user.ID)
	if err != nil {
		response.FailSafe(w, "chapters.list", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	// rows.Close 必须调用，否则底层数据库连接可能无法及时归还连接池。
	defer rows.Close()

	// chapterDTO 是“后端返回给前端的章节列表结构”。
	//
	// 它不是数据库表结构的完整映射，只包含前端需要展示/跳转的字段。
	// `omitempty` 表示字段为 nil 时不输出到 JSON，减少响应体体积。
	type chapterDTO struct {
		ID    string  `json:"id"`
		Ord   int     `json:"ord"`
		Title *string `json:"title,omitempty"`
		Href  *string `json:"href,omitempty"`
	}

	// 预分配 32 个容量只是一个温和优化：
	// - 大多数书的章节数不会特别夸张；
	// - 即使超过 32，append 也会自动扩容；
	// - 不会为了“可能的大书”预分配大块内存。
	out := make([]chapterDTO, 0, 32)
	for rows.Next() {
		var c chapterDTO

		// title/href 在数据库中允许 NULL。
		//
		// Go 里不能直接把 SQL NULL 扫到 string，因为 string 无法表示“没有值”。
		// sql.NullString 同时包含：
		//   - String：真实字符串；
		//   - Valid：数据库里是不是非 NULL。
		var title, href sql.NullString
		if err := rows.Scan(&c.ID, &c.Ord, &title, &href); err != nil {
			response.FailSafe(w, "chapters.list.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if title.Valid {
			c.Title = &title.String
		}
		if href.Valid {
			c.Href = &href.String
		}
		out = append(out, c)
	}
	// 这里原文件没有 rows.Err 检查。
	// 对 SQLite 本地查询来说出错概率较低，但如果后续要更严谨，
	// 可以在循环后加：
	//   if err := rows.Err(); err != nil { ... }
	response.OK(w, map[string]any{"chapters": out})
}

// HandleGet 处理：GET /api/books/{id}/chapters/{chapterId}
//
// 作用：返回“某一章”的正文内容。
//
// 与 HandleList 的区别：
//   - HandleList 只返回章节索引；
//   - HandleGet 会读取 html/text 正文，正文可能较大。
//
// 前端使用位置：
//   - TxtReader 进入某章时请求这一章内容；
//   - ReaderPage 根据章节 id/ord 控制上一章、下一章和阅读进度。
//
// 返回字段说明：
//   - html：解析器生成的 HTML 正文，适合富文本展示；
//   - text：纯文本正文，适合搜索、AI、降级显示等；
//   - title/href：都可能为空，所以用指针字段输出 JSON。
//
// 低内存设计：
//   - 每次只查一章，不一次性查整本书所有正文；
//   - 这比把全文塞到一个大 JSON 里返回更适合低内存后端。
func (h *Handler) HandleGet(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	chapterID := r.PathValue("chapterId")
	if bookID == "" || chapterID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "参数不完整")
		return
	}

	// 这里同时按 id、book_id、user_id 过滤。
	//
	// 这样即使 chapterID 被猜到，也必须满足：
	//   - 章节属于这本书；
	//   - 这本书属于当前用户。
	row := h.DB.QueryRowContext(r.Context(), `
		SELECT id, ord, title, href, html, text
		FROM book_chapters
		WHERE id = ? AND book_id = ? AND user_id = ?
		LIMIT 1
	`, chapterID, bookID, user.ID)

	// body 是单章响应 DTO。
	//
	// 指针字段配合 omitempty：
	// - 数据库 NULL → JSON 不输出这个字段；
	// - 数据库有值 → JSON 输出字符串。
	type body struct {
		ID    string  `json:"id"`
		Ord   int     `json:"ord"`
		Title *string `json:"title,omitempty"`
		Href  *string `json:"href,omitempty"`
		HTML  *string `json:"html,omitempty"`
		Text  *string `json:"text,omitempty"`
	}

	var (
		b body

		// 这些列都可能是 SQL NULL，所以统一用 sql.NullString 承接。
		title, href, html, text sql.NullString
	)
	if err := row.Scan(&b.ID, &b.Ord, &title, &href, &html, &text); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "章节不存在")
			return
		}
		response.FailSafe(w, "chapters.get", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if title.Valid {
		b.Title = &title.String
	}
	if href.Valid {
		b.Href = &href.String
	}
	if html.Valid {
		b.HTML = &html.String
	}
	if text.Valid {
		b.Text = &text.String
	}
	response.OK(w, map[string]any{"chapter": b})
}

// ownsBook 判断某本书是否属于某个用户。
//
// 这是一个很小的权限辅助函数。
// 返回 bool 而不是 error 的原因：
//   - 调用方只需要知道“能不能访问”；
//   - 查询不到、数据库错误都统一按 false 处理，避免误放行。
//
// 如果未来需要把“数据库错误”和“不存在”区分开，可以改成：
//
//	func ownsBook(...) (bool, error)
func ownsBook(r *http.Request, db *sql.DB, userID, bookID string) bool {
	var n int
	row := db.QueryRowContext(r.Context(),
		`SELECT 1 FROM books WHERE id = ? AND user_id = ? LIMIT 1`,
		bookID, userID)
	if err := row.Scan(&n); err != nil {
		return false
	}
	return n == 1
}

// HandleTOC 处理：GET /api/books/{id}/toc
//
// 作用：返回层级目录（Table of Contents）。
//
// ReaderPage 打开一本书后，会请求这个接口，并把结果传给 TocDrawer。
// TocDrawer 负责展示“目录抽屉”，用户点击目录项后跳到对应章节或定位点。
//
// 数据来源有两种：
//
// 1. 优先使用 books.toc 中保存的真实层级目录
//
//   - EPUB、MOBI 等格式通常自带目录结构；
//   - 前端 parser 在 ingest 阶段会提取 TOC；
//   - 后端把 TOC JSON 存在 books.toc；
//   - 读取时直接返回给前端。
//
// 2. 如果没有 books.toc，则从 book_chapters 合成扁平目录
//
//   - 老数据可能没有 toc 字段；
//   - TXT 这类格式可能没有天然层级目录；
//   - 但前端 TocDrawer 仍然应该有东西可显示；
//   - 所以退化为“第 1 章、第 2 章……”这种平铺列表。
//
// stored TOC 的数据形状大致是：
//
//	{
//	  "items": [
//	    {
//	      "label": "Part I",
//	      "depth": 0,
//	      "children": [
//	        { "label": "Chapter 1", "chapterId": "...", "depth": 1, "children": [] }
//	      ]
//	    }
//	  ]
//	}
//
// 注意：数据库中保存的是 items 数组本身，而本接口包装成统一响应信封。
func (h *Handler) HandleTOC(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// 先从 books 表读取 toc，并且用 user_id 做所有权过滤。
	//
	// 这一步同时完成了“书是否存在”和“是否属于当前用户”的判断。
	var stored sql.NullString
	err := h.DB.QueryRowContext(r.Context(),
		`SELECT toc FROM books WHERE id = ? AND user_id = ? LIMIT 1`,
		bookID, user.ID).Scan(&stored)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
			return
		}
		response.FailSafe(w, "chapters.toc.lookup", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	if stored.Valid && strings.TrimSpace(stored.String) != "" {
		// 这里选择“直接拼接 JSON 并写出”，而不是：
		//   json.Unmarshal(stored.String) → 再 json.Marshal(...)
		//
		// 原因：
		//   - TOC 在 ingest 写入时就应该已经验证过格式；
		//   - 每次读目录都反序列化会增加 CPU 和短生命周期内存分配；
		//   - BookFree 目标是低内存常驻服务，读接口应尽量轻。
		//
		// 注意安全前提：
		//   stored.String 必须是后端可信流程写入的合法 JSON；
		//   不应让用户直接提交任意字符串写入 toc。
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"ok":true,"data":{"items":` + stored.String + `}}`))
		return
	}

	// Fallback：没有真实 TOC 时，从章节表合成一个“扁平目录”。
	//
	// 只读取 id/ord/title，不读取章节正文。
	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT id, ord, title
		FROM book_chapters
		WHERE book_id = ? AND user_id = ?
		ORDER BY ord ASC
	`, bookID, user.ID)
	if err != nil {
		response.FailSafe(w, "chapters.toc.fallback", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()

	// item 是 TocDrawer 能识别的基础目录节点。
	//
	// ChapterID 指向章节；Depth 表示层级深度。
	// fallback 没有真实层级，所以所有节点 Depth 都是 0。
	type item struct {
		Label     string  `json:"label"`
		ChapterID *string `json:"chapterId,omitempty"`
		Depth     int     `json:"depth"`
	}

	out := make([]item, 0, 32)
	for rows.Next() {
		var (
			id    string
			ord   int
			title sql.NullString
		)
		if err := rows.Scan(&id, &ord, &title); err != nil {
			response.FailSafe(w, "chapters.toc.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}

		// title.String 即使 title.Valid=false 也会是空字符串。
		// 这里 TrimSpace 后为空，就用“第 N 章”兜底。
		label := strings.TrimSpace(title.String)
		if label == "" {
			label = chapterFallbackLabel(ord)
		}

		// 注意：循环变量 id 每次都会变。
		// 如果直接写 ChapterID: &id，虽然 Go 当前语义下通常也能工作，
		// 但显式复制一份 idCopy 更容易让初学者理解：
		// 每个目录项都持有自己那一章的 id 地址。
		idCopy := id
		out = append(out, item{Label: label, ChapterID: &idCopy, Depth: 0})
	}
	response.OK(w, map[string]any{"items": out})
}

// chapterFallbackLabel 生成没有标题时显示的章节名。
//
// ord 在数据库里是从 0 开始的顺序号：
//   - ord=0 表示第一章；
//   - ord=1 表示第二章。
//
// 但给用户看的文字应从 1 开始，所以这里用 ord+1。
// 保持“第 N 章”的中文格式，是为了兼容旧版 TocDrawer 的显示习惯。
func chapterFallbackLabel(ord int) string {
	return "第 " + strconv.Itoa(ord+1) + " 章"
}
