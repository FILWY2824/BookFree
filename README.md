# BookFree

一个自托管阅读器。后端使用 Go，前端是 Vite/React 单页应用；支持单个二进制文件部署、低 RSS 内存占用和内嵌 SQLite。支持在浏览器中导入 EPUB、PDF 和 TXT，提供中日韩全文搜索、划线、高亮、笔记、阅读进度以及 8 种阅读主题。

> **状态（审计后）：** 生产审计中的所有 P0/P1 项目都已修复。AI 聊天、MOBI/AZW/FB2/CBZ 解析、管理面板 UI、OAuth 以及基于 Foliate 的阅读器有意不包含在当前范围内；完整状态矩阵请查看 [`docs/MIGRATION-PROGRESS.md`](./docs/MIGRATION-PROGRESS.md)。

## 快速开始（Docker）

```sh
# 1. 生成密钥并写入 .env（一次性操作）。
echo "BOOKFREE_APP_SECRET=$(openssl rand -hex 32)" > .env

# 2. 构建并启动。
docker compose --env-file .env up -d --build

# 3. 等待几秒钟，直到 /api/health 变为健康状态。
curl -fsS http://127.0.0.1:8788/api/health | jq

# 4. 创建第一个管理员用户。生产环境默认关闭自助注册，
#    因此有两种方式：
#
#    A. 先创建账号，再通过 CLI 提升为管理员（推荐）。
#       临时打开注册，注册完成后再关闭：
docker compose --env-file .env exec -e BOOKFREE_ALLOW_REGISTRATION=1 bookfree \
  /app/bookfree-server make-admin you@example.com
#
#    B. 或者长期打开注册（适合单用户/可信网络）。
#       将下面配置加入 .env 后执行 `docker compose up -d`：
#       BOOKFREE_ALLOW_REGISTRATION=1
```

然后访问 <http://127.0.0.1:8788>。

旧版 `docker-quickstart.sh` 脚本仍然保留，方便使用；但上面的四条命令正是它实际执行的内容，出问题时也更容易排查。

容器会把所有数据持久化到主机上的 `./data/`。请备份该目录。

## 原生构建（开发）

前置要求：Go 1.22+、Node 20+、gcc/clang（用于 CGO）。

```sh
# 最简单方式：Makefile 已经处理好 FTS5 构建标签和 webdist 复制。
make build
./bookfree-server
```

如果无法使用 `make`，等价命令如下：

```sh
# 1. 构建 SPA 包。
cd apps/web
npm install
npm run build
cd ../..

# 2. 将前端构建产物复制到 Go 的嵌入目录。
rm -rf server/webdist/assets server/webdist/index.html server/webdist/robots.txt
cp -r apps/web/dist/. server/webdist/

# 3. 构建 Go 二进制文件。构建标签是必须的；
#    如果没有 `sqlite_fts5`，搜索迁移会在启动时失败。
cd server
GOPROXY=direct GOSUMDB=off CGO_ENABLED=1 \
  go build \
    -tags 'sqlite_fts5 sqlite_omit_load_extension' \
    -trimpath -ldflags='-s -w' \
    -o ../bookfree-server \
    ./cmd/bookfree
cd ..

# 4. 运行。
BOOKFREE_APP_SECRET=$(openssl rand -hex 32) \
BOOKFREE_DB_URL='file:./data/bookfree.db' \
BOOKFREE_STORAGE_DIR=./data/storage \
./bookfree-server
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BOOKFREE_APP_SECRET` | — | 生产环境必填。32 位以上十六进制字符。 |
| `BOOKFREE_ENV` | `development` | 设置为 `production` 可启用更严格的安全默认值。 |
| `BOOKFREE_ADDR` | `127.0.0.1:3001` | Docker 镜像中为 `0.0.0.0:8788`。 |
| `BOOKFREE_DB_URL` | `file:./data/bookfree.db` | 当前构建仅支持本地 SQLite。 |
| `BOOKFREE_STORAGE_DIR` | `./data/storage` | 书籍文件存放目录。 |
| `BOOKFREE_MAX_UPLOAD_SIZE_MB` | `100` | 上传大小限制。Docker 镜像设置为 `200`。 |
| `BOOKFREE_ALLOW_REGISTRATION` | 生产环境默认关闭 | 设置为 `1` 可启用自助注册。 |
| `BOOKFREE_TRUSTED_PROXIES` | 空 | 逗号分隔的 CIDR/IP 列表；这些代理的 `X-Forwarded-For` / `X-Real-IP` 会被信任。**为空时会忽略转发头**，在 Caddy / Nginx / Traefik 后运行时请设置。 |
| `BOOKFREE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`。 |

旧版 `QS_MASTER_SECRET`、`APP_SECRET`、`NEXTAUTH_SECRET`、`SESSION_SECRET`、`QS_CONFIG_SECRET` 仍会作为 `BOOKFREE_APP_SECRET` 的回退别名被接受。

## 子命令

```sh
./bookfree-server                     # 启动服务（默认）
./bookfree-server migrate             # 应用待执行迁移后退出
./bookfree-server backfill-fts        # 用现有数据填充 FTS5
./bookfree-server make-admin <email>  # 将用户提升为 role=admin
./bookfree-server version
./bookfree-server help
```

## 架构

```
bookfree/
├── apps/web/                Vite + React + Tailwind 单页应用。
│   ├── src/pages/           路由页面组件。
│   ├── src/reader/          TXT / EPUB / PDF 阅读器实现。
│   ├── src/parsers/         适合 Web Worker 的 TXT/EPUB → 导入解析。
│   └── public/              静态文件（robots.txt 等）— Vite 会复制到 dist/。
└── server/
    ├── cmd/bookfree/        入口点和子命令。
    └── internal/
        ├── auth/            会话、登录/注册/me、dummy-bcrypt 防时序攻击。
        ├── books/           列表 / 获取 / 删除（含文件清理）/ 上传（流式）。
        ├── chapters/        章节列表和正文获取。
        ├── config/          环境变量加载器，带旧配置回退链。
        ├── db/              使用 DSN 编码 PRAGMA 的 *sql.DB。
        ├── health/          GET /api/health（失败时返回 HTTP 503）。
        ├── http/            路由、中间件、限流、可信代理 IP。
        ├── ingest/          POST /api/books/{id}/ingest — 接收解析后的章节/分块。
        ├── notes/           高亮和笔记 API。
        ├── progress/        阅读进度 upsert。
        ├── search/          FTS5 查询处理器和 CJK bigram 分词器。
        ├── security/        AES-GCM、scrypt、bcrypt — 与 JS 兼容。
        └── storage/         存储接口和本地文件系统驱动。
```

## 内存

空闲 RSS 约 32 MB。50 MB 的流式上传仍约 32 MB（字节直接以 32 KiB 分块写入磁盘，不在内存中缓冲）。

## 当前构建未包含的内容

以下内容有意不在当前范围内，且每一项都需要较大开发量：

- AI 聊天 / RAG / 引文
- MOBI / AZW / AZW3 / FB2 / FBZ / CBZ 解析（上传接受这些格式；它们会被存储并可下载，但阅读器中尚未分页显示）
- 基于 Foliate 的 EPUB 渲染
- 管理员 UI（目前 CLI 是唯一管理入口）
- OAuth 配置
- 统计 — 页面存在，但数据是尽力而为

## 许可证

继承上游项目的许可证。
