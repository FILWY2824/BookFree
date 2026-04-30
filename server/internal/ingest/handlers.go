// Package ingest 负责“前端解析完一本书之后，把解析结果写入数据库”的接口。
//
// 对应的主要路由是：
//
//	POST /api/books/{id}/ingest
//	POST /api/books/{id}/ingest/fail
//
// 你可以把上传一本书理解成两个阶段：
//
//  1. 上传原始文件：
//     前端 UploadButton 把 .txt/.epub/.pdf 等原始文件 PUT 到
//     /api/books/upload，后端只负责把原始文件流式保存到 storage，
//     并在 books 表里创建一条 status='uploaded' 的记录。
//
//  2. 导入解析结果：
//     对 TXT/EPUB/CBZ 等可由前端解析的格式，浏览器里的解析器会把书拆成
//     chapters、chunks、toc，再 POST 到本文件的 /api/books/{id}/ingest。
//     本文件负责把这些结构化结果写入：
//     - book_chapters：章节正文
//     - book_chunks：搜索和 AI 检索用的文本块
//     - book_chunk_embeddings：轻量 hash-vector 向量
//     - books.toc：层级目录 JSON
//     - ingestion_jobs：导入任务状态
//
// 为什么让前端解析，而不是让 Go 后端解析？
//
//   - 这是 BookFree 的重要低内存设计：Go 服务端要常驻运行，目标是空闲/轻负载时
//     尽量稳定在 50MB 内。如果把 EPUB 解压、XML 解析、HTML 清洗、大文件切块都放到
//     后端常驻进程里，内存峰值和依赖复杂度都会明显上升。
//   - 浏览器本来就在用户设备上，解析工作放在浏览器侧可以把 CPU/内存成本转移到
//     一次性的客户端任务。
//   - 后端只接收“已经结构化好的小块数据”，然后用事务写入 SQLite。这更适合
//     自托管、小内存、单体 Go 后端。
//   - 未来 Android 客户端也可以复用同一个 ingest API：Android 负责解析本地文件，
//     后端仍然只接收 chapters/chunks/toc。
//
// 请求体大致长这样：
//
//	{
//	  "title":      "...",                  // 可选：覆盖书名
//	  "authors":    ["..."],                // 可选：作者列表
//	  "language":   "...",                  // 可选：语言
//	  "publisher":  "...",                  // 可选：出版社
//	  "chapters":   [
//	    { "id":"c1", "ord":0, "title":"...", "html":"...", "text":"..." }
//	  ],
//	  "chunks":     [
//	    { "id":"k1", "chapterId":"c1", "ord":0, "pageNo":null, "text":"..." }
//	  ],
//	  "toc": [
//	    { "label":"第一章", "chapterId":"c1", "children":[] }
//	  ]
//	}
//
// 幂等性说明：
// 本接口按 book 级别幂等。也就是说，同一本书重复 POST 同一份 ingest body 时，
// 会先删除这本书旧的 chapters/chunks，再重新插入新数据，不会出现重复索引。
// 这样前端在网络抖动时重试，不会把一本书索引两遍。
package ingest

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"bookfree/internal/ai"
	"bookfree/internal/auth"
	"bookfree/internal/response"
	"bookfree/internal/search"
)

// Handler 是 ingest 模块的 HTTP 处理器依赖容器。
//
// 在 router.go 里会创建：
//
//	ingestHandler := &ingest.Handler{DB: deps.DB, IsProd: deps.Config.IsProduction()}
//
// 字段说明：
//   - DB：SQLite 的连接池句柄。注意 *sql.DB 不是一个“单连接”，而是 database/sql
//     管理的一组连接。BookFree 在 db.Open 里限制了连接池大小，以满足低内存部署。
//   - IsProd：是否生产环境。传给 response.FailSafe，用于决定错误响应里是否隐藏
//     数据库错误细节，避免生产环境泄露内部信息。
type Handler struct {
	DB     *sql.DB
	IsProd bool
}

