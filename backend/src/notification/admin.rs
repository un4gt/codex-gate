use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::runtime::{enqueue_channel_test, enqueue_rule_run};
use super::store::{ChannelRecord, DeliveryView, RuleRecord};
use super::{
    ChannelConfig, CreateChannelRequest, CreateRuleRequest, NotificationError, NotificationLocale,
    RuleConfig, SchedulePreviewRequest, UpdateChannelRequest, UpdateRuleRequest,
    decode_rule_config, encode_json, next_occurrences, validate_channel_config,
    validate_rule_config,
};
use crate::http::{self, HttpResponse};
use crate::state::SharedState;
use crate::{crypto, util};

const DEFAULT_DELIVERY_LIMIT: i64 = 50;
const MAX_DELIVERY_LIMIT: i64 = 200;
const SCHEDULE_PREVIEW_COUNT: usize = 5;

#[derive(Serialize)]
struct SummaryResponse {
    enabled_channels: i64,
    enabled_rules: i64,
    firing_alerts: i64,
    failed_deliveries_24h: i64,
}

#[derive(Serialize)]
struct ListResponse<T> {
    items: Vec<T>,
}

#[derive(Serialize)]
struct DeliveryListResponse {
    items: Vec<DeliveryView>,
    offset: i64,
    limit: i64,
}

#[derive(Serialize)]
struct DeliveryDetailResponse {
    #[serde(flatten)]
    delivery: DeliveryView,
    last_http_status: Option<i32>,
    last_request_body: Option<String>,
    last_response_body: Option<String>,
    event_payload: serde_json::Value,
}

#[derive(Serialize)]
struct EnqueuedResponse {
    run_id: String,
}

#[derive(Serialize)]
struct SchedulePreviewResponse {
    cron: String,
    timezone: String,
    occurrences_ms: Vec<i64>,
}

#[derive(Serialize)]
struct CreatedChannelResponse {
    channel: ChannelView,
    #[serde(skip_serializing_if = "Option::is_none")]
    generated_signing_secret: Option<String>,
}

#[derive(Serialize)]
struct ChannelView {
    id: i64,
    name: String,
    enabled: bool,
    #[serde(flatten)]
    config: PublicChannelConfig,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Serialize)]
struct AlertStateView {
    state: String,
    breach_count: i64,
    recovery_count: i64,
    opened_at_ms: Option<i64>,
    last_notified_at_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(tag = "kind", content = "config", rename_all = "snake_case")]
enum PublicChannelConfig {
    Smtp(PublicSmtpConfig),
    Webhook(PublicWebhookConfig),
}

#[derive(Serialize)]
struct PublicSmtpConfig {
    host: String,
    port: u16,
    security: super::SmtpSecurity,
    username: Option<String>,
    has_password: bool,
    from_name: Option<String>,
    from_email: String,
    recipients: Vec<String>,
}

#[derive(Serialize)]
struct PublicWebhookConfig {
    url_masked: String,
    format: super::WebhookFormat,
    has_signing_secret: bool,
    headers: Vec<PublicWebhookHeader>,
}

#[derive(Serialize)]
struct PublicWebhookHeader {
    name: String,
    has_value: bool,
}

#[derive(Serialize)]
struct RuleView {
    id: i64,
    name: String,
    enabled: bool,
    channel_ids: Vec<i64>,
    #[serde(flatten)]
    config: RuleConfig,
    next_run_at_ms: i64,
    last_window_end_ms: Option<i64>,
    created_at_ms: i64,
    updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    alert_state: Option<AlertStateView>,
}

#[derive(Default, Deserialize)]
struct TestChannelRequest {
    #[serde(default)]
    locale: NotificationLocale,
}

pub async fn handle(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    match dispatch(req, state).await {
        Ok(response) => response,
        Err(error) => error.response(),
    }
}

