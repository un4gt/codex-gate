# little-gate

轻量级 OpenAI 兼容网关代理，提供多上游路由、用户密钥管理、统计与基础可观测能力。

管理台的“通知”模块支持按 Cron 定时发送服务器状态与上游 Provider/客户端访问 Key 用量报表，也支持 CPU、内存、上游健康、请求、错误率、Token 和估算成本阈值告警。投递通道包括 SMTP 邮件、带 HMAC-SHA256 签名的通用 Webhook，以及飞书、企业微信、钉钉、Slack、Discord 机器人消息格式，配置与安全说明见 [docs/notifications.md](docs/notifications.md)。

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

如果在 Docker 前使用 Nginx、Cloudflare 或其他反向代理，Responses WebSocket 还要求代理透传 `Upgrade` 和 `Connection`，并使用足够长的空闲超时。完整配置和 `101 Switching Protocols` 验证命令见 [Nginx 与 Cloudflare 反向代理](docs/reverse-proxy.md)。

### 2) Docker Compose 从源码构建（开发/自托管）

如果你就是在当前仓库目录里部署，并且希望按本地代码直接构建，可以使用仓库默认的 `docker-compose.yml`。

```bash
cp .env.example .env
npm --prefix frontend ci
bash scripts/docker-compose-up.sh -d --build
```

这条脚本会显式运行 `manual` stage，先执行前端 smoke tests、前端生产构建和 Rust tests，再调用 Docker Compose。`manual` stage 不会被 Git 自动触发，不能用普通的 `git commit` 或 `git push` 代替。

仓库内的 `Dockerfile` 还会在 Node 24 builder 中重新执行 `npm ci`、前端测试和生产构建；任一步失败都会终止镜像构建。因此即使直接执行 `docker compose up -d --build`，有问题的前端产物也不会进入运行时镜像。

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

前端要求 Node.js `>=22.22.0`，CI 和 Docker 统一使用 Node 24。`frontend/.npmrc` 已启用 `engine-strict`，Node 版本不满足时 `npm ci` 会直接失败，而不是只打印告警。构建机还需要 Rust stable，以及 `prek 0.3.9` 或可执行 `uvx` 的 uv 安装。

Linux/macOS：

```bash
npm --prefix frontend ci
bash scripts/run-prek-checks.sh pre-push
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
uvx --from "prek==0.3.9" prek run --stage pre-push --all-files --show-diff-on-failure --fail-fast
cargo build --release --locked --manifest-path backend/Cargo.toml
New-Item -ItemType Directory -Force -Path dist\little-gate-local\static | Out-Null
Copy-Item backend\target\release\backend.exe dist\little-gate-local\little-gate.exe
Copy-Item frontend\dist\* dist\little-gate-local\static -Recurse
Copy-Item deploy\binary.env.example dist\little-gate-local\.env.example
Copy-Item deploy\windows\run-little-gate.ps1 dist\little-gate-local\
```

复制 `.env.example` 为 `.env`，设置 `ADMIN_TOKEN` 和 `MASTER_KEY` 后，按上面的 Linux/Windows 启动方式运行。

### 发布门禁

安装本地 Git hooks（需要 PATH 中已有 `prek`）：

```bash
bash scripts/install-prek-hooks.sh
```

安装脚本调用官方 `prek install --overwrite --prepare-hooks`，并尊重 Git 的有效 `core.hooksPath`。`default_install_hook_types` 只负责默认安装 `pre-commit` 和 `pre-push` shim；每个检查是否运行仍由 `prek.toml` 中的 `stages` 决定。

发布、创建 tag 或人工构建发布包时必须显式运行完整门禁：

```bash
bash scripts/run-prek-checks.sh pre-push
```

不要用未指定 stage 的 `prek run --all-files` 代替；它默认只运行 `pre-commit` stage，可能遗漏 Rust tests。`manual` stage 也永远不会自动运行，只能通过 `bash scripts/docker-compose-up.sh ...` 或显式指定 `--stage manual` 调用。

本地 hooks 可以被跳过，因此不是发布安全边界。`scripts/git-push-with-next-tag.sh` 只允许从 `main` 创建 tag，并会先要求 clean worktree、执行同一个 pre-push 门禁。统一的 `.github/workflows/release.yml` 还会在首个 job 中拒绝非 `main` 的手动运行，以及提交尚未进入 `main` 的 tag；校验通过后才会执行 `.github/workflows/quality-gate.yml`、构建二进制或发布 Docker 镜像。

### 上游 API Base URL

