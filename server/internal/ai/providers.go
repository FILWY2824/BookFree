// Custom AI provider profiles — let the user import their own
// OpenAI-compatible endpoint instead of going through the server's
// built-in Anthropic-backed AI.
//
// Endpoints:
//
//	GET    /api/ai/providers                  list user's profiles
//	POST   /api/ai/providers                  create one
//	PUT    /api/ai/providers/{id}             update label / model / set default
//	DELETE /api/ai/providers/{id}             remove one
//
//	GET    /api/ai/providers/{id}/models      pull live model list from upstream
//	POST   /api/ai/test                       test built-in OR a profile
//
// Storage uses the existing `ai_provider_profiles` table from
// migration 0007 (with `weight` from 0013). API keys are encrypted at
// rest via security.Encrypt with purpose "ai-provider".
//
// IMPORTANT — the test endpoint has two modes:
//
//   • Built-in: server uses ANTHROPIC_API_KEY internally and returns
//     ONLY {"ok": true} or {"ok": false, "errorMessage": "<safe>"}.
//     We never expose the actual model identifier or any internal
//     details to the client; the user only learns whether the
//     built-in works or doesn't.
//
//   • Custom: we DO return the model and provider name the user
//     configured, plus a sample echo from the upstream. That's their
//     own data, so no leak.

package ai

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"bookfree/internal/auth"
	"bookfree/internal/response"
	"bookfree/internal/security"
)

// ── DTOs ─────────────────────────────────────────────────────────────

