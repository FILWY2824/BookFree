// Package search 负责 BookFree 的全文搜索子系统。
//
// 这个包里目前有两类核心能力：
//  1. tokenize.go：把中文、英文、数字文本切成适合 SQLite FTS5 检索的 token；
//  2. handler.go：实现 GET /api/search，对书籍正文 chunks 和用户笔记 notes 执行 FTS5 MATCH 查询。
//
// 为什么这里要特别强调 FTS5？
// BookFree 早期曾经使用过“每次搜索时，把大量 chunks 加载到内存里，再临时建立 MiniSearch
// 倒排索引”的方案。这个方案在小书库里能跑，但对本项目的 50MB 常驻内存目标非常不友好：
//  1. 每次查询都可能把几千个文本块加载到 Go 堆内存；
//  2. 临时倒排索引会制造大量短生命周期对象；
//  3. 并发搜索时内存峰值不稳定。
//
// 现在的方案是：导入书籍时就把可搜索文本写入 SQLite FTS5 虚表；搜索时只把查询条件交给
// SQLite，由 SQLite 返回有限数量的命中结果。这样 Go 进程常驻内存更稳定，也更符合
// “轻量单体 + SQLite + 低内存”的架构约束。
package search

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"

	"bookfree/internal/auth"
	"bookfree/internal/response"
)

// Handler 是 search 模块的 HTTP 处理器依赖容器。
//
// 在 Go 后端里，经常会把一组相关接口的方法挂在同一个 Handler 结构体上。
// 这样做的好处是：
//  1. 每个方法都能访问同一批依赖，比如 DB；
//  2. 依赖从 main/router 层注入，方便测试时替换；
//  3. 不需要使用大量全局变量，代码边界更清晰。
type Handler struct {
	// DB 是 database/sql 的数据库连接池句柄。
	//
	// 注意：*sql.DB 不是一条数据库连接，而是连接池管理器。
	// 在本项目中，底层数据库是 SQLite，并且连接数在 db.Open 中被限制得很小，
	// 这是为了避免本地自托管场景下出现不必要的常驻内存增长。
	DB *sql.DB

	// IsProd 表示当前是否为生产环境。
	//
	// 它会传给 response.FailSafe：
	//   - 生产环境：隐藏真实错误细节，避免泄露 SQL、路径等内部信息；
	//   - 开发环境：返回更具体的错误，方便排查。
	IsProd bool
}

