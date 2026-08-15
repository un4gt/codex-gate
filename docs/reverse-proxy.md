# Nginx 与 Cloudflare 反向代理

Little Gate 的 HTTP Responses 和 Responses WebSocket 共用 `/v1/responses`：普通请求使用 `POST`，WebSocket 握手使用带 Upgrade 头的 `GET`。反向代理必须保留 WebSocket Upgrade 语义，否则后端只会收到普通 GET，无法建立连接。

OpenAI 官方的 [Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode) 也使用这个路径。单个连接最长持续 60 分钟，因此反向代理超时不能沿用较短的普通 API 超时。

## Nginx 配置

先在 Nginx 的 `http {}` 作用域声明连接映射。`map` 不能放进 `server {}` 或 `location {}`：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

如果站点文件由 `nginx.conf` 的 `http {}` 直接 include，可以把 `map` 放在站点文件中、`server` 之前。随后使用下面的代理配置：

```nginx
server {
    listen 80;
    server_name api.example.com;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

可直接从 [deploy/nginx/little-gate.conf.example](../deploy/nginx/little-gate.conf.example) 复制完整示例。Nginx 默认会继续转发 `Authorization`、`Content-Type`、`Accept` 和 `User-Agent`，无需逐个重复设置。

不要使用下面的配置，它会明确删除 WebSocket 握手所需的连接头：

```nginx
proxy_set_header Connection "";
```

修改后检查并平滑重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Cloudflare

Cloudflare 代理状态下的 DNS 记录支持 WebSocket。需要确认 Cloudflare 网络设置没有禁用 WebSockets，并为 API 路径绕过缓存。客户端到 Cloudflare 使用 `wss://` 时，Cloudflare 仍会向上述 Nginx 发起 HTTP/1.1 Upgrade；源站是否使用 HTTP 或 HTTPS 不改变 Upgrade 头必须被 Nginx 转发这一要求。

生产环境建议使用 Cloudflare `Full (strict)` SSL 模式和有效的源站证书，避免 Cloudflare 到源站之间使用明文 HTTP。这是传输安全建议，不是 Upgrade 404 的直接原因。

## 验证

先用无效 Key 验证反向代理是否保留了握手头。下面的请求应返回 `401 Unauthorized`，而不是 `404 Not Found` 或“websocket upgrade headers are missing”：

```bash
curl --http1.1 --include --max-time 5 https://api.example.com/v1/responses \
  -H 'Authorization: Bearer invalid-websocket-probe' \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
```

再使用 Little Gate 中创建的有效客户端 API Key 做端到端验证：

```bash
export CLIENT_API_KEY='replace-with-client-api-key'
curl --http1.1 --include --no-buffer --max-time 5 \
  https://api.example.com/v1/responses \
  -H "Authorization: Bearer ${CLIENT_API_KEY}" \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
```

正确响应以这些行开头：

```text
HTTP/1.1 101 Switching Protocols
connection: upgrade
upgrade: websocket
```

`curl` 随后因 `--max-time 5` 退出是预期行为；`101` 已证明握手成功。若返回 `426` 且提示没有已启用的 WebSocket 上游，请在管理台启用 Provider 的 WebSocket；如果原生上游只支持 HTTP Responses，还需为该 Provider 启用 Responses HTTP-to-WebSocket bridge。

## 常见响应

| 响应 | 含义 |
| --- | --- |
| `404 {"error":"not found"}` | 旧版本后端收到的只是普通 GET，通常是 Nginx 丢失 Upgrade 头。 |
| `426`，提示缺少 Upgrade 头 | 后端路径正确，但反向代理仍未转发 `Upgrade` 和 `Connection`。 |
| `401` | Upgrade 已到达后端，但客户端 API Key 缺失或无效。 |
| `426`，提示没有 WebSocket 上游 | 握手正常，Provider 的 WebSocket/HTTP bridge 配置未启用。 |
| `101 Switching Protocols` | 客户端到 Little Gate 的 WebSocket 握手成功。 |
