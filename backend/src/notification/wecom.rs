//! WeCom robot message formats from document/path/99110. No remote image fetching.
use serde_json::{Value, json};

use super::presentation::{
    cost, integer, percent, title, truncate_chars, truncate_utf8_bytes, window_display,
};
use super::report::{NotificationPayload, UsageDimension};
use super::{NotificationError, WecomConfig, WecomMessageType};

pub(super) fn validate(config: &WecomConfig) -> Result<(), NotificationError> {
    let needs_link = matches!(
        config.message_type,
        WecomMessageType::TemplateCard | WecomMessageType::News
    );
    for (field, value, required) in [
        ("wecom.details_url", config.details_url.as_str(), needs_link),
        ("wecom.image_url", config.image_url.as_str(), false),
    ] {
        if value.is_empty() && !required {
            continue;
        }
        let valid = url::Url::parse(value).is_ok_and(|url| {
            matches!(url.scheme(), "https" | "http")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        });
        if !valid {
            return Err(NotificationError::bad_request(
                "invalid_wecom_url",
                "WeCom card links must be absolute HTTP(S) URLs without embedded credentials",
                Some(field),
            ));
        }
    }
    Ok(())
}

// Names/warnings are plain data, never markup or @-mentions supplied to the robot.
fn plain(value: &str, limit: usize) -> String {
    truncate_chars(
        &value
            .chars()
            .map(|c| match c {
                '<' => '＜',
                '>' => '＞',
                '*' => '＊',
                '[' => '［',
                ']' => '］',
                '`' => '｀',
                '#' => '＃',
                '_' => '＿',
                '\\' => '＼',
                c if c.is_control() => ' ',
                c => c,
            })
            .collect::<String>(),
        limit,
    )
}

fn label<'a>(payload: &NotificationPayload, zh: &'a str, en: &'a str) -> &'a str {
    if payload.rule.locale == "en-US" {
        en
    } else {
        zh
    }
}

fn window(payload: &NotificationPayload) -> String {
    let display = window_display(&payload.window);
    format!("{} — {} ({})", display.from, display.to, display.timezone)
}

fn usage_line(item: &UsageDimension, payload: &NotificationPayload) -> String {
    format!(
        "{} · {} {} · {} Token · {}",
        plain(&item.name, 60),
        integer(item.aggregate.requests),
        label(payload, "请求", "requests"),
        integer(item.aggregate.total_tokens),
        cost(&item.aggregate.estimated_cost_usd)
    )
}

fn alerts(payload: &NotificationPayload) -> String {
    let mut lines = Vec::new();
    if let Some(alert) = &payload.alert {
        let metric = serde_json::to_value(alert.metric)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        lines.push(format!(
            "{}: {} {:.2} / {} {:.2}",
            label(payload, "告警", "Alert"),
            metric,
            alert.value,
            label(payload, "阈值", "threshold"),
            alert.threshold
        ));
    }
    lines.extend(
        payload
            .warnings
            .iter()
            .take(3)
            .map(|warning| plain(warning, 96)),
    );
    if payload.warnings.len() > 3 {
        lines.push(
            label(
                payload,
                "另有提示，请查看详情。",
                "More warnings; see details.",
            )
            .into(),
        );
    }
    lines.join("\n")
}

fn usage_section(
    items: &[UsageDimension],
    payload: &NotificationPayload,
    heading: &str,
    budget: usize,
) -> String {
    let mut section = format!("\n**{heading}**\n");
    let mut shown = 0;
    for item in items.iter().take(usize::from(payload.rule.top_n)) {
        let line = format!("> {}\n", usage_line(item, payload));
        // Reserve space for an omission marker rather than cutting a Markdown construct.
        if section.len() + line.len() + 100 > budget {
            break;
        }
        section.push_str(&line);
        shown += 1;
    }
    if shown < items.len() {
        section.push_str(&format!(
            "> … {} {}\n",
            items.len() - shown,
            label(payload, "项未展示", "more items")
        ));
    } else if items.is_empty() {
        section.push_str(label(payload, "> 暂无用量\n", "> No usage\n"));
    }
    section
}

fn markdown(payload: &NotificationPayload) -> String {
    let totals = &payload.usage.totals;
    let server = &payload.server;
    let mut message = format!(
        "## {}\n> {}\n\n**{}** {} · **{}** {}\n**Token** {} · **{}** {}\n\n**{}**\n> CPU {} · {} {}\n> {} {} / {} {} / {} {} · {} {}\n",
        plain(&title(payload), 100),
        window(payload),
        label(payload, "请求", "Requests"),
        integer(totals.requests),
        label(payload, "失败", "Failed"),
        integer(totals.failed),
        integer(totals.total_tokens),
        label(payload, "成本", "Cost"),
        cost(&totals.estimated_cost_usd),
        label(payload, "服务器状态", "Server status"),
        percent(server.cpu_usage_percent),
        label(payload, "内存", "Memory"),
        percent(server.memory_usage_percent),
        server.healthy,
        label(payload, "正常", "healthy"),
        server.warning,
        label(payload, "警告", "warning"),
        server.error,
        label(payload, "异常", "error"),
        label(payload, "数据库", "Database"),
        if server.database_ready {
            label(payload, "就绪", "ready")
        } else {
            label(payload, "不可用", "unavailable")
        }
    );
    let alerts = alerts(payload);
    if !alerts.is_empty() {
        message.push_str(&format!(
            "\n**{}**\n{alerts}\n",
            label(payload, "告警与提示", "Alerts and warnings")
        ));
    }
    let footer = format!("\n> little-gate · {}", plain(&payload.instance.id, 40));
    let budget = 4096usize.saturating_sub(message.len() + footer.len()) / 2;
    message.push_str(&usage_section(
        &payload.usage.providers,
        payload,
        label(payload, "上游消耗", "Provider usage"),
        budget,
    ));
    message.push_str(&usage_section(
        &payload.usage.client_keys,
        payload,
        label(payload, "客户端 Key 消耗", "Client key usage"),
        budget,
    ));
    message.push_str(&footer);
    message
}

