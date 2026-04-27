-- Stage 12: OAuth (Profile/栖枢) linking columns on users.
-- When a user signs in via the Profile OAuth server, we persist the
-- external subject ID + issuer so the same external account always maps
-- to the same local BookFree user. Password login is unaffected; users
-- provisioned purely via OAuth have a random 'oauth-only' password hash
-- that can never match a real login attempt.

ALTER TABLE users ADD COLUMN oauth_provider TEXT;
ALTER TABLE users ADD COLUMN oauth_sub      TEXT;

-- Combined uniqueness so a given (provider, sub) pair cannot point at
-- two BookFree users. We use a partial index (WHERE oauth_sub IS NOT NULL)
-- because password-only users will never have this column populated.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth
  ON users (oauth_provider, oauth_sub)
  WHERE oauth_sub IS NOT NULL;

UPDATE _meta SET value = '12', updated_at = unixepoch() WHERE key = 'schema_version';
