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

// SupportedFormats lists the extensions we accept on upload.
var SupportedFormats = []string{"epub", "pdf", "txt", "fb2", "fbz", "cbz", "mobi", "azw", "azw3"}

const headSize = 512

// HandleUpload → PUT /api/books/upload
//
// Streams the raw request body to the storage driver, then transactionally
// inserts books / book_assets / ingestion_jobs rows. (Audit P1-05.) The
// orphan-cleanup contract is:
//
//   stored=true   → bytes are on disk under storageKey.
//   committed=true → the DB now references those bytes.
//   defer drops storage if stored && !committed.
//
// This covers EVERY failure mode after Storage.Put returns success —
// including Stat failure, BeginTx failure, INSERT failure, and Commit
// failure. The previous version only covered post-BeginTx failures, so
// a Stat error left the file on disk forever.
func (h *Handler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())

	if r.Body == nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体为空")
		return
	}
	defer r.Body.Close()

	filename := firstNonEmpty(
		r.Header.Get("x-bookfree-filename"),
		r.Header.Get("x-alma-filename"),
		r.URL.Query().Get("filename"),
	)
	filename = sanitizeFilename(filename)
	if filename == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少文件名")
		return
	}
	format := detectFormat(filename)
	if format == "" || !contains(SupportedFormats, format) {
		response.Fail(w, http.StatusBadRequest, response.CodeUnsupportedFormat,
			"不支持的格式：."+format)
		return
	}

	maxBytes := h.maxUploadBytes()
	if r.ContentLength > 0 && r.ContentLength > maxBytes {
		response.Fail(w, http.StatusRequestEntityTooLarge,
			response.CodeValidation, "文件过大")
		return
	}

	body := http.MaxBytesReader(w, r.Body, maxBytes)

	head := make([]byte, 0, headSize)
	headBuf := bytes.NewBuffer(head)
	teeReader := io.TeeReader(io.LimitReader(body, headSize), headBuf)
	headBytes, headErr := io.ReadAll(teeReader)
	if headErr != nil && !errors.Is(headErr, io.EOF) {
		if strings.Contains(headErr.Error(), "exceeds") {
			response.Fail(w, http.StatusRequestEntityTooLarge,
				response.CodeValidation, "文件过大")
			return
		}
		response.FailSafe(w, "books.upload.head", headErr, http.StatusBadRequest, h.IsProd)
		return
	}

	if !magicMatchesFormat(headBytes, format) {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation,
			"文件内容与扩展名不匹配（.格式="+format+"）")
		return
	}

	full := io.MultiReader(bytes.NewReader(headBytes), body)

	bookID := security.RandomID()
	jobID := security.RandomID()
	assetID := security.RandomID()
	storageKey := storage.BookKey(user.ID, bookID, "original."+format)

	now := time.Now().Unix()

	// Stage 1: write bytes to disk. Anything that goes wrong AFTER this
	// point must roll back the storage write, otherwise we orphan the
	// file. The single bool below tracks that obligation; the deferred
	// closure below the tx checks it on every exit path.
	declaredSize := r.ContentLength
	if declaredSize < 0 {
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
	stored := true
	committed := false
	defer func() {
		// Detached context — request ctx may already be cancelled.
		if stored && !committed {
			_ = h.Storage.Delete(context.Background(), storageKey)
		}
	}()

	// Stage 2: ask the storage driver for the actual bytes-on-disk size.
	info, err := h.Storage.Stat(r.Context(), storageKey)
	if err != nil {
		// (Audit P1-05): we used to leak the file here. The deferred
		// cleanup above now drops it.
		response.FailSafe(w, "books.upload.stat", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// Stage 3: persist DB rows transactionally.
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

	title := guessTitleFromFilename(filename)

	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO books (id, user_id, title, authors, format, size_bytes,
		                   status, created_at, updated_at)
		VALUES (?, ?, ?, '[]', ?, ?, 'uploaded', ?, ?)
	`, bookID, user.ID, title, format, info.Size, now, now); err != nil {
		response.FailSafe(w, "books.upload.insert_book", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO book_assets (id, book_id, user_id, kind, storage_key,
		                         content_type, size_bytes, created_at)
		VALUES (?, ?, ?, 'original', ?, ?, ?, ?)
	`, assetID, bookID, user.ID, storageKey, guessContentType(format), info.Size, now); err != nil {
		response.FailSafe(w, "books.upload.insert_asset", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO ingestion_jobs (id, book_id, user_id, state, created_at, updated_at)
		VALUES (?, ?, ?, 'pending', ?, ?)
	`, jobID, bookID, user.ID, now, now); err != nil {
		response.FailSafe(w, "books.upload.insert_job", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	if err := tx.Commit(); err != nil {
		response.FailSafe(w, "books.upload.commit", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	rollback = false
	committed = true

	logger.Info("books.upload.completed", logger.Fields{
		"userId":    user.ID,
		"bookId":    bookID,
		"format":    format,
		"sizeBytes": info.Size,
	})

	// Ingestion is the SPA's job — it parses TXT/EPUB in a Web Worker
	// and POSTs chapters/chunks back to /api/books/{id}/ingest. The
	// books row stays in 'uploaded' until that endpoint marks it 'ready'.
	response.Created(w, map[string]any{
		"bookId":    bookID,
		"jobId":     jobID,
		"format":    format,
		"sizeBytes": info.Size,
		"status":    "uploaded",
	})
}

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

func detectFormat(filename string) string {
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(filename)), ".")
	return ext
}

func magicMatchesFormat(head []byte, format string) bool {
	if len(head) < 4 {
		return false
	}
	switch format {
	case "epub", "fbz", "cbz":
		return head[0] == 'P' && head[1] == 'K' && head[2] == 0x03 && head[3] == 0x04
	case "pdf":
		return bytes.HasPrefix(head, []byte("%PDF-"))
	case "mobi", "azw", "azw3":
		if len(head) < 68 {
			return false
		}
		ident := head[60:68]
		return bytes.Equal(ident, []byte("BOOKMOBI")) ||
			bytes.Equal(ident, []byte("TPZ3TPZ3"))
	case "fb2":
		return bytes.Contains(head, []byte("<?xml")) || bytes.Contains(head, []byte("<FictionBook"))
	case "txt":
		return true
	}
	return false
}

func guessTitleFromFilename(name string) string {
	base := strings.TrimSuffix(name, path.Ext(name))
	base = strings.TrimSpace(base)
	if base == "" {
		return "Untitled"
	}
	return base
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}
