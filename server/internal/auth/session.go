// Package auth handles cookie-backed sessions. The cookie format and
// `sessions` row layout match the Next.js project so users who are
// already logged in DO NOT get kicked out by the cutover.
//
// Cookie value:  "<session_id>.<raw_token>"
//                ^^^^^^^^^^^^ ^^^^^^^^^^^^
//                | 32 hex     | 43 base64url chars (32 bytes)
// We look up by id and verify the raw_token's sha256 against the
// stored token_hash — neither half alone is useful to an attacker who
// only sees one of the two columns.
package auth

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"bookfree/internal/models"
	"bookfree/internal/security"
)

const (
	// SessionTTL matches src/lib/auth/session.js: 30 days.
	SessionTTL = 30 * 24 * time.Hour
	// touchAfter caps last_seen_at writes to once per day to avoid
	// hammering the DB with UPDATEs on every request.
	touchAfter = 24 * time.Hour
)

type Store struct {
	db         *sql.DB
	cookieName string
	secure     bool
}

func NewStore(db *sql.DB, cookieName string, secure bool) *Store {
	return &Store{db: db, cookieName: cookieName, secure: secure}
}

// CookieName lets handlers use the configured name without poking at
// internals. Returned as-is for use in http.SetCookie / r.Cookie.
func (s *Store) CookieName() string { return s.cookieName }

// Create issues a new session, persists it, and returns the raw cookie
// value the caller should set.
func (s *Store) Create(ctx context.Context, userID, userAgent, ip string) (cookieValue string, expiresAt time.Time, err error) {
	id := security.RandomID()
	raw := security.RandomToken()
	hash := security.SHA256Hex(raw)
	now := time.Now()
	expires := now.Add(SessionTTL)

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, id, userID, hash, nullStr(userAgent), nullStr(ip), now.Unix(), now.Unix(), expires.Unix())
	if err != nil {
		return "", time.Time{}, err
	}
	return id + "." + raw, expires, nil
}

// Lookup validates a cookie value and returns the associated user.
// Returns (nil, nil) for missing/invalid/expired sessions — handlers
// turn that into 401, never 500.
func (s *Store) Lookup(ctx context.Context, cookieValue string) (*models.User, error) {
	id, raw, ok := splitCookie(cookieValue)
	if !ok {
		return nil, nil
	}
	expectedHash := security.SHA256Hex(raw)

	var (
		storedHash string
		userID     string
		expiresAt  int64
		lastSeen   int64
	)
	row := s.db.QueryRowContext(ctx, `
		SELECT token_hash, user_id, expires_at, last_seen_at
		FROM sessions WHERE id = ? LIMIT 1
	`, id)
	if err := row.Scan(&storedHash, &userID, &expiresAt, &lastSeen); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	// Constant-time compare. crypto/subtle would be ideal but a hex
	// string compare on equal-length values is fine here — both sides
	// are sha256 hex digests of length 64.
	if !secureEqual(storedHash, expectedHash) {
		return nil, nil
	}
	if time.Now().Unix() > expiresAt {
		// Garbage-collect expired session opportunistically. Errors here
		// are ignored — the next sweep will catch it.
		_, _ = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id)
		return nil, nil
	}

	user, err := loadUser(ctx, s.db, userID)
	if err != nil {
		return nil, err
	}
	if user == nil || !user.IsActive() {
		return nil, nil
	}

	// Touch last_seen_at at most once per touchAfter window.
	if time.Since(time.Unix(lastSeen, 0)) > touchAfter {
		_, _ = s.db.ExecContext(ctx, `UPDATE sessions SET last_seen_at = ? WHERE id = ?`, time.Now().Unix(), id)
	}

	return user, nil
}

// Delete removes a session by cookie value (used at logout).
func (s *Store) Delete(ctx context.Context, cookieValue string) error {
	id, _, ok := splitCookie(cookieValue)
	if !ok {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id)
	return err
}

// SetCookie writes the session cookie on the response.
func (s *Store) SetCookie(w http.ResponseWriter, cookieValue string, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName,
		Value:    cookieValue,
		Path:     "/",
		Expires:  expiresAt,
		MaxAge:   int(SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearCookie expires the cookie immediately on the client.
func (s *Store) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func loadUser(ctx context.Context, db *sql.DB, id string) (*models.User, error) {
	row := db.QueryRowContext(ctx, `
		SELECT id, email, name, avatar_url, role,
		       COALESCE(status, 'active'), oauth_provider, oauth_sub,
		       COALESCE(can_use_system_ai, 1),
		       created_at, updated_at
		FROM users WHERE id = ? LIMIT 1
	`, id)

	var (
		u           models.User
		avatar      sql.NullString
		oauthProv   sql.NullString
		oauthSub    sql.NullString
		canUseSysAI int64
	)
	if err := row.Scan(&u.ID, &u.Email, &u.Name, &avatar, &u.Role,
		&u.Status, &oauthProv, &oauthSub, &canUseSysAI,
		&u.CreatedAt, &u.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if avatar.Valid {
		u.AvatarURL = &avatar.String
	}
	if oauthProv.Valid {
		u.OAuthProvider = &oauthProv.String
	}
	if oauthSub.Valid {
		u.OAuthSub = &oauthSub.String
	}
	u.CanUseSystemAI = canUseSysAI != 0
	return &u, nil
}

func splitCookie(v string) (id, raw string, ok bool) {
	if v == "" {
		return "", "", false
	}
	dot := strings.IndexByte(v, '.')
	if dot <= 0 || dot == len(v)-1 {
		return "", "", false
	}
	return v[:dot], v[dot+1:], true
}

func secureEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
