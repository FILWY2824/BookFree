# BookFree

一个自托管阅读器。后端 Go,前端 Vite/React 单页应用;单二进制部署、低内存占用、内嵌 SQLite。支持在浏览器中导入 EPUB / PDF / TXT / CBZ,提供中日韩全文搜索、划线、高亮、下划线、波浪线、删除线、笔记、阅读进度、AI 对话以及 8 种阅读主题。

> **状态:** 生产审计中的 P0/P1 全部修复。AI 对话已接入 Anthropic API(需要 `ANTHROPIC_API_KEY`)。MOBI/AZW3 解析、管理面板 UI、OAuth 仍不在范围内,详见 [`docs/MIGRATION-PROGRESS.md`](./docs/MIGRATION-PROGRESS.md)。

---

## 一键部署(推荐:Docker)

整个流程只有两步:**写 `.env`** + **`docker compose up -d --build`**。

### 步骤 1:生成密钥并写入 `.env`

`.env` 与 `docker-compose.yml` 位于同一目录。Compose v2 会自动读取它,**不需要 `--env-file` 参数**。

**Linux / macOS** —— 一行命令搞定:

```sh
echo "BOOKFREE_APP_SECRET=$(openssl rand -hex 32)" > .env
```

**Windows PowerShell** —— 一段命令:

```powershell
$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
"BOOKFREE_APP_SECRET=" + (-join ($b | %{ '{0:x2}' -f $_ })) | Out-File -Encoding ascii .env
```

`.env` 至少要有 `BOOKFREE_APP_SECRET` 这一行。其它字段(注册开关、AI Key、时区等)可以参考 [`.env.example`](./.env.example) 也写到 `.env`,不写就用 `docker-compose.yml` 里的默认值。

> 想启用阅读器右侧的 AI 对话? 把 Anthropic 的 key 也加进 `.env`:
> ```
> ANTHROPIC_API_KEY=sk-ant-…
> ```

### 步骤 2:构建并启动

```sh
docker compose up -d --build
```

第一次构建约 2 分钟,之后改代码再 `up -d --build` 通常很快。完成后访问 <http://127.0.0.1:8788>。

如果忘了写 `.env`,Compose 会立即拒绝启动并打印中文提示告诉你去 `.env` 填,而不是神秘地起一个无密钥的容器。

### 创建第一个管理员

生产模式默认关闭自助注册。两种方式建管理员:

```sh
# 方式 A(推荐):临时打开注册 → 浏览器注册 → CLI 提权
docker compose exec -e BOOKFREE_ALLOW_REGISTRATION=1 bookfree \
  /app/bookfree-server make-admin you@example.com

# 方式 B(单用户):在 .env 里写 BOOKFREE_ALLOW_REGISTRATION=1,
# 然后 docker compose up -d --build 让设置生效
```

### 常用运维

```sh
docker compose logs -f       # 跟日志
docker compose ps            # 看健康状态(healthy)
docker compose restart       # 不重新构建,只重启
docker compose down          # 停服(保留 ./data)
docker compose up -d --build # 改了代码或 yaml 后重建
```

宿主机 `./data/` 包含 SQLite 数据库 + 上传的书籍文件。**这一个目录就是全部可备份内容**。`.env` 也建议一起备份,因为没了 `BOOKFREE_APP_SECRET` 数据库里加密的字段无法解密。

---

## 原生编译部署

### 前置要求

| 组件 | 版本 | 说明 |
|------|------|------|
| Go | 1.22+ | 后端二进制 |
| Node.js | 20+ | 编译期需要,运行期不需要 |
| C 编译器 | 任意 | `mattn/go-sqlite3` 用 CGO 编译内嵌 SQLite |
| Git | 任意 | 拉取依赖 |

### Linux / macOS

```sh
# ── 1. 用 Makefile(最省事) ─────────────────────────────────
make build
BOOKFREE_APP_SECRET=$(openssl rand -hex 32) ./bookfree-server

# ── 2. 不想用 make 的等价命令 ───────────────────────────────
# 2a. 编译 SPA
cd apps/web
npm install
npm run build
cd ../..

# 2b. 把前端产物注入 Go 嵌入目录
rm -rf server/webdist/assets server/webdist/index.html server/webdist/robots.txt
cp -r apps/web/dist/. server/webdist/

# 2c. 编译后端二进制(必须带 sqlite_fts5 标签)
cd server
CGO_ENABLED=1 \
  go build \
    -tags 'sqlite_fts5 sqlite_omit_load_extension' \
    -trimpath -ldflags='-s -w' \
    -o ../bookfree-server \
    ./cmd/bookfree
cd ..

# 2d. 启动
mkdir -p data/storage
BOOKFREE_APP_SECRET=$(openssl rand -hex 32) \
BOOKFREE_DB_URL='file:./data/bookfree.db' \
BOOKFREE_STORAGE_DIR=./data/storage \
./bookfree-server
```