async fn dispatch(
    req: Request<Incoming>,
    state: SharedState,
) -> Result<HttpResponse, NotificationError> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    match (method.clone(), path.as_str()) {
        (Method::GET, "/api/v1/notifications/summary") => summary(&state).await,
        (Method::GET, "/api/v1/notifications/channels") => list_channels(&state).await,
        (Method::POST, "/api/v1/notifications/channels") => create_channel(req, &state).await,
        (Method::GET, "/api/v1/notifications/rules") => list_rules(&req, &state).await,
        (Method::POST, "/api/v1/notifications/rules") => create_rule(req, &state).await,
        (Method::POST, "/api/v1/notifications/schedule-preview") => {
            schedule_preview(req, &state).await
        }
        (Method::GET, "/api/v1/notifications/deliveries") => list_deliveries(&req, &state).await,
        _ => {
            if let Some(id) = parse_i64_resource(&path, "/api/v1/notifications/channels/", "") {
                return match method {
                    Method::GET => get_channel(id, &state).await,
                    Method::PATCH => update_channel(id, req, &state).await,
                    Method::DELETE => delete_channel(id, &state).await,
                    _ => method_not_allowed(),
                };
            }
            if let Some(id) = parse_i64_resource(&path, "/api/v1/notifications/channels/", "/test")
            {
                return if method == Method::POST {
                    test_channel(id, req, &state).await
                } else {
                    method_not_allowed()
                };
            }
            if let Some(id) = parse_i64_resource(&path, "/api/v1/notifications/rules/", "") {
                return match method {
                    Method::GET => get_rule(id, &state).await,
                    Method::PATCH => update_rule(id, req, &state).await,
                    Method::DELETE => delete_rule(id, &state).await,
                    _ => method_not_allowed(),
                };
            }
            if let Some(id) = parse_i64_resource(&path, "/api/v1/notifications/rules/", "/run") {
                return if method == Method::POST {
                    run_rule(id, &state).await
                } else {
                    method_not_allowed()
                };
            }
            if let Some(id) =
                parse_string_resource(&path, "/api/v1/notifications/deliveries/", "/retry")
            {
                return if method == Method::POST {
                    retry_delivery(&id, &state).await
                } else {
                    method_not_allowed()
                };
            }
            if let Some(id) = parse_string_resource(&path, "/api/v1/notifications/deliveries/", "")
            {
                return if method == Method::GET {
                    get_delivery(&id, &state).await
                } else {
                    method_not_allowed()
                };
            }
            Err(NotificationError::not_found(
                "notification endpoint not found",
            ))
        }
    }
}

async fn summary(state: &SharedState) -> Result<HttpResponse, NotificationError> {
    let (enabled_channels, enabled_rules, firing_alerts, failed_deliveries_24h) =
        state.db.notification_summary(util::now_ms()).await?;
    Ok(http::json(
        StatusCode::OK,
        &SummaryResponse {
            enabled_channels,
            enabled_rules,
            firing_alerts,
            failed_deliveries_24h,
        },
    ))
}

async fn list_channels(state: &SharedState) -> Result<HttpResponse, NotificationError> {
    let records = state.db.notification_list_channels().await?;
    let mut items = Vec::with_capacity(records.len());
    for record in records {
        items.push(channel_view(record, state)?);
    }
    Ok(http::json(StatusCode::OK, &ListResponse { items }))
}

async fn get_channel(id: i64, state: &SharedState) -> Result<HttpResponse, NotificationError> {
    let record = get_channel_record(id, state).await?;
    Ok(http::json(StatusCode::OK, &channel_view(record, state)?))
}

async fn create_channel(
    req: Request<Incoming>,
    state: &SharedState,
) -> Result<HttpResponse, NotificationError> {
    let mut body = read_json::<CreateChannelRequest>(req, state.config.max_request_bytes).await?;
    let name = validated_name(&body.name)?;
    let generated_signing_secret = ensure_create_secret(&mut body.config);
    validate_channel_config(&body.config)?;
    let config_enc = encrypt_channel_config(&body.config, state)?;
    let now_ms = util::now_ms();
    let id = state
        .db
        .notification_insert_channel(
            &name,
            body.config.kind().as_str(),
            body.enabled,
            &config_enc,
            now_ms,
        )
        .await?;
    state.notifications.wake();
    let record = get_channel_record(id, state).await?;
    Ok(http::json(
        StatusCode::CREATED,
        &CreatedChannelResponse {
            channel: channel_view(record, state)?,
            generated_signing_secret,
        },
    ))
}

