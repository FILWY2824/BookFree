# BookFree — convenience targets.
#
# Most operators only need `make build` and `make run`. The rest is
# scaffolding for the migration workflow.

# Pure-Go build was tried, dropped: the wasm-based pure-Go SQLite
# drivers add ~60 MB to RSS just for the wazero runtime. We now use
# mattn/go-sqlite3 (CGO + real libsqlite3), which keeps idle RSS at
# ~32 MB. Trade-off: the binary depends on glibc.
#
# Build tags:
#   sqlite_fts5                 — compile FTS5 in (we use it for /api/search)
#   sqlite_omit_load_extension  — drop SQLite runtime extension API,
#                                 shrinks attack surface
#
# ldflags:
#   -s -w  — strip debug symbols + DWARF, saves ~5 MB on the binary
#
# GOPROXY/GOSUMDB defaults are for restricted-network environments.
# In an open environment override or unset.
GOPROXY ?= direct
GOSUMDB ?= off
GO      ?= go
NPM     ?= npm
GO_BUILD_TAGS    ?= sqlite_fts5 sqlite_omit_load_extension
GO_BUILD_LDFLAGS ?= -s -w
CGO_ENABLED      ?= 1

BINARY  := bookfree-server

.PHONY: all build build-server build-web run test typecheck-web clean migrate backfill help

all: build

help:  ## show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk -F':.*?##' '{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

build: build-web build-server  ## build everything (SPA + binary with embedded SPA)

build-web:  ## build the Vite SPA into apps/web/dist and copy to server/webdist
	cd apps/web && $(NPM) install --no-audit --no-fund --loglevel=error
	cd apps/web && $(NPM) run build
	rm -rf server/webdist/assets server/webdist/index.html
	cp -r apps/web/dist/. server/webdist/

build-server:  ## build the Go binary (assumes server/webdist/ is up-to-date)
	cd server && GOPROXY=$(GOPROXY) GOSUMDB=$(GOSUMDB) CGO_ENABLED=$(CGO_ENABLED) \
		$(GO) build -tags '$(GO_BUILD_TAGS)' -ldflags='$(GO_BUILD_LDFLAGS)' \
		-o ../$(BINARY) ./cmd/bookfree

run: build  ## build then run (env from .env if you source it first)
	./$(BINARY)

test:  ## go test ./...
	cd server && GOPROXY=$(GOPROXY) GOSUMDB=$(GOSUMDB) $(GO) test ./...

typecheck-web:  ## typecheck the SPA without building
	cd apps/web && $(NPM) run typecheck

migrate: build-server  ## apply pending DB migrations
	./$(BINARY) migrate

backfill: build-server  ## populate FTS5 tables from existing rows
	./$(BINARY) backfill-fts

clean:  ## remove the binary and SPA build outputs
	rm -f $(BINARY)
	rm -rf apps/web/dist
	rm -rf server/webdist/assets
