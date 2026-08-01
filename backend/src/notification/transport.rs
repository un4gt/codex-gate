use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use bytes::Bytes;
use hmac::{Hmac, Mac};
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::{CONTENT_TYPE, HeaderName, HeaderValue, USER_AGENT};
use hyper::{Request, StatusCode, Uri};
use lettre::message::{Mailbox, MultiPart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use minijinja::value::Value;
use minijinja::{AutoEscape, Environment, context};
use sha2::Sha256;

use super::report::{NotificationPayload, UsageDimension};
use super::{
    ChannelConfig, DELIVERY_TIMEOUT_SECS, NotificationError, NotificationLocale, SmtpChannelConfig,
    SmtpSecurity, WebhookChannelConfig, WebhookFormat,
};
use crate::upstream::UpstreamClient;
use crate::util;

const MAX_RESPONSE_BYTES: usize = 8 * 1024;
const MAX_WEBHOOK_BYTES: usize = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 16 * 1024;
const MAX_CHAT_MESSAGE_CHARS: usize = 16_000;
const MAX_DISCORD_MESSAGE_CHARS: usize = 2_000;
const USER_AGENT_VALUE: &str = "little-gate-notifications/1";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct DeliveryContext<'a> {
    pub delivery_id: &'a str,
    pub event_type: &'a str,
    pub payload_json: &'a str,
}

#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct DeliveryError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<i64>,
    pub diagnostics: DeliveryDiagnostics,
}

#[derive(Clone, Debug, Default)]
pub struct DeliveryDiagnostics {
    pub http_status: Option<u16>,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
}

impl DeliveryError {
    fn permanent(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: sanitize_error(message.into()),
            retryable: false,
            retry_after_ms: None,
            diagnostics: DeliveryDiagnostics::default(),
        }
    }

    fn retryable(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: sanitize_error(message.into()),
            retryable: true,
            retry_after_ms: None,
            diagnostics: DeliveryDiagnostics::default(),
        }
    }

    fn with_diagnostics(mut self, diagnostics: DeliveryDiagnostics) -> Self {
        self.diagnostics = diagnostics;
        self
    }
}

#[async_trait]
trait NotificationSender {
    async fn send(
        &self,
        config: &ChannelConfig,
        context: DeliveryContext<'_>,
    ) -> Result<DeliveryDiagnostics, DeliveryError>;
}

struct SmtpSender;

struct WebhookSender {
    client: UpstreamClient,
}

pub async fn send_delivery(
    client: UpstreamClient,
    config: &ChannelConfig,
    context: DeliveryContext<'_>,
) -> Result<DeliveryDiagnostics, DeliveryError> {
    match config {
        ChannelConfig::Smtp(_) => SmtpSender.send(config, context).await,
        ChannelConfig::Webhook(_) => WebhookSender { client }.send(config, context).await,
    }
}

pub fn validate_smtp_config(config: &SmtpChannelConfig) -> Result<(), NotificationError> {
    if config.host.trim().is_empty() {
        return Err(NotificationError::bad_request(
            "invalid_smtp_host",
            "SMTP host is required",
            Some("host"),
        ));
    }
    if config.port == 0 {
        return Err(NotificationError::bad_request(
            "invalid_smtp_port",
            "SMTP port must be between 1 and 65535",
            Some("port"),
        ));
    }
    parse_mailbox(config.from_name.as_deref(), &config.from_email).map_err(|message| {
        NotificationError::bad_request("invalid_from_email", message, Some("from_email"))
    })?;
    if config.recipients.is_empty() || config.recipients.len() > 50 {
        return Err(NotificationError::bad_request(
            "invalid_recipients",
            "SMTP channel requires between 1 and 50 recipients",
            Some("recipients"),
        ));
    }
    for recipient in &config.recipients {
        recipient.parse::<Mailbox>().map_err(|error| {
            NotificationError::bad_request(
                "invalid_recipient",
                error.to_string(),
                Some("recipients"),
            )
        })?;
    }
    if config.username.as_deref().is_some_and(str::is_empty)
        || config.password.as_deref().is_some_and(str::is_empty)
    {
        return Err(NotificationError::bad_request(
            "invalid_smtp_credentials",
            "SMTP username and password must not be empty strings",
            Some("username"),
        ));
    }
    if config.username.is_some() != config.password.is_some() {
        return Err(NotificationError::bad_request(
            "invalid_smtp_credentials",
            "SMTP username and password must be configured together",
            Some("username"),
        ));
    }
    Ok(())
}

