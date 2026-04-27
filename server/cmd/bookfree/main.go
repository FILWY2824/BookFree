// bookfree is the single-binary backend that replaces the legacy
// Next.js full-stack process. It brings up the DB, applies migrations,
// opens the storage driver, and serves both the SPA bundle and every
// /api/* route from one HTTP server.
//
// Operator commands:
//
//	./bookfree-server              start the HTTP server (default)
//	./bookfree-server migrate      apply pending migrations and exit
//	./bookfree-server backfill-fts populate the new FTS5 tables from
//	                               existing book_chunks/notes rows
//	./bookfree-server make-admin   promote a user to role=admin
//	./bookfree-server version      print version and exit
//
// All other configuration is via environment variables — see
// internal/config/config.go and the .env.example at the repo root.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"bookfree/internal/auth"
	"bookfree/internal/config"
	"bookfree/internal/db"
	httpsrv "bookfree/internal/http"
	"bookfree/internal/logger"
	"bookfree/internal/search"
	"bookfree/internal/security"
	"bookfree/internal/storage"
	"bookfree/webdist"
)

// version is set via -ldflags="-X main.version=…" by the build pipeline.
var version = "dev"

func main() {
	// Memory limits. The wasm-based SQLite driver we used to ship made
	// 80 MiB the realistic floor; with the C-backed driver we tighten
	// to 48 MiB. GOGC=30 trades a little CPU for noticeably tighter
	// peak heap during bursty work (uploads, search bursts). Both are
	// overrideable via env so an operator on a noisier workload can
	// loosen them without rebuilding.
	//
	// debug.SetMemoryLimit is a soft target — when the heap approaches
	// it, the GC pace accelerates. It does NOT cap RSS the way ulimit
	// would; that's still the operator's job via cgroup or systemd.
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(48 << 20)
	}
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(30)
	}

	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "bookfree:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger.SetLevel(cfg.LogLevel)

	args := os.Args[1:]
	if len(args) > 0 {
		switch args[0] {
		case "version":
			fmt.Println(resolvedVersion())
			return nil
		case "help", "-h", "--help":
			printHelp()
			return nil
		case "migrate":
			return cmdMigrate(cfg)
		case "backfill-fts":
			return cmdBackfillFTS(cfg)
		case "make-admin":
			if len(args) < 2 {
				return errors.New("usage: bookfree-server make-admin <email>")
			}
			return cmdMakeAdmin(cfg, args[1])
		default:
			logger.Warn("boot.unknown_subcommand", logger.Fields{"arg": args[0]})
			// Fall through to serve.
		}
	}

	logger.Info("boot", logger.Fields{
		"version":     resolvedVersion(),
		"env":         cfg.Env,
		"addr":        cfg.Addr,
		"dbURL":       redactURL(cfg.DBURL),
		"storageDir":  cfg.StorageDir,
		"maxUploadMB": cfg.MaxUploadMB,
		"webdistDir":  cfg.WebDistDir,
	})
	return cmdServe(cfg)
}

func printHelp() {
	fmt.Println(`bookfree-server — low-memory Go backend for the BookFree reader.

Subcommands:
  (no args)             start the HTTP server
  migrate               apply pending DB migrations and exit
  backfill-fts          populate FTS5 tables from existing rows
  make-admin <email>    promote a user to role=admin
  version               print version
  help                  show this help

Configuration is via environment variables. See .env.example.`)
}

func cmdServe(cfg *config.Config) error {
	database, deriver, store, err := bootstrap(cfg)
	if err != nil {
		return err
	}
	defer database.Close()

	sessions := auth.NewStore(database, cfg.SessionCookie, cfg.IsProduction())

	allowRegister := !cfg.IsProduction()
	if v := os.Getenv("BOOKFREE_ALLOW_REGISTRATION"); v == "1" || v == "true" {
		allowRegister = true
	} else if v == "0" || v == "false" {
		allowRegister = false
	}

	deps := httpsrv.RouterDeps{
		DB:                database,
		Storage:           store,
		Sessions:          sessions,
		KeyDeriver:        deriver,
		IsProd:            cfg.IsProduction(),
		Version:           resolvedVersion(),
		StartedAt:         time.Now(),
		WebDistFS:         webdistOrNil(),
		WebDistDir:        cfg.WebDistDir,
		MaxUploadMB:       cfg.MaxUploadMB,
		AllowRegistration: allowRegister,
		TrustedProxies:    httpsrv.ParseTrustedProxies(cfg.TrustedProxies),
	}
	handler := httpsrv.New(deps)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return httpsrv.Run(ctx, cfg.Addr, handler)
}

