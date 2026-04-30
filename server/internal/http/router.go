// Package httpsrv 负责组装 BookFree 的 HTTP 服务。
//
// 对初学者来说，这个包可以理解为“后端路由总表”：
// - 哪个 URL 对应哪个 handler；
// - 哪些接口需要登录；
// - 哪些接口需要限流；
// - 请求进入业务 handler 前要经过哪些中间件；
// - 前端 SPA 静态文件如何被同一个 Go 服务托管。
//
// 本文件 router.go 是其中最重要的入口。
// main.go 会调用 httpsrv.New(deps)，得到一个 http.Handler，
// 然后把这个 handler 交给标准库 HTTP Server 启动。
package httpsrv

import (
	"database/sql"
	"io/fs"
	"net"
	"net/http"
	"time"

	"bookfree/internal/ai"
	"bookfree/internal/auth"
	"bookfree/internal/books"
	"bookfree/internal/chapters"
	"bookfree/internal/health"
	"bookfree/internal/ingest"
	"bookfree/internal/notes"
	"bookfree/internal/progress"
	"bookfree/internal/response"
	searchapi "bookfree/internal/search"
	"bookfree/internal/security"
	"bookfree/internal/storage"
)

// RouterDeps 汇总所有 handler 需要用到的外部依赖。
//
// 这种结构体常被称为“依赖注入对象”：
// - main.go 负责创建真实依赖，例如数据库、存储、session；
// - router.go 只接收这些依赖，然后传给各个模块；
// - 各个 handler 不需要自己读取环境变量，也不需要自己创建数据库连接。
//
// 这样做的好处：
// 1. 模块边界清晰：books/auth/notes/search 各自只关心自己的 handler；
// 2. 更容易测试：测试时可以传入临时数据库或 mock storage；
// 3. 更适合未来多端：Web 和 Android 都调用同一套 /api/*，后端依赖不和前端页面耦合。
type RouterDeps struct {
	// DB 是 SQLite 数据库连接池。
	//
	// 注意 *sql.DB 不是单个连接，而是连接池。
	// 本项目在 db.Open 里限制了连接数量，以适配 SQLite 和低内存部署。
	DB *sql.DB

	// Storage 是文件存储接口。
	//
	// 当前实现是本地磁盘，用于保存上传的原始书籍文件。
	// 未来如果要支持 S3/R2，也可以在 storage 包里增加实现，路由层不用大改。
	Storage storage.Storage

	// Sessions 管理登录 session。
	//
	// Auth 中间件会从 Cookie 中读取 session，
	// 再把当前用户信息挂到请求 context 上。
	Sessions *auth.Store

	// KeyDeriver 用于派生加密密钥。
	//
	// 例如用户自定义 AI Provider 的 API Key 需要加密保存，
	// 就不能明文直接存数据库。
	KeyDeriver *security.KeyDeriver

	// IsProd 表示当前是否生产环境。
	//
	// handler 可以根据它决定：
	// - 错误信息是否隐藏内部细节；
	// - Cookie 是否使用更严格的安全属性；
	// - 注册等功能是否默认关闭。
	IsProd bool

	// Version 和 StartedAt 用于健康检查接口。
	Version   string
	StartedAt time.Time

	// WebDistFS 是嵌入到 Go 二进制中的前端静态文件。
	//
	// 如果 make build 把 Vite 构建产物嵌入了 server/webdist，
	// Go 后端就能直接托管 React SPA。
	WebDistFS fs.FS

	// WebDistDir 是开发时从磁盘目录读取前端静态文件的可选覆盖项。
	WebDistDir string

	// MaxUploadMB 限制单个上传文件大小。
	//
	// 这是保护内存、磁盘和网络的重要配置。
	MaxUploadMB int

	// AllowRegistration 控制是否允许新用户注册。
	//
	// 生产环境默认关闭，避免自托管实例暴露到公网后被陌生人注册。
	AllowRegistration bool

	// TrustedProxies 表示允许信任的反向代理 IP/CIDR。
	//
	// 如果服务直接暴露在公网，不应该信任任意客户端传来的：
	// - X-Forwarded-For
	// - X-Real-IP
	// - X-Forwarded-Proto
	//
	// 否则攻击者可以伪造 IP，绕过基于 IP 的限流或日志审计。
	//
	// 只有请求来自这些可信代理时，相关 header 才会被用于解析真实客户端 IP。
	TrustedProxies []*net.IPNet
}