async fn update_channel(
    id: i64,
    req: Request<Incoming>,
    state: &SharedState,
) -> Result<HttpResponse, NotificationError> {
    let body = read_json::<UpdateChannelRequest>(req, state.config.max_request_bytes).await?;
    let current = get_channel_record(id, state).await?;
    let current_config = decrypt_channel_config(&current.config_enc, state)?;
    let name = match body.name {
        Some(name) => validated_name(&name)?,
        None => current.name.clone(),
    };
    let enabled = body.enabled.unwrap_or(current.enabled);
    let config = match body.config {
        Some(config) => merge_channel_secrets(config, &current_config)?,
        None => current_config,
    };
    if config.kind().as_str() != current.kind {
        return Err(NotificationError::conflict(
            "channel_kind_immutable",
            "notification channel kind cannot be changed",
        ));
    }
    validate_channel_config(&config)?;
    let config_enc = encrypt_channel_config(&config, state)?;
    state
        .db
        .notification_update_channel(id, &name, enabled, &config_enc, util::now_ms())
        .await?;
    state.notifications.wake();
    let record = get_channel_record(id, state).await?;
    Ok(http::json(StatusCode::OK, &channel_view(record, state)?))
}

async fn delete_channel(id: i64, state: &SharedState) -> Result<HttpResponse, NotificationError> {
    match state.db.notification_delete_channel(id).await {
        Ok(true) => {
            state.notifications.wake();
            Ok(http::empty(StatusCode::NO_CONTENT))
        }
        Ok(false) => Err(NotificationError::not_found(
            "notification channel not found",
        )),
        Err(error) if error.to_string().contains("channel_in_use") => {
            Err(NotificationError::conflict(
                "channel_in_use",
                "notification channel is referenced by one or more rules",
            ))
        }
        Err(error) => Err(error.into()),
    }
}

async fn test_channel(
    id: i64,
    req: Request<Incoming>,
    state: &SharedState,
) -> Result<HttpResponse, NotificationError> {
    let body = read_optional_json::<TestChannelRequest>(req, state.config.max_request_bytes)
        .await?
        .unwrap_or_default();
    let run_id = enqueue_channel_test(state, id, body.locale).await?;
    Ok(http::json(
        StatusCode::ACCEPTED,
        &EnqueuedResponse { run_id },
    ))
}

async fn list_rules(
    req: &Request<Incoming>,
    state: &SharedState,
) -> Result<HttpResponse, NotificationError> {
    let kind = query_string(req.uri().query(), "kind");
    if kind
        .as_deref()
        .is_some_and(|kind| !matches!(kind, "scheduled_report" | "threshold_alert"))
    {
        return Err(NotificationError::bad_request(
            "invalid_rule_kind",
            "kind must be scheduled_report or threshold_alert",
            Some("kind"),
        ));
    }
    let records = state.db.notification_list_rules().await?;
    let mut items = Vec::with_capacity(records.len());
    for record in records
        .into_iter()
        .filter(|record| kind.as_deref().is_none_or(|kind| record.kind == kind))
    {
        items.push(rule_view(record, state).await?);
    }
    Ok(http::json(StatusCode::OK, &ListResponse { items }))
}

async fn get_rule(id: i64, state: &SharedState) -> Result<HttpResponse, NotificationError> {
    let record = get_rule_record(id, state).await?;
    Ok(http::json(StatusCode::OK, &rule_view(record, state).await?))
}

async fn create_rule(
    req: Request<Incoming>,
    state: &SharedState,
) -> Result<HttpResponse, NotificationError> {
    let body = read_json::<CreateRuleRequest>(req, state.config.max_request_bytes).await?;
    let name = validated_name(&body.name)?;
    let channel_ids = validate_channel_ids(&body.channel_ids, state).await?;
    validate_rule_config(&body.config)?;
    validate_rule_scope(&body.config, state).await?;
    let now_ms = util::now_ms();
    let next_run_at_ms = initial_next_run(&body.config, now_ms)?;
    let config_json = encode_json(&body.config)?;
    let id = state
        .db
        .notification_insert_rule(
            &name,
            body.config.kind().as_str(),
            body.enabled,
            &config_json,
            next_run_at_ms,
            &channel_ids,
            now_ms,
        )
        .await?;
    state.notifications.wake();
    let record = get_rule_record(id, state).await?;
    Ok(http::json(
        StatusCode::CREATED,
        &rule_view(record, state).await?,
    ))
}

