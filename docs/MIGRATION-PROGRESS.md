# BookFree 迁移 — 进度与路线图

本文档用于跟踪 Next.js → Go + Vite SPA 迁移状态。它的存在是为了让任何运维人员（或未来的我）都能在不重新从源码推导每个决定的情况下接手工作。请从上到下阅读。

---

## 状态摘要

| 阶段 | 范围 | 状态 |
|-----:|------|------|
| 1 | 仓库拆分、Go 模块、构建环境 | ✅ 已完成 |
| 1 | Vite SPA 外壳 | ✅ 已完成 |
| 2 | DB 层（sqlite、迁移、FTS5） | ✅ 已完成 |
| 2 | AES-GCM v1：信封格式（兼容性锁定） | ✅ 已完成 |
| 2 | scrypt 密钥派生（兼容性锁定） | ✅ 已完成 |
| 2 | Session + 鉴权中间件 | ✅ 已完成 |
| 2 | 健康检查、图书 CRUD、文件流式传输 | ✅ 已完成 |
| 2 | 流式上传（不缓冲） | ✅ 已完成 |
| 2 | 章节 / 进度 / 搜索 | ✅ 已完成 |
| 3 | 高亮 + 笔记 | ⬜ 未开始 |
| 3 | 阅读偏好 + 阅读会话 | ⬜ 未开始 |
| 4 | 异步导入 worker（或 Web Worker 路径） | ⬜ 未开始 |
| 5 | AI provider + AES 信封往返 | ⬜ 未开始 |
| 5 | 聊天 SSE 端点 + 5 个 provider 适配器 | ⬜ 未开始 |
| 10 | 管理面板（配置 / 用户等） | ⬜ 未开始 |
| 11 | EPUB / PDF / MOBI 解析器迁移 | ⬜ 未开始 |
| 12 | 存储抽象（S3/Turso） | ⚠️ 仅接口 |

当前交付内容足以注册、登录、上传书籍、列出书籍、通过 Range 请求获取原始文件、获取章节元数据、保存阅读进度并执行 FTS5 搜索。其他内容都是支撑这些功能的基础设施。

---

## 架构

```
┌──────────────────────────┐        ┌──────────────────────────────┐
│  apps/web   (Vite SPA)   │        │  server (Go 单二进制文件)    │
│                          │        │                              │
│  React 18 + react-router │  HTTP  │  cmd/bookfree     入口点     │
│  api.ts envelope client  ├───────►│  internal/http    路由       │
│  AuthProvider + Guard    │        │  internal/auth    session    │
│  pages/Login + Library   │        │  internal/books   CRUD+上传  │
│  pages/Reader (shell)    │        │  internal/storage 本地 FS    │
│  Web Workers (阶段 11)   │        │  internal/security AES+scrypt│
│                          │        │  internal/db      迁移       │
│  构建到 dist/，然后      │        │  internal/search  FTS5+bigram│
│  嵌入进二进制文件        ├───────►│  webdist/         //go:embed │
└──────────────────────────┘ static └──────────────────────────────┘
                                              │
                                              ▼
                                    SQLite（FTS5 + WAL + 8 MiB cache）
                                    本地 FS（data/storage/users/<id>/...）
```

单二进制文件，不使用 CGO。`main.go` 中通过 `GOMEMLIMIT=80MiB` 固定内存上限；使用全新 DB 并内嵌 SPA 时，空闲 RSS 观测值约 98 MB（18 MB 差值来自 Go 运行时开销 — 堆上限生效，但 RSS 会像往常一样滞后回收）。

---

## 如何添加一个新端点

`internal/http/router.go` 中的 router 是连接各模块的主干。以添加 `POST /api/highlights` 为例：

1. 创建 `internal/highlights/handlers.go`，定义一个 `Handler` 结构体，保存所需依赖（DB、IsProd 等）。
2. 按照 books / progress 的模式添加 handler 方法：
   ```go
   func (h *Handler) HandleCreate(w http.ResponseWriter, r *http.Request) {
       user := auth.UserFromContext(r.Context())
       // ... 校验请求体，执行查询，写入 response.OK / response.Fail
   }
   ```