管理台中的服务地址表示完整的 API Base URL。网关会在这个前缀后追加 `/models`、`/chat/completions` 或 `/responses`：

| 配置值 | 模型列表地址 | Chat Completions 地址 |
| --- | --- | --- |
| `https://api.openai.com` | `https://api.openai.com/v1/models` | `https://api.openai.com/v1/chat/completions` |
| `https://api.openai.com/v1` | `https://api.openai.com/v1/models` | `https://api.openai.com/v1/chat/completions` |
| `https://gateway.example.com/openai/v2` | `https://gateway.example.com/openai/v2/models` | `https://gateway.example.com/openai/v2/chat/completions` |
| `https://ark.cn-beijing.volces.com/api/coding/v3` | `https://ark.cn-beijing.volces.com/api/coding/v3/models` | `https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions` |

只有裸域名会为了兼容自动补 `/v1`；只要配置值已有路径，网关就会完整保留该路径。Base URL 不接受查询参数，模型同步固定请求 API Base URL 下的纯 `/models`。

### Provider 请求覆写

新建 Provider 的可选高级区和 Provider 详情页都提供“请求覆写”编辑器，可按 `all`、`chat_completions`、`responses` 作用域对发往该上游的 Header 和 JSON Body 执行 `set` / `remove`。Body 路径使用点路径，例如 `client_metadata.x-codex-window-id`；不存在的中间对象会自动创建。匹配具体协议的规则会在 `all` 规则之后执行，因此可用于覆盖通用值。

覆写发生在模型改写、Responses→Chat 转换、Codex 请求规范化和 `include_usage` 注入之后，并在网关完成上游鉴权 Header 构造后执行，因此最终发送内容与管理台预览一致。HTTP Responses、Responses WebSocket 原生转发和 HTTP bridge 都会应用规则；`all` Header 规则也会用于普通兼容 Provider 的 `/models` 同步请求。

规则值支持 `{{request_id}}` 模板。同一客户端请求的 Header、Body、OAuth 重试和 Provider failover 会复用同一个动态 ID；WebSocket 会话内也保持一致。管理台内置“Codex 客户端兼容预设”，会加入与当前 Codex TUI 形态配套的 `User-Agent`、`originator`、`version`、`x-codex-window-id`、`session-id`、`thread-id`，以及 Responses `client_metadata` 指纹，适合处理启用了 `codex_cli_only` 一类客户端门禁的兼容中转站。预设只是可编辑起点；中转若配置了 Codex 最低或最高版本边界，应将 `User-Agent` 中的版本与 `version` 一并调整到允许范围内。

Codex 预设只解决客户端身份与引擎指纹门禁，不会强制覆盖 `instructions`，以免破坏 Code Agent 自己的系统提示词。如果中转通过门禁后改为返回 `instructions is required` 一类 400，应先确认客户端发送了非空 `instructions`，再按实际协议补充 Body 规则。

示例配置：

```json
{
  "headers": [
    {
      "scope": "all",
      "operation": "set",
      "name": "User-Agent",
      "value": "codex-tui/0.146.0 (Ubuntu 22.4.0; x86_64) xterm-256color"
    },
    {
      "scope": "all",
      "operation": "set",
      "name": "originator",
      "value": "codex-tui"
    },
    {
      "scope": "all",
      "operation": "set",
      "name": "version",
      "value": "0.146.0"
    },
    {
      "scope": "all",
      "operation": "set",
      "name": "x-codex-window-id",
      "value": "{{request_id}}"
    }
  ],
  "body": [
    {
      "scope": "responses",
      "operation": "set",
      "path": "client_metadata.x-codex-window-id",
      "value": "{{request_id}}"
    }
  ]
}
```

为避免破坏路由与安全边界，网关拒绝覆写鉴权、Cookie、Host、Content-Length、压缩/连接控制、WebSocket 握手、代理转发/来源以及方法/路径重写 Header，也拒绝覆写 Body 根字段 `model`、`stream`、`type`。配置上限为 64 条 Header 规则、128 条 Body 规则和 256 KiB。

覆写值按普通 Provider 配置持久化，不是密钥保险库；不要把真实 API Key、Access Token 或会话 Cookie 写入规则，鉴权应继续通过 Provider Key / Codex OAuth 配置管理。

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
| `SESSION_AFFINITY_TTL_MS` | `1800000` | 会话到 Provider 亲和绑定的滑动 TTL（30 分钟）。 |
| `SESSION_AFFINITY_MAX_ENTRIES` | `10000` | 单进程最多保留的会话亲和条目数。 |
| `UPSTREAM_FIRST_EVENT_TIMEOUT_MS` | `60000` | SSE 首个有效事件到达前允许故障转移的等待上限。 |
| `UPSTREAM_FIRST_EVENT_MAX_BYTES` | `65536` | SSE 首个有效事件预检缓冲上限。 |
| `UPSTREAM_RATE_LIMIT_FALLBACK_COOLDOWN_MS` | `30000` | 402/429 未返回 reset 信息时的 key 冷却基准时长。 |

