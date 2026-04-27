# BookFree Migration — Progress & Roadmap

This document tracks the state of the Next.js → Go + Vite SPA migration.
It exists so any operator (or future me) can pick up the work without
re-deriving every decision from the source. Read top-to-bottom.

---

## Status Summary

| Phase | Area                                  | Status         |
|------:|---------------------------------------|----------------|
|     1 | Repo split, Go module, build env      | ✅ Done         |
|     1 | Vite SPA shell                        | ✅ Done         |
|     2 | DB layer (sqlite, migrations, FTS5)   | ✅ Done         |
|     2 | AES-GCM v1: envelope (compat-locked)  | ✅ Done         |
|     2 | scrypt key derivation (compat-locked) | ✅ Done         |
|     2 | Sessions + auth middleware            | ✅ Done         |
|     2 | Health, books CRUD, file streaming    | ✅ Done         |
|     2 | Streaming upload (no buffer)          | ✅ Done         |
|     2 | Chapters / progress / search          | ✅ Done         |
|     3 | Highlights + notes                    | ⬜ Not started  |
|     3 | Reading prefs + reading sessions      | ⬜ Not started  |
|     4 | Async ingestion worker (or WW path)   | ⬜ Not started  |
|     5 | AI providers + AES envelope round-trip| ⬜ Not started  |
|     5 | Chat SSE endpoint + 5 provider adapters| ⬜ Not started |
|    10 | Admin panel (config/users/etc)        | ⬜ Not started  |
|    11 | EPUB / PDF / MOBI parser ports        | ⬜ Not started  |
|    12 | Storage abstraction (S3/Turso)        | ⚠️ Interface only |

What ships today is enough to register, log in, upload a book, list
books, fetch the original file with Range requests, fetch chapter
metadata, save reading progress, and run an FTS5 search. Everything
else is plumbing for those features.

---

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────────┐
│  apps/web   (Vite SPA)   │        │  server (Go single binary)   │
│                          │        │                              │
│  React 18 + react-router │  HTTP  │  cmd/bookfree     entrypoint │
│  api.ts envelope client  ├───────►│  internal/http    router     │
│  AuthProvider + Guard    │        │  internal/auth    sessions   │
│  pages/Login + Library   │        │  internal/books   CRUD+upload│
│  pages/Reader (shell)    │        │  internal/storage local FS   │
│  Web Workers (Phase 11)  │        │  internal/security AES+scrypt│
│                          │        │  internal/db      migrations │
│  built into dist/, then  │        │  internal/search  FTS5+bigram│
│  embedded into binary    ├───────►│  webdist/         //go:embed │
└──────────────────────────┘ static └──────────────────────────────┘
                                              │
                                              ▼
                                    SQLite (FTS5 + WAL + 8 MiB cache)
                                    Local FS (data/storage/users/<id>/...)
