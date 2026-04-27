-- Phase 0+1: 细粒度任务进度、阅读偏好、书签、锚点字段
-- 兼容本地 SQLite（不使用 IF NOT EXISTS on ALTER TABLE）

ALTER TABLE ingestion_jobs ADD COLUMN stage           TEXT;
ALTER TABLE ingestion_jobs ADD COLUMN progress_pct    INTEGER DEFAULT 0;
ALTER TABLE ingestion_jobs ADD COLUMN current_step    TEXT;
ALTER TABLE ingestion_jobs ADD COLUMN total_units     INTEGER;
ALTER TABLE ingestion_jobs ADD COLUMN completed_units INTEGER;
ALTER TABLE ingestion_jobs ADD COLUMN error_code      TEXT;
ALTER TABLE ingestion_jobs ADD COLUMN error_message   TEXT;

ALTER TABLE highlights ADD COLUMN anchor_text TEXT;
ALTER TABLE notes      ADD COLUMN anchor_text TEXT;

CREATE TABLE IF NOT EXISTS reading_preferences (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  font_family       TEXT    NOT NULL DEFAULT 'serif',
  font_size         INTEGER NOT NULL DEFAULT 18,
  line_height       REAL    NOT NULL DEFAULT 1.8,
  paragraph_spacing INTEGER NOT NULL DEFAULT 16,
  page_margin       INTEGER NOT NULL DEFAULT 48,
  theme             TEXT    NOT NULL DEFAULT 'light',
  reading_mode      TEXT    NOT NULL DEFAULT 'paged',
  page_animation    TEXT    NOT NULL DEFAULT 'slide',
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chapter_id TEXT,
  page_no    INTEGER,
  locator    TEXT,
  label      TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at DESC);

UPDATE _meta SET value = '6', updated_at = unixepoch() WHERE key = 'schema_version';
