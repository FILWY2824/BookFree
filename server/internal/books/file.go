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

// HandleFile → GET /api/books/{id}/file
//
// Streams the original asset back to the client with proper Range
// support — non-negotiable for the PDF reader, which fetches by byte
// range to render a single page without downloading the whole file.
//
// http.ServeContent does the heavy lifting (Range, If-Modified-Since,
// If-None-Match). We just have to feed it an io.ReadSeeker, which the
// local storage driver returns directly from os.Open.
func (h *Handler) HandleFile(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// Step 1: confirm the user owns this book before we touch the FS.
	book, err := FindByID(r.Context(), h.DB, user.ID, bookID)
	if err != nil {
		response.FailSafe(w, "books.file.lookup", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if book == nil {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	// Step 2: fetch the storage key for the original asset.
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

	// Step 3: open the file via the storage driver. Returns an
	// io.ReadSeekCloser ready for ServeContent.
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

	// Set headers BEFORE calling ServeContent. ServeContent
	// inspects them to decide whether to negotiate Range.
	if ctype.Valid && ctype.String != "" {
		w.Header().Set("Content-Type", ctype.String)
	} else if ct := guessContentType(book.Format); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if info.ETag != "" {
		w.Header().Set("ETag", info.ETag)
	}
	w.Header().Set("Accept-Ranges", "bytes")
	// Cache for 5 minutes so a reader scrubbing through pages doesn't
	// re-fetch every range hit. The user can't get a stale file —
	// the asset is content-addressed by storage_key.
	w.Header().Set("Cache-Control", "private, max-age=300")
	// Content-Disposition: inline so PDFs open in the browser viewer.
	// Filename is derived from the book title; quote-escaped per RFC.
	w.Header().Set("Content-Disposition", inlineDisposition(book.Title, book.Format))

	http.ServeContent(w, r, "", info.ModTime, rc)
}

// guessContentType maps a stored format to the right MIME for the
// browser. http.DetectContentType would also work but does an extra
// 512-byte sniff we don't need — we already know the format from the
// books row.
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

func inlineDisposition(title, format string) string {
	safe := strings.NewReplacer(`"`, `\"`, "\n", " ", "\r", " ").Replace(title)
	if safe == "" {
		safe = "book"
	}
	return `inline; filename="` + safe + "." + format + `"`
}
