# 通知模块

通知模块位于管理台 `/notifications`，用于将 little-gate 的服务器状态与消费汇总发送到 SMTP 邮箱、通用 Webhook 或消息平台机器人。模块不新增环境变量；SMTP 密码、Webhook URL、签名密钥和自定义请求头值使用现有 `MASTER_KEY` 加密保存。

## 报表与告警

- 定时报表使用标准 5 段 Cron：`分钟 小时 日期 月份 星期`。
- 每条报表规则有独立 IANA 时区，默认 `Asia/Shanghai`。
- 报表窗口使用相邻计划边界 `[from, to)`；进程停机后只发送一份合并报表，并在 payload 中标记遗漏次数。
- 用量按上游 Provider 和客户端访问 Key 汇总，不展开 Provider 内部凭据 Key。
- 内容包含请求数、失败数、Token、用量覆盖率、估算美元成本和未定价请求数。
- 阈值告警支持首次触发、冷却提醒和恢复通知，每分钟评估一次。
- 数据库租约确保多实例部署中同一个计划或投递只会被一个实例领取。

服务器 CPU 和内存来自领取任务的实例；数据库用量汇总来自共享数据库。数据库完全不可用时，通知模块无法可靠地从同一个数据库中领取任务，因此数据库宕机告警仍应由外部监控检查 `/readyz`。

## SMTP

邮件由 Rust 后端通过 SMTP 投递，支持 TLS、STARTTLS 和显式无加密模式。HTML 与纯文本模板由 [EmailMD](https://www.emailmd.dev) 从 `backend/assets/notifications/report.zh-CN.md` 和 `report.en-US.md` 生成。

修改 Markdown 后执行：

```bash
npm --prefix frontend run email-templates:generate
npm --prefix frontend run email-templates:check
```

前端生产构建会自动执行模板一致性检查。每次投递使用稳定的 `Message-ID`，重试不会生成新的邮件标识。

## Webhook

Webhook 请求使用 `application/json`。通道的“消息格式”决定请求体结构：

- `generic`：发送版本化 little-gate 事件 JSON，并使用 little-gate HMAC 请求签名。
- `feishu`：发送飞书文本消息，顶层包含 `msg_type: "text"` 和 `content.text`；填写飞书机器人签名密钥后还会包含 `timestamp` 和 `sign`。
- `wecom`、`dingtalk`：发送平台文本消息，顶层包含 `msgtype: "text"` 和 `text.content`。企业微信遵循[官方文本消息规范](https://developer.work.weixin.qq.com/document/path/99110)，将 `text.content` 限制在 2048 个 UTF-8 字节内，超出时按字符边界截断并添加省略号；不会截断中文或 emoji 的编码。
- `slack`：发送包含 `text` 的 Incoming Webhook 消息。
- `discord`：发送包含 `content` 的 Webhook 消息，并按 Discord 文本长度限制截断。

`generic` payload 中的 `schema_version` 当前为 `1`。主要字段包括：

- `event`：投递 ID、事件类型和发生时间。
- `rule`：规则 ID、名称、语言和邮件 Top N。
- `instance`：领取任务的实例 ID、版本、启动时间和运行时长。
- `window`：统计范围、时区、是否补发、遗漏次数和数据完整性。
- `server`：CPU、内存、数据库就绪状态和上游健康汇总。
- `usage`：总计、Provider 明细和客户端 Key 明细。
- `alert`：告警指标、范围、当前值、阈值与状态；报表事件中可能为空。
- `warnings`：用量缺失、未定价或保留期不足等提示。

所有格式都会携带事件、投递、时间戳和幂等请求头。配置了签名密钥时还会携带签名请求头：

```text
X-Little-Gate-Event: <event_type>
X-Little-Gate-Delivery: <delivery_id>
X-Little-Gate-Timestamp: <unix_seconds>
X-Little-Gate-Signature: v1=<hex_hmac_sha256>
Idempotency-Key: <delivery_id>
```

签名输入为：

```text
<timestamp>.<raw_request_body>
```

通用 Webhook 接收端应使用通道签名密钥计算 HMAC-SHA256，进行常量时间比较，并校验时间戳以防重放。飞书、企业微信和钉钉即使返回 HTTP 2xx，little-gate 仍会检查响应体业务码；非零业务码会记录为失败，而不是误报“发送成功”。408、425、429 和 5xx 会重试；每次投递最多尝试 3 次，默认间隔为立即、1 分钟、5 分钟。Webhook body 限制为 1 MiB；每个用量维度最多保留 1,000 项，超出部分合并为“其他”。

发送历史的详情会保留最近一次尝试的实际请求体摘要、HTTP 状态和平台响应体摘要，便于排查平台业务错误。请求与响应摘要最多各保留 16 KiB，历史仍按 90 天清理。

管理 API 不返回 SMTP 密码、Webhook 签名密钥、自定义请求头值或完整 Webhook 路径/查询内容。只有通用 Webhook 会在密钥留空时自动生成 little-gate HMAC 密钥，并在创建响应中显示一次；消息平台格式不会自动生成平台密钥。

## 排查 `invalid_payload`

`invalid_payload` 表示投递器读取本地保存的通知 JSON 失败，此时尚未发出企业微信请求；平台返回非零 `errcode` 时记录的是 `webhook_platform_rejected`。

已修复带用量明细时出现的 `invalid type: map, expected f64`：`serde_json` 的 `arbitrary_precision` 与 `serde(flatten)` 组合会把统计百分比小数以内部映射形式传递给反序列化器。现在通过 JSON Number 读取失败率和用量覆盖率，保持现有 JSON 结构、大整数及金额精度，无需迁移数据库。企业微信、其他消息平台和 SMTP 共用这份通知数据，因此同时受益。部署修复后，可在发送历史中重试原有失败记录，或重新点击“发送测试”。

离线回归：`python scripts/run_wecom_notification_regression.py`。脚本启动临时网关和本地模拟企业微信接口，产生真实用量统计后调用通道测试 API，验证带小数的统计明细、UTF-8 长度限制、业务错误识别、投递诊断和保存报表的重试；不向真实企业微信群发送消息。可用 `--binary /path/to/backend` 指定现有程序，或设置独立 `CARGO_TARGET_DIR` 避免覆盖运行中的构建产物。
