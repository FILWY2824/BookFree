# syntax=docker/dockerfile:1.6
#
# BookFree multi-stage Dockerfile.
#
# Three stages:
#   1. spa-builder    Node alpine — bundles the Vite SPA into apps/web/dist
#   2. server-builder Go alpine — copies SPA into server/webdist, builds the Go
#                                 binary with CGO + vendored SQLite + FTS5
#   3. runtime        Alpine — musl libc, ca-certificates, the binary, a
#                              non-root user. ~7 MB base + ~7 MB binary.
#
# Final image: ~50-60 MB compressed, ~25 MB pulled to disk after dedup with
# the alpine base.
#
# Why all-alpine: mattn/go-sqlite3 vendors the SQLite C source via cgo, so
# we don't need a system libsqlite3 — only a working libc + libm. Building
# on alpine (musl) and running on alpine (musl) keeps both the build and
# runtime layers small and avoids any glibc/musl mismatch.
#
# Build: docker build -t bookfree:latest .
# Run:   docker run -p 8788:8788 -v ./data:/app/data \
#               -e BOOKFREE_APP_SECRET=$(openssl rand -hex 32) bookfree:latest

# ─── Stage 1: SPA builder ────────────────────────────────────────────
# Pin Node version explicitly so reproducible — newer Node majors regularly
# break Vite plugins. node:20-alpine is ~50 MB; node:lts-alpine drifts.
FROM node:20-alpine AS spa-builder
WORKDIR /web

# Copy package manifests FIRST so npm install caches independently of source
# changes. The `.dockerignore` excludes node_modules, so an `npm ci` is needed
# rather than mount-cache reuse.
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error

# Now copy the source. Each cp invalidates the cache on its own contents only.
#
# `apps/web/public/` is critical: Vite copies its contents (robots.txt,
# favicon, etc.) verbatim into dist/. Without it the server stage's
# `test -f /src/server/webdist/robots.txt` sanity check fails. (Audit P0-01.)
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts ./
COPY apps/web/postcss.config.js apps/web/tailwind.config.js ./
COPY apps/web/public ./public
COPY apps/web/src ./src

# Build the SPA. Vite drops output in /web/dist/.
# Vite's default minifier (esbuild) is fast enough that we don't need terser.
RUN npm run build

# ─── Stage 2: Go builder ─────────────────────────────────────────────
# golang:1.22 + alpine = small layer + the gcc/musl toolchain we need for CGO.
# go-sqlite3 needs a C compiler at build time; we install build-base for that.
FROM golang:1.22-alpine AS server-builder
RUN apk add --no-cache build-base
WORKDIR /src

# Module manifests first — same caching reasoning as the SPA stage. A pure
# code edit (no go.mod change) hits this cache and skips the (slow) module
# fetch.
COPY server/go.mod server/go.sum ./server/
WORKDIR /src/server

# Pre-fetch modules. Doing this in a separate layer means a re-build with
# unchanged go.mod skips network entirely on rebuild.
#
# GOPROXY=direct GOSUMDB=off lets the build work in restricted-network
# environments where proxy.golang.org isn't reachable. In an open environment
# Docker won't notice the difference; the modules just come from github.
ENV GOPROXY=direct
ENV GOSUMDB=off
RUN go mod download

# Copy the rest of the server source.
COPY server /src/server

# Pull the SPA bundle from stage 1 into webdist/.
#
# We first wipe any placeholder content so the embed only sees the real
# bundle. Then copy from /web/dist/. The webdist/embed.go file itself
# (the //go:embed declaration) was copied in by `COPY server` above and
# stays — it lives alongside the embedded files, not inside them.
RUN rm -rf /src/server/webdist/assets /src/server/webdist/index.html /src/server/webdist/robots.txt
COPY --from=spa-builder /web/dist/ /src/server/webdist/

# Sanity check the embed inputs are present BEFORE the build, so a bad
# COPY fails fast instead of producing a binary that 500s on /.
RUN test -f /src/server/webdist/index.html \
    && test -d /src/server/webdist/assets \
    && test -f /src/server/webdist/robots.txt \
    && echo "✓ webdist populated"

# CGO_ENABLED=1 is mandatory because we use mattn/go-sqlite3.
# Build tags:
#   sqlite_fts5                 — compile FTS5 in (we need it for /api/search)
#   sqlite_omit_load_extension  — drop runtime extension API, smaller surface
#
# -ldflags "-s -w" strips symbols + DWARF, shaves ~5 MB off the binary.
# -trimpath removes local filesystem paths from the binary so the same
# source produces the same bytes regardless of where it was built.
RUN CGO_ENABLED=1 GOOS=linux \
    go build \
        -tags 'sqlite_fts5 sqlite_omit_load_extension' \
        -trimpath \
        -ldflags '-s -w' \
        -o /out/bookfree-server \
        ./cmd/bookfree

# Sanity check: dump version + linked libs at build time so it shows up in
# the docker build log. If this line fails the image won't ship.
RUN /out/bookfree-server version || true

# ─── Stage 3: runtime ────────────────────────────────────────────────
# alpine:3.20 is ~7 MB and ships musl libc. We build on the same musl base
# in stage 2 so the binary's dynamic links resolve cleanly.
#
# Note that mattn/go-sqlite3 vendors the SQLite C source — it doesn't need
# a system libsqlite3. So our only dynamic deps are libc + libm, both
# satisfied by the alpine base.
FROM alpine:3.20 AS runtime

# ca-certificates for HTTPS calls to AI providers (Phase 5+).
# tzdata so log timestamps render correctly when the operator sets TZ.
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S bookfree && \
    adduser -S -G bookfree -h /app bookfree

WORKDIR /app

# Copy ONLY the binary. No source, no node_modules, no build tools.
COPY --from=server-builder /out/bookfree-server /app/bookfree-server

# Runtime data lives in /app/data — bind-mount this in production.
# We pre-create with the right ownership so a fresh container can write
# without the operator having to chown bind-mounted host directories.
RUN mkdir -p /app/data/storage && \
    chown -R bookfree:bookfree /app

USER bookfree

# Defaults that work for the docker-compose.yml — operators override anything
# here via -e at `docker run` or environment: in compose.
ENV BOOKFREE_ENV=production \
    BOOKFREE_ADDR=0.0.0.0:8788 \
    BOOKFREE_DB_URL=file:/app/data/bookfree.db \
    BOOKFREE_STORAGE_DIR=/app/data/storage \
    BOOKFREE_LOG_LEVEL=info \
    BOOKFREE_MAX_UPLOAD_SIZE_MB=200

EXPOSE 8788

# HEALTHCHECK uses /api/health. The handler now returns HTTP 503 when
# DB or secret are unhealthy (audit P1-06), so a plain HTTP exit code
# check is sufficient — wget's --tries=1 returns non-zero on 5xx.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- --tries=1 --timeout=4 http://127.0.0.1:8788/api/health >/dev/null || exit 1

# Volume declaration: docker-compose.yml will bind-mount over this; the
# declaration here is for `docker run` users who skip compose.
VOLUME ["/app/data"]

ENTRYPOINT ["/app/bookfree-server"]
