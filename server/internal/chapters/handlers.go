// Package chapters owns the /api/books/:id/chapters/* surface.
package chapters

import (
	"database/sql"
	"errors"
	"net/http"

	"bookfree/internal/auth"
	"bookfree/internal/response"
)

type Handler struct {
	DB     *sql.DB
	IsProd bool
}

// HandleList → GET /api/books/{id}/chapters/list
//
// Returns the chapter index for the book in TOC order. The legacy
// shape was { chapters: [{id, ord, title, href}, ...] }, with title
// nullable for books whose TOC failed to extract.
func (h *Handler) HandleList(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	if !ownsBook(r, h.DB, user.ID, bookID) {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

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
	defer rows.Close()

	type chapterDTO struct {
		ID    string  `json:"id"`
		Ord   int     `json:"ord"`
		Title *string `json:"title,omitempty"`
		Href  *string `json:"href,omitempty"`
	}
	out := make([]chapterDTO, 0, 32)
	for rows.Next() {
		var c chapterDTO
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
	response.OK(w, map[string]any{"chapters": out})
}

// HandleGet → GET /api/books/{id}/chapters/{chapterId}
//
// Returns the cached HTML / plain-text body of one chapter. The body
// is potentially large, so we let the response writer stream it
// rather than materialise a wrapper struct.
func (h *Handler) HandleGet(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	chapterID := r.PathValue("chapterId")
	if bookID == "" || chapterID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "参数不完整")
		return
	}

	row := h.DB.QueryRowContext(r.Context(), `
		SELECT id, ord, title, href, html, text
		FROM book_chapters
		WHERE id = ? AND book_id = ? AND user_id = ?
		LIMIT 1
	`, chapterID, bookID, user.ID)

	type body struct {
		ID    string  `json:"id"`
		Ord   int     `json:"ord"`
		Title *string `json:"title,omitempty"`
		Href  *string `json:"href,omitempty"`
		HTML  *string `json:"html,omitempty"`
		Text  *string `json:"text,omitempty"`
	}

	var (
		b                       body
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
