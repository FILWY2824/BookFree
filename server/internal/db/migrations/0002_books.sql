-- Stage 2: books, ingestion_jobs, book_assets

CREATE TABLE IF NOT EXISTS books (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  authors         TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  language        TEXT,
  publisher       TEXT,
  cover_storage_key TEXT,                      -- key for cover image in storage
  format          TEXT NOT NULL,               -- 'epub' | 'pdf' | 'mobi' | 'azw' | 'azw3' | 'fb2' | 'fbz' | 'cbz'
  size_bytes      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'uploaded',
                  -- 'uploaded' | 'parsing' | 'chunking' | 'indexing' | 'ready' | 'failed'
  error           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);

-- Each book has at least one asset (the original file). Future: extracted images, derived formats.
CREATE TABLE IF NOT EXISTS book_assets (
  id              TEXT PRIMARY KEY,
  book_id         TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- denormalized for fast scoping
  kind            TEXT NOT NULL,               -- 'original' | 'cover' | 'extracted'
  storage_key     TEXT NOT NULL UNIQUE,
  content_type    TEXT,
  size_bytes      INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_assets_book ON book_assets(book_id);
CREATE INDEX IF NOT EXISTS idx_assets_user ON book_assets(user_id);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id              TEXT PRIMARY KEY,
  book_id         TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state           TEXT NOT NULL DEFAULT 'pending',
                  -- 'pending' | 'parsing' | 'chunking' | 'indexing' | 'done' | 'failed'
  attempt         INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  started_at      INTEGER,
  finished_at     INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_jobs_book ON ingestion_jobs(book_id);
CREATE INDEX IF NOT EXISTS idx_jobs_user_state ON ingestion_jobs(user_id, state);

UPDATE _meta SET value = '2', updated_at = unixepoch() WHERE key = 'schema_version';
