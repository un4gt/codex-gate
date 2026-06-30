# little-gate

轻量级 OpenAI 兼容网关代理，提供多上游路由、用户密钥管理、统计与基础可观测能力。

## 部署方式

### 1) Docker Compose 快速部署（使用已发布镜像）

这条路径适合直接在服务器上部署，不需要本地构建源码。

#### 第一步：下载 `docker-compose.yml`

```bash
mkdir -p little-gate && cd little-gate
curl -fsSLO https://raw.githubusercontent.com/un4gt/little-gate/main/docker-compose.yml
curl -fsSLo .env https://raw.githubusercontent.com/un4gt/little-gate/main/.env.example
```

如果服务器没有 `curl`，也可以改用 `wget`。

#### 第二步：修改 `docker-compose.yml`

下载下来的 `docker-compose.yml` 默认是“从源码构建”，需要把它改成“直接拉取镜像”。

把下面这段：

```yaml
build:
  context: .
  dockerfile: Dockerfile
image: little-gate:local
```

改成：

```yaml
image: ghcr.io/un4gt/little-gate:v1.0.0
```

说明：

- `v1.0.0` 请替换成你实际要部署的版本 tag
- 如果你使用 Docker Hub，也可以把镜像地址替换成对应的 Docker Hub 地址

#### 第三步：修改 `.env`

至少设置这些字段：

```bash
ADMIN_TOKEN=replace-with-strong-admin-token
MASTER_KEY=replace-with-strong-master-key
LITTLE_GATE_PORT=8080
RUST_LOG=info
```

其中：

- `ADMIN_TOKEN`：后台管理鉴权口令，必填
- `MASTER_KEY`：用于密钥加密，强烈建议单独设置
- `LITTLE_GATE_PORT`：宿主机映射端口，默认 `8080`

#### 第四步：拉取镜像并启动

```bash
docker compose pull
docker compose up -d
```

#### 第五步：检查是否启动成功

```bash
docker compose ps
docker compose logs -f little-gate
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

#### 常用运维命令

更新镜像版本：

1. 修改 `docker-compose.yml` 中的镜像 tag
2. 执行：

```bash
docker compose pull
docker compose up -d
```

停止服务：

```bash
docker compose down
```

停止服务并删除数据卷：

```bash
docker compose down -v
```

数据默认存储在 Docker 卷 `little-gate-data`。如果开启归档，路径为容器内 `/app/data/archive/request_logs`。

### 2) Docker Compose 从源码构建（开发/自托管）

如果你就是在当前仓库目录里部署，并且希望按本地代码直接构建，可以使用仓库默认的 `docker-compose.yml`。

```bash
cp .env.example .env
docker compose up -d --build
```

这种方式会使用仓库内的 `Dockerfile` 本地构建镜像，更适合开发调试或自定义修改后的部署。

---

### 3) 二进制发布包部署（Linux / Windows）

这条路径适合不能使用 Docker 的服务器。每个 tag 发布后，GitHub Actions 会生成：

- `little-gate-vX.Y.Z-linux-x86_64.tar.gz`
- `little-gate-vX.Y.Z-windows-x86_64.zip`

发布包内包含后端二进制、管理后台静态资源、二进制部署专用 `.env.example` 和启动脚本。应用本身不会自动读取 `.env` 文件；包内启动脚本会读取同目录 `.env` 并注入当前进程。

#### Linux

```bash
tar -xzf little-gate-vX.Y.Z-linux-x86_64.tar.gz
cd little-gate-vX.Y.Z-linux-x86_64
cp .env.example .env
```

编辑 `.env`，至少设置：

```bash
ADMIN_TOKEN=replace-with-strong-admin-token
MASTER_KEY=replace-with-strong-master-key
LISTEN_ADDR=0.0.0.0:8080
STATIC_DIR=./static
DB_DSN=sqlite://./data/little_gate.sqlite
```

启动：

```bash
chmod +x ./little-gate ./run-little-gate.sh
./run-little-gate.sh
```

#### Windows

```powershell
Expand-Archive .\little-gate-vX.Y.Z-windows-x86_64.zip -DestinationPath .
Set-Location .\little-gate-vX.Y.Z-windows-x86_64
Copy-Item .env.example .env
```

编辑 `.env`，至少设置：

```powershell
ADMIN_TOKEN=replace-with-strong-admin-token
MASTER_KEY=replace-with-strong-master-key
LISTEN_ADDR=0.0.0.0:8080
STATIC_DIR=./static
DB_DSN=sqlite://./data/little_gate.sqlite
```

启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\run-little-gate.ps1
```

