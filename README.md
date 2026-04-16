# codex-gate

轻量级 OpenAI/Codex 网关代理，提供多上游路由、用户密钥管理、统计与基础可观测能力。

## 部署方式

### 1) Docker Compose 快速部署（使用已发布镜像）

这条路径适合直接在服务器上部署，不需要本地构建源码。

#### 第一步：下载 `docker-compose.yml`

```bash
mkdir -p codex-gate && cd codex-gate
curl -fsSLO https://raw.githubusercontent.com/un4gt/codex-gate/main/docker-compose.yml
curl -fsSLo .env https://raw.githubusercontent.com/un4gt/codex-gate/main/.env.example
```

如果服务器没有 `curl`，也可以改用 `wget`。

#### 第二步：修改 `docker-compose.yml`

下载下来的 `docker-compose.yml` 默认是“从源码构建”，需要把它改成“直接拉取镜像”。

把下面这段：

```yaml
build:
  context: .
  dockerfile: Dockerfile
image: codex-gate:local
```

改成：

```yaml
image: ghcr.io/un4gt/codex-gate:v1.0.0
```

说明：

- `v1.0.0` 请替换成你实际要部署的版本 tag
- 如果你使用 Docker Hub，也可以把镜像地址替换成对应的 Docker Hub 地址

#### 第三步：修改 `.env`

至少设置这些字段：

```bash
ADMIN_TOKEN=replace-with-strong-admin-token
MASTER_KEY=replace-with-strong-master-key
CODEX_GATE_PORT=8080
RUST_LOG=info
```

其中：

- `ADMIN_TOKEN`：后台管理鉴权口令，必填
- `MASTER_KEY`：用于密钥加密，强烈建议单独设置
- `CODEX_GATE_PORT`：宿主机映射端口，默认 `8080`

#### 第四步：拉取镜像并启动

```bash
docker compose pull
docker compose up -d
```

#### 第五步：检查是否启动成功

```bash
docker compose ps
docker compose logs -f codex-gate
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

数据默认存储在 Docker 卷 `codex-gate-data`。如果开启归档，路径为容器内 `/app/data/archive/request_logs`。

### 2) Docker Compose 从源码构建（开发/自托管）

如果你就是在当前仓库目录里部署，并且希望按本地代码直接构建，可以使用仓库默认的 `docker-compose.yml`。

```bash
cp .env.example .env
docker compose up -d --build
```

这种方式会使用仓库内的 `Dockerfile` 本地构建镜像，更适合开发调试或自定义修改后的部署。

---

### 3) 裸二进制部署（Linux）

#### 构建

后端：

```bash
cargo build --release --manifest-path backend/Cargo.toml
```

前端静态资源（可选，启用管理界面时需要）：

```bash
npm --prefix frontend ci
npm --prefix frontend run build
```

#### 运行

最小环境变量：

- `ADMIN_TOKEN`（必填）
- `MASTER_KEY`（建议）

常用可配置项：

- `LISTEN_ADDR`（默认 `0.0.0.0:8080`）
- `DB_DSN`（默认 `sqlite://./data/codex_gate.sqlite`）
- `STATIC_DIR`（默认 `./static`）
- `RUST_LOG`（默认 `info`）

示例：

```bash
export ADMIN_TOKEN='replace-with-strong-token'
export MASTER_KEY='replace-with-strong-master-key'
export LISTEN_ADDR='0.0.0.0:8080'
export DB_DSN='sqlite://./data/codex_gate.sqlite'
export STATIC_DIR='./frontend/dist'

./backend/target/release/backend
```

验证：

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

> 生产环境建议使用 `systemd`/容器编排托管进程，并配合日志轮转与数据备份策略。

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
| `CODEX_GATE_PORT` | `8080` | Docker 对外映射端口。 |
| `LISTEN_ADDR` | `0.0.0.0:8080` | 网关监听地址。 |
| `STATIC_DIR` | `/app/static`（容器） | 前端静态文件目录。 |
| `DB_DSN` | `sqlite:///app/data/codex_gate.sqlite` | 数据库连接串（SQLite/Postgres）。 |
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
| `MAX_RESPONSE_BYTES` | `20971520` | 单次响应体最大字节数（20MB）。 |
| `LOG_QUEUE_CAPACITY` | `2048` | 异步日志/遥测队列容量。 |
| `STATS_FLUSH_INTERVAL_MS` | `2000` | 统计聚合刷新周期。 |

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