// New 构建整个应用的 http.Handler。
//
// 标准库里的 http.Handler 可以理解为：
// “给我一个 HTTP 请求，我负责写出 HTTP 响应”的对象。
//
// 这里做三件核心事情：
// 1. 创建 http.ServeMux 路由器；
// 2. 把不同 API 路径注册到不同模块的 handler；
// 3. 用 chain(...) 包上一层层中间件。
//
// 中间件顺序（从外到内）：
//
//	requestID  →  recover  →  secureHeaders  →  accessLog  →  loadSession  →  mux
//
// 请求进入时先经过 requestID，最后才到具体路由。
// 响应返回时则按相反方向一层层返回。
//
// 每个路由的额外规则：
// - auth.RequireUser：访问用户数据前必须登录；
// - auth.RequireAdmin：必须是管理员；
// - RateLimit：对登录、注册、上传、解析等高成本接口限流。
func New(deps RouterDeps) http.Handler {
	// ServeMux 是 Go 标准库自带的路由器。
	//
	// Go 1.22+ 支持这种写法：
	//   "GET /api/books"
	//   "POST /api/auth/login"
	//   "GET /api/books/{id}"
	//
	// 它会同时匹配 HTTP 方法和路径，比旧版只写路径更清晰。
	mux := http.NewServeMux()

	// resolveIP 用于在“可信代理”场景下解析真实客户端 IP。
	//
	// 限流和访问日志都需要尽可能准确的客户端 IP。
	resolveIP := TrustedProxyResolver(deps.TrustedProxies)

	// ── Health（匿名可访问）────────────────────────────────────────
	//
	// 健康检查通常给 Docker、反向代理、监控系统使用。
	// 它不需要登录，否则部署平台无法判断服务是否存活。
	hh := &health.Handler{
		DB:        deps.DB,
		StartedAt: deps.StartedAt,
		Version:   deps.Version,
		Deriver:   deps.KeyDeriver,
	}
	mux.HandleFunc("GET /api/health", hh.HandleGet)

	// ── Auth（登录/注册/当前用户）──────────────────────────────────
	//
	// auth.Handler 负责：
	// - 登录；
	// - 退出；
	// - 注册；
	// - 查询当前用户 /api/auth/me。
	//
	// 其中 login/register 大多是匿名访问；
	// me/logout 会根据 Cookie 判断当前 session。
	ah := &auth.Handler{
		DB:                deps.DB,
		Sessions:          deps.Sessions,
		IsProd:            deps.IsProd,
		AllowRegistration: deps.AllowRegistration,
		TrustedClientIP:   resolveIP,
	}

	// 对高风险/高成本接口做限流。
	//
	// 为什么需要限流：
	// - 登录会做密码校验，bcrypt/argon 等哈希计算比较耗 CPU；
	// - 注册可能被垃圾账号滥用；
	// - 上传会消耗网络、磁盘；
	// - ingest 会写入章节、索引、搜索数据。
	//
	// 限流 key 以客户端 IP 为主。
	loginLimit := RateLimit(20, time.Minute, IPKey(resolveIP))
	registerLimit := RateLimit(5, 10*time.Minute, IPKey(resolveIP))
	uploadLimit := RateLimit(30, time.Minute, IPKey(resolveIP))
	ingestLimit := RateLimit(60, time.Minute, IPKey(resolveIP))

	// mux.Handle 用于注册一个 http.Handler。
	// 这里 loginLimit(...) 返回的仍然是 http.Handler，
	// 只是它会先检查是否超出频率，再决定是否调用真正的登录 handler。
	mux.Handle("POST /api/auth/login", loginLimit(http.HandlerFunc(ah.HandleLogin)))
	mux.HandleFunc("POST /api/auth/logout", ah.HandleLogout)
	mux.Handle("POST /api/auth/register", registerLimit(http.HandlerFunc(ah.HandleRegister)))
	mux.HandleFunc("GET /api/auth/me", ah.HandleMe)

	// 账号自删除接口：DELETE /api/auth/me。
	//
	// 这个接口需要用户在请求体里提供密码。
	// 删除逻辑不只删除 users 表，还要清理：
	// - session；
	// - 用户书籍；
	// - 书籍关联的文件；
	// - 笔记、高亮、进度等相关数据。
	//
	// 所以它使用单独的 AccountHandler，并传入 Storage，确保磁盘文件也能清理。
	accountH := &auth.AccountHandler{
		DB:       deps.DB,
		Sessions: deps.Sessions,
		Storage:  deps.Storage,
		IsProd:   deps.IsProd,
	}
	mux.Handle("DELETE /api/auth/me",
		auth.RequireUser(http.HandlerFunc(accountH.HandleDeleteSelf)))

	// ── Books（书籍元数据、文件、上传）──────────────────────────────
	//
	// 这些接口都涉及用户私有数据，因此都需要 auth.RequireUser。
	//
	// 前端典型调用：
	// - LibraryPage 加载书架：GET /api/books
	// - BookCard 进入阅读页：GET /api/books/{id}
	// - UploadButton 上传：PUT/POST /api/books/upload
	// - Reader 下载原始文件：GET /api/books/{id}/file
	bh := &books.Handler{
		DB:          deps.DB,
		Storage:     deps.Storage,
		IsProd:      deps.IsProd,
		MaxUploadMB: deps.MaxUploadMB,
	}
	mux.Handle("GET /api/books", auth.RequireUser(http.HandlerFunc(bh.HandleList)))
	mux.Handle("GET /api/books/{id}", auth.RequireUser(http.HandlerFunc(bh.HandleGet)))
	mux.Handle("DELETE /api/books/{id}", auth.RequireUser(http.HandlerFunc(bh.HandleDelete)))
	mux.Handle("GET /api/books/{id}/file", auth.RequireUser(http.HandlerFunc(bh.HandleFile)))
	mux.Handle("PUT /api/books/upload", uploadLimit(auth.RequireUser(http.HandlerFunc(bh.HandleUpload))))
	mux.Handle("POST /api/books/upload", uploadLimit(auth.RequireUser(http.HandlerFunc(bh.HandleUpload))))

	// ── Ingest（前端解析完成后的回调）───────────────────────────────
	//
	// BookFree 当前的部分格式解析发生在前端：
	// - 前端读取 EPUB/PDF/TXT；
	// - 解析出章节、目录、文本；
	// - 再调用 ingest 接口把结构化结果写回后端数据库。
	//
	// 这样能减少后端常驻依赖和内存占用，符合小内存部署目标。
	ih := &ingest.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("POST /api/books/{id}/ingest", ingestLimit(auth.RequireUser(http.HandlerFunc(ih.HandlePost))))
	mux.Handle("POST /api/books/{id}/ingest/fail", auth.RequireUser(http.HandlerFunc(ih.HandleFail)))

	// ── Chapters（章节读取与目录）──────────────────────────────────
	//
	// 阅读页会通过这些接口获取：
	// - 章节列表；
	// - 某个章节正文；
	// - 目录 TOC。
	ch := &chapters.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("GET /api/books/{id}/chapters/list", auth.RequireUser(http.HandlerFunc(ch.HandleList)))
	mux.Handle("GET /api/books/{id}/chapters/{chapterId}", auth.RequireUser(http.HandlerFunc(ch.HandleGet)))
	mux.Handle("GET /api/books/{id}/toc", auth.RequireUser(http.HandlerFunc(ch.HandleTOC)))

	// ── Progress（阅读进度）────────────────────────────────────────
	//
	// 阅读进度是多端复用能力：
	// - Web 端读到第几章；
	// - 未来 Android 端继续阅读；
	// 都应该使用同一套后端 progress 接口。
	ph := &progress.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("GET /api/books/{id}/progress", auth.RequireUser(http.HandlerFunc(ph.HandleGet)))
	mux.Handle("PUT /api/books/{id}/progress", auth.RequireUser(http.HandlerFunc(ph.HandlePut)))

	// ── Notes / Highlights（笔记与高亮）────────────────────────────
	//
	// 高亮和笔记是阅读器核心用户数据：
	// - highlights：选中文本的高亮标记；
	// - notes：用户写下的评论/摘录/想法。
	//
	// 这里既提供“按书籍查询”，也提供“全局查询”，用于笔记页面汇总展示。
	nh := &notes.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("GET /api/books/{id}/highlights", auth.RequireUser(http.HandlerFunc(nh.HandleListHighlights)))
	mux.Handle("POST /api/books/{id}/highlights", auth.RequireUser(http.HandlerFunc(nh.HandleCreateHighlight)))
	mux.Handle("DELETE /api/highlights/{id}", auth.RequireUser(http.HandlerFunc(nh.HandleDeleteHighlight)))
	mux.Handle("GET /api/books/{id}/notes", auth.RequireUser(http.HandlerFunc(nh.HandleListNotes)))
	mux.Handle("POST /api/books/{id}/notes", auth.RequireUser(http.HandlerFunc(nh.HandleCreateNote)))
	mux.Handle("PUT /api/notes/{id}", auth.RequireUser(http.HandlerFunc(nh.HandleUpdateNote)))
	mux.Handle("DELETE /api/notes/{id}", auth.RequireUser(http.HandlerFunc(nh.HandleDeleteNote)))
	mux.Handle("GET /api/notes", auth.RequireUser(http.HandlerFunc(nh.HandleListAllNotes)))
	mux.Handle("GET /api/highlights", auth.RequireUser(http.HandlerFunc(nh.HandleListAllHighlights)))

	// ── Search（全文搜索）──────────────────────────────────────────
	//
	// 搜索依赖 SQLite FTS5。
	// 后端只提供稳定 HTTP API，前端 SearchPage 不需要知道 SQLite 细节。
	sh := &searchapi.Handler{DB: deps.DB, IsProd: deps.IsProd}
	mux.Handle("GET /api/search", auth.RequireUser(http.HandlerFunc(sh.HandleSearch)))

	// ── AI chat（AI 阅读助手）──────────────────────────────────────
	//
	// 这里是服务端 AI 代理层：
	// - 内置 AI：使用服务端配置的模型/API Key，并受用户限额控制；
	// - 自定义 Provider：用户保存自己的 OpenAI-compatible 配置；
	// - KeyDeriver：用于加密保存用户的 Provider Key。
	//
	// 这样前端和未来 Android 不需要直接处理供应商密钥，
	// API 也更容易保持稳定。
	aih := &ai.Handler{DB: deps.DB, IsProd: deps.IsProd, KeyDeriver: deps.KeyDeriver}
	mux.Handle("GET /api/ai/status", auth.RequireUser(http.HandlerFunc(aih.HandleStatus)))
	mux.Handle("POST /api/ai/chat", auth.RequireUser(http.HandlerFunc(aih.HandleChat)))
	mux.Handle("POST /api/ai/test", auth.RequireUser(http.HandlerFunc(aih.HandleTest)))
	mux.Handle("GET /api/ai/providers", auth.RequireUser(http.HandlerFunc(aih.HandleListProviders)))
	mux.Handle("POST /api/ai/providers", auth.RequireUser(http.HandlerFunc(aih.HandleCreateProvider)))
	mux.Handle("PUT /api/ai/providers/{id}", auth.RequireUser(http.HandlerFunc(aih.HandleUpdateProvider)))
	mux.Handle("DELETE /api/ai/providers/{id}", auth.RequireUser(http.HandlerFunc(aih.HandleDeleteProvider)))
	mux.Handle("GET /api/ai/providers/{id}/models", auth.RequireUser(http.HandlerFunc(aih.HandleListProviderModels)))
	mux.Handle("GET /api/ai/limits", auth.RequireUser(http.HandlerFunc(aih.HandleGetLimits)))
	mux.Handle("PUT /api/ai/limits", auth.RequireAdmin(http.HandlerFunc(aih.HandleSetLimits)))

	// ── /api/* 兜底：未知 API 返回 JSON 404 ───────────────────────
	//
	// 为什么要单独处理 /api/：
	// - 如果 API 路径写错，不应该返回前端 index.html；
	// - 前端 api.ts 期望后端返回 JSON 信封；
	// - 返回 HTML 会导致前端错误信息很难理解。
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		response.Fail(w, http.StatusNotFound, response.CodeNotFound,
			"未知 API 路由："+r.Method+" "+r.URL.Path)
	})

	// ── SPA 静态文件 fallback ─────────────────────────────────────
	//
	// 前端 React 使用 BrowserRouter。
	// 当用户直接打开 /library、/book/xxx 这类路径时，
	// 浏览器会向后端请求这个路径。
	//
	// 后端需要返回前端 index.html，让 React 接管路由，
	// 而不是把 /library 当成后端 API 路径。
	mux.Handle("/", NewSPAStaticHandler(deps.WebDistFS, deps.WebDistDir))

	// chain 把多个中间件包到 mux 外面。
	//
	// 从上到下看是“声明顺序”，实际请求进入时是：
	// requestID -> recover -> secureHeaders -> accessLog -> loadSession -> mux。
	return chain(mux,
		requestIDMiddleware,
		recoverMiddleware(deps.IsProd),
		secureHeadersMiddleware,
		accessLogMiddleware(resolveIP),
		auth.LoadSession(deps.Sessions),
	)
}