Provider 调度先按 API Key 与 Provider 的调度组交集授权，再使用组内优先级覆盖（未设置时使用 Provider 全局优先级）。同一优先级使用权重采样加 power-of-two choices，根据并发占用与延迟 EWMA 选择。带 `session-id`、`session_id`、`x-session-id`、`thread-id`、`prompt_cache_key` 或支持的 `metadata` 会话标识的请求会保持 Provider 亲和；新增 Provider 不会让已有健康会话漂移。

`GET /v1/models` 是协议无关的全局活动模型注册表：接口仍要求有效的客户端 Bearer Key，但不会按该 Key 的 Provider Group、`api_format` 查询参数、模型路由、Endpoint 健康、quota 或 circuit 状态过滤。模型只有在至少一个启用 Provider 下存在 `enabled=true && available=true` 的库存记录，并且至少一个启用上游 Key 允许该模型时才进入注册表；启用别名至少需要一个满足同样条件的目标。模型出现在注册表中不代表任意 API Key、协议或当前运行时状态下一定可执行，具体原因会由请求错误和日志中的路由决策链说明。

网关在尚未请求上游时使用 OpenAI 风格结构化错误。常见 `error.code` 如下：

| HTTP | `error.code` | 含义 |
| ---: | --- | --- |
| `404` | `model_not_found` | 没有 Provider 注册该模型，且不存在未同步库存的兼容 Provider。 |
| `403` | `model_disabled` | Gateway 全局策略或模型别名禁用了模型。 |
| `403` | `model_not_authorized` | 模型已注册，但客户端 Key 未授权匹配的 Provider Group。 |
| `400` | `model_protocol_unsupported` | Provider 不支持客户端协议，或 Chat-only 模型未开启 Responses→Chat。 |
| `503` | `model_not_available` | 同步库存中存在模型，但库存已禁用或不可用。 |
| `503` | `model_route_unavailable` | 模型路由排除了所有匹配 Provider。 |
| `503` | `no_upstream_key_for_model` | 没有启用且允许该模型的上游 Key。 |
| `503` | `no_enabled_upstream_endpoint` | 没有启用的上游 Endpoint。 |
| `503` | `all_upstreams_temporarily_unavailable` | 候选因熔断、quota、健康、并发或亲和回避而暂时不可用。 |

一旦上游已经返回响应，网关不会使用上述本地错误包装它：上游状态码、正文和安全响应头直接透传；模型级 `model_not_found` 错误也不会累计 Provider 熔断。

每个请求最多使用初始 Provider 加 3 次 Provider 切换，即最多 4 个不同 Provider；每个 Provider 默认尝试 2 次，可在管理界面单独调整。401/403 只影响 key，402/429 进入 key quota 冷却，404 会跨 Provider 重试但不累计 Provider 熔断，网络错误、408/409/425 和 5xx 才累计 Provider 熔断。SSE 只允许在首个有效事件发送给客户端之前故障转移，之后不会重放。

会话亲和、Provider 并发、EWMA、熔断和 quota 冷却均为进程内内存状态：重启会清空，多副本之间不会自动共享。Provider/API Key 配置、调度组、路由和请求决策链日志仍持久化到 SQLite/Postgres。多副本部署如需全局一致亲和，应在网关前配置稳定的会话级负载分配。

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
- `/v1/chat/completions` 不选 responses-only provider，并返回 `400 model_protocol_unsupported`
- `/v1/models` 与 `/v1/models?api_format=responses` 返回相同的协议无关注册表
- responses-only 模型同时出现在两个模型列表入口中
- provider/key 的 models 同步链路可用

测试产物写入 `data/tmp/`，脚本末尾会输出结果 JSON 路径。

## 本地验证与回归

- `python3 scripts/mock_upstream.py`：本地模拟上游（支持带任意 API 前缀的 chat/responses/models）
- `python3 scripts/bench_gateway.py ...`：基础并发 / 长压 / RSS 采样
- `python3 scripts/bench_failover.py ...`：endpoint / key failover 基线
- `python3 scripts/run_regression.py --archive-compress`：一键跑 build / 长压 / failover / archive 回归