```

Single binary, no CGO. Memory ceiling pinned via `GOMEMLIMIT=80MiB`
inside `main.go`; observed RSS at idle with a fresh DB and SPA
embedded is ~98 MB (the 18 MB delta is Go runtime overhead — heap
caps work, RSS just lags as it always does).

---

## How to add a new endpoint

The router in `internal/http/router.go` is the wiring spine. To add
`POST /api/highlights`, for example:

1. Create `internal/highlights/handlers.go` with a `Handler` struct
   that holds whatever it needs (DB, IsProd, etc.).
2. Add handler methods following the books / progress pattern:
   ```go
   func (h *Handler) HandleCreate(w http.ResponseWriter, r *http.Request) {
       user := auth.UserFromContext(r.Context())
       // ... validate body, run query, write response.OK / response.Fail
   }
   ```
3. Register in `router.go`:
   ```go
   hl := &highlights.Handler{DB: deps.DB, IsProd: deps.IsProd}
   mux.Handle("POST /api/highlights",
       auth.RequireUser(http.HandlerFunc(hl.HandleCreate)))
   ```
4. Add a function to `apps/web/src/lib/api.ts` consumers if it's a
   stable surface, or just call `api.post('/api/highlights', body)`
   inline.

That's the whole pattern. Every legacy `/api/*` route translates to
exactly one Go handler method, mostly with copy-paste shape.

### Translating a legacy DAL to Go

Every DAL function `legacy/src/lib/dal/<x>.js` becomes a function in
`server/internal/<x>/store.go`. The translation is mechanical:

| Legacy JS                                  | Go equivalent                       |
|--------------------------------------------|-------------------------------------|
| `async function listFooByUser(db, userId)` | `func ListByUser(ctx, db, userID)`  |
| `await db.execute({ sql, args })`          | `db.QueryContext(ctx, sql, args...)`|
| `rowToFoo(row)`                            | a struct + scan helper              |
| `return rows.map(rowToFoo)`                | scan in a `for rows.Next()` loop    |

Legacy timestamps are stored as `unixepoch()` integers. Go `time.Time`
should never appear in column scans — use `int64` and convert at the
HTTP boundary if needed.

---

## Phase 3 — Highlights / notes / prefs (estimated 2 days)

Schema is already there (migrations 0004, 0008, 0019). What's needed:

- `internal/highlights/store.go`: Create / List / Update / Delete
  scoped by `(user_id, book_id)`. Mirror `src/lib/dal/highlights.js`.
- `internal/notes/store.go`: same shape; remember the soft-delete
  semantics (`deleted_at IS NOT NULL`) — the FTS notes trigger
  respects this so searches don't surface deleted notes.
- `internal/highlights/handlers.go` + `internal/notes/handlers.go`:
  REST verbs in the legacy shape.
- Wire in `router.go`.

The notes table already gets backfilled into `notes_fts` by the
trigger added in 0020, so search-after-create works without any
extra code on the Go side.

## Phase 4 — Async ingestion (estimated 3 days)

Two paths in the migration plan, both covered by the existing schema:

**Server-side worker (legacy parity).** Long-running goroutine that
polls `ingestion_jobs` and runs format-specific parsers. EPUB and TXT
are the easy wins (Go-native libraries exist). PDF and MOBI need a
sub-process — the legacy was `pdf-parse` + a hand-rolled MOBI parser.

**Client-side parser (preferred).** The SPA loads a Web Worker that
parses the book locally, then POSTs `/api/books/<id>/ingest` with a
batch of `{ chapter, chunks }` rows. The Go side just inserts. This
keeps server-side memory minimal because parsing is the heaviest op
in the legacy stack.

Recommended order: ship Go-side TXT first (trivial: split on form
feeds or N-line windows, write chunks). Then SPA worker for EPUB. PDF
last because pdf.js parsing in a worker is non-trivial.

## Phase 5 — AI providers + chat (estimated 1 week)

The 5 provider adapters (OpenAI, Anthropic, Gemini, Volcengine,
Groq) all share a streaming-translation contract: read SSE/JSON-lines
from upstream, emit our own SSE events to the SPA. Translate one,
the rest fall in line.

Critical compat point: provider API keys go through
`security.Encrypt()` → ciphertext stored in `ai_providers.api_key`.
The envelope is byte-identical to the JS code so an existing provider
row stored by the legacy app round-trips through the Go decrypt.

Test harness should round-trip a provider with a known key and
confirm the same plaintext comes back out from a JS-encrypted row.
That single test catches every key/IV/format mistake.

## Phase 11 — Reader

Out of scope for the backend, but the API contract is locked:

- `GET /api/books/{id}/file` streams the raw file with Range support.
  pdf.js fetches a few KB at a time; epub.js downloads then unzips
  in a worker. Both work today.
- `GET /api/books/{id}/chapters/list` returns the TOC.
- `GET /api/books/{id}/chapters/{chapterId}` returns rendered HTML
  + plaintext (populated by the ingestion worker / web worker).
- `PUT /api/books/{id}/progress` upserts the current position.

Everything the reader needs is already wired.

---

## Operator runbook

```sh
# Build
make build

# Run with default dev config (writes to ./data/, ./storage/)
make run

# Apply migrations against an existing DB
./bookfree-server migrate

# Backfill FTS5 from legacy book_chunks / notes rows
./bookfree-server backfill-fts

# Promote a user
./bookfree-server make-admin you@example.com

# Override the embedded SPA from disk (dev hot-reload)
BOOKFREE_WEBDIST_DIR=apps/web/dist ./bookfree-server
```

## Crypto compatibility notes

The migration plan calls these out explicitly because getting any of
them wrong silently breaks the round-trip with existing data.

- **AES-GCM envelope:** `"v1:" + base64(iv(12) || tag(16) || ciphertext)`.
  Note JS produces `iv || ct || tag` from `cipher.final()` — the legacy
  code rearranges into `iv || tag || ct`. Go's `cipher.AEAD.Seal`
  returns `ct || tag`; we splice manually. See
  `internal/security/crypto.go`.
- **scrypt:** N=16384, r=8, p=1, keyLen=32, salt=`sha256("qishu:salt:" + purpose)`.
  Three purposes: `ai-provider`, `app-config`, `oauth-tokens`.
- **bcrypt:** cost 10. `bcryptjs` writes `$2a$`; Go's `bcrypt`
  accepts both `$2a$` and `$2b$`. Verified.
- **Session cookie:** `<session_id>.<raw_token>`. id is 16 bytes hex,
  raw_token is 32 bytes base64url **unpadded**. Padding mismatch is
  the most common compat bug.

---

## Network constraint workaround

The build environment for this iteration could not reach
`proxy.golang.org` or vanity hosts (`golang.org/x/*`). We use a
`replace` directive in `go.mod` to point those at the github mirror:

```
replace golang.org/x/crypto => github.com/golang/crypto v0.27.0
```

If your environment has unrestricted network access, you can drop
the replace and use the default proxy.

## Build with CGO + FTS5

The SQLite driver is `mattn/go-sqlite3`, which requires CGO and a
build tag to enable FTS5:

```sh
GOPROXY=direct GOSUMDB=off CGO_ENABLED=1 \
  go build -tags 'sqlite_fts5 sqlite_omit_load_extension' \
           -ldflags='-s -w' \
           -o bookfree-server ./cmd/bookfree
```

`-tags sqlite_fts5` compiles FTS5 support in (mattn defaults to
omitting it). `-tags sqlite_omit_load_extension` removes the SQLite
runtime extension loading API — we never use it and disabling it
shrinks the attack surface. `-ldflags='-s -w'` strips the symbol
table; saves ~5 MB on the binary.

The Makefile encodes these flags. `make build` is the canonical
build command.

## Memory profile

After switching from `ncruces/go-sqlite3` (wasm) to
`mattn/go-sqlite3` (CGO + libsqlite3), measured numbers on x86_64
Linux:

| State                                  | RSS    |
|----------------------------------------|-------:|
| Idle                                   | 32 MB  |
| During 50 MB streaming PUT upload      | 32 MB  |
| After register / login / upload / search round-trip | 33 MB |

The streaming upload pipeline (head buffer → magic-number sniff →
io.MultiReader → io.Copy → atomic rename) does not scale memory with
file size. A 5 GB upload behaves identically.

`GOMEMLIMIT=48MiB` and `GOGC=30` are set in `main.go` if env is unset.
A tighter `GOGC` trades a small amount of CPU for tighter peak heap
during bursty work like search or chat. Override either via the
standard env var without rebuilding.

---

## What I would do next, in order

1. **Highlights + notes endpoints** — schema and FTS triggers exist;
   it's purely DAL + handler boilerplate. ~2 days.
2. **Reading prefs upsert** — single endpoint, single table. ~half day.
3. **Web Worker EPUB parser** — biggest user-visible payoff because
   it makes the reader work end-to-end. ~3 days including the
   `/api/books/{id}/ingest` POST endpoint.
4. **AI provider config CRUD** + the encrypt/decrypt round-trip test.
   ~2 days.
5. **Chat SSE handler** with one provider (OpenAI-compatible adapter
   covers OpenAI + Groq + Volcengine in one go). ~3 days.
6. **Admin panel** — frontend-heavy, backend is mostly thin queries.
   Schedule depends on UX appetite.

Each step is independent and shippable. You don't have to finish all
of Phase 3 before starting Phase 5.

---

## Post-audit hardening (this build)

The production audit's P0 / P1 items have been resolved in this drop:

- **P0-01** — `Dockerfile` now copies `apps/web/public/` so Vite emits
  `robots.txt` into `dist/`; the server stage's existence check no
  longer fails.
- **P0-02** — `/api/auth/register` returns an actionable error pointing
  the operator at `bookfree-server make-admin` and
  `BOOKFREE_ALLOW_REGISTRATION`.
- **P0-03** — Real reader pipeline: client-side TXT/EPUB parser →
  `POST /api/books/{id}/ingest` → `book_chapters` + `book_chunks` +
  FTS5. PDFs render via lazy-loaded pdf.js without ingest. EPUB also
  has a CFI-based reader using epubjs.
- **P0-04** — SQLite PRAGMAs (`_foreign_keys`, `_busy_timeout`,
  `_journal_mode`, `_synchronous`, `_cache_size`, `_temp_store`) now
  ride on the DSN, so every pooled connection picks them up — not
  just the first one. Regression test in `internal/db/db_test.go`.
- **P0-05** — README's native build path documents the mandatory
  `sqlite_fts5` build tag and recommends `make build`.
- **P1-01** — Login runs bcrypt unconditionally (dummy hash on
  user-not-found) so unknown-email and wrong-password branches take
  identical wall time.
- **P1-02** — In-memory token-bucket rate limit on
  `/api/auth/login` (20/min), `/api/auth/register` (5/10min),
  `/api/books/upload` (30/min), `/api/books/{id}/ingest` (60/min).
- **P1-03** — `BOOKFREE_TRUSTED_PROXIES` (CIDR list).
  `X-Forwarded-For` / `X-Real-IP` are honoured **only** when the
  immediate peer's address falls inside one of those CIDRs; empty
  list (default) means forwarded headers are ignored entirely.
- **P1-04** — `DELETE /api/books/{id}` collects `storage_key`s in the
  same tx, then drops them from the storage driver post-commit.
- **P1-05** — Upload uses a `stored && !committed` deferred cleanup
  that covers Stat / BeginTx / INSERT / Commit failures.
- **P1-06** — `GET /api/health` returns HTTP 503 when DB or secret
  are unhealthy. The Docker healthcheck now relies on the HTTP
  status code instead of grepping the JSON body.
- **P1-07** — Tests:
  `internal/db/db_test.go` (DSN PRAGMAs),
  `internal/http/middleware_test.go` (trusted-proxy resolver +
  request-id charset),
  `internal/auth/handlers_test.go` (timing-equivalent login,
  actionable register message).

P2 items resolved opportunistically:

- **P2-03** — CSP + (conditional) HSTS now set in `secureHeaders`.
- **P2-04** — `validRequestID()` restricts the inbound `X-Request-Id`
  to `[A-Za-z0-9._-]{1,64}` so it can be embedded in logs verbatim.
