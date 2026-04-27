// Package config reads environment variables with the legacy-fallback
// chain documented in the migration plan §17. Order:
//
//	BOOKFREE_*  (new, preferred)  →  legacy variable names from the
//	                                 Next.js project's .env
//
// Every getter returns the first non-empty value or the documented
// default, so existing deployments need zero changes — operators who
// were running the Next.js app can drop their .env on the new binary
// and it works.
package config

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Env             string
	Addr            string
	PublicURL       string
	DBURL           string
	StorageDriver   string
	StorageDir      string
	AppSecret       string
	SessionCookie   string
	MaxUploadMB     int
	LogLevel        string
	EnablePProf     bool
	WebDistDir      string // optional override for serving frontend from disk during dev
	OpenAIAPIKey    string
	OpenAIModel     string
	AnthropicAPIKey string
	GeminiAPIKey    string
	// TrustedProxies is the raw comma-separated list parsed by
	// httpsrv.ParseTrustedProxies. Set BOOKFREE_TRUSTED_PROXIES when
	// the binary runs behind a reverse proxy whose X-Forwarded-For /
	// X-Real-IP / X-Forwarded-Proto headers should be honoured.
	// Examples: "127.0.0.1,::1" for a sibling proxy on the same host,
	// "10.0.0.0/8,172.16.0.0/12" for a private cluster.
	TrustedProxies string
}

// Load returns a Config populated from the environment. It does no
// validation beyond the "secret must exist in production" rule —
// downstream packages enforce their own constraints.
func Load() (*Config, error) {
	c := &Config{
		Env:             firstNonEmpty("BOOKFREE_ENV", "NODE_ENV", "ENV"),
		Addr:            firstNonEmpty("BOOKFREE_ADDR", "ADDR", "PORT"),
		PublicURL:       firstNonEmpty("BOOKFREE_PUBLIC_URL", "PUBLIC_URL", "NEXT_PUBLIC_URL"),
		DBURL:           firstNonEmpty("BOOKFREE_DB_URL", "TURSO_DATABASE_URL", "DATABASE_URL"),
		StorageDriver:   firstNonEmpty("BOOKFREE_STORAGE_DRIVER", "STORAGE_DRIVER"),
		StorageDir:      firstNonEmpty("BOOKFREE_STORAGE_DIR", "STORAGE_DIR"),
		AppSecret:       firstNonEmpty("BOOKFREE_APP_SECRET", "QS_MASTER_SECRET", "APP_SECRET", "NEXTAUTH_SECRET", "SESSION_SECRET", "QS_CONFIG_SECRET"),
		SessionCookie:   firstNonEmpty("BOOKFREE_SESSION_COOKIE", "AUTH_COOKIE_NAME"),
		LogLevel:        firstNonEmpty("BOOKFREE_LOG_LEVEL", "LOG_LEVEL"),
		WebDistDir:      firstNonEmpty("BOOKFREE_WEBDIST_DIR"),
		OpenAIAPIKey:    firstNonEmpty("OPENAI_API_KEY"),
		OpenAIModel:     firstNonEmpty("OPENAI_MODEL"),
		AnthropicAPIKey: firstNonEmpty("ANTHROPIC_API_KEY"),
		GeminiAPIKey:    firstNonEmpty("GEMINI_API_KEY"),
		TrustedProxies:  firstNonEmpty("BOOKFREE_TRUSTED_PROXIES", "TRUSTED_PROXIES"),
	}

	// Defaults.
	if c.Env == "" {
		c.Env = "development"
	}
	if c.Addr == "" {
		c.Addr = "127.0.0.1:3001"
	} else if !strings.Contains(c.Addr, ":") {
		// allow PORT=3001 style
		c.Addr = "127.0.0.1:" + c.Addr
	}
	if c.DBURL == "" {
		c.DBURL = "file:./data/bookfree.db"
	}
	if c.StorageDriver == "" {
		c.StorageDriver = "local"
	}
	if c.StorageDir == "" {
		c.StorageDir = "./data/storage"
	}
	if c.SessionCookie == "" {
		// Match the Next.js default exactly so cookies set by the old
		// Node server keep working after the cutover.
		c.SessionCookie = "alma_session"
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}

	// Upload limit. Same precedence rule.
	if v := firstNonEmpty("BOOKFREE_MAX_UPLOAD_SIZE_MB", "MAX_UPLOAD_SIZE_MB"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.MaxUploadMB = n
		}
	}
	if c.MaxUploadMB == 0 {
		c.MaxUploadMB = 100
	}

	if v := firstNonEmpty("BOOKFREE_ENABLE_PPROF"); v != "" {
		c.EnablePProf = v == "1" || strings.EqualFold(v, "true")
	}

	// Production hard-stop: a missing secret would silently encrypt with
	// a dev fallback. The JS code does the same; we keep the contract.
	if c.IsProduction() && c.AppSecret == "" {
		return nil, errors.New("config: no master secret configured (set BOOKFREE_APP_SECRET / QS_MASTER_SECRET / APP_SECRET / NEXTAUTH_SECRET / SESSION_SECRET)")
	}

	return c, nil
}

func (c *Config) IsProduction() bool { return c.Env == "production" }

func firstNonEmpty(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}
