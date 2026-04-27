# BookFree

A self-hosted reader. Go backend + Vite/React SPA, single binary, low
RSS, embedded SQLite. Supports EPUB, PDF, and TXT ingestion in the
browser, with full-text CJK search, highlights, notes, reading
progress, and 8 reader themes.

> **Status (post-audit):** every P0/P1 item from the production audit
> is fixed. AI chat, MOBI/AZW/FB2/CBZ parsing, the admin panel UI,
> OAuth, and Foliate-based readers are intentionally out of scope; see
> [`docs/MIGRATION-PROGRESS.md`](./docs/MIGRATION-PROGRESS.md) for the
> long-form status matrix.

## Quick start (Docker)

```sh
# 1. Generate a secret and write it to .env (one-time).
echo "BOOKFREE_APP_SECRET=$(openssl rand -hex 32)" > .env

# 2. Build and start.
docker compose --env-file .env up -d --build

# 3. Wait a few seconds for /api/health to flip green.
curl -fsS http://127.0.0.1:8788/api/health | jq

# 4. Create the first admin user. Self-serve registration is OFF in
#    production, so you have two paths:
#
#    A. Pre-create + promote via CLI (recommended).
#       Open the registration once with the env flag set, register,
#       turn it back off:
docker compose --env-file .env exec -e BOOKFREE_ALLOW_REGISTRATION=1 bookfree \
  /app/bookfree-server make-admin you@example.com
#
#    B. Or run permanently with registration on (single-user / trusted
#       network). Add to .env then `docker compose up -d`:
#       BOOKFREE_ALLOW_REGISTRATION=1
```

Then visit <http://127.0.0.1:8788>.

The legacy `docker-quickstart.sh` script is still present for
convenience but the four commands above are exactly what it runs and
are clearer to debug when something goes wrong.

The container persists everything to `./data/` on the host. Back that
directory up.

## Native build (development)

Prerequisites: Go 1.22+, Node 20+, gcc/clang (for CGO).

```sh
# Easiest: the Makefile knows about FTS5 build tags and the webdist copy.
make build
./bookfree-server
```

If you can't run `make`, the equivalent commands are:

```sh
# 1. SPA bundle.
cd apps/web
npm install
npm run build
cd ../..

# 2. Copy the bundle into the Go embed directory.
rm -rf server/webdist/assets server/webdist/index.html server/webdist/robots.txt
cp -r apps/web/dist/. server/webdist/

# 3. Build the Go binary. The build tags are MANDATORY — without
#    `sqlite_fts5` the search migration will fail at boot.
cd server
GOPROXY=direct GOSUMDB=off CGO_ENABLED=1 \
  go build \
    -tags 'sqlite_fts5 sqlite_omit_load_extension' \
    -trimpath -ldflags='-s -w' \
    -o ../bookfree-server \
    ./cmd/bookfree
cd ..

# 4. Run.
BOOKFREE_APP_SECRET=$(openssl rand -hex 32) \
BOOKFREE_DB_URL='file:./data/bookfree.db' \
BOOKFREE_STORAGE_DIR=./data/storage \
./bookfree-server
```

## Environment variables

| Variable                       | Default                       | Notes |
|--------------------------------|-------------------------------|-------|
| `BOOKFREE_APP_SECRET`          | —                             | Required in production. 32+ char hex. |
| `BOOKFREE_ENV`                 | `development`                 | Set to `production` for hardened defaults. |
| `BOOKFREE_ADDR`                | `127.0.0.1:3001`              | `0.0.0.0:8788` in the Docker image. |
| `BOOKFREE_DB_URL`              | `file:./data/bookfree.db`     | Local SQLite only in this build. |
| `BOOKFREE_STORAGE_DIR`         | `./data/storage`              | Where book files live. |
| `BOOKFREE_MAX_UPLOAD_SIZE_MB`  | `100`                         | Upload cap. Docker image sets `200`. |
| `BOOKFREE_ALLOW_REGISTRATION`  | off in production             | `1` to enable self-serve signup. |
| `BOOKFREE_TRUSTED_PROXIES`     | empty                         | Comma-separated CIDRs / IPs whose `X-Forwarded-For` / `X-Real-IP` are honoured. **Forwarded headers are ignored when this is empty** — set it when running behind Caddy / Nginx / Traefik. |
| `BOOKFREE_LOG_LEVEL`           | `info`                        | `debug` / `info` / `warn` / `error`. |

Legacy `QS_MASTER_SECRET`, `APP_SECRET`, `NEXTAUTH_SECRET`,
`SESSION_SECRET`, `QS_CONFIG_SECRET` are still accepted as
fallback aliases for `BOOKFREE_APP_SECRET`.

## Subcommands

```sh
./bookfree-server                     # serve (default)
./bookfree-server migrate             # apply pending migrations and exit
./bookfree-server backfill-fts        # populate FTS5 from existing rows
./bookfree-server make-admin <email>  # promote a user to role=admin
./bookfree-server version
./bookfree-server help
```

## Architecture

```
bookfree/
├── apps/web/                Vite + React + Tailwind SPA.
│   ├── src/pages/           Route components.
│   ├── src/reader/          TXT / EPUB / PDF reader implementations.
│   ├── src/parsers/         Web-Worker-friendly TXT/EPUB → ingest.
│   └── public/              Static (robots.txt etc.) — Vite copies into dist/.
└── server/
    ├── cmd/bookfree/        Entrypoint + subcommands.
    └── internal/
        ├── auth/            Sessions, login/register/me, dummy-bcrypt timing-safe.
        ├── books/           List / get / delete (with file cleanup) / upload (streaming).
        ├── chapters/        Chapter list + body fetcher.
        ├── config/          Env loader with legacy fallback chain.
        ├── db/              *sql.DB with PRAGMAs encoded in the DSN.
        ├── health/          GET /api/health (HTTP 503 on fail).
        ├── http/            Router, middleware, rate limit, trusted-proxy IP.
        ├── ingest/          POST /api/books/{id}/ingest — receives parsed chapters/chunks.
        ├── notes/           Highlights + notes API.
        ├── progress/        Reading progress upsert.
        ├── search/          FTS5 query handler + CJK bigram tokenizer.
        ├── security/        AES-GCM, scrypt, bcrypt — JS-compat.
        └── storage/         Storage interface + local FS driver.
```

## Memory

Idle RSS ~32 MB. A 50 MB streaming upload still ~32 MB (bytes go
straight to disk in 32 KiB chunks; nothing is buffered).

## What's not in this build

The following are deliberately omitted from the current scope and
would each be substantial additions:

- AI chat / RAG / citations
- MOBI / AZW / AZW3 / FB2 / FBZ / CBZ parsing (uploads accept these
  formats; they're stored and downloadable but not paginated in the
  reader yet)
- Foliate-based EPUB rendering
- Admin UI (the CLI is the only management surface today)
- OAuth provisioning
- Stats — the page exists, but the data is best-effort

## License

Inherits the upstream project's license.
