# BookFree — Docker deployment

This guide walks through everything you need to run BookFree in Docker
in production: one-click setup, TLS, reverse proxies, backups, upgrades,
and the gotchas to watch for.

For a 30-second start, just run `./docker-quickstart.sh` and skip to
the [Operations](#operations) section.

---

## What you get

- **Single-container deployment.** No external SQLite, no Redis, no
  S3 — everything ships in one image.
- **~32 MB idle RSS, ~50 MB hard cap by default.** The compose file
  pins memory limits so a runaway worker can't OOM the host.
- **Persistent volume.** `./data/` on the host holds the SQLite DB and
  every uploaded book. Bind mount, not named volume — easier to back up.
- **Healthcheck.** `docker ps` shows `(healthy)` once `/api/health`
  responds, including a memory-stats snapshot.
- **Non-root container user.** The process runs as UID `bookfree`
  (created in the image), not root.
- **Multi-stage build, ~50-60 MB compressed image.**

---

## One-click deploy

```sh
git clone <this-repo> bookfree
cd bookfree
./docker-quickstart.sh
```

That script does five things:

1. Verifies `docker` and `docker compose` are installed.
2. Creates `./data/` and `./data/storage/`.
3. Generates a strong `BOOKFREE_APP_SECRET` into `.env` (chmod 600).
4. Builds the image (~2 minutes the first time, instant on rebuilds).
5. Starts the container and waits for `/api/health` to come green.

Idempotent — safe to run repeatedly. Existing `.env` is preserved.

---

## Manual deploy

If you'd rather drive `docker compose` directly:

```sh
# Generate the secret once
echo "BOOKFREE_APP_SECRET=$(openssl rand -hex 32)" > .env
chmod 600 .env

# Build + start
docker compose up -d --build

# Watch logs
docker compose logs -f
```

The `--env-file .env` flag is implicit when the file is named exactly
`.env` and lives next to `docker-compose.yml`.

---

## First admin

Registration is **disabled by default** in production. You have two
options to create the first user:

**Option A — register, then promote.** Temporarily allow registration:

```sh
echo "BOOKFREE_ALLOW_REGISTRATION=1" >> .env
docker compose up -d
# Open http://127.0.0.1:8788, register your account.
docker compose exec bookfree /app/bookfree-server make-admin you@example.com

# Lock registration back down
sed -i '/BOOKFREE_ALLOW_REGISTRATION/d' .env
docker compose up -d
```

**Option B — register through the temp flag in production.** Keep
`BOOKFREE_ALLOW_REGISTRATION=1` if you want a self-serve site.

---

## Reverse proxy (Caddy / Nginx / Traefik)

The compose file binds the container to `127.0.0.1:8788` deliberately
— don't expose it directly. Front it with a real reverse proxy for
TLS, HTTP/2, and rate limiting.

### Caddy (simplest)

`Caddyfile`:

```caddy
reader.example.com {
    reverse_proxy 127.0.0.1:8788
    encode gzip zstd
    # Books can be large — give uploads time
    request_body {
        max_size 200MB
    }
}
```

Run with `caddy run` or use the docker image. TLS is automatic.

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name reader.example.com;

    ssl_certificate     /etc/letsencrypt/live/reader.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/reader.example.com/privkey.pem;

    # 200 MB upload cap — match BOOKFREE_MAX_UPLOAD_SIZE_MB.
    client_max_body_size 200M;
    # Long timeouts for AI streaming + big uploads.
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE chat streams need this — disable buffering for /api/chat.
        # If your nginx is on this whole vhost, leave it global; if you
        # have other apps mounted, restrict to the chat path.
        proxy_buffering off;
    }
}
```

### Traefik

If you already run Traefik with file/docker provider, add labels to
the compose service:

```yaml
services:
  bookfree:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.bookfree.rule=Host(`reader.example.com`)"
      - "traefik.http.routers.bookfree.tls.certresolver=letsencrypt"
      - "traefik.http.services.bookfree.loadbalancer.server.port=8788"
```

And remove the `ports:` block so Traefik handles routing instead of
the host port mapping.

---

## Backups

The whole state is `./data/`. Two reasonable strategies:

**Hot snapshot via litestream** (recommended for SQLite):

```yaml
# docker-compose.override.yml
services:
  litestream:
    image: litestream/litestream:0.3
    container_name: bookfree-litestream
    restart: unless-stopped
    volumes:
      - ./data:/data
      - ./litestream.yml:/etc/litestream.yml:ro
    command: replicate
    depends_on:
      - bookfree
```

`litestream.yml`:

```yaml
dbs:
  - path: /data/bookfree.db
    replicas:
      - type: s3
        bucket: my-bookfree-backup
        path: bookfree
        region: us-east-1
        access-key-id: ...
        secret-access-key: ...
```

**Cold tarball** (simpler, suitable for personal deployments):

```sh
docker compose stop
tar czf "bookfree-backup-$(date +%F).tar.gz" data/ .env
docker compose start
```

The Storage layer is bind-mounted as a directory, so tarring it gets
both the DB and every uploaded book in one shot. Don't forget `.env`
— without `BOOKFREE_APP_SECRET`, every encrypted AI provider key
becomes unrecoverable.

---

## Upgrades

```sh
git pull
docker compose up -d --build
```

That rebuilds the image (cached layers reuse what hasn't changed) and
restarts. Migrations run automatically on boot. Schema changes are
backwards-compatible (new columns are nullable, additive); operators
DO NOT need to take downtime for a normal upgrade.

A migration that needs operator action will be called out in the
release notes. To preview:

```sh
docker compose exec bookfree /app/bookfree-server migrate
```

(Running `migrate` against an already-migrated DB is a no-op.)

---

## Operations

### Common commands

```sh
docker compose logs -f                              # tail logs
docker compose ps                                   # health status
docker compose exec bookfree /app/bookfree-server help
docker compose exec bookfree /app/bookfree-server make-admin you@x.com
docker compose exec bookfree /app/bookfree-server backfill-fts
docker compose exec bookfree /app/bookfree-server version

