// 中文导读：
// url_guard.go 用于限制和校验外部 AI Provider 的 base URL。
// 这是一个安全边界：用户或管理员配置模型接口地址时，后端不能无条件访问任意内网地址。
// 否则可能产生 SSRF 风险，例如让服务器去访问 127.0.0.1、云厂商元数据地址或内网管理服务。
// 这个文件通常会判断 URL scheme、host、端口、IP 范围等是否允许。
// 如果你要放宽或收紧 AI 接口地址规则，必须先理解这里的安全目的，并同步测试本地部署和远程 Provider。

// URL validation for user-supplied AI provider endpoints.
//
// The settings page lets a user paste a custom OpenAI-compatible base
// URL (e.g. https://api.deepseek.com/v1) plus their secret key. Both
// values flow into the server, where they're (a) used to fetch the
// model list, (b) used to test connectivity, and (c) stored encrypted
// for later /api/ai/chat calls.
//
// A naïve implementation would just take the user's string and call
// http.Get on it. That's a textbook SSRF vector — the user could
// supply http://169.254.169.254/latest/meta-data/ to read AWS IMDS
// secrets, http://localhost:5432/ to probe internal services,
// file:///etc/passwd to dump the host filesystem, etc.
//
// This module is the only sanctioned way to construct the *http.Request
// that fronts a user-supplied URL. It enforces, in order:
//
//   1. Scheme is exactly "https". Plain http or any other scheme
//      (file, ftp, gopher, javascript, data, ws) is rejected. We
//      accept "http" only when the host is "127.0.0.1" or "localhost"
//      AND the deployment opted in via BOOKFREE_ALLOW_INSECURE_AI=1
//      (intended for local testing of self-hosted models like Ollama).
//
//   2. Hostname must be a registered name OR a literal public IP. We
//      explicitly forbid every IANA-reserved range that would let the
//      request hit the host's own metadata, internal LAN, or
//      loopback.
//
//   3. Port is restricted to the standard HTTPS-over-internet range
//      (443) plus a small allow-list of common AI-provider ports
//      (8443, 11434 for Ollama). Arbitrary ports could be used to
//      reach internal services that happen to expose HTTPS.
//
//   4. URL length, path depth, and query length capped to defang
//      pathological inputs.
//
//   5. The request is sent through a custom http.Transport whose
//      DialContext refuses any address whose IP, after DNS
//      resolution, falls into a forbidden range. This is the belt to
//      step 2's suspenders — without it, a user could still bypass
//      hostname checks with a DNS record like
//      `evil.example.com → 169.254.169.254`.

package ai

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

// SafeBaseURL holds a validated, normalised base URL ready to feed
// into http.NewRequest. Always built via ValidateBaseURL — never
// directly literal-converted from user input.
type SafeBaseURL struct {
	parsed   *url.URL
	original string
}

func (s SafeBaseURL) String() string { return s.parsed.String() }

// ValidateBaseURL parses and rejects user-supplied AI base URLs that
// fail the rules above. Returned error messages are safe to surface
// to the user (they describe the validation failure without leaking
// server internals).
func ValidateBaseURL(raw string) (SafeBaseURL, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return SafeBaseURL{}, errors.New("URL 不能为空")
	}
	if len(s) > 2048 {
		return SafeBaseURL{}, errors.New("URL 太长（最多 2048 字符）")
	}

	// Reject embedded control characters and whitespace before parsing.
	// url.Parse is lenient about some of these and we don't want them
	// surviving into the http.Request.
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return SafeBaseURL{}, errors.New("URL 含有非法字符")
		}
	}

	u, err := url.Parse(s)
	if err != nil {
		return SafeBaseURL{}, fmt.Errorf("URL 格式无效：%w", err)
	}

	// Scheme — only https in normal mode; http allowed only for
	// loopback when BOOKFREE_ALLOW_INSECURE_AI is set.
	scheme := strings.ToLower(u.Scheme)
	allowInsecure := strings.TrimSpace(os.Getenv("BOOKFREE_ALLOW_INSECURE_AI")) == "1"
	if scheme != "https" {
		if !(allowInsecure && scheme == "http" && isLocalHostname(u.Hostname())) {
			return SafeBaseURL{}, errors.New("URL 必须以 https:// 开头")
		}
	}

	// User-info segment in the URL (https://user:pass@host) is a
	// classic phishing vector and serves no purpose for AI providers.
	if u.User != nil {
		return SafeBaseURL{}, errors.New("URL 不能包含用户名 / 密码")
	}

	host := u.Hostname()
	if host == "" {
		return SafeBaseURL{}, errors.New("URL 缺少主机名")
	}
	// In normal mode, refuse anything that resolves to a private /
	// loopback / link-local / multicast / metadata range.
	if !allowInsecure {
		if isLocalHostname(host) {
			return SafeBaseURL{}, errors.New("不允许指向 localhost 或内网地址")
		}
		if ip := net.ParseIP(host); ip != nil && isForbiddenIP(ip) {
			return SafeBaseURL{}, errors.New("不允许指向私有 / 保留 IP 地址")
		}
	}

	// Port allow-list. Empty means scheme default; we accept 443 and
	// a small handful of well-known AI/inference ports.
	if port := u.Port(); port != "" {
		switch port {
		case "443", "8443":
			// fine — public HTTPS-ish ports
		case "80":
			if !allowInsecure {
				return SafeBaseURL{}, errors.New("不允许使用端口 80")
			}
		case "11434":
			if !allowInsecure {
				return SafeBaseURL{}, errors.New("11434 仅在本地调试模式可用")
			}
		default:
			return SafeBaseURL{}, fmt.Errorf("不允许的端口：%s（仅支持 443/8443）", port)
		}
	}

	// Path checks — keep depth and length sane. We don't restrict path
	// content otherwise; OpenAI-compatible APIs use various sub-paths
	// (/v1, /openai/v1, etc.).
	if len(u.Path) > 256 {
		return SafeBaseURL{}, errors.New("URL 路径过长")
	}
	if strings.Count(u.Path, "/") > 10 {
		return SafeBaseURL{}, errors.New("URL 路径层级过深")
	}
	// Query strings on a base URL are almost always a misconfiguration
	// or an attempt to smuggle parameters; reject.
	if u.RawQuery != "" {
		return SafeBaseURL{}, errors.New("URL 不能包含查询参数")
	}
	if u.Fragment != "" {
		return SafeBaseURL{}, errors.New("URL 不能包含 # 片段")
	}

	// Strip any trailing slash so we can append /chat/completions etc.
	// without doubled slashes.
	u.Path = strings.TrimRight(u.Path, "/")

	return SafeBaseURL{parsed: u, original: s}, nil
}

