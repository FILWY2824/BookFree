// 中文导读：
// crypto.go 提供加密/解密等底层安全工具。
// 它通常不会直接处理 HTTP 请求，而是被 AI Provider、配置存储等模块调用，用来保护敏感字段。
// 安全代码要避免“自己发明算法”，应优先使用 Go 标准库成熟算法。
// 如果你要改加密格式，需要考虑数据库中已经保存的旧密文如何迁移。

// AES-256-GCM with the exact envelope the Next.js code emitted:
//
//	"v1:" + base64( iv(12) || tag(16) || ciphertext )
//
// See src/lib/dal/aiProviders.js#encryptKey for the JS reference.
// Failing to match this byte-for-byte means existing api_key_enc rows
// stop decrypting after the cutover and operators have to re-enter
// every API key. We do NOT want that.
package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
)

const (
	aesGCMNonceLen = 12
	aesGCMTagLen   = 16
)

// Encrypt produces a "v1:..." envelope. plaintext == "" returns an
// empty string (the JS code returns null; both DALs treat empty as
// "no secret stored").
func Encrypt(d *KeyDeriver, purpose, plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	key, err := d.Derive(purpose)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, aesGCMNonceLen)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	// gcm.Seal returns ciphertext||tag — we need the tag separately
	// because the JS layout is iv||tag||ciphertext, not the more
	// common iv||ciphertext||tag.
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	if len(sealed) < aesGCMTagLen {
		return "", errors.New("security: gcm seal produced short output")
	}
	ct := sealed[:len(sealed)-aesGCMTagLen]
	tag := sealed[len(sealed)-aesGCMTagLen:]

	out := make([]byte, 0, aesGCMNonceLen+aesGCMTagLen+len(ct))
	out = append(out, iv...)
	out = append(out, tag...)
	out = append(out, ct...)
	return "v1:" + base64.StdEncoding.EncodeToString(out), nil
}

// Decrypt accepts both the "v1:" prefixed format and the legacy bare
// base64 (some early ciphertexts in the JS code path didn't have the
// version tag). Returns "" if the input is empty so callers can pass
// through nullable columns without branching.
func Decrypt(d *KeyDeriver, purpose, envelope string) (string, error) {
	if envelope == "" {
		return "", nil
	}
	body := strings.TrimPrefix(envelope, "v1:")

	raw, err := base64.StdEncoding.DecodeString(body)
	if err != nil {
		return "", err
	}
	if len(raw) < aesGCMNonceLen+aesGCMTagLen {
		return "", errors.New("security: ciphertext too short")
	}
	iv := raw[:aesGCMNonceLen]
	tag := raw[aesGCMNonceLen : aesGCMNonceLen+aesGCMTagLen]
	ct := raw[aesGCMNonceLen+aesGCMTagLen:]

	key, err := d.Derive(purpose)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	// Reassemble into the layout cipher.AEAD expects (ct||tag).
	sealed := make([]byte, 0, len(ct)+len(tag))
	sealed = append(sealed, ct...)
	sealed = append(sealed, tag...)
	pt, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// MaskKey returns a "abcd••••wxyz"-style preview suitable for UI
// display. Matches the legacy maskKey() exactly.
func MaskKey(key string) string {
	if len(key) < 8 {
		return "••••••••"
	}
	return key[:4] + "••••" + key[len(key)-4:]
}
