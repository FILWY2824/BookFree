package db

import (
	"net/url"
	"strings"
	"testing"
)

// Audit P0-04 regression: connection-level PRAGMAs must be encoded
// into the DSN so every pooled connection picks them up. If the DSN
// drops _foreign_keys, mattn/go-sqlite3 falls back to OFF and DELETE
// FROM books leaks orphans.
func TestBuildDSN_DefaultsArePresent(t *testing.T) {
	dsn, err := buildDSN("file:./data/bookfree.db")
	if err != nil {
		t.Fatalf("buildDSN: %v", err)
	}
	if !strings.HasPrefix(dsn, "./data/bookfree.db?") {
		t.Errorf("expected path prefix preserved, got %q", dsn)
	}
	q, err := url.ParseQuery(dsn[strings.IndexByte(dsn, '?')+1:])
	if err != nil {
		t.Fatalf("parse query: %v", err)
	}
	cases := map[string]string{
		"_foreign_keys": "on",
		"_busy_timeout": "5000",
		"_journal_mode": "WAL",
		"_synchronous":  "NORMAL",
		"_cache_size":   "-2048",
		"_temp_store":   "MEMORY",
	}
	for k, want := range cases {
		if got := q.Get(k); got != want {
			t.Errorf("PRAGMA %q: got %q, want %q", k, got, want)
		}
	}
}

func TestBuildDSN_UserParamsOverride(t *testing.T) {
	// Operator overrides journal_mode=DELETE for an SD-card filesystem
	// that lacks atomic rename. The default WAL must yield to the
	// explicit value.
	dsn, err := buildDSN("file:./data/bookfree.db?_journal_mode=DELETE")
	if err != nil {
		t.Fatalf("buildDSN: %v", err)
	}
	q, _ := url.ParseQuery(dsn[strings.IndexByte(dsn, '?')+1:])
	if got := q.Get("_journal_mode"); got != "DELETE" {
		t.Errorf("user override ignored: got _journal_mode=%q", got)
	}
	// Other defaults must remain.
	if got := q.Get("_foreign_keys"); got != "on" {
		t.Errorf("default _foreign_keys lost: got %q", got)
	}
}

func TestBuildDSN_RejectsLibsql(t *testing.T) {
	if _, err := buildDSN("libsql://example.turso.io"); err == nil {
		t.Error("expected error for libsql URL")
	}
}

func TestBuildDSN_RejectsEmpty(t *testing.T) {
	if _, err := buildDSN(""); err == nil {
		t.Error("expected error for empty URL")
	}
	if _, err := buildDSN("   "); err == nil {
		t.Error("expected error for whitespace-only URL")
	}
}
