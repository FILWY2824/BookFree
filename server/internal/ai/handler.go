// Package ai exposes a minimal AI chat surface to the reader. The
// reader can ask "explain this passage" / "summarise" / "translate"
// kinds of questions about a selection.
//
// The design is deliberately the simplest thing that works:
//
//   GET  /api/ai/status        → { configured: bool }
//   POST /api/ai/chat          → { message: { role, content } }
//
// The Anthropic API key lives in the ANTHROPIC_API_KEY environment
// variable on the server only. The client never sees it. If the env
// var is unset, /api/ai/status reports configured:false and /api/ai/chat
// returns 501 with code NOT_CONFIGURED — the client uses the status
// value to disable the AI panel proactively, so users get a clean
// "未配置" message instead of a 501 mid-conversation.
//
// Why server-side only:
//   * keeps the key out of the browser bundle
//   * lets us swap providers later without touching every client
//   * future-proofs for per-user provider profiles backed by the
//     ai_provider_profiles table (migration 0007), which we don't
//     wire here but the schema is in place for.

package ai

import (
	"bytes"
	"database/sql"
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

const (
	apiEndpoint  = "https://api.anthropic.com/v1/messages"
	apiVersion   = "2023-06-01"
	defaultModel = "claude-sonnet-4-5"
	maxTokens    = 1024
	httpTimeout  = 60 * time.Second
)

type Handler struct {
	DB         *sql.DB
	IsProd     bool
	KeyDeriver *security.KeyDeriver
}

// HandleStatus reports whether an AI key is configured server-side.
// We return 200 always so the client doesn't have to differentiate
// between "no AI" and "AI configured but failing".
func (h *Handler) HandleStatus(w http.ResponseWriter, r *http.Request) {
	_ = r
	configured := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")) != ""
	response.OK(w, map[string]any{
		"configured": configured,
		"provider":   "anthropic",
	})
}

// chatMessage mirrors the wire shape on both ends — same JSON the
// client sends and the same we return. The Anthropic API uses an
// almost-identical shape so we forward most fields straight.
type chatMessage struct {
	Role    string `json:"role"`    // "user" | "assistant"
	Content string `json:"content"` // plain text
}

type chatRequest struct {
	Messages []chatMessage `json:"messages"`
	// Optional excerpt the reader passes when "use selection as
	// context" is on. We prepend a system message describing it so
	// the model knows the selection is the subject of the next user
	// question rather than just preamble.
	Excerpt string `json:"excerpt,omitempty"`
	// Book id — when set AND the request asks for streaming, the
	// server runs RAG retrieval (FTS5 + vector rerank) and prepends
	// the top passages to the system prompt, then emits them as
	// citation events on the wire. Empty bookId == no retrieval.
	BookID    string `json:"bookId,omitempty"`
	ChapterID string `json:"chapterId,omitempty"`
	// When set, route to the named user-imported provider instead of
	// the built-in Anthropic proxy. Lookup scoped to user_id, so a
	// caller can't reach another user's profile.
	ProviderID string `json:"providerId,omitempty"`
	// Streaming flag. When true, the response is text/event-stream
	// and the client receives `citations`, `delta`, and `done` events.
	// When false (the default) we do the legacy single JSON response.
	Stream bool `json:"stream,omitempty"`
}

// HandleChat proxies a chat turn. By default it uses the server's
// built-in Anthropic key (ANTHROPIC_API_KEY). If the request specifies
// a `providerId`, we fall through to the user's custom OpenAI-compatible
// profile instead — that path bypasses the system quota and rate-limit
// enforcement (it's the user's own account).
//
// Streaming branch:
//
//	When req.Stream is true, we switch to text/event-stream framing.
//	See sse.go for the helpers and rag.go for the retrieval step.
func (h *Handler) HandleChat(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromContext(r.Context())

	var req chatRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&req); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}
	if len(req.Messages) == 0 {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "messages 不能为空")
		return
	}
	if len(req.Messages) > 32 {
		req.Messages = req.Messages[len(req.Messages)-32:]
	}

	if req.Stream {
		h.handleChatStream(w, r, user.ID, req)
		return
	}

	// Routing: explicit providerId => user's custom AI; otherwise
	// fall back to the built-in Anthropic key with quota enforcement.
	if strings.TrimSpace(req.ProviderID) != "" {
		h.handleChatViaProvider(w, r, user.ID, req)
		return
	}

	apiKey := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if apiKey == "" {
		response.Fail(w, http.StatusNotImplemented, "NOT_CONFIGURED",
			"AI 功能尚未启用：服务端未配置 ANTHROPIC_API_KEY")
		return
	}
	if !canUseSystemAI(r.Context(), h.DB, user.ID) {
		response.Fail(w, http.StatusTooManyRequests, response.CodeRateLimited,
			"AI 调用受限：已达额度或速率上限，请稍后再试或在设置中导入自己的 AI")
		return
	}
	h.handleChatViaBuiltin(w, r, user.ID, apiKey, req)
}

