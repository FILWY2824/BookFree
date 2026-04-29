// Package ingest owns POST /api/books/{id}/ingest.
//
// The migration plan §11 picks the client-side ingest path: the SPA
// parses TXT/EPUB in a Web Worker, then POSTs the structured output
// (chapters + chunks + cover) here, and we persist it. This trades CPU
// off the server (where it would have to re-implement zip + XML +
// every quirk of every EPUB toolchain) for some kilobytes of upload.
//
// We deliberately keep the schema thin:
//
//	{
//	  "title":      "...",                  // optional override
//	  "authors":    ["..."],                // optional
//	  "language":   "...",                  // optional
//	  "publisher":  "...",                  // optional
//	  "chapters":   [{ "id":"c1", "ord":0, "title":"...", "html":"...", "text":"..." }, ...],
//	  "chunks":     [{ "id":"k1", "chapterId":"c1", "ord":0, "pageNo":null, "text":"..." }, ...]
//	}
//
// The handler is idempotent at the book level: a second POST with the
// same body wipes the previous chapters/chunks and re-inserts. That
// matches the legacy "re-ingest" UX and means a client retry on
// transient network errors doesn't double-index the book.
package ingest

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"bookfree/internal/ai"
	"bookfree/internal/auth"
	"bookfree/internal/response"
	"bookfree/internal/search"
)

type Handler struct {
	DB     *sql.DB
	IsProd bool
}

type chapterIn struct {
	ID    string  `json:"id"`
	Ord   int     `json:"ord"`
	Title *string `json:"title,omitempty"`
	Href  *string `json:"href,omitempty"`
	HTML  *string `json:"html,omitempty"`
	Text  *string `json:"text,omitempty"`
}

type chunkIn struct {
	ID         string  `json:"id"`
	ChapterID  *string `json:"chapterId,omitempty"`
	ChapterOrd *int    `json:"chapterOrd,omitempty"`
	PageNo     *int    `json:"pageNo,omitempty"`
	Ord        int     `json:"ord"`
	Text       string  `json:"text"`
}

// tocItemIn is the wire shape for a single TOC entry. The tree is
// arbitrary in depth; "ChapterID" is the parser-side chapter id (the
// `c.ID` value the SPA emits in `chapters[]`), which we then rewrite
// to the scoped DB id during persistence so the frontend can navigate
// directly via /api/books/{id}/chapters/{chapterId}.
type tocItemIn struct {
	Label     string      `json:"label"`
	ChapterID *string     `json:"chapterId,omitempty"`
	Depth     *int        `json:"depth,omitempty"`
	Children  []tocItemIn `json:"children,omitempty"`
}

type ingestBody struct {
	Title     *string     `json:"title,omitempty"`
	Authors   []string    `json:"authors,omitempty"`
	Language  *string     `json:"language,omitempty"`
	Publisher *string     `json:"publisher,omitempty"`
	Chapters  []chapterIn `json:"chapters"`
	Chunks    []chunkIn   `json:"chunks"`
	TOC       []tocItemIn `json:"toc,omitempty"`
}

// max body size for an ingest payload. Real-world EPUB ingest payloads
// run 200 KB - 5 MB depending on book length. 32 MiB is a generous cap
// that covers any reasonable book.
const maxIngestBytes = 32 << 20