pub(super) fn build_message(
    config: &WecomConfig,
    payload: &NotificationPayload,
) -> Result<Value, String> {
    validate(config).map_err(|error| error.message)?;
    let totals = &payload.usage.totals;
    match config.message_type {
        WecomMessageType::Markdown => {
            Ok(json!({"msgtype": "markdown", "markdown": {"content": markdown(payload)}}))
        }
        WecomMessageType::Text => {
            let text = markdown(payload)
                .lines()
                .map(|line| {
                    line.trim_start_matches("## ")
                        .trim_start_matches("> ")
                        .replace("**", "")
                })
                .collect::<Vec<_>>()
                .join("\n");
            Ok(json!({"msgtype": "text", "text": {"content": truncate_utf8_bytes(&text, 2048)}}))
        }
        WecomMessageType::News => {
            let description = format!(
                "{}\n{} {} · {} {}\nToken {} · {}\n{}",
                window(payload),
                label(payload, "请求", "Requests"),
                integer(totals.requests),
                label(payload, "失败", "Failed"),
                integer(totals.failed),
                integer(totals.total_tokens),
                cost(&totals.estimated_cost_usd),
                alerts(payload)
            );
            let mut article = json!({"title": truncate_utf8_bytes(&title(payload), 128),
                "description": truncate_utf8_bytes(description.trim(), 512), "url": config.details_url});
            if !config.image_url.is_empty() {
                article["picurl"] = json!(config.image_url);
            }
            Ok(json!({"msgtype": "news", "news": {"articles": [article]}}))
        }
        WecomMessageType::TemplateCard => {
            let server = &payload.server;
            let color = match payload.event.event_type.as_str() {
                "alert_triggered" | "alert_reminder" => 2,
                "alert_recovered" => 3,
                _ => 0,
            };
            let rows = [
                (
                    label(payload, "请求", "Requests"),
                    format!(
                        "{} / {} {}",
                        integer(totals.requests),
                        integer(totals.failed),
                        label(payload, "失败", "failed")
                    ),
                ),
                ("Token", integer(totals.total_tokens)),
                (
                    label(payload, "成本", "Cost"),
                    cost(&totals.estimated_cost_usd),
                ),
                (
                    label(payload, "资源", "CPU/Mem"),
                    format!(
                        "{} / {}",
                        percent(server.cpu_usage_percent),
                        percent(server.memory_usage_percent)
                    ),
                ),
                (
                    label(payload, "上游", "Upstreams"),
                    format!(
                        "{} {} / {} {} / {} {}",
                        server.healthy,
                        label(payload, "正常", "OK"),
                        server.warning,
                        label(payload, "警告", "warn"),
                        server.error,
                        label(payload, "异常", "error")
                    ),
                ),
                (
                    label(payload, "数据库", "Database"),
                    if server.database_ready {
                        label(payload, "就绪", "ready")
                    } else {
                        label(payload, "不可用", "unavailable")
                    }
                    .into(),
                ),
            ]
            .into_iter()
            .map(|(key, value)| json!({"keyname": key, "value": truncate_chars(&value, 26)}))
            .collect::<Vec<_>>();
            let mut details = alerts(payload);
            for (heading, items) in [
                (
                    label(payload, "上游消耗", "Provider usage"),
                    &payload.usage.providers,
                ),
                (
                    label(payload, "客户端 Key 消耗", "Client key usage"),
                    &payload.usage.client_keys,
                ),
            ] {
                details.push_str(&format!("\n{heading}"));
                for item in items.iter().take(2) {
                    details.push_str(&format!("\n{}", usage_line(item, payload)));
                }
                if items.len() > 2 {
                    details.push_str(label(
                        payload,
                        "\n…更多请查看详情",
                        "\n…See details for more",
                    ));
                }
            }
            let mut card = json!({"card_type": "text_notice", "source": {"desc": "little-gate", "desc_color": color},
                "main_title": {"title": truncate_chars(&title(payload), 26)},
                "horizontal_content_list": rows,
                "quote_area": {"title": label(payload, "用量与提示", "Usage and notices"), "quote_text": truncate_chars(details.trim(), 700)},
                "jump_list": [{"type": 1, "title": label(payload, "查看详情", "View details"), "url": config.details_url}],
                "card_action": {"type": 1, "url": config.details_url}});
            if config.image_url.is_empty() {
                card["sub_title_text"] = json!(window(payload));
            } else {
                card["card_type"] = json!("news_notice");
                card["card_image"] = json!({"url": config.image_url, "aspect_ratio": 2.0});
                card["vertical_content_list"] = json!([{"title": label(payload, "时间窗口", "Time window"), "desc": window(payload)}]);
            }
            Ok(json!({"msgtype": "template_card", "template_card": card}))
        }
    }
}
