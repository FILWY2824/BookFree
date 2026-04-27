-- Alma Reader — initial schema (Stage 0 placeholder).
-- Real tables (users, books, ingestion_jobs, highlights, notes, etc.) land in Stage 1+.
-- This migration just creates a meta table so we can verify migrate.js works end-to-end.

CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR REPLACE INTO _meta (key, value, updated_at)
VALUES ('schema_version', '0', unixepoch());
