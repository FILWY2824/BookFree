-- Stage 21: capture the user-extension columns the legacy code added
-- lazily inside ensureUserExtensions() (src/lib/dal/users.js).
--
-- The legacy approach was to ALTER TABLE on every DB handle and
-- swallow the duplicate-column error. That's fine when there's a
-- single long-lived process; for our migration runner it's cleaner
-- to capture the schema change explicitly so it shows up in the
-- _migrations audit and survives a rebuild from migrations alone.
--
-- can_use_system_ai is the admin-only flag that, when 0, forces the
-- chat layer to refuse the built-in (system) AI for this user. They
-- can still bring their own key. Default 1 preserves existing
-- behaviour for every pre-migration user.

ALTER TABLE users ADD COLUMN can_use_system_ai INTEGER NOT NULL DEFAULT 1;

UPDATE _meta SET value = '21', updated_at = unixepoch() WHERE key = 'schema_version';