// HandlePost → POST /api/books/{id}/ingest
//
// On success the books row transitions 'uploaded' → 'ready'. The status
// transition is what unblocks the reader's "this book has chapters"
// check and the search index for new content.
func (h *Handler) HandlePost(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}

	// Confirm ownership before doing any heavy work. We also load the
	// format because PDF is rendered directly from the original file in
	// the browser and is allowed to complete ingest without extracted
	// chapters/chunks.
	var ownerID string
	var bookFormat string
	if err := h.DB.QueryRowContext(r.Context(),
		`SELECT user_id, format FROM books WHERE id = ? LIMIT 1`, bookID).Scan(&ownerID, &bookFormat); err != nil {
		if err == sql.ErrNoRows || ownerID != user.ID {
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
			return
		}
		response.FailSafe(w, "ingest.lookup", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if ownerID != user.ID {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}

	var body ingestBody
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxIngestBytes))
	if err := dec.Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法："+err.Error())
		return
	}
	if len(body.Chapters) == 0 && len(body.Chunks) == 0 && strings.ToLower(bookFormat) != "pdf" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation,
			"chapters 与 chunks 至少需要一项")
		return
	}

	now := time.Now().Unix()

	tx, err := h.DB.BeginTx(r.Context(), nil)
	if err != nil {
		response.FailSafe(w, "ingest.tx", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	rollback := true
	defer func() {
		if rollback {
			_ = tx.Rollback()
		}
	}()

	// Idempotency: nuke previous chapters/chunks for this book. The
	// FTS5 sync triggers (migration 0020) handle book_chunks_fts
	// cleanup automatically via AFTER DELETE.
	if _, err := tx.ExecContext(r.Context(),
		`DELETE FROM book_chunks WHERE book_id = ? AND user_id = ?`, bookID, user.ID); err != nil {
		response.FailSafe(w, "ingest.clear_chunks", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if _, err := tx.ExecContext(r.Context(),
		`DELETE FROM book_chapters WHERE book_id = ? AND user_id = ?`, bookID, user.ID); err != nil {
		response.FailSafe(w, "ingest.clear_chapters", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	chapterIDs := make(map[string]string, len(body.Chapters))

	// Insert chapters. We accept either html or text (or both); at
	// least one has to be present for the reader to render anything.
	if len(body.Chapters) > 0 {
		stmt, err := tx.PrepareContext(r.Context(), `
			INSERT INTO book_chapters (id, book_id, user_id, ord, title, href, html, text, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		if err != nil {
			response.FailSafe(w, "ingest.prepare_chapter", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		for _, c := range body.Chapters {
			dbID := scopedIngestID(bookID, "chapter", c.ID, c.Ord)
			if strings.TrimSpace(c.ID) != "" {
				chapterIDs[c.ID] = dbID
			}
			if _, err := stmt.ExecContext(r.Context(),
				dbID, bookID, user.ID, c.Ord,
				nullStr(c.Title), nullStr(c.Href),
				nullStr(c.HTML), nullStr(c.Text),
				now); err != nil {
				stmt.Close()
				response.FailSafe(w, "ingest.insert_chapter", err, http.StatusInternalServerError, h.IsProd)
				return
			}
		}
		stmt.Close()
	}

	// Insert chunks. search_text is computed from the body so the
	// FTS5 trigger picks up the row immediately. The bigram tokenizer
	// is the same one the search handler uses, so the index is
	// consistent with the query path.
	//
	// We also write a 96-d hash-vector embedding per chunk into
	// book_chunk_embeddings (migration 0023). The cost is tiny —
	// ~384 bytes per chunk, ~400 KB for a typical book — and lets
	// the streaming-chat endpoint do hybrid (FTS + cosine) ranking
	// without an external embedding service. See ai/rag.go for the
	// full retrieval pipeline; this insert is the only producer.
	if len(body.Chunks) > 0 {
		stmt, err := tx.PrepareContext(r.Context(), `
			INSERT INTO book_chunks (id, book_id, user_id, chapter_id, chapter_ord, page_no, ord, text, search_text, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		if err != nil {
			response.FailSafe(w, "ingest.prepare_chunk", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		embStmt, err := tx.PrepareContext(r.Context(), `
			INSERT INTO book_chunk_embeddings (chunk_id, book_id, user_id, model_tag, vector, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(chunk_id) DO UPDATE SET
				vector     = excluded.vector,
				model_tag  = excluded.model_tag,
				created_at = excluded.created_at
		`)
		if err != nil {
			stmt.Close()
			response.FailSafe(w, "ingest.prepare_embedding", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		for _, c := range body.Chunks {
			if strings.TrimSpace(c.Text) == "" {
				continue
			}
			dbID := scopedIngestID(bookID, "chunk", c.ID, c.Ord)
			chapterID := nullStrPtr(c.ChapterID)
			if c.ChapterID != nil {
				if mapped, ok := chapterIDs[*c.ChapterID]; ok {
					chapterID = mapped
				}
			}
			searchText := search.SearchText(c.Text)
			if _, err := stmt.ExecContext(r.Context(),
				dbID, bookID, user.ID,
				chapterID, nullIntPtr(c.ChapterOrd), nullIntPtr(c.PageNo),
				c.Ord, c.Text, searchText, now); err != nil {
				stmt.Close()
				embStmt.Close()
				response.FailSafe(w, "ingest.insert_chunk", err, http.StatusInternalServerError, h.IsProd)
				return
			}
			vec := ai.EncodeVector(ai.EmbedText(c.Text))
			if _, err := embStmt.ExecContext(r.Context(),
				dbID, bookID, user.ID, ai.EmbedModelTag(), vec, now); err != nil {
				// Embedding insert is non-critical — log and continue.
				// A missing row downgrades retrieval to FTS-only for
				// this chunk, which is still useful.
				_ = err
			}
		}
		stmt.Close()
		embStmt.Close()
	}

	// Update book metadata + status.
	authorsJSON := "[]"
	if len(body.Authors) > 0 {
		if b, err := json.Marshal(body.Authors); err == nil {
			authorsJSON = string(b)
		}
	}

	// Persist the hierarchical TOC. We rewrite each item's chapterId
	// from the parser-side handle to the DB-scoped id we just inserted,
	// so a TocDrawer click can hit /api/books/{id}/chapters/{chapterId}
	// directly. Items whose chapterId doesn't resolve are kept (their
	// label is still useful as a heading), with chapterId left empty so
	// the UI can render them as non-navigable section dividers.
	var tocJSON sql.NullString
	if len(body.TOC) > 0 {
		remapped := remapTocChapterIDs(body.TOC, chapterIDs, 0)
		if b, err := json.Marshal(remapped); err == nil {
			tocJSON = sql.NullString{String: string(b), Valid: true}
		}
	}

	if _, err := tx.ExecContext(r.Context(), `
		UPDATE books
		SET status     = 'ready',
		    title      = COALESCE(NULLIF(?, ''), title),
		    authors    = ?,
		    language   = COALESCE(?, language),
		    publisher  = COALESCE(?, publisher),
		    toc        = ?,
		    error      = NULL,
		    updated_at = ?
		WHERE id = ? AND user_id = ?
	`,
		strDeref(body.Title),
		authorsJSON,
		nullStrPtr(body.Language),
		nullStrPtr(body.Publisher),
		tocJSON,
		now, bookID, user.ID); err != nil {
		response.FailSafe(w, "ingest.update_book", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	if _, err := tx.ExecContext(r.Context(), `
		UPDATE ingestion_jobs
		SET state = 'done', finished_at = ?, updated_at = ?, last_error = NULL
		WHERE book_id = ? AND user_id = ?
	`, now, now, bookID, user.ID); err != nil {
		response.FailSafe(w, "ingest.update_job", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	if err := tx.Commit(); err != nil {
		response.FailSafe(w, "ingest.commit", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	rollback = false

	response.OK(w, map[string]any{
		"bookId":   bookID,
		"status":   "ready",
		"chapters": len(body.Chapters),
		"chunks":   len(body.Chunks),
	})
}

// HandleFail → POST /api/books/{id}/ingest/fail
//
// Called when the SPA's worker can't parse the file (e.g. encrypted
// PDF, corrupted EPUB). Marks the books row 'failed' so the UI can
// surface it instead of leaving it in 'uploaded' indefinitely.
func (h *Handler) HandleFail(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	bookID := r.PathValue("id")

	var body struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body)

	now := time.Now().Unix()
	msg := strings.TrimSpace(body.Error)
	if msg == "" {
		msg = "解析失败"
	}
	if len(msg) > 500 {
		msg = msg[:500]
	}

	res, err := h.DB.ExecContext(r.Context(), `
		UPDATE books SET status = 'failed', error = ?, updated_at = ?
		WHERE id = ? AND user_id = ?
	`, msg, now, bookID, user.ID)
	if err != nil {
		response.FailSafe(w, "ingest.fail.update", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "书籍不存在")
		return
	}
	_, _ = h.DB.ExecContext(r.Context(), `
		UPDATE ingestion_jobs SET state = 'failed', last_error = ?, finished_at = ?, updated_at = ?
		WHERE book_id = ? AND user_id = ?
	`, msg, now, now, bookID, user.ID)

	response.OK(w, map[string]any{"bookId": bookID, "status": "failed"})
}

func scopedIngestID(bookID, kind, raw string, ord int) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = strconv.Itoa(ord)
	}
	return bookID + ":" + kind + ":" + raw
}

// tocItemOut is the shape we write to books.toc. We strip the parser-
// side chapter handles and replace them with the DB-scoped ids the
// frontend uses for navigation. The on-disk JSON is intentionally
// permissive: we keep the depth field even though it's redundant with
// nesting, so a future denormalised renderer can read a flat list
// without re-walking the tree.
type tocItemOut struct {
	Label     string       `json:"label"`
	ChapterID *string      `json:"chapterId,omitempty"`
	Depth     int          `json:"depth"`
	Children  []tocItemOut `json:"children,omitempty"`
}

// remapTocChapterIDs walks the user-supplied tree, swapping each
// parser-side chapter id for the matching DB-scoped id. Items whose
// chapterId is missing or doesn't resolve keep the label only; this
// is normal for "Part I" style headings that don't correspond to a
// readable section.
func remapTocChapterIDs(items []tocItemIn, chapterIDs map[string]string, depth int) []tocItemOut {
	if len(items) == 0 {
		return nil
	}
	out := make([]tocItemOut, 0, len(items))
	for _, it := range items {
		label := strings.TrimSpace(it.Label)
		if label == "" {
			// Drop unlabelled entries entirely — they'd render as blank
			// rows. Their children, if any, are promoted up so the
			// hierarchy degrades gracefully instead of orphaning content.
			out = append(out, remapTocChapterIDs(it.Children, chapterIDs, depth)...)
			continue
		}
		var mapped *string
		if it.ChapterID != nil {
			if id, ok := chapterIDs[*it.ChapterID]; ok {
				mapped = &id
			}
		}
		out = append(out, tocItemOut{
			Label:     label,
			ChapterID: mapped,
			Depth:     depth,
			Children:  remapTocChapterIDs(it.Children, chapterIDs, depth+1),
		})
	}
	return out
}

func nullStr(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
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

func strDeref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