启动好之后浏览器开 <http://127.0.0.1:3001>(原生默认 3001;Docker 则是 8788)。

### Windows(PowerShell)

> Windows 上 CGO 需要本地 C 编译器,装其中之一:
>
> - **MSYS2** —— `pacman -S mingw-w64-x86_64-gcc`,把 `C:\msys64\mingw64\bin` 加进 PATH
> - **Chocolatey** —— `choco install mingw`
> - **TDM-GCC** —— 官网下载 installer
>
> 装完在新 PowerShell 里 `gcc --version` 能打印版本就 OK。

```powershell
# ── 1. 编译前端 ────────────────────────────────────────────
cd apps\web
npm install
npm run build
cd ..\..

# ── 2. 注入到 Go 嵌入目录 ──────────────────────────────────
Remove-Item -Recurse -Force server\webdist\assets,server\webdist\index.html,server\webdist\robots.txt -ErrorAction SilentlyContinue
Copy-Item -Recurse apps\web\dist\* server\webdist\

# ── 3. 编译后端二进制 ──────────────────────────────────────
$env:CGO_ENABLED = "1"
cd server
go build `
  -tags "sqlite_fts5 sqlite_omit_load_extension" `
  -trimpath -ldflags "-s -w" `
  -o ..\bookfree-server.exe `
  .\cmd\bookfree
cd ..

# ── 4. 生成 32 字节 hex 密钥并启动 ─────────────────────────
New-Item -ItemType Directory -Force data\storage | Out-Null
$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$env:BOOKFREE_APP_SECRET = -join ($b | ForEach-Object { '{0:x2}' -f $_ })
$env:BOOKFREE_DB_URL = "file:./data/bookfree.db"
$env:BOOKFREE_STORAGE_DIR = "./data/storage"
.\bookfree-server.exe
```

> **想跑 Windows 后台/开机自启?** 用 `nssm install BookFree` 把 `bookfree-server.exe` 注册成 Windows 服务,然后用上面那段 PowerShell 把环境变量配置到服务参数里。或者干脆走 Docker Desktop 方案,省掉 CGO 编译环节。

### Windows(cmd.exe / Batch)

不用 PowerShell 也行:

```bat
:: 编译前端
cd apps\web
npm install
npm run build
cd ..\..

:: 注入到嵌入目录
rmdir /s /q server\webdist\assets 2>nul
del /q server\webdist\index.html server\webdist\robots.txt 2>nul
xcopy /e /i /y apps\web\dist server\webdist

:: 编译后端
set CGO_ENABLED=1
cd server
go build -tags "sqlite_fts5 sqlite_omit_load_extension" -trimpath -ldflags "-s -w" -o ..\bookfree-server.exe .\cmd\bookfree
cd ..

:: 生成 hex 密钥(借 PowerShell 一行)并启动
mkdir data\storage 2>nul
for /f "delims=" %%a in ('powershell -NoProfile -Command "$b=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b);-join ($b | %%{'{0:x2}' -f $_})"') do set BOOKFREE_APP_SECRET=%%a
set BOOKFREE_DB_URL=file:./data/bookfree.db
set BOOKFREE_STORAGE_DIR=./data/storage
bookfree-server.exe
```

---

## 环境变量