// HandleSearch 处理全文搜索接口：
//
//	GET /api/search?q=关键词&bookId=可选书籍ID&exact=1&limit=30
//
// 前端典型调用位置：
//  1. SearchPage：全局搜索书库中的正文和笔记；
//  2. ReaderPage：在某一本书内搜索，并通过结果跳回具体章节、页码或 locator；
//  3. NotesPage：搜索用户笔记。
//
// 查询参数说明：
//  1. q：用户输入的搜索词，必填；
//  2. bookId：可选。如果传入，则只在某一本书内搜索；
//  3. exact：可选。当 exact=1 时，在 FTS5 找到候选结果后，再检查原文是否包含完整 q；
//  4. limit：可选。默认 30，最大 200，避免单次搜索返回过多内容。
//
// 返回结构保持为前端容易消费的统一形状：
//
//	{
//	  "q": "用户输入",
//	  "chunks": [正文命中列表],
//	  "notes":  [笔记命中列表]
//	}
//
// 注意：这里不直接返回 response 信封外层的 ok/data/error，
// 因为 response.OK 会自动把 data 包进统一信封。
func (h *Handler) HandleSearch(w http.ResponseWriter, r *http.Request) {
	// auth.UserFromContext 从认证中间件写入的 context 中取当前用户。
	//
	// /api/search 路由在 router.go 中受 auth.RequireUser 保护，
	// 因此正常情况下这里一定能拿到 user。
	// 后续查询必须带上 user.ID，保证多用户隔离：
	// A 用户不能搜索到 B 用户上传的书籍正文或笔记。
	user := auth.UserFromContext(r.Context())

	// TrimSpace 去掉首尾空白。
	//
	// 例如用户输入 "  量子纠缠  "，实际搜索词应视为 "量子纠缠"。
	q := strings.TrimSpace(r.URL.Query().Get("q"))

	// bookId 是可选范围过滤。
	//
	// 不传 bookId：搜索当前用户所有书和笔记；
	// 传 bookId：只搜索当前用户这一本书相关的正文和笔记。
	bookID := strings.TrimSpace(r.URL.Query().Get("bookId"))

	// exact=1 表示开启“精确包含”后过滤。
	//
	// FTS5 的中文 bigram 搜索是先找候选集，例如 “量子纠缠” 会变成：
	//   "量子" "子纠" "纠缠"
	// 如果 exact=true，我们还会检查 plain text 中是否真的包含完整的 “量子纠缠”。
	// 这样可以让搜索结果列表与阅读页黄色高亮行为保持一致。
	exact := r.URL.Query().Get("exact") == "1"

	// 空搜索词不是错误。
	//
	// 前端输入框刚打开、用户清空输入时都可能发出空 q。
	// 这时返回空数组，让前端渲染“无结果/等待输入”即可。
	if q == "" {
		response.OK(w, map[string]any{"q": q, "chunks": []any{}, "notes": []any{}})
		return
	}

	// QueryString 会调用 tokenize.go 中的 Tokenize，
	// 把用户输入转换为 SQLite FTS5 MATCH 表达式。
	//
	// 例如：
	//   q = "量子纠缠"
	//   tokens = ["量子", "子纠", "纠缠"]
	//   matchExpr = "\"量子\" \"子纠\" \"纠缠\""
	//
	// 如果用户输入全是标点、空白或当前不支持的字符，matchExpr 可能为空。
	matchExpr := QueryString(q)
	if matchExpr == "" {
		response.OK(w, map[string]any{"q": q, "chunks": []any{}, "notes": []any{}})
		return
	}

	// parseLimit 负责限制单次查询结果数量。
	//
	// 默认 30 条，最多 200 条。
	// 这既能防止接口返回过大的 JSON，也能减少 Go 进程一次性分配过多结果切片。
	chunkLimit := parseLimit(r.URL.Query().Get("limit"), 30, 200)

	// 先查询书籍正文 chunks。
	//
	// chunks 是 ingest 阶段从书籍正文中切出来的可搜索文本块。
	// 命中结果中会包含 bookId、chapterId、chapterOrd、pageNo、locator 等跳转信息，
	// 前端可以据此跳到阅读器里的具体位置。
	chunks, err := h.queryChunks(r, user.ID, matchExpr, bookID, q, exact, chunkLimit)
	if err != nil {
		response.FailSafe(w, "search.chunks", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// 再查询用户笔记 notes。
	//
	// 即使当前页面只展示正文结果，后端也保持同时返回 chunks 和 notes。
	// 这样 API 形状稳定，Web 前端和未来 Android 客户端都可以按需展示。
	notes, err := h.queryNotes(r, user.ID, matchExpr, bookID, q, exact, chunkLimit)
	if err != nil {
		response.FailSafe(w, "search.notes", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	response.OK(w, map[string]any{
		"q":      q,
		"chunks": chunks,
		"notes":  notes,
	})
}

// chunkHit 是“书籍正文搜索命中”的 JSON DTO。
//
// DTO 是 Data Transfer Object 的缩写，表示“专门给接口传输用的数据结构”。
// 它不一定和数据库表一一对应，而是按前端需要组织字段。
type chunkHit struct {
	// ID 是 chunk 的唯一 ID，对应 FTS 表中的 chunk_id。
	ID string `json:"id"`

	// BookID / BookTitle 用于前端展示“命中了哪本书”，也用于跳转到 /book/:id。
	BookID    string `json:"bookId"`
	BookTitle string `json:"bookTitle"`

	// ChapterID / ChapterOrd / ChapterTitle 用于 TXT/EPUB 等章节型阅读器跳转。
	//
	// 这些字段是指针类型并带 omitempty：
	//   - 有值：JSON 输出对应字段；
	//   - nil：JSON 中省略字段。
	// 这样 PDF 等没有章节信息的结果不会输出一堆 null。
	ChapterID    *string `json:"chapterId,omitempty"`
	ChapterOrd   *int    `json:"chapterOrd,omitempty"`
	ChapterTitle *string `json:"chapterTitle,omitempty"`

	// PageNo 用于 PDF 阅读器跳转页码。
	PageNo *int `json:"pageNo,omitempty"`

	// Locator 用于更精确的位置定位。
	//
	// 对 EPUB 可能是 CFIv2 locator；
	// 对 TXT/HTML 可能是段落锚点；
	// 具体解释在 ReaderPage 和 locator 相关文件里。
	Locator *string `json:"locator,omitempty"`

	// Snippet 是 SQLite snippet() 生成的带 <mark> 的高亮片段，
	// 前端可以直接用它展示命中上下文。
	Snippet string `json:"snippet"`

	// PlainSnippet 是不带 HTML 高亮的普通片段。
	//
	// 当前实现用原文 text 截断到 200 个 rune，避免返回过长正文。
	PlainSnippet string `json:"plainSnippet"`

	// Score 是相关性分数。
	//
	// SQLite FTS5 的 bm25() 越小越相关；
	// 本接口返回 -bm25()，让前端看到“越大越相关”的直觉分数。
	Score float64 `json:"score"`
}

// queryChunks 查询书籍正文 FTS5 索引。
//
// 参数说明：
//  1. r：当前 HTTP 请求，用于拿 context；
//  2. userID：当前用户 ID，用于多用户隔离；
//  3. matchExpr：QueryString 生成的 FTS5 MATCH 表达式；
//  4. bookID：可选书籍过滤；
//  5. rawQ：用户原始查询词，用于 exact 后过滤；
//  6. exact：是否要求原文精确包含 rawQ；
//  7. limit：最大返回数量。
//
// 低内存点：
//  1. 查询直接在 SQLite FTS5 中执行，不在 Go 内存里建立搜索索引；
//  2. LIMIT 限制返回行数；
//  3. 只扫描命中行并转换为轻量 DTO。
func (h *Handler) queryChunks(r *http.Request, userID, matchExpr, bookID, rawQ string, exact bool, limit int) ([]chunkHit, error) {
	// args 是 SQL 参数列表。
	//
	// 不要把 userID、bookID、matchExpr 直接拼进 SQL 字符串，
	// 而应通过 ? 占位符传递给 database/sql。
	// 这样可以避免 SQL 注入，也能让 SQLite 正确处理特殊字符。
	args := []any{userID}

	// whereBook 是可选 SQL 片段。
	//
	// 当 bookID 非空时，额外增加 “AND fts.book_id = ?”，
	// 查询范围就从“当前用户所有书”缩小到“当前用户某一本书”。
	whereBook := ""
	if bookID != "" {
		whereBook = "AND fts.book_id = ?"
		args = append(args, bookID)
	}

	// MATCH 表达式和 LIMIT 也作为 SQL 参数传入。
	args = append(args, matchExpr, limit)

	// 这个 SQL 做了几件事：
	//  1. 从 book_chunks_fts 这个 FTS5 虚表中查正文命中；
	//  2. LEFT JOIN books 取书名；
	//  3. LEFT JOIN book_chapters 取章节标题；
	//  4. 使用 snippet() 生成带 <mark> 的高亮片段；
	//  5. 使用 bm25() 计算相关性并排序；
	//  6. 限制用户、可选书籍范围和返回数量。
	//
	// snippet(book_chunks_fts, 1, '<mark>', '</mark>', '…', 24) 含义：
	//  1. 第一个参数是 FTS 表名；
	//  2. 第二个参数 1 表示对第 1 个可搜索列生成摘要片段；
	//  3. '<mark>' 和 '</mark>' 是命中词前后的 HTML 标记；
	//  4. '…' 是省略号；
	//  5. 24 是片段 token 数量。
	//
	// bm25(book_chunks_fts) 越小越相关，所以 ORDER BY 使用 bm25() 升序；
	// SELECT 中返回 -bm25()，只是为了让前端看到更直观的“分数越大越好”。
	sqlStmt := `
		SELECT fts.chunk_id, fts.book_id,
		       COALESCE(b.title, ''),
		       fts.chapter_id, fts.chapter_ord,
		       ch.title,
		       fts.page_no,
		       fts.locator,
		       snippet(book_chunks_fts, 1, '<mark>', '</mark>', '…', 24) AS snip,
		       fts.text,
		       -bm25(book_chunks_fts) AS score
		FROM book_chunks_fts AS fts
		LEFT JOIN books          AS b  ON b.id = fts.book_id
		LEFT JOIN book_chapters  AS ch ON ch.id = fts.chapter_id
		WHERE fts.user_id = ?
		  ` + whereBook + `
		  AND book_chunks_fts MATCH ?
		ORDER BY bm25(book_chunks_fts)
		LIMIT ?
	`

	rows, err := h.DB.QueryContext(r.Context(), sqlStmt, args...)
	if err != nil {
		return nil, err
	}
	// rows.Close 释放数据库游标资源。
	//
	// 即使后面 rows.Next 提前出错或函数提前返回，也应该关闭 rows。
	defer rows.Close()

	// 预分配容量为 limit。
	//
	// 这不是说一定会返回 limit 条，因为 exact 后过滤可能丢掉部分候选结果；
	// 但预分配可以减少 append 扩容次数。
	out := make([]chunkHit, 0, limit)
	for rows.Next() {
		var (
			hit chunkHit

			// 数据库里的 NULL 不能直接 scan 到 string/int。
			// sql.NullString / sql.NullInt64 用 Valid 字段表示是否真的有值。
			chapterID, chapterTitle sql.NullString
			chapterOrd, pageNo      sql.NullInt64
			locator                 sql.NullString

			snip, plain string
			score       float64
		)

		if err := rows.Scan(&hit.ID, &hit.BookID, &hit.BookTitle,
			&chapterID, &chapterOrd, &chapterTitle, &pageNo,
			&locator, &snip, &plain, &score); err != nil {
			return nil, err
		}

		// exact 后过滤：
		//
		// FTS5 bigram MATCH 负责找候选集；
		// 如果 exact=true，还要检查原文 plain 是否包含用户完整输入 rawQ。
		// 这样可以减少 bigram 命中但完整词组不连续的情况。
		if exact && !strings.Contains(plain, rawQ) {
			continue
		}

		// 把 sql.Null* 转成 JSON 指针字段。
		//
		// 例如 chapterID.Valid=false 时，hit.ChapterID 保持 nil，
		// 最终 JSON 中因为 omitempty 不输出 chapterId 字段。
		if chapterID.Valid {
			hit.ChapterID = &chapterID.String
		}
		if chapterOrd.Valid {
			v := int(chapterOrd.Int64)
			hit.ChapterOrd = &v
		}
		if chapterTitle.Valid {
			hit.ChapterTitle = &chapterTitle.String
		}
		if pageNo.Valid {
			v := int(pageNo.Int64)
			hit.PageNo = &v
		}
		if locator.Valid {
			hit.Locator = &locator.String
		}

		hit.Snippet = snip
		hit.PlainSnippet = trimSnippet(plain, 200)
		hit.Score = score
		out = append(out, hit)
	}

	// rows.Err 检查遍历过程中是否发生错误。
	//
	// 常见情况包括：数据库连接中断、context 被取消等。
	return out, rows.Err()
}

// noteHit 是“笔记搜索命中”的 JSON DTO。
//
// 笔记搜索与正文搜索类似，但它的跳转目标通常是：
//  1. 打开对应书籍；
//  2. 定位到笔记所在 locator；
//  3. 展示用户写下的 body 和 selectedText。
type noteHit struct {
	ID        string `json:"id"`
	BookID    string `json:"bookId"`
	BookTitle string `json:"bookTitle"`

	// ChapterID 可选，因为某些笔记可能只有 locator，没有章节 ID。
	ChapterID *string `json:"chapterId,omitempty"`

	// Locator 是笔记在书内的位置锚点。
	Locator string `json:"locator"`

	// Body 是用户自己写的笔记内容。
	Body string `json:"body"`

	// SelectedText 是用户创建笔记时选中的原文，可选。
	SelectedText *string `json:"selectedText,omitempty"`

	// Snippet 是 FTS5 snippet() 生成的高亮片段。
	Snippet string `json:"snippet"`

	// Score 是 -bm25(notes_fts)，越大表示越相关。
	Score float64 `json:"score"`
}

// queryNotes 查询用户笔记 FTS5 索引。
//
// notes_fts 通常索引两类文本：
//  1. note body：用户自己写的笔记；
//  2. selected_text：用户划线/批注时选中的原文。
//
// 因此 exact 后过滤也需要同时检查 body 和 selected_text。
func (h *Handler) queryNotes(r *http.Request, userID, matchExpr, bookID, rawQ string, exact bool, limit int) ([]noteHit, error) {
	args := []any{userID}

	// 与正文搜索相同，bookID 是可选范围过滤。
	whereBook := ""
	if bookID != "" {
		whereBook = "AND fts.book_id = ?"
		args = append(args, bookID)
	}
	args = append(args, matchExpr, limit)

	// notes_fts 的查询逻辑与 book_chunks_fts 类似：
	//  1. 限制 user_id，保证多用户隔离；
	//  2. 可选限制 book_id；
	//  3. MATCH 用户查询表达式；
	//  4. snippet() 生成高亮片段；
	//  5. bm25() 排序。
	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT fts.note_id, fts.book_id, COALESCE(b.title, ''),
		       fts.chapter_id, fts.locator, fts.body, fts.selected_text,
		       snippet(notes_fts, 1, '<mark>', '</mark>', '…', 16) AS snip,
		       -bm25(notes_fts) AS score
		FROM notes_fts AS fts
		LEFT JOIN books AS b ON b.id = fts.book_id
		WHERE fts.user_id = ?
		  `+whereBook+`
		  AND notes_fts MATCH ?
		ORDER BY bm25(notes_fts)
		LIMIT ?
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]noteHit, 0, limit)
	for rows.Next() {
		var (
			h noteHit

			// chapterID 和 selected_text 在数据库中可能为 NULL。
			chapterID, selected sql.NullString

			snip  string
			score float64
		)

		if err := rows.Scan(&h.ID, &h.BookID, &h.BookTitle,
			&chapterID, &h.Locator, &h.Body, &selected, &snip, &score); err != nil {
			return nil, err
		}

		// exact 后过滤需要检查两处：
		//  1. 笔记正文 h.Body；
		//  2. 用户选中的原文 selected.String。
		if exact && !strings.Contains(h.Body, rawQ) && !(selected.Valid && strings.Contains(selected.String, rawQ)) {
			continue
		}

		if chapterID.Valid {
			h.ChapterID = &chapterID.String
		}
		if selected.Valid {
			h.SelectedText = &selected.String
		}

		h.Snippet = snip
		h.Score = score
		out = append(out, h)
	}

	return out, rows.Err()
}

// parseLimit 解析 URL 查询参数中的 limit。
//
// 参数：
//  1. s：用户传入的字符串，例如 "50"；
//  2. dflt：默认值，例如 30；
//  3. max：最大允许值，例如 200。
//
// 为什么要限制最大值？
// 搜索接口如果允许 limit=100000，可能导致：
//  1. SQLite 查询返回大量行；
//  2. Go 进程分配很大的结果切片；
//  3. JSON 响应体过大；
//  4. 浏览器渲染卡顿。
//
// 因此这里做一个简单但有效的保护。
func parseLimit(s string, dflt, max int) int {
	if s == "" {
		return dflt
	}

	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return dflt
	}

	if n > max {
		return max
	}

	return n
}

// trimSnippet 把字符串按 rune 截断到最多 n 个字符。
//
// Go 的 string 底层是 UTF-8 字节序列。
// 中文字符通常占 3 个字节，如果直接按字节截断，可能把一个汉字截成半个，导致乱码。
// 转成 []rune 后，每个元素代表一个 Unicode 码点，更适合按“字符数量”截断。
func trimSnippet(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
