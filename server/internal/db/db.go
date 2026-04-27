// Package db wraps *sql.DB with the sqlite-specific PRAGMAs and
// connection-pool tuning we want for a low-memory single-binary
// deployment.
package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"time"

	// mattn/go-sqlite3 wraps the real libsqlite3 via CGO.
	_ "github.com/mattn/go-sqlite3"
)

// Open returns a *sql.DB pointed at the given URL.
//
// IMPORTANT (audit P0-04): all connection-level PRAGMAs (foreign_keys,
// busy_timeout, journal_mode, synchronous, …) are encoded into the DSN
// query string. mattn/go-sqlite3 then runs them on EVERY new connection
// it opens — not just the first one. The previous implementation ran
// PRAGMAs via db.ExecContext() against the pool, which only guaranteed
// they took effect on the connection that happened to be checked out at
// the time. With MaxOpenConns=2 that meant one of the two pooled
// connections silently had foreign_keys = OFF, and DELETE FROM books
// could leave orphan rows in book_assets / book_chunks / etc.
func Open(rawURL string) (*sql.DB, error) {
	dsn, err := buildDSN(rawURL)
	if err != nil {
		return nil, err
	}

	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	// Aggressive connection limits. SQLite has a single writer regardless
	// of pool size, and every connection holds its own statement cache.
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(5 * time.Minute)

	// Validate the DSN by forcing one connection through. If something
	// in the PRAGMA chain is malformed, mattn/go-sqlite3 surfaces the
	// error here — much more debuggable than a 500 at first query time.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return db, nil
}

// buildDSN turns a user-supplied URL into a mattn/go-sqlite3 DSN that
// applies our standard PRAGMA set on every connection.
func buildDSN(rawURL string) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", fmt.Errorf("db: empty URL")
	}
	if strings.HasPrefix(rawURL, "libsql://") || strings.HasPrefix(rawURL, "https://") {
		return "", fmt.Errorf("db: remote libsql URL %q not supported by this build", rawURL)
	}

	path := strings.TrimPrefix(rawURL, "file:")

	var userParams url.Values
	if i := strings.IndexByte(path, '?'); i >= 0 {
		var err error
		userParams, err = url.ParseQuery(path[i+1:])
		if err != nil {
			return "", fmt.Errorf("db: parse url params: %w", err)
		}
		path = path[:i]
	} else {
		userParams = url.Values{}
	}

	// mattn/go-sqlite3's underscore-prefixed connection-init pragmas:
	// applied on every new connection by the driver itself.
	defaults := map[string]string{
		"_foreign_keys": "on",
		"_busy_timeout": "5000",
		"_journal_mode": "WAL",
		"_synchronous":  "NORMAL",
		"_cache_size":   "-2048", // 2 MiB
		"_temp_store":   "MEMORY",
	}
	for k, v := range defaults {
		if !userParams.Has(k) {
			userParams.Set(k, v)
		}
	}

	return path + "?" + userParams.Encode(), nil
}
