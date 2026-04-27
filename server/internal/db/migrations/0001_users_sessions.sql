-- Stage 1: users + sessions

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                    -- ULID-like (16 random bytes hex)
  email         TEXT NOT NULL UNIQUE,                -- normalized lowercase
  password_hash TEXT NOT NULL,                       -- bcrypt
  name          TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  role          TEXT NOT NULL DEFAULT 'user',        -- 'user' | 'admin'
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Server-side sessions. Cookie carries the raw token; we store its SHA-256.
-- Revocable, supports multi-device sign-out, no JWT complexity.
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,                    -- random id, also stored in cookie alongside token
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,                       -- sha256 of raw token
  user_agent    TEXT,
  ip            TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

UPDATE _meta SET value = '1', updated_at = unixepoch() WHERE key = 'schema_version';
