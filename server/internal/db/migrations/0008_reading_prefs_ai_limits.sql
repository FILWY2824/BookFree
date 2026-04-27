-- Phase 3: persistent reading prefs + AI quota/rate records

ALTER TABLE reading_preferences ADD COLUMN page_layout TEXT NOT NULL DEFAULT 'single';

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_label    TEXT,
  model             TEXT,
  request_kind      TEXT NOT NULL DEFAULT 'chat',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  completed         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON ai_usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_completed ON ai_usage_events(user_id, completed, created_at DESC);