3. 在 `router.go` 中注册：
   ```go
   hl := &highlights.Handler{DB: deps.DB, IsProd: deps.IsProd}
   mux.Handle("POST /api/highlights",
       auth.RequireUser(http.HandlerFunc(hl.HandleCreate)))
   ```
4. 如果这是稳定 API 表面，则在 `apps/web/src/lib/api.ts` 的消费者侧添加函数；否则直接内联调用 `api.post('/api/highlights', body)`。

这就是完整模式。每个旧版 `/api/*` 路由都能转换为一个 Go handler 方法，大多数形状都可以照着复制。

### 将旧 DAL 翻译为 Go

每个 DAL 函数 `legacy/src/lib/dal/<x>.js` 都会变成 `server/internal/<x>/store.go` 中的函数。翻译过程是机械的：

| 旧版 JS | Go 等价写法 |
|---------|-------------|
| `async function listFooByUser(db, userId)` | `func ListByUser(ctx, db, userID)` |
| `await db.execute({ sql, args })` | `db.QueryContext(ctx, sql, args...)` |
| `rowToFoo(row)` | 一个 struct + scan 辅助函数 |
| `return rows.map(rowToFoo)` | 在 `for rows.Next()` 循环中 scan |

旧版时间戳以 `unixepoch()` 整数存储。Go 的 `time.Time` 不应直接出现在列扫描中；请使用 `int64`，并在 HTTP 边界按需转换。

---

## 阶段 3 — 高亮 / 笔记 / 偏好（预计 2 天）

Schema 已经存在（迁移 0004、0008、0019）。还需要：

- `internal/highlights/store.go`：按 `(user_id, book_id)` 作用域实现 Create / List / Update / Delete。参考 `src/lib/dal/highlights.js`。
- `internal/notes/store.go`：同样形状；注意软删除语义（`deleted_at IS NOT NULL`）— notes FTS 触发器会遵守它，因此搜索不会返回已删除笔记。
- `internal/highlights/handlers.go` + `internal/notes/handlers.go`：按旧版形状实现 REST verbs。
- 接入 `router.go`。

0020 中添加的触发器已经会把 notes 表回填到 `notes_fts`，因此创建后搜索无需 Go 侧额外代码即可工作。

## 阶段 4 — 异步导入（预计 3 天）

迁移计划中有两条路径，现有 schema 都已覆盖：

**服务端 worker（与旧版一致）。** 长时间运行的 goroutine，轮询 `ingestion_jobs` 并运行特定格式解析器。EPUB 和 TXT 是容易的优先项（已有 Go 原生库）。PDF 和 MOBI 需要子进程 — 旧版使用的是 `pdf-parse` 和手写 MOBI 解析器。

**客户端解析器（推荐）。** SPA 加载一个 Web Worker，在本地解析书籍，然后向 `/api/books/<id>/ingest` POST 一批 `{ chapter, chunks }` 行。Go 侧只负责插入。这样可以保持服务端内存极低，因为解析是旧技术栈中最重的操作。

推荐顺序：先交付 Go 侧 TXT（很简单：按换页符或 N 行窗口切分，写入 chunks）。然后是 SPA worker for EPUB。PDF 最后，因为在 worker 中使用 pdf.js 解析并不简单。

## 阶段 5 — AI provider + 聊天（预计 1 周）

5 个 provider 适配器（OpenAI、Anthropic、Gemini、Volcengine、Groq）共享同一个流式转换契约：从上游读取 SSE/JSON-lines，向 SPA 发出我们自己的 SSE 事件。翻译好一个后，其他都能按相同模式实现。

关键兼容点：provider API key 通过 `security.Encrypt()` 加密，密文存储在 `ai_providers.api_key`。该 envelope 与 JS 代码字节级一致，因此旧应用存储的已有 provider 行可以通过 Go 解密完成往返。

测试工具应使用已知 key 往返一个 provider，并确认从 JS 加密行中解出的明文一致。这个单一测试可以捕获所有 key / IV / 格式错误。

## 阶段 11 — 阅读器

这超出了后端范围，但 API 契约已锁定：

