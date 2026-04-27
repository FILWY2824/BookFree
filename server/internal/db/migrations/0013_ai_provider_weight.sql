-- Stage 13: AI provider load-balancing weight.
-- When multiple SYSTEM-level providers exist, resolveChatProvider will
-- pick one via weighted-random selection using this column. Default of 1
-- means "equal weight" — setting 0 effectively disables a provider
-- without touching the `enabled` flag (useful for canary roll-backs).
--
-- User-level providers ignore this column (weight only applies to the
-- system-wide pool, which is what the admin panel manages).

ALTER TABLE ai_provider_profiles ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_providers_weight
  ON ai_provider_profiles (is_system, enabled, weight);

UPDATE _meta SET value = '13', updated_at = unixepoch() WHERE key = 'schema_version';
