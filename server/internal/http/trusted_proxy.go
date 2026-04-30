// 中文导读：
// trusted_proxy.go 处理“可信反向代理”相关逻辑。
// 当 BookFree 部署在 Nginx、Caddy、Cloudflare、Docker 网关后面时，真实用户 IP 可能在 X-Forwarded-For 等请求头里。
// 不能盲目信任所有代理头，否则攻击者可以伪造 IP 绕过限流或审计。
// 这个文件用于判断哪些代理来源可信，只有可信代理转发的头才应该被采用。
// 如果你调整部署拓扑或 CDN，可能需要同步调整 BOOKFREE_TRUSTED_PROXIES。

package httpsrv

import (
	"net"
	"net/http"
	"strings"
)

// TrustedProxyResolver returns a function that extracts the genuine
// client IP from a request. The semantic the audit requires (P1-03) is:
// only honour X-Forwarded-For / X-Real-IP if the request *actually*
// arrived through a configured trusted proxy.
//
// Behaviour:
//   - cidrs is empty → forwarded headers IGNORED, RemoteAddr returned.
//   - cidrs is non-empty AND RemoteAddr ∈ any cidr →
//     leftmost X-Forwarded-For entry returned (or X-Real-IP fallback).
//   - cidrs is non-empty AND RemoteAddr NOT in any cidr →
//     RemoteAddr returned, forwarded headers ignored.
//
// This means an attacker spraying X-Forwarded-For: 1.2.3.4 directly at
// the server cannot poison logs or session-IP fields; only an
// operator-trusted proxy can.
func TrustedProxyResolver(cidrs []*net.IPNet) func(*http.Request) string {
	return func(r *http.Request) string {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		ip := net.ParseIP(host)
		trusted := false
		if ip != nil {
			for _, c := range cidrs {
				if c.Contains(ip) {
					trusted = true
					break
				}
			}
		}
		if !trusted {
			return r.RemoteAddr
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// Leftmost entry is the originating client per RFC 7239.
			if i := strings.IndexByte(xff, ','); i > 0 {
				return strings.TrimSpace(xff[:i])
			}
			return strings.TrimSpace(xff)
		}
		if xr := r.Header.Get("X-Real-IP"); xr != "" {
			return strings.TrimSpace(xr)
		}
		return r.RemoteAddr
	}
}

// ParseTrustedProxies parses a comma-separated list of CIDRs or single
// IPs. Single-IP entries are converted to /32 (v4) or /128 (v6).
// Invalid entries are dropped with no error returned — operators who
// want strict validation should check the returned slice length.
func ParseTrustedProxies(s string) []*net.IPNet {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	out := make([]*net.IPNet, 0, 4)
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			ip := net.ParseIP(part)
			if ip == nil {
				continue
			}
			if ip.To4() != nil {
				part = part + "/32"
			} else {
				part = part + "/128"
			}
		}
		_, n, err := net.ParseCIDR(part)
		if err == nil {
			out = append(out, n)
		}
	}
	return out
}