// chapterIn 是前端传入的单个章节结构。
//
// 这个结构不是数据库模型，而是“接口入参模型”：
//   - 前端解析器输出什么字段，这里就接收什么字段。
//   - 后面写入数据库时，会把它转换为 book_chapters 表中的行。
type chapterIn struct {
	// ID 是前端解析器生成的章节临时 id，例如 "c1"。
	// 注意：这个 id 不会原样作为数据库 id 使用，而是会经过 scopedIngestID
	// 加上 bookID 前缀，避免不同书籍之间章节 id 冲突。
	ID string `json:"id"`

	// Ord 是章节顺序，从 0 开始。前端阅读器可以用它表示第几章。
	Ord int `json:"ord"`

	// Title/Href/HTML/Text 都是可选字段。
	// 用 *string 而不是 string，是为了区分“前端没传这个字段”和“传了空字符串”。
	Title *string `json:"title,omitempty"`
	Href  *string `json:"href,omitempty"`
	HTML  *string `json:"html,omitempty"`
	Text  *string `json:"text,omitempty"`
}

// chunkIn 是前端传入的文本块结构。
//
// chunk 是比 chapter 更小的检索单位，主要服务两个功能：
//   - 全文搜索：写入 book_chunks.search_text，并由 SQLite FTS5 索引。
//   - AI 问答/RAG：写入 book_chunk_embeddings，用于轻量向量召回。
//
// 为什么需要 chunks，而不是直接搜索 chapters？
//   - 章节可能很长，搜索命中后给用户展示很大一段正文体验不好。
//   - AI 检索也更适合按较短文本块召回，避免把整章都塞进上下文。
type chunkIn struct {
	ID string `json:"id"`

	// ChapterID 是前端解析器里的章节 id。后端写库时会把它映射成数据库中的 scoped id。
	ChapterID *string `json:"chapterId,omitempty"`

	// ChapterOrd 是章节顺序的冗余字段，方便一些只知道 ord 的阅读/搜索路径。
	ChapterOrd *int `json:"chapterOrd,omitempty"`

	// PageNo 主要给 PDF 或分页类格式预留。
	PageNo *int `json:"pageNo,omitempty"`

	// Ord 是 chunk 在整本书或当前解析输出中的顺序。
	Ord int `json:"ord"`

	// Text 是这个 chunk 的纯文本内容。空白文本会被跳过，不写入索引。
	Text string `json:"text"`
}

// tocItemIn 是前端传入的目录树节点。
//
// TOC = Table Of Contents，即“目录”。
// EPUB 这类格式通常天然带有层级目录，例如：
//
//	第一部分
//	  第一章
//	  第二章
//
// Children 允许任意深度，所以它是一个递归结构。
//
// ChapterID 这里还是“前端解析器生成的章节 id”，例如 "c1"。
// 在持久化到 books.toc 前，我们会通过 remapTocChapterIDs 把它改写成数据库中的
// scoped chapter id，这样前端点击目录时可以直接请求：
//
//	/api/books/{id}/chapters/{chapterId}
type tocItemIn struct {
	Label     string      `json:"label"`
	ChapterID *string     `json:"chapterId,omitempty"`
	Depth     *int        `json:"depth,omitempty"`
	Children  []tocItemIn `json:"children,omitempty"`
}

// ingestBody 是 POST /api/books/{id}/ingest 的完整请求体。
//
// 它把“元数据 + 正文结构 + 搜索块 + 目录”放在一起提交，后端用一个数据库事务写完。
// 这样要么整本书导入成功，要么失败回滚，不会出现“章节写了一半、状态却 ready”的情况。
type ingestBody struct {
	Title     *string     `json:"title,omitempty"`
	Authors   []string    `json:"authors,omitempty"`
	Language  *string     `json:"language,omitempty"`
	Publisher *string     `json:"publisher,omitempty"`
	Chapters  []chapterIn `json:"chapters"`
	Chunks    []chunkIn   `json:"chunks"`
	TOC       []tocItemIn `json:"toc,omitempty"`
}

// maxIngestBytes 是 ingest 请求体最大体积。
//
// 32MiB 对“章节 + chunks + toc”的 JSON 来说已经比较宽松：
//   - 普通 TXT/EPUB 通常在几百 KB 到几 MB；
//   - 限制大小可以防止恶意请求一次性占用太多内存；
//   - 这里限制的是 HTTP body 解码前的大小，是保护 Go 后端常驻内存的重要边界。
const maxIngestBytes = 32 << 20