async fn update_rule(
    id: i64,
    req: Request<Incoming>,
    state: &SharedState,
) -> Result<HttpResponse, NotificationError> {
    let body = read_json::<UpdateRuleRequest>(req, state.config.max_request_bytes).await?;
    let current = get_rule_record(id, state).await?;
    let current_config = decode_rule_config(&current.config_json)?;
    let config = body.config.unwrap_or(current_config);
    if config.kind().as_str() != current.kind {
        return Err(NotificationError::conflict(
            "rule_kind_immutable",
            "notification rule kind cannot be changed",
        ));
    }
    validate_rule_config(&config)?;
    validate_rule_scope(&config, state).await?;
    let channel_ids = match body.channel_ids {
        Some(channel_ids) => validate_channel_ids(&channel_ids, state).await?,
        None => state.db.notification_rule_channel_ids(id).await?,
    };
    let name = match body.name {
        Some(name) => validated_name(&name)?,
        None => current.name,
    };
    let enabled = body.enabled.unwrap_or(current.enabled);
    let now_ms = util::now_ms();
    let next_run_at_ms = initial_next_run(&config, now_ms)?;
    let config_json = encode_json(&config)?;
    state
        .db
        .notification_update_rule(
            id,
            &name,
            enabled,
            &config_json,
            next_run_at_ms,
            &channel_ids,
            now_ms,
        )
        .await?;
    state.notifications.wake();
    let record = get_rule_record(id, state).await?;
    Ok(http::json(StatusCode::OK, &rule_view(record, state).await?))
}

async fn delete_rule(id: i64, state: &SharedState) -> Result<HttpResponse, NotificationError> {
    if !state.db.notification_delete_rule(id).await? {
        return Err(NotificationError::not_found("notification rule not found"));
    }
    state.notifications.wake();
    Ok(http::empty(StatusCode::NO_CONTENT))
}

async fn run_rule(id: i64, state: &SharedState) -> Result<HttpResponse, NotificationError> {
    let rule = get_rule_record(id, state).await?;
    let run_id = enqueue_rule_run(state, &rule).await?;
    Ok(http::json(
        StatusCode::ACCEPTED,
        &EnqueuedResponse { run_id },
    ))
}

async fn schedule_preview(
    req: Request<Incoming>,
    state: &SharedState,
) -> Result<HttpResponse, NotificationError> {
    let body = read_json::<SchedulePreviewRequest>(req, state.config.max_request_bytes).await?;
    let occurrences_ms = next_occurrences(
        &body.cron,
        &body.timezone,
        util::now_ms(),
        SCHEDULE_PREVIEW_COUNT,
    )?;
    Ok(http::json(
        StatusCode::OK,
        &SchedulePreviewResponse {
            cron: body.cron.trim().to_string(),
            timezone: body.timezone.trim().to_string(),
            occurrences_ms,
        },
    ))
}

async fn list_deliveries(
    req: &Request<Incoming>,
    state: &SharedState,
) -> Result<HttpResponse, NotificationError> {
    let offset = query_i64(req.uri().query(), "offset").unwrap_or(0).max(0);
    let limit = query_i64(req.uri().query(), "limit")
        .unwrap_or(DEFAULT_DELIVERY_LIMIT)
        .clamp(1, MAX_DELIVERY_LIMIT);
    let status = query_string(req.uri().query(), "status");
    if status.as_deref().is_some_and(|status| {
        !matches!(
            status,
            "pending" | "sending" | "succeeded" | "failed" | "skipped"
        )
    }) {
        return Err(NotificationError::bad_request(
            "invalid_delivery_status",
            "status is not a supported delivery state",
            Some("status"),
        ));
    }
    let rule_id = query_i64(req.uri().query(), "rule_id");
    let items = state
        .db
        .notification_list_deliveries(offset, limit, status.as_deref(), rule_id)
        .await?;
    Ok(http::json(
        StatusCode::OK,
        &DeliveryListResponse {
            items,
            offset,
            limit,
        },
    ))
}

async fn get_delivery(id: &str, state: &SharedState) -> Result<HttpResponse, NotificationError> {
    let detail = state
        .db
        .notification_get_delivery_detail(id)
        .await?
        .ok_or_else(|| NotificationError::not_found("notification delivery not found"))?;
    let event_payload = serde_json::from_str(&detail.event_payload_json)?;
    Ok(http::json(
        StatusCode::OK,
        &DeliveryDetailResponse {
            delivery: detail.delivery,
            last_http_status: detail.last_http_status,
            last_request_body: detail.last_request_body,
            last_response_body: detail.last_response_body,
            event_payload,
        },
    ))
}

