# BookFree — Docker 部署

本指南说明如何在生产环境中用 Docker 运行 BookFree，包括一键初始化、TLS、反向代理、备份、升级以及需要注意的常见问题。

如果只想 30 秒快速启动，直接运行 `./docker-quickstart.sh`，然后跳到[运维](#运维)章节即可。

---

## 你会得到什么

- **单容器部署。** 不需要外部 SQLite、Redis 或 S3；所有内容都打包在一个镜像中。
- **空闲 RSS 约 32 MB，默认硬上限约 50 MB。** compose 文件固定了内存限制，避免失控的 worker 把宿主机打到 OOM。
- **持久化卷。** 主机上的 `./data/` 保存 SQLite 数据库和所有上传书籍。这里使用绑定挂载而不是命名卷，更方便备份。
- **健康检查。** `/api/health` 响应正常后，`docker ps` 会显示 `(healthy)`，并包含内存统计快照。
- **非 root 容器用户。** 进程以镜像中创建的 UID `bookfree` 运行，而不是 root。
- **多阶段构建，压缩后镜像约 50-60 MB。**

---

## 一键部署

```sh
git clone <this-repo> bookfree
cd bookfree
./docker-quickstart.sh
```

该脚本会做五件事：

1. 检查 `docker` 和 `docker compose` 是否已安装。
2. 创建 `./data/` 和 `./data/storage/`。
3. 生成强随机的 `BOOKFREE_APP_SECRET` 并写入 `.env`（chmod 600）。
4. 构建镜像（首次约 2 分钟，后续重建通常很快）。
5. 启动容器并等待 `/api/health` 变为健康状态。

该脚本是幂等的，可以重复运行。已有 `.env` 会被保留。

---

## 手动部署

如果你想直接使用 `docker compose`：

```sh
# 只生成一次密钥
echo "BOOKFREE_APP_SECRET=$(openssl rand -hex 32)" > .env
chmod 600 .env

# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f
```

当文件名正好是 `.env` 且与 `docker-compose.yml` 位于同一目录时，`--env-file .env` 参数会被隐式使用。

---

## 第一个管理员

生产环境默认**关闭注册**。创建第一个用户有两种方式：

**方式 A — 先注册，再提升权限。** 临时允许注册：

```sh
echo "BOOKFREE_ALLOW_REGISTRATION=1" >> .env
docker compose up -d
# 打开 http://127.0.0.1:8788，注册你的账号。
docker compose exec bookfree /app/bookfree-server make-admin you@example.com

# 再次关闭注册
sed -i '/BOOKFREE_ALLOW_REGISTRATION/d' .env
docker compose up -d
```

**方式 B — 在生产环境保留临时注册开关。** 如果你想运行一个可自助注册的网站，可以保留 `BOOKFREE_ALLOW_REGISTRATION=1`。

---

## 反向代理（Caddy / Nginx / Traefik）

compose 文件有意将容器绑定到 `127.0.0.1:8788`，不要直接对外暴露。请在前面放置真正的反向代理，用于 TLS、HTTP/2 和限流。

### Caddy（最简单）

`Caddyfile`：

```caddy
reader.example.com {
    reverse_proxy 127.0.0.1:8788
    encode gzip zstd
    # 书籍可能比较大，请给上传留足时间
    request_body {
        max_size 200MB
    }
}
```

可用 `caddy run` 运行，也可以使用 Docker 镜像。TLS 会自动配置。

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name reader.example.com;

    ssl_certificate     /etc/letsencrypt/live/reader.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/reader.example.com/privkey.pem;

    # 200 MB 上传上限 — 与 BOOKFREE_MAX_UPLOAD_SIZE_MB 保持一致。
    client_max_body_size 200M;
    # AI 流式响应和大文件上传需要较长超时时间。
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 聊天流需要这样设置 — 对 /api/chat 禁用缓冲。
        # 如果 nginx 只服务这个虚拟主机，可以保持全局设置；
        # 如果还挂载了其他应用，请限制到聊天路径。
        proxy_buffering off;
    }
}
```

### Traefik

如果你已经使用 Traefik 的 file/docker provider，可以给 compose 服务添加 labels：

```yaml
services:
  bookfree:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.bookfree.rule=Host(`reader.example.com`)"
      - "traefik.http.routers.bookfree.tls.certresolver=letsencrypt"
      - "traefik.http.services.bookfree.loadbalancer.server.port=8788"
