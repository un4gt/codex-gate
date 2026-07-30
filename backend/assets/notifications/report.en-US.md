---
preheader: "little-gate notification: {{ rule.name }}"
lang: en-US
---

# {{ rule.name }}

Window: {{ window.from_ms }} — {{ window.to_ms }} ({{ window.timezone }})

::: callout
Requests **{{ usage.totals.requests }}** · Failed **{{ usage.totals.failed }}** · Tokens **{{ usage.totals.total_tokens }}** · Cost **${{ usage.totals.estimated_cost_usd }}**
:::

## Server status

- CPU: {{ server.cpu_usage_percent }}%
- Memory: {{ server.memory_usage_percent }}%
- Providers: {{ server.healthy }} healthy / {{ server.warning }} warning / {{ server.error }} error
- Database: {% if server.database_ready %}ready{% else %}unavailable{% endif %}

## Provider usage

{{ provider_table_html | safe }}

## Client key usage

{{ client_key_table_html | safe }}

{% if alert %}
## Alert

{{ alert.metric }}: {{ alert.value }} (threshold {{ alert.threshold }})
{% endif %}

{% if warnings %}
## Warnings

{% for warning in warnings %}- {{ warning }}
{% endfor %}
{% endif %}

::: footer
Sent automatically by little-gate · instance {{ instance.id }}
:::
