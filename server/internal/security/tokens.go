package security

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// RandomID returns 16 random bytes hex-encoded — same shape as the
// legacy randomId() in src/lib/auth/session.js. Used as primary keys
// for new rows; existing primary keys keep working unchanged.
func RandomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// RandomToken returns 32 random bytes base64url-encoded WITHOUT
// padding, matching Node's `crypto.randomBytes(32).toString('base64url')`.
// Critical: the cookie format is `${sessionId}.${rawToken}`; if we
// emitted padded base64 the dot split would still work but tokens
// produced on Node would no longer round-trip through Go's strict
// validators.
func RandomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// SHA256Hex computes hex(sha256(s)) — exactly what the legacy
// session.js#sha256 returns. token_hash columns persist this value.
func SHA256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
