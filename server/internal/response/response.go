// Package response carries the JSON envelope every handler returns.
//
// The shape is identical to src/lib/api/response.js so the existing
// frontend's apiClient — which inspects {ok, data, error} — keeps
// working unchanged after the cutover. We do NOT invent a new shape;
// the migration plan §6.1 explicitly requires compat.
package response

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"bookfree/internal/logger"
)

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details"`
	ErrorID string `json:"errorId,omitempty"`
}

type envelope struct {
	OK    bool       `json:"ok"`
	Data  any        `json:"data"`
	Error *errorBody `json:"error"`
}

// Common error codes — the JS ErrorCodes constant lives in
// src/lib/api/response.js. Keep this in lockstep so the frontend's
// switch statements over `error.code` stay valid.
const (
	CodeUnauthorized      = "UNAUTHORIZED"
	CodeForbidden         = "FORBIDDEN"
	CodeNotFound          = "NOT_FOUND"
	CodeValidation        = "VALIDATION"
	CodeConflict          = "CONFLICT"
	CodeUnsupportedFormat = "UNSUPPORTED_FORMAT"
	CodeDRMProtected      = "DRM_PROTECTED"
	CodeParseFailed       = "PARSE_FAILED"
	CodeInternal          = "INTERNAL"
	CodeCSRFRejected      = "CSRF_REJECTED"
	CodeRateLimited       = "RATE_LIMITED"
)

// OK writes a 2xx success envelope.
func OK(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusOK, envelope{OK: true, Data: data})
}

// Created writes a 201 success envelope. Used by POST handlers that
// genuinely create a resource.
func Created(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusCreated, envelope{OK: true, Data: data})
}

// Fail writes a deterministic error envelope at the given status. The
// frontend reads error.code first and error.message second, so both
// must be set.
func Fail(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, envelope{OK: false, Error: &errorBody{
		Code: code, Message: message,
	}})
}

// FailDetails is Fail with an arbitrary `details` payload (e.g. field
// validation errors).
func FailDetails(w http.ResponseWriter, status int, code, message string, details any) {
	writeJSON(w, status, envelope{OK: false, Error: &errorBody{
		Code: code, Message: message, Details: details,
	}})
}

// FailSafe is what handler-level catches use for unexpected errors.
// In production it returns a generic message + an errorId; the real
// error is logged so an operator can correlate. Same contract as the
// legacy failSafe() in src/lib/api/response.js.
func FailSafe(w http.ResponseWriter, where string, err error, status int, isProd bool) {
	id := randomErrorID()
	logger.Error(orDefault(where, "api.error"), logger.Fields{
		"errorId": id,
		"err":     err,
		"status":  status,
	})
	msg := "服务器内部错误（错误编号：" + id + "，请联系管理员查询日志）"
	if !isProd && err != nil {
		msg = err.Error() + "（errorId=" + id + "）"
	}
	writeJSON(w, status, envelope{OK: false, Error: &errorBody{
		Code: CodeInternal, Message: msg, ErrorID: id,
	}})
}

func randomErrorID() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, body envelope) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func orDefault(s, dflt string) string {
	if s == "" {
		return dflt
	}
	return s
}
