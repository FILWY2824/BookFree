package auth

import (
	"context"
	"net/http"

	"bookfree/internal/models"
	"bookfree/internal/response"
)

type ctxKey struct{}

var userCtxKey = ctxKey{}

// WithUser stores the resolved user on the request context. The
// session loader middleware calls this; everything downstream that
// needs the user calls UserFromContext().
func WithUser(parent context.Context, u *models.User) context.Context {
	return context.WithValue(parent, userCtxKey, u)
}

// UserFromContext returns the resolved user, or nil if the request is
// anonymous. RequireUser/RequireAdmin should be used in front of
// handlers that demand authentication; this getter exists for
// optional-auth paths.
func UserFromContext(ctx context.Context) *models.User {
	u, _ := ctx.Value(userCtxKey).(*models.User)
	return u
}

// LoadSession is a middleware that resolves the cookie into a user
// and stuffs it on the context. It NEVER short-circuits on its own —
// guard middleware like RequireUser does that. This split lets a
// future logged-out variant of `/api/health` work without surgery.
func LoadSession(s *Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie(s.CookieName())
			if err != nil || c.Value == "" {
				next.ServeHTTP(w, r)
				return
			}
			user, err := s.Lookup(r.Context(), c.Value)
			if err != nil {
				// DB error during lookup. We do NOT 500 the whole
				// request — the caller might be hitting a public
				// endpoint. Strip the cookie and continue anonymous.
				next.ServeHTTP(w, r)
				return
			}
			if user != nil {
				r = r.WithContext(WithUser(r.Context(), user))
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireUser short-circuits anonymous requests with 401.
func RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserFromContext(r.Context()) == nil {
			response.Fail(w, http.StatusUnauthorized, response.CodeUnauthorized, "请先登录")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAdmin layers on top of RequireUser to enforce role=admin.
func RequireAdmin(next http.Handler) http.Handler {
	return RequireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := UserFromContext(r.Context())
		if !u.IsAdmin() {
			response.Fail(w, http.StatusForbidden, response.CodeForbidden, "需要管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	}))
}
