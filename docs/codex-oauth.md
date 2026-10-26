# Codex OAuth 登录

little-gate 支持通过 OpenAI Codex OAuth 账号访问 ChatGPT Codex Responses API。管理台的“OAuth 登录”页面默认使用浏览器授权码 + PKCE；原有设备码登录保留为回退方式。

没有 `openai_codex_oauth` Provider 时，管理台可以自动创建默认 Provider 和 `https://chatgpt.com/backend-api/codex` endpoint，并立即发起登录。登录成功后，账号继续使用现有的密钥调度、账号去重、额度检查、模型同步和刷新租约。

## Docker Compose

仓库的 `docker-compose.yml` 已包含 callback 监听配置：

```yaml
ports:
  - "${LITTLE_GATE_PORT:-8080}:8080"
  - "127.0.0.1:1455:1455"
environment:
  LISTEN_ADDR: ${LISTEN_ADDR:-0.0.0.0:8080}
  CODEX_OAUTH_CALLBACK_LISTEN_ADDR: ${CODEX_OAUTH_CALLBACK_LISTEN_ADDR:-0.0.0.0:1455}
```

Docker 部署的 `.env` 使用：

```dotenv
CODEX_OAUTH_CALLBACK_LISTEN_ADDR=0.0.0.0:1455
```

容器内必须监听 `0.0.0.0:1455`。不要在 Docker 的 `.env` 中改成 `127.0.0.1:1455`，否则宿主机端口映射无法连接容器内 listener。宿主机映射固定绑定 `127.0.0.1`，不会默认向公网公开 callback 端口。

修改配置后重新构建并启动：

```bash
docker compose up -d --build
docker compose logs -f little-gate
```

正常日志包含：

```text
Codex OAuth callback listener on 0.0.0.0:1455
```

## 二进制部署

直接运行 Linux 或 Windows 二进制时使用回环监听：

```dotenv
CODEX_OAUTH_CALLBACK_LISTEN_ADDR=127.0.0.1:1455
```

如果不设置该变量，二进制默认同样监听 `127.0.0.1:1455`。端口必须保持为 `1455`，因为 OpenAI Codex 的 redirect URI 固定为：

```text
http://localhost:1455/auth/callback
```

## 登录步骤

1. 打开管理台侧边栏的“OAuth 登录”。
2. 选择已有 Codex Provider；如果不存在，点击“创建并登录”。
3. 保持“浏览器登录”，点击“打开 OpenAI 登录页”。
4. 完成 OpenAI 登录和授权。
5. 同机部署会自动接收 callback；远程部署按下一节提交完整 callback URL。
6. 管理台依次显示 Token 交换、凭据保存、额度刷新和模型同步状态。

需要回退时，可以在登录对话框切换到“设备码登录”。切换登录方式会先取消当前 pending 会话，避免同一个 Provider 或账号目标存在多个并发登录。

## 远程部署

OAuth redirect 中的 `localhost` 指浏览器所在机器，而不是远程 little-gate 服务器。因此浏览器和服务不在同一台机器时，自动 callback 通常无法到达服务器。

登录后即使浏览器显示无法访问 `localhost:1455`，授权结果仍保留在地址栏中。复制完整地址，例如：

```text
http://localhost:1455/auth/callback?code=...&state=...
```

将其粘贴到登录对话框的“回调地址”，然后点击“提交回调地址”。不要只复制 `code`，服务端还必须验证同一会话的 `state`。

也可以在操作者电脑建立 SSH 本地端口转发，使浏览器的 `localhost:1455` 到达远程服务器：

```bash
ssh -L 1455:127.0.0.1:1455 user@example-server
```

## Codex CLI 请求头兼容性