func cmdMigrate(cfg *config.Config) error {
	database, _, _, err := bootstrap(cfg)
	if err != nil {
		return err
	}
	defer database.Close()
	logger.Info("migrate.done", nil)
	return nil
}

// cmdBackfillFTS reads every legacy row that has no search_text yet,
// computes one with the bigram tokenizer, and UPDATEs it. The trigger
// added by 0020_fts_search.sql does the rest (re-insert into FTS5).
//
// Safe to re-run / interrupt: WHERE search_text IS NULL means a second
// pass picks up exactly where the first one stopped.
func cmdBackfillFTS(cfg *config.Config) error {
	database, _, _, err := bootstrap(cfg)
	if err != nil {
		return err
	}
	defer database.Close()

	ctx := context.Background()
	if n, err := backfillSearchText(ctx, database, "book_chunks", "id", "text"); err != nil {
		return fmt.Errorf("book_chunks: %w", err)
	} else {
		logger.Info("backfill.book_chunks", logger.Fields{"updated": n})
	}
	if n, err := backfillSearchText(ctx, database, "notes", "id", "body"); err != nil {
		return fmt.Errorf("notes: %w", err)
	} else {
		logger.Info("backfill.notes", logger.Fields{"updated": n})
	}
	return nil
}

// backfillSearchText updates rows in batches of 500. After each
// UPDATE, the AFTER UPDATE trigger fires and writes the row into the
// matching FTS5 table.
func backfillSearchText(ctx context.Context, database *sql.DB, table, idCol, textCol string) (int, error) {
	const batch = 500
	updated := 0
	for {
		rows, err := database.QueryContext(ctx, fmt.Sprintf(
			`SELECT %s, %s FROM %s WHERE search_text IS NULL LIMIT %d`,
			idCol, textCol, table, batch))
		if err != nil {
			return updated, err
		}
		var ids, texts []string
		for rows.Next() {
			var id, txt string
			if err := rows.Scan(&id, &txt); err != nil {
				rows.Close()
				return updated, err
			}
			ids = append(ids, id)
			texts = append(texts, txt)
		}
		rows.Close()
		if len(ids) == 0 {
			break
		}

		tx, err := database.BeginTx(ctx, nil)
		if err != nil {
			return updated, err
		}
		stmt, err := tx.PrepareContext(ctx, fmt.Sprintf(
			`UPDATE %s SET search_text = ? WHERE %s = ?`, table, idCol))
		if err != nil {
			tx.Rollback()
			return updated, err
		}
		for i, id := range ids {
			if _, err := stmt.ExecContext(ctx, search.SearchText(texts[i]), id); err != nil {
				stmt.Close()
				tx.Rollback()
				return updated, err
			}
			updated++
		}
		stmt.Close()
		if err := tx.Commit(); err != nil {
			return updated, err
		}
		if updated%5000 < batch {
			logger.Info("backfill.progress", logger.Fields{"table": table, "rows": updated})
		}
	}
	return updated, nil
}

func cmdMakeAdmin(cfg *config.Config, email string) error {
	database, _, _, err := bootstrap(cfg)
	if err != nil {
		return err
	}
	defer database.Close()
	res, err := database.ExecContext(context.Background(),
		`UPDATE users SET role = 'admin', updated_at = unixepoch() WHERE LOWER(email) = LOWER(?)`,
		email)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("no user with email %q", email)
	}
	logger.Info("make_admin.done", logger.Fields{"email": email})
	return nil
}

// bootstrap opens the database, runs migrations, builds the key
// deriver, and opens the storage driver.
func bootstrap(cfg *config.Config) (*sql.DB, *security.KeyDeriver, storage.Storage, error) {
	database, err := db.Open(cfg.DBURL)
	if err != nil {
		return nil, nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.Migrate(ctx, database); err != nil {
		_ = database.Close()
		return nil, nil, nil, fmt.Errorf("migrate: %w", err)
	}

	deriver := security.NewKeyDeriver(cfg.AppSecret)

	store, err := storage.NewLocal(cfg.StorageDir)
	if err != nil {
		_ = database.Close()
		return nil, nil, nil, err
	}
	return database, deriver, store, nil
}

func webdistOrNil() fs.FS {
	if !webdist.Has() {
		return nil
	}
	return webdist.FS()
}

func resolvedVersion() string {
	if version != "dev" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

// redactURL strips secrets from a DB URL before logging. Auth tokens
// in libsql/turso URLs live in either the userinfo or the authToken
// query param.
func redactURL(s string) string {
	u, err := url.Parse(s)
	if err != nil {
		return s
	}
	if u.User != nil {
		u.User = url.User(u.User.Username())
	}
	if q := u.Query(); q.Has("authToken") {
		q.Set("authToken", "REDACTED")
		u.RawQuery = q.Encode()
	}
	return u.String()
}
