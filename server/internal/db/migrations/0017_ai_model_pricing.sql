-- ─────────────────────────────────────────────────────────────────────────
-- 0017_ai_model_pricing.sql — admin-editable per-model pricing
-- ─────────────────────────────────────────────────────────────────────────
--
-- Previously `MODEL_PRICING` was a hardcoded object in src/lib/limits/ai.js.
-- That meant:
--   • New models shipping after a release required a code push.
--   • Custom / self-hosted / regional providers (Volcano, Doubao, DeepSeek,
--     Qwen, local OpenAI-compatible proxies) could never be priced
--     accurately because only admins know their real rates.
--   • Admins could not see or audit what each model was being charged at.
--
-- This migration creates `ai_model_pricing` so admins can manage prices
-- from the admin UI (similar to "newapi" / one-api style dashboards).
--
-- Convention: prices are stored as USD per 1,000,000 tokens (the "per 1M"
-- unit most AI providers quote). The code divides by 1e6 at cost time.
-- Storing integers/rationals with 6-decimal precision as REAL is fine for
-- this — the bill numbers are low-dollar, and doubles have 15 digits of
-- precision.
--
-- The row matches by BOTH exact model name AND optional provider_type.
-- If `provider_type` is NULL the row is a GLOBAL pricing fallback that
-- matches any provider. Lookup precedence at runtime (see aiModelPricing.js):
--
--   1. (provider_type, model)  exact match
--   2. (NULL,          model)  global match
--   3. (provider_type, prefix) prefix match (e.g. "gpt-4o*" → "gpt-4o-mini-2024-…")
--   4. (NULL,          prefix) global prefix match
--   5. env fallback (legacy AI_INPUT_COST_PER_1K_TOKENS_USD)
--   6. hardcoded registry fallback
--
-- Prefix matching is done in code via SUBSTR/LIKE on the server; we index
-- on model name for direct hits.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_model_pricing (
  id                TEXT PRIMARY KEY,
  -- Model identifier as returned by the provider API (e.g. "gpt-4o-mini",
  -- "claude-sonnet-4-20250514", "doubao-1.5-pro-32k"). Case-sensitive.
  model             TEXT NOT NULL,
  -- Optional narrowing: only match when the resolved provider is of this
  -- kind. NULL means "match any provider". Useful when the same model
  -- name is served at different prices by different providers (e.g. a
  -- proxy offering "gpt-4o" at a markup).
  provider_type     TEXT,
  -- If 1, the `model` column is treated as a prefix (matches when the
  -- runtime model name STARTS WITH this value). Lets admins define a
  -- single row for model families like "gpt-4o-*".
  is_prefix         INTEGER NOT NULL DEFAULT 0,
  -- Prices in USD per 1,000,000 tokens. The admin UI lets the operator
  -- enter "$2.50 / 1M" style numbers directly.
  input_per_1m_usd  REAL NOT NULL DEFAULT 0,
  output_per_1m_usd REAL NOT NULL DEFAULT 0,
  -- Admin-facing notes (e.g. "2025-02 official", "proxy markup 20%").
  note              TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  -- 'system' = seeded by the app, 'custom' = added by admin. Seeded rows
  -- are re-synced on boot (idempotent INSERT OR IGNORE), but admin edits
  -- to them are preserved by ON CONFLICT DO NOTHING.
  source            TEXT NOT NULL DEFAULT 'custom',
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by        TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Uniqueness: one active row per (model, provider_type, is_prefix) tuple.
-- We keep disabled rows as history so admin can toggle without losing the
-- previous price.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_pricing_uniq
  ON ai_model_pricing (model, COALESCE(provider_type, ''), is_prefix);

CREATE INDEX IF NOT EXISTS idx_ai_model_pricing_enabled
  ON ai_model_pricing (enabled, model);

UPDATE _meta SET value = '17', updated_at = unixepoch() WHERE key = 'schema_version';
