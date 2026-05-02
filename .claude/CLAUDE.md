# CLAUDE.md — BookFree 项目智能体开发文档

> **用途：** 本文档供 Claude Code 自动化开发使用。请在每次任务开始前通读本文档，以最少的 token 消耗完成高质量开发。
> **核心原则：** 先读再写、先测再提交、最小改动、中文注释。

---

## 一、项目概览

BookFree 是一个**自托管阅读器**，采用 Go 后端 + Vite/React 前端的单体架构，编译为单二进制部署。

| 维度 | 描述 |
|------|------|
| 后端 | Go 1.22+，内嵌 SQLite（FTS5 + WAL），CGO 编译（mattn/go-sqlite3） |
| 前端 | React 18 + TypeScript + Tailwind CSS + Vite 5，SPA 模式 |
| 部署 | 单二进制，Docker 一键部署，前端 dist 嵌入 Go 二进制 |
| 内存目标 | 空闲 RSS ≤ 50MB，容器硬限 256MB |
| 支持格式 | EPUB / PDF / TXT / CBZ |
| 核心功能 | 书架管理、阅读器、高亮/笔记、全文搜索、AI 对话、阅读进度 |

---

## 二、目录结构速查

```
BookFree-main/
├── apps/web/                     # 前端 Vite SPA
│   ├── src/
│   │   ├── components/           # 通用 UI 组件
│   │   ├── pages/                # 路由页面（Library/Reader/Search/Notes/AI/Stats/Settings）
│   │   ├── reader/               # 格式阅读器（Epub/Pdf/Txt/Cbz）
│   │   ├── lib/                  # 工具库（api.ts/auth.tsx/highlights.ts 等）
│   │   ├── parsers/              # 前端解析器（txt/epub/foliate）
│   │   ├── App.tsx               # 路由总表
│   │   └── main.tsx              # 入口
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
├── server/                       # Go 后端
│   ├── cmd/bookfree/main.go      # 程序入口、子命令分发
│   ├── internal/
│   │   ├── http/                 # 路由注册 + 中间件（router.go 是核心）
│   │   ├── auth/                 # 登录/注册/session/中间件
│   │   ├── books/                # 书籍 CRUD + 上传 + 文件流
│   │   ├── chapters/             # 章节读取、目录
│   │   ├── ingest/               # 前端解析结果回写后端
│   │   ├── notes/                # 高亮 + 笔记
│   │   ├── progress/             # 阅读进度
│   │   ├── search/               # FTS5 全文搜索 + bigram 分词
│   │   ├── ai/                   # AI 对话（SSE 流、RAG、provider 管理、限额）
│   │   ├── config/               # 环境变量配置
│   │   ├── db/                   # SQLite 连接 + 迁移
│   │   │   └── migrations/       # SQL 迁移文件（0000-0023）
│   │   ├── models/               # 共享数据结构（User/Book/BookChapter）
│   │   ├── response/             # 统一 JSON 信封（OK/Fail/FailSafe）
│   │   ├── security/             # 密码哈希/AES-GCM 加密/token/密钥派生
│   │   ├── storage/              # 文件存储接口（当前为 local FS）
│   │   ├── accounts/             # 账号管理
│   │   ├── health/               # 健康检查
│   │   └── logger/               # 结构化日志
│   ├── webdist/                  # 嵌入前端产物（go:embed）
│   ├── go.mod
│   └── go.sum
├── docs/MIGRATION-PROGRESS.md    # 迁移进度路线图
├── Makefile                      # 构建命令
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## 三、技术栈与依赖

### 后端（Go）
- **数据库：** mattn/go-sqlite3（CGO），编译 tag: `sqlite_fts5 sqlite_omit_load_extension`
- **加密：** golang.org/x/crypto（bcrypt 密码哈希、scrypt 密钥派生、AES-GCM 信封加密）
- **无第三方 HTTP 框架：** 纯标准库 `net/http` + Go 1.22 新路由语法 `"GET /api/books/{id}"`
- **无 ORM：** 直接 `database/sql` 操作 SQLite

### 前端（TypeScript/React）
- **路由：** react-router-dom v6
- **样式：** Tailwind CSS 3
- **构建：** Vite 5 + @vitejs/plugin-react
- **书籍解析：** epubjs、pdfjs-dist 4.7、foliate-js、fflate（zip）
- **无状态管理库：** 使用 React Context + useState

---

## 四、关键设计模式（必读）

### 4.1 后端 Handler 模式
所有 API handler 遵循相同结构：

```go
// 1. Handler 结构体持有依赖（依赖注入，不读环境变量）
type Handler struct {
    DB     *sql.DB
    IsProd bool
}

