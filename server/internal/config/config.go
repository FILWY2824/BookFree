// Package config 负责读取 BookFree 后端启动时需要的配置。
//
// 对 Go 初学者来说，可以把这个包理解为“后端配置中心”：
// - 程序启动时，main.go 会先调用 config.Load()；
// - Load() 从操作系统环境变量里读取端口、数据库路径、存储目录、密钥等配置；
// - 读取完成后返回一个 *Config；
// - 之后 main.go 再把这些配置传给数据库、HTTP 服务、文件存储等模块。
//
// 为什么不把配置直接写死在代码里？
// 1. 本地开发、Docker 部署、服务器部署需要的配置通常不同；
// 2. 密钥、数据库路径、外部 AI Key 不能提交到 Git 仓库；
// 3. 同一份二进制程序可以通过不同环境变量运行在不同环境里。
//
// 本项目做过从旧的 Next.js/Node 项目到 Go 单体后端的迁移，
// 所以这里保留了“新变量名优先，旧变量名兜底”的兼容链：
//
//	BOOKFREE_*  新的、推荐使用的变量名
//	legacy      旧 Next.js 项目 .env 中曾经使用的变量名
//
// 例如 AppSecret 会依次读取：
// BOOKFREE_APP_SECRET → QS_MASTER_SECRET → APP_SECRET → NEXTAUTH_SECRET → ...
//
// 这样做的好处是：老用户原来的 .env 文件可以尽量不改，
// 直接换成新的 Go 后端二进制后仍然能启动。
package config

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

// Config 是 BookFree 后端启动后的“配置快照”。
//
// 这里的字段大多来自环境变量。程序启动后通常不会再动态改变这些字段，
// 因此可以认为它们是一次性加载的只读配置。
//
// 字段命名说明：
// - Env / Addr / DBURL 这类字段是基础运行配置；
// - Storage* 控制上传文件保存在哪里；
// - AppSecret / SessionCookie 和登录态、加密、Cookie 有关；
// - OpenAI / Anthropic / Gemini 是外部 AI 服务的可选配置；
// - TrustedProxies 用于反向代理部署时正确识别真实客户端 IP。
type Config struct {
	// Env 表示当前运行环境。
	//
	// 常见取值：
	// - development：本地开发，错误信息可以更详细；
	// - production：生产部署，错误信息更保守，必须配置密钥。
	Env string

	// Addr 是 HTTP 服务监听地址。
	//
	// 示例：
	// - "127.0.0.1:3001"：只允许本机访问，适合本地开发；
	// - "0.0.0.0:3001"：允许外部机器访问，适合 Docker/服务器部署。
	Addr string

	// PublicURL 是外部访问 BookFree 的公开地址。
	//
	// 例如反向代理后可能是：
	// https://reader.example.com
	//
	// 当前不是所有模块都会用到它，但保留它有利于后续生成回调地址、
	// 分享链接、OAuth 回调等功能。
	PublicURL string

	// DBURL 是 SQLite 数据库地址。
	//
	// 当前项目优先使用本地 SQLite，默认值是：
	// file:./data/bookfree.db
	//
	// 注意：这不是远程数据库连接池，而是一个本地文件路径。
	// 这符合 BookFree 低内存、易部署、自托管的目标。
	DBURL string

	// StorageDriver 表示文件存储驱动。
	//
	// 当前默认是 local，即上传的书籍文件保存在本机目录。
	// 后续如果要扩展 S3、对象存储等，可以围绕这个字段做切换。
	StorageDriver string

	// StorageDir 是本地文件存储目录。
	//
	// 当 StorageDriver=local 时，上传的 EPUB/PDF/TXT 原始文件等
	// 会存放在这个目录下。
	StorageDir string

	// AppSecret 是应用主密钥。
	//
	// 它通常用于派生加密密钥、签名密钥等安全用途。
	// 生产环境必须显式配置，不能使用空值或临时默认值。
	AppSecret string

	// SessionCookie 是保存登录 session 的 Cookie 名称。
	//
	// 保持这个字段可配置，有利于：
	// - 兼容旧系统 Cookie；
	// - 避免同域名下多个应用 Cookie 名冲突。
	SessionCookie string

	// MaxUploadMB 是单个上传文件大小上限，单位是 MB。
	//
	// 例如 100 表示最多上传 100MB 的书籍文件。
	// 对阅读器来说，上传限制既能保护服务器磁盘，也能避免大文件解析造成内存峰值。
	MaxUploadMB int

	// LogLevel 是日志级别，例如 debug/info/warn/error。
	//
	// main.go 会读取它并配置 logger。
	LogLevel string

	// EnablePProf 控制是否开启 Go pprof 调试接口。
	//
	// pprof 可以帮助分析 CPU、内存、goroutine 等问题。
	// 但生产环境暴露 pprof 有安全风险，所以默认关闭。
	EnablePProf bool

	// WebDistDir 是前端静态文件目录的可选覆盖值。
	//
	// 正常构建后，Go 后端可以从 server/webdist 嵌入的文件系统中提供前端 SPA。
	// 本地开发时，如果想从磁盘目录直接读取构建产物，可以设置这个字段。
	WebDistDir string

	// OpenAIAPIKey 是 OpenAI API Key。
	//
	// 为空表示未配置 OpenAI，AI 模块应自行降级或提示用户配置。
	OpenAIAPIKey string

	// OpenAIModel 是默认 OpenAI 模型名。
	//
	// 例如 gpt-4o-mini、gpt-4.1-mini 等。
	OpenAIModel string

	// AnthropicAPIKey 是 Anthropic Claude 的 API Key。
	AnthropicAPIKey string

	// GeminiAPIKey 是 Google Gemini 的 API Key。
	GeminiAPIKey string

	// TrustedProxies 是原始的、逗号分隔的可信代理列表。
	//
	// 它会在 HTTP 层由 httpsrv.ParseTrustedProxies 解析。
	//
	// 为什么需要它？
	// 如果 BookFree 部署在 Nginx/Caddy/Cloudflare Tunnel 后面，
	// Go 程序看到的直接连接 IP 可能只是代理服务器 IP。
	// 只有当代理可信时，后端才应该相信 X-Forwarded-For、
	// X-Real-IP、X-Forwarded-Proto 等头部。
	//
	// 示例：
	// - "127.0.0.1,::1"：反向代理和 BookFree 在同一台机器；
	// - "10.0.0.0/8,172.16.0.0/12"：私有网络集群。
	TrustedProxies string
}