async fn retry_delivery(id: &str, state: &SharedState) -> Result<HttpResponse, NotificationError> {
    let delivery = state
        .db
        .notification_get_delivery(id)
        .await?
        .ok_or_else(|| NotificationError::not_found("notification delivery not found"))?;
    if delivery.status != "failed" {
        return Err(NotificationError::conflict(
            "delivery_not_retryable",
            "only failed deliveries can be retried",
        ));
    }
    if !state
        .db
        .notification_retry_delivery(id, util::now_ms())
        .await?
    {
        return Err(NotificationError::conflict(
            "delivery_retry_conflict",
            "delivery state changed before retry",
        ));
    }
    state.notifications.wake();
    let delivery = state
        .db
        .notification_get_delivery(id)
        .await?
        .ok_or_else(|| NotificationError::not_found("notification delivery not found"))?;
    Ok(http::json(StatusCode::ACCEPTED, &delivery))
}

async fn get_channel_record(
    id: i64,
    state: &SharedState,
) -> Result<ChannelRecord, NotificationError> {
    state
        .db
        .notification_get_channel(id)
        .await?
        .ok_or_else(|| NotificationError::not_found("notification channel not found"))
}

async fn get_rule_record(id: i64, state: &SharedState) -> Result<RuleRecord, NotificationError> {
    state
        .db
        .notification_get_rule(id)
        .await?
        .ok_or_else(|| NotificationError::not_found("notification rule not found"))
}

fn channel_view(
    record: ChannelRecord,
    state: &SharedState,
) -> Result<ChannelView, NotificationError> {
    let config = decrypt_channel_config(&record.config_enc, state)?;
    let config = match config {
        ChannelConfig::Smtp(config) => PublicChannelConfig::Smtp(PublicSmtpConfig {
            host: config.host,
            port: config.port,
            security: config.security,
            username: config.username,
            has_password: config.password.is_some(),
            from_name: config.from_name,
            from_email: config.from_email,
            recipients: config.recipients,
        }),
        ChannelConfig::Webhook(config) => PublicChannelConfig::Webhook(PublicWebhookConfig {
            url_masked: mask_webhook_url(&config.url),
            format: config.format,
            has_signing_secret: !config.signing_secret.is_empty(),
            headers: config
                .headers
                .into_iter()
                .map(|header| PublicWebhookHeader {
                    name: header.name,
                    has_value: !header.value.is_empty(),
                })
                .collect(),
        }),
    };
    Ok(ChannelView {
        id: record.id,
        name: record.name,
        enabled: record.enabled,
        config,
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
    })
}

async fn rule_view(record: RuleRecord, state: &SharedState) -> Result<RuleView, NotificationError> {
    let channel_ids = state.db.notification_rule_channel_ids(record.id).await?;
    let config = decode_rule_config(&record.config_json)?;
    let alert_state = if matches!(&config, RuleConfig::ThresholdAlert(_)) {
        state
            .db
            .notification_get_alert_state(record.id)
            .await?
            .map(|alert| AlertStateView {
                state: alert.state,
                breach_count: alert.breach_count,
                recovery_count: alert.recovery_count,
                opened_at_ms: alert.opened_at_ms,
                last_notified_at_ms: alert.last_notified_at_ms,
            })
    } else {
        None
    };
    Ok(RuleView {
        id: record.id,
        name: record.name,
        enabled: record.enabled,
        channel_ids,
        config,
        next_run_at_ms: record.next_run_at_ms,
        last_window_end_ms: record.last_window_end_ms,
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
        alert_state,
    })
}

fn encrypt_channel_config(
    config: &ChannelConfig,
    state: &SharedState,
) -> Result<String, NotificationError> {
    let plaintext = serde_json::to_string(config)?;
    crypto::encrypt_secret(&state.config.master_key, &plaintext).map_err(|_| {
        NotificationError::internal("failed to encrypt notification channel configuration")
    })
}

fn decrypt_channel_config(
    encrypted: &str,
    state: &SharedState,
) -> Result<ChannelConfig, NotificationError> {
    let plaintext = crypto::decrypt_secret(&state.config.master_key, encrypted).map_err(|_| {
        NotificationError::internal("failed to decrypt notification channel configuration")
    })?;
    serde_json::from_str(&plaintext)
        .map_err(|_| NotificationError::internal("notification channel configuration is invalid"))
}