#### 验证

Linux：

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

Windows：

```powershell
Invoke-WebRequest http://127.0.0.1:8080/healthz
Invoke-WebRequest http://127.0.0.1:8080/readyz
```

Linux 生产环境可参考发布包中的 `little-gate.service` 配置 systemd；Windows 如需服务化运行，建议用 NSSM 或 WinSW 包装 `little-gate.exe`。更完整说明见 [docs/binary-deployment.md](docs/binary-deployment.md)。

### 4) 从源码构建二进制（开发/自托管）

Linux/macOS：

```bash
npm --prefix frontend ci
npm --prefix frontend run build
cargo build --release --locked --manifest-path backend/Cargo.toml
mkdir -p dist/little-gate-local/static
cp backend/target/release/backend dist/little-gate-local/little-gate
cp -R frontend/dist/* dist/little-gate-local/static/
cp deploy/binary.env.example dist/little-gate-local/.env.example
cp deploy/linux/run-little-gate.sh dist/little-gate-local/
```

Windows：

```powershell
npm --prefix frontend ci
npm --prefix frontend run build
cargo build --release --locked --manifest-path backend/Cargo.toml
New-Item -ItemType Directory -Force -Path dist\little-gate-local\static | Out-Null
Copy-Item backend\target\release\backend.exe dist\little-gate-local\little-gate.exe
Copy-Item frontend\dist\* dist\little-gate-local\static -Recurse
Copy-Item deploy\binary.env.example dist\little-gate-local\.env.example
Copy-Item deploy\windows\run-little-gate.ps1 dist\little-gate-local\
```

复制 `.env.example` 为 `.env`，设置 `ADMIN_TOKEN` 和 `MASTER_KEY` 后，按上面的 Linux/Windows 启动方式运行。

## 环境变量说明

### `MASTER_KEY` vs `ADMIN_TOKEN`

- 项目里没有 `ADMIN_KEY` 这个变量；管理端鉴权使用的是 `ADMIN_TOKEN`。
- `ADMIN_TOKEN`：仅用于后台管理 API 鉴权（`/api/v1/*` 的 Bearer Token）。
- `MASTER_KEY`：用于加密/解密上游密钥、以及哈希用户 API Key 的主密钥（数据平面安全根）。

> 建议生产环境必须显式设置 `MASTER_KEY`，且不要与 `ADMIN_TOKEN` 相同。  
> 若直接修改已运行实例的 `MASTER_KEY`，历史密钥解密与 API Key 校验会受影响，需配套做密钥迁移。

### 核心与安全字段

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 无（必填） | 管理后台 API 鉴权令牌。 |
| `MASTER_KEY` | 空时回退 `ADMIN_TOKEN` | 加密上游密钥、哈希用户 API Key。 |
| `LITTLE_GATE_PORT` | `8080` | Docker 对外映射端口。 |
| `LISTEN_ADDR` | `0.0.0.0:8080` | 网关监听地址。 |
| `STATIC_DIR` | `/app/static`（容器） | 前端静态文件目录。 |
| `DB_DSN` | `sqlite:///app/data/little_gate.sqlite` | 数据库连接串（SQLite/Postgres）。 |
| `DB_MAX_CONNECTIONS` | `10` | 数据库连接池上限。 |
| `RUST_LOG` | `info` | Rust 日志级别。 |

