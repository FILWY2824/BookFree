// 中文导读：
// server.go 封装 HTTP 服务启动和优雅关闭逻辑。
// Go 标准库的 http.Server 支持设置读写超时、空闲连接超时、Shutdown 等能力。
// 这些超时很重要：它们能避免慢请求或异常连接长期占用 goroutine 和内存。
// BookFree 追求低内存常驻，所以这里不应该启动大量后台任务，也不应该无限等待关闭。
// 如果你要改监听地址、关闭超时、HTTP 超时参数，可以从这里入手。

package httpsrv

import (
	"context"
	"errors"
	"net/http"
	"time"

	"bookfree/internal/logger"
)

// Run starts the HTTP server and blocks until ctx is cancelled or the
// server fails. ListenAndServe is wrapped in a graceful-shutdown
// dance so an in-flight upload or AI stream isn't killed when the
// operator runs `systemctl restart`.
//
// The 30 s shutdown grace was picked to be comfortably longer than a
// typical upload chunk window but well under what most reverse
// proxies tolerate — Caddy and Nginx both default to ≥ 60 s.
func Run(ctx context.Context, addr string, handler http.Handler) error {
	srv := &http.Server{
		Addr:    addr,
		Handler: handler,
		// Read/Idle timeouts protect against slowloris-style attacks
		// without breaking long uploads (the upload handler streams
		// from r.Body, which doesn't reset these timeouts mid-flight,
		// so we keep them generous).
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		// No WriteTimeout: SSE chat streams legitimately keep the
		// response open for minutes. We rely on context cancellation
		// inside handlers to drop slow clients instead.
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("http.listening", logger.Fields{"addr": addr})
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		logger.Info("http.shutting_down", nil)
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("http.shutdown_err", logger.Fields{"err": err})
			return err
		}
		return nil
	}
}
