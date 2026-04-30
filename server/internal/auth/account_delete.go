// 中文导读：
// account_delete.go 负责账号删除相关逻辑。
// 删除账号不是简单删 users 表一行，因为还可能有关联书籍、笔记、进度、AI 会话、上传文件等数据。
// 实现时要保证数据库记录和文件存储尽量一致，避免删除一半失败后留下孤儿数据。
// 这是高风险操作，前端必须有确认流程，后端也要检查当前登录用户权限。

// Account deletion handler. The path is DELETE /api/auth/me — a
// logged-in user wipes their own account. Mirrors the "right to be
// forgotten" expectation and gives the user a button to remove all
// trace of themselves without admin involvement.
//
// Why this lives in auth/ rather than accounts/:
//   The handler talks to session cookies (we have to clear the
//   user's session immediately after deletion, otherwise the
//   browser would carry an invalid token until expiry) — that's
//   inherently auth's territory. The actual cascade work delegates
//   to the accounts package, which is where DB+storage cleanup is
//   centralised.
//
// Confirmation:
//   The destructive action requires the request body to carry the
//   user's current password — same idea as a "type your password to
//   continue" check. A leaked session cookie alone shouldn't be
//   enough to nuke the account. We use bcrypt.CompareHashAndPassword
//   the same way HandleLogin does, including the dummy-bcrypt path
//   if the password row is somehow missing (defence-in-depth: don't
//   leak whether the password row exists).

package auth

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"bookfree/internal/accounts"
	"bookfree/internal/response"
	"bookfree/internal/storage"

	"golang.org/x/crypto/bcrypt"
)

// AccountHandler is the per-handler dependency bundle. We keep it
// separate from the main auth.Handler because it needs the storage
// driver, which the main one doesn't.
type AccountHandler struct {
	DB       *sql.DB
	Sessions *Store
	Storage  storage.Storage
	IsProd   bool
}

type deleteAccountBody struct {
	Password string `json:"password"`
}

// HandleDeleteSelf → DELETE /api/auth/me
//
// 1. Verify the supplied password against the user's own bcrypt hash.
// 2. Delegate to accounts.DeleteUser (DB cascade + file/dir cleanup).
// 3. Clear the session cookie + revoke server-side session(s).
func (h *AccountHandler) HandleDeleteSelf(w http.ResponseWriter, r *http.Request) {
	user := UserFromContext(r.Context())
	if user == nil {
		response.Fail(w, http.StatusUnauthorized, response.CodeUnauthorized, "未登录")
		return
	}

	var body deleteAccountBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&body); err != nil || body.Password == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "需要提供密码以确认删除")
		return
	}

	var pwdHash string
	err := h.DB.QueryRowContext(r.Context(),
		`SELECT password_hash FROM users WHERE id = ? LIMIT 1`,
		user.ID).Scan(&pwdHash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// Burn the same wall-clock time as a real verify before
			// rejecting, so a deleted-account race can't be probed
			// for via response timing.
			_ = bcrypt.CompareHashAndPassword([]byte(dummyBcryptHash), []byte(body.Password))
			response.Fail(w, http.StatusUnauthorized, response.CodeUnauthorized, "密码不正确")
			return
		}
		response.FailSafe(w, "account.delete.lookup", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(pwdHash), []byte(body.Password)); err != nil {
		response.Fail(w, http.StatusUnauthorized, response.CodeUnauthorized, "密码不正确")
		return
	}

	if err := accounts.DeleteUser(r.Context(), h.DB, h.Storage, user.ID); err != nil {
		if errors.Is(err, accounts.ErrNotFound) {
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "账户不存在")
			return
		}
		response.FailSafe(w, "account.delete", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// Tear down the cookie. The DELETE FROM users cascade already
	// removed any session rows that referenced the user, so the
	// server-side session is gone; this just stops the browser from
	// re-presenting the now-invalid cookie.
	h.Sessions.ClearCookie(w)
	response.OK(w, map[string]any{"deleted": true})
}