type providerDTO struct {
	ID             string  `json:"id"`
	Label          string  `json:"label"`
	ProviderType   string  `json:"providerType"`
	BaseURL        string  `json:"baseUrl"`
	ChatModel      *string `json:"chatModel,omitempty"`
	Enabled        bool    `json:"enabled"`
	IsDefault      bool    `json:"isDefault"`
	HasKey         bool    `json:"hasKey"`
	// KeyHint is the last 4 chars of the original key, prefixed with
	// "sk-…". Lets the user identify which key is in this profile
	// without exposing it. Empty when no key stored.
	KeyHint   string `json:"keyHint,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type providerCreate struct {
	Label        string `json:"label"`
	ProviderType string `json:"providerType"` // "openai-compatible" for now
	BaseURL      string `json:"baseUrl"`
	APIKey       string `json:"apiKey"`
	ChatModel    string `json:"chatModel,omitempty"`
}

type providerUpdate struct {
	Label     *string `json:"label,omitempty"`
	ChatModel *string `json:"chatModel,omitempty"`
	Enabled   *bool   `json:"enabled,omitempty"`
	IsDefault *bool   `json:"isDefault,omitempty"`
	// Setting a new key replaces the old one. Empty / omitted leaves
	// the existing key untouched.
	APIKey *string `json:"apiKey,omitempty"`
	// Setting a new BaseURL re-validates with the same SSRF rules
	// applied at create time.
	BaseURL *string `json:"baseUrl,omitempty"`
}

// ── List ─────────────────────────────────────────────────────────────

func (h *Handler) HandleListProviders(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	rows, err := h.DB.QueryContext(r.Context(), `
		SELECT p.id, p.label, p.provider_type, COALESCE(p.base_url, ''),
		       p.chat_model, p.enabled,
		       COALESCE((SELECT 1 FROM user_ai_preferences u
		                 WHERE u.user_id = ? AND u.default_chat_profile_id = p.id), 0) AS is_default,
		       (p.api_key_enc IS NOT NULL AND p.api_key_enc != '') AS has_key,
		       p.created_at, p.updated_at
		FROM ai_provider_profiles p
		WHERE p.user_id = ? AND COALESCE(p.is_system, 0) = 0
		ORDER BY p.created_at DESC
	`, user.ID, user.ID)
	if err != nil {
		response.FailSafe(w, "providers.list", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	defer rows.Close()
	out := make([]providerDTO, 0, 4)
	for rows.Next() {
		var d providerDTO
		var chatModel sql.NullString
		var enabledI, isDefaultI, hasKeyI int
		if err := rows.Scan(&d.ID, &d.Label, &d.ProviderType, &d.BaseURL,
			&chatModel, &enabledI, &isDefaultI, &hasKeyI,
			&d.CreatedAt, &d.UpdatedAt); err != nil {
			response.FailSafe(w, "providers.scan", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		if chatModel.Valid {
			s := chatModel.String
			d.ChatModel = &s
		}
		d.Enabled = enabledI != 0
		d.IsDefault = isDefaultI != 0
		d.HasKey = hasKeyI != 0
		// KeyHint is filled below from the encrypted column when needed.
		out = append(out, d)
	}
	response.OK(w, map[string]any{"providers": out})
}

// ── Create ───────────────────────────────────────────────────────────

func (h *Handler) HandleCreateProvider(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	if h.KeyDeriver == nil {
		response.Fail(w, http.StatusInternalServerError, response.CodeInternal,
			"服务端未配置加密密钥，无法保存第三方 AI 凭据")
		return
	}
	var body providerCreate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}
	body.Label = strings.TrimSpace(body.Label)
	body.BaseURL = strings.TrimSpace(body.BaseURL)
	body.APIKey = strings.TrimSpace(body.APIKey)
	body.ChatModel = strings.TrimSpace(body.ChatModel)
	body.ProviderType = strings.TrimSpace(body.ProviderType)
	if body.ProviderType == "" {
		body.ProviderType = "openai-compatible"
	}
	if body.Label == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请填写名称")
		return
	}
	if len(body.Label) > 60 {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "名称过长（最多 60 字符）")
		return
	}
	if body.APIKey == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请填写 API Key")
		return
	}
	if len(body.APIKey) > 1024 {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "API Key 过长")
		return
	}
	safe, err := ValidateBaseURL(body.BaseURL)
	if err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, err.Error())
		return
	}

	enc, err := security.Encrypt(h.KeyDeriver, "ai-provider", body.APIKey)
	if err != nil {
		response.FailSafe(w, "providers.encrypt", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	id := security.RandomID()
	now := time.Now().Unix()
	chatModel := sql.NullString{String: body.ChatModel, Valid: body.ChatModel != ""}
	if _, err := h.DB.ExecContext(r.Context(), `
		INSERT INTO ai_provider_profiles
		  (id, user_id, provider_type, label, base_url, api_key_enc, chat_model,
		   enabled, is_system, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
	`, id, user.ID, body.ProviderType, body.Label, safe.String(), enc, chatModel, now, now); err != nil {
		response.FailSafe(w, "providers.insert", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	response.OK(w, map[string]any{
		"provider": providerDTO{
			ID:           id,
			Label:        body.Label,
			ProviderType: body.ProviderType,
			BaseURL:      safe.String(),
			ChatModel:    nullableString(body.ChatModel),
			Enabled:      true,
			IsDefault:    false,
			HasKey:       true,
			KeyHint:      keyHint(body.APIKey),
			CreatedAt:    now,
			UpdatedAt:    now,
		},
	})
}

// ── Update ───────────────────────────────────────────────────────────

func (h *Handler) HandleUpdateProvider(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	id := r.PathValue("id")
	if id == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}
	var body providerUpdate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}

	// Make sure the row exists and belongs to the user.
	var ownedBy string
	if err := h.DB.QueryRowContext(r.Context(),
		`SELECT user_id FROM ai_provider_profiles WHERE id = ? AND COALESCE(is_system, 0) = 0`, id,
	).Scan(&ownedBy); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "未找到该 AI 配置")
			return
		}
		response.FailSafe(w, "providers.update.lookup", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	if ownedBy != user.ID {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "未找到该 AI 配置")
		return
	}

	sets := []string{"updated_at = ?"}
	args := []any{time.Now().Unix()}
	if body.Label != nil {
		v := strings.TrimSpace(*body.Label)
		if v == "" || len(v) > 60 {
			response.Fail(w, http.StatusBadRequest, response.CodeValidation, "名称无效")
			return
		}
		sets = append(sets, "label = ?")
		args = append(args, v)
	}
	if body.ChatModel != nil {
		v := strings.TrimSpace(*body.ChatModel)
		sets = append(sets, "chat_model = ?")
		if v == "" {
			args = append(args, nil)
		} else {
			args = append(args, v)
		}
	}
	if body.Enabled != nil {
		sets = append(sets, "enabled = ?")
		if *body.Enabled {
			args = append(args, 1)
		} else {
			args = append(args, 0)
		}
	}
	if body.BaseURL != nil {
		safe, err := ValidateBaseURL(*body.BaseURL)
		if err != nil {
			response.Fail(w, http.StatusBadRequest, response.CodeValidation, err.Error())
			return
		}
		sets = append(sets, "base_url = ?")
		args = append(args, safe.String())
	}
	if body.APIKey != nil && strings.TrimSpace(*body.APIKey) != "" {
		if h.KeyDeriver == nil {
			response.Fail(w, http.StatusInternalServerError, response.CodeInternal, "服务端未配置加密密钥")
			return
		}
		enc, err := security.Encrypt(h.KeyDeriver, "ai-provider", strings.TrimSpace(*body.APIKey))
		if err != nil {
			response.FailSafe(w, "providers.update.encrypt", err, http.StatusInternalServerError, h.IsProd)
			return
		}
		sets = append(sets, "api_key_enc = ?")
		args = append(args, enc)
	}

	q := `UPDATE ai_provider_profiles SET ` + strings.Join(sets, ", ") + ` WHERE id = ? AND user_id = ?`
	args = append(args, id, user.ID)
	if _, err := h.DB.ExecContext(r.Context(), q, args...); err != nil {
		response.FailSafe(w, "providers.update", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	// Default-toggle goes into user_ai_preferences, not the provider row.
	if body.IsDefault != nil {
		var def any = id
		if !*body.IsDefault {
			def = nil
		}
		if _, err := h.DB.ExecContext(r.Context(), `
			INSERT INTO user_ai_preferences (user_id, default_chat_profile_id, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
			  default_chat_profile_id = excluded.default_chat_profile_id,
			  updated_at = excluded.updated_at
		`, user.ID, def, time.Now().Unix()); err != nil {
			response.FailSafe(w, "providers.update.default", err, http.StatusInternalServerError, h.IsProd)
			return
		}
	}

	response.OK(w, map[string]any{"ok": true})
}

// ── Delete ───────────────────────────────────────────────────────────

func (h *Handler) HandleDeleteProvider(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	id := r.PathValue("id")
	if id == "" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 id")
		return
	}
	res, err := h.DB.ExecContext(r.Context(),
		`DELETE FROM ai_provider_profiles WHERE id = ? AND user_id = ? AND COALESCE(is_system, 0) = 0`,
		id, user.ID)
	if err != nil {
		response.FailSafe(w, "providers.delete", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "未找到该 AI 配置")
		return
	}
	response.OK(w, map[string]any{"ok": true})
}

// ── Models — pull live list from upstream ────────────────────────────

func (h *Handler) HandleListProviderModels(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	id := r.PathValue("id")
	base, apiKey, ok := h.loadProviderCreds(r, user.ID, id)
	if !ok {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "未找到该 AI 配置")
		return
	}

	req, err := NewSafeRequest(r.Context(), base, http.MethodGet, "/models", nil)
	if err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "URL 构造失败：" + err.Error())
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")

	client := SafeHTTPClient(15 * time.Second)
	res, err := client.Do(req)
	if err != nil {
		response.Fail(w, http.StatusBadGateway, "AI_UPSTREAM",
			"无法连接到 AI 服务："+sanitizeNetworkErr(err))
		return
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(res.Body, 256<<10))
	if res.StatusCode/100 != 2 {
		response.Fail(w, http.StatusBadGateway, "AI_UPSTREAM",
			fmt.Sprintf("拉取模型失败（HTTP %d）：%s", res.StatusCode, extractErrorMessage(body)))
		return
	}

	// OpenAI-compatible shape: {"data": [{"id": "..."}]}.
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		response.Fail(w, http.StatusBadGateway, "AI_UPSTREAM", "上游返回无法解析为模型列表")
		return
	}
	models := make([]string, 0, len(parsed.Data))
	for _, m := range parsed.Data {
		if m.ID != "" {
			models = append(models, m.ID)
		}
	}
	response.OK(w, map[string]any{"models": models})
}

// ── Test ─────────────────────────────────────────────────────────────

type testRequest struct {
	// "builtin" or "provider"
	Target     string `json:"target"`
	ProviderID string `json:"providerId,omitempty"`
}

func (h *Handler) HandleTest(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())
	var body testRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}

	switch body.Target {
	case "builtin":
		// Internal-only test. The user must NOT learn anything about
		// the underlying model or provider. We send a tiny throwaway
		// message and report success/failure.
		apiKey := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
		if apiKey == "" {
			response.OK(w, map[string]any{"ok": false, "errorMessage": "内置 AI 未启用"})
			return
		}
		if !canUseSystemAI(r.Context(), h.DB, user.ID) {
			response.OK(w, map[string]any{"ok": false, "errorMessage": "内置 AI 已暂停（额度不足或速率超限）"})
			return
		}
		ok, msg := pingAnthropic(r.Context(), apiKey)
		if ok {
			response.OK(w, map[string]any{"ok": true})
		} else {
			// Strip any provider-specific identifiers from the error
			// before returning.
			response.OK(w, map[string]any{"ok": false, "errorMessage": sanitizeBuiltinErr(msg)})
		}

	case "provider":
		if body.ProviderID == "" {
			response.Fail(w, http.StatusBadRequest, response.CodeValidation, "缺少 providerId")
			return
		}
		base, apiKey, ok := h.loadProviderCreds(r, user.ID, body.ProviderID)
		if !ok {
			response.Fail(w, http.StatusNotFound, response.CodeNotFound, "未找到该 AI 配置")
			return
		}
		// Look up the chat_model for nicer test output.
		var label, model sql.NullString
		_ = h.DB.QueryRowContext(r.Context(),
			`SELECT label, chat_model FROM ai_provider_profiles WHERE id = ? AND user_id = ?`,
			body.ProviderID, user.ID).Scan(&label, &model)

		ok2, name, modelOut, errMsg := pingOpenAICompatible(r.Context(), base, apiKey, model.String)
		if ok2 {
			response.OK(w, map[string]any{
				"ok":       true,
				"name":     pickNonEmpty(name, label.String, "自定义 AI"),
				"model":    modelOut,
			})
		} else {
			response.OK(w, map[string]any{
				"ok":           false,
				"errorMessage": errMsg,
			})
		}
	default:
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "target 必须是 builtin 或 provider")
	}
}

// ── helpers ──────────────────────────────────────────────────────────

func (h *Handler) loadProviderCreds(r *http.Request, userID, id string) (SafeBaseURL, string, bool) {
	if h.KeyDeriver == nil {
		return SafeBaseURL{}, "", false
	}
	var baseURL, encKey string
	err := h.DB.QueryRowContext(r.Context(),
		`SELECT COALESCE(base_url, ''), COALESCE(api_key_enc, '')
		 FROM ai_provider_profiles
		 WHERE id = ? AND user_id = ? AND COALESCE(is_system, 0) = 0`,
		id, userID).Scan(&baseURL, &encKey)
	if err != nil {
		return SafeBaseURL{}, "", false
	}
	if baseURL == "" || encKey == "" {
		return SafeBaseURL{}, "", false
	}
	apiKey, err := security.Decrypt(h.KeyDeriver, "ai-provider", encKey)
	if err != nil || apiKey == "" {
		return SafeBaseURL{}, "", false
	}
	safe, err := ValidateBaseURL(baseURL)
	if err != nil {
		return SafeBaseURL{}, "", false
	}
	return safe, apiKey, true
}

// Hash an api key into a short visible hint without revealing the key.
// We show "sk-…XXXX" using the last 4 chars of the key; if the key is
// short we use a sha256 prefix instead.
func keyHint(k string) string {
	if len(k) >= 8 {
		return "…" + k[len(k)-4:]
	}
	if k == "" {
		return ""
	}
	h := sha256.Sum256([]byte(k))
	return "#" + hex.EncodeToString(h[:2])
}

func nullableString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func pickNonEmpty(xs ...string) string {
	for _, s := range xs {
		if s != "" {
			return s
		}
	}
	return ""
}

// pingAnthropic sends a one-token request to Anthropic's /v1/messages
// purely to verify the key works. No provider details are returned to
// the caller — we only care about success/failure.
func pingAnthropic(ctx context.Context, apiKey string) (bool, string) {
	body := map[string]any{
		"model":      defaultModel,
		"max_tokens": 4,
		"messages":   []map[string]string{{"role": "user", "content": "ping"}},
	}
	buf, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiEndpoint, strings.NewReader(string(buf)))
	if err != nil {
		return false, err.Error()
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", apiVersion)
	c := &http.Client{Timeout: 15 * time.Second}
	res, err := c.Do(req)
	if err != nil {
		return false, err.Error()
	}
	defer res.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode/100 == 2 {
		return true, ""
	}
	return false, extractErrorMessage(rb)
}

// pingOpenAICompatible runs a tiny chat completion against a custom
// OpenAI-compatible provider. Returns the model echoed by the
// upstream + a short label derived from the response.
func pingOpenAICompatible(ctx context.Context, base SafeBaseURL, apiKey, preferredModel string) (ok bool, name, model, errMsg string) {
	model = preferredModel
	if model == "" {
		model = "gpt-3.5-turbo"
	}
	body := map[string]any{
		"model":      model,
		"max_tokens": 4,
		"messages": []map[string]string{
			{"role": "user", "content": "ping"},
		},
	}
	buf, _ := json.Marshal(body)
	req, err := NewSafeRequest(ctx, base, http.MethodPost, "/chat/completions", buf)
	if err != nil {
		return false, "", "", "URL 构造失败：" + err.Error()
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	c := SafeHTTPClient(15 * time.Second)
	res, err := c.Do(req)
	if err != nil {
		return false, "", "", "无法连接：" + sanitizeNetworkErr(err)
	}
	defer res.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(res.Body, 256<<10))
	if res.StatusCode/100 != 2 {
		return false, "", "", fmt.Sprintf("HTTP %d：%s", res.StatusCode, extractErrorMessage(rb))
	}
	var parsed struct {
		Model   string `json:"model"`
		Object  string `json:"object"`
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(rb, &parsed)
	if parsed.Model != "" {
		model = parsed.Model
	}
	// Derive a name from the host part of the base URL (purely
	// cosmetic — the user already knows what they typed).
	host := req.URL.Hostname()
	name = host
	return true, name, model, ""
}

// sanitizeBuiltinErr strips any reference to specific upstream
// provider names / models from an error string before showing it for
// the built-in test. The user shouldn't learn that the built-in is
// "Anthropic Claude X.Y" from a failure message.
func sanitizeBuiltinErr(msg string) string {
	if msg == "" {
		return "内置 AI 测试失败"
	}
	low := strings.ToLower(msg)
	if strings.Contains(low, "401") || strings.Contains(low, "unauthor") || strings.Contains(low, "api key") {
		return "服务端凭据无效或已过期"
	}
	if strings.Contains(low, "429") || strings.Contains(low, "rate") {
		return "调用频率受限，请稍后再试"
	}
	if strings.Contains(low, "timeout") || strings.Contains(low, "deadline") {
		return "调用超时"
	}
	if strings.Contains(low, "network") || strings.Contains(low, "dial") || strings.Contains(low, "dns") {
		return "网络不可达"
	}
	return "内置 AI 调用失败"
}

// sanitizeNetworkErr keeps user-visible text generic when the upstream
// dial fails for SSRF / DNS / timeout reasons. We surface enough to
// debug, not enough to enumerate the server's network.
func sanitizeNetworkErr(err error) string {
	s := err.Error()
	if len(s) > 240 {
		s = s[:240] + "…"
	}
	// Replace "connect: connection refused" and similar low-level
	// plaintext with friendlier copy.
	if strings.Contains(s, "forbidden range") {
		return "目标地址不在允许范围"
	}
	return s
}

// canUseSystemAI is a fast pre-flight check that consults the user's
// quota / rate-limit window. Used by the test endpoint and the chat
// proxy. The actual quota state lives in ai_usage_events; the
// configured caps live in app_config.
func canUseSystemAI(ctx context.Context, db *sql.DB, userID string) bool {
	caps := loadSystemAIConfig(ctx, db)
	// Rate limit (last minute, system provider only).
	var rateCount int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM ai_usage_events
		WHERE user_id = ? AND COALESCE(provider_source, 'system') = 'system'
		  AND created_at >= ?
	`, userID, time.Now().Unix()-60).Scan(&rateCount); err == nil {
		if rateCount >= caps.RatePerMinute {
			return false
		}
	}
	// Cost cap (sum of estimated_cost_usd for the rolling month).
	var totalCost float64
	if err := db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM ai_usage_events
		WHERE user_id = ? AND COALESCE(provider_source, 'system') = 'system'
		  AND created_at >= ?
	`, userID, time.Now().Unix()-30*24*3600).Scan(&totalCost); err == nil {
		if totalCost >= caps.MonthlyUSD {
			return false
		}
	}
	return true
}

type systemAICaps struct {
	MonthlyUSD    float64
	RatePerMinute int
}

// loadSystemAIConfig reads admin-configured caps from app_config or
// falls back to the defaults the user requested ($10 / 5-per-min).
func loadSystemAIConfig(ctx context.Context, db *sql.DB) systemAICaps {
	c := systemAICaps{MonthlyUSD: 10, RatePerMinute: 5}
	row := db.QueryRowContext(ctx,
		`SELECT value FROM app_config WHERE key = 'ai_system_limits'`)
	var raw string
	if err := row.Scan(&raw); err == nil && raw != "" {
		var parsed struct {
			MonthlyUSD    float64 `json:"monthlyUsd"`
			RatePerMinute int     `json:"ratePerMinute"`
		}
		if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
			if parsed.MonthlyUSD > 0 {
				c.MonthlyUSD = parsed.MonthlyUSD
			}
			if parsed.RatePerMinute > 0 {
				c.RatePerMinute = parsed.RatePerMinute
			}
		}
	}
	return c
}
