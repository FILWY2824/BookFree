package ingest

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"bookfree/internal/auth"
	"bookfree/internal/db"
	"bookfree/internal/models"
	"bookfree/internal/security"
)

func newIngestTestDB(t *testing.T) *sql.DB {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "bookfree-test.db")
	d, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.Migrate(ctx, d); err != nil {
		_ = d.Close()
		t.Fatalf("migrate: %v", err)
	}

	t.Cleanup(func() { _ = d.Close() })
	return d
}

func insertIngestTestUser(t *testing.T, d *sql.DB) *models.User {
	t.Helper()

	now := time.Now().Unix()
	u := &models.User{
		ID:        security.RandomID(),
		Email:     "reader-" + security.RandomID() + "@example.com",
		Name:      "Reader",
		Role:      "user",
		Status:    "active",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if _, err := d.Exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, u.ID, u.Email, "test-only", u.Name, u.Role, now, now); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return u
}

func insertIngestTestBook(t *testing.T, d *sql.DB, userID, format string) string {
	t.Helper()

	id := security.RandomID()
	now := time.Now().Unix()
	if _, err := d.Exec(`
		INSERT INTO books (id, user_id, title, authors, format, size_bytes, status, created_at, updated_at)
		VALUES (?, ?, ?, '[]', ?, 123, 'uploaded', ?, ?)
	`, id, userID, strings.ToUpper(format)+" fixture", format, now, now); err != nil {
		t.Fatalf("insert book: %v", err)
	}
	return id
}

func postIngest(t *testing.T, h *Handler, user *models.User, bookID, body string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, "/api/books/"+bookID+"/ingest", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", bookID)
	req = req.WithContext(auth.WithUser(req.Context(), user))

	rec := httptest.NewRecorder()
	h.HandlePost(rec, req)
	return rec
}

func TestHandlePost_AllowsEmptyPDFIngest(t *testing.T) {
	d := newIngestTestDB(t)
	user := insertIngestTestUser(t, d)
	bookID := insertIngestTestBook(t, d, user.ID, "pdf")

	h := &Handler{DB: d}
	rec := postIngest(t, h, user, bookID, `{"title":"PDF fixture","chapters":[],"chunks":[]}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var status string
	if err := d.QueryRow(`SELECT status FROM books WHERE id = ?`, bookID).Scan(&status); err != nil {
		t.Fatalf("query status: %v", err)
	}
	if status != "ready" {
		t.Fatalf("expected status ready, got %q", status)
	}
}

func TestHandlePost_RejectsEmptyTextIngest(t *testing.T) {
	d := newIngestTestDB(t)
	user := insertIngestTestUser(t, d)
	bookID := insertIngestTestBook(t, d, user.ID, "txt")

	h := &Handler{DB: d}
	rec := postIngest(t, h, user, bookID, `{"title":"TXT fixture","chapters":[],"chunks":[]}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	var status string
	if err := d.QueryRow(`SELECT status FROM books WHERE id = ?`, bookID).Scan(&status); err != nil {
		t.Fatalf("query status: %v", err)
	}
	if status != "uploaded" {
		t.Fatalf("expected status to remain uploaded, got %q", status)
	}
}

func TestHandlePost_ScopesClientIDsPerBook(t *testing.T) {
	d := newIngestTestDB(t)
	user := insertIngestTestUser(t, d)
	firstBookID := insertIngestTestBook(t, d, user.ID, "txt")
	secondBookID := insertIngestTestBook(t, d, user.ID, "txt")

	h := &Handler{DB: d}
	body := `{
		"title":"TXT fixture",
		"chapters":[{"id":"chapter-1","ord":0,"title":"第一章","text":"hello world"}],
		"chunks":[{"id":"chunk-1","chapterId":"chapter-1","ord":0,"text":"hello world"}]
	}`

	first := postIngest(t, h, user, firstBookID, body)
	if first.Code != http.StatusOK {
		t.Fatalf("expected first ingest 200, got %d body=%s", first.Code, first.Body.String())
	}
	second := postIngest(t, h, user, secondBookID, body)
	if second.Code != http.StatusOK {
		t.Fatalf("expected second ingest 200, got %d body=%s", second.Code, second.Body.String())
	}

	var chapterCount int
	if err := d.QueryRow(`SELECT COUNT(*) FROM book_chapters WHERE id = 'chapter-1'`).Scan(&chapterCount); err != nil {
		t.Fatalf("count raw chapter ids: %v", err)
	}
	if chapterCount != 0 {
		t.Fatalf("expected raw client chapter id not to be stored globally, got %d", chapterCount)
	}

	var chunkCount int
	if err := d.QueryRow(`SELECT COUNT(*) FROM book_chunks WHERE id = 'chunk-1'`).Scan(&chunkCount); err != nil {
		t.Fatalf("count raw chunk ids: %v", err)
	}
	if chunkCount != 0 {
		t.Fatalf("expected raw client chunk id not to be stored globally, got %d", chunkCount)
	}

	for _, bookID := range []string{firstBookID, secondBookID} {
		var status string
		if err := d.QueryRow(`SELECT status FROM books WHERE id = ?`, bookID).Scan(&status); err != nil {
			t.Fatalf("query status for %s: %v", bookID, err)
		}
		if status != "ready" {
			t.Fatalf("expected book %s status ready, got %q", bookID, status)
		}

		var storedChapterID, storedChunkChapterID string
		if err := d.QueryRow(`
			SELECT ch.id, ck.chapter_id
			FROM book_chapters ch
			JOIN book_chunks ck ON ck.book_id = ch.book_id
			WHERE ch.book_id = ?
			LIMIT 1
		`, bookID).Scan(&storedChapterID, &storedChunkChapterID); err != nil {
			t.Fatalf("query scoped ids for %s: %v", bookID, err)
		}
		if storedChapterID != bookID+":chapter:chapter-1" {
			t.Fatalf("expected scoped chapter id for %s, got %q", bookID, storedChapterID)
		}
		if storedChunkChapterID != storedChapterID {
			t.Fatalf("expected chunk chapter_id %q, got %q", storedChapterID, storedChunkChapterID)
		}
	}
}