fn ensure_create_secret(config: &mut ChannelConfig) -> Option<String> {
    let ChannelConfig::Webhook(config) = config else {
        return None;
    };
    if config.format != super::WebhookFormat::Generic || !config.signing_secret.trim().is_empty() {
        return None;
    }
    let secret = format!("{}{}", util::new_ulid(), util::new_ulid());
    config.signing_secret.clone_from(&secret);
    Some(secret)
}

fn merge_channel_secrets(
    incoming: ChannelConfig,
    existing: &ChannelConfig,
) -> Result<ChannelConfig, NotificationError> {
    match (incoming, existing) {
        (ChannelConfig::Smtp(mut incoming), ChannelConfig::Smtp(existing)) => {
            if incoming.password.is_none() && incoming.username == existing.username {
                incoming.password.clone_from(&existing.password);
            }
            Ok(ChannelConfig::Smtp(incoming))
        }
        (ChannelConfig::Webhook(mut incoming), ChannelConfig::Webhook(existing)) => {
            if incoming.url.trim().is_empty() {
                incoming.url.clone_from(&existing.url);
            }
            if incoming.format == existing.format && incoming.signing_secret.trim().is_empty() {
                incoming.signing_secret.clone_from(&existing.signing_secret);
            }
            for header in &mut incoming.headers {
                if header.value.is_empty()
                    && let Some(existing_header) = existing
                        .headers
                        .iter()
                        .find(|candidate| candidate.name.eq_ignore_ascii_case(&header.name))
                {
                    header.value.clone_from(&existing_header.value);
                }
            }
            Ok(ChannelConfig::Webhook(incoming))
        }
        _ => Err(NotificationError::conflict(
            "channel_kind_immutable",
            "notification channel kind cannot be changed",
        )),
    }
}

fn mask_webhook_url(raw: &str) -> String {
    let Ok(uri) = raw.parse::<hyper::Uri>() else {
        return "••••••".to_string();
    };
    let (Some(scheme), Some(authority)) = (uri.scheme_str(), uri.authority()) else {
        return "••••••".to_string();
    };
    let suffix = if uri
        .path_and_query()
        .is_none_or(|value| value.as_str() == "/")
    {
        String::new()
    } else {
        "/…".to_string()
    };
    format!("{scheme}://{authority}{suffix}")
}

fn initial_next_run(config: &RuleConfig, now_ms: i64) -> Result<i64, NotificationError> {
    match config {
        RuleConfig::ScheduledReport(config) => {
            next_occurrences(&config.cron, &config.timezone, now_ms, 1)?
                .into_iter()
                .next()
                .ok_or_else(|| {
                    NotificationError::bad_request(
                        "cron_has_no_next_occurrence",
                        "cron expression has no future occurrence",
                        Some("cron"),
                    )
                })
        }
        RuleConfig::ThresholdAlert(_) => Ok(now_ms),
    }
}

async fn validate_channel_ids(
    channel_ids: &[i64],
    state: &SharedState,
) -> Result<Vec<i64>, NotificationError> {
    if channel_ids.is_empty() {
        return Err(NotificationError::bad_request(
            "missing_channels",
            "at least one notification channel is required",
            Some("channel_ids"),
        ));
    }
    let mut unique = channel_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    for id in &unique {
        if *id <= 0 || state.db.notification_get_channel(*id).await?.is_none() {
            return Err(NotificationError::bad_request(
                "invalid_channel_id",
                format!("notification channel {id} does not exist"),
                Some("channel_ids"),
            ));
        }
    }
    Ok(unique)
}

async fn validate_rule_scope(
    config: &RuleConfig,
    state: &SharedState,
) -> Result<(), NotificationError> {
    let RuleConfig::ThresholdAlert(config) = config else {
        return Ok(());
    };
    let Some(scope_id) = config.scope_id else {
        return Ok(());
    };
    let exists = match config.scope_kind {
        super::AlertScopeKind::Global => true,
        super::AlertScopeKind::Provider => state
            .db
            .list_upstream_providers()
            .await?
            .iter()
            .any(|provider| provider.id == scope_id),
        super::AlertScopeKind::ClientKey => state
            .db
            .list_api_keys()
            .await?
            .iter()
            .any(|key| key.id == scope_id),
    };
    if !exists {
        return Err(NotificationError::bad_request(
            "scope_not_found",
            format!("notification alert scope {scope_id} does not exist"),
            Some("scope_id"),
        ));
    }
    Ok(())
}