// HandlePost 处理：POST /api/books/{id}/ingest。
//
// 成功后，books.status 会从 uploaded/parsing 等状态变为 ready。
// 前端 ReaderPage/LibraryPage 看到 status='ready' 后，就知道这本书已经可以阅读和搜索。
//
// 处理流程概览：
//  1. 从请求 context 里拿当前登录用户。
//  2. 读取路径参数 bookID。
//  3. 查 books 表，确认这本书属于当前用户。
//  4. 限制请求体大小并解码 JSON。
//  5. 开启数据库事务。
//  6. 删除旧 chapters/chunks，保证重试时幂等。
//  7. 插入章节。
//  8. 插入 chunks、搜索文本和轻量 embedding。
//  9. 更新 books 元数据、目录和 status。
//  10. 更新 ingestion_jobs。
//  11. 提交事务并返回成功响应。
func (h *Handler) HandlePost(w http.ResponseWriter, r *http.Request) {
	// UserFromContext 由 auth.RequireUser 中间件提前写入。
	// 该路由在 router.go 中受认证保护，因此正常情况下 user 不会为空。
	user := auth.UserFromContext(r.Context())

	// Go 1.22 的 net/http ServeMux 支持从路径模式里读取 {id}。
	// 这里的 id 就是 /api/books/{id}/ingest 中的 book id。
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// 先确认 ownership，再做任何 JSON 解码、事务、索引等较重工作。
	// 这样可以避免攻击者对不属于自己的 bookID 发大 body，占用服务器资源。
	//
	// 同时读取 format：PDF 特殊。PDF 阅读器直接从原始文件 /file 读取并渲染，
	// 不一定需要前端解析出 chapters/chunks，所以 PDF 允许空 chapters/chunks 完成 ingest。
	var ownerID string
	var bookFormat string
	if err := h.DB.QueryRowContext(r.Context(),
		`SELECT user_id, format FROM books WHERE id = ? LIMIT 1`, bookID).Scan(&ownerID, &bookFormat); err != nil {
		if err == sql.ErrNoRows || ownerID != user.ID {
			// 对“不存在”和“不属于你”的书都返回 404，而不是 403。
			// 这样可以避免泄露“这个 bookID 是否存在”。
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
			return
		}
		response.FailSafe(w, "ingest.lookup", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if ownerID != user.ID {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	var body ingestBody

	// MaxBytesReader 会在读取超过 maxIngestBytes 时返回错误。
	// json.Decoder 是流式解码器，不需要先 io.ReadAll 整个请求体；
	// 这比“一次性读取完整 body 再 json.Unmarshal”更适合低内存服务端。
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxIngestBytes))
	if err := dec.Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法："+err.Error())
		return
	}

	// 非 PDF 格式至少要有 chapters 或 chunks，否则 status 变 ready 后前端也没内容可读/可搜。
	if len(body.Chapters) == 0 && len(body.Chunks) == 0 && strings.ToLower(bookFormat) != "pdf" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation,
			"chapters 与 chunks 至少需要一项")
		return
	}

	now := time.Now().Unix()

	// 使用事务保证本次导入的原子性：
	//   - 如果中途任意一步失败，defer Rollback 会撤销所有已写入行；
	//   - 只有 Commit 成功后，书籍才会变成 ready。
	tx, err := h.DB.BeginTx(r.Context(), nil)
	if err != nil {
		response.FailSafe(w, "ingest.tx", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	rollback := true
	defer func() {
		if rollback {
			_ = tx.Rollback()
		}
	}()

	// 幂等性关键步骤：先删除这本书旧的 chunks 和 chapters。
	//
	// 为什么先删 chunks 再删 chapters？
	//   - chunks 可能引用 chapter_id；
	//   - 先删更细粒度的子数据，避免外键或逻辑引用问题。
	//
	// migration 0020 里有 FTS5 同步触发器，删除 book_chunks 时会同步清理
	// book_chunks_fts，因此这里不需要手写 FTS 删除逻辑。
	if _, err := tx.ExecContext(r.Context(),
		`DELETE FROM book_chunks WHERE book_id = ? AND user_id = ?`, bookID, user.ID); err != nil {
		response.FailSafe(w, "ingest.clear_chunks", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if _, err := tx.ExecContext(r.Context(),
		`DELETE FROM book_chapters WHERE book_id = ? AND user_id = ?`, bookID, user.ID); err != nil {
		response.FailSafe(w, "ingest.clear_chapters", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// chapterIDs 记录“前端临时章节 id → 数据库章节 id”的映射。
	//
	// 例子：
	//   前端传入 chapter.id = "c1"
	//   数据库保存为 bookID + ":chapter:" + "c1"
	//
	// 后面 chunks.chapterId 和 toc.chapterId 都要用这个映射改写。
	chapterIDs := make(map[string]string, len(body.Chapters))

	// 插入章节。
	//
	// PrepareContext 会预编译 SQL 语句，循环 Exec 时复用同一条语句。
	// 对大量章节来说，这比每章都重新解析 SQL 更高效。
	if len(body.Chapters) > 0 {
		stmt, err := tx.PrepareContext(r.Context(), `
			INSERT INTO book_chapters (id, book_id, user_id, ord, title, href, html, text, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		if err != nil {
			response.FailSafe(w, "ingest.prepare_chapter", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		for _, c := range body.Chapters {
			dbID := scopedIngestID(bookID, "chapter", c.ID, c.Ord)
			if strings.TrimSpace(c.ID) != "" {
				chapterIDs[c.ID] = dbID
			}

			// nullStr 会把 nil 或空字符串转为 SQL NULL。
			// 这样数据库里不会塞满无意义的 ""，查询时也能用 sql.NullString 区分有无值。
			if _, err := stmt.ExecContext(r.Context(),
				dbID, bookID, user.ID, c.Ord,
				nullStr(c.Title), nullStr(c.Href),
				nullStr(c.HTML), nullStr(c.Text),
				now); err != nil {
				stmt.Close()
				response.FailSafe(w, "ingest.insert_chapter", err, http.StatusInternalServerError, h.IsProd)
				return
			}
		}
		stmt.Close()
	}

	// 插入 chunks。
	//
	// search_text 的生成逻辑和搜索接口 QueryString 使用同一个 tokenizer：
	//   - 写入索引时：search.SearchText(c.Text)
	//   - 查询时：search.QueryString(q)
	//
	// 这样中文 bigram、英文 token 的规则保持一致，避免“写入时一种分词，查询时另一种分词”。
	//
	// 同时写入 book_chunk_embeddings：
	//   - ai.EmbedText(c.Text) 生成一个轻量 hash-vector；
	//   - ai.EncodeVector(...) 编码成 []byte 存入 SQLite；
	//   - 用于 AI RAG 的混合召回：FTS + cosine。
	//
	// 注意：这里不是调用外部大模型 embedding 服务，所以不会引入常驻模型，也不会明显增加
	// 服务端内存。向量按行持久化在 SQLite，需要时才读取。
	if len(body.Chunks) > 0 {
		stmt, err := tx.PrepareContext(r.Context(), `
			INSERT INTO book_chunks (id, book_id, user_id, chapter_id, chapter_ord, page_no, ord, text, search_text, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		if err != nil {
			response.FailSafe(w, "ingest.prepare_chunk", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		embStmt, err := tx.PrepareContext(r.Context(), `
			INSERT INTO book_chunk_embeddings (chunk_id, book_id, user_id, model_tag, vector, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(chunk_id) DO UPDATE SET
				vector     = excluded.vector,
				model_tag  = excluded.model_tag,
				created_at = excluded.created_at
		`)
		if err != nil {
			stmt.Close()
			response.FailSafe(w, "ingest.prepare_embedding", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		for _, c := range body.Chunks {
			// 空白 chunk 没有搜索/AI 价值，跳过可以减少数据库体积和索引开销。
			if strings.TrimSpace(c.Text) == "" {
				continue
			}

			dbID := scopedIngestID(bookID, "chunk", c.ID, c.Ord)

			// 如果 chunk 指向了某个章节，把前端临时 chapter id 改写成数据库 scoped id。
			// 如果映射不存在，就保留原值/NULL，让系统尽量容错。
			chapterID := nullStrPtr(c.ChapterID)
			if c.ChapterID != nil {
				if mapped, ok := chapterIDs[*c.ChapterID]; ok {
					chapterID = mapped
				}
			}

			searchText := search.SearchText(c.Text)
			if _, err := stmt.ExecContext(r.Context(),
				dbID, bookID, user.ID,
				chapterID, nullIntPtr(c.ChapterOrd), nullIntPtr(c.PageNo),
				c.Ord, c.Text, searchText, now); err != nil {
				stmt.Close()
				embStmt.Close()
				response.FailSafe(w, "ingest.insert_chunk", err, http.StatusInternalServerError, h.IsProd)
				return
			}

			vec := ai.EncodeVector(ai.EmbedText(c.Text))
			if _, err := embStmt.ExecContext(r.Context(),
				dbID, bookID, user.ID, ai.EmbedModelTag(), vec, now); err != nil {
				// embedding 写入失败不是致命错误。
				// 即使少了向量，搜索仍然可以走 FTS5；AI 检索只是少了一部分向量召回能力。
				// 这里选择忽略错误，是为了避免“辅助索引失败”导致整本书导入失败。
				_ = err
			}
		}
		stmt.Close()
		embStmt.Close()
	}

	// authors 在 books 表里以 JSON 字符串保存。
	// 这样 SQLite schema 保持简单，不需要额外 book_authors 表；
	// 前端拿到后可以直接解析为 string[]。
	authorsJSON := "[]"
	if len(body.Authors) > 0 {
		if b, err := json.Marshal(body.Authors); err == nil {
			authorsJSON = string(b)
		}
	}

	// 保存层级目录 TOC。
	//
	// body.TOC 里 chapterId 是前端解析器的临时 id，不能直接持久化给前端点击使用。
	// remapTocChapterIDs 会把它改写成数据库 scoped chapter id。
	//
	// 如果某个目录项没有对应 chapterId，例如“第一部分”只是分组标题，不是正文页，
	// 会保留 label 但不带 chapterId，前端 TocDrawer 可以把它渲染成不可点击标题。
	var tocJSON sql.NullString
	if len(body.TOC) > 0 {
		remapped := remapTocChapterIDs(body.TOC, chapterIDs, 0)
		if b, err := json.Marshal(remapped); err == nil {
			tocJSON = sql.NullString{String: string(b), Valid: true}
		}
	}

	// 更新 books 元数据和状态。
	//
	// COALESCE(NULLIF(?, ''), title) 的含义：
	//   - 如果前端传了非空 title，就用新 title；
	//   - 如果没传或传空字符串，就保留旧 title。
	//
	// status='ready' 是关键状态：它告诉书架和阅读页“这本书已经可以打开阅读”。
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE books
		SET status     = 'ready',
		    title      = COALESCE(NULLIF(?, ''), title),
		    authors    = ?,
		    language   = COALESCE(?, language),
		    publisher  = COALESCE(?, publisher),
		    toc        = ?,
		    error      = NULL,
		    updated_at = ?
		WHERE id = ? AND user_id = ?
	`,
		strDeref(body.Title),
		authorsJSON,
		nullStrPtr(body.Language),
		nullStrPtr(body.Publisher),
		tocJSON,
		now, bookID, user.ID); err != nil {
		response.FailSafe(w, "ingest.update_book", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// 更新导入任务状态。前端可以根据 jobs 或 books.status 展示“处理中/完成/失败”。
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE ingestion_jobs
		SET state = 'done', finished_at = ?, updated_at = ?, last_error = NULL
		WHERE book_id = ? AND user_id = ?
	`, now, now, bookID, user.ID); err != nil {
		response.FailSafe(w, "ingest.update_job", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// Commit 成功后，事务内所有章节、chunks、目录、状态才真正生效。
	if err := tx.Commit(); err != nil {
		response.FailSafe(w, "ingest.commit", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	rollback = false

	response.OK(w, map[string]any{
		"bookId":   bookID,
		"status":   "ready",
		"chapters": len(body.Chapters),
		"chunks":   len(body.Chunks),
	})
}

// HandleFail 处理：POST /api/books/{id}/ingest/fail。
//
// 当前端解析失败时会调用这个接口，例如：
//   - EPUB 文件损坏；
//   - 文件加密；
//   - 浏览器解析器不支持某种内部结构；
//   - worker 运行时报错。
//
// 这个接口会把 books.status 标记为 failed，并保存错误信息。
// 这样书架页面可以显示“解析失败”，而不是让书一直停留在 uploaded/parsing 状态。
func (h *Handler) HandleFail(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")

	var body struct {
		Error string `json:"error"`
	}

	// 失败上报只需要很小的 JSON，4KiB 足够保存错误摘要。
	// 这里忽略 Decode 错误：即使前端没传合法 body，也可以用默认“解析失败”。
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body)

	now := time.Now().Unix()
	msg := strings.TrimSpace(body.Error)
	if msg == "" {
		msg = "解析失败"
	}
	if len(msg) > 500 {
		// 避免把超长异常栈写入数据库或返回给前端。
		msg = msg[:500]
	}

	// 只更新当前用户拥有的这本书，防止越权修改别人的书籍状态。
	res, err := h.DB.ExecContext(r.Context(), `
		UPDATE books SET status = 'failed', error = ?, updated_at = ?
		WHERE id = ? AND user_id = ?
	`, msg, now, bookID, user.ID)
	if err != nil {
		response.FailSafe(w, "ingest.fail.update", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	// 同步更新 ingestion_jobs。这里即使失败也不阻断响应，因为 books.status 已经是
	// UI 最关心的主状态。
	_, _ = h.DB.ExecContext(r.Context(), `
		UPDATE ingestion_jobs SET state = 'failed', last_error = ?, finished_at = ?, updated_at = ?
		WHERE book_id = ? AND user_id = ?
	`, msg, now, now, bookID, user.ID)

	response.OK(w, map[string]any{"bookId": bookID, "status": "failed"})
}

// scopedIngestID 把前端解析器生成的局部 id 转成数据库内全局更安全的 id。
//
// 为什么不直接使用前端传来的 raw id？
//   - 不同书都可能有章节 id "c1"；
//   - 同一本书里 chunk id 和 chapter id 也可能重名；
//   - 加上 bookID 和 kind 后，id 更稳定、更不容易冲突。
//
// 如果 raw 为空，就用 ord 兜底，保证即使解析器没有生成 id，也能得到一个可用 id。
func scopedIngestID(bookID, kind, raw string, ord int) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = strconv.Itoa(ord)
	}
	return bookID + ":" + kind + ":" + raw
}

// tocItemOut 是实际写入 books.toc 的目录节点结构。
//
// 与 tocItemIn 的区别：
//   - tocItemIn 是前端入参，chapterId 可能是 "c1" 这类解析器局部 id；
//   - tocItemOut 是后端持久化结果，chapterId 已经被替换成数据库 scoped id。
//
// Depth 字段虽然可以从 Children 嵌套层级推导出来，但这里仍然保存：
//   - 前端渲染缩进时可以直接使用；
//   - 未来如果想把目录扁平化展示，也不用重新遍历计算深度。
type tocItemOut struct {
	Label     string       `json:"label"`
	ChapterID *string      `json:"chapterId,omitempty"`
	Depth     int          `json:"depth"`
	Children  []tocItemOut `json:"children,omitempty"`
}

// remapTocChapterIDs 遍历目录树，把每个目录项的 chapterId 从“前端临时 id”
// 替换成“数据库 scoped chapter id”。
//
// 参数说明：
//   - items：当前层级的目录节点列表；
//   - chapterIDs：前端 chapter id 到 DB chapter id 的映射；
//   - depth：当前层级深度，根节点为 0。
//
// 对无 label 的节点：
//   - 不直接保留空白节点，因为前端会渲染出空行；
//   - 但它的 children 可能有有效内容，所以把 children 提升到当前层级。
//
// 对找不到 chapterId 映射的节点：
//   - 保留 label，去掉 chapterId；
//   - 这适合“第一卷”“Part I”这类只是分组、不直接对应正文的目录项。
func remapTocChapterIDs(items []tocItemIn, chapterIDs map[string]string, depth int) []tocItemOut {
	if len(items) == 0 {
		return nil
	}
	out := make([]tocItemOut, 0, len(items))
	for _, it := range items {
		label := strings.TrimSpace(it.Label)
		if label == "" {
			out = append(out, remapTocChapterIDs(it.Children, chapterIDs, depth)...)
			continue
		}

		var mapped *string
		if it.ChapterID != nil {
			if id, ok := chapterIDs[*it.ChapterID]; ok {
				mapped = &id
			}
		}

		out = append(out, tocItemOut{
			Label:     label,
			ChapterID: mapped,
			Depth:     depth,
			Children:  remapTocChapterIDs(it.Children, chapterIDs, depth+1),
		})
	}
	return out
}

// nullStr 把可选字符串转换成 database/sql 可以接收的值。
//
// 返回 any 是因为 ExecContext 的参数类型是 ...any。
//   - nil 会被 database/sql 写成 SQL NULL；
//   - 非空字符串会被写成 TEXT。
func nullStr(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}

// nullStrPtr 与 nullStr 功能相同。
// 这里保留两个函数名，是为了让调用处语义更直观：
//   - nullStr 用在 chapterIn 的字段；
//   - nullStrPtr 用在其他可选字符串指针字段。
func nullStrPtr(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}

// nullIntPtr 把可选 int 指针转换成 SQL 参数。
// nil 表示数据库 NULL，非 nil 表示具体整数。
func nullIntPtr(i *int) any {
	if i == nil {
		return nil
	}
	return *i
}

// strDeref 解引用可选字符串。
// nil 时返回空字符串，配合 SQL 里的 NULLIF(?, ”) 使用。
func strDeref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
