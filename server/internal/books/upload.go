package books

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	"bookfree/internal/auth"
	"bookfree/internal/logger"
	"bookfree/internal/response"
	"bookfree/internal/security"
	"bookfree/internal/storage"
)

// SupportedFormats 是后端允许上传的书籍格式列表。
//
// 这个列表必须和前端 apps/web/src/components/UploadButton.tsx 里的 ACCEPT 保持同步。
// 原因是：
// - 前端 ACCEPT 决定文件选择器里用户“看得见、选得到”哪些扩展名；
// - 后端 SupportedFormats 才是真正的安全边界，决定服务器“实际接受”哪些扩展名；
// - 只改前端不改后端，用户上传后会被后端拒绝；
// - 只改后端不改前端，用户在浏览器里可能选不到新格式。
//
// 当前项目支持的阅读情况要区分两层：
//  1. “允许上传”：这里列出的格式都可以被保存到书架；
//  2. “可以直接阅读/解析”：TXT、EPUB、PDF 是当前 Web 阅读主链路；
//     其他格式可以先保存，后续再逐步补解析能力。
var SupportedFormats = []string{"epub", "pdf", "txt", "fb2", "fbz", "cbz", "mobi", "azw", "azw3"}

// headSize 表示上传时只读取文件开头多少字节用于格式嗅探。
//
// 很多文件格式都有“魔数”（magic number）：
// - PDF 通常以 %PDF- 开头；
// - EPUB/CBZ/FBZ 本质上是 ZIP，开头通常是 PK\x03\x04；
// - MOBI/AZW 系列会在固定偏移处出现 BOOKMOBI 等标识。
//
// 这里只读 512 字节，而不是把整本书读入内存。
// 这是 BookFree 低内存设计的关键之一：
// 上传大文件时，后端保持流式处理，避免因为单个请求把服务端堆内存撑大。
const headSize = 512