# Inspect the SQLite DB directly (useful for debugging)
docker compose exec bookfree sh -c 'apk add --no-cache sqlite && sqlite3 /app/data/bookfree.db .tables'
```

### Memory monitoring

```sh
# Container-level
docker stats bookfree

# Application-level (from the binary itself)
curl -s http://127.0.0.1:8788/api/health | jq .data.mem
```

The `mem` block contains live numbers from `runtime.MemStats`:
`heapMb`, `heapSysMb`, `sysMb`, `stackMb`, `numGc`, `goroutines`.

### Tuning

All of these are env vars in `.env` — change and `docker compose up -d`:

| Variable                          | Default          | Notes                                   |
|-----------------------------------|------------------|-----------------------------------------|
| `BOOKFREE_LOG_LEVEL`              | `info`           | `debug` for verbose, `warn` for quiet   |
| `BOOKFREE_MAX_UPLOAD_SIZE_MB`     | `200`            | Per-upload cap. Streaming, no RAM cost. |
| `BOOKFREE_ALLOW_REGISTRATION`     | (off in prod)    | `1` to allow self-serve sign-ups        |
| `GOMEMLIMIT`                      | `48MiB`          | Soft heap target. Tighter = more GC.    |
| `GOGC`                            | `30`             | Heap-growth %; tighter = more GC.       |
| `TZ`                              | (UTC)            | e.g. `Asia/Shanghai` for local logs     |

The compose-level `deploy.resources.limits.memory: 256M` is the hard
cap — RSS exceeding it triggers OOM-kill. The default is intentionally
generous; we observe 32-50 MB under all current workloads. Tighten to
`128M` if you want a stricter ceiling.

---

## Troubleshooting

**Port 8788 already in use.**
Edit `docker-compose.yml`, change `127.0.0.1:8788:8788` to the host
port you want (e.g. `127.0.0.1:9090:8788`), then `docker compose up -d`.

**Container restarts in a loop.**
Check `docker compose logs --tail=50 bookfree`. Most likely causes:

- `BOOKFREE_APP_SECRET` not set — re-run `docker-quickstart.sh`
- `data/` permissions wrong — `sudo chown -R 1000:1000 data/` (or whatever
  UID the bookfree user got — `docker compose exec bookfree id`)
- DB locked from a previous unclean shutdown — see "stuck WAL" below

**"database is locked" errors.**
SQLite WAL recovery is automatic, but if the container was killed
mid-write (e.g. host OOM), you may see this on first boot. Restart
once and SQLite will reconcile the WAL: `docker compose restart`.
If it persists, the DB file may be corrupt — restore from backup.

**Image build takes forever / runs out of disk.**
Clear the Docker build cache: `docker builder prune -a`. The first
build of each Node minor version pulls ~150 MB; subsequent builds
share that layer.

**Healthcheck shows `(unhealthy)` but the app responds.**
The healthcheck calls `/api/health` from inside the container. If
something's broken with the DB ping but the HTTP layer is up, you'll
see this. `curl -s http://127.0.0.1:8788/api/health | jq` from the
host shows the actual `db: "ok"|"fail"` field — that's what the check
looks at.

---

## Development with Docker

For day-to-day development, native build is faster (no docker context
upload, no layer cache fights). But if you want a Docker-based dev
loop:

```sh
# Live SPA via host disk override:
docker run --rm -it \
  -p 8788:8788 \
  -v ./data:/app/data \
  -v ./apps/web/dist:/app/webdist:ro \
  -e BOOKFREE_APP_SECRET=$(openssl rand -hex 32) \
  -e BOOKFREE_WEBDIST_DIR=/app/webdist \
  -e BOOKFREE_ENV=development \
  bookfree:latest
```

That bind-mounts `apps/web/dist/` into the container so a host-side
`npm run build` is enough to refresh the SPA without rebuilding the
image.

For the Go side, host-build the binary and bind-mount it in:

```sh
make build-server
docker run --rm -it \
  -p 8788:8788 \
  -v ./data:/app/data \
  -v ./bookfree-server:/app/bookfree-server:ro \
  -e BOOKFREE_APP_SECRET=$(openssl rand -hex 32) \
  bookfree:latest
```

Although honestly, if you're going that far, just run the binary on
the host directly.

---

## Reproducible builds

The Dockerfile uses `-trimpath` and `-ldflags '-s -w'` to strip local
paths and debug symbols. Same source + same Go version = same bytes.
Module resolution is locked by `go.sum`. SPA bundle filenames are
content-hashed, so a same-source rebuild produces identical asset
filenames too.

Pin the base image digests in production if you want bit-exact
rebuilds across time:

```dockerfile
FROM node:20-alpine@sha256:...
FROM golang:1.22-alpine@sha256:...
FROM alpine:3.20@sha256:...
```

(Look up current digests with `docker buildx imagetools inspect`.)
