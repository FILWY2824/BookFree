// Package search owns the search subsystem: the bigram tokenizer
// for legacy CJK content (tokenize.go) and the /api/search HTTP
// handler that runs FTS5 MATCH queries (handler.go).
//
// Per the migration plan §8, this replaces the legacy per-request
// MiniSearch index — no more "load 5000 chunks into a heap-allocated
// inverted index per query".
package search

import (
	"database/sql"
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

// HandleSearch → GET /api/search?q=...&bookId=...&exact=1
//
// Response shape mirrors the legacy /api/search:
//
//	{
//	  q,
//	  chunks: [...],
//	  notes:  [...]
//	}
//
// `exact=1` is a post-filter applied on the candidate set: FTS5
// matches the user's bigram tokens, then we drop any row whose plain
// `text` does not contain the original query verbatim. This keeps the
// reader-page yellow overlays in lockstep with the result list — the
// reason the legacy frontend grew this flag in the first place.
func (h *Handler) HandleSearch(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	bookID := strings.TrimSpace(r.URL.Query().Get("bookId"))
	exact := r.URL.Query().Get("exact") == "1"

	if q == "" {
		response.OK(w, map[string]any{"q": q, "chunks": []any{}, "notes": []any{}})
		return
	}

	matchExpr := QueryString(q)
	if matchExpr == "" {
		response.OK(w, map[string]any{"q": q, "chunks": []any{}, "notes": []any{}})
		return
	}

	chunkLimit := parseLimit(r.URL.Query().Get("limit"), 30, 200)

	chunks, err := h.queryChunks(r, user.ID, matchExpr, bookID, q, exact, chunkLimit)
	if err != nil {
		response.FailSafe(w, "search.chunks", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// Notes search is only meaningful in library scope (no bookId)
	// or when the user is on the notes page. We always return both
	// arrays so the frontend can decide what to render.
	notes, err := h.queryNotes(r, user.ID, matchExpr, bookID, q, exact, chunkLimit)
	if err != nil {
		response.FailSafe(w, "search.notes", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	response.OK(w, map[string]any{
		"q":      q,
		"chunks": chunks,
		"notes":  notes,
	})
}

type chunkHit struct {
	ID           string  `json:"id"`
	BookID       string  `json:"bookId"`
	BookTitle    string  `json:"bookTitle"`
	ChapterID    *string `json:"chapterId,omitempty"`
	ChapterOrd   *int    `json:"chapterOrd,omitempty"`
	ChapterTitle *string `json:"chapterTitle,omitempty"`
	PageNo       *int    `json:"pageNo,omitempty"`
	Locator      *string `json:"locator,omitempty"`
	Snippet      string  `json:"snippet"`
	PlainSnippet string  `json:"plainSnippet"`
	Score        float64 `json:"score"`
}

func (h *Handler) queryChunks(r *http.Request, userID, matchExpr, bookID, rawQ string, exact bool, limit int) ([]chunkHit, error) {
	// FTS5 ranks lower numbers as MORE relevant; we negate so the
	// frontend's "higher = better" assumption holds. snippet() returns
	// a context-trimmed excerpt with bm25's chosen highlight markers.
	args := []any{userID}
	whereBook := ""
	if bookID != "" {
		whereBook = "AND fts.book_id = ?"
		args = append(args, bookID)
	}
	args = append(args, matchExpr, limit)

	sqlStmt := `
		SELECT fts.chunk_id, fts.book_id,
		       COALESCE(b.title, ''),
		       fts.chapter_id, fts.chapter_ord,
		       ch.title,
		       fts.page_no,
		       fts.locator,
		       snippet(book_chunks_fts, 1, '<mark>', '</mark>', '…', 24) AS snip,
		       fts.text,
		       -bm25(book_chunks_fts) AS score
		FROM book_chunks_fts AS fts
		LEFT JOIN books          AS b  ON b.id = fts.book_id
		LEFT JOIN book_chapters  AS ch ON ch.id = fts.chapter_id
		WHERE fts.user_id = ?
		  ` + whereBook + `
		  AND book_chunks_fts MATCH ?
		ORDER BY bm25(book_chunks_fts)
		LIMIT ?
	`

	rows, err := h.DB.QueryContext(r.Context(), sqlStmt, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]chunkHit, 0, limit)
	for rows.Next() {
		var (
			hit                       chunkHit
			chapterID, chapterTitle   sql.NullString
			chapterOrd, pageNo        sql.NullInt64
			locator                   sql.NullString
			snip, plain               string
			score                     float64
		)
		if err := rows.Scan(&hit.ID, &hit.BookID, &hit.BookTitle,
			&chapterID, &chapterOrd, &chapterTitle, &pageNo,
			&locator, &snip, &plain, &score); err != nil {
			return nil, err
		}
		if exact && !strings.Contains(plain, rawQ) {
			continue
		}
		if chapterID.Valid {
			hit.ChapterID = &chapterID.String
		}
		if chapterOrd.Valid {
			v := int(chapterOrd.Int64)
			hit.ChapterOrd = &v
		}
		if chapterTitle.Valid {
			hit.ChapterTitle = &chapterTitle.String
		}
		if pageNo.Valid {
			v := int(pageNo.Int64)
			hit.PageNo = &v
		}
		if locator.Valid {
			hit.Locator = &locator.String
		}
		hit.Snippet = snip
		hit.PlainSnippet = trimSnippet(plain, 200)
		hit.Score = score
		out = append(out, hit)
	}
	return out, rows.Err()
}

type noteHit struct {
	ID           string  `json:"id"`
	BookID       string  `json:"bookId"`
	BookTitle    string  `json:"bookTitle"`
	ChapterID    *string `json:"chapterId,omitempty"`
	Locator      string  `json:"locator"`
	Body         string  `json:"body"`
	SelectedText *string `json:"selectedText,omitempty"`
	Snippet      string  `json:"snippet"`
	Score        float64 `json:"score"`
}

func (h *Handler) queryNotes(r *http.Request, userID, matchExpr, bookID, rawQ string, exact bool, limit int) ([]noteHit, error) {
	args := []any{userID}
	whereBook := ""
	if bookID != "" {
		whereBook = "AND fts.book_id = ?"
		args = append(args, bookID)
	}
	args = append(args, matchExpr, limit)

	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT fts.note_id, fts.book_id, COALESCE(b.title, ''),
		       fts.chapter_id, fts.locator, fts.body, fts.selected_text,
		       snippet(notes_fts, 1, '<mark>', '</mark>', '…', 16) AS snip,
		       -bm25(notes_fts) AS score
		FROM notes_fts AS fts
		LEFT JOIN books AS b ON b.id = fts.book_id
		WHERE fts.user_id = ?
		  `+whereBook+`
		  AND notes_fts MATCH ?
		ORDER BY bm25(notes_fts)
		LIMIT ?
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]noteHit, 0, limit)
	for rows.Next() {
		var (
			h                              noteHit
			chapterID, selected            sql.NullString
			snip                           string
			score                          float64
		)
		if err := rows.Scan(&h.ID, &h.BookID, &h.BookTitle,
			&chapterID, &h.Locator, &h.Body, &selected, &snip, &score); err != nil {
			return nil, err
		}
		if exact && !strings.Contains(h.Body, rawQ) && !(selected.Valid && strings.Contains(selected.String, rawQ)) {
			continue
		}
		if chapterID.Valid {
			h.ChapterID = &chapterID.String
		}
		if selected.Valid {
			h.SelectedText = &selected.String
		}
		h.Snippet = snip
		h.Score = score
		out = append(out, h)
	}
	return out, rows.Err()
}

func parseLimit(s string, dflt, max int) int {
	if s == "" {
		return dflt
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return dflt
	}
	if n > max {
		return max
	}
	return n
}

func trimSnippet(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