pub fn validate_webhook_config(config: &WebhookChannelConfig) -> Result<(), NotificationError> {
    let uri = config.url.parse::<Uri>().map_err(|error| {
        NotificationError::bad_request("invalid_webhook_url", error.to_string(), Some("url"))
    })?;
    if !matches!(uri.scheme_str(), Some("http" | "https")) || uri.authority().is_none() {
        return Err(NotificationError::bad_request(
            "invalid_webhook_url",
            "Webhook URL must be an absolute HTTP or HTTPS URL",
            Some("url"),
        ));
    }
    if uri
        .authority()
        .is_some_and(|authority| authority.as_str().contains('@'))
    {
        return Err(NotificationError::bad_request(
            "invalid_webhook_url",
            "Webhook URL must not contain embedded credentials",
            Some("url"),
        ));
    }
    if config.format == WebhookFormat::Generic && config.signing_secret.trim().len() < 32 {
        return Err(NotificationError::bad_request(
            "invalid_signing_secret",
            "Webhook signing secret must contain at least 32 characters",
            Some("signing_secret"),
        ));
    }
    for header in &config.headers {
        validate_custom_header(header.name.as_str(), header.value.as_str())?;
    }
    Ok(())
}

#[async_trait]
impl NotificationSender for SmtpSender {
    async fn send(
        &self,
        config: &ChannelConfig,
        context: DeliveryContext<'_>,
    ) -> Result<DeliveryDiagnostics, DeliveryError> {
        let ChannelConfig::Smtp(config) = config else {
            return Err(DeliveryError::permanent(
                "channel_kind_mismatch",
                "expected SMTP channel configuration",
            ));
        };
        let payload: NotificationPayload = serde_json::from_str(context.payload_json)
            .map_err(|error| DeliveryError::permanent("invalid_payload", error.to_string()))?;
        let rendered = render_email(&payload)
            .map_err(|error| DeliveryError::permanent("email_render_failed", error))?;
        let from = parse_mailbox(config.from_name.as_deref(), &config.from_email)
            .map_err(|error| DeliveryError::permanent("invalid_from_email", error))?;
        let mut builder = Message::builder()
            .from(from)
            .message_id(Some(format!("{}@little-gate.local", context.delivery_id)))
            .subject(rendered.subject);
        for recipient in &config.recipients {
            let mailbox = recipient.parse::<Mailbox>().map_err(|error| {
                DeliveryError::permanent("invalid_recipient", error.to_string())
            })?;
            builder = builder.to(mailbox);
        }
        let message = builder
            .multipart(MultiPart::alternative_plain_html(
                rendered.text,
                rendered.html,
            ))
            .map_err(|error| DeliveryError::permanent("email_build_failed", error.to_string()))?;

        let builder = match config.security {
            SmtpSecurity::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(config.host.trim()),
            SmtpSecurity::Starttls => {
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(config.host.trim())
            }
            SmtpSecurity::None => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(
                config.host.trim(),
            )),
        }
        .map_err(|error| DeliveryError::permanent("smtp_configuration_failed", error.to_string()))?
        .port(config.port)
        .timeout(Some(Duration::from_secs(DELIVERY_TIMEOUT_SECS)));
        let builder = match (&config.username, &config.password) {
            (Some(username), Some(password)) => {
                builder.credentials(Credentials::new(username.clone(), password.clone()))
            }
            _ => builder,
        };
        let mailer = builder.build();
        let result = tokio::time::timeout(
            Duration::from_secs(DELIVERY_TIMEOUT_SECS),
            mailer.send(message),
        )
        .await
        .map_err(|_| DeliveryError::retryable("smtp_timeout", "SMTP delivery timed out"))?;
        result.map_err(|error| {
            if error.is_transient()
                || error.is_timeout()
                || error.is_tls()
                || error.is_transport_shutdown()
            {
                DeliveryError::retryable("smtp_temporary_error", error.to_string())
            } else {
                DeliveryError::permanent("smtp_delivery_failed", error.to_string())
            }
        })?;
        Ok(DeliveryDiagnostics::default())
    }
}

