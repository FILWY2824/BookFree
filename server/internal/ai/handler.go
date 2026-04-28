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
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"bookfree/internal/response"
)

const (
	apiEndpoint  = "https://api.anthropic.com/v1/messages"
	apiVersion   = "2023-06-01"
	defaultModel = "claude-sonnet-4-5"
	maxTokens    = 1024
	httpTimeout  = 60 * time.Second
)

type Handler struct {
	DB     *sql.DB
	IsProd bool
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
}

// HandleChat proxies a chat turn to Anthropic. We deliberately do not
// stream — the reader UI is happy to wait for a complete answer, and
// streaming requires SSE plumbing that's not pulling its weight yet.
func (h *Handler) HandleChat(w http.ResponseWriter, r *http.Request) {
	apiKey := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if apiKey == "" {
		response.Fail(w, http.StatusNotImplemented, "NOT_CONFIGURED",
			"AI 功能尚未启用：服务端未配置 ANTHROPIC_API_KEY")
		return
	}

	var req chatRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&req); err != nil {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "请求体非法")
		return
	}
	if len(req.Messages) == 0 {
		response.Fail(w, http.StatusBadRequest, response.CodeValidation, "messages 不能为空")
		return
	}
	// Sanity-clamp the message count so a runaway client can't drain
	// quota with a 10 000-message turn. 32 is plenty for a reader
	// chat where context is reset per book session.
	if len(req.Messages) > 32 {
		req.Messages = req.Messages[len(req.Messages)-32:]
	}

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
