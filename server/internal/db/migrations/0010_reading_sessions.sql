-- Stage 10: Reading sessions for reading statistics (inspired by ReadAny)

CREATE TABLE IF NOT EXISTS reading_sessions (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at    INTEGER,
  duration_s  INTEGER NOT NULL DEFAULT 0,   -- active reading seconds
  pages_read  INTEGER NOT NULL DEFAULT 0,
  start_pct   REAL NOT NULL DEFAULT 0,
  end_pct     REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_rs_user_started ON reading_sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_rs_book ON reading_sessions(book_id, started_at DESC);

UPDATE _meta SET value = '10', updated_at = unixepoch() WHERE key = 'schema_version';