对照版本为 [Codex CLI `rust-v0.163.0`](https://github.com/openai/codex/tree/83086188ae0614bd882818ff1aa23f3194962012)，与此次 Reqable 请求头中客户端声明的版本一致。核对只使用 `/v1/responses` 的请求头，测试使用合成令牌和会话标识，不保存真实抓包内容。

HTTP Responses、原生 WebSocket 和 WebSocket 转 HTTP 桥接共用客户端请求头规则：

| 请求头 | 处理方式 |
| --- | --- |
| `x-codex-*` | 原样转发，包括 beta、窗口、turn metadata、turn state、父线程和路由提示；保留重复值 |
| `session-id`、`thread-id`、`x-client-request-id`、`originator`、`user-agent` | 保留客户端值 |
| `version` | 优先保留显式值；OAuth 模式下缺失时，从 `codex-tui`、`codex_cli_rs` 或 `codex_vscode` 的 User-Agent 提取版本 |
| `x-openai-internal-codex-responses-lite` | 保留客户端对 Responses Lite 的选择，未提供时不强制开启 |
| `x-openai-subagent`、`x-openai-memgen-request` | 保留子代理和记忆请求标识 |
| `x-openai-internal-codex-residency`、`x-oai-attestation`、`x-responsesapi-include-timing-metrics` | 客户端提供时转发，不代替客户端生成 |
| `Authorization`、`ChatGPT-Account-ID` | 使用网关所选 OAuth 账号的 Access Token 和账号 ID；客户端提供的网关密钥或账号 ID 不作为上游凭据 |
| `Host`、`Content-Length`、WebSocket 握手字段 | 按实际上游地址、请求体和连接重新生成 |

普通 HTTP 的 `Content-Type`、`Accept` 和 OpenAI API 请求头继续按既有白名单处理。Cookie、代理/CDN 地址头和任意未知 `x-openai-*` 头不在新增白名单内。HTTP 上游返回的 `x-codex-turn-state` 保留给客户端，后续请求携带时继续透传。

此前，抓包中的 `x-openai-internal-codex-responses-lite: true` 会被白名单丢弃；以上额外协议头也未完整覆盖。规则现在由 HTTP 和 WebSocket 共享，避免两条路径再次产生差异。来源见官方 [Responses 请求头构造](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/client.rs)、[线程元数据](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/responses_metadata.rs)及 [Provider 默认 version 头](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider-info/src/lib.rs)。

浏览器授权使用与该版本相同的 `client_id`、PKCE、redirect URI、`id_token_add_organizations` 和 `codex_cli_simplified_flow`，并补齐 `originator=codex_cli_rs` 及完整 scope：

```text
openid profile email offline_access api.connectors.read api.connectors.invoke
```

与官方一致，不再强制 `prompt=login`；刷新令牌使用 JSON grant，省略 `scope`，避免把原始授权缩小到 `openid profile email`。来源见官方 [浏览器授权参数](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/server.rs#L586)和 [令牌刷新](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L1625)。**已有账号需要重新进行浏览器授权，才能取得新增 scope；单纯刷新旧令牌不会扩大权限。**

## Codex CLI 模型目录

自定义 Provider 现在可以通过 `model_catalog_url` 获取 Codex 原生模型目录。参考 [tbphp/gpt-load 的目录设计](https://github.com/tbphp/gpt-load/tree/d3307afa7991e3100a1564bd4f3190b19e78890f/internal/clientcatalog)，网关复用 `/v1/models`，根据客户端附带的非空 `client_version` 参数协商格式：

- `GET /v1/models`：保持标准 OpenAI `{object: "list", data: [...]}`。
- `GET /v1/models?client_version=0.163.0`：返回 Codex 原生 `{models: [...]}`，包含推理档位、上下文窗口、模型提示词及工具能力等元数据。

在 Codex 的 `config.toml` 中为现有 Provider 增加 `model_catalog_url`，完整示例：

```toml
model_provider = "little-gate"

[features]
api_key_model_discovery = true

[model_providers.little-gate]
name = "little-gate"
base_url = "https://api.tumuer.me/v1"
model_catalog_url = "https://api.tumuer.me/v1/models"
env_key = "LITTLE_GATE_API_KEY"
wire_api = "responses"
```

将本项目签发的 API Key 放入 `LITTLE_GATE_API_KEY` 环境变量；目录与 Responses 请求使用同一个网关凭据。若已有 Provider，只补充该表中的目录字段即可，不要重复创建 TOML 表。无需手动拼接 `client_version`，CLI 会自动添加。Codex `0.163.0` 的 `api_key_model_discovery` 默认开启，示例显式列出以便检查已有配置。修改配置后重启 CLI；CLI 自身会缓存目录，网关权限变更可能需要客户端刷新才能反映到模型选择器，实际请求仍会校验最新权限。

目录复用网关的 Responses 路由规则，只包含调用方 API Key 授权、Provider/端点/Key 启用、模型库存及白名单允许的模型；OAuth 账号还必须处于可路由状态。仅支持 Chat 且未开启 Responses 转换的模型不会进入 Codex 目录。普通 `/v1/models` 的现有行为不变。

能力数据来自随程序嵌入的官方 Codex `rust-v0.163.0` 固定快照，[来源、校验值和更新方式](../backend/assets/codex/README.md)均已记录。已知原生 Responses 模型保留完整元数据；指向同一真实模型的别名使用该模型的能力并保留别名身份。未知模型、多目标异构别名、Responses→Chat 转换使用保守元数据，不声明未经确认的推理档位、上下文容量、图片输入或 Responses Lite 支持。目录中的 `supported_in_api=true` 表示可经本项目 Responses API 路由，不表示用户持有 OpenAI 官方 API 权限。

这是固定能力快照与本项目实时路由权限的组合，不是从每个 OAuth 账号实时获取的官方目录，也不代表该账号拥有快照里全部功能。目录不会扩大现有模型库存；仍需先在管理台同步并启用模型。响应按官方优先级排序，最多 1 MiB；超限时返回能完整容纳的有序模型前缀并记录警告，不截断 JSON。对于 `client_version >= 0.159.2` 的三段数字版本，移除与 `model_messages` 重复的旧 `base_instructions`；旧版或无法识别的版本保留兼容字段。

验证命令：

```bash
cargo test --manifest-path backend/Cargo.toml --locked
python scripts/run_codex_catalog_regression.py --codex /path/to/native/codex
```

回归使用临时数据库、合成凭据和本地上游，覆盖协议协商、权限、别名、转换、禁用与 OAuth 账号失效；可省略 `--codex` 仅运行网关回归。指定原生 Codex 可执行文件时，用独立 `CODEX_HOME` 启动 `app-server` 并调用 `model/list`，验证真实 CLI 能解码目录和显示模型；不读取现有登录文件、不进行真实推理。已在 `codex-cli 0.163.0` 验证通过。若本地运行实例占用默认构建产物，可设置独立 `CARGO_TARGET_DIR` 后运行。

## 与 CLI `/login` 的边界

以下源码核对固定在上述 `rust-v0.163.0` / `83086188ae0614bd882818ff1aa23f3194962012`，项目基线为 `v0.0.50`。结论不是“自定义 Provider 必然无法等价”，而是：**仅在网关完成 OAuth，再向原版 CLI 提供网关 API Key，不会自动给 CLI 建立 ChatGPT 账号身份；只修复 `/responses` 请求头不足以完成全部行为对齐。**

必须区分三种状态：网关保存的上游 OAuth 账号、CLI 的本地 `AuthManager`、模型 Provider 实际使用的请求凭据。官方 [`auth_manager_for_provider` 与 `resolve_provider_auth`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider/src/auth.rs#L184)表明，普通 `env_key` / 显式 Bearer 配置可以覆盖模型请求的凭据，同时保留传入的本地认证管理器；只有命令认证等路径另建 Provider 认证管理器。因此，“使用网关 API Key”不能单独证明本地 `AuthMode` 就是 `ApiKey`。CLI 也可能未登录，或另有有效 ChatGPT 登录。

本地认证类型由凭据构建，见 [`CodexAuth::auth_mode`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L509)及 [`AuthDotJson::resolved_mode`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L1764)。网关将出站 Bearer 替换成 OAuth Token，不会把这个本地对象同步变成 ChatGPT 登录。

| 核对项 | 该版本源码中的实际条件 | 对本项目的含义 |
| --- | --- | --- |
| 账号展示 | [`ConfiguredModelProvider::account_state`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider/src/provider.rs#L510)在 `requires_openai_auth` 为真时读取本地认证对象；邮箱和套餐也取自该对象 | 网关上游账号不会自动成为 CLI 展示的账号。仅启用 `requires_openai_auth` 也不会凭空生成 ChatGPT 凭据 |
| ChatGPT 内置 Apps | [`apps_enabled_for_auth`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/features/src/lib.rs#L584)要求 Apps 开关和账号条件；[`host_owned_codex_apps_enabled`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-mcp/src/mcp/mod.rs#L347)检查本地 `uses_codex_backend()`，不满足时移除内置 `codex_apps` 服务 | 只有网关 OAuth 而没有 CLI 的相应认证时，新增 scope 不会启用内置 Apps。这不代表自定义 MCP、skills 或插件整体不可用；它们需要分别核对 |
| 主动账号额度查询 | [`get_account_rate_limits_response`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/account_processor.rs#L1192)先检查本地认证，再用该身份访问独立的 `chatgpt_base_url` | 此请求不由模型 Provider 的 `/v1/responses` 代办。响应中携带的限流数据还有[独立解析路径](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/sse/responses.rs#L38)，不能把主动查询受限表述为所有限流信息都不可用 |
| 模型目录 | [`supports_api_key_models`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider/src/models_endpoint.rs#L213)支持显式 `model_catalog_url`；[`api_key_model_discovery`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/features/src/lib.rs#L977)在此版本默认开启，也有静态 `model_catalog_json` 路径 | 已补齐目录接口与配置：`/v1/models` 在收到非空 `client_version` 时返回[目录解码](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-api/src/endpoint/models.rs#L69)所需的 `{models: [...]}`，使用官方能力快照并按网关权限过滤。已通过真实 CLI 的 `model/list` 验证；不是实时 OAuth 账号目录或全部账号功能等价性证明 |
| 模型选择过滤 | [`build_available_models`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/models-manager/src/manager.rs#L170)依据本地认证决定过滤，最终调用 [`filter_by_auth`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/protocol/src/openai_models.rs#L1022) | 无相应账号认证时只展示 `supported_in_api` 模型。目录适配必须定义真实可用性和能力语义，不能只返回模型名称；选择器过滤也不等于已证明所有显式模型请求都被禁止 |
| WebSocket 与远程上下文压缩 | Provider 有可序列化的 `supports_websockets` 和 [`capabilities.remote_compaction`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider-info/src/capabilities.rs#L10)。[默认能力](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider/src/capabilities.rs#L31)按 Provider 决定，允许覆盖 | 不能把这些差异一律归因于 API Key。此版本压缩 V2 通过普通 Responses 请求发送 `compaction_trigger`，见[请求构造](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/compact_remote_v2_attempt.rs#L167)；需要对该协议单独验证，不能沿用旧版本假设为 `/responses/compact` |
| HTTP 请求体压缩 | [`responses_request_compression`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/client.rs#L1728)同时检查功能开关、本地 `uses_codex_backend()` 和 Provider 的 `is_openai()` | 请求编码存在条件差异；编码差异本身不能证明模型能力或回答质量下降 |
| 内部工具元数据 | [`include_internal_metadata`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider/src/provider.rs#L112)取决于目的地址或运行时授权；对应[字段定义](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider-info/src/lib.rs#L202)标注 `#[serde(skip)]` | 存在运行时集成入口，但不能通过在普通 `config.toml` 写 `include_internal_metadata = true` 开启。CLI 没有发出的工具元数据，网关不能通过补请求头恢复 |

### 保留原生账号能力的接入方向

源码提供了保留 ChatGPT 身份的接入机制，因此不应下结论为“任何网关架构都不可能接近原生登录”：

- **CLI 自己持有 ChatGPT 登录，模型请求经网关转发。** 保留本地身份，同时把网关认证与 OpenAI 认证分开。官方的 [`gateway_oauth` 组合认证](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider/src/combined_auth.rs#L22)就支持附加独立网关凭据，但它不是本项目现有“管理台登录上游 OAuth”的同一功能。当前网关入口只校验自身 Bearer API Key，并替换成调度选中的上游账号，仍需设计身份绑定及凭据处理。
- **通过 app-server 的外部 ChatGPT 凭据接口集成。** [`login_chatgpt_auth_tokens_response`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/request_processors/account_processor.rs#L856)接收 Access Token、账号 ID 和套餐，构建 `ChatgptAuthTokens`；[`ExternalAuthBridge::refresh`](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/src/external_auth.rs#L33)向宿主请求更新凭据。这是可用的集成机制，不等同于给现有 CLI 配一个网关 API Key，也不是完整等价性已验证。需要接入宿主、凭据刷新和固定账号语义；不需要让 CLI 与网关共享并发轮换同一个 Refresh Token。

内置 Apps 的地址由 `chatgpt_base_url` 形成独立的 [`/ps/mcp` 服务](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-mcp/src/mcp/mod.rs#L620)，并有[目的地址信任判断](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/codex-mcp/src/mcp/mod.rs#L363)。修改模型 `base_url` 不会自动代理这些调用，直接替换 `chatgpt_base_url` 也不足以保留其认证行为。

如果 CLI 本地账号与网关调度账号不同，账号展示、额度、连接器权限和推理实际使用的账号可能分别属于不同身份。完整对齐需要解决这个身份一致性问题，再验证目录、请求/响应协议和账号接口。此前完成的请求头与 OAuth 参数回归不能代替这些验证；本节是源码静态核对，未运行官方仓库测试或真实账号端到端验收。

离线验证命令为 `cargo test --manifest-path backend/Cargo.toml --locked` 和 `python scripts/run_oauth_metering_regression.py`。后者用临时数据库和本地模拟上游检查三条转发路径的实际请求头、账号凭据替换及 HTTP turn state 的往返，不访问真实 OpenAI 服务。离线通过不代表已经完成真实账号登录或生产流量验收。

## 管理 API

所有接口都需要现有的管理端 Bearer Token。

启动浏览器登录：

```http
POST /api/v1/providers/{provider_id}/codex-oauth/sessions
Content-Type: application/json

{"replace_key_id":null,"flow":"browser"}
```

`flow` 支持 `browser` 和 `device`。为兼容旧客户端，省略时默认使用 `device`；管理台会显式发送 `browser`。

查询和取消会话：

```http
GET /api/v1/codex-oauth/sessions/{session_id}
DELETE /api/v1/codex-oauth/sessions/{session_id}
```

手工提交 callback：

```http
POST /api/v1/codex-oauth/sessions/{session_id}/callback
Content-Type: application/json

{"redirect_url":"http://localhost:1455/auth/callback?code=...&state=..."}
```

浏览器会话状态阶段依次为 `waiting_for_user`、`exchanging`、`finalizing` 和 `finished`。Pending 会话只保存在当前进程内，服务重启后必须重新发起。

## 安全边界

- PKCE verifier 使用安全随机数生成，challenge 使用 SHA-256 和无填充 Base64URL。
- 每个浏览器会话使用独立随机 `state`，callback 只能认领一次。
- Callback URL 必须精确使用 `http://localhost:1455/auth/callback`，服务会校验协议、主机、端口、路径和重复参数。
- Access Token、Refresh Token 和 ID Token 使用 `MASTER_KEY` 加密后写入现有数据库。
- 授权码、PKCE verifier 和 OAuth Token 不写入日志，也不写入临时明文凭据文件。
- Callback HTML 禁止缓存，不回显 `code` 或 `state`，并设置严格的 CSP 和 Referrer Policy。

## 故障排查

### `1455` 端口已被占用

Listener 启动失败只会记录 warning，不会导致主服务退出。可以停止占用端口的程序，或者继续使用手工 callback。

Docker 宿主机端口冲突时，可以删除这一行后重新启动：

```yaml
- "127.0.0.1:1455:1455"
```

删除映射后，同机自动 callback 不可用，但管理台手工提交仍然有效。

### Callback 提示 state 无效

只提交当前登录对话框对应的最新 callback URL。重新发起登录后，旧页面和旧 callback 的 `state` 都会失效。

### 会话过期或服务重启

浏览器登录会话有效期为 5 分钟，设备码登录会话有效期为 15 分钟。服务重启会清空所有 pending 会话；重新点击登录即可。

### 登录成功但额度或模型同步出现警告

凭据保存成功后，额度刷新和模型同步失败会作为 warning 显示，不会回滚已登录账号。可以在 OAuth 账号列表中重新刷新额度，或在 Provider 页面重新同步模型。

## 模型限制与路由状态

在 OAuth 账户的“账号操作 → 模型限制”中管理账户白名单。OAuth 页面与上游详情共用同一组件和密钥模型 API；未配置条目时允许所有符合上游规则的模型，配置后仅允许列表中启用的模型。**删除全部条目会恢复不限**，禁用全部条目则不允许任何模型。限制匹配别名路由解析后的真实模型名。

同步保留已有条目的启停状态，新发现的模型默认启用。重新登录同一账户保留名称、启用开关、调度权重、优先级及模型限制。模型发现继续使用上游模型接口；事件兼容与模型名称无关。

上游列表及账户 API 返回 `routing_availability: { available, reason }`。该状态综合上游开关、账户开关、OAuth 授权、额度、模型限制、连接目标和运行时容量。全部账户不可路由时显示“无可用账户”，具体原因见账户行；这不会自动关闭上游总开关。手动关闭上游显示“上游已禁用”，重新启用有效账户后恢复可用。

配置修改对新 HTTP 请求和既有 WebSocket 的下一轮 `response.create` 生效。复用连接每轮刷新账户、模型、上游配置，并复核别名与授权；原目标失效时返回 `upstream_target_changed` 并关闭连接，客户端需要重连。原生 WebSocket 复用已有并发槽位。已经开始输出的请求允许完成。

## 用量与客户端断开

HTTP SSE、Responses JSON、OAuth SSE 转 JSON、原生 WebSocket 及 HTTP 桥接共用 Responses 事件和用量解析逻辑。支持 `response.completed`、`response.done`、`response.failed`、`response.incomplete`、`response.cancelled`/`response.canceled`；终态结果同时参考响应的 `status`。JSON `type` 优先于当前 SSE 帧的 `event:`。

解析支持仅有 `data:` 的事件、跨分块、多行 data、CRLF 和末尾没有空行的帧。单个完整 SSE 帧解析上限为 4 MiB，超过时跳过该帧并记录解析原因，HTTP 原始数据继续透传。首事件预读达到 `UPSTREAM_FIRST_EVENT_MAX_BYTES` 后交给计量读取任务继续转发，不因预读缓冲阈值拒绝大事件。JSON 计量至少保留 4 MiB 的有界窗口，超过窗口仍使用原有首尾用量捕获兜底。

用量读取 `response.usage` 或顶层 `usage`，支持 Responses 和 Chat Completions 的输入、输出、缓存及推理字段别名。有效终态用量优先，重复事件不累加；没有终态用量时保留之前有效观测。输入或输出 token 缺失时不推算消耗：`usage_observed=false` 表示未返回完整有效用量，真实零用量为 `usage_observed=true` 且计数为零。

客户端断开后，网关继续读取上游最多 **30 秒**，收到终态、上游关闭或更早的读取超时即结束。HTTP 使用独立读取任务和有界通道；WebSocket 独立观察客户端断开。日志记为 `client_disconnected`，耗时停在客户端断开时，后续收集到的用量仍结算。断开不触发上游重试，也不计为上游健康故障；日志及配额只结算一次。

## Fast / Standard 档位日志

OAuth 请求中的 `service_tier: "fast"` 和 `"priority"` 均转换为 `"priority"`，HTTP 和 WebSocket 行为一致。普通 OpenAI 上游继续按照既有规则透传及应用参数覆盖。

请求日志、管理 API 和 JSONL 归档包含三个可空字段：

| 字段 | 含义 |
| --- | --- |
| `requested_service_tier` | 客户端原始请求档位 |
| `upstream_service_tier` | 转换和上游覆盖后实际发送的档位 |
| `service_tier` | 上游实际返回的档位 |

返回 `fast` 或 `priority` 显示 **Fast**，返回 `default` 显示 **Standard**，其他返回值原样显示。未返回实际档位时显示“未确认”。[OpenAI Fast mode 文档](https://developers.openai.com/api/docs/guides/fast-mode#rate-limits-and-ramp-rate)明确说明，Fast 请求可能降至 Standard 并返回 `service_tier: "default"`，所以不能用请求档位代替实际档位。

SQLite 和 PostgreSQL 启动时幂等添加这些字段，历史行保持空值。默认日志布局增加“服务档位”，已经保存的自定义列及列顺序保持不变，日志详情始终展示三个字段。本次仅记录档位，不引入差异化计费规则。没有原始响应的历史请求保持原用量状态，不追溯推算。

离线回归可运行 `python3 scripts/run_oauth_metering_regression.py`，使用临时数据库和本地 HTTP/WebSocket 模拟上游，覆盖 `gpt-6-astra`、失败终态、白名单、档位、断连计量及 30 秒截止时间；不会调用真实 OAuth 服务。常规路由及归档回归仍为 `python3 scripts/run_regression.py --archive-compress`。
