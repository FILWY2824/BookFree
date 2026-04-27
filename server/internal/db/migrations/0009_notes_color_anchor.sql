-- Stage 9: add missing anchor_text and color columns to notes table.
-- These columns are referenced by the DAL but were missing from the original schema.

ALTER TABLE notes ADD COLUMN anchor_text TEXT;
ALTER TABLE notes ADD COLUMN color TEXT NOT NULL DEFAULT 'yellow';

UPDATE _meta SET value = '9', updated_at = unixepoch() WHERE key = 'schema_version';
