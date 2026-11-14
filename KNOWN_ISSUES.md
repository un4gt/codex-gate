# 待解决问题

更新时间：2026-11-13

## 1. pr-agent 长请求超时导致渠道 503

- 现象：`pr-agent`（key 19）以非流式 Chat Completions 发送约 114 KB 的 PR diff，单次生成超过 120 秒；网关返回 504，Modal 侧记录 499；随后端点冷却，其他 key 的 deepseek 请求收到 503 `no_available_endpoint`。
- 根因：
  - provider 11（modal）未单独设置超时，走全局 `UPSTREAM_REQUEST_TIMEOUT_MS=120000`。
  - `upstream_timeout` 被归类为 Provider failure，单次失败即触发端点冷却。
  - 端点 HalfOpen 时只允许一个探针，且探针占用整个请求时长（最长 120 秒），期间其他请求全部拒绝。
  - pr-agent 的 SDK 读超时 600 秒，504 后快速重试，持续占用探针与冷却周期。
- 待办：
  - [ ] 半开探针增加租约（10–15 秒），超时后允许其他请求继续探测。
  - [ ] 单次 `upstream_timeout` 不立即冷却端点，至少连续 N 次或按失败比例。
  - [ ] modal provider 超时调到 300 秒；或让 pr-agent 使用 `stream: true`。
  - [ ] 确认 pr-agent 重试策略，尊重 503 的 `Retry-After`。

## 2. 上游 14（agy-proxy）模型同步 502

- 现象：`POST /api/v1/upstreams/14/models/sync` 返回 502 `{"error":"client error (Connect)"}`；浏览器经 Cloudflare 看到的是通用 502 页面。
- 根因：
  - provider 14 的 base URL 是 `http://127.0.0.1:8317/v1`，在 codex-gate 容器内 `127.0.0.1` 指向容器自身，端口未监听。
  - agy-proxy 实际运行在另一个 Docker 网络 `agy-proxy_default`；codex-gate 在 `codex-gate_default`，两者不能按容器名互访。
  - agy-proxy 的 8317 只发布在宿主机 `127.0.0.1` 与 `172.26.10.46`。
- 已验证：从 codex-gate 容器访问 `http://172.26.10.46:8317/v1/models` 可连通并返回 401（服务正常，需鉴权）。
- 待办：
  - [ ] 方案 A：把 codex-gate 接入 `agy-proxy_default` 网络，base URL 改为 `http://agy-proxy:8317/v1`。
  - [ ] 方案 B：base URL 改为 `http://172.26.10.46:8317/v1`（快速，但依赖宿主机内网 IP）。
  - [ ] 同步时确认 key 15 是 agy-proxy 的有效 API Key。

## 3. 部署安全（低优先级）

- [ ] `/home/codex-gate/docker-compose.aws.json` 中的 `ADMIN_TOKEN` / `MASTER_KEY` 为明文，建议改为 `.env` 或 Docker secret。
- [ ] 当前 `MASTER_KEY` 为空，会回退到 `ADMIN_TOKEN`；生产环境应显式设置独立值。