// 2. 方法签名统一为 (w http.ResponseWriter, r *http.Request)
func (h *Handler) HandleXxx(w http.ResponseWriter, r *http.Request) {
    // 3. 从 context 获取当前用户
    user := auth.UserFromContext(r.Context())

    // 4. 读取参数（路径参数用 r.PathValue，body 用 json.Decoder）
    id := r.PathValue("id")

    // 5. 业务逻辑 + 数据库操作
    // ...

    // 6. 统一响应：response.OK / response.Fail / response.FailSafe
    response.OK(w, data)
}
```

### 4.2 路由注册模式
在 `server/internal/http/router.go` 中注册：
```go
mux.Handle("POST /api/xxx", auth.RequireUser(http.HandlerFunc(handler.Method)))
```
- 需要登录的路由用 `auth.RequireUser()` 包裹
- 需要管理员的路由用 `auth.RequireAdmin()` 包裹
- 高风险接口加 `RateLimit()` 限流

### 4.3 API 响应信封
所有 JSON API 返回统一结构：
```json
{ "ok": true,  "data": {...}, "error": null }
{ "ok": false, "data": null,  "error": {"code": "VALIDATION", "message": "..."} }
```
错误码定义在 `response/response.go`：UNAUTHORIZED / FORBIDDEN / NOT_FOUND / VALIDATION / CONFLICT / INTERNAL / RATE_LIMITED 等。

### 4.4 前端 API 调用模式
通过 `lib/api.ts` 封装的 `api.get/post/put/delete` 调用，自动解析信封、处理 401 跳转。

### 4.5 数据库迁移
- 迁移文件在 `server/internal/db/migrations/` 下，按编号排序（0000-0023）
- 新增迁移文件命名为 `0024_xxx.sql`
- `db.Migrate()` 在启动时自动执行未运行的迁移
- **迁移只增不删，不修改已有迁移文件**

---

## 五、开发命令速查

```bash
# ── 构建 ──────────────────────────
make build          # 构建前端 + 后端（完整构建）
make build-web      # 仅构建前端 SPA
make build-server   # 仅构建 Go 后端
make run            # 构建并运行

# ── 测试 ──────────────────────────
make test           # 运行全部 Go 测试 (cd server && go test ./...)
cd server && go test ./internal/auth/...        # 测试单个包
cd server && go test -run TestLogin ./internal/auth/  # 测试单个函数
cd server && go test -v -count=1 ./...          # 详细输出，不缓存

# ── 前端 ──────────────────────────
cd apps/web && npm run dev          # Vite 开发服务器
cd apps/web && npm run build        # 生产构建
cd apps/web && npm run typecheck    # TypeScript 类型检查（tsc --noEmit）

# ── 运维 ──────────────────────────
make migrate        # 仅执行数据库迁移
make backfill       # FTS5 数据回填
./bookfree-server make-admin user@email.com  # 提升管理员
```

---

## 六、测试规范

### 6.1 Go 测试模式
项目使用标准库 `testing`，已有测试文件提供了可复用的 harness：

```go
// 创建内存 SQLite 测试数据库（含完整迁移）
func newTestDB(t *testing.T) *sql.DB {
    t.Helper()
    d, err := db.Open("file::memory:?cache=shared")  // 或使用 t.TempDir() 文件
    // ... Migrate + t.Cleanup
}

// 插入测试用户
func mustInsertUser(t *testing.T, d *sql.DB, email, password string) string { ... }

