-- ─────────────────────────────────────────────────────────────────────────
-- 0018_oauth_session_tokens.sql — store OAuth tokens with each session so
-- we can detect provider-side revocation ("user revoked the app at
-- 栖枢/QiShu → our local session should die too").
-- ─────────────────────────────────────────────────────────────────────────
--
-- Problem:
--   Before this migration, OAuth was strictly a login bootstrap. Once the
--   callback exchanged the code for a local session cookie, we threw away
--   the `access_token` and `refresh_token`. That meant when a user went
--   to QiShu and clicked "撤销对 QiShu Reader 的授权", we had no way of
--   knowing — the local session cookie stayed valid for its full TTL
--   (weeks). The user was already gone upstream but still signed in here.
--
-- Fix:
--   Persist access_token + refresh_token (encrypted at rest with the
--   same scrypt-derived 'oauth-tokens' key used nowhere else, so a leak
--   of app_config or ai_provider keys cannot decrypt tokens).
--
--   On session lookup, if the row has OAuth tokens AND last_check_at is
--   more than OAUTH_REVOCATION_CHECK_INTERVAL_SEC ago, we call the
--   provider's /userinfo with the stored access_token. Outcomes:
--     • 200 → user still authorized. Update last_check_at.
--     • 401 with a valid refresh_token → refresh, retry. If that succeeds
--       update the stored tokens. If refresh returns invalid_grant →
--       provider has revoked; DELETE THIS SESSION.
--     • Any other 4xx/5xx → treat as transient; don't nuke the session
--       but also don't update last_check_at (we'll retry next request).
--
-- Privacy / safety:
--   • Tokens never leave the server. Never serialized to the client, never
--     logged. Only the encrypted ciphertext lives in the DB.
--   • The 5-minute check interval bounds the "revocation lag" to 5 min
--     while keeping upstream load to ~1 userinfo call per user per 5 min.
--   • If QS_MASTER_SECRET is rotated, ciphertexts stop decrypting; the
--     next check will see a decrypt failure and DELETE the session,
--     forcing a fresh OAuth login. Correct, intentional behaviour.

ALTER TABLE sessions ADD COLUMN oauth_provider TEXT;
ALTER TABLE sessions ADD COLUMN oauth_access_token_enc  TEXT;
ALTER TABLE sessions ADD COLUMN oauth_refresh_token_enc TEXT;
-- Unix timestamp (seconds) when access_token expires. NULL = unknown;
-- we'll probe via userinfo and refresh on 401.
ALTER TABLE sessions ADD COLUMN oauth_access_expires_at  INTEGER;
-- Unix timestamp (seconds) when we last successfully verified the user
-- is still authorized with the OAuth provider.
ALTER TABLE sessions ADD COLUMN oauth_last_check_at      INTEGER;

-- Helpful index for the admin "force-revoke all OAuth sessions for user"
-- path and for bulk periodic checks.
CREATE INDEX IF NOT EXISTS idx_sessions_oauth
  ON sessions (oauth_provider, user_id)
  WHERE oauth_provider IS NOT NULL;

UPDATE _meta SET value = '18', updated_at = unixepoch() WHERE key = 'schema_version';
