// SSE (Server-Sent Events) framing helpers for the streaming chat
// endpoint. SSE is dirt-simple — `event: name\ndata: payload\n\n` —
// but getting the headers and flushing right matters: without the
// right headers, intermediate proxies (Cloudflare, Nginx with default
// config) buffer the response and the browser sees nothing until the
// upstream call completes, defeating the whole point of streaming.
//
// Header set:
//   Content-Type: text/event-stream — required for the browser EventSource
//                                     contract; ALSO short-circuits some
//                                     reverse-proxy buffering.
//   Cache-Control: no-cache, no-transform — `no-transform` is the
//                                            critical one against gzip
//                                            buffering by middlebox.
//   Connection: keep-alive            — prevents premature TCP close
//                                        on HTTP/1.1.
//   X-Accel-Buffering: no             — Nginx-specific opt-out of
//                                        proxy_buffering on this response.
//
// We flush after every event so each frame hits the wire immediately.
// http.ResponseWriter must implement http.Flusher for this to work;
// it does for both the standard server and chi/gorilla wrappers, but
// we guard with a type assertion and fall back to "no flush" rather
// than crash the request.

package ai

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// sseWriter wraps an http.ResponseWriter to write SSE frames. Use
// newSSEWriter to construct one — it sets the headers and flushes
// the response status before returning.
type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
	closed  bool
}

func newSSEWriter(w http.ResponseWriter) *sseWriter {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	s := &sseWriter{w: w}
	if f, ok := w.(http.Flusher); ok {
		s.flusher = f
		f.Flush()
	}
	return s
}

// event writes a single SSE frame. `payload` is JSON-marshalled.
// We split data on newlines because SSE requires each line of the
// payload to be prefixed with "data: " — JSON marshalling rarely
// produces multi-line output but if a future field has an embedded
// newline we don't want to silently corrupt the framing.
func (s *sseWriter) event(name string, payload any) error {
	if s.closed {
		return fmt.Errorf("sse: writer closed")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	var buf strings.Builder
	buf.WriteString("event: ")
	buf.WriteString(name)
	buf.WriteByte('\n')
	for _, line := range strings.Split(string(body), "\n") {
		buf.WriteString("data: ")
		buf.WriteString(line)
		buf.WriteByte('\n')
	}
	buf.WriteByte('\n')

	if _, err := s.w.Write([]byte(buf.String())); err != nil {
		return err
	}
	if s.flusher != nil {
		s.flusher.Flush()
	}
	return nil
}

// errorAndClose emits an `error` event with the given message and
// marks the writer closed. Subsequent calls to event() return an
// error so the caller can stop work.
func (s *sseWriter) errorAndClose(message string) {
	_ = s.event("error", map[string]string{"message": message})
	s.closed = true
}

// done writes the terminal `done` event so the client can clean up.
func (s *sseWriter) done() {
	_ = s.event("done", map[string]any{})
}
