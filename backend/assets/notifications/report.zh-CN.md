---
preheader: "little-gate 通知：{{ rule.name }}"
lang: zh-CN
---

# {{ rule.name }}

时间窗口：{{ window.from_ms }} — {{ window.to_ms }}（{{ window.timezone }}）

::: callout
请求 **{{ usage.totals.requests }}** · 失败 **{{ usage.totals.failed }}** · Token **{{ usage.totals.total_tokens }}** · 成本 **${{ usage.totals.estimated_cost_usd }}**
:::

## 服务器状态

- CPU：{{ server.cpu_usage_percent }}%
- 内存：{{ server.memory_usage_percent }}%
- 上游：{{ server.healthy }} 正常 / {{ server.warning }} 警告 / {{ server.error }} 异常
- 数据库：{% if server.database_ready %}就绪{% else %}不可用{% endif %}

## 上游消耗

{{ provider_table_html | safe }}

## 客户端 Key 消耗

{{ client_key_table_html | safe }}

{% if alert %}
## 告警

{{ alert.metric }}：{{ alert.value }}（阈值 {{ alert.threshold }}）
{% endif %}

{% if warnings %}
## 提示

{% for warning in warnings %}- {{ warning }}
{% endfor %}
{% endif %}

::: footer
由 little-gate 自动发送 · 实例 {{ instance.id }}
:::