#[async_trait]
impl NotificationSender for WebhookSender {
    async fn send(
        &self,
        config: &ChannelConfig,
        context: DeliveryContext<'_>,
    ) -> Result<DeliveryDiagnostics, DeliveryError> {
        let ChannelConfig::Webhook(config) = config else {
            return Err(DeliveryError::permanent(
                "channel_kind_mismatch",
                "expected Webhook channel configuration",
            ));
        };
        let timestamp = util::now_ms().div_euclid(1_000).to_string();
        let request_body = build_webhook_body(config, context.payload_json, &timestamp)?;
        if request_body.len() > MAX_WEBHOOK_BYTES {
            return Err(DeliveryError::permanent(
                "webhook_payload_too_large",
                "Webhook payload exceeds 1 MiB",
            ));
        }
        let request_excerpt = diagnostic_excerpt(&request_body);
        let uri = config
            .url
            .parse::<Uri>()
            .map_err(|error| DeliveryError::permanent("invalid_webhook_url", error.to_string()))?;
        let mut builder = Request::post(uri)
            .header(CONTENT_TYPE, "application/json")
            .header(USER_AGENT, USER_AGENT_VALUE)
            .header("x-little-gate-event", context.event_type)
            .header("x-little-gate-delivery", context.delivery_id)
            .header("x-little-gate-timestamp", &timestamp)
            .header("idempotency-key", context.delivery_id);
        if !config.signing_secret.is_empty() {
            let signature = sign_webhook(&config.signing_secret, &timestamp, &request_body)?;
            builder = builder.header("x-little-gate-signature", format!("v1={signature}"));
        }
        for header in &config.headers {
            let name = HeaderName::from_bytes(header.name.as_bytes()).map_err(|error| {
                DeliveryError::permanent("invalid_webhook_header", error.to_string())
            })?;
            let value = HeaderValue::from_str(&header.value).map_err(|error| {
                DeliveryError::permanent("invalid_webhook_header", error.to_string())
            })?;
            builder = builder.header(name, value);
        }
        let request = builder
            .body(Full::new(Bytes::copy_from_slice(request_body.as_bytes())))
            .map_err(|error| {
                DeliveryError::permanent("webhook_request_failed", error.to_string())
            })?;
        let response = tokio::time::timeout(
            Duration::from_secs(DELIVERY_TIMEOUT_SECS),
            self.client.request(request),
        )
        .await
        .map_err(|_| {
            DeliveryError::retryable("webhook_timeout", "Webhook request timed out")
                .with_diagnostics(DeliveryDiagnostics {
                    request_body: Some(request_excerpt.clone()),
                    ..DeliveryDiagnostics::default()
                })
        })?
        .map_err(|error| {
            DeliveryError::retryable("webhook_network_error", error.to_string()).with_diagnostics(
                DeliveryDiagnostics {
                    request_body: Some(request_excerpt.clone()),
                    ..DeliveryDiagnostics::default()
                },
            )
        })?;
        let status = response.status();
        let retry_after_ms = parse_retry_after_ms(response.headers().get("retry-after"));
        let collected = Limited::new(response.into_body(), MAX_RESPONSE_BYTES)
            .collect()
            .await;
        let response_excerpt = collected
            .ok()
            .and_then(|body| String::from_utf8(body.to_bytes().to_vec()).ok())
            .map(|value| diagnostic_excerpt(&value))
            .filter(|value| !value.is_empty());
        let diagnostics = DeliveryDiagnostics {
            http_status: Some(status.as_u16()),
            request_body: Some(request_excerpt),
            response_body: response_excerpt.clone(),
        };
        if status.is_success() {
            validate_platform_response(config.format, response_excerpt.as_deref())
                .map_err(|error| error.with_diagnostics(diagnostics.clone()))?;
            return Ok(diagnostics);
        }
        let message = response_excerpt
            .as_deref()
            .map(|value| sanitize_error(value.to_string()))
            .unwrap_or_else(|| format!("Webhook returned {status}"));
        if is_retryable_status(status) {
            return Err(DeliveryError {
                code: "webhook_temporary_status",
                message,
                retryable: true,
                retry_after_ms,
                diagnostics,
            });
        }
        Err(
            DeliveryError::permanent("webhook_rejected", format!("{status}: {message}"))
                .with_diagnostics(diagnostics),
        )
    }
}

