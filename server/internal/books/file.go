package books

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"bookfree/internal/auth"
	"bookfree/internal/response"
	"bookfree/internal/storage"
)

// HandleFile 处理：GET /api/books/{id}/file
//
// 作用：把某本书的“原始上传文件”返回给浏览器。
//
// 这个接口和前端阅读器关系很密切：
// - PDF 阅读器通常不会一次性下载整个 PDF，而是按字节范围 Range 请求文件片段；
// - EPUB/CBZ 等格式也可能需要读取原始文件，再由前端解析或渲染；
// - 不支持在线解析的格式，也可以通过这个接口下载/打开原始文件。
//
// 本函数做的事情可以拆成 4 步：
// 1. 从认证 context 里取当前用户；
// 2. 确认这本书属于当前用户，防止越权读取文件；
// 3. 从 book_assets 表找到 kind='original' 的 storage_key；
// 4. 通过 Storage.Open 打开文件，并交给 http.ServeContent 输出。
//
// 为什么使用 http.ServeContent？
// Go 标准库的 ServeContent 已经帮我们处理了很多 HTTP 文件服务细节：
// - Range：支持 PDF 这类按字节范围加载的阅读器；
// - If-Modified-Since：浏览器缓存协商；
// - If-None-Match / ETag：避免重复传输未变化内容；
// - 自动设置部分响应状态码，例如 206 Partial Content。
//
// 低内存设计：
// - 这里不会把整本书读入内存；
// - Storage.Open 返回的是可读、可 seek 的文件流；
// - ServeContent 边读边写给客户端，适合大 PDF/EPUB。
func (h *Handler) HandleFile(w http.ResponseWriter, r *http.Request) {
	// 当前用户来自认证中间件。
	// 这个接口必须挂在 RequireUser 后面，因为原始文件属于私有数据。
	user := auth.UserFromContext(r.Context())

	// 读取 Go 1.22 路由参数 {id}。
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// 第一步：确认当前用户拥有这本书。
	//
	// 为什么先查 ownership，再打开文件？
	// - 如果不先校验，攻击者只要猜到 storage_key 或 bookID，就可能下载别人的文件；
	// - 书籍原始文件可能包含用户隐私数据；
	// - 权限判断必须发生在任何文件系统访问之前。
	book, err := FindByID(r.Context(), h.DB, user.ID, bookID)
	if err != nil {
		response.FailSafe(w, "books.file.lookup", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if book == nil {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	// 第二步：从 book_assets 表找到原始文件的 storage_key。
	//
	// book_assets 里可能存多种资产：
	// - original：用户上传的原始书籍文件；
	// - cover：封面；
	// - 未来可能有派生文件、缓存文件等。
	//
	// 这里明确 kind='original'，因为阅读器要读取的是原始书籍文件。
	var (
		key   string
		ctype sql.NullString
	)
	row := h.DB.QueryRowContext(r.Context(), `
		SELECT storage_key, content_type
		FROM book_assets
		WHERE book_id = ? AND user_id = ? AND kind = 'original'
		LIMIT 1
	`, bookID, user.ID)
	if err := row.Scan(&key, &ctype); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "原始文件不存在")
			return
		}
		response.FailSafe(w, "books.file.asset", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// 第三步：通过 Storage 抽象打开文件。
	//
	// 当前 Storage 实现通常是本地文件系统，Open 内部可能调用 os.Open。
	// 返回值 rc 通常实现了：
	// - Read：读取文件内容；
	// - Seek：跳转到指定字节位置；
	// - Close：关闭文件句柄。
	//
	// Seek 能力非常重要，因为 ServeContent 需要它来支持 Range 请求。
	rc, info, err := h.Storage.Open(r.Context(), key)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "文件不存在")
			return
		}
		response.FailSafe(w, "books.file.open", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rc.Close()

	// 第四步：设置响应头，然后交给 http.ServeContent。
	//
	// 注意：这些 Header 必须在 ServeContent 之前设置。
	// ServeContent 会根据请求头和响应头来决定是否走缓存、Range、206 等逻辑。

	// Content-Type 告诉浏览器文件类型。
	// 优先使用数据库中记录的 content_type；如果没有，再根据 book.Format 推断。
	if ctype.Valid && ctype.String != "" {
		w.Header().Set("Content-Type", ctype.String)
	} else if ct := guessContentType(book.Format); ct != "" {
		w.Header().Set("Content-Type", ct)
	}

	// ETag 是文件版本标识。
	// 如果浏览器下次请求带 If-None-Match 且 ETag 没变，服务端可以返回 304，减少传输。
	if info.ETag != "" {
		w.Header().Set("ETag", info.ETag)
	}

	// 明确告诉浏览器和 PDF.js：这个接口支持按字节范围读取。
	//
	// 对 PDF 很关键：
	// - PDF 阅读器可能只需要当前页附近的数据；
	// - Range 可以避免每次都下载整个大 PDF；
	// - 这也有助于降低服务器内存和网络压力。
	w.Header().Set("Accept-Ranges", "bytes")

	// private 表示缓存只属于当前用户的浏览器，不能被共享代理缓存。
	// max-age=300 表示 5 分钟内可以复用缓存。
	//
	// 这样用户在 PDF 中翻页、返回、重新渲染时，不必每次都重新读取同一段内容。
	w.Header().Set("Cache-Control", "private, max-age=300")

	// Content-Disposition: inline 表示“尽量在浏览器中打开”，而不是强制下载。
	//
	// 对 PDF 来说，inline 可以让浏览器/PDF.js 直接渲染；
	// filename 用于下载时显示友好的文件名。
	w.Header().Set("Content-Disposition", inlineDisposition(book.Title, book.Format))

	// ServeContent 会把 rc 作为文件内容来源。
	//
	// 第三个参数 name 这里传空字符串，是因为我们已经手动设置了 Content-Disposition；
	// info.ModTime 用于 Last-Modified 缓存协商；
	// rc 必须支持 Seek，才能完整支持 Range。
	http.ServeContent(w, r, "", info.ModTime, rc)
}

// guessContentType 根据书籍格式返回浏览器理解的 MIME 类型。
//
// 为什么不直接用 http.DetectContentType？
// - DetectContentType 需要读取文件前 512 字节；
// - 在这里我们已经从数据库知道格式，不需要再次嗅探；
// - 少一次读取更简单，也更符合低内存/低开销目标。
func guessContentType(format string) string {
	switch strings.ToLower(format) {
	case "epub":
		return "application/epub+zip"
	case "pdf":
		return "application/pdf"
	case "mobi", "azw", "azw3":
		return "application/x-mobipocket-ebook"
	case "fb2":
		return "application/x-fictionbook+xml"
	case "fbz", "cbz":
		return "application/zip"
	case "txt":
		return "text/plain; charset=utf-8"
	}
	return "application/octet-stream"
}

// inlineDisposition 生成 Content-Disposition 响应头。
//
// 返回值类似：
//
//	inline; filename="三体.pdf"
//
// 其中：
// - inline：告诉浏览器优先在线打开；
// - filename：如果用户另存为/下载，浏览器使用这个文件名。
//
// 这里会简单转义双引号和换行，避免文件名破坏 Header 格式。
// 更复杂的国际化 filename* 编码可以以后再增强；当前实现足够轻量。
func inlineDisposition(title, format string) string {
	safe := strings.NewReplacer(`"`, `\"`, "\n", " ", "\r", " ").Replace(title)
	if safe == "" {
		safe = "book"
	}
	return `inline; filename="` + safe + "." + format + `"`
}