- `GET /api/books/{id}/file` 支持 Range，流式返回原始文件。pdf.js 每次抓取几 KB；epub.js 下载后在 worker 中解压。两者当前都可用。
- `GET /api/books/{id}/chapters/list` 返回目录。
- `GET /api/books/{id}/chapters/{chapterId}` 返回渲染后的 HTML + plaintext（由导入 worker / web worker 填充）。
- `PUT /api/books/{id}/progress` upsert 当前阅读位置。

阅读器所需的一切都已接好。

---

## 运维手册

```sh
# 构建
make build

# 使用默认开发配置运行（写入 ./data/、./storage/）
make run

# 对已有 DB 应用迁移
./bookfree-server migrate

# 从旧 book_chunks / notes 行回填 FTS5
./bookfree-server backfill-fts

# 提升用户权限
./bookfree-server make-admin you@example.com

# 用磁盘上的 SPA 覆盖内嵌 SPA（开发热重载）
BOOKFREE_WEBDIST_DIR=apps/web/dist ./bookfree-server
```

## 加密兼容性说明

迁移计划明确列出这些点，是因为任何一个做错都会静默破坏与现有数据的往返兼容性。

- **AES-GCM 信封：** `"v1:" + base64(iv(12) || tag(16) || ciphertext)`。
  注意 JS 从 `cipher.final()` 产生 `iv || ct || tag` — 旧代码会重排为 `iv || tag || ct`。Go 的 `cipher.AEAD.Seal` 返回 `ct || tag`；我们手动拼接。见 `internal/security/crypto.go`。
- **scrypt：** N=16384，r=8，p=1，keyLen=32，salt=`sha256("qishu:salt:" + purpose)`。
  三个 purpose：`ai-provider`、`app-config`、`oauth-tokens`。
- **bcrypt：** cost 10。`bcryptjs` 写入 `$2a$`；Go 的 `bcrypt` 同时接受 `$2a$` 和 `$2b$`。已验证。
- **Session cookie：** `<session_id>.<raw_token>`。id 是 16 字节 hex，raw_token 是 32 字节 base64url **无填充**。padding 不匹配是最常见的兼容性 bug。

---

## 网络限制规避方案

本轮迭代的构建环境无法访问 `proxy.golang.org` 或 vanity hosts（`golang.org/x/*`）。我们在 `go.mod` 中使用 `replace` 指令指向 GitHub mirror：

```
replace golang.org/x/crypto => github.com/golang/crypto v0.27.0
```

如果你的环境可以自由访问网络，可以移除该 replace，使用默认 proxy。

## 使用 CGO + FTS5 构建

SQLite driver 是 `mattn/go-sqlite3`，它需要 CGO，并需要构建标签来启用 FTS5：

```sh
GOPROXY=direct GOSUMDB=off CGO_ENABLED=1 \
  go build -tags 'sqlite_fts5 sqlite_omit_load_extension' \
           -ldflags='-s -w' \
           -o bookfree-server ./cmd/bookfree
```

`-tags sqlite_fts5` 会编译进 FTS5 支持（mattn 默认省略它）。`-tags sqlite_omit_load_extension` 会移除 SQLite 运行时扩展加载 API — 我们从不用它，禁用后可以缩小攻击面。`-ldflags='-s -w'` 会去除符号表，二进制文件可节省约 5 MB。

Makefile 已经编码了这些 flags。`make build` 是标准构建命令。

## 内存画像

从 `ncruces/go-sqlite3`（wasm）切换到 `mattn/go-sqlite3`（CGO + libsqlite3）后，x86_64 Linux 上的测量结果：

| 状态 | RSS |
|------|---:|
| 空闲 | 32 MB |
| 50 MB 流式 PUT 上传期间 | 32 MB |
| 注册 / 登录 / 上传 / 搜索往返后 | 33 MB |

流式上传管线（head buffer → magic-number sniff → io.MultiReader → io.Copy → atomic rename）不会随着文件大小增加内存。5 GB 上传表现相同。

