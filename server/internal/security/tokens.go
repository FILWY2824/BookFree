// 中文导读：
// tokens.go 负责生成随机 token，例如 session token、一次性令牌或其他安全随机字符串。
// 安全 token 必须使用 crypto/rand 这类密码学安全随机源，不能用 math/rand。
// token 长度越短越容易被猜中；长度越长越安全但存储和传输略有成本。
// 如果你新增登录态、邀请链接、邮箱验证等能力，通常会复用这里的 token 生成逻辑。

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
