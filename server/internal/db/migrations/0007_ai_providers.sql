-- Phase 5: AI Provider 配置中心
-- 兼容本地 SQLite

CREATE TABLE IF NOT EXISTS ai_provider_profiles (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider_type   TEXT NOT NULL,
  label           TEXT NOT NULL,
  base_url        TEXT,
  api_key_enc     TEXT,
  chat_model      TEXT,
  embedding_model TEXT,
  organization    TEXT,
  project         TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  is_system       INTEGER NOT NULL DEFAULT 0,
  default_for_chat      INTEGER NOT NULL DEFAULT 0,
  default_for_embedding INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_providers_user   ON ai_provider_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_providers_system ON ai_provider_profiles(is_system, enabled);

CREATE TABLE IF NOT EXISTS user_ai_preferences (
  user_id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefer_own_key           INTEGER NOT NULL DEFAULT 0,
  default_chat_profile_id  TEXT REFERENCES ai_provider_profiles(id) ON DELETE SET NULL,
  default_embed_profile_id TEXT REFERENCES ai_provider_profiles(id) ON DELETE SET NULL,
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);

UPDATE _meta SET value = '7', updated_at = unixepoch() WHERE key = 'schema_version';