Docker 用户改 `.env` 即可。原生部署或想了解全部字段的看下表:

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BOOKFREE_APP_SECRET` | — | **必填**。32+ 位 hex。Docker 通过 `.env`,原生部署 export。 |
| `BOOKFREE_ENV` | `development` | `production` 启用更严格的 cookie / 注册关闭 / 密钥校验。 |
| `BOOKFREE_ADDR` | `127.0.0.1:3001` | Docker 镜像默认 `0.0.0.0:8788`。 |
| `BOOKFREE_DB_URL` | `file:./data/bookfree.db` | 仅支持本地 SQLite。 |
| `BOOKFREE_STORAGE_DIR` | `./data/storage` | 书籍文件目录。 |
| `BOOKFREE_MAX_UPLOAD_SIZE_MB` | `100` | 上传上限。Docker 镜像 `200`。 |
| `BOOKFREE_ALLOW_REGISTRATION` | 生产关 / 开发开 | `0` / `1`。 |
| `BOOKFREE_TRUSTED_PROXIES` | 空 | 反代白名单 CIDR/IP,逗号分隔。**为空时忽略 X-Forwarded-For / X-Real-IP**,Caddy / Nginx / Traefik 后必须设。 |
| `BOOKFREE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`。 |
| `ANTHROPIC_API_KEY` | 空 | 启用阅读器 AI 对话。空则前端显示"未配置"。 |
| `GOMEMLIMIT` | `80MiB`(原生)/ `240MiB`(Docker) | Go 软内存上限。 |
| `TZ` | 系统 / `Asia/Shanghai`(Docker) | 影响日志时间戳。 |

兼容老变量:`QS_MASTER_SECRET`、`APP_SECRET`、`NEXTAUTH_SECRET`、`SESSION_SECRET`、`QS_CONFIG_SECRET` 仍作为 `BOOKFREE_APP_SECRET` 的 fallback。

---

## 子命令

```sh
./bookfree-server                     # 启动服务(默认)
./bookfree-server migrate             # 应用待执行迁移后退出
./bookfree-server backfill-fts        # 用现有数据填充 FTS5
./bookfree-server make-admin <email>  # 提权为 admin
./bookfree-server version
./bookfree-server help
```

Docker 里通过 `docker compose exec bookfree /app/bookfree-server <子命令>` 执行同样内容。

---

## 阅读器特性

- **左右翻页 / 按章上下滑 / 全文上下滑**三种翻页模式,设置抽屉里现切现用。分页式支持鼠标滚轮 + 键盘 ←/→ + 屏幕左 1/3 / 右 2/3 点击区。
- **阅读设置永久化**:web / 手机 PWA / 桌面壳分别存储,不互相干扰(`bookfree.reader.prefs.v3.{web|app|window}`)。
- **栏宽 / 字号 / 行距**用 `[−] [ 数值 ] [+]` 步进控件,长按连续步进,中间格直接键入精确数值。
- **8 种字体**(霞鹜文楷 / 思源宋体 / 宋体 / 楷体 / 思源黑体 / 苹方 / 仿宋 / 等宽),4×2 网格,tile 用对应字体本身渲染做预览。
- **8 种阅读主题**,与字体颜色变量解耦,新主题只动 CSS 变量。
- **标注**:高亮、下划线、波浪线、删除线 × 6 种颜色,以及与之关联的笔记。选区工具条自动避开屏幕边界。
- **AI 对话**(配置了 `ANTHROPIC_API_KEY` 时):右侧抽屉,选区可附带为上下文,本会话内保留对话历史。
- **进度恢复**:每个 reader 都门控在 progress 加载完成后才挂载,旧 bug(打开书一直跳到第一页)已根治。

---

## 架构

```
bookfree/
├── apps/web/                 Vite + React + Tailwind 单页应用
│   ├── src/pages/            路由页
│   ├── src/reader/           TXT / EPUB / PDF / CBZ 四个阅读器
│   ├── src/components/       NumericStepper、SelectionToolbar、PageNav 等
│   ├── src/lib/              prefs / themes / annotations / highlights / ai 客户端
│   └── public/               robots.txt 等静态资源
├── server/
│   ├── cmd/bookfree/         入口与子命令
│   └── internal/
│       ├── ai/               /api/ai/{status,chat} 反向代理 Anthropic
│       ├── auth/             会话、登录/注册/me、防时序攻击
│       ├── books/            列表 / 获取 / 删除(含文件清理) / 流式上传
│       ├── chapters/         章节列表与正文
│       ├── config/           env 加载(带老变量 fallback 链)
│       ├── db/               *sql.DB + DSN PRAGMA
│       ├── health/           GET /api/health(失败 503)
│       ├── http/             路由、中间件、限流、可信代理 IP
│       ├── ingest/           POST /api/books/{id}/ingest
│       ├── notes/            高亮/下划线/波浪线/删除线 + 笔记
│       ├── progress/         阅读进度 upsert
│       ├── search/           FTS5 + CJK bigram 分词
│       ├── security/         AES-GCM、scrypt、bcrypt
│       └── storage/          存储抽象与本地 FS 实现
├── Dockerfile                三阶段:SPA → Go → alpine 运行时
└── docker-compose.yml        通过 .env 注入 APP_SECRET
```

---

## 内存

空闲 RSS ~32 MB。50 MB 流式上传仍约 32 MB(字节直接以 32 KiB chunk 写盘,不在内存缓冲)。AI 对话长会话峰值 ~80–120 MB。

---

## 不在当前范围

每一项都是较大开发量,故意推后:

- MOBI / AZW / AZW3 / FB2 / FBZ 解析(上传接受、能下载,但 reader 还没分页显示)
- 基于 Foliate 的 EPUB 渲染(epub.js 已经能用)
- 管理员 UI(目前 CLI 是唯一管理入口)
- OAuth 配置
- 远端 SQLite(libsql/Turso)— 当前构建仅支持本地 file:// SQLite

---

## 许可证

继承上游项目的许可证。
