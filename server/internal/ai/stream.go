// Streaming chat handler. Owns the SSE response lifecycle for
// /api/ai/chat?stream=true.
//
// What this does, end-to-end:
//
//   1. Open the SSE response with the right headers + flush.
//   2. Run RAG retrieval against the user's last message (when a
//      bookId is provided). Emit the resulting citations as the
//      first SSE event so the UI can render the source cards
//      before the model starts producing text.
//   3. Build the upstream prompt with the retrieved passages
//      prepended as a system block.
//   4. Call the upstream LLM. We always go through the NON-streaming
//      upstream call — Anthropic's streaming and OpenAI-compatible
//      streaming use different framings, and supporting both inside
//      one code path is more complexity than the reader-companion
//      use case justifies. Instead, we get the full response back,
//      then chunk it out over our own SSE wire so the UI still
//      animates. From the user's perspective the difference is
//      ~200ms of upstream latency before the first character — for
//      a 1024-token answer that's tiny.
//   5. Emit `done` and close.
//
// Routing: built-in (Anthropic) when no providerId is supplied,
// custom OpenAI-compatible profile when one is. Same gate as the
// non-streaming path for system-AI quota enforcement.

package ai

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"bookfree/internal/security"
)

const (
	streamChunkRunes = 32                    // characters per SSE delta frame
	streamChunkDelay = 35 * time.Millisecond // gap between frames
)

func (h *Handler) handleChatStream(w http.ResponseWriter, r *http.Request, userID string, req chatRequest) {
	sw := newSSEWriter(w)
	ctx := r.Context()

	// Pull the user's last user-role message — the query for retrieval.
	query := lastUserMessage(req.Messages)

	// 1) Retrieval (book-scoped only). Emit citations first so the UI
	//    can show provenance even before the model responds.
	var passages []RetrievedChunk
	var citations []CitationDTO
	if strings.TrimSpace(req.BookID) != "" && query != "" {
		ps, cs, err := retrieveContext(ctx, h.DB, userID, req.BookID, query)
		if err == nil {
			passages = ps
			citations = cs
		}
	}
	if citations == nil {
		citations = []CitationDTO{}
	}
	if err := sw.event("citations", citations); err != nil {
		return
	}

	// 2) Build the upstream prompt. Retrieved passages get a labelled
	//    system block; any user-supplied excerpt is added separately
	//    so the model can distinguish "the user highlighted this" from
	//    "we retrieved these".
	systemParts := []string{
		"You are a helpful reading companion inside an e-book reader. " +
			"Be concise. Answer in the same language the user wrote in. " +
			"When the PASSAGES block is present, ground every factual claim in it; " +
			"if the passages do not contain the answer, say so rather than inventing one.",
	}
	if len(passages) > 0 {
		var pb strings.Builder
		pb.WriteString("RETRIEVED PASSAGES (use these as the source of truth):\n")
		for i, p := range passages {
			pb.WriteString("\n[")
			pb.WriteString(p.BookTitle)
			if p.ChapterTitle != "" {
				pb.WriteString(" / ")
				pb.WriteString(p.ChapterTitle)
			}
			pb.WriteString("]\n")
			pb.WriteString(truncatePassage(p.Text))
			pb.WriteByte('\n')
			_ = i
		}
		systemParts = append(systemParts, pb.String())
	}
	if strings.TrimSpace(req.Excerpt) != "" {
		excerpt := req.Excerpt
		const maxExcerptChars = 8000
		if len(excerpt) > maxExcerptChars {
			excerpt = excerpt[:maxExcerptChars] + "…"
		}
		systemParts = append(systemParts, "USER-HIGHLIGHTED EXCERPT:\n"+excerpt)
	}
	systemPrompt := strings.Join(systemParts, "\n\n")

	// 3) Call the upstream. Routing same as non-streaming path.
	var (
		fullText string
		err      error
	)
	if strings.TrimSpace(req.ProviderID) != "" {
		fullText, err = h.streamCallProvider(ctx, userID, req, systemPrompt)
	} else {
		apiKey := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
		if apiKey == "" {
			sw.errorAndClose("AI 功能尚未启用：服务端未配置 ANTHROPIC_API_KEY")
			return
		}
		if !canUseSystemAI(ctx, h.DB, userID) {
			sw.errorAndClose("AI 调用受限：已达额度或速率上限，请稍后再试或在设置中导入自己的 AI")
			return
		}
		fullText, err = h.streamCallBuiltin(ctx, userID, req, systemPrompt, apiKey)
	}
	if err != nil {
		sw.errorAndClose(err.Error())
		return
	}

	// 4) Chunk the full text out over the SSE wire so the UI animates.
	if err := emitChunks(ctx, sw, fullText); err != nil {
		// Emission errors usually mean the client disconnected; nothing
		// to do but stop. No need to send error event — the connection
		// is already gone.
		return
	}
	sw.done()
}

func lastUserMessage(msgs []chatMessage) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if strings.ToLower(strings.TrimSpace(msgs[i].Role)) == "user" {
			return strings.TrimSpace(msgs[i].Content)
		}
	}
	return ""
}