fn build_webhook_body(
    config: &WebhookChannelConfig,
    payload_json: &str,
    timestamp: &str,
) -> Result<String, DeliveryError> {
    if config.format == WebhookFormat::Generic {
        return Ok(payload_json.to_string());
    }
    let payload: NotificationPayload = serde_json::from_str(payload_json)
        .map_err(|error| DeliveryError::permanent("invalid_payload", error.to_string()))?;
    let rendered = render_email(&payload)
        .map_err(|error| DeliveryError::permanent("webhook_render_failed", error))?;
    let max_chars = if config.format == WebhookFormat::Discord {
        MAX_DISCORD_MESSAGE_CHARS
    } else {
        MAX_CHAT_MESSAGE_CHARS
    };
    let message = truncate_chars(
        &format!("{}\n\n{}", rendered.subject, rendered.text),
        max_chars,
    );
    let body = match config.format {
        WebhookFormat::Generic => unreachable!("generic webhook returned before rendering"),
        WebhookFormat::Feishu => {
            let mut body = serde_json::json!({
                "msg_type": "text",
                "content": { "text": message },
            });
            if !config.signing_secret.is_empty() {
                body["timestamp"] = serde_json::Value::String(timestamp.to_string());
                body["sign"] = serde_json::Value::String(sign_feishu_webhook(
                    &config.signing_secret,
                    timestamp,
                )?);
            }
            body
        }
        WebhookFormat::Wecom | WebhookFormat::Dingtalk => serde_json::json!({
            "msgtype": "text",
            "text": { "content": message },
        }),
        WebhookFormat::Slack => serde_json::json!({ "text": message }),
        WebhookFormat::Discord => serde_json::json!({ "content": message }),
    };
    serde_json::to_string(&body)
        .map_err(|error| DeliveryError::permanent("webhook_render_failed", error.to_string()))
}

fn validate_platform_response(
    format: WebhookFormat,
    response_body: Option<&str>,
) -> Result<(), DeliveryError> {
    let (code_field, message_field) = match format {
        WebhookFormat::Feishu => ("code", "msg"),
        WebhookFormat::Wecom | WebhookFormat::Dingtalk => ("errcode", "errmsg"),
        WebhookFormat::Generic | WebhookFormat::Slack | WebhookFormat::Discord => return Ok(()),
    };
    let raw = response_body.ok_or_else(|| {
        DeliveryError::permanent(
            "webhook_invalid_response",
            "Webhook returned an empty platform response",
        )
    })?;
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|error| {
        DeliveryError::permanent(
            "webhook_invalid_response",
            format!("Webhook returned invalid JSON: {error}"),
        )
    })?;
    let code = value
        .get(code_field)
        .and_then(serde_json::Value::as_i64)
        .or_else(|| {
            (format == WebhookFormat::Feishu)
                .then(|| value.get("StatusCode").and_then(serde_json::Value::as_i64))
                .flatten()
        })
        .ok_or_else(|| {
            DeliveryError::permanent(
                "webhook_invalid_response",
                format!("Webhook response is missing {code_field}"),
            )
        })?;
    if code == 0 {
        return Ok(());
    }
    let message = value
        .get(message_field)
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .get("StatusMessage")
                .and_then(serde_json::Value::as_str)
        })
        .unwrap_or("platform rejected the message");
    Err(DeliveryError::permanent(
        "webhook_platform_rejected",
        format!("Webhook platform returned code {code}: {message}"),
    ))
}

fn sign_feishu_webhook(secret: &str, timestamp: &str) -> Result<String, DeliveryError> {
    let string_to_sign = format!("{timestamp}\n{secret}");
    let mac = HmacSha256::new_from_slice(string_to_sign.as_bytes())
        .map_err(|error| DeliveryError::permanent("invalid_signing_secret", error.to_string()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes()))
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

fn diagnostic_excerpt(value: &str) -> String {
    if value.len() <= MAX_DIAGNOSTIC_BYTES {
        return value.to_string();
    }
    let mut boundary = MAX_DIAGNOSTIC_BYTES.saturating_sub(3);
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}...", &value[..boundary])
}

struct RenderedEmail {
    subject: String,
    html: String,
    text: String,
}