```

同时移除 `ports:` 块，让 Traefik 负责路由，而不是通过宿主机端口映射访问。

---

## 备份

所有状态都在 `./data/` 中。推荐两种策略：

**通过 litestream 热快照**（SQLite 推荐方案）：

```yaml
# docker-compose.override.yml
services:
  litestream:
    image: litestream/litestream:0.3
    container_name: bookfree-litestream
    restart: unless-stopped
    volumes:
      - ./data:/data
      - ./litestream.yml:/etc/litestream.yml:ro
    command: replicate
    depends_on:
      - bookfree
```

`litestream.yml`：

```yaml
dbs:
  - path: /data/bookfree.db
    replicas:
      - type: s3
        bucket: my-bookfree-backup
        path: bookfree
        region: us-east-1
        access-key-id: ...
        secret-access-key: ...
```

**冷 tar 包**（更简单，适合个人部署）：

```sh
docker compose stop
tar czf "bookfree-backup-$(date +%F).tar.gz" data/ .env
docker compose start
```

Storage 层以目录形式绑定挂载，因此直接打包即可同时得到数据库和所有上传书籍。不要忘记 `.env`；没有 `BOOKFREE_APP_SECRET`，数据库中所有加密的 AI provider 密钥都无法恢复。

---

## 升级

```sh
git pull
docker compose up -d --build
```

这会重建镜像（未变更的缓存层会被复用）并重启。迁移会在启动时自动运行。Schema 变更保持向后兼容（新增列可为空、以追加为主）；正常升级不需要停机。

如果某个迁移需要操作员手动处理，会在发布说明中明确写出。可用下面命令预览：

```sh
docker compose exec bookfree /app/bookfree-server migrate
```

（对已经完成迁移的数据库运行 `migrate` 不会产生额外操作。）

---

## 运维

### 常用命令

```sh
docker compose logs -f                              # 跟踪日志
docker compose ps                                   # 查看健康状态
docker compose exec bookfree /app/bookfree-server help
docker compose exec bookfree /app/bookfree-server make-admin you@x.com
docker compose exec bookfree /app/bookfree-server backfill-fts
docker compose exec bookfree /app/bookfree-server version

# 直接检查 SQLite 数据库（调试时有用）
docker compose exec bookfree sh -c 'apk add --no-cache sqlite && sqlite3 /app/data/bookfree.db .tables'
```

### 内存监控

```sh
# 容器层面
docker stats bookfree

# 应用层面（由二进制程序自身返回）
curl -s http://127.0.0.1:8788/api/health | jq .data.mem
```

`mem` 块包含来自 `runtime.MemStats` 的实时数字：`heapMb`、`heapSysMb`、`sysMb`、`stackMb`、`numGc`、`goroutines`。

### 调优

以下配置都是 `.env` 中的环境变量；修改后执行 `docker compose up -d`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BOOKFREE_LOG_LEVEL` | `info` | `debug` 输出更详细，`warn` 更安静 |
| `BOOKFREE_MAX_UPLOAD_SIZE_MB` | `200` | 单次上传上限。流式处理，不增加内存成本。 |
| `BOOKFREE_ALLOW_REGISTRATION` | 生产环境关闭 | 设置 `1` 允许自助注册 |
| `GOMEMLIMIT` | `48MiB` | 软堆目标。越低 GC 越频繁。 |
| `GOGC` | `30` | 堆增长百分比；越低 GC 越频繁。 |
| `TZ` | UTC | 例如 `Asia/Shanghai`，用于本地日志时间 |

