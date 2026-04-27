-- Phase 5: track whether an AI usage event was served by a system provider
-- or a user-imported one. Used by the stats/rate-limit pages so that only
-- system-provider usage counts toward billable/displayed totals.
-- 'system' | 'user'. Defaults to 'system' for older rows (safe assumption:
-- system-managed usage pre-dated per-user keys).

ALTER TABLE ai_usage_events ADD COLUMN provider_source TEXT NOT NULL DEFAULT 'system';
