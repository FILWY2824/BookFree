-- Stage 3: per-user, per-book reading progress.

CREATE TABLE IF NOT EXISTS reading_progress (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  -- locator: opaque per-format pointer (e.g. chapter id for EPUB, page no for PDF)
  locator       TEXT,
  chapter_order INTEGER,
  page_no       INTEGER,
  percent       REAL NOT NULL DEFAULT 0,
  last_read_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_user_recent ON reading_progress(user_id, last_read_at DESC);

UPDATE _meta SET value = '3', updated_at = unixepoch() WHERE key = 'schema_version';