// HandleUpload 处理：PUT /api/books/upload
//
// 这是“上传一本书到书架”的后端入口，对应前端 UploadButton.tsx 中的 api.putRaw 调用。
//
// 完整链路可以按阶段理解：
// 1. 前端把原始文件作为 HTTP body 发到 PUT /api/books/upload；
// 2. 本函数读取登录用户，校验文件名、扩展名、大小和文件头；
// 3. 本函数把原始文件流式写入 Storage；
// 4. 本函数在 SQLite 中创建：
//   - books：书籍主记录；
//   - book_assets：原始文件资产记录；
//   - ingestion_jobs：导入任务记录；
//
// 5. 返回 bookId/jobId/format/status 给前端；
// 6. 前端再根据格式解析章节，并调用 /api/books/{id}/ingest 写入章节和全文索引。
//
// 为什么“解析书籍”不在这个接口里做？
// - EPUB/TXT/CBZ 等解析可能占用较多 CPU 和内存；
// - 当前架构选择让 Web 前端在浏览器中解析，Go 后端只保存结果；
// - 这样可以降低服务端常驻内存压力，更符合 50MB 以内的目标；
// - 未来 Android 客户端也可以复用同一套 upload + ingest API。
//
// 这个函数的一个重要安全/一致性点：
// Storage.Put 成功后，如果数据库写入失败，必须删除刚刚写入的文件。
// 否则磁盘上会留下“数据库里找不到引用”的孤儿文件，时间久了会浪费存储空间。
func (h *Handler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	// 认证中间件已经把当前登录用户放入 context。
	// 所有上传的书籍都必须归属到 user.ID，不能由前端自己传 userId。
	user := auth.UserFromContext(r.Context())

	// 正常的上传请求必须有 body。
	// r.Body 是一个 io.ReadCloser，可以把它理解成“浏览器上传文件的数据流”。
	if r.Body == nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体为空")
		return
	}
	// 请求结束后关闭 body，释放底层连接资源。
	defer r.Body.Close()

	// 文件名可能来自三个位置：
	// - x-bookfree-filename：当前项目推荐使用的自定义 header；
	// - x-alma-filename：历史兼容字段；
	// - URL query filename：前端 putRaw 当前使用 query 传 filename，避免中文文件名在 header 中的编码兼容问题。
	//
	// firstNonEmpty 会按顺序取第一个非空值。
	filename := firstNonEmpty(
		r.Header.Get("x-bookfree-filename"),
		r.Header.Get("x-alma-filename"),
		r.URL.Query().Get("filename"),
	)

	// sanitizeFilename 会去掉路径、非法字符、过长文件名等风险。
	// 后端永远不能直接信任浏览器传来的文件名。
	filename = sanitizeFilename(filename)
	if filename == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少文件名")
		return
	}

	// 通过扩展名初步判断格式。
	// 注意：扩展名只是一层粗校验，后面还会用 magicMatchesFormat 检查文件内容。
	format := detectFormat(filename)
	if format == "" || !contains(SupportedFormats, format) {
		response.Fail(w, http.StatusBadRequest, response.CodeUnsupportedFormat,
			"不支持的格式：."+format)
		return
	}

	// maxUploadBytes 会根据配置计算最大上传字节数。
	// 默认 100MB，上限 10GB，防止误配置成极端值。
	maxBytes := h.maxUploadBytes()

	// 如果请求头里带了 Content-Length，并且已经超过限制，可以提前拒绝。
	// 这样不需要继续读取 body，节省网络、磁盘和 CPU。
	if r.ContentLength > 0 && r.ContentLength > maxBytes {
		response.Fail(w, http.StatusRequestEntityTooLarge,
			response.CodeValidation, "文件过大")
		return
	}

	// http.MaxBytesReader 是上传大小限制的真正防线。
	//
	// 为什么不能只看 Content-Length？
	// - 客户端可以不传 Content-Length；
	// - 客户端也可能传一个假的值；
	// - MaxBytesReader 会在实际读取超过 maxBytes 时返回错误。
	body := http.MaxBytesReader(w, r.Body, maxBytes)

	// 下面几行是 Go 流式 I/O 中比较关键的一段。
	//
	// 目标：
	// - 只读取文件开头 headSize 字节做格式检查；
	// - 但之后写入 Storage 时，不能丢掉这已经读出来的开头字节。
	//
	// 数据流解释：
	// 1. io.LimitReader(body, headSize)：最多从 body 读取 512 字节；
	// 2. io.TeeReader(..., headBuf)：读取时顺便把读到的数据复制到 headBuf；
	// 3. io.ReadAll(teeReader)：得到 headBytes，用于 magic number 检查；
	// 4. 后面用 io.MultiReader(bytes.NewReader(headBytes), body)
	//    把“刚读过的头部”和“剩余 body”重新拼成完整文件流。
	//
	// 这样既完成格式校验，又避免把整本书读入内存。
	head := make([]byte, 0, headSize)
	headBuf := bytes.NewBuffer(head)
	teeReader := io.TeeReader(io.LimitReader(body, headSize), headBuf)
	headBytes, headErr := io.ReadAll(teeReader)
	if headErr != nil && !errors.Is(headErr, io.EOF) {
		// MaxBytesReader 超限时，错误文本里通常包含 exceeds。
		// 这里返回 413，让前端知道是文件太大，而不是普通服务器错误。
		if strings.Contains(headErr.Error(), "exceeds") {
			response.Fail(w, http.StatusRequestEntityTooLarge,
				response.CodeValidation, "文件过大")
			return
		}
		response.FailSafe(w, "books.upload.head", headErr, http.StatusBadRequest, h.IsProd)
		return
	}

	// 用文件头内容检查扩展名是否可信。
	//
	// 例如用户把一个 exe 改名成 .pdf，扩展名检测会通过，
	// 但 magicMatchesFormat 会因为开头不是 %PDF- 而拒绝。
	if !magicMatchesFormat(headBytes, format) {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation,
			"文件内容与扩展名不匹配（.格式="+format+"）")
		return
	}

	// 把刚刚读取过的 headBytes 和剩余 body 拼回一个完整 reader。
	// Storage.Put 后面读 full 时，读到的是完整文件，不会缺前 512 字节。
	full := io.MultiReader(bytes.NewReader(headBytes), body)

	// 为新书、导入任务、资产记录生成随机 ID。
	// RandomID 由 security 包提供，避免使用递增 ID 暴露业务规模或方便枚举。
	bookID := security.RandomID()
	jobID := security.RandomID()
	assetID := security.RandomID()

	// storageKey 是文件在 Storage 中的逻辑路径。
	// 通常会包含 userID/bookID，确保不同用户、不同书籍之间不会互相覆盖。
	storageKey := storage.BookKey(user.ID, bookID, "original."+format)

	now := time.Now().Unix()

	// 第一阶段：先把原始文件写入 Storage。
	//
	// 这里的重点是“流式写入”：
	// - full 是 io.Reader；
	// - Storage.Put 一边读请求体，一边写磁盘/存储；
	// - 不需要在 Go 堆内存中保存完整文件。
	//
	// 任何发生在 Storage.Put 成功之后、数据库 Commit 成功之前的错误，
	// 都必须触发 orphan cleanup，删除 storageKey 对应文件。
	declaredSize := r.ContentLength
	if declaredSize < 0 {
		// ContentLength == -1 表示请求没有声明大小。
		// Storage.Put 仍然可以边读边写，只是无法提前知道总大小。
		declaredSize = 0
	}
	if err := h.Storage.Put(r.Context(), storageKey, full, declaredSize, guessContentType(format)); err != nil {
		if strings.Contains(err.Error(), "too large") || strings.Contains(err.Error(), "exceeds") {
			response.Fail(w, http.StatusRequestEntityTooLarge,
				response.CodeValidation, "文件过大")
			return
		}
		response.FailSafe(w, "books.upload.store", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// stored 表示文件已经写入 Storage。
	// committed 表示数据库事务已经成功提交，数据库已经引用该文件。
	//
	// 后面的 defer 会检查：
	// - stored=true && committed=false：说明文件已写入但数据库未成功，需要清理；
	// - committed=true：说明数据库已有记录，不应删除文件。
	stored := true
	committed := false
	defer func() {
		// 注意这里使用 context.Background()，而不是 r.Context()。
		//
		// 原因：
		// - 如果客户端断开连接，r.Context() 可能已经取消；
		// - 但 orphan cleanup 仍然应该尽力完成；
		// - 用独立 context 可以避免清理刚开始就被请求取消打断。
		if stored && !committed {
			_ = h.Storage.Delete(context.Background(), storageKey)
		}
	}()

	// 第二阶段：向 Storage 询问真实落盘大小。
	//
	// 为什么不用 Content-Length？
	// - 客户端可能没有传；
	// - body 可能经过代理；
	// - Storage 实际写入大小才是数据库 size_bytes 应该记录的值。
	info, err := h.Storage.Stat(r.Context(), storageKey)
	if err != nil {
		// 如果这里失败，defer 会删除刚刚写入的文件，避免孤儿文件残留。
		response.FailSafe(w, "books.upload.stat", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// 第三阶段：在数据库事务中写入 books / book_assets / ingestion_jobs。
	//
	// 为什么要事务？
	// - 这三张表必须同时成功；
	// - 如果只写入 books 但没写入 book_assets，阅读器找不到原始文件；
	// - 如果只写入 asset 但没写入 job，前端/管理员无法判断导入状态；
	// - 事务可以保证失败时一起回滚。
	tx, err := h.DB.BeginTx(r.Context(), nil)
	if err != nil {
		response.FailSafe(w, "books.upload.tx", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	rollback := true
	defer func() {
		if rollback {
			_ = tx.Rollback()
		}
	}()

	// 初始书名来自文件名去扩展名。
	// 后续 ingest 阶段如果解析出更准确的 metadata，可以再更新 title/authors。
	title := guessTitleFromFilename(filename)

	// 插入 books 主记录。
	//
	// status 初始为 uploaded，表示“原始文件已经上传，但章节/全文索引还没完成”。
	// 前端 UploadButton 随后会调用 ingest，把状态推进到 ready 或 failed。
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO books (id, user_id, title, authors, format, size_bytes,
		                   status, created_at, updated_at)
		VALUES (?, ?, ?, '[]', ?, ?, 'uploaded', ?, ?)
	`, bookID, user.ID, title, format, info.Size, now, now); err != nil {
		response.FailSafe(w, "books.upload.insert_book", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// 插入原始文件资产记录。
	//
	// kind='original' 表示这是用户上传的原始书籍文件。
	// ReaderPage/PdfReader/EpubReader 后续通过 GET /api/books/{id}/file 读取的就是这个资产。
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO book_assets (id, book_id, user_id, kind, storage_key,
		                         content_type, size_bytes, created_at)
		VALUES (?, ?, ?, 'original', ?, ?, ?, ?)
	`, assetID, bookID, user.ID, storageKey, guessContentType(format), info.Size, now); err != nil {
		response.FailSafe(w, "books.upload.insert_asset", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// 插入导入任务记录。
	//
	// 这里创建 pending 任务，表示“还有解析/入库工作要做”。
	// 当前解析主要由前端完成，但保留 jobs 表可以让状态跟踪、错误排查和未来后台 worker 更容易扩展。
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO ingestion_jobs (id, book_id, user_id, state, created_at, updated_at)
		VALUES (?, ?, ?, 'pending', ?, ?)
	`, jobID, bookID, user.ID, now, now); err != nil {
		response.FailSafe(w, "books.upload.insert_job", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// 提交事务后，数据库正式引用 storageKey。
	// 如果 Commit 失败，rollback defer 会回滚事务，orphan cleanup defer 会删除文件。
	if err := tx.Commit(); err != nil {
		response.FailSafe(w, "books.upload.commit", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	rollback = false
	committed = true

	// 写一条结构化日志，方便排查上传问题。
	// 注意日志里不要记录用户上传文件的本地路径或敏感内容。
	logger.Info("books.upload.completed", logger.Fields{
		"userId":    user.ID,
		"bookId":    bookID,
		"format":    format,
		"sizeBytes": info.Size,
	})

	// 返回 201 Created。
	//
	// status=uploaded 告诉前端：
	// - 原始文件已成功保存；
	// - 但这本书还没有完成解析；
	// - 前端接下来应继续调用 /api/books/{id}/ingest 或 /ingest/fail。
	response.Created(w, map[string]any{
		"bookId":    bookID,
		"jobId":     jobID,
		"format":    format,
		"sizeBytes": info.Size,
		"status":    "uploaded",
	})
}

// maxUploadBytes 返回允许上传的最大字节数。
//
// 配置来自 Handler.MaxUploadMB，一般由 config.Load 从环境变量读取。
// 这里做两层保护：
// - <=0 时使用默认 100MB；
// - >10240 时截断到 10240MB，也就是 10GB，避免误配置导致过大请求占满磁盘。
func (h *Handler) maxUploadBytes() int64 {
	mb := h.MaxUploadMB
	if mb <= 0 {
		mb = 100
	}
	if mb > 10240 {
		mb = 10240
	}
	return int64(mb) * 1024 * 1024
}

// sanitizeFilename 清理浏览器传来的文件名。
//
// 安全背景：
// 用户上传的文件名不能直接用于磁盘路径，否则可能出现路径穿越或非法文件名问题。
// 例如：
// - ../../secret.txt
// - C:\Users\xxx\secret.pdf
// - 带有 Windows 不允许的字符 <>:"|?*
//
// path.Base 会先去掉目录部分；
// ReplaceAll 会把危险字符替换成下划线；
// 最后还会拒绝空文件名、"."、".."，并限制最大长度。
func sanitizeFilename(name string) string {
	if name == "" {
		return ""
	}
	name = path.Base(name)
	for _, bad := range []string{"\\", "/", ":", "*", "?", `"`, "<", ">", "|"} {
		name = strings.ReplaceAll(name, bad, "_")
	}
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return ""
	}
	if len(name) > 255 {
		name = name[:255]
	}
	return name
}

// detectFormat 根据文件扩展名判断格式。
//
// path.Ext("hello.epub") 返回 ".epub"；
// strings.TrimPrefix 去掉开头的 "."；
// strings.ToLower 让 ".PDF"、".Pdf" 也能被识别成 "pdf"。
func detectFormat(filename string) string {
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(filename)), ".")
	return ext
}

// magicMatchesFormat 检查文件头是否和扩展名大致匹配。
//
// 这不是完整的安全扫描，也不是完整的文件解析；
// 它只是一个轻量的第一道防线，用很小的内存成本排除明显伪装的文件。
//
// 参数：
// - head：上传文件开头的 headSize 字节；
// - format：从扩展名得到的格式。
func magicMatchesFormat(head []byte, format string) bool {
	if len(head) < 4 {
		return false
	}
	switch format {
	case "epub", "fbz", "cbz":
		// EPUB/FBZ/CBZ 都是 ZIP 容器的一类，常见 ZIP 本地文件头为 PK\x03\x04。
		return head[0] == 'P' && head[1] == 'K' && head[2] == 0x03 && head[3] == 0x04
	case "pdf":
		// PDF 文件通常以 %PDF- 开头。
		return bytes.HasPrefix(head, []byte("%PDF-"))
	case "mobi", "azw", "azw3":
		// MOBI/AZW 系列的标识不在文件开头，而在偏移 60:68 附近。
		if len(head) < 68 {
			return false
		}
		ident := head[60:68]
		return bytes.Equal(ident, []byte("BOOKMOBI")) ||
			bytes.Equal(ident, []byte("TPZ3TPZ3"))
	case "fb2":
		// FB2 是 XML 格式，常见头部包含 <?xml 或 <FictionBook。
		return bytes.Contains(head, []byte("<?xml")) || bytes.Contains(head, []byte("<FictionBook"))
	case "txt":
		// TXT 没有可靠统一的 magic number。
		// 这里允许所有 .txt，因为后续解析失败时会通过 ingest/fail 标记。
		return true
	}
	return false
}

// guessTitleFromFilename 从文件名推测初始书名。
//
// 例如：
// - "三体.epub" -> "三体"
// - "notes.txt" -> "notes"
//
// 这是上传阶段的临时标题。
// 后续解析 EPUB metadata 时，如果拿到正式书名，可以再更新数据库。
func guessTitleFromFilename(name string) string {
	base := strings.TrimSuffix(name, path.Ext(name))
	base = strings.TrimSpace(base)
	if base == "" {
		return "Untitled"
	}
	return base
}

// contains 判断字符串切片 xs 中是否包含 s。
//
// Go 标准库在较早版本中没有通用 slices.Contains；
// 这里手写一个小函数，避免为这么简单的逻辑引入额外依赖。
func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// firstNonEmpty 返回参数列表中第一个非空字符串。
//
// 这个小工具常用于“兼容多个配置名/请求字段”的场景。
// 在本文件中，它用于按优先级读取上传文件名。
func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}