// 使用 httptest 测试 handler
req := httptest.NewRequest(http.MethodPost, "/api/xxx", strings.NewReader(body))
req.Header.Set("Content-Type", "application/json")
req.SetPathValue("id", bookID)  // Go 1.22 路径参数
req = req.WithContext(auth.WithUser(req.Context(), user))  // 注入用户上下文
rec := httptest.NewRecorder()
handler.HandleXxx(rec, req)
// 断言 rec.Code 和 rec.Body
```

### 6.2 已有测试清单
| 文件 | 覆盖范围 |
|------|----------|
| `auth/handlers_test.go` | 登录/注册/权限（含安全审计 P0/P1） |
| `http/middleware_test.go` | 可信代理 IP 解析、请求 ID 校验 |
| `ingest/handlers_test.go` | 导入 handler（PDF/TXT 空内容、ID 作用域隔离） |
| `search/tokenize_test.go` | 中日韩 bigram 分词、不支持脚本过滤 |
| `db/db_test.go` | DSN 构建（PRAGMA 默认值、用户覆盖、拒绝 libsql） |

### 6.3 测试编写原则
- 测试函数命名：`Test<Handler/Func>_<场景描述>`（英文，驼峰）
- 用 `t.Helper()` 标记辅助函数
- 用 `t.Cleanup()` 注册资源清理
- 用 `t.Run(name, func)` 进行子测试
- 失败断言用 `t.Fatalf`（阻断后续）或 `t.Errorf`（继续执行）
- 每个新 handler 至少覆盖：正常路径 + 参数校验失败 + 权限不足

---

## 七、代码风格与注释规范

### 7.1 中文注释规范
本项目**所有代码注释使用中文**。遵循以下模板：

```go
// HandleXxx 处理 XXX 请求。
//
// 请求参数：
// - id（路径）：书籍 ID
// - body（JSON）：{ "title": "..." }
//
// 响应：
// - 200：成功，返回更新后的数据
// - 400：参数校验失败
// - 401：未登录
func (h *Handler) HandleXxx(w http.ResponseWriter, r *http.Request) {
```

```typescript
/*
 * XxxPage 是 XXX 页面。
 *
 * 功能说明：
 * - 展示用户的 XXX 列表；
 * - 支持 XXX 操作。
 *
 * 路由：/xxx
 * 依赖接口：GET /api/xxx
 */
```

### 7.2 Go 代码风格
- 标准库优先，无第三方 HTTP/ORM 框架
- 错误处理：`if err != nil { return }` 模式，不用 panic
- 变量命名：Go 惯例短名（`w` / `r` / `db` / `ctx`）
- 包内私有类型/函数：小写开头
- 导出类型/函数：大写开头 + 注释

### 7.3 TypeScript 代码风格
- 函数组件 + Hooks，不用 class 组件
- 接口用 `interface`，类型用 `type`
- API 调用通过 `lib/api.ts`，不直接 fetch
- 使用 Tailwind 类，不写自定义 CSS（除非必要在 `styles.css`）

---

## 八、新增功能标准流程

### 8.1 新增后端 API 端点
1. **创建 handler：** `server/internal/<module>/handlers.go`
2. **定义 Handler 结构体**，持有 `DB *sql.DB`、`IsProd bool` 等依赖
3. **实现 handler 方法**，遵循第四节模式
4. **注册路由：** 在 `server/internal/http/router.go` 的 `New()` 中添加
5. **编写测试：** `server/internal/<module>/handlers_test.go`
6. **运行测试：** `cd server && go test ./internal/<module>/...`
7. **前端对接：** 在 `apps/web/src/lib/api.ts` 中添加调用函数（若稳定 API）

### 8.2 新增数据库表/字段
1. **创建迁移：** `server/internal/db/migrations/0024_xxx.sql`
2. **编号递增**，不修改已有迁移
3. **更新 models：** 如有新共享类型，更新 `models/types.go`
4. **测试迁移：** `make test`（测试会自动运行迁移）

### 8.3 新增前端页面
1. **创建页面：** `apps/web/src/pages/XxxPage.tsx`
2. **注册路由：** 在 `App.tsx` 的 `<Routes>` 中添加 `<Route>`
3. **需要登录的页面**用 `<AuthGuard>` 包裹
4. **类型检查：** `cd apps/web && npm run typecheck`

---

## 九、安全注意事项

- **SQL 注入：** 永远使用 `?` 占位符，禁止 `fmt.Sprintf` 拼接用户输入到 SQL
- **密钥管理：** 敏感配置通过 `BOOKFREE_APP_SECRET` 环境变量，不硬编码
- **加密存储：** 用户 AI Provider Key 通过 `security.KeyDeriver` + AES-GCM 加密后存 DB
- **密码哈希：** 使用 `security.HashPassword`（bcrypt），不自行实现
- **Session：** 服务端 session + HttpOnly Cookie，不用 JWT/localStorage
- **CSRF：** 有 CSRF 校验中间件
- **信任代理：** 只在 `TrustedProxies` 配置的 IP 范围内信任 X-Forwarded-For
- **生产模式：** `IsProd=true` 时错误信息隐藏内部细节，返回 errorId 供日志关联

---

## 十、环境变量速查

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BOOKFREE_APP_SECRET` | （必填） | 主密钥，用于加密和签名 |
| `BOOKFREE_ENV` | `development` | `production` 启用安全限制 |
| `BOOKFREE_ADDR` | `127.0.0.1:3001` | 监听地址 |
| `BOOKFREE_DB_URL` | `file:./data/bookfree.db` | SQLite 路径 |
| `BOOKFREE_STORAGE_DIR` | `./data/storage` | 上传文件存储目录 |
| `BOOKFREE_MAX_UPLOAD_SIZE_MB` | `100` | 单文件上传限制 |
| `BOOKFREE_ALLOW_REGISTRATION` | 开发=true/生产=false | 注册开关 |
| `ANTHROPIC_API_KEY` | （可选） | AI 对话功能 |
| `BOOKFREE_TRUSTED_PROXIES` | （空） | 可信反向代理 CIDR |

---

## 十一、常见错误排查

| 现象 | 排查方向 |
|------|----------|
| 构建失败 `cgo: C compiler not found` | 安装 gcc/clang，确保 `CGO_ENABLED=1` |
| `no such table` | 检查迁移文件编号连续性，运行 `make migrate` |
| 前端 API 404 返回 HTML | 后端 `/api/*` 兜底返回 JSON 404，检查路由注册 |
| 上传后书籍状态卡在 `uploaded` | 前端 ingest 未调用或失败，检查 `/api/books/{id}/ingest` |
| AI 对话返回 501 | 未配置 `ANTHROPIC_API_KEY` |
| 内存超限 OOM | 检查 `GOMEMLIMIT`，考虑减小上传限制或图片缓存 |

---

## 十二、迁移状态与待办

以下功能**已完成**（可直接使用）：
- 注册/登录/session、书籍 CRUD、文件流式上传、章节/进度/搜索
- 高亮 + 笔记、AI 对话（Anthropic）、FTS5 中日韩全文搜索
- 8 种阅读主题、Docker 部署、健康检查

以下功能**未实现**（可作为开发任务）：
- 阅读偏好 + 阅读会话统计
- 异步导入 worker
- 管理面板 UI
- MOBI/AZW3 解析
- 存储抽象（S3/R2）
- OAuth 登录

详见 `docs/MIGRATION-PROGRESS.md`。

---

## 十三、Token 节省策略

> 以下规则帮助 Claude Code 在开发时减少不必要的 token 消耗。

1. **不重复读取本文档**——首次任务读取后，后续任务只在需要特定章节时定向查阅
2. **精准定位文件**——修改前先 `grep` 或 `find` 定位，不遍历整个项目
3. **最小改动原则**——只修改必要文件，不做无关重构
4. **复用测试 harness**——使用已有的 `newTestDB` / `mustInsertUser` 等辅助函数
5. **不重复安装依赖**——Go 依赖已在 go.mod，npm 依赖已在 package.json
6. **批量操作**——多个小修改合并到一次编辑，减少工具调用
7. **跳过不需要的注释**——已有充分注释的代码不重复添加
8. **输出简洁**——测试通过后只报告结果，不复述测试代码
9. **善用 Go 1.22 路由语法**——直接 `"METHOD /path/{param}"`，不需要第三方路由库
10. **遵循已有模式**——新代码仿照同目录下最近的文件结构，不发明新模式
