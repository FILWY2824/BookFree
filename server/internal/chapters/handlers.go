// Package chapters owns the /api/books/:id/chapters/* surface.
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

// HandleTOC → GET /api/books/{id}/toc
//
// Returns the hierarchical table of contents that the SPA-side parser
// extracted at ingest time. The shape mirrors what the parser emits:
//
//	{
//	  "items": [
//	    { "label": "Part I", "depth": 0, "children": [
//	        { "label": "Chapter 1", "chapterId": "...", "depth": 1, "children": [...] }
//	    ]},
//	    ...
//	  ]
//	}
//
// When the book has no stored TOC (NULL `books.toc` — pre-migration
// rows or formats whose parser couldn't extract one), we fall back to
// synthesising a flat tree from book_chapters, so the TocDrawer always
// has something to show. That preserves the legacy behaviour for old
// books while letting newly-ingested ones surface their real hierarchy.
func (h *Handler) HandleTOC(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

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
		// We pass the JSON straight through. Validating it once at
		// ingest time is enough; re-parsing on every read would just
		// burn cycles for no benefit.
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"ok":true,"data":{"items":` + stored.String + `}}`))
		return
	}

	// Fallback: synthesise a flat tree from chapter rows.
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
		label := strings.TrimSpace(title.String)
		if label == "" {
			label = chapterFallbackLabel(ord)
		}
		idCopy := id
		out = append(out, item{Label: label, ChapterID: &idCopy, Depth: 0})
	}
	response.OK(w, map[string]any{"items": out})
}

func chapterFallbackLabel(ord int) string {
	// Keep the legacy "第 N 章" format here so the fallback list reads
	// the same way the old TocDrawer rendered it.
	return "第 " + strconv.Itoa(ord+1) + " 章"
}
