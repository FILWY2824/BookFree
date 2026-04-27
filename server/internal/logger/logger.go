// Package logger provides a tiny structured logger writing JSON to stderr.
//
// We deliberately avoid pulling in zap/zerolog/slog adapters: a single
// JSON encoder per call keeps allocation predictable and the binary
// small. slog from the stdlib would also work; this is essentially a
// pre-go-1.21 shim that we can swap for slog later without touching
// callers.
package logger

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"sync"
	"time"
)

type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

func (l Level) String() string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelInfo:
		return "info"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	}
	return "info"
}

func parseLevel(s string) Level {
	switch s {
	case "debug":
		return LevelDebug
	case "warn":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

type Logger struct {
	mu    sync.Mutex
	out   io.Writer
	level Level
}

var defaultLogger = &Logger{out: os.Stderr, level: LevelInfo}

// SetLevel reconfigures the package-level logger from a string. Safe to
// call from main() at startup.
func SetLevel(s string) { defaultLogger.level = parseLevel(s) }

type Fields map[string]any

func (l *Logger) emit(lvl Level, event string, fields Fields) {
	if lvl < l.level {
		return
	}
	rec := map[string]any{
		"t":     time.Now().UTC().Format(time.RFC3339Nano),
		"level": lvl.String(),
		"event": event,
	}
	for k, v := range fields {
		// errors don't JSON-encode their message by default — coerce.
		if e, ok := v.(error); ok {
			v = e.Error()
		}
		rec[k] = v
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := json.NewEncoder(l.out).Encode(rec); err != nil {
		// last-resort fallback: stdlib log.
		log.Printf("[logger] encode error: %v", err)
	}
}

func Debug(event string, f Fields) { defaultLogger.emit(LevelDebug, event, f) }
func Info(event string, f Fields)  { defaultLogger.emit(LevelInfo, event, f) }
func Warn(event string, f Fields)  { defaultLogger.emit(LevelWarn, event, f) }
func Error(event string, f Fields) { defaultLogger.emit(LevelError, event, f) }
