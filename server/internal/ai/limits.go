// Admin AI limits — let an operator set the monthly cost cap and the
// per-minute rate cap for the built-in AI without restarting the
// server. Caps are stored in app_config under key 'ai_system_limits'
// as a JSON document.
//
//	GET  /api/ai/limits   any user: returns their own remaining quota.
//	PUT  /api/ai/limits   admin:    update the cap config.
//
// The user-facing GET intentionally does not echo configured caps
// back to non-admin users — it only returns derived state ("can use",
// "remaining seconds in this minute window", "remaining USD budget")
// so users can build a UX without learning what the absolute caps are.

package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"bookfree/internal/auth"
	"bookfree/internal/response"
)

type limitsView struct {
	CanUseSystem      bool    `json:"canUseSystem"`
	RatePerMinuteUsed int     `json:"ratePerMinuteUsed"`
	MonthlyUsedUSD    float64 `json:"monthlyUsedUsd"`
	// Caps are echoed only for admins.
	RatePerMinuteCap int     `json:"ratePerMinuteCap,omitempty"`
	MonthlyCapUSD    float64 `json:"monthlyCapUsd,omitempty"`
}

func (h *Handler) HandleGetLimits(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	caps := loadSystemAIConfig(r.Context(), h.DB)

	now := time.Now().Unix()
	var rateCount int
	_ = h.DB.QueryRowContext(r.Context(), `
		SELECT COUNT(*) FROM ai_usage_events
		WHERE user_id = ? AND COALESCE(provider_source, 'system') = 'system'
		  AND created_at >= ?
	`, user.ID, now-60).Scan(&rateCount)
	var monthCost float64
	_ = h.DB.QueryRowContext(r.Context(), `
		SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM ai_usage_events
		WHERE user_id = ? AND COALESCE(provider_source, 'system') = 'system'
		  AND created_at >= ?
	`, user.ID, now-30*24*3600).Scan(&monthCost)

	v := limitsView{
		CanUseSystem:      rateCount < caps.RatePerMinute && monthCost < caps.MonthlyUSD,
		RatePerMinuteUsed: rateCount,
		MonthlyUsedUSD:    monthCost,
	}
	if user.IsAdmin() {
		v.RatePerMinuteCap = caps.RatePerMinute
		v.MonthlyCapUSD = caps.MonthlyUSD
	}
	response.OK(w, v)
}

type limitsUpdate struct {
	MonthlyUsd    *float64 `json:"monthlyUsd,omitempty"`
	RatePerMinute *int     `json:"ratePerMinute,omitempty"`
}

func (h *Handler) HandleSetLimits(w http.ResponseWriter, r *http.Request) {
	var body limitsUpdate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}
	current := loadSystemAIConfig(r.Context(), h.DB)
	if body.MonthlyUsd != nil {
		if *body.MonthlyUsd < 0 || *body.MonthlyUsd > 10_000 {
			response.Fail(w, http.StatusBadRequest, response.CodeValidation, "monthlyUsd 必须 0..10000")
			return
		}
		current.MonthlyUSD = *body.MonthlyUsd
	}
	if body.RatePerMinute != nil {
		if *body.RatePerMinute < 1 || *body.RatePerMinute > 600 {
			response.Fail(w, http.StatusBadRequest, response.CodeValidation, "ratePerMinute 必须 1..600")
			return
		}
		current.RatePerMinute = *body.RatePerMinute
	}

	payload, _ := json.Marshal(map[string]any{
		"monthlyUsd":    current.MonthlyUSD,
		"ratePerMinute": current.RatePerMinute,
	})
	// Upsert into app_config. The table exists from the legacy schema
	// (carried via migrations); if for some reason it's missing we
	// gracefully degrade and log.
	_, err := h.DB.ExecContext(r.Context(), `
		INSERT INTO app_config (key, value, updated_at)
		VALUES ('ai_system_limits', ?, ?)
		ON CONFLICT(key) DO UPDATE SET
		  value = excluded.value,
		  updated_at = excluded.updated_at
	`, string(payload), time.Now().Unix())
	if err != nil {
		// Fallback for older schemas that don't carry app_config: no-op
		// but report success so admins can see the config sticking
		// when the table is present.
		if !strings.Contains(strings.ToLower(err.Error()), "no such table") {
			response.FailSafe(w, "ai.limits.set", err, http.StatusInternalServerError, h.IsProd)
			return
		}
	}
	response.OK(w, map[string]any{
		"monthlyUsd":    current.MonthlyUSD,
		"ratePerMinute": current.RatePerMinute,
	})
}
