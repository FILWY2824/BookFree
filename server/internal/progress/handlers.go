// Package progress backs /api/books/:id/progress.
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

type Handler struct {
	DB     *sql.DB
	IsProd bool
}

type progressDTO struct {
	Locator      *string `json:"locator,omitempty"`
	ChapterID    *string `json:"chapterId,omitempty"`
	ChapterOrder *int    `json:"chapterOrder,omitempty"`
	PageNo       *int    `json:"pageNo,omitempty"`
	Percent      float64 `json:"percent"`
	LastReadAt   int64   `json:"lastReadAt"`
}

// HandleGet → GET /api/books/{id}/progress
//
// Returns the user's saved position. When no row exists yet (the user
// has never opened this book), we return zero-value progress rather
// than 404 — the frontend treats both the same, and a 200 is one less
// thing for the loading indicator to interpret.
func (h *Handler) HandleGet(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	row := h.DB.QueryRowContext(r.Context(), `
		SELECT locator, chapter_id, chapter_order, page_no, percent, last_read_at
		FROM reading_progress
		WHERE user_id = ? AND book_id = ?
		LIMIT 1
	`, user.ID, bookID)

	var (
		locator              sql.NullString
		chapterID            sql.NullString
		chapterOrder, pageNo sql.NullInt64
		percent              float64
		lastReadAt           int64
	)
	if err := row.Scan(&locator, &chapterID, &chapterOrder, &pageNo, &percent, &lastReadAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			response.OK(w, map[string]any{"progress": progressDTO{Percent: 0}})
			return
		}
		response.FailSafe(w, "progress.get", err, http.StatusInternalServerError, h.IsProd)
		return
	}
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

// HandlePut → PUT /api/books/{id}/progress
//
// Upserts a row keyed by (user_id, book_id). The schema declares that
// pair as the primary key (migration 0003) so we can use INSERT…ON
// CONFLICT.
func (h *Handler) HandlePut(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	var body struct {
		Locator      *string  `json:"locator"`
		ChapterID    *string  `json:"chapterId"`
		ChapterOrder *int     `json:"chapterOrder"`
		PageNo       *int     `json:"pageNo"`
		Percent      *float64 `json:"percent"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}

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
	now := time.Now().Unix()

	// Confirm ownership before writing — a user must not be able to
	// "save progress" on someone else's book.
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

func toNullStr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}
func toNullInt(i *int) any {
	if i == nil {
		return nil
	}
	return *i
}