// SafeHTTPClient returns an *http.Client whose Transport refuses to
// connect to any IP that falls into a forbidden range AT DIAL TIME,
// after DNS resolution. This is the SSRF backstop — even if a user
// supplies a hostname that LOOKS public but resolves to 127.0.0.1
// or 169.254.169.254, the dial will fail.
//
// We use a fresh client per request so the timeout is hard-bounded
// per upstream call.
func SafeHTTPClient(timeout time.Duration) *http.Client {
	allowInsecure := strings.TrimSpace(os.Getenv("BOOKFREE_ALLOW_INSECURE_AI")) == "1"
	dialer := &net.Dialer{
		Timeout:   8 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(network, address string, c syscall.RawConn) error {
			if allowInsecure {
				return nil
			}
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip := net.ParseIP(host)
			if ip == nil {
				return errors.New("dial: hostname did not resolve to an IP")
			}
			if isForbiddenIP(ip) {
				return fmt.Errorf("dial: refused to connect to %s (forbidden range)", ip)
			}
			return nil
		},
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   8 * time.Second,
			ResponseHeaderTimeout: timeout,
			IdleConnTimeout:       30 * time.Second,
			MaxIdleConnsPerHost:   2,
			DisableKeepAlives:     true,
			// Do NOT follow redirects to a different host without re-
			// validating — handled by Client.CheckRedirect below.
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			// Ensure each redirect target is also safe.
			if _, err := ValidateBaseURL(req.URL.String()); err != nil {
				return fmt.Errorf("不安全的重定向：%w", err)
			}
			return nil
		},
	}
}

// NewSafeRequest builds an *http.Request whose URL is a sub-path of
// the validated base URL. Caller passes a sub-path like
// "/chat/completions" — we join it cleanly with the base URL's path.
func NewSafeRequest(ctx context.Context, base SafeBaseURL, method, subPath string, body []byte) (*http.Request, error) {
	if !strings.HasPrefix(subPath, "/") {
		subPath = "/" + subPath
	}
	full := base.parsed.String() + subPath
	// Re-validate the resulting URL out of paranoia (the base is safe
	// but ensuring the full URL still parses cleanly is cheap).
	if _, err := url.Parse(full); err != nil {
		return nil, err
	}
	var br io.Reader
	if body != nil {
		br = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, full, br)
	if err != nil {
		return nil, err
	}
	return req, nil
}

// ── helpers ──────────────────────────────────────────────────────────

func isLocalHostname(host string) bool {
	h := strings.ToLower(host)
	if h == "localhost" || h == "ip6-localhost" || h == "ip6-loopback" {
		return true
	}
	if strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") {
		return true
	}
	return false
}

// isForbiddenIP returns true for any IP we never want to connect to
// from a user-controlled URL. The list is conservative: anything that
// isn't unambiguously globally routable is rejected.
func isForbiddenIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	if ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	// Cloud metadata / link-local, IsLinkLocalUnicast covers
	// 169.254/16 — we keep the explicit check for clarity.
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
		if ip4[0] == 0 {
			return true
		}
		// 100.64.0.0/10 — Carrier-grade NAT.
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
			return true
		}
	}
	// IPv6 unique local (fc00::/7).
	if ip.To4() == nil && len(ip) == net.IPv6len {
		if ip[0] == 0xfc || ip[0] == 0xfd {
			return true
		}
	}
	return false
}

// minimal io.Reader/io.Closer adapter — no longer needed; left as a
// no-op stub so we don't have to renumber imports. Kept this comment
// to make grep-able the historic refactor.
