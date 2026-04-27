package httpsrv

import (
	"net/http"
	"testing"
)

func mkReq(remote, xff, xrealip string) *http.Request {
	r, _ := http.NewRequest("GET", "/", nil)
	r.RemoteAddr = remote
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	if xrealip != "" {
		r.Header.Set("X-Real-IP", xrealip)
	}
	return r
}

// Audit P1-03: an attacker spraying X-Forwarded-For directly at the
// server must not be able to poison logs / session-IP fields.
func TestTrustedProxyResolver_NoCidrsIgnoresHeaders(t *testing.T) {
	resolve := TrustedProxyResolver(nil)
	r := mkReq("203.0.113.7:54321", "1.2.3.4", "5.6.7.8")
	if got := resolve(r); got != "203.0.113.7:54321" {
		t.Errorf("expected RemoteAddr unchanged, got %q", got)
	}
}

func TestTrustedProxyResolver_UntrustedRemoteIgnoresHeaders(t *testing.T) {
	cidrs := ParseTrustedProxies("10.0.0.0/8")
	resolve := TrustedProxyResolver(cidrs)
	r := mkReq("203.0.113.7:54321", "1.2.3.4", "5.6.7.8")
	if got := resolve(r); got != "203.0.113.7:54321" {
		t.Errorf("expected RemoteAddr returned for untrusted peer, got %q", got)
	}
}

func TestTrustedProxyResolver_TrustedRemoteHonoursXFF(t *testing.T) {
	cidrs := ParseTrustedProxies("10.0.0.0/8")
	resolve := TrustedProxyResolver(cidrs)
	r := mkReq("10.0.0.5:443", "203.0.113.42, 10.0.0.5", "")
	if got := resolve(r); got != "203.0.113.42" {
		t.Errorf("expected leftmost XFF entry, got %q", got)
	}
}

func TestTrustedProxyResolver_TrustedRemoteFallsBackToXRealIP(t *testing.T) {
	cidrs := ParseTrustedProxies("10.0.0.0/8")
	resolve := TrustedProxyResolver(cidrs)
	r := mkReq("10.0.0.5:443", "", "203.0.113.42")
	if got := resolve(r); got != "203.0.113.42" {
		t.Errorf("expected X-Real-IP, got %q", got)
	}
}

func TestParseTrustedProxies_SingleIPBecomesHostMask(t *testing.T) {
	cidrs := ParseTrustedProxies("127.0.0.1, ::1, 10.0.0.0/8")
	if len(cidrs) != 3 {
		t.Fatalf("expected 3 cidrs, got %d", len(cidrs))
	}
}

func TestParseTrustedProxies_DropsInvalid(t *testing.T) {
	cidrs := ParseTrustedProxies("not-an-ip, 10.0.0.0/8, also-bad/99")
	if len(cidrs) != 1 {
		t.Errorf("expected 1 valid cidr, got %d", len(cidrs))
	}
}

func TestValidRequestID(t *testing.T) {
	cases := map[string]bool{
		"":                    false,
		"abc-123_v1.2":        true,
		"line\nbreak":         false,
		"semi;colon":          false,
		"quote\"":             false,
		"too-long-" + repeat("x", 80): false,
	}
	for in, want := range cases {
		if got := validRequestID(in); got != want {
			t.Errorf("validRequestID(%q) = %v, want %v", in, got, want)
		}
	}
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}