// Load 从环境变量中读取配置，并返回 Config。
//
// 这个函数只做“启动级别”的基础校验：
// - 设置默认值；
// - 解析数字/布尔配置；
// - 生产环境强制要求 AppSecret。
//
// 更具体的约束通常由下游模块自己检查。
// 例如：
// - db.Open 会检查 DBURL 是否能打开；
// - storage.OpenLocal 会检查存储目录；
// - HTTP handler 会检查请求参数是否合法。
func Load() (*Config, error) {
	/*
	 * 这里使用 firstNonEmpty(...) 是为了实现“优先级读取”。
	 *
	 * 例如 Env：
	 * - 如果 BOOKFREE_ENV 有值，就使用它；
	 * - 否则尝试 NODE_ENV；
	 * - 再否则尝试 ENV；
	 * - 都没有则返回空字符串，后面再设置默认值 development。
	 */
	c := &Config{
		Env:             firstNonEmpty("BOOKFREE_ENV", "NODE_ENV", "ENV"),
		Addr:            firstNonEmpty("BOOKFREE_ADDR", "ADDR", "PORT"),
		PublicURL:       firstNonEmpty("BOOKFREE_PUBLIC_URL", "PUBLIC_URL", "NEXT_PUBLIC_URL"),
		DBURL:           firstNonEmpty("BOOKFREE_DB_URL", "TURSO_DATABASE_URL", "DATABASE_URL"),
		StorageDriver:   firstNonEmpty("BOOKFREE_STORAGE_DRIVER", "STORAGE_DRIVER"),
		StorageDir:      firstNonEmpty("BOOKFREE_STORAGE_DIR", "STORAGE_DIR"),
		AppSecret:       firstNonEmpty("BOOKFREE_APP_SECRET", "QS_MASTER_SECRET", "APP_SECRET", "NEXTAUTH_SECRET", "SESSION_SECRET", "QS_CONFIG_SECRET"),
		SessionCookie:   firstNonEmpty("BOOKFREE_SESSION_COOKIE", "AUTH_COOKIE_NAME"),
		LogLevel:        firstNonEmpty("BOOKFREE_LOG_LEVEL", "LOG_LEVEL"),
		WebDistDir:      firstNonEmpty("BOOKFREE_WEBDIST_DIR"),
		OpenAIAPIKey:    firstNonEmpty("OPENAI_API_KEY"),
		OpenAIModel:     firstNonEmpty("OPENAI_MODEL"),
		AnthropicAPIKey: firstNonEmpty("ANTHROPIC_API_KEY"),
		GeminiAPIKey:    firstNonEmpty("GEMINI_API_KEY"),
		TrustedProxies:  firstNonEmpty("BOOKFREE_TRUSTED_PROXIES", "TRUSTED_PROXIES"),
	}

	/*
	 * 下面开始补默认值。
	 *
	 * 默认值的原则：
	 * - 本地开发应尽量开箱即用；
	 * - 生产环境涉及安全的配置不能偷偷给弱默认值；
	 * - 路径尽量落在 ./data 下，方便 Docker volume 或本地备份。
	 */

	if c.Env == "" {
		c.Env = "development"
	}

	if c.Addr == "" {
		c.Addr = "127.0.0.1:3001"
	} else if !strings.Contains(c.Addr, ":") {
		/*
		 * 兼容 PORT=3001 这种部署平台常见写法。
		 *
		 * net/http 监听地址通常需要 "host:port"。
		 * 如果用户只填了 "3001"，这里自动补成 "127.0.0.1:3001"。
		 */
		c.Addr = "127.0.0.1:" + c.Addr
	}

	if c.DBURL == "" {
		c.DBURL = "file:./data/bookfree.db"
	}

	if c.StorageDriver == "" {
		c.StorageDriver = "local"
	}

	if c.StorageDir == "" {
		c.StorageDir = "./data/storage"
	}

	if c.SessionCookie == "" {
		/*
		 * 这里沿用旧 Next.js 项目的默认 Cookie 名称。
		 *
		 * 好处是迁移时如果浏览器里已有旧服务写入的 Cookie，
		 * 新 Go 服务可以尽量保持兼容，减少用户重新登录的概率。
		 */
		c.SessionCookie = "alma_session"
	}

	if c.LogLevel == "" {
		c.LogLevel = "info"
	}

	/*
	 * 上传大小限制也遵循同样的优先级规则：
	 * BOOKFREE_MAX_UPLOAD_SIZE_MB 优先，其次 MAX_UPLOAD_SIZE_MB。
	 *
	 * strconv.Atoi 会把字符串转成整数。
	 * 如果环境变量不是合法数字，当前逻辑会忽略它并使用默认值。
	 */
	if v := firstNonEmpty("BOOKFREE_MAX_UPLOAD_SIZE_MB", "MAX_UPLOAD_SIZE_MB"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.MaxUploadMB = n
		}
	}
	if c.MaxUploadMB == 0 {
		c.MaxUploadMB = 100
	}

	/*
	 * 是否开启 pprof。
	 *
	 * 支持两种常见写法：
	 * - BOOKFREE_ENABLE_PPROF=1
	 * - BOOKFREE_ENABLE_PPROF=true
	 */
	if v := firstNonEmpty("BOOKFREE_ENABLE_PPROF"); v != "" {
		c.EnablePProf = v == "1" || strings.EqualFold(v, "true")
	}

	/*
	 * 生产环境安全硬校验。
	 *
	 * 如果生产环境没有 AppSecret，程序直接启动失败。
	 * 这比“自动使用开发默认密钥”更安全，因为默认密钥会导致：
	 * - Cookie/session 容易被伪造；
	 * - 加密数据无法保证安全；
	 * - 多实例部署时行为不可控。
	 */
	if c.IsProduction() && c.AppSecret == "" {
		return nil, errors.New("config: no master secret configured (set BOOKFREE_APP_SECRET / QS_MASTER_SECRET / APP_SECRET / NEXTAUTH_SECRET / SESSION_SECRET)")
	}

	return c, nil
}

// IsProduction 判断当前是否是生产环境。
//
// 这个方法让调用方不用到处写 c.Env == "production"，
// 代码可读性更好，也方便以后统一调整生产环境判断规则。
func (c *Config) IsProduction() bool { return c.Env == "production" }

// firstNonEmpty 按顺序读取多个环境变量，并返回第一个非空值。
//
// 参数 keys 使用了 Go 的可变参数语法：
//
//	func firstNonEmpty(keys ...string)
//
// 调用时可以传任意数量的字符串：
//
//	firstNonEmpty("A", "B", "C")
//
// 函数内部的 keys 会变成 []string。
//
// strings.TrimSpace 会去掉首尾空白，避免用户在 .env 中不小心写出：
//
//	BOOKFREE_ADDR=" 127.0.0.1:3001 "
//
// 这种值时导致解析异常。
func firstNonEmpty(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}
