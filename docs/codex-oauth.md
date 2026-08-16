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
