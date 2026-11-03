---
preheader: "little-gate notification: {{ rule.name }}"
lang: en-US
---

# {{ rule.name }}

Window: {{ display.window.from }} — {{ display.window.to }} ({{ display.window.timezone }})

::: callout
Requests **{{ display.requests }}** · Failed **{{ display.failed }}** · Tokens **{{ display.tokens }}** · Cost **{{ display.cost }}**
:::

## Server status

- CPU: {{ display.cpu }}
- Memory: {{ display.memory }}
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