如果环境变量未设置，`main.go` 会设置 `GOMEMLIMIT=48MiB` 和 `GOGC=30`。更紧的 `GOGC` 会用少量 CPU 换取搜索或聊天等突发工作期间更紧的峰值堆。两者都可以通过标准环境变量覆盖，无需重建。

---

## 我接下来会按顺序做什么

1. **高亮 + 笔记端点** — schema 和 FTS 触发器已存在；这纯粹是 DAL + handler 样板。约 2 天。
2. **阅读偏好 upsert** — 单端点、单表。约半天。
3. **Web Worker EPUB 解析器** — 用户可见收益最大，因为它会让阅读器端到端工作。包含 `/api/books/{id}/ingest` POST 端点约 3 天。
4. **AI provider 配置 CRUD** + encrypt/decrypt 往返测试。约 2 天。
5. **Chat SSE handler**，先接一个 provider（OpenAI-compatible adapter 可以一次覆盖 OpenAI + Groq + Volcengine）。约 3 天。
6. **管理面板** — 前端工作量较大，后端主要是薄查询。排期取决于 UX 要求。

每一步都是独立且可发布的。无需完成整个阶段 3 后才能开始阶段 5。

---

## 审计后加固（当前构建）

生产审计中的 P0 / P1 项已在本次交付中解决：

- **P0-01** — `Dockerfile` 现在复制 `apps/web/public/`，因此 Vite 会把 `robots.txt` 输出到 `dist/`；server stage 的存在性检查不再失败。
- **P0-02** — `/api/auth/register` 会返回可执行的错误信息，引导操作员使用 `bookfree-server make-admin` 和 `BOOKFREE_ALLOW_REGISTRATION`。
- **P0-03** — 真实阅读器管线：客户端 TXT/EPUB 解析器 → `POST /api/books/{id}/ingest` → `book_chapters` + `book_chunks` + FTS5。PDF 通过懒加载 pdf.js 渲染，无需 ingest。EPUB 也有基于 CFI 的 epubjs 阅读器。
- **P0-04** — SQLite PRAGMA（`_foreign_keys`、`_busy_timeout`、`_journal_mode`、`_synchronous`、`_cache_size`、`_temp_store`）现在挂在 DSN 上，因此每个池化连接都会获得它们 — 不再只有第一个连接。回归测试在 `internal/db/db_test.go`。
- **P0-05** — README 的原生构建路径记录了必需的 `sqlite_fts5` 构建标签，并推荐 `make build`。
- **P1-01** — 登录无条件运行 bcrypt（用户不存在时使用 dummy hash），因此未知邮箱和错误密码分支耗时一致。
- **P1-02** — 基于内存 token bucket 对 `/api/auth/login`（20/min）、`/api/auth/register`（5/10min）、`/api/books/upload`（30/min）、`/api/books/{id}/ingest`（60/min）限流。
- **P1-03** — `BOOKFREE_TRUSTED_PROXIES`（CIDR 列表）。只有当直接对端地址位于这些 CIDR 之一时，才会信任 `X-Forwarded-For` / `X-Real-IP`；空列表（默认）表示完全忽略转发头。
- **P1-04** — `DELETE /api/books/{id}` 在同一个事务中收集 `storage_key`，然后在提交后从 storage driver 删除。
- **P1-05** — 上传使用 `stored && !committed` deferred cleanup，覆盖 Stat / BeginTx / INSERT / Commit 失败。
- **P1-06** — 当 DB 或 secret 不健康时，`GET /api/health` 返回 HTTP 503。Docker healthcheck 现在依赖 HTTP 状态码，而不是 grep JSON body。
- **P1-07** — 测试：
  `internal/db/db_test.go`（DSN PRAGMA）、
  `internal/http/middleware_test.go`（trusted-proxy resolver + request-id charset）、
  `internal/auth/handlers_test.go`（登录耗时等价、注册提示可操作）。

顺手解决的 P2 项：

- **P2-03** — `secureHeaders` 现在设置 CSP +（条件）HSTS。
- **P2-04** — `validRequestID()` 将入站 `X-Request-Id` 限制为 `[A-Za-z0-9._-]{1,64}`，因此可以原样嵌入日志。
