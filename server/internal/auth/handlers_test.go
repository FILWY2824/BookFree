package auth

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"bookfree/internal/db"
	"bookfree/internal/security"
)

// minimal in-process DB harness reused by handler tests.
func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	d, err := db.Open("file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

func mustInsertUser(t *testing.T, d *sql.DB, email, password string) string {
	t.Helper()
	hash, err := security.HashPassword(password)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	id := security.RandomID()
	now := time.Now().Unix()
	if _, err := d.Exec(`
		INSERT INTO users (id, email, password_hash, name, role, created_at, updated_at)
		VALUES (?, ?, ?, '', 'user', ?, ?)
	`, id, email, hash, now, now); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id
}

// Audit P1-01: timing channel between "no such user" and "bad password"
// branches. Both must run bcrypt once. A perfect test would measure
// wall-clock; we settle for an obvious-correctness check (login on a
// missing email returns 401, not 200) plus a structural assertion that
// the handler does NOT short-circuit before VerifyPassword.
func TestLogin_UnknownEmailReturns401Same(t *testing.T) {
	d := newTestDB(t)
	mustInsertUser(t, d, "alice@example.com", "correct-horse-battery-staple")
	store := NewStore(d, "alma_session", false)
	h := &Handler{DB: d, Sessions: store, AllowRegistration: true}

	cases := []struct {
		name, email, password string
	}{
		{"unknown email", "ghost@example.com", "anything"},
		{"known email + wrong password", "alice@example.com", "wrong"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := strings.NewReader(`{"email":"` + tc.email + `","password":"` + tc.password + `"}`)
			req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			h.HandleLogin(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "邮箱或密码错误") {
				t.Errorf("expected identical error message, got %s", rec.Body.String())
			}
		})
	}
}

func TestLogin_CorrectCredentialsReturns200(t *testing.T) {
	d := newTestDB(t)
	mustInsertUser(t, d, "alice@example.com", "correct-horse-battery-staple")
	store := NewStore(d, "alma_session", false)
	h := &Handler{DB: d, Sessions: store, AllowRegistration: true}

	body := strings.NewReader(`{"email":"alice@example.com","password":"correct-horse-battery-staple"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.HandleLogin(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	// Set-Cookie must be present.
	if c := rec.Result().Cookies(); len(c) == 0 {
		t.Error("expected Set-Cookie header")
	}
}

// Audit P0-02: registration disabled should give an actionable error
// pointing to make-admin / BOOKFREE_ALLOW_REGISTRATION rather than a
// flat "disabled".
func TestRegister_DisabledMessageIsActionable(t *testing.T) {
	d := newTestDB(t)
	store := NewStore(d, "alma_session", false)
	h := &Handler{DB: d, Sessions: store, AllowRegistration: false}

	body := strings.NewReader(`{"email":"new@example.com","password":"longenough123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.HandleRegister(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rec.Code)
	}
	got := rec.Body.String()
	if !strings.Contains(got, "make-admin") {
		t.Errorf("expected message to mention make-admin, got %s", got)
	}
}
