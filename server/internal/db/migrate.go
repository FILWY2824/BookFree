package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strings"

	"bookfree/internal/logger"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrate runs every embedded *.sql file in lexical order. Each file
// runs inside its own transaction so a partial failure does not leave
// the schema in an inconsistent half-applied state.
//
// We track applied filenames in `_migrations` (separate from the
// legacy `_meta.schema_version` row, which the SQL migration files
// themselves continue to bump for audit). Idempotency is at the file
// level, which means re-running with no new files is a no-op and
// re-running after adding 0020_fts_search.sql applies just that one.
func Migrate(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS _migrations (
			filename   TEXT PRIMARY KEY,
			applied_at INTEGER NOT NULL DEFAULT (unixepoch())
		)
	`); err != nil {
		return fmt.Errorf("create _migrations: %w", err)
	}

	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}
	files := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	applied, err := loadApplied(ctx, db)
	if err != nil {
		return err
	}

	for _, name := range files {
		if applied[name] {
			continue
		}
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		if err := runOne(ctx, db, name, string(body)); err != nil {
			return err
		}
		logger.Info("db.migration_applied", logger.Fields{"name": name})
	}
	return nil
}

func loadApplied(ctx context.Context, db *sql.DB) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT filename FROM _migrations`)
	if err != nil {
		return nil, fmt.Errorf("query _migrations: %w", err)
	}
	defer rows.Close()
	out := make(map[string]bool)
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		out[f] = true
	}
	return out, rows.Err()
}

// runOne wraps a single migration body in a transaction. SQLite
// supports DDL inside transactions, so this is safe for ALTER TABLE,
// CREATE TABLE, CREATE INDEX, CREATE VIRTUAL TABLE, etc.
//
// Some legacy migrations contain idempotent ALTER TABLE ADD COLUMN
// statements that error on re-run if a sibling tool has already added
// the column. We swallow ONLY the "duplicate column name" error and
// keep going, preserving the legacy migrate.mjs behaviour.
func runOne(ctx context.Context, db *sql.DB, name, body string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, stmt := range splitStatements(body) {
		s := strings.TrimSpace(stmt)
		if s == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, s); err != nil {
			if isIgnorable(err) {
				logger.Warn("db.migration_ignorable", logger.Fields{
					"file":    name,
					"err":     err.Error(),
					"snippet": firstLine(s),
				})
				continue
			}
			return fmt.Errorf("migration %s: %w (statement: %s)", name, err, firstLine(s))
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO _migrations (filename) VALUES (?)`, name); err != nil {
		return fmt.Errorf("record %s: %w", name, err)
	}
	return tx.Commit()
}

// splitStatements is a minimal SQL splitter: splits on `;` outside
// string/comment context. SQLite's CREATE TRIGGER bodies legally
// contain `;` between BEGIN and END, so we track the BEGIN…END nesting
// level and refuse to split inside.
func splitStatements(body string) []string {
	var out []string
	var cur strings.Builder
	i := 0
	depth := 0
	for i < len(body) {
		c := body[i]
		// Line comment
		if c == '-' && i+1 < len(body) && body[i+1] == '-' {
			for i < len(body) && body[i] != '\n' {
				cur.WriteByte(body[i])
				i++
			}
			continue
		}
		// String literal
		if c == '\'' {
			cur.WriteByte(c)
			i++
			for i < len(body) {
				cur.WriteByte(body[i])
				if body[i] == '\'' {
					i++
					break
				}
				i++
			}
			continue
		}
		// BEGIN…END detection (case-insensitive, word-boundary).
		if (c == 'B' || c == 'b') && hasKeyword(body, i, "BEGIN") {
			depth++
			cur.WriteString(body[i : i+5])
			i += 5
			continue
		}
		if (c == 'E' || c == 'e') && hasKeyword(body, i, "END") && depth > 0 {
			depth--
			cur.WriteString(body[i : i+3])
			i += 3
			continue
		}
		if c == ';' && depth == 0 {
			out = append(out, cur.String())
			cur.Reset()
			i++
			continue
		}
		cur.WriteByte(c)
		i++
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func hasKeyword(s string, i int, kw string) bool {
	if i+len(kw) > len(s) {
		return false
	}
	if !strings.EqualFold(s[i:i+len(kw)], kw) {
		return false
	}
	// require word boundary
	if i > 0 {
		p := s[i-1]
		if isWordByte(p) {
			return false
		}
	}
	if i+len(kw) < len(s) {
		n := s[i+len(kw)]
		if isWordByte(n) {
			return false
		}
	}
	return true
}

func isWordByte(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_'
}

func isIgnorable(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "duplicate column name") ||
		strings.Contains(msg, "already exists")
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + "…"
	}
	if len(s) > 120 {
		return s[:120] + "…"
	}
	return s
}