fn validated_name(name: &str) -> Result<String, NotificationError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(NotificationError::bad_request(
            "invalid_name",
            "name must contain between 1 and 100 characters",
            Some("name"),
        ));
    }
    Ok(name.to_string())
}

async fn read_json<T: DeserializeOwned>(
    req: Request<Incoming>,
    max_bytes: usize,
) -> Result<T, NotificationError> {
    read_optional_json(req, max_bytes).await?.ok_or_else(|| {
        NotificationError::bad_request("missing_json_body", "JSON request body is required", None)
    })
}

async fn read_optional_json<T: DeserializeOwned>(
    req: Request<Incoming>,
    max_bytes: usize,
) -> Result<Option<T>, NotificationError> {
    let (_, body) = req.into_parts();
    let collected =
        Limited::new(body, max_bytes)
            .collect()
            .await
            .map_err(|_| NotificationError {
                status: StatusCode::PAYLOAD_TOO_LARGE,
                code: "request_body_too_large",
                message: "request body exceeds the configured limit".to_string(),
                field: None,
            })?;
    let bytes = collected.to_bytes();
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        NotificationError::bad_request("invalid_json", format!("invalid JSON: {error}"), None)
    })
}

fn parse_i64_resource(path: &str, prefix: &str, suffix: &str) -> Option<i64> {
    parse_string_resource(path, prefix, suffix)?.parse().ok()
}

fn parse_string_resource(path: &str, prefix: &str, suffix: &str) -> Option<String> {
    let value = path.strip_prefix(prefix)?.strip_suffix(suffix)?;
    if value.is_empty() || value.contains('/') {
        return None;
    }
    Some(value.to_string())
}

fn query_i64(query: Option<&str>, key: &str) -> Option<i64> {
    query_string(query, key)?.parse().ok()
}

fn query_string(query: Option<&str>, key: &str) -> Option<String> {
    query?
        .split('&')
        .filter_map(|part| part.split_once('='))
        .find_map(|(candidate, value)| (candidate == key).then(|| value.trim().to_string()))
        .filter(|value| !value.is_empty())
}

fn method_not_allowed<T>() -> Result<T, NotificationError> {
    Err(NotificationError {
        status: StatusCode::METHOD_NOT_ALLOWED,
        code: "method_not_allowed",
        message: "method not allowed for notification endpoint".to_string(),
        field: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_channel_view_never_serializes_secrets() {
        let view = ChannelView {
            id: 1,
            name: "mail".to_string(),
            enabled: true,
            config: PublicChannelConfig::Smtp(PublicSmtpConfig {
                host: "smtp.example.com".to_string(),
                port: 587,
                security: super::super::SmtpSecurity::Starttls,
                username: Some("operator".to_string()),
                has_password: true,
                from_name: None,
                from_email: "ops@example.com".to_string(),
                recipients: vec!["team@example.com".to_string()],
            }),
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        let json = serde_json::to_string(&view).expect("serialize public channel");
        assert!(!json.contains("\"password\":"));
        assert!(!json.contains("\"signing_secret\":"));
    }

    #[test]
    fn missing_webhook_secret_is_generated_once() {
        let mut config = ChannelConfig::Webhook(crate::notification::WebhookChannelConfig {
            url: "https://example.com/hook".to_string(),
            format: crate::notification::WebhookFormat::Generic,
            signing_secret: String::new(),
            headers: Vec::new(),
        });
        let generated = ensure_create_secret(&mut config).expect("generated secret");
        let ChannelConfig::Webhook(config) = config else {
            panic!("webhook config");
        };
        assert_eq!(config.signing_secret, generated);
    }

    #[test]
    fn chat_platform_webhook_does_not_generate_little_gate_secret() {
        let mut config = ChannelConfig::Webhook(crate::notification::WebhookChannelConfig {
            url: "https://open.feishu.cn/open-apis/bot/v2/hook/example".to_string(),
            format: crate::notification::WebhookFormat::Feishu,
            signing_secret: String::new(),
            headers: Vec::new(),
        });

        assert!(ensure_create_secret(&mut config).is_none());
    }

    #[test]
    fn webhook_url_mask_hides_paths_and_queries() {
        let masked = mask_webhook_url("https://hooks.example.com/team/secret?token=private");
        assert_eq!(masked, "https://hooks.example.com/…");
        assert!(!masked.contains("secret"));
        assert!(!masked.contains("private"));
    }
}
