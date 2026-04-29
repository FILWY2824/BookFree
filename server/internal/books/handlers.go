package books

import (
	"context"
	"database/sql"
	"net/http"

	"bookfree/internal/auth"
	"bookfree/internal/logger"
	"bookfree/internal/response"
	"bookfree/internal/storage"
)

// Handler bundles the dependencies the routes need.
type Handler struct {
	DB          *sql.DB
	Storage     storage.Storage
	IsProd      bool
	MaxUploadMB int
}

// HandleList → GET /api/books
func (h *Handler) HandleList(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	books, err := ListByUser(r.Context(), h.DB, user.ID)
	if err != nil {
		response.FailSafe(w, "books.list", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	response.OK(w, map[string]any{"books": books})
}

// HandleGet → GET /api/books/{id}
func (h *Handler) HandleGet(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	id := r.PathValue("id")
	if id == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}
	book, err := FindByID(r.Context(), h.DB, user.ID, id)
	if err != nil {
		response.FailSafe(w, "books.get", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if book == nil {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}
	response.OK(w, map[string]any{"book": book})
}

// HandleDelete → DELETE /api/books/{id}
//
// (Audit P1-04.) Order of operations:
//
//  1. Open a tx, look up every storage_key still attached to the book.
//  2. DELETE FROM books — the cascade rules drop book_assets / chunks
//     / chapters / progress / highlights / notes in the same tx.
//  3. Commit.
//  4. Best-effort delete each storage key from the driver.
//  5. DeletePrefix on `users/<uid>/books/<bid>/` to mop up any file we
//     don't have a row for (covers, sidecar caches) plus the now-empty
//     directory itself. Without step 5 the per-book directory shell
//     was being left behind every time, accumulating fragmentation
//     that would make a future data migration painful — the user
//     called this out explicitly as a problem.
//
// We deliberately delete files AFTER the commit so that a tx rollback
// (e.g. FK violation) doesn't take the user's files with it.
func (h *Handler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	id := r.PathValue("id")
	if id == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}
	ok, keys, err := Delete(r.Context(), h.DB, user.ID, id)
	if err != nil {
		response.FailSafe(w, "books.delete", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if !ok {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	// Drop storage in the background so the response isn't held up by
	// disk I/O on a large book. We use a fresh context detached from
	// the request — the request context will be cancelled the moment
	// we write the JSON reply, but the deletes still need to complete.
	go h.dropStorageKeys(keys, user.ID, id)

	response.OK(w, map[string]any{"deleted": true, "assetCount": len(keys)})
}

func (h *Handler) dropStorageKeys(keys []string, userID, bookID string) {
	ctx := context.Background()
	// Pass 1: delete each tracked file. We still do this even though
	// DeletePrefix would catch them, because (a) it makes per-key
	// failures visible in the log and (b) drivers other than the
	// local FS may not implement DeletePrefix as a single recursive
	// call (e.g. an S3 driver might walk objects).
	for _, k := range keys {
		if err := h.Storage.Delete(ctx, k); err != nil {
			logger.Warn("books.delete.storage", logger.Fields{
				"userId": userID,
				"bookId": bookID,
				"key":    k,
				"err":    err.Error(),
			})
		}
	}
	// Pass 2: nuke the per-book directory so no shell is left behind.
	// The local driver also prunes the now-empty `books/` parent if
	// this was the user's last book.
	prefix := storage.BookPrefix(userID, bookID)
	if err := h.Storage.DeletePrefix(ctx, prefix); err != nil {
		logger.Warn("books.delete.storage.prefix", logger.Fields{
			"userId": userID,
			"bookId": bookID,
			"prefix": prefix,
			"err":    err.Error(),
		})
	}
}
