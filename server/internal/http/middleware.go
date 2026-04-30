// 中文导读：
// middleware.go 放 HTTP 中间件。
// 中间件可以理解为“请求进入具体 handler 前后统一执行的一层包装”。
// 常见职责包括：请求日志、panic 恢复、安全头、CORS、请求大小限制、真实 IP 识别等。
// 把这些逻辑放中间件，可以避免每个业务 handler 重复写。
// 修改中间件要谨慎，因为它会影响所有 API 和静态资源请求。

// Package httpsrv contains the HTTP server, router glue, and the
// generic middlewares that wrap every handler (request id, panic
// recovery, security headers, access log).
//
// We deliberately keep the chain short: each middleware is exactly
// one file, and the binding order is encoded in router.go. Any new
// middleware added later should justify itself against a measurable
// problem — an empty `next.ServeHTTP` adds nanoseconds, but a chain
// of fifteen of them adds RSS too because of closure capture.
package httpsrv

import (
	"context"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"bookfree/internal/logger"
	"bookfree/internal/response"
	"bookfree/internal/security"
)

type ctxRequestIDKey struct{}

func reqIDKey() ctxRequestIDKey { return ctxRequestIDKey{} }

// RequestIDFromContext returns the inbound request id assigned by
// requestIDMiddleware. Used by handlers that emit logs of their own.
func RequestIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(reqIDKey()).(string)
	return v
}

func requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Honor an inbound X-Request-Id from a trusted reverse proxy if
		// it looks reasonable; otherwise mint a fresh one. We restrict
		// the accepted charset (audit P2-04) so the id can be safely
		// embedded in JSON log lines and trace headers without escaping.
		id := r.Header.Get("X-Request-Id")
		if !validRequestID(id) {
			id = security.RandomID()
		}
		ctx := context.WithValue(r.Context(), reqIDKey(), id)
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// validRequestID restricts an incoming X-Request-Id to a safe charset
// and length so we can embed it in logs and headers verbatim. Allowed:
// A-Z a-z 0-9 . _ - ; length 1..64.
func validRequestID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'A' && c <= 'Z':
		case c >= 'a' && c <= 'z':
		case c >= '0' && c <= '9':
		case c == '.' || c == '_' || c == '-':
		default:
			return false
		}
	}
	return true
}

func secureHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		// CSP (audit P2-03). We allow:
		//   - inline styles (Tailwind's preflight + injected style tags)
		//   - blob: workers (pdf.js / epub.js spawn worker URLs from blobs)
		//   - data: images (cover thumbnails, EPUB-extracted icons)
		//   - jsdelivr CDN (LXGW WenKai webfont, optional pdf.js worker
		//     fallback). Tighten further if your deploy doesn't need
		//     these.
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net; "+
				"worker-src 'self' blob:; "+
				"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "+
				"font-src 'self' data: https://cdn.jsdelivr.net; "+
				"img-src 'self' data: blob:; "+
				"connect-src 'self'; "+
				"object-src 'none'; "+
				"base-uri 'self'; "+
				"frame-ancestors 'none'")
		// HSTS only when we know we're served over HTTPS — we infer
		// that from the proxy header, which the trusted-proxy chain
		// has already validated (otherwise it's stripped).
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// recoverMiddleware turns panics into a 500 response without crashing
// the whole server. It also logs the panic with the request id so an
// operator can correlate.
func recoverMiddleware(isProd bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					id := RequestIDFromContext(r.Context())
					logger.Error("http.panic", logger.Fields{
						"requestId": id,
						"panic":     rec,
						"path":      r.URL.Path,
						"method":    r.Method,
					})
					// Do NOT leak panic strings in prod — the panic
					// might contain stack-frame snippets that include
					// secrets caught in argument values.
					if isProd {
						response.Fail(w, http.StatusInternalServerError, response.CodeInternal, "服务器内部错误")
					} else {
						response.Fail(w, http.StatusInternalServerError, response.CodeInternal, "panic during request")
					}
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// accessLogMiddleware emits one structured log line per request.
// It uses a thin ResponseWriter wrapper to capture the status without
// buffering the body — body buffering would defeat the streaming
// upload/SSE paths.
type loggedWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	bytes       int64
}

func (lw *loggedWriter) WriteHeader(status int) {
	if !lw.wroteHeader {
		lw.status = status
		lw.wroteHeader = true
	}
	lw.ResponseWriter.WriteHeader(status)
}

func (lw *loggedWriter) Write(b []byte) (int, error) {
	if !lw.wroteHeader {
		lw.status = http.StatusOK
		lw.wroteHeader = true
	}
	n, err := lw.ResponseWriter.Write(b)
	atomic.AddInt64(&lw.bytes, int64(n))
	return n, err
}

// Flush is required by SSE handlers — without it the http.Flusher
// type-assertion they do would fail and the stream would buffer.
func (lw *loggedWriter) Flush() {
	if f, ok := lw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func accessLogMiddleware(resolveIP func(*http.Request) string) func(http.Handler) http.Handler {
	if resolveIP == nil {
		resolveIP = func(r *http.Request) string { return r.RemoteAddr }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			lw := &loggedWriter{ResponseWriter: w}
			next.ServeHTTP(lw, r)
			logger.Info("http.access", logger.Fields{
				"requestId": RequestIDFromContext(r.Context()),
				"method":    r.Method,
				"path":      r.URL.Path,
				"status":    lw.status,
				"bytes":     atomic.LoadInt64(&lw.bytes),
				"durMs":     time.Since(start).Milliseconds(),
				"ip":        resolveIP(r),
			})
		})
	}
}

// (clientIP removed — IP extraction now lives in TrustedProxyResolver,
// which only honours X-Forwarded-For when the immediate peer is a
// configured trusted proxy. See trusted_proxy.go.)

// chain is a tiny composition helper. mux.Handle("/x", chain(h, m1, m2))
// applies m1 first, then m2, then h. Order matters: see router.go.
func chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// MaxBodySize enforces a per-request body size cap. Used on the
// upload route as the second line of defence after the
// Content-Length pre-check; on every other route as a sanity cap
// to stop a malicious client streaming a 10 GB JSON body.
//
// The maxBytes value should match BOOKFREE_MAX_UPLOAD_SIZE_MB on the
// upload route; smaller (e.g. 1 MiB) on regular JSON routes.
func MaxBodySize(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > maxBytes {
				response.Fail(w, http.StatusRequestEntityTooLarge,
					response.CodeValidation,
					"请求体过大（上限 "+strconv.FormatInt(maxBytes/1024/1024, 10)+" MB）")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}
