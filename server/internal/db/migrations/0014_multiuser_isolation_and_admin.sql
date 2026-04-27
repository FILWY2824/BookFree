-- Stage 14: Multi-user isolation hardening + tables for admin panel (problem 5).
--
-- This migration does five things:
--
-- 1. COMPOSITE INDEXES on (user_id, ...) for hot paths — improves lookup speed
--    AND makes per-user scans cheap when the DB grows across many users.
--
-- 2. Adds an `owner_ns` virtual namespace column on `book_assets` that MUST
--    match `users/<user_id>/books/<book_id>/` prefix of storage_key.
--    Enforced at DAL write time + validated here.
--
-- 3. Creates `audit_logs` table for user behaviour logs (login, upload,
--    admin actions, etc.) keyed by actor_user_id + ip + user_agent + time.
--    Needed by problem 5's admin panel.
--
-- 4. Creates `app_config` table for runtime-editable configuration that
--    problem 5's admin panel will write to. This is the "single source of
--    truth" that SUPERSEDES .env variables — see src/lib/config/index.js
--    for precedence rules (DB > env > default).
--
-- 5. Creates `user_storage_roots` to pin each user to their own data
--    directory prefix. Protects against any future refactor accidentally
--    co-mingling user data.

-- ── 1. Composite indexes for user-scoped hot paths ──────────────────────
CREATE INDEX IF NOT EXISTS idx_highlights_user_book_updated
  ON highlights (user_id, book_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notes_user_book_updated
  ON notes (user_id, book_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chapters_user_book_ord
  ON book_chapters (user_id, book_id, ord);

CREATE INDEX IF NOT EXISTS idx_chunks_user_book_ord
  ON book_chunks (user_id, book_id, ord);

CREATE INDEX IF NOT EXISTS idx_assets_user_book
  ON book_assets (user_id, book_id);

CREATE INDEX IF NOT EXISTS idx_jobs_user_book
  ON ingestion_jobs (user_id, book_id);

CREATE INDEX IF NOT EXISTS idx_progress_user_book
  ON reading_progress (user_id, book_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON chat_sessions (user_id, updated_at DESC);

-- ── 2. Storage namespace integrity ─────────────────────────────────────
-- The DAL ensures storage keys are always `users/<user_id>/books/<book_id>/...`
-- This trigger validates that at INSERT time as a last line of defense.
CREATE TRIGGER IF NOT EXISTS book_assets_enforce_user_namespace
  BEFORE INSERT ON book_assets
  FOR EACH ROW
  WHEN NEW.storage_key NOT LIKE 'users/' || NEW.user_id || '/books/' || NEW.book_id || '/%'
BEGIN
  SELECT RAISE(ABORT, 'book_assets.storage_key must start with users/<user_id>/books/<book_id>/');
END;

-- ── 3. Audit log table (for problem 5 admin panel) ──────────────────────
-- Records every security-relevant action. Keyed by both user (the actor)
-- and target (if the action touched another user's data — rare, admin-only).
-- Retention policy is enforced by admin-initiated purge; no TTL here.
CREATE TABLE IF NOT EXISTS audit_logs (
  id              TEXT PRIMARY KEY,
  actor_user_id   TEXT,                                 -- who did it (nullable: anonymous failed-login)
  actor_email     TEXT,                                 -- snapshot at log time
  actor_role      TEXT,                                 -- 'user' | 'admin' | null
  action          TEXT NOT NULL,                        -- 'login', 'logout', 'login_failed',
                                                        -- 'book_upload', 'book_delete',
                                                        -- 'admin_config_update',
                                                        -- 'admin_user_update', 'admin_user_delete', etc.
  target_kind     TEXT,                                 -- 'user' | 'book' | 'config' | etc.
  target_id       TEXT,                                 -- id of affected entity
  metadata        TEXT,                                 -- JSON: diff/details/path/etc.
  ip              TEXT,
  user_agent      TEXT,
  status          TEXT NOT NULL DEFAULT 'success',      -- 'success' | 'failure'
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_audit_actor_time
  ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_time
  ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time
  ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target
  ON audit_logs (target_kind, target_id);

-- ── 4. Runtime-editable configuration table ─────────────────────────────
-- Admin panel writes here; app reads via src/lib/config/index.js which
-- layers: DB (if present) > env var > compile-time default.
--
-- `value_enc` stores values that are AES-GCM encrypted (API keys, SMTP
-- password, etc). `is_secret` tells the admin UI whether to mask.
CREATE TABLE IF NOT EXISTS app_config (
  key            TEXT PRIMARY KEY,                      -- e.g. 'ALLOW_REGISTRATION', 'AI_GLOBAL_RATE_LIMIT'
  value          TEXT,                                  -- plaintext value (null if is_secret=1 and set)
  value_enc      TEXT,                                  -- AES-GCM ciphertext (null if not secret)
  value_kind     TEXT NOT NULL DEFAULT 'string',        -- 'string'|'int'|'bool'|'json'
  is_secret      INTEGER NOT NULL DEFAULT 0,            -- UI masks + writes go to value_enc
  description    TEXT,                                  -- shown in admin UI
  updated_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_app_config_updated
  ON app_config (updated_at DESC);

-- ── 5. Per-user storage root pinning ────────────────────────────────────
-- Redundant with `users/<user_id>/` prefix convention but gives the admin
-- panel a single table to audit "what directory belongs to whom" without
-- scanning the filesystem. Also supports future S3 bucket partitioning.
CREATE TABLE IF NOT EXISTS user_storage_roots (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  root_prefix    TEXT NOT NULL UNIQUE,                  -- e.g. 'users/<ulid>/'
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Back-fill for existing users (idempotent — UNIQUE prevents duplicates).
INSERT OR IGNORE INTO user_storage_roots (user_id, root_prefix)
SELECT id, 'users/' || id || '/' FROM users;

-- ── 6. User active/suspended flag (for admin panel) ─────────────────────
-- Problem 5's admin panel needs to suspend users without deleting their
-- data. Added here so the DB is ready when the UI lands.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  -- 'active' | 'suspended' | 'deleted'

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);

UPDATE _meta SET value = '14', updated_at = unixepoch() WHERE key = 'schema_version';
