package httpsrv

import (
	"net/http"
	"sync"
	"time"

	"bookfree/internal/response"
)

// rateLimiter is a simple token-bucket per key. It exists to satisfy
// audit P1-02: login/register/upload need at least IP-level rate
// limiting so an attacker can't bcrypt-bomb the server or storage-bomb
// the disk.
//
// We deliberately keep this in-process. A multi-instance deployment
// would benefit from Redis, but BookFree's target is a single small VPS
// where the local map is more than enough — and adding Redis would
// triple the operational footprint.
//
// Concurrency: a single sync.Mutex protects the map. The work inside
// the lock is O(1) per request (map lookup + a few arithmetic ops), so
// even at hundreds of req/s this is invisible compared to disk and
// bcrypt cost.
type rateLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	max      float64
	refill   float64 // tokens per second
	lastSwp  time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

// newRateLimiter returns a limiter that allows `max` events in any
// `window`-second sliding span, refilling continuously.
func newRateLimiter(max int, window time.Duration) *rateLimiter {
	if max <= 0 {
		max = 1
	}
	if window <= 0 {
		window = time.Minute
	}
	return &rateLimiter{
		buckets: make(map[string]*bucket),
		max:     float64(max),
		refill:  float64(max) / window.Seconds(),
		lastSwp: time.Now(),
	}
}

// allow consumes one token from key's bucket if available. Returns true
// if the request should proceed.
func (rl *rateLimiter) allow(key string, now time.Time) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	// Periodic sweep to garbage-collect stale buckets so the map
	// doesn't grow unbounded under attack. Cheap because we sweep at
	// most once a minute regardless of request rate.
	if now.Sub(rl.lastSwp) > time.Minute {
		cutoff := now.Add(-10 * time.Minute)
		for k, b := range rl.buckets {
			if b.last.Before(cutoff) {
				delete(rl.buckets, k)
			}
		}
		rl.lastSwp = now
	}

	b, ok := rl.buckets[key]
	if !ok {
		rl.buckets[key] = &bucket{tokens: rl.max - 1, last: now}
		return true
	}
	elapsed := now.Sub(b.last).Seconds()
	b.tokens += elapsed * rl.refill
	if b.tokens > rl.max {
		b.tokens = rl.max
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// RateLimit returns middleware that admits at most `max` requests per
// window per key. The key function decides what to bucket on — typically
// a normalised client IP via TrustedProxyResolver, but the sign-in
// path also keys on the email so a single IP brute-forcing one account
// gets rejected even when distributing over many addresses.
func RateLimit(max int, window time.Duration, key func(*http.Request) string) func(http.Handler) http.Handler {
	rl := newRateLimiter(max, window)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			k := key(r)
			if k == "" {
				next.ServeHTTP(w, r)
				return
			}
			if !rl.allow(k, time.Now()) {
				w.Header().Set("Retry-After", "60")
				response.Fail(w, http.StatusTooManyRequests, response.CodeRateLimited,
					"操作过于频繁，请稍后再试")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// IPKey is a convenience key extractor for RateLimit that uses the
// trusted-proxy-aware client IP.
func IPKey(resolveIP func(*http.Request) string) func(*http.Request) string {
	if resolveIP == nil {
		return func(r *http.Request) string { return r.RemoteAddr }
	}
	return func(r *http.Request) string {
		ip := resolveIP(r)
		// Strip port if present.
		if idx := indexLastByte(ip, ':'); idx >= 0 {
			// Watch for IPv6 — bracketed form, multiple colons.
			if !looksLikeIPv6(ip) {
				return ip[:idx]
			}
		}
		return ip
	}
}

func indexLastByte(s string, b byte) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func looksLikeIPv6(s string) bool {
	colons := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			colons++
			if colons > 1 {
				return true
			}
		}
	}
	return false
}
