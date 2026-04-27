-- Stage 4: highlights, notes. Sync model: cloud is source of truth;
-- clients send updated_at with writes for last-write-wins conflict resolution.
-- Idempotency_key lets clients safely retry without duplicating rows.

CREATE TABLE IF NOT EXISTS highlights (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id         TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id      TEXT,                           -- nullable for PDF-style books
  page_no         INTEGER,
  locator         TEXT NOT NULL,                  -- format-specific anchor (e.g. cfi or text-search hash)
  selected_text   TEXT NOT NULL,                  -- snapshot for survival across reflows
  color           TEXT NOT NULL DEFAULT 'yellow', -- yellow|red|green|blue|purple
  idempotency_key TEXT,                           -- client-supplied dedupe key
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at      INTEGER                         -- soft delete for sync
);

CREATE INDEX IF NOT EXISTS idx_hl_user_book ON highlights(user_id, book_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hl_idem ON highlights(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notes (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id         TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  highlight_id    TEXT REFERENCES highlights(id) ON DELETE SET NULL,
  chapter_id      TEXT,
  page_no         INTEGER,
  locator         TEXT NOT NULL,
  selected_text   TEXT,                           -- optional snapshot when note is anchored
  body            TEXT NOT NULL,
  idempotency_key TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notes_user_book ON notes(user_id, book_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_user_recent ON notes(user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notes_idem ON notes(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

UPDATE _meta SET value = '4', updated_at = unixepoch() WHERE key = 'schema_version';
