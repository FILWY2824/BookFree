package httpsrv

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
)

// SPAStaticHandler serves the Vite build output AND falls back to
// index.html for any path that isn't a real file. That fallback is
// what lets a hard refresh on /book/abc not 404 — the SPA router
// reads window.location and routes itself.
//
// Two source modes:
//
//	embedded — fs.FS handed in by main.go (//go:embed of webdist/)
//	disk     — diskRoot != "" overrides; useful in dev so the binary
//	           can pick up rebuilt assets without recompiling.
//
// /api/* paths must be routed BEFORE this handler; the router does
// that by registering specific patterns first.
type SPAStaticHandler struct {
	embedded fs.FS
	diskRoot string
}

func NewSPAStaticHandler(embedded fs.FS, diskRoot string) *SPAStaticHandler {
	return &SPAStaticHandler{embedded: embedded, diskRoot: diskRoot}
}

func (s *SPAStaticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Refuse anything that escapes the static root — defence in depth
	// against a malformed URL like "/../etc/passwd". http.FS already
	// does this, but doing it here lets us return a JSON 404 instead
	// of an html one for the /api-shaped paths users sometimes typo.
	clean := path.Clean(r.URL.Path)
	if strings.HasPrefix(clean, "/..") {
		http.NotFound(w, r)
		return
	}

	urlPath := strings.TrimPrefix(clean, "/")
	if urlPath == "" {
		urlPath = "index.html"
	}

	// 1. Real file? Serve it with content-type detection.
	if s.serveFile(w, r, urlPath) {
		return
	}

	// 2. Not found, and it looks like a static asset request — return
	// 404, NOT the SPA shell. Otherwise a missing /assets/foo.js would
	// silently render index.html with status 200 and the browser would
	// see HTML when it expected JS, blocking the whole app.
	if isLikelyAsset(urlPath) {
		http.NotFound(w, r)
		return
	}

	// 3. Fallback: hand back the SPA shell so client-side routing can
	// take over.
	if !s.serveFile(w, r, "index.html") {
		http.Error(w, "frontend not built — run `npm --prefix apps/web run build` and copy dist/* to server/webdist/", http.StatusNotFound)
	}
}

func (s *SPAStaticHandler) serveFile(w http.ResponseWriter, r *http.Request, p string) bool {
	if s.diskRoot != "" {
		full := path.Join(s.diskRoot, p)
		info, err := os.Stat(full)
		if err == nil && !info.IsDir() {
			setStaticHeaders(w, p)
			http.ServeFile(w, r, full)
			return true
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			// permission/io issue; treat as miss but log? — for now,
			// silent fallback keeps the user experience clean.
		}
	}
	if s.embedded != nil {
		f, err := s.embedded.Open(p)
		if err == nil {
			defer f.Close()
			info, err := f.Stat()
			if err == nil && !info.IsDir() {
				setStaticHeaders(w, p)
				http.ServeContent(w, r, p, info.ModTime(), readSeekerFromFS(f))
				return true
			}
		}
	}
	return false
}

// setStaticHeaders applies cache control: aggressive long-cache for
// fingerprinted assets (Vite emits foo.<hash>.js), no-cache for the
// shell so deploys are picked up immediately.
func setStaticHeaders(w http.ResponseWriter, p string) {
	if p == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
		return
	}
	if strings.HasPrefix(p, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
}

func isLikelyAsset(p string) bool {
	if strings.HasPrefix(p, "assets/") {
		return true
	}
	for _, ext := range []string{".js", ".css", ".map", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".json", ".wasm"} {
		if strings.HasSuffix(p, ext) {
			return true
		}
	}
	return false
}

// readSeekerFromFS adapts an fs.File to io.ReadSeeker if the embed
// FS supports seeking (it does for files). http.ServeContent NEEDS a
// seeker for Range support.
func readSeekerFromFS(f fs.File) interface {
	Read(p []byte) (n int, err error)
	Seek(offset int64, whence int) (int64, error)
} {
	if rs, ok := f.(interface {
		Read(p []byte) (n int, err error)
		Seek(offset int64, whence int) (int64, error)
	}); ok {
		return rs
	}
	// embed.FS files always implement ReadSeeker, so this branch is
	// effectively unreachable. Kept for explicitness.
	panic("static fs file does not implement Seek — embed.FS regression?")
}
