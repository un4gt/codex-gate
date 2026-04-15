# 2026-04-14 进度记录（上游管理 / responses 渠道）

## 一、当前实现进度（摘要）

本轮代码基线已落地的关键点：

- 上游类型已收敛为固定枚举并由后端校验：
  - `openai`
  - `openai_compatible`
  - `openai_codex_oauth`
  - `openai_compatible_responses`
- 新建上游流程已包含最小关键字段：`API 密钥`、`Base URL`、`启用 websocket 传输`。
- provider 级 websocket 策略已实现：在 responses 流式请求时优先 websocket，失败自动回退 HTTP。
- `openai_compatible_responses` 已与 chat 通道隔离：
  - 该 provider 不参与 `/v1/chat/completions` 选路；
  - 可用于 `/v1/responses`；
  - `/v1/models?api_format=responses` 可单独暴露其模型。
- 模型管理链路已具备：
  - provider 模型同步（`/api/v1/providers/{id}/models/sync`）
  - key 模型同步（`/api/v1/keys/{id}/models/sync`）
  - provider 模型 alias / enabled / delete 管理
  - key 模型 enabled / delete 管理
- `AGENTS.md` 已写入本轮“产品约束与参考项目”，用于后续协作对齐。

> 注：当前 mock 工具已补齐 `GET /v1/models`（支持 `api_format=responses`），因此 provider/key 的 models/sync 可以在本地自洽验证。

---

## 二、Rust 分层与稳定性进展（与 `$rust-best-practices` 对齐）

当前后端已有显式分层：

- `backend/src/cache/`：
  - `api_key_cache.rs`
  - `upstream_cache.rs`
  - `policy.rs`
- 入口聚合：`backend/src/cache.rs`

结合本次检查结果：

- `cargo clippy --manifest-path backend/Cargo.toml --all-targets --all-features`：通过。
- `cargo test --manifest-path backend/Cargo.toml`：通过（当前无单元测试用例，0 tests）。
- 已避免为完成任务引入额外功能堆叠，保持“极简可控”。

---

## 三、`openai_compatible_responses` 本地实机测试（最新）

测试时间（UTC）：`2026-04-14T03:59:38Z`

### 1) 测试目标

验证 responses 渠道端到端链路是否符合预期：

1. provider / key 模型同步可用（从 `/v1/models?api_format=responses` 拉取）。
2. `/v1/responses` 正常路由到 responses provider。
3. `/v1/chat/completions` 不会误选 responses-only provider。
4. `/v1/models` 与 `/v1/models?api_format=responses` 视图隔离正确。

### 2) 执行方式

使用脚本：

```bash
MOCK_PORT=19130 GW_PORT=18130 scripts/test_openai_compatible_responses.sh
```

脚本会自动完成：

- 启动 mock upstream（含 chat/responses 模型集）
- 启动 backend（独立临时 SQLite）
- 创建 provider / endpoint / key / client api key
- 执行 provider models sync + key models sync
- 调用 `/v1/responses`、`/v1/chat/completions`、`/v1/models`、`/v1/models?api_format=responses`
- 自动断言并输出结果 JSON

### 3) 核验结果

断言全部通过，核心结果如下：

- `/v1/responses`：`200`
- `/v1/chat/completions`：`503`，错误为 `no available providers`
- `/v1/models`：chat 视图为空（`data=[]`）
- `/v1/models?api_format=responses`：返回 `resp-sync-mini`、`resp-sync-plus`
- provider/key models sync 均包含以上 responses 模型

### 4) 产物路径

- 结果 JSON：
  - `data/tmp/responses_chain_sync_result_20260414T035938Z.log`
- 网关日志：
  - `data/tmp/responses_gateway_sync_20260414T035938Z.log`
- mock 日志：
  - `data/tmp/responses_mock_sync_20260414T035938Z.log`
- 测试数据库：
  - `data/tmp/responses_chain_sync_20260414T035938Z.sqlite`

---

## 四、已新增的可复现脚本/工具

- `scripts/test_openai_compatible_responses.sh`
  - 一键执行 responses 渠道本地回归
  - 默认端口：`MOCK_PORT=19120`、`GW_PORT=18120`
  - 支持通过环境变量覆写端口与后端二进制路径
- `scripts/mock_upstream.py`
  - 新增 `GET /v1/models` 支持
  - 支持参数：
    - `--models-chat`
    - `--models-responses`
  - 支持 query：`?api_format=responses`

---

## 五、后续可执行项（不扩功能前提）

1. 将 `scripts/test_openai_compatible_responses.sh` 接入 `scripts/run_regression.py`（可选开关）。
2. 为 websocket->HTTP fallback 增加可观测指标（例如单独 failover 计数标签）。
3. 在真实第三方 `openai_compatible_responses` 上游上复跑一次同流程（替换 mock base_url + key）。
