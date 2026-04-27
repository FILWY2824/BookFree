// Package webdist holds the embedded SPA bundle. The actual files
// live in server/webdist/ and are produced by `npm run build` in
// apps/web. We expose them via go:embed here so the binary is fully
// self-contained.
//
// To rebuild the bundle:
//
//	cd apps/web && npm run build && cp -r dist/* ../../server/webdist/
//
// During development you can skip embedding entirely by setting
// BOOKFREE_WEBDIST_DIR=apps/web/dist, which makes the static handler
// read from disk instead.
package webdist

import (
	"embed"
	"io/fs"
)

//go:embed all:assets all:index.html all:robots.txt
var embedded embed.FS

// Has returns true if any files were embedded. When the SPA hasn't
// been built yet (fresh checkout), the embed contains only this
// package itself and we want the handler to show a friendly error
// instead of a half-broken site.
func Has() bool {
	if _, err := embedded.ReadFile("index.html"); err == nil {
		return true
	}
	return false
}

// FS returns the embedded files. May be empty if the SPA hasn't
// been built yet — callers should prefer the disk override in that
// case.
func FS() fs.FS { return embedded }