// emitChunks splits `s` into runes-N chunks and writes one delta
// event per chunk, with a small delay between frames. Returns the
// first transport error.
func emitChunks(ctx context.Context, sw *sseWriter, s string) error {
	if s == "" {
		return nil
	}
	runes := []rune(s)
	for i := 0; i < len(runes); i += streamChunkRunes {
		end := i + streamChunkRunes
		if end > len(runes) {
			end = len(runes)
		}
		if err := sw.event("delta", map[string]string{"text": string(runes[i:end])}); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(streamChunkDelay):
		}
	}
	return nil
}

// ─── Upstream callers ──────────────────────────────────────────────

// streamCallBuiltin runs an Anthropic chat completion using the
// provided system prompt and message history. Returns the full
// concatenated assistant text. We keep this non-streaming — see the
// rationale at the top of the file.
func (h *Handler) streamCallBuiltin(ctx context.Context, userID string, req chatRequest, systemPrompt, apiKey string) (string, error) {
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
		return "", errors.New("没有有效的消息内容")
	}
	if upMsgs[len(upMsgs)-1].Role != "user" {
		return "", errors.New("最后一条消息必须为 user")
	}

	body, err := json.Marshal(map[string]any{
		"model":      defaultModel,
		"max_tokens": maxTokens,
		"system":     systemPrompt,
		"messages":   upMsgs,
	})
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, apiEndpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("anthropic-version", apiVersion)
	httpReq.Header.Set("x-api-key", apiKey)

	client := &http.Client{Timeout: httpTimeout}
	res, err := client.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 != 2 {
		return "", errors.New(sanitizeBuiltinErr(extractErrorMessage(respBody)))
	}

	var parsed struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", errors.New("无法解析上游响应")
	}
	var text strings.Builder
	for _, c := range parsed.Content {
		if c.Type == "text" {
			text.WriteString(c.Text)
		}
	}
	// Record usage so quota math has data — same as the non-streaming
	// path. Best-effort: a logging failure here doesn't fail the turn.
	if outText := text.String(); outText != "" {
		approxTokens := len(outText)/4 + 64
		estCost := float64(approxTokens) / 1000.0 * 0.015
		_, _ = h.DB.ExecContext(ctx, `
			INSERT INTO ai_usage_events
			  (id, user_id, provider_label, model, request_kind,
			   completion_tokens, total_tokens, estimated_cost_usd,
			   completed, provider_source, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'chat', ?, ?, ?, 1, 'system', ?, ?)
		`, security.RandomID(), userID, "builtin", defaultModel,
			approxTokens, approxTokens, estCost,
			time.Now().Unix(), time.Now().Unix())
	}
	return text.String(), nil
}

// streamCallProvider runs a chat completion against a user's saved
// OpenAI-compatible provider. Same non-streaming + chunk-emission
// strategy as the builtin path.
func (h *Handler) streamCallProvider(ctx context.Context, userID string, req chatRequest, systemPrompt string) (string, error) {
	// loadProviderCreds requires an *http.Request to extract user
	// context, but we only have ctx + userID here. Build a synthetic
	// request that carries the user via context — same way as the
	// non-streaming provider path does internally.
	syntheticReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, "/", nil)
	base, apiKey, ok := h.loadProviderCreds(syntheticReq, userID, strings.TrimSpace(req.ProviderID))
	if !ok {
		return "", errors.New("未找到该 AI 配置")
	}

	// Look up the provider's chosen chat model.
	var model sql.NullString
	_ = h.DB.QueryRowContext(ctx,
		`SELECT chat_model FROM ai_provider_profiles WHERE id = ? AND user_id = ?`,
		req.ProviderID, userID).Scan(&model)

	type oaiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	upMsgs := make([]oaiMsg, 0, len(req.Messages)+1)
	upMsgs = append(upMsgs, oaiMsg{Role: "system", Content: systemPrompt})
	for _, m := range req.Messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		if role != "user" && role != "assistant" {
			role = "user"
		}
		c := strings.TrimSpace(m.Content)
		if c == "" {
			continue
		}
		upMsgs = append(upMsgs, oaiMsg{Role: role, Content: c})
	}

	upBody := map[string]any{
		"messages":   upMsgs,
		"max_tokens": maxTokens,
	}
	if model.Valid && model.String != "" {
		upBody["model"] = model.String
	}
	buf, err := json.Marshal(upBody)
	if err != nil {
		return "", err
	}

	httpReq, err := NewSafeRequest(ctx, base, http.MethodPost, "/chat/completions", buf)
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := SafeHTTPClient(httpTimeout)
	res, err := client.Do(httpReq)
	if err != nil {
		return "", errors.New("无法连接 AI 服务：" + sanitizeNetworkErr(err))
	}
	defer res.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 != 2 {
		// Surface the error message + the constructed URL so the user
		// can debug their provider config (mirrors the inline-test
		// behaviour added in providers.go).
		return "", errors.New(extractErrorMessage(respBody) +
			"\n请求 URL: " + base.String() + "/chat/completions")
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", errors.New("无法解析上游响应")
	}
	if len(parsed.Choices) == 0 {
		return "", errors.New("上游返回了 0 个 choice")
	}
	return parsed.Choices[0].Message.Content, nil
}