fn render_email(payload: &NotificationPayload) -> Result<RenderedEmail, String> {
    let locale = if payload.rule.locale == "en-US" {
        NotificationLocale::EnUs
    } else {
        NotificationLocale::ZhCn
    };
    let top_n = usize::from(payload.rule.top_n);
    let provider_html = render_html_table(&payload.usage.providers, top_n, locale);
    let client_key_html = render_html_table(&payload.usage.client_keys, top_n, locale);
    let provider_text = render_text_table(&payload.usage.providers, top_n);
    let client_key_text = render_text_table(&payload.usage.client_keys, top_n);
    let mut html_env = Environment::new();
    html_env.set_auto_escape_callback(|_| AutoEscape::Html);
    let mut text_env = Environment::new();
    let (html_source, text_source) = match locale {
        NotificationLocale::ZhCn => (
            include_str!("../../assets/notifications/report.zh-CN.html"),
            include_str!("../../assets/notifications/report.zh-CN.txt"),
        ),
        NotificationLocale::EnUs => (
            include_str!("../../assets/notifications/report.en-US.html"),
            include_str!("../../assets/notifications/report.en-US.txt"),
        ),
    };
    html_env
        .add_template("report", html_source)
        .map_err(|error| error.to_string())?;
    text_env
        .add_template("report", text_source)
        .map_err(|error| error.to_string())?;
    let html = html_env
        .get_template("report")
        .map_err(|error| error.to_string())?
        .render(context! {
            rule => &payload.rule,
            instance => &payload.instance,
            window => &payload.window,
            server => &payload.server,
            usage => &payload.usage,
            alert => &payload.alert,
            warnings => &payload.warnings,
            provider_table_html => Value::from_safe_string(provider_html),
            client_key_table_html => Value::from_safe_string(client_key_html),
        })
        .map_err(|error| error.to_string())?;
    let text = text_env
        .get_template("report")
        .map_err(|error| error.to_string())?
        .render(context! {
            rule => &payload.rule,
            instance => &payload.instance,
            window => &payload.window,
            server => &payload.server,
            usage => &payload.usage,
            alert => &payload.alert,
            warnings => &payload.warnings,
            provider_table_text => provider_text,
            client_key_table_text => client_key_text,
        })
        .map_err(|error| error.to_string())?;
    let label = match (locale, payload.event.event_type.as_str()) {
        (NotificationLocale::ZhCn, "alert_triggered") => "[告警]",
        (NotificationLocale::ZhCn, "alert_reminder") => "[持续告警]",
        (NotificationLocale::ZhCn, "alert_recovered") => "[已恢复]",
        (NotificationLocale::EnUs, "alert_triggered") => "[Alert]",
        (NotificationLocale::EnUs, "alert_reminder") => "[Ongoing alert]",
        (NotificationLocale::EnUs, "alert_recovered") => "[Recovered]",
        _ => "",
    };
    Ok(RenderedEmail {
        subject: format!("[little-gate]{label} {}", payload.rule.name),
        html,
        text,
    })
}

fn render_html_table(items: &[UsageDimension], top_n: usize, locale: NotificationLocale) -> String {
    let (name_label, requests_label, tokens_label, cost_label) = match locale {
        NotificationLocale::ZhCn => ("名称", "请求", "Token", "成本"),
        NotificationLocale::EnUs => ("Name", "Requests", "Tokens", "Cost"),
    };
    let mut out = format!(
        "<table role=\"table\" style=\"width:100%;border-collapse:collapse\"><thead><tr><th align=\"left\" style=\"border-bottom:1px solid #ddd;padding:8px\">{name_label}</th><th align=\"right\" style=\"border-bottom:1px solid #ddd;padding:8px\">{requests_label}</th><th align=\"right\" style=\"border-bottom:1px solid #ddd;padding:8px\">{tokens_label}</th><th align=\"right\" style=\"border-bottom:1px solid #ddd;padding:8px\">{cost_label}</th></tr></thead><tbody>"
    );
    for item in items.iter().take(top_n) {
        out.push_str(&format!(
            "<tr><td style=\"border-bottom:1px solid #eee;padding:8px\">{}</td><td align=\"right\" style=\"border-bottom:1px solid #eee;padding:8px\">{}</td><td align=\"right\" style=\"border-bottom:1px solid #eee;padding:8px\">{}</td><td align=\"right\" style=\"border-bottom:1px solid #eee;padding:8px\">${}</td></tr>",
            escape_html(&item.name),
            item.aggregate.requests,
            item.aggregate.total_tokens,
            escape_html(&item.aggregate.estimated_cost_usd),
        ));
    }
    out.push_str("</tbody></table>");
    out
}