compose 层面的 `deploy.resources.limits.memory: 256M` 是硬上限；RSS 超过该值会触发 OOM kill。默认值刻意留得较宽；当前所有工作负载下观测值约 32-50 MB。如果需要更严格的上限，可收紧到 `128M`。

---

## 故障排查

**8788 端口已被占用。**
编辑 `docker-compose.yml`，将 `127.0.0.1:8788:8788` 改成你想使用的宿主机端口（例如 `127.0.0.1:9090:8788`），然后执行 `docker compose up -d`。

**容器不断重启。**
检查 `docker compose logs --tail=50 bookfree`。最常见原因：

- 未设置 `BOOKFREE_APP_SECRET` — 重新运行 `docker-quickstart.sh`
- `data/` 权限不正确 — `sudo chown -R 1000:1000 data/`（或实际 bookfree 用户 UID，可用 `docker compose exec bookfree id` 查看）
- 上一次异常关闭导致 DB 锁定 — 见下面的“WAL 卡住”说明

**出现 "database is locked" 错误。**
SQLite WAL 恢复是自动的，但如果容器在写入中途被杀死（例如宿主机 OOM），首次启动时可能出现该错误。重启一次，SQLite 会合并 WAL：`docker compose restart`。如果仍然存在，数据库文件可能已损坏，请从备份恢复。

**镜像构建非常慢 / 磁盘空间不足。**
清理 Docker 构建缓存：`docker builder prune -a`。每个 Node 小版本的首次构建会拉取约 150 MB；后续构建会共享该层。

**健康检查显示 `(unhealthy)`，但应用可以访问。**
健康检查会在容器内部调用 `/api/health`。如果数据库 ping 失败但 HTTP 层仍可用，就会出现这种情况。从宿主机运行 `curl -s http://127.0.0.1:8788/api/health | jq` 可以看到实际的 `db: "ok"|"fail"` 字段，健康检查看的就是它。

---

## 使用 Docker 开发

日常开发中，原生构建更快（没有 Docker context 上传，也不会和层缓存纠缠）。但如果你想用 Docker 开发循环：

```sh
# 通过主机磁盘覆盖实现实时 SPA：
docker run --rm -it \
  -p 8788:8788 \
  -v ./data:/app/data \
  -v ./apps/web/dist:/app/webdist:ro \
  -e BOOKFREE_APP_SECRET=$(openssl rand -hex 32) \
  -e BOOKFREE_WEBDIST_DIR=/app/webdist \
  -e BOOKFREE_ENV=development \
  bookfree:latest
```

这会把 `apps/web/dist/` 绑定挂载进容器，因此只需在主机侧运行 `npm run build`，即可刷新 SPA，而不用重建镜像。

Go 侧可以在主机构建二进制文件，然后绑定挂载进去：

```sh
make build-server
docker run --rm -it \
  -p 8788:8788 \
  -v ./data:/app/data \
  -v ./bookfree-server:/app/bookfree-server:ro \
  -e BOOKFREE_APP_SECRET=$(openssl rand -hex 32) \
  bookfree:latest
```

不过说实话，如果已经做到这一步，直接在主机上运行二进制文件通常更简单。

---

## 可复现构建

Dockerfile 使用 `-trimpath` 和 `-ldflags '-s -w'` 去除本地路径和调试符号。同一源码 + 同一 Go 版本 = 相同字节。模块解析由 `go.sum` 锁定。SPA 包文件名带内容哈希，因此相同源码重建也会生成相同资源文件名。

如果希望跨时间点得到字节级一致的生产构建，请固定基础镜像 digest：

```dockerfile
FROM node:20-alpine@sha256:...
FROM golang:1.22-alpine@sha256:...
FROM alpine:3.20@sha256:...
```

（可用 `docker buildx imagetools inspect` 查看当前 digest。）
