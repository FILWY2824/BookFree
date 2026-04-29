package httpsrv

import (
	"database/sql"
	"io/fs"
	"net"
	"net/http"
	"time"

	"bookfree/internal/ai"
	"bookfree/internal/auth"
	"bookfree/internal/books"
	"bookfree/internal/chapters"
	"bookfree/internal/health"
	"bookfree/internal/ingest"
	"bookfree/internal/notes"
	"bookfree/internal/progress"
	"bookfree/internal/response"
	searchapi "bookfree/internal/search"
	"bookfree/internal/security"
	"bookfree/internal/storage"
)

// RouterDeps groups every dependency the handlers need.
type RouterDeps struct {
	DB                *sql.DB
	Storage           storage.Storage
	Sessions          *auth.Store
	KeyDeriver        *security.KeyDeriver
	IsProd            bool
	Version           string
	StartedAt         time.Time
	WebDistFS         fs.FS
	WebDistDir        string
	MaxUploadMB       int
	AllowRegistration bool
	// TrustedProxies — CIDRs / IPs allowed to inject XFF / X-Real-IP.
	// When empty (the default for direct-exposed deployments) those
	// headers are ignored entirely.
	TrustedProxies []*net.IPNet
}

// New builds the application's http.Handler.
//
// Middleware chain (outer → inner):
//
//	requestID  →  recover  →  secureHeaders  →  accessLog  →  loadSession  →  mux
//
// Per-route extras:
//
//	auth.RequireUser  for every /api/* path that touches user data.
//	RateLimit         for login / register / upload / ingest.
func New(deps RouterDeps) http.Handler {
	mux := http.NewServeMux()

	resolveIP := TrustedProxyResolver(deps.TrustedProxies)

	// ── Health (anonymous) ────────────────────────────────────────
	hh := &health.Handler{
		DB:        deps.DB,
		StartedAt: deps.StartedAt,
		Version:   deps.Version,
		Deriver:   deps.KeyDeriver,
	}
	mux.HandleFunc("GET /api/health", hh.HandleGet)

	// ── Auth (mostly anonymous) ───────────────────────────────────
	ah := &auth.Handler{
		DB:                deps.DB,
		Sessions:          deps.Sessions,
		IsProd:            deps.IsProd,
		AllowRegistration: deps.AllowRegistration,
		TrustedClientIP:   resolveIP,
	}

	// Rate limits per audit P1-02:
	//   login    20 / minute / IP   (bcrypt is expensive; an attacker
	//                                 trying to brute-force will hit this
	//                                 long before any account is in danger)
	//   register 5  / 10min / IP    (signup spam)
	//   upload   30 / minute / IP   (storage / disk pressure backstop)
	//   ingest   60 / minute / IP   (reasonable for a real reader's
	//                                 first-load workflow that ingests a
	//                                 handful of just-uploaded books)
	loginLimit := RateLimit(20, time.Minute, IPKey(resolveIP))
	registerLimit := RateLimit(5, 10*time.Minute, IPKey(resolveIP))
	uploadLimit := RateLimit(30, time.Minute, IPKey(resolveIP))
	ingestLimit := RateLimit(60, time.Minute, IPKey(resolveIP))

	mux.Handle("POST /api/auth/login", loginLimit(http.HandlerFunc(ah.HandleLogin)))
	mux.HandleFunc("POST /api/auth/logout", ah.HandleLogout)
	mux.Handle("POST /api/auth/register", registerLimit(http.HandlerFunc(ah.HandleRegister)))
	mux.HandleFunc("GET /api/auth/me", ah.HandleMe)

	// Account self-delete — DELETE /api/auth/me. Requires the user's
	// password in the request body. Routes through the accounts pkg
	// to ensure DB rows AND on-disk files are wiped (covering the
	// "fragments left behind" issue we hit on book deletion).
	accountH := &auth.AccountHandler{
		DB:       deps.DB,
		Sessions: deps.Sessions,
		Storage:  deps.Storage,
		IsProd:   deps.IsProd,
	}
	mux.Handle("DELETE /api/auth/me",
		auth.RequireUser(http.HandlerFunc(accountH.HandleDeleteSelf)))

	// ── Books (require auth) ──────────────────────────────────────
	bh := &books.Handler{
		DB:          deps.DB,
		Storage:     deps.Storage,
		IsProd:      deps.IsProd,
		MaxUploadMB: deps.MaxUploadMB,
	}
	mux.Handle("GET /api/books", auth.RequireUser(http.HandlerFunc(bh.HandleList)))
	mux.Handle("GET /api/books/{id}", auth.RequireUser(http.HandlerFunc(bh.HandleGet)))
	mux.Handle("DELETE /api/books/{id}", auth.RequireUser(http.HandlerFunc(bh.HandleDelete)))
	mux.Handle("GET /api/books/{id}/file", auth.RequireUser(http.HandlerFunc(bh.HandleFile)))
	mux.Handle("PUT /api/books/upload", uploadLimit(auth.RequireUser(http.HandlerFunc(bh.HandleUpload))))
	mux.Handle("POST /api/books/upload", uploadLimit(auth.RequireUser(http.HandlerFunc(bh.HandleUpload))))

	// ── Ingest (client-side parser callback) ──────────────────────
	ih := &ingest.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("POST /api/books/{id}/ingest", ingestLimit(auth.RequireUser(http.HandlerFunc(ih.HandlePost))))
	mux.Handle("POST /api/books/{id}/ingest/fail", auth.RequireUser(http.HandlerFunc(ih.HandleFail)))

	// ── Chapters ──────────────────────────────────────────────────
	ch := &chapters.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("GET /api/books/{id}/chapters/list", auth.RequireUser(http.HandlerFunc(ch.HandleList)))
	mux.Handle("GET /api/books/{id}/chapters/{chapterId}", auth.RequireUser(http.HandlerFunc(ch.HandleGet)))
	mux.Handle("GET /api/books/{id}/toc", auth.RequireUser(http.HandlerFunc(ch.HandleTOC)))

	// ── Progress ──────────────────────────────────────────────────
	ph := &progress.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("GET /api/books/{id}/progress", auth.RequireUser(http.HandlerFunc(ph.HandleGet)))
	mux.Handle("PUT /api/books/{id}/progress", auth.RequireUser(http.HandlerFunc(ph.HandlePut)))

	// ── Notes / Highlights ────────────────────────────────────────
	nh := &notes.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("GET /api/books/{id}/highlights", auth.RequireUser(http.HandlerFunc(nh.HandleListHighlights)))
	mux.Handle("POST /api/books/{id}/highlights", auth.RequireUser(http.HandlerFunc(nh.HandleCreateHighlight)))
	mux.Handle("DELETE /api/highlights/{id}", auth.RequireUser(http.HandlerFunc(nh.HandleDeleteHighlight)))
	mux.Handle("GET /api/books/{id}/notes", auth.RequireUser(http.HandlerFunc(nh.HandleListNotes)))
	mux.Handle("POST /api/books/{id}/notes", auth.RequireUser(http.HandlerFunc(nh.HandleCreateNote)))
	mux.Handle("PUT /api/notes/{id}", auth.RequireUser(http.HandlerFunc(nh.HandleUpdateNote)))
	mux.Handle("DELETE /api/notes/{id}", auth.RequireUser(http.HandlerFunc(nh.HandleDeleteNote)))
	mux.Handle("GET /api/notes", auth.RequireUser(http.HandlerFunc(nh.HandleListAllNotes)))
	mux.Handle("GET /api/highlights", auth.RequireUser(http.HandlerFunc(nh.HandleListAllHighlights)))

	// ── Search ────────────────────────────────────────────────────
	sh := &searchapi.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("GET /api/search", auth.RequireUser(http.HandlerFunc(sh.HandleSearch)))

	// ── AI chat ────────────────────────────────────────────────────
	// Server-side proxy. Built-in path uses ANTHROPIC_API_KEY (with
	// per-user quota + rate limit). Custom-provider path uses the
	// user's OpenAI-compatible profile.
	aih := &ai.Handler{DB: deps.DB, IsProd: deps.IsProd, KeyDeriver: deps.KeyDeriver}
	mux.Handle("GET /api/ai/status", auth.RequireUser(http.HandlerFunc(aih.HandleStatus)))
	mux.Handle("POST /api/ai/chat", auth.RequireUser(http.HandlerFunc(aih.HandleChat)))
	mux.Handle("POST /api/ai/test", auth.RequireUser(http.HandlerFunc(aih.HandleTest)))
	mux.Handle("GET /api/ai/providers", auth.RequireUser(http.HandlerFunc(aih.HandleListProviders)))
	mux.Handle("POST /api/ai/providers", auth.RequireUser(http.HandlerFunc(aih.HandleCreateProvider)))
	mux.Handle("PUT /api/ai/providers/{id}", auth.RequireUser(http.HandlerFunc(aih.HandleUpdateProvider)))
	mux.Handle("DELETE /api/ai/providers/{id}", auth.RequireUser(http.HandlerFunc(aih.HandleDeleteProvider)))
	mux.Handle("GET /api/ai/providers/{id}/models", auth.RequireUser(http.HandlerFunc(aih.HandleListProviderModels)))
	mux.Handle("GET /api/ai/limits", auth.RequireUser(http.HandlerFunc(aih.HandleGetLimits)))
	mux.Handle("PUT /api/ai/limits", auth.RequireAdmin(http.HandlerFunc(aih.HandleSetLimits)))

	// ── /api/* catch-all → 404 JSON instead of HTML ───────────────
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound,
			"未知 API 路由："+r.Method+" "+r.URL.Path)
	})

	// ── SPA static fallback ───────────────────────────────────────
	mux.Handle("/", NewSPAStaticHandler(deps.WebDistFS, deps.WebDistDir))

	return chain(mux,
		requestIDMiddleware,
		recoverMiddleware(deps.IsProd),
		secureHeadersMiddleware,
		accessLogMiddleware(resolveIP),
		auth.LoadSession(deps.Sessions),
	)
}