// handleChatViaBuiltin runs the Anthropic-backed chat AND records a
// usage event so quota math has data to work with.
func (h *Handler) handleChatViaBuiltin(w http.ResponseWriter, r *http.Request, userID, apiKey string, req chatRequest) {

	// Build the upstream request body. Anthropic accepts a top-level
	// `system` string + a `messages` array. We attach the excerpt as
	// a system instruction; the user's own messages stay verbatim.
	systemParts := []string{
		"You are a helpful reading companion inside an e-book reader. " +
			"Be concise. Answer in the same language the user wrote in. " +
			"If the user references a passage, ground your answer in the provided EXCERPT.",
	}
	if strings.TrimSpace(req.Excerpt) != "" {
		// Truncate over-long excerpts so we don't blow past the
		// model's context window or run up the token bill.
		excerpt := req.Excerpt
		const maxExcerptChars = 8000
		if len(excerpt) > maxExcerptChars {
			excerpt = excerpt[:maxExcerptChars] + "…"
		}
		systemParts = append(systemParts, "EXCERPT FROM THE BOOK:\n"+excerpt)
	}

	type anthMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	upMsgs := make([]anthMsg, 0, len(req.Messages))
	for _, m := range req.Messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		if role != "user" && role != "assistant" {
			role = "user"
		}
		content := strings.TrimSpace(m.Content)
		if content == "" {
			continue
		}
		upMsgs = append(upMsgs, anthMsg{Role: role, Content: content})
	}
	if len(upMsgs) == 0 {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "没有有效的消息内容")
		return
	}
	// Anthropic requires the last message to have role=user.
	if upMsgs[len(upMsgs)-1].Role != "user" {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "最后一条消息必须为 user")
		return
	}

	upBody := map[string]any{
		"model":      defaultModel,
		"max_tokens": maxTokens,
		"system":     strings.Join(systemParts, "\n\n"),
		"messages":   upMsgs,
	}
	buf, err := json.Marshal(upBody)
	if err != nil {
		response.FailSafe(w, "ai.marshal", err, http.StatusInternalServerError, h.IsProd)
		return
	}

	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, apiEndpoint, bytes.NewReader(buf))
	if err != nil {
		response.FailSafe(w, "ai.req", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	upReq.Header.Set("content-type", "application/json")
	upReq.Header.Set("x-api-key", apiKey)
	upReq.Header.Set("anthropic-version", apiVersion)

	client := &http.Client{Timeout: httpTimeout}
	upRes, err := client.Do(upReq)
	if err != nil {
		response.FailSafe(w, "ai.do", err, http.StatusBadGateway, h.IsProd)
		return
	}
	defer upRes.Body.Close()

	resBody, err := io.ReadAll(io.LimitReader(upRes.Body, 1<<20))
	if err != nil {
		response.FailSafe(w, "ai.read", err, http.StatusBadGateway, h.IsProd)
		return
	}

	if upRes.StatusCode/100 != 2 {
		// Bubble up the model's error text so the client UI can show
		// something better than "请求失败". We do NOT pass through the
		// original status — it would expose Anthropic-specific codes
		// (401 for bad key, 429 for rate limits) that we want to
		// flatten into a generic 502.
		msg := extractErrorMessage(resBody)
		if msg == "" {
			msg = "AI 上游请求失败"
		}
		response.Fail(w, http.StatusBadGateway, "AI_UPSTREAM", msg)
		return
	}

	// Anthropic's response shape: { content: [ { type:"text", text:"…" } ], … }
	var parsed struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(resBody, &parsed); err != nil {
		response.FailSafe(w, "ai.parse", errors.New("invalid upstream JSON"), http.StatusBadGateway, h.IsProd)
		return
	}
	var sb strings.Builder
	for _, c := range parsed.Content {
		if c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	answer := strings.TrimSpace(sb.String())
	if answer == "" {
		answer = "(模型未返回内容)"
	}

	response.OK(w, map[string]any{
		"message": chatMessage{
			Role:    "assistant",
			Content: answer,
		},
	})

	// Best-effort usage logging. We approximate token cost from the
	// answer length when the upstream didn't return token counts (the
	// Anthropic v1/messages response in our parsed struct doesn't
	// include usage). This is enough for the per-user $10 cap to
	// behave roughly correctly; admin can adjust caps in app_config.
	approxTokens := len(answer)/4 + 64
	estCost := float64(approxTokens) / 1000.0 * 0.015
	_, _ = h.DB.ExecContext(r.Context(), `
		INSERT INTO ai_usage_events
		  (id, user_id, provider_label, model, request_kind,
		   completion_tokens, total_tokens, estimated_cost_usd,
		   completed, provider_source, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'chat', ?, ?, ?, 1, 'system', ?, ?)
	`, security.RandomID(), userID, "builtin", defaultModel,
		approxTokens, approxTokens, estCost,
		time.Now().Unix(), time.Now().Unix())
}

// chat path that targets a user-imported OpenAI-compatible provider.
// We bypass the system quota / rate-limit check (the user is paying)
// but still tag the usage row with provider_source='user' so admin
// reports can distinguish.
func (h *Handler) handleChatViaProvider(w http.ResponseWriter, r *http.Request, userID string, req chatRequest) {
	base, apiKey, ok := h.loadProviderCreds(r, userID, strings.TrimSpace(req.ProviderID))
	if !ok {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound, "未找到该 AI 配置")
		return
	}

	// Look up which model this profile prefers.
	var model sql.NullString
	_ = h.DB.QueryRowContext(r.Context(),
		`SELECT chat_model FROM ai_provider_profiles WHERE id = ? AND user_id = ?`,
		req.ProviderID, userID).Scan(&model)
	chosenModel := strings.TrimSpace(model.String)
	if chosenModel == "" {
		chosenModel = "gpt-3.5-turbo"
	}

	// OpenAI-compatible request shape.
	type openaiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	upMsgs := make([]openaiMsg, 0, len(req.Messages)+1)
	if strings.TrimSpace(req.Excerpt) != "" {
		excerpt := req.Excerpt
		if len(excerpt) > 8000 {
			excerpt = excerpt[:8000] + "…"
		}
		upMsgs = append(upMsgs, openaiMsg{
			Role:    "system",
			Content: "You are a helpful reading companion. Ground your answer in this EXCERPT FROM THE BOOK:\n" + excerpt,
		})
	}
	for _, m := range req.Messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		if role != "user" && role != "assistant" && role != "system" {
			role = "user"
		}
		c := strings.TrimSpace(m.Content)
		if c == "" {
			continue
		}
		upMsgs = append(upMsgs, openaiMsg{Role: role, Content: c})
	}
	upBody := map[string]any{
		"model":      chosenModel,
		"max_tokens": maxTokens,
		"messages":   upMsgs,
	}
	buf, err := json.Marshal(upBody)
	if err != nil {
		response.FailSafe(w, "ai.user.marshal", err, http.StatusInternalServerError, h.IsProd)
		return
	}
	upReq, err := NewSafeRequest(r.Context(), base, http.MethodPost, "/chat/completions", buf)
	if err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "URL 构造失败："+err.Error())
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Authorization", "Bearer "+apiKey)
	client := SafeHTTPClient(httpTimeout)
	res, err := client.Do(upReq)
	if err != nil {
		response.Fail(w, http.StatusBadGateway, "AI_UPSTREAM",
			"无法连接到 AI 服务："+sanitizeNetworkErr(err))
		return
	}
	defer res.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 != 2 {
		response.Fail(w, http.StatusBadGateway, "AI_UPSTREAM",
			fmt.Sprintf("HTTP %d：%s", res.StatusCode, extractErrorMessage(rb)))
		return
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(rb, &parsed); err != nil {
		response.Fail(w, http.StatusBadGateway, "AI_UPSTREAM", "上游返回无法解析")
		return
	}
	answer := ""
	if len(parsed.Choices) > 0 {
		answer = strings.TrimSpace(parsed.Choices[0].Message.Content)
	}
	if answer == "" {
		answer = "(模型未返回内容)"
	}
	response.OK(w, map[string]any{
		"message": chatMessage{Role: "assistant", Content: answer},
	})

	_, _ = h.DB.ExecContext(r.Context(), `
		INSERT INTO ai_usage_events
		  (id, user_id, provider_label, model, request_kind,
		   prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
		   completed, provider_source, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'chat', ?, ?, ?, 0, 1, 'user', ?, ?)
	`, security.RandomID(), userID, "user", chosenModel,
		parsed.Usage.PromptTokens, parsed.Usage.CompletionTokens, parsed.Usage.TotalTokens,
		time.Now().Unix(), time.Now().Unix())
}

// extractErrorMessage tries to pull a helpful string out of an
// upstream error body. Anthropic uses {"error": {"message": "…"}} but
// occasionally returns plain text on infra failures, so we fall back
// to the raw bytes truncated.
func extractErrorMessage(b []byte) string {
	var p struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(b, &p); err == nil && p.Error.Message != "" {
		return p.Error.Message
	}
	s := strings.TrimSpace(string(b))
	if len(s) > 240 {
		s = s[:240] + "…"
	}
	return s
}
