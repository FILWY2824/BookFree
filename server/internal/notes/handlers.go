// Package notes owns /api/books/{id}/highlights and /api/books/{id}/notes.
//
// We keep the surface minimal compared to the legacy Next.js project:
//
//   GET  /api/books/{id}/highlights          → list active highlights
//   POST /api/books/{id}/highlights          → create one
//   DELETE /api/highlights/{id}              → soft-delete one
//
//   GET  /api/books/{id}/notes               → list active notes
//   POST /api/books/{id}/notes               → create one
//   PUT  /api/notes/{id}                     → update body
//   DELETE /api/notes/{id}                   → soft-delete one
//
// All writes scope by user_id; the cascade rules in migration 0014
// guarantee a user can never read or write another user's data.
package notes

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"bookfree/internal/auth"
	"bookfree/internal/response"
	"bookfree/internal/search"
	"bookfree/internal/security"
)

type Handler struct {
	DB     *sql.DB
	IsProd bool
}

// ── highlights ───────────────────────────────────────────────────────

type highlightDTO struct {
	ID           string  `json:"id"`
	BookID       string  `json:"bookId"`
	ChapterID    *string `json:"chapterId,omitempty"`
	PageNo       *int    `json:"pageNo,omitempty"`
	Locator      string  `json:"locator"`
	SelectedText string  `json:"selectedText"`
	Color        string  `json:"color"`
	// Style is one of: "highlight", "underline", "wavy", "strike".
	// Persisted via migration 0019. Defaults to "highlight" for legacy
	// rows. We always emit it on the wire so the client renders the
	// right CSS class without inferring.
	Style     string `json:"style"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type highlightCreate struct {
	ChapterID    *string `json:"chapterId,omitempty"`
	PageNo       *int    `json:"pageNo,omitempty"`
	Locator      string  `json:"locator"`
	SelectedText string  `json:"selectedText"`
	Color        string  `json:"color"`
	Style        string  `json:"style,omitempty"`
}

// GET /api/books/{id}/highlights
func (h *Handler) HandleListHighlights(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT id, book_id, chapter_id, page_no, locator, selected_text, color, style, created_at, updated_at
		FROM highlights
		WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL
		ORDER BY created_at ASC
		LIMIT 5000
	`, user.ID, bookID)
	if err != nil {
		response.FailSafe(w, "highlights.list", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()
	out := make([]highlightDTO, 0, 32)
	for rows.Next() {
		var d highlightDTO
		var chapter sql.NullString
		var page sql.NullInt64
		if err := rows.Scan(&d.ID, &d.BookID, &chapter, &page, &d.Locator,
			&d.SelectedText, &d.Color, &d.Style, &d.CreatedAt, &d.UpdatedAt); err != nil {
			response.FailSafe(w, "highlights.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if chapter.Valid {
			s := chapter.String
			d.ChapterID = &s
		}
		if page.Valid {
			n := int(page.Int64)
			d.PageNo = &n
		}
		out = append(out, d)
	}
	response.OK(w, map[string]any{"highlights": out})
}

// POST /api/books/{id}/highlights
func (h *Handler) HandleCreateHighlight(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if !ownsBook(r, h.DB, user.ID, bookID) {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}
	var body highlightCreate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}
	body.SelectedText = strings.TrimSpace(body.SelectedText)
	body.Locator = strings.TrimSpace(body.Locator)
	if body.SelectedText == "" || body.Locator == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "selectedText 与 locator 必填")
		return
	}
	if !validColor(body.Color) {
		body.Color = "yellow"
	}
	if !validStyle(body.Style) {
		body.Style = "highlight"
	}
	id := security.RandomID()
	now := time.Now().Unix()
	if _, err := h.DB.ExecContext(r.Context(), `
		INSERT INTO highlights (id, user_id, book_id, chapter_id, page_no, locator,
		                        selected_text, color, style, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, id, user.ID, bookID,
		nullStrPtr(body.ChapterID), nullIntPtr(body.PageNo),
		body.Locator, body.SelectedText, body.Color, body.Style, now, now); err != nil {
		response.FailSafe(w, "highlights.create", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	response.Created(w, map[string]any{
		"highlight": highlightDTO{
			ID:           id,
			BookID:       bookID,
			ChapterID:    body.ChapterID,
			PageNo:       body.PageNo,
			Locator:      body.Locator,
			SelectedText: body.SelectedText,
			Color:        body.Color,
			Style:        body.Style,
			CreatedAt:    now,
			UpdatedAt:    now,
		},
	})
}

// DELETE /api/highlights/{id}
func (h *Handler) HandleDeleteHighlight(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	hlID := r.PathValue("id")
	now := time.Now().Unix()
	res, err := h.DB.ExecContext(r.Context(), `
		UPDATE highlights SET deleted_at = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND deleted_at IS NULL
	`, now, now, hlID, user.ID)
	if err != nil {
		response.FailSafe(w, "highlights.delete", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "高亮不存在")
		return
	}
	response.OK(w, map[string]any{"deleted": true})
}

// ── notes ────────────────────────────────────────────────────────────

type noteDTO struct {
	ID           string  `json:"id"`
	BookID       string  `json:"bookId"`
	HighlightID  *string `json:"highlightId,omitempty"`
	ChapterID    *string `json:"chapterId,omitempty"`
	PageNo       *int    `json:"pageNo,omitempty"`
	Locator      string  `json:"locator"`
	SelectedText *string `json:"selectedText,omitempty"`
	Body         string  `json:"body"`
	CreatedAt    int64   `json:"createdAt"`
	UpdatedAt    int64   `json:"updatedAt"`
}

type noteCreate struct {
	HighlightID  *string `json:"highlightId,omitempty"`
	ChapterID    *string `json:"chapterId,omitempty"`
	PageNo       *int    `json:"pageNo,omitempty"`
	Locator      string  `json:"locator"`
	SelectedText *string `json:"selectedText,omitempty"`
	Body         string  `json:"body"`
}

// GET /api/books/{id}/notes
func (h *Handler) HandleListNotes(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT id, book_id, highlight_id, chapter_id, page_no, locator,
		       selected_text, body, created_at, updated_at
		FROM notes
		WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL
		ORDER BY created_at DESC
		LIMIT 5000
	`, user.ID, bookID)
	if err != nil {
		response.FailSafe(w, "notes.list", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()
	out := make([]noteDTO, 0, 32)
	for rows.Next() {
		var d noteDTO
		var hl, chapter, sel sql.NullString
		var page sql.NullInt64
		if err := rows.Scan(&d.ID, &d.BookID, &hl, &chapter, &page,
			&d.Locator, &sel, &d.Body, &d.CreatedAt, &d.UpdatedAt); err != nil {
			response.FailSafe(w, "notes.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if hl.Valid {
			s := hl.String
			d.HighlightID = &s
		}
		if chapter.Valid {
			s := chapter.String
			d.ChapterID = &s
		}
		if sel.Valid {
			s := sel.String
			d.SelectedText = &s
		}
		if page.Valid {
			n := int(page.Int64)
			d.PageNo = &n
		}
		out = append(out, d)
	}
	response.OK(w, map[string]any{"notes": out})
}

// HandleListAllNotes → GET /api/notes
//
// All notes across the user's library, ordered most-recent first.
func (h *Handler) HandleListAllNotes(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT n.id, n.book_id, b.title, n.chapter_id, n.locator,
		       n.selected_text, n.body, n.created_at, n.updated_at
		FROM notes n
		JOIN books b ON b.id = n.book_id AND b.user_id = n.user_id
		WHERE n.user_id = ? AND n.deleted_at IS NULL
		ORDER BY n.updated_at DESC
		LIMIT 1000
	`, user.ID)
	if err != nil {
		response.FailSafe(w, "notes.all", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()

	type dto struct {
		ID           string  `json:"id"`
		BookID       string  `json:"bookId"`
		BookTitle    string  `json:"bookTitle"`
		ChapterID    *string `json:"chapterId,omitempty"`
		Locator      string  `json:"locator"`
		SelectedText *string `json:"selectedText,omitempty"`
		Body         string  `json:"body"`
		CreatedAt    int64   `json:"createdAt"`
		UpdatedAt    int64   `json:"updatedAt"`
	}

	out := make([]dto, 0, 32)
	for rows.Next() {
		var d dto
		var chapter, sel sql.NullString
		if err := rows.Scan(&d.ID, &d.BookID, &d.BookTitle, &chapter,
			&d.Locator, &sel, &d.Body, &d.CreatedAt, &d.UpdatedAt); err != nil {
			response.FailSafe(w, "notes.all.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if chapter.Valid {
			s := chapter.String
			d.ChapterID = &s
		}
		if sel.Valid {
			s := sel.String
			d.SelectedText = &s
		}
		out = append(out, d)
	}
	response.OK(w, map[string]any{"notes": out})
}

// HandleListAllHighlights → GET /api/highlights
//
// All highlights / underlines / strikes / wavy across the user's
// library, ordered most-recent first. Symmetric with HandleListAllNotes
// — the new "标注与笔记" page consumes both feeds and merges them in
// the UI by locator. Limit 2000 keeps the response under a few hundred
// KB on power-user libraries; if a user has more, they probably want
// the per-book endpoint anyway.
func (h *Handler) HandleListAllHighlights(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT hl.id, hl.book_id, b.title, hl.chapter_id, hl.page_no,
		       hl.locator, hl.selected_text, hl.color, hl.style,
		       hl.created_at, hl.updated_at
		FROM highlights hl
		JOIN books b ON b.id = hl.book_id AND b.user_id = hl.user_id
		WHERE hl.user_id = ? AND hl.deleted_at IS NULL
		ORDER BY hl.updated_at DESC
		LIMIT 2000
	`, user.ID)
	if err != nil {
		response.FailSafe(w, "highlights.all", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()

	type dto struct {
		ID           string  `json:"id"`
		BookID       string  `json:"bookId"`
		BookTitle    string  `json:"bookTitle"`
		ChapterID    *string `json:"chapterId,omitempty"`
		PageNo       *int    `json:"pageNo,omitempty"`
		Locator      string  `json:"locator"`
		SelectedText string  `json:"selectedText"`
		Color        string  `json:"color"`
		Style        string  `json:"style"`
		CreatedAt    int64   `json:"createdAt"`
		UpdatedAt    int64   `json:"updatedAt"`
	}

	out := make([]dto, 0, 32)
	for rows.Next() {
		var d dto
		var chapter sql.NullString
		var page sql.NullInt64
		if err := rows.Scan(&d.ID, &d.BookID, &d.BookTitle, &chapter, &page,
			&d.Locator, &d.SelectedText, &d.Color, &d.Style,
			&d.CreatedAt, &d.UpdatedAt); err != nil {
			response.FailSafe(w, "highlights.all.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if chapter.Valid {
			s := chapter.String
			d.ChapterID = &s
		}
		if page.Valid {
			n := int(page.Int64)
			d.PageNo = &n
		}
		out = append(out, d)
	}
	response.OK(w, map[string]any{"highlights": out})
}

// POST /api/books/{id}/notes
func (h *Handler) HandleCreateNote(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if !ownsBook(r, h.DB, user.ID, bookID) {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}
	var body noteCreate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}
	body.Body = strings.TrimSpace(body.Body)
	body.Locator = strings.TrimSpace(body.Locator)
	if body.Body == "" || body.Locator == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "body 与 locator 必填")
		return
	}
	id := security.RandomID()
	now := time.Now().Unix()
	searchText := search.SearchText(body.Body)
	if _, err := h.DB.ExecContext(r.Context(), `
		INSERT INTO notes (id, user_id, book_id, highlight_id, chapter_id, page_no, locator,
		                   selected_text, body, search_text, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, id, user.ID, bookID,
		nullStrPtr(body.HighlightID), nullStrPtr(body.ChapterID), nullIntPtr(body.PageNo),
		body.Locator, nullStrPtr(body.SelectedText), body.Body, searchText, now, now); err != nil {
		response.FailSafe(w, "notes.create", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	response.Created(w, map[string]any{
		"note": noteDTO{
			ID:           id,
			BookID:       bookID,
			HighlightID:  body.HighlightID,
			ChapterID:    body.ChapterID,
			PageNo:       body.PageNo,
			Locator:      body.Locator,
			SelectedText: body.SelectedText,
			Body:         body.Body,
			CreatedAt:    now,
			UpdatedAt:    now,
		},
	})
}

// PUT /api/notes/{id}
func (h *Handler) HandleUpdateNote(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	noteID := r.PathValue("id")
	var body struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}
	body.Body = strings.TrimSpace(body.Body)
	if body.Body == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "body 不能为空")
		return
	}
	now := time.Now().Unix()
	searchText := search.SearchText(body.Body)
	res, err := h.DB.ExecContext(r.Context(), `
		UPDATE notes SET body = ?, search_text = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND deleted_at IS NULL
	`, body.Body, searchText, now, noteID, user.ID)
	if err != nil {
		response.FailSafe(w, "notes.update", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "笔记不存在")
		return
	}
	response.OK(w, map[string]any{"updated": true})
}

// DELETE /api/notes/{id}
func (h *Handler) HandleDeleteNote(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	noteID := r.PathValue("id")
	now := time.Now().Unix()
	res, err := h.DB.ExecContext(r.Context(), `
		UPDATE notes SET deleted_at = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND deleted_at IS NULL
	`, now, now, noteID, user.ID)
	if err != nil {
		response.FailSafe(w, "notes.delete", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "笔记不存在")
		return
	}
	response.OK(w, map[string]any{"deleted": true})
}

// ── helpers ──────────────────────────────────────────────────────────

func ownsBook(r *http.Request, db *sql.DB, userID, bookID string) bool {
	if bookID == "" {
		return false
	}
	var n int
	err := db.QueryRowContext(r.Context(),
		`SELECT 1 FROM books WHERE id = ? AND user_id = ? LIMIT 1`,
		bookID, userID).Scan(&n)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false
		}
		return false
	}
	return n == 1
}

func validColor(c string) bool {
	switch c {
	case "yellow", "red", "green", "blue", "purple", "orange":
		return true
	}
	return false
}

// validStyle gates the highlight `style` column. Mirrors the four
// values supported by migration 0019 and the client-side
// HighlightStyle union.
func validStyle(s string) bool {
	switch s {
	case "highlight", "underline", "wavy", "strike":
		return true
	}
	return false
}

func nullStrPtr(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}

func nullIntPtr(i *int) any {
	if i == nil {
		return nil
	}
	return *i
}
