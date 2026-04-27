// Package health backs /api/health.
package health

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"runtime"
	"time"

	"bookfree/internal/security"
)

type Handler struct {
	DB        *sql.DB
	StartedAt time.Time
	Version   string
	Deriver   *security.KeyDeriver
}

// HandleGet → GET /api/health
//
// Returns HTTP 200 + ok envelope when both DB and secret are healthy,
// HTTP 503 + fail envelope otherwise (audit P1-06: load balancers and
// external probes need a non-2xx signal — JSON body alone is not
// enough). The body still carries the same {ok, data:{...}} shape so
// existing callers parsing it keep working.
func (h *Handler) HandleGet(w http.ResponseWriter, r *http.Request) {
	dbOK := true
	if h.DB != nil {
		if err := h.DB.PingContext(r.Context()); err != nil {
			dbOK = false
		}
	}
	secretOK := h.Deriver == nil || h.Deriver.HasRealSecret()
	uptimeSec := int64(time.Since(h.StartedAt).Seconds())

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	allOK := dbOK && secretOK
	body := map[string]any{
		"ok": allOK,
		"data": map[string]any{
			"status":    boolToStatus(allOK),
			"version":   h.Version,
			"goVersion": runtime.Version(),
			"uptimeSec": uptimeSec,
			"db":        boolToStatus(dbOK),
			"secret":    boolToStatus(secretOK),
			"mem": map[string]any{
				"heapMb":     bytesToMB(ms.HeapAlloc),
				"heapSysMb":  bytesToMB(ms.HeapSys),
				"sysMb":      bytesToMB(ms.Sys),
				"stackMb":    bytesToMB(ms.StackSys),
				"numGc":      ms.NumGC,
				"goroutines": runtime.NumGoroutine(),
			},
		},
	}

	status := http.StatusOK
	if !allOK {
		status = http.StatusServiceUnavailable
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func boolToStatus(b bool) string {
	if b {
		return "ok"
	}
	return "fail"
}

func bytesToMB(n uint64) float64 {
	return float64(n) / (1024.0 * 1024.0)
}
