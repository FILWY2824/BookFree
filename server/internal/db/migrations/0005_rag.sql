-- Stage 5: chunks (with optional embeddings), chat sessions, chat messages.
-- Note: book_chapters was created lazily by Stage 2 ingest; we add an idempotent
-- create here for environments that ran 0005 before any ingest.

CREATE TABLE IF NOT EXISTS book_chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  title TEXT,
  href TEXT,
  html TEXT,
  text TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON book_chapters(book_id, ord);
CREATE INDEX IF NOT EXISTS idx_chapters_user ON book_chapters(user_id);

CREATE TABLE IF NOT EXISTS book_chunks (
  id           TEXT PRIMARY KEY,
  book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chapter_id   TEXT,                              -- references book_chapters.id (no FK to allow lazy creation)
  chapter_ord  INTEGER,
  page_no      INTEGER,
  ord          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  embedding    BLOB,                              -- F32 vector packed; null if AI unavailable at index time
  embed_model  TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chunks_book ON book_chunks(book_id, ord);
CREATE INDEX IF NOT EXISTS idx_chunks_user ON book_chunks(user_id);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id     TEXT REFERENCES books(id) ON DELETE SET NULL,  -- null = library scope
  scope       TEXT NOT NULL,                      -- 'current_book' | 'current_book_with_notes' | 'user_library'
  title       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_recent ON chat_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                      -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  citations   TEXT,                               -- JSON
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at);

UPDATE _meta SET value = '5', updated_at = unixepoch() WHERE key = 'schema_version';
