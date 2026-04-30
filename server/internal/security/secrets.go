// 中文导读：
// secrets.go 负责处理应用密钥、环境变量密钥、敏感配置校验等安全基础能力。
// BookFree 后端会用 AppSecret 派生加密密钥，用于保护数据库里的第三方 AI Provider Key 等敏感信息。
// 生产环境必须使用足够长、随机、稳定的密钥；如果频繁更换，旧数据可能无法解密。
// 这里属于部署安全的关键位置，改动时要同时检查 .env.example、README/DOCKER 文档是否需要同步。

// Package security mirrors the cryptographic primitives the Next.js
// codebase used so old ciphertexts (AI provider keys, app_config
// secrets, OAuth tokens stored on sessions) keep decrypting after the
// Go cutover. Every parameter here is a bit-for-bit match for
// src/lib/auth/secrets.js + src/lib/dal/aiProviders.js in the legacy
// project; do NOT change them without also writing a re-encryption
// migration.
package security

import (
	"crypto/sha256"
	"errors"
	"sync"

	"golang.org/x/crypto/scrypt"
)

// Master secret discovery order — must match src/lib/auth/secrets.js
// LEGACY_NAMES exactly so a deployment that has been running the old
// project keeps decrypting on the new one.
var legacyEnvNames = []string{
	"QS_MASTER_SECRET",
	"APP_SECRET",
	"NEXTAUTH_SECRET",
	"SESSION_SECRET",
	"QS_CONFIG_SECRET",
}

// LegacyEnvNames is exported for the config layer so the documented
// fallback chain stays in one place.
func LegacyEnvNames() []string { return append([]string{"BOOKFREE_APP_SECRET"}, legacyEnvNames...) }

// DevFallback is the literal string the old code used when NODE_ENV is
// not "production" and no secret is set. Reproducing it ensures dev
// databases created on the old stack still decrypt on the new one.
const DevFallback = "qishu-reader-DEV-INSECURE-key-DO-NOT-USE-IN-PRODUCTION"

// scrypt parameters — see src/lib/auth/secrets.js.
const (
	scryptN      = 16384
	scryptR      = 8
	scryptP      = 1
	scryptKeyLen = 32
)

type KeyDeriver struct {
	master []byte
	mu     sync.Mutex
	cache  map[string][]byte
}

// NewKeyDeriver creates a deriver with a master secret. Pass an empty
// string to use the dev fallback (only acceptable outside production —
// the config layer enforces that rule before we get here).
func NewKeyDeriver(master string) *KeyDeriver {
	if master == "" {
		master = DevFallback
	}
	return &KeyDeriver{
		master: []byte(master),
		cache:  make(map[string][]byte),
	}
}

// Derive returns the 32-byte AES-256 key for a purpose. Cached because
// scrypt is intentionally slow.
//
// The salt construction (sha256("qishu:salt:" + purpose)) is what makes
// the derived keys cryptographically independent across purposes — a
// leak of one does not compromise the others.
func (d *KeyDeriver) Derive(purpose string) ([]byte, error) {
	if purpose == "" {
		return nil, errors.New("security: derive requires non-empty purpose")
	}
	d.mu.Lock()
	if k, ok := d.cache[purpose]; ok {
		d.mu.Unlock()
		return k, nil
	}
	d.mu.Unlock()

	saltSrc := sha256.Sum256([]byte("qishu:salt:" + purpose))
	key, err := scrypt.Key(d.master, saltSrc[:], scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return nil, err
	}

	d.mu.Lock()
	d.cache[purpose] = key
	d.mu.Unlock()
	return key, nil
}

// HasRealSecret reports whether the configured master is something
// other than the dev fallback. Used by /api/health and the admin panel.
func (d *KeyDeriver) HasRealSecret() bool {
	return string(d.master) != DevFallback
}

// Purpose constants. Must match the strings passed to deriveKey() in
// the legacy JS, or ciphertexts produced there will not decrypt here.
const (
	PurposeAIProvider = "ai-provider"
	PurposeAppConfig  = "app-config"
	PurposeOAuth      = "oauth-tokens"
)