### 缓存与吞吐字段

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `INJECT_INCLUDE_USAGE` | `true` | 对流式请求补齐 `stream_options.include_usage=true`。 |
| `API_KEY_CACHE_TTL_MS` | `30000` | API Key 校验缓存 TTL。 |
| `API_KEY_CACHE_MAX_ENTRIES` | `100000` | API Key 缓存条目上限。 |
| `UPSTREAM_CACHE_TTL_MS` | `2000` | 上游快照缓存 TTL。 |
| `UPSTREAM_CACHE_STALE_GRACE_MS` | `30000` | 上游缓存过期后的容错窗口。 |
| `MAX_REQUEST_BYTES` | `10485760` | 单次请求体最大字节数（10MB）。 |
| `USAGE_CAPTURE_BYTES` | `2097152` | 非流式响应用量采样窗口总字节数（2MB）。 |
| `USAGE_CAPTURE_TAIL_BYTES` | `1048576` | 用量采样窗口中保留尾部的字节数（1MB）。 |
| `LOG_QUEUE_CAPACITY` | `2048` | 异步日志/遥测队列容量。 |
| `STATS_FLUSH_INTERVAL_MS` | `2000` | 统计聚合刷新周期。 |

旧版 `MAX_RESPONSE_BYTES` 仍可作为 `USAGE_CAPTURE_BYTES` 的回退值，但新部署建议使用上面的用量采样字段。

### 选路、熔断与超时字段

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ENDPOINT_SELECTOR_STRATEGY` | `weighted` | endpoint 选择策略（`weighted`/`latency`）。 |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `3` | 熔断触发失败阈值。 |
| `CIRCUIT_BREAKER_OPEN_MS` | `30000` | 熔断打开时长。 |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `2000` | 上游连接超时。 |
| `UPSTREAM_REQUEST_TIMEOUT_MS` | `120000` | 上游请求总超时。 |

### 留存与归档字段

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `REQUEST_LOG_RETENTION_DAYS` | `30` | 请求日志保留天数。 |
| `STATS_DAILY_RETENTION_DAYS` | `400` | 日统计保留天数。 |
| `RETENTION_CLEANUP_INTERVAL_MS` | `21600000` | 留存清理任务执行周期。 |
| `RETENTION_DELETE_BATCH` | `2000` | 每轮清理删除批量大小。 |
| `REQUEST_LOG_ARCHIVE_ENABLED` | `false` | 是否启用请求日志归档。 |
| `REQUEST_LOG_ARCHIVE_DIR` | `/app/data/archive/request_logs` | 归档输出目录。 |
| `REQUEST_LOG_ARCHIVE_COMPRESS` | `true` | 是否压缩归档文件。 |

## `openai_compatible_responses` 本地链路验证

已提供一键脚本验证 responses 专用链路：

```bash
cargo build --manifest-path backend/Cargo.toml
MOCK_PORT=19130 GW_PORT=18130 scripts/test_openai_compatible_responses.sh
```

该脚本会自动验证以下行为：

- `/v1/responses` 正常返回（200）
- `/v1/chat/completions` 不选 responses-only provider（503, `no available providers`）
- `/v1/models` 不暴露 responses-only 模型
- `/v1/models?api_format=responses` 暴露 responses 模型
- provider/key 的 models 同步链路可用

测试产物写入 `data/tmp/`，脚本末尾会输出结果 JSON 路径。

## 本地验证与回归

- `python3 scripts/mock_upstream.py`：本地模拟上游（支持 chat/responses 以及 `/v1/models`）
- `python3 scripts/bench_gateway.py ...`：基础并发 / 长压 / RSS 采样
- `python3 scripts/bench_failover.py ...`：endpoint / key failover 基线
- `python3 scripts/run_regression.py --archive-compress`：一键跑 build / 长压 / failover / archive 回归