fn render_text_table(items: &[UsageDimension], top_n: usize) -> String {
    items
        .iter()
        .take(top_n)
        .map(|item| {
            format!(
                "- {}: requests {}, tokens {}, cost ${}",
                item.name,
                item.aggregate.requests,
                item.aggregate.total_tokens,
                item.aggregate.estimated_cost_usd
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_mailbox(name: Option<&str>, email: &str) -> Result<Mailbox, String> {
    let address = email
        .trim()
        .parse()
        .map_err(|error: lettre::address::AddressError| error.to_string())?;
    Ok(Mailbox::new(
        name.map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        address,
    ))
}

fn validate_custom_header(name: &str, value: &str) -> Result<(), NotificationError> {
    let parsed = HeaderName::from_bytes(name.trim().as_bytes()).map_err(|error| {
        NotificationError::bad_request("invalid_webhook_header", error.to_string(), Some("headers"))
    })?;
    if value.is_empty() {
        return Err(NotificationError::bad_request(
            "invalid_webhook_header",
            "Webhook header values must not be empty",
            Some("headers"),
        ));
    }
    HeaderValue::from_str(value).map_err(|error| {
        NotificationError::bad_request("invalid_webhook_header", error.to_string(), Some("headers"))
    })?;
    let reserved = [
        "host",
        "content-length",
        "content-type",
        "connection",
        "transfer-encoding",
        "upgrade",
        "x-little-gate-event",
        "x-little-gate-delivery",
        "x-little-gate-timestamp",
        "x-little-gate-signature",
        "idempotency-key",
    ];
    if reserved.iter().any(|item| parsed.as_str() == *item) {
        return Err(NotificationError::bad_request(
            "reserved_webhook_header",
            format!("Webhook header {} is reserved", parsed.as_str()),
            Some("headers"),
        ));
    }
    Ok(())
}

fn sign_webhook(secret: &str, timestamp: &str, body: &str) -> Result<String, DeliveryError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|error| DeliveryError::permanent("invalid_signing_secret", error.to_string()))?;
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn parse_retry_after_ms(value: Option<&HeaderValue>) -> Option<i64> {
    let seconds = value?.to_str().ok()?.trim().parse::<i64>().ok()?;
    Some(seconds.clamp(1, 1_800).saturating_mul(1_000))
}

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 425 | 429) || status.is_server_error()
}

fn sanitize_error(mut message: String) -> String {
    message = message.replace(['\r', '\n'], " ");
    if message.len() > 512 {
        let mut boundary = 512;
        while !message.is_char_boundary(boundary) {
            boundary -= 1;
        }
        message.truncate(boundary);
    }
    message
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notification::report::{
        EventPayload, InstancePayload, RulePayload, ServerPayload, UsageAggregate, UsagePayload,
        WindowPayload,
    };

    #[test]
    fn webhook_signature_is_stable() {
        let first =
            sign_webhook("01234567890123456789012345678901", "10", "{}").expect("signature");
        let second =
            sign_webhook("01234567890123456789012345678901", "10", "{}").expect("signature");
        assert_eq!(first, second);
    }

    #[test]
    fn reserved_headers_are_rejected() {
        let error = validate_custom_header("Content-Length", "5").unwrap_err();
        assert_eq!(error.code, "reserved_webhook_header");
    }

    #[test]
    fn feishu_webhook_body_contains_msg_type() {
        let body = build_webhook_body(
            &webhook_config(WebhookFormat::Feishu),
            &serde_json::to_string(&sample_payload()).expect("serialize payload"),
            "10",
        )
        .expect("build Feishu body");
        let value: serde_json::Value = serde_json::from_str(&body).expect("parse Feishu body");

        assert_eq!(value["msg_type"], "text");
    }

    #[test]
    fn feishu_webhook_body_places_message_in_content_text() {
        let body = build_webhook_body(
            &webhook_config(WebhookFormat::Feishu),
            &serde_json::to_string(&sample_payload()).expect("serialize payload"),
            "10",
        )
        .expect("build Feishu body");
        let value: serde_json::Value = serde_json::from_str(&body).expect("parse Feishu body");

        assert!(
            value["content"]["text"]
                .as_str()
                .is_some_and(|message| message.contains("Daily report"))
        );
    }

    #[test]
    fn feishu_business_error_rejects_http_success_response() {
        let error = validate_platform_response(
            WebhookFormat::Feishu,
            Some(r#"{"code":19001,"msg":"param invalid"}"#),
        )
        .unwrap_err();

        assert_eq!(error.code, "webhook_platform_rejected");
    }

    #[test]
    fn feishu_zero_business_code_accepts_response() {
        let result = validate_platform_response(
            WebhookFormat::Feishu,
            Some(r#"{"code":0,"msg":"success"}"#),
        );

        assert!(result.is_ok(), "unexpected validation error: {result:?}");
    }

    #[test]
    fn html_table_escapes_names() {
        let items = vec![UsageDimension {
            id: 1,
            name: "<script>".to_string(),
            aggregate: Default::default(),
        }];
        let html = render_html_table(&items, 20, NotificationLocale::EnUs);
        assert!(!html.contains("<script>"));
    }

    #[test]
    fn generated_email_assets_render_with_minijinja_contract() {
        let payload = NotificationPayload {
            schema_version: 1,
            event: EventPayload {
                id: "event-1".to_string(),
                event_type: "scheduled_report".to_string(),
                occurred_at_ms: 1,
            },
            rule: RulePayload {
                id: Some(1),
                name: "Daily report".to_string(),
                locale: "en-US".to_string(),
                top_n: 20,
            },
            instance: InstancePayload {
                id: "instance-1".to_string(),
                hostname: None,
                version: "test".to_string(),
                commit: "test".to_string(),
                started_at_ms: 0,
                uptime_ms: 1,
            },
            window: WindowPayload {
                from_ms: 0,
                to_ms: 1,
                timezone: "UTC".to_string(),
                catch_up: false,
                missed_occurrences: 0,
                data_complete: true,
            },
            server: ServerPayload {
                database_ready: true,
                scope: "host".to_string(),
                cpu_usage_percent: Some(12.5),
                cpu_capacity_cores: 4.0,
                cpu_sample_ms: Some(1_000),
                memory_used_bytes: Some(1),
                memory_total_bytes: Some(2),
                memory_usage_percent: Some(50.0),
                memory_limited: false,
                providers_enabled: 1,
                healthy: 1,
                warning: 0,
                error: 0,
            },
            usage: UsagePayload {
                totals: UsageAggregate::default(),
                providers: vec![UsageDimension {
                    id: 1,
                    name: "Provider A".to_string(),
                    aggregate: UsageAggregate::default(),
                }],
                client_keys: Vec::new(),
                truncated: false,
                total_provider_items: 1,
                total_client_key_items: 0,
            },
            alert: None,
            warnings: Vec::new(),
        };
        let rendered = render_email(&payload).expect("render email");
        assert!(rendered.html.contains("Daily report"));
        assert!(rendered.html.contains("Provider A"));
        assert!(rendered.text.contains("Provider A"));
    }

    fn webhook_config(format: WebhookFormat) -> WebhookChannelConfig {
        WebhookChannelConfig {
            url: "https://example.com/hook".to_string(),
            format,
            signing_secret: String::new(),
            headers: Vec::new(),
        }
    }

    fn sample_payload() -> NotificationPayload {
        NotificationPayload {
            schema_version: 1,
            event: EventPayload {
                id: "event-1".to_string(),
                event_type: "scheduled_report".to_string(),
                occurred_at_ms: 1,
            },
            rule: RulePayload {
                id: Some(1),
                name: "Daily report".to_string(),
                locale: "en-US".to_string(),
                top_n: 20,
            },
            instance: InstancePayload {
                id: "instance-1".to_string(),
                hostname: None,
                version: "test".to_string(),
                commit: "test".to_string(),
                started_at_ms: 0,
                uptime_ms: 1,
            },
            window: WindowPayload {
                from_ms: 0,
                to_ms: 1,
                timezone: "UTC".to_string(),
                catch_up: false,
                missed_occurrences: 0,
                data_complete: true,
            },
            server: ServerPayload {
                database_ready: true,
                scope: "host".to_string(),
                cpu_usage_percent: Some(12.5),
                cpu_capacity_cores: 4.0,
                cpu_sample_ms: Some(1_000),
                memory_used_bytes: Some(1),
                memory_total_bytes: Some(2),
                memory_usage_percent: Some(50.0),
                memory_limited: false,
                providers_enabled: 1,
                healthy: 1,
                warning: 0,
                error: 0,
            },
            usage: UsagePayload {
                totals: UsageAggregate::default(),
                providers: Vec::new(),
                client_keys: Vec::new(),
                truncated: false,
                total_provider_items: 0,
                total_client_key_items: 0,
            },
            alert: None,
            warnings: Vec::new(),
        }
    }
}
