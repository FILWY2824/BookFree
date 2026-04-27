package auth

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"bookfree/internal/response"
	"bookfree/internal/security"
)

// Handler bundles the dependencies needed by the auth endpoints.
type Handler struct {
	DB                *sql.DB
	Sessions          *Store
	IsProd            bool
	AllowRegistration bool
	// TrustedClientIP, if non-nil, is consulted to extract the real
	// client IP from forwarded headers. When nil the handler falls back
	// to RemoteAddr — matching the legacy behaviour for direct deploys.
	TrustedClientIP func(*http.Request) string
}

// dummyBcryptHash is a real bcrypt hash of a fixed string. We feed it
// to bcrypt.CompareHashAndPassword on the "user not found" branch so
// the path takes the same wall-clock time as a genuine failed-login
// (audit P1-01: timing-side-channel account enumeration). The string
// hashed here doesn't matter — bcrypt's CPU cost is what we're paying
// for, not its correctness.
const dummyBcryptHash = "$2a$10$FEjaYx3W3qjMZh8MTZKF7Oj4.G50cb/T6ldzhHk4n3cJTs0kf2bZS"

type loginBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// HandleLogin → POST /api/auth/login
//
// Looks up by lowercased email, verifies bcrypt, issues a session, and
// sets the cookie. Identical wall-clock timing for "no such user" and
// "wrong password" branches — both run bcrypt once. (Audit P1-01.)
func (h *Handler) HandleLogin(w http.ResponseWriter, r *http.Request) {
	var body loginBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if email == "" || body.Password == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "邮箱与密码不能为空")
		return
	}

	row := h.DB.QueryRowContext(r.Context(),
		`SELECT id, password_hash, COALESCE(status, 'active') FROM users WHERE email = ? LIMIT 1`,
		email)
	var (
		id, hash, status string
		userFound        = true
	)
	if err := row.Scan(&id, &hash, &status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			userFound = false
			hash = dummyBcryptHash
		} else {
			response.FailSafe(w, "auth.login", err, http.StatusInternalServerError, h.IsProd)
			return
		}
	}

	// Always run bcrypt — even when userFound=false — so attackers can't
	// distinguish "no such user" from "wrong password" by wall-clock
	// timing. The result is discarded on the not-found branch.
	pwOK := security.VerifyPassword(body.Password, hash)
	if !userFound || !pwOK {
		response.Fail(w, http.StatusUnauthorized, response.CodeUnauthorized, "邮箱或密码错误")
		return
	}
	if status != "active" {
		response.Fail(w, http.StatusForbidden, response.CodeForbidden, "账号已停用")
		return
	}

	cv, expires, err := h.Sessions.Create(r.Context(), id, r.UserAgent(), h.clientAddr(r))
	if err != nil {
		response.FailSafe(w, "auth.login.session", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	h.Sessions.SetCookie(w, cv, expires)

	user, err := loadUser(r.Context(), h.DB, id)
	if err != nil {
		response.FailSafe(w, "auth.login.user", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	response.OK(w, map[string]any{"user": user})
}

// HandleLogout → POST /api/auth/logout
func (h *Handler) HandleLogout(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Cookie(h.Sessions.CookieName())
	if c != nil && c.Value != "" {
		_ = h.Sessions.Delete(r.Context(), c.Value)
	}
	h.Sessions.ClearCookie(w)
	response.OK(w, map[string]any{"loggedOut": true})
}

type registerBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

// HandleRegister → POST /api/auth/register
//
// Local password registration. Disabled by default in production; an
// operator who wants self-serve signup sets BOOKFREE_ALLOW_REGISTRATION=1
// or pre-creates accounts via `bookfree-server make-admin`. The error
// message points the user to the right escape hatch instead of just
// saying "disabled". (Audit P0-02.)
func (h *Handler) HandleRegister(w http.ResponseWriter, r *http.Request) {
	if !h.AllowRegistration {
		response.Fail(w, http.StatusForbidden, response.CodeForbidden,
			"自助注册已关闭。如需开通账号，请联系管理员（可在服务器上运行 `bookfree-server make-admin <邮箱>` 提升账号权限，或在环境变量中设置 BOOKFREE_ALLOW_REGISTRATION=1 后重启服务）。")
		return
	}
	var body registerBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if email == "" || !strings.Contains(email, "@") {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "邮箱格式不正确")
		return
	}
	if len(body.Password) < 8 {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "密码至少 8 位")
		return
	}

	hash, err := security.HashPassword(body.Password)
	if err != nil {
		response.FailSafe(w, "auth.register.hash", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	id := security.RandomID()
	now := time.Now().Unix()

	_, err = h.DB.ExecContext(r.Context(), `
		INSERT INTO users (id, email, password_hash, name, role, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'user', ?, ?)
	`, id, email, hash, strings.TrimSpace(body.Name), now, now)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") || strings.Contains(err.Error(), "unique") {
			response.Fail(w, http.StatusConflict, response.CodeConflict, "邮箱已被使用")
			return
		}
		response.FailSafe(w, "auth.register", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	cv, expires, err := h.Sessions.Create(r.Context(), id, r.UserAgent(), h.clientAddr(r))
	if err != nil {
		response.FailSafe(w, "auth.register.session", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	h.Sessions.SetCookie(w, cv, expires)

	user, err := loadUser(r.Context(), h.DB, id)
	if err != nil {
		response.FailSafe(w, "auth.register.user", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	response.Created(w, map[string]any{"user": user})
}

// HandleMe → GET /api/auth/me
func (h *Handler) HandleMe(w http.ResponseWriter, r *http.Request) {
	u := UserFromContext(r.Context())
	if u == nil {
		response.Fail(w, http.StatusUnauthorized, response.CodeUnauthorized, "未登录")
		return
	}
	response.OK(w, map[string]any{"user": u})
}

// clientAddr returns the user-facing IP. Uses TrustedClientIP (which
// validates X-Forwarded-For only when RemoteAddr is on a configured
// trusted proxy net) when present; falls back to RemoteAddr when the
// process is exposed directly. (Audit P1-03.)
func (h *Handler) clientAddr(r *http.Request) string {
	if h.TrustedClientIP != nil {
		if ip := h.TrustedClientIP(r); ip != "" {
			return ip
		}
	}
	return r.RemoteAddr
}
