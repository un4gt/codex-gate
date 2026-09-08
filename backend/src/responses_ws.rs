use std::fmt::Display;
use std::time::Instant;

use bytes::{Bytes, BytesMut};
use futures_util::{Sink, SinkExt, StreamExt};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::header::{
    ACCEPT, AUTHORIZATION, CONNECTION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT,
};
use hyper::{Method, Request, Response, StatusCode, Uri};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{
    HeaderName as WsHeaderName, HeaderValue as WsHeaderValue,
};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::affinity::extract_affinity_identity;
use crate::cache::transport_capability::{TransportCapabilityKey, WsCapability};
use crate::http::{self, HttpResponse};
use crate::metrics::RequestMetric;
use crate::pricing::{PricingEvaluation, evaluate_price};
use crate::proxy::{self, ResolvedUpstream};
use crate::request_overrides::RequestOverrideContext;
use crate::state::SharedState;
use crate::telemetry::TelemetryEvent;
use crate::types::{ApiFormat, ApiKeyAuth, Usage};
use crate::upstream_url;
use crate::util;

type UpstreamWs = WebSocketStream<MaybeTlsStream<TcpStream>>;
struct PendingTurnLog {
    permit: Option<mpsc::OwnedPermit<TelemetryEvent>>,
    event: TelemetryEvent,
    pricing: PricingEvaluation,
    succeeded: bool,
}

const UPSTREAM_RESPONSES_PATH: &str = "/responses";
const RESPONSES_WS_BETA: &str = "responses_websockets=2026-02-06";
const BETA_FEATURE_RESPONSES_HTTP_TO_WS: &str = "responses-http-to-ws";

#[derive(Clone)]
struct WsContext {
    state: SharedState,
    api_key: ApiKeyAuth,
    request_headers: HeaderMap,
    request_override_context: RequestOverrideContext,
    session_id: String,
    session_log_id: String,
    session_started_at_ms: i64,
    disconnected_at: tokio::sync::watch::Sender<Option<Instant>>,
    requested_service_tier: Option<String>,
    upstream_service_tier: Option<String>,
    observation: std::sync::Arc<parking_lot::Mutex<crate::response_events::Observation>>,
    pending_turn_log: std::sync::Arc<parking_lot::Mutex<Option<PendingTurnLog>>>,
}

struct ActiveUpstream {
    requested_model: String,
    resolved: ResolvedUpstream,
    transport: ActiveTransport,
    _provider_capacity: Option<crate::provider_runtime::ProviderCapacityPermit>,
}

enum ActiveTransport {
    NativeWs(Box<UpstreamWs>),
    HttpBridge,
}

struct WsBridgeError {
    status: StatusCode,
    error_type: &'static str,
    message: String,
    scope: proxy::FailureScope,
}

#[derive(Clone)]
struct TurnOutcome {
    status: StatusCode,
    error_type: Option<String>,
    error_message: Option<String>,
    t_stream_ms: Option<i64>,
    t_first_byte_ms: Option<i64>,
    t_first_token_ms: Option<i64>,
    duration_ms: i64,
    usage: Usage,
    usage_observed: bool,
    origin: proxy::OutcomeOrigin,
}

#[derive(Clone, Copy)]
enum TurnTransport {
    NativeWs,
    HttpBridge,
    WsSetup,
}

impl TurnTransport {
    fn as_log_value(self) -> &'static str {
        match self {
            Self::NativeWs => "ws_native",
            Self::HttpBridge => "ws_http_bridge",
            Self::WsSetup => "ws_setup",
        }
    }
}

enum NativeWsConnectOutcome {
    Connected(
        Box<UpstreamWs>,
        crate::provider_runtime::ProviderCapacityPermit,
    ),
    Unsupported(WsBridgeError),
    Unavailable(WsBridgeError),
    Failed(WsBridgeError),
}

enum ForwardResult {
    Complete,
    RetryableBeforeEvent(WsBridgeError),
    Fatal,
}

#[derive(Default)]
struct WsProviderBudget {
    attempted_provider_ids: std::collections::HashSet<i64>,
}

impl WsProviderBudget {
    fn seed(&mut self, provider_id: i64) {
        self.attempted_provider_ids.insert(provider_id);
    }

    fn contains(&self, provider_id: i64) -> bool {
        self.attempted_provider_ids.contains(&provider_id)
    }

    fn try_note_attempt(&mut self, provider_id: i64) -> Option<bool> {
        if self.attempted_provider_ids.contains(&provider_id) {
            return Some(false);
        }
        if self.attempted_provider_ids.len() >= proxy::MAX_DISTINCT_PROVIDERS {
            return None;
        }
        let switched = !self.attempted_provider_ids.is_empty();
        self.attempted_provider_ids.insert(provider_id);
        Some(switched)
    }

    fn exhausted(&self) -> bool {
        self.attempted_provider_ids.len() >= proxy::MAX_DISTINCT_PROVIDERS
    }
}

pub async fn handle(mut req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let Some(api_key_plaintext) = http::bearer_token(&req) else {
        record_handshake_metric(
            &state,
            StatusCode::UNAUTHORIZED,
            Some("missing_bearer_token"),
        );
        return http::json_error(StatusCode::UNAUTHORIZED, "missing bearer token");
    };

    let auth = match state
        .caches
        .api_keys
        .validate(
            &state.db,
            &state.config.master_key,
            api_key_plaintext,
            util::now_ms(),
        )
        .await
    {
        Ok(v) => v,
        Err(e) => {
            record_handshake_metric(
                &state,
                StatusCode::INTERNAL_SERVER_ERROR,
                Some("api_key_validate_failed"),
            );
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e);
        }
    };

    let Some(api_key) = auth else {
        record_handshake_metric(&state, StatusCode::UNAUTHORIZED, Some("invalid_api_key"));
        return http::json_error(StatusCode::UNAUTHORIZED, "invalid api key");
    };

    if !has_any_websocket_provider(&state).await {
        return websocket_not_supported();
    }

    let request_headers = req.headers().clone();
    let (response, websocket) = match hyper_tungstenite::upgrade(&mut req, None) {
        Ok(v) => v,
        Err(err) => {
            record_handshake_metric(&state, StatusCode::BAD_REQUEST, Some("invalid_websocket"));
            return http::json_error(StatusCode::BAD_REQUEST, format!("invalid websocket: {err}"));
        }
    };

    let ctx = WsContext {
        state,
        api_key,
        request_headers,
        request_override_context: RequestOverrideContext::new(),
        session_id: util::new_ulid(),
        session_log_id: util::new_ulid(),
        session_started_at_ms: util::now_ms(),
        disconnected_at: tokio::sync::watch::channel(None).0,
        requested_service_tier: None,
        upstream_service_tier: None,
        observation: Default::default(),
        pending_turn_log: Default::default(),
    };
    tokio::spawn(async move {
        serve_websocket(websocket, ctx).await;
    });

    let (parts, _body) = response.into_parts();
    Response::from_parts(parts, http::full(Bytes::new(), None))
}

async fn has_any_websocket_provider(state: &SharedState) -> bool {
    let Ok(snap) = state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
    else {
        return true;
    };

    snap.providers.iter().any(|provider| {
        provider.enabled
            && provider.websocket_enabled
            && snap
                .endpoints_by_provider
                .get(&provider.id)
                .is_some_and(|items| items.iter().any(|endpoint| endpoint.enabled))
            && snap
                .keys_by_provider
                .get(&provider.id)
                .is_some_and(|items| items.iter().any(|key| key.enabled))
    })
}

fn websocket_not_supported() -> HttpResponse {
    let mut response = http::json_error(
        StatusCode::UPGRADE_REQUIRED,
        "websocket transport is not supported by any enabled upstream",
    );
    response
        .headers_mut()
        .insert(CONNECTION, HeaderValue::from_static("close"));
    response
}

fn record_handshake_metric(
    state: &SharedState,
    status: StatusCode,
    error_type: Option<&'static str>,
) {
    state.metrics.record_request(
        ApiFormat::Responses,
        RequestMetric {
            http_status: Some(status.as_u16() as i32),
            error_type,
            duration_ms: Some(0),
            usage: Usage::default(),
            pricing: PricingEvaluation::usage_missing(),
        },
    );
}

async fn serve_websocket(websocket: hyper_tungstenite::HyperWebsocket, ctx: WsContext) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _inflight = ctx.state.metrics.inflight_guard();
    let downstream = match websocket.await {
        Ok(ws) => ws,
        Err(err) => {
            log::warn!("responses websocket upgrade failed: {err}");
            return;
        }
    };

    let (mut downstream, mut reader) = downstream.split();
    let (sender, mut messages) = mpsc::channel(8);
    let disconnected = ctx.disconnected_at.clone();
    let reader_task = tokio::spawn(async move {
        while let Some(message) = reader.next().await {
            let closed = matches!(&message, Ok(Message::Close(_)) | Err(_));
            if closed {
                disconnected.send_replace(Some(Instant::now()));
            }
            if sender.send(message).await.is_err() || closed {
                break;
            }
        }
        if disconnected.borrow().is_none() {
            disconnected.send_replace(Some(Instant::now()));
        }
    });
    record_session_open(&ctx);
    let mut active: Option<ActiveUpstream> = None;
    let mut close_status = StatusCode::OK;
    let mut close_error_type: Option<String> = None;
    let mut close_error_message: Option<String> = None;
    while let Some(message) = messages.recv().await {
        let message = match message {
            Ok(message) => message,
            Err(err) => {
                log::warn!("responses websocket downstream read failed: {err}");
                close_status = StatusCode::BAD_REQUEST;
                close_error_type = Some("downstream_websocket_read_error".to_string());
                close_error_message = Some(err.to_string());
                break;
            }
        };

        match message {
            Message::Text(text) => {
                let text = text.to_string();
                let value = match serde_json::from_str::<Value>(&text) {
                    Ok(value) => value,
                    Err(err) => {
                        let _ = send_ws_error(
                            &mut downstream,
                            StatusCode::BAD_REQUEST,
                            "invalid_json",
                            &format!("invalid websocket JSON: {err}"),
                        )
                        .await;
                        continue;
                    }
                };

                let mut ctx = ctx.clone();
                ctx.requested_service_tier = crate::response_events::service_tier(&value);
                let Some(event_type) = value.get("type").and_then(Value::as_str) else {
                    let _ = send_ws_error(
                        &mut downstream,
                        StatusCode::BAD_REQUEST,
                        "missing_type",
                        "websocket event is missing type",
                    )
                    .await;
                    continue;
                };

                if event_type != "response.create" {
                    if let Some(active) = active.as_mut() {
                        match &mut active.transport {
                            ActiveTransport::NativeWs(ws) => {
                                if let Ok(serialized) = serde_json::to_string(&value)
                                    && ws.send(Message::Text(serialized.into())).await.is_err()
                                {
                                    close_status = StatusCode::BAD_GATEWAY;
                                    close_error_type =
                                        Some("upstream_websocket_write_error".to_string());
                                    close_error_message = Some(
                                        "failed to send non-create websocket event upstream"
                                            .to_string(),
                                    );
                                    break;
                                }
                            }
                            ActiveTransport::HttpBridge => {
                                let message = "HTTP bridge only supports response.create events";
                                let _ = send_ws_error(
                                    &mut downstream,
                                    StatusCode::BAD_REQUEST,
                                    "unsupported_http_bridge_event",
                                    message,
                                )
                                .await;
                                close_status = StatusCode::BAD_REQUEST;
                                close_error_type =
                                    Some("unsupported_http_bridge_event".to_string());
                                close_error_message = Some(message.to_string());
                                break;
                            }
                        }
                    } else {
                        let _ = send_ws_error(
                            &mut downstream,
                            StatusCode::BAD_REQUEST,
                            "upstream_unavailable",
                            "response.create must be sent before other websocket events",
                        )
                        .await;
                        close_status = StatusCode::BAD_REQUEST;
                        close_error_type = Some("upstream_unavailable".to_string());
                        close_error_message = Some(
                            "response.create must be sent before other websocket events"
                                .to_string(),
                        );
                    }
                    continue;
                }

                let turn_start = Instant::now();
                let Some(requested_model) = value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                else {
                    record_ws_setup_failed_turn(
                        &ctx,
                        None,
                        StatusCode::BAD_REQUEST,
                        "missing_model",
                        "response.create is missing model",
                        turn_start,
                    );
                    let _ = send_ws_error(
                        &mut downstream,
                        StatusCode::BAD_REQUEST,
                        "missing_model",
                        "response.create is missing model",
                    )
                    .await;
                    continue;
                };

                let mut provider_budget = WsProviderBudget::default();
                if let Some(selected) = active.as_ref() {
                    provider_budget.seed(selected.resolved.provider.id);
                }
                if active.is_none() {
                    match connect_selected_upstream(&ctx, &requested_model, &mut provider_budget)
                        .await
                    {
                        Ok(upstream) => active = Some(upstream),
                        Err(err) => {
                            record_ws_setup_failed_turn(
                                &ctx,
                                Some(&requested_model),
                                err.status,
                                err.error_type,
                                &err.message,
                                turn_start,
                            );
                            let _ = send_ws_error(
                                &mut downstream,
                                err.status,
                                err.error_type,
                                &err.message,
                            )
                            .await;
                            close_status = err.status;
                            close_error_type = Some(err.error_type.to_string());
                            close_error_message = Some(err.message);
                            break;
                        }
                    }
                }

                let Some(selected) = active.as_ref() else {
                    break;
                };
                if selected.requested_model != requested_model {
                    let message =
                        "a responses websocket connection can only serve one routed model";
                    record_ws_setup_failed_turn(
                        &ctx,
                        Some(&requested_model),
                        StatusCode::BAD_REQUEST,
                        "model_changed",
                        message,
                        turn_start,
                    );
                    let _ = send_ws_error(
                        &mut downstream,
                        StatusCode::BAD_REQUEST,
                        "model_changed",
                        message,
                    )
                    .await;
                    close_status = StatusCode::BAD_REQUEST;
                    close_error_type = Some("model_changed".to_string());
                    close_error_message = Some(message.to_string());
                    break;
                }

                let original_value = value;
                let mut turn_complete = false;
                let mut turn_ctx = ctx.clone();
                turn_ctx.requested_service_tier =
                    crate::response_events::service_tier(&original_value);
                turn_ctx.pending_turn_log = Default::default();
                while active.is_some() {
                    if let Some(selected) = active.as_mut()
                        && let Err(message) = refresh_active_upstream(&ctx, selected).await
                    {
                        turn_ctx.pending_turn_log.lock().take();
                        record_ws_setup_failed_turn(
                            &ctx,
                            Some(&requested_model),
                            StatusCode::SERVICE_UNAVAILABLE,
                            "upstream_target_changed",
                            &message,
                            turn_start,
                        );
                        let _ = send_ws_error(
                            &mut downstream,
                            StatusCode::SERVICE_UNAVAILABLE,
                            "upstream_target_changed",
                            &message,
                        )
                        .await;
                        break;
                    }
                    let Some(selected) = active.as_ref() else {
                        break;
                    };
                    let mut routed_value = original_value.clone();
                    normalize_response_create(&mut routed_value, &selected.resolved.upstream_model);
                    if selected.resolved.provider.provider_type == crate::codex_oauth::PROVIDER_TYPE
                    {
                        crate::codex_oauth::normalize_response_create_value(
                            &mut routed_value,
                            &selected.resolved.upstream_model,
                        );
                    }
                    if let Err(error) = selected
                        .resolved
                        .provider
                        .request_overrides
                        .apply_body_value(
                            &mut routed_value,
                            ApiFormat::Responses,
                            &ctx.request_override_context,
                        )
                    {
                        let message =
                            format!("failed to apply provider request body overrides: {error}");
                        turn_ctx.pending_turn_log.lock().take();
                        record_ws_setup_failed_turn(
                            &ctx,
                            Some(&requested_model),
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "request_override_failed",
                            &message,
                            turn_start,
                        );
                        let _ = send_ws_error(
                            &mut downstream,
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "request_override_failed",
                            &message,
                        )
                        .await;
                        break;
                    }
                    if selected.resolved.provider.provider_type == crate::codex_oauth::PROVIDER_TYPE
                        && routed_value.get("service_tier").and_then(Value::as_str) == Some("fast")
                    {
                        routed_value["service_tier"] = Value::String("priority".into());
                    }
                    let payload = match serde_json::to_string(&routed_value) {
                        Ok(payload) => payload,
                        Err(err) => {
                            let message = format!("failed to encode websocket payload: {err}");
                            turn_ctx.pending_turn_log.lock().take();
                            record_ws_setup_failed_turn(
                                &ctx,
                                Some(&requested_model),
                                StatusCode::BAD_REQUEST,
                                "invalid_payload",
                                &message,
                                turn_start,
                            );
                            let _ = send_ws_error(
                                &mut downstream,
                                StatusCode::BAD_REQUEST,
                                "invalid_payload",
                                &message,
                            )
                            .await;
                            break;
                        }
                    };

                    let Some(active_upstream) = active.as_mut() else {
                        break;
                    };
                    turn_ctx.upstream_service_tier =
                        crate::response_events::service_tier(&routed_value);
                    turn_ctx.observation = Default::default();
                    let result = forward_response_create(
                        &turn_ctx,
                        &mut downstream,
                        active_upstream,
                        payload,
                    )
                    .await;
                    match result {
                        ForwardResult::Complete => {
                            turn_complete = true;
                            break;
                        }
                        ForwardResult::Fatal => break,
                        ForwardResult::RetryableBeforeEvent(err) => {
                            if ctx.disconnected_at.borrow().is_some() {
                                break;
                            }
                            let failed_provider_id = active
                                .as_ref()
                                .map(|item| item.resolved.provider.id)
                                .unwrap_or_default();
                            provider_budget.seed(failed_provider_id);
                            active = None;
                            if provider_budget.exhausted() {
                                let _ = send_ws_error(
                                    &mut downstream,
                                    err.status,
                                    err.error_type,
                                    &err.message,
                                )
                                .await;
                                break;
                            }
                            ctx.state
                                .metrics
                                .record_failover(crate::metrics::FailoverKind::Generic);
                            match connect_selected_upstream(
                                &ctx,
                                &requested_model,
                                &mut provider_budget,
                            )
                            .await
                            {
                                Ok(upstream) => active = Some(upstream),
                                Err(connect_error) => {
                                    let _ = send_ws_error(
                                        &mut downstream,
                                        connect_error.status,
                                        connect_error.error_type,
                                        &connect_error.message,
                                    )
                                    .await;
                                    break;
                                }
                            }
                        }
                    }
                }
                if let Some(mut pending) = turn_ctx.pending_turn_log.lock().take() {
                    pending.event.duration_ms = Some(
                        (turn_start.elapsed().as_millis() as i64)
                            .saturating_sub(
                                ctx.disconnected_at
                                    .borrow()
                                    .map_or(0, |at| at.elapsed().as_millis() as i64),
                            )
                            .max(0),
                    );
                    ctx.state.metrics.record_request(
                        ApiFormat::Responses,
                        RequestMetric {
                            http_status: pending.event.http_status,
                            error_type: if pending.succeeded {
                                None
                            } else {
                                pending.event.error_type.as_deref()
                            },
                            duration_ms: pending.event.duration_ms,
                            usage: pending.event.usage,
                            pricing: pending.pricing,
                        },
                    );
                    if let Some(permit) = pending.permit {
                        let _ = permit.send(pending.event);
                    }
                }
                if !turn_complete {
                    close_status = StatusCode::BAD_GATEWAY;
                    close_error_type = Some("websocket_turn_failed".to_string());
                    close_error_message = Some("responses websocket turn failed".to_string());
                    break;
                }
            }
            Message::Binary(_) => {
                let _ = send_ws_error(
                    &mut downstream,
                    StatusCode::BAD_REQUEST,
                    "unsupported_message",
                    "binary websocket messages are not supported",
                )
                .await;
            }
            Message::Ping(payload) => {
                if downstream.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            Message::Pong(_) => {}
            Message::Close(frame) => {
                if let Some(active) = active.as_mut()
                    && let ActiveTransport::NativeWs(ws) = &mut active.transport
                {
                    let _ = ws.send(Message::Close(frame.clone())).await;
                }
                let _ = downstream.send(Message::Close(frame)).await;
                break;
            }
            Message::Frame(_) => {}
        }
    }
    reader_task.abort();
    record_session_close(&ctx, close_status, close_error_type, close_error_message);
}

async fn refresh_active_upstream(
    ctx: &WsContext,
    active: &mut ActiveUpstream,
) -> Result<(), String> {
    let snap = ctx
        .state
        .caches
        .upstream
        .get(&ctx.state.db, &ctx.state.config.master_key)
        .await?;
    let provider = snap
        .providers
        .iter()
        .find(|provider| provider.id == active.resolved.provider.id)
        .ok_or_else(|| "upstream removed; reconnect required".to_string())?;
    let key = snap
        .keys_by_provider
        .get(&provider.id)
        .and_then(|keys| keys.iter().find(|key| key.id == active.resolved.key.id))
        .ok_or_else(|| "account removed; reconnect required".to_string())?;
    let availability = crate::routing_availability::account(
        &ctx.state,
        &snap,
        provider,
        key,
        Some(&active.resolved.upstream_model),
        active._provider_capacity.is_some(),
    );
    if !availability.available {
        return Err(format!(
            "{}; reconnect required",
            availability.reason.unwrap_or("account unavailable")
        ));
    }
    if !provider.websocket_enabled || !snap.is_model_globally_enabled(&active.requested_model) {
        return Err("websocket or requested model disabled; reconnect required".into());
    }
    // Re-resolve aliases and group authorization without reserving another concurrency slot.
    if !proxy::ws_target_still_routed(
        &snap,
        &ctx.api_key,
        &active.requested_model,
        provider.id,
        &active.resolved.upstream_model,
    ) {
        return Err("model route or provider authorization changed; reconnect required".into());
    }
    let endpoint = snap
        .endpoints_by_provider
        .get(&provider.id)
        .and_then(|endpoints| {
            endpoints
                .iter()
                .find(|endpoint| endpoint.id == active.resolved.endpoint.id && endpoint.enabled)
        })
        .ok_or_else(|| "endpoint disabled; reconnect required".to_string())?;
    if endpoint.base_url != active.resolved.endpoint.base_url {
        return Err("endpoint changed; reconnect required".into());
    }
    active.resolved.provider = provider.clone();
    active.resolved.key = key.clone();
    active.resolved.endpoint = endpoint.clone();
    active.resolved.price = snap.find_price_for_request(
        provider.id,
        &active.requested_model,
        &active.resolved.upstream_model,
    );
    Ok(())
}

async fn connect_selected_upstream(
    ctx: &WsContext,
    requested_model: &str,
    provider_budget: &mut WsProviderBudget,
) -> Result<ActiveUpstream, WsBridgeError> {
    let affinity = extract_affinity_identity(&ctx.request_headers, &[], ctx.api_key.id);
    let existing_affinity_binding = affinity
        .as_ref()
        .and_then(|identity| ctx.state.affinity.lookup(identity, util::now_ms()));
    if affinity.is_some() {
        ctx.state
            .metrics
            .record_affinity_lookup(existing_affinity_binding.is_some());
    }
    let mut plan = proxy::build_upstream_plan(
        &ctx.state,
        ApiFormat::Responses,
        requested_model,
        &ctx.api_key,
        affinity.as_ref(),
        false,
    )
    .await
    .map_err(|error| {
        let status = error.status;
        WsBridgeError {
            status,
            error_type: error.code,
            message: error.message,
            scope: proxy::classify_failure_scope(
                Some(status.as_u16() as i32),
                proxy::OutcomeOrigin::Gateway,
            ),
        }
    })?;
    let affinity_binding = proxy::apply_affinity_to_plan(
        &ctx.state,
        affinity.as_ref(),
        existing_affinity_binding,
        &mut plan,
    );

    let attempts = plan
        .attempts
        .into_iter()
        .filter(|resolved| {
            resolved.provider.websocket_enabled && !provider_budget.contains(resolved.provider.id)
        })
        .collect::<Vec<_>>();

    if attempts.is_empty() {
        return Err(WsBridgeError {
            status: StatusCode::UPGRADE_REQUIRED,
            error_type: "websocket_not_supported",
            message: if provider_budget.exhausted() {
                "websocket provider failover budget exhausted".to_string()
            } else {
                "no websocket-enabled upstream target is available".to_string()
            },
            scope: proxy::FailureScope::Client,
        });
    }

    let mut last_error = None;
    let mut faulted_providers = std::collections::HashSet::new();
    for (index, resolved) in attempts.iter().cloned().enumerate() {
        let already_attempted = provider_budget.contains(resolved.provider.id);
        let Some(switched) = provider_budget.try_note_attempt(resolved.provider.id) else {
            break;
        };
        if !already_attempted {
            ctx.state.metrics.record_provider_selection(switched);
        }
        match connect_or_bridge_upstream(ctx, &resolved).await {
            NativeWsConnectOutcome::Connected(ws, permit) => {
                confirm_ws_affinity(
                    ctx,
                    affinity.as_ref(),
                    affinity_binding,
                    resolved.provider.id,
                    faulted_providers.contains(
                        &affinity_binding
                            .map(|binding| binding.provider_id)
                            .unwrap_or_default(),
                    ),
                );
                return Ok(ActiveUpstream {
                    requested_model: requested_model.to_string(),
                    resolved,
                    transport: ActiveTransport::NativeWs(ws),
                    _provider_capacity: Some(permit),
                });
            }
            NativeWsConnectOutcome::Unsupported(err)
                if provider_has_beta_feature(&resolved, BETA_FEATURE_RESPONSES_HTTP_TO_WS) =>
            {
                log::info!(
                    "responses websocket upstream unsupported for provider={} endpoint={}, using HTTP bridge: {}",
                    resolved.provider.id,
                    resolved.endpoint.id,
                    err.message
                );
                return Ok(ActiveUpstream {
                    requested_model: requested_model.to_string(),
                    resolved,
                    transport: ActiveTransport::HttpBridge,
                    _provider_capacity: None,
                });
            }
            NativeWsConnectOutcome::Unsupported(err) => {
                if index + 1 < attempts.len() {
                    ctx.state
                        .metrics
                        .record_failover(crate::metrics::FailoverKind::Endpoint);
                }
                last_error = Some(err);
            }
            NativeWsConnectOutcome::Unavailable(err) => {
                if index + 1 < attempts.len() {
                    ctx.state
                        .metrics
                        .record_failover(crate::metrics::FailoverKind::Generic);
                }
                last_error = Some(err);
            }
            NativeWsConnectOutcome::Failed(err) => {
                let has_same_provider = attempts[index + 1..]
                    .iter()
                    .any(|attempt| attempt.provider.id == resolved.provider.id);
                if !has_same_provider {
                    if err.scope.should_migrate_affinity() {
                        faulted_providers.insert(resolved.provider.id);
                    }
                    if err.scope.should_avoid_affinity_immediately()
                        && let Some(identity) = affinity.as_ref()
                    {
                        ctx.state.affinity.mark_provider_failed(
                            identity,
                            resolved.provider.id,
                            util::now_ms(),
                            std::time::Duration::from_millis(
                                resolved.provider.circuit_breaker_open_ms.max(1) as u64,
                            ),
                        );
                    }
                }
                if index + 1 < attempts.len() {
                    ctx.state
                        .metrics
                        .record_failover(crate::metrics::FailoverKind::Endpoint);
                }
                last_error = Some(err);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| WsBridgeError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        error_type: "upstream_retry_exhausted",
        message: "no websocket upstream target could be reserved".to_string(),
        scope: proxy::FailureScope::Provider,
    }))
}

fn confirm_ws_affinity(
    ctx: &WsContext,
    identity: Option<&crate::affinity::AffinityIdentity>,
    binding: Option<crate::affinity::AffinityBinding>,
    provider_id: i64,
    migrate: bool,
) {
    let (Some(identity), Some(binding)) = (identity, binding) else {
        return;
    };
    let now_ms = util::now_ms();
    if binding.provider_id == provider_id {
        if binding.confirmed {
            let _ = ctx
                .state
                .affinity
                .refresh_if_provider(identity, provider_id, now_ms);
        } else {
            let _ = ctx.state.affinity.confirm(identity, binding, now_ms);
        }
    } else if migrate {
        ctx.state.affinity.migrate(identity, provider_id, now_ms);
        ctx.state.metrics.record_affinity_migration();
    }
}

async fn connect_or_bridge_upstream(
    ctx: &WsContext,
    resolved: &ResolvedUpstream,
) -> NativeWsConnectOutcome {
    let key = TransportCapabilityKey {
        provider_id: resolved.provider.id,
        endpoint_id: resolved.endpoint.id,
    };
    if ctx
        .state
        .caches
        .transport_capability
        .get(key, util::now_ms())
        == Some(WsCapability::NativeUnsupported)
    {
        return NativeWsConnectOutcome::Unsupported(WsBridgeError {
            status: StatusCode::UPGRADE_REQUIRED,
            error_type: "upstream_websocket_capability_cached",
            message: "upstream websocket is cached as unsupported".to_string(),
            scope: proxy::FailureScope::Client,
        });
    }

    let Ok(reservation) = proxy::reserve_ws_connection(&ctx.state, resolved, util::now_ms()) else {
        return NativeWsConnectOutcome::Unavailable(WsBridgeError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            error_type: "upstream_retry_exhausted",
            message: "websocket upstream target could not be reserved".to_string(),
            scope: proxy::FailureScope::Provider,
        });
    };
    ctx.state.metrics.record_upstream_attempt();

    if ctx
        .state
        .caches
        .transport_capability
        .get(key, util::now_ms())
        == Some(WsCapability::NativeSupported)
    {
        // A recent native-WS success lets this request probe immediately instead of
        // serializing all healthy connects behind the single-flight lock.
        return connect_upstream_ws_once(ctx, resolved, key, reservation).await;
    }

    let probe_lock = ctx.state.caches.transport_capability.probe_lock(key);
    let _probe_guard = probe_lock.lock().await;
    match ctx
        .state
        .caches
        .transport_capability
        .get(key, util::now_ms())
    {
        Some(WsCapability::NativeUnsupported) => {
            reservation.neutral();
            return NativeWsConnectOutcome::Unsupported(WsBridgeError {
                status: StatusCode::UPGRADE_REQUIRED,
                error_type: "upstream_websocket_capability_cached",
                message: "upstream websocket is cached as unsupported".to_string(),
                scope: proxy::FailureScope::Client,
            });
        }
        Some(WsCapability::NativeSupported) => {
            return connect_upstream_ws_once(ctx, resolved, key, reservation).await;
        }
        None => {}
    }

    connect_upstream_ws_once(ctx, resolved, key, reservation).await
}

async fn connect_upstream_ws_once(
    ctx: &WsContext,
    resolved: &ResolvedUpstream,
    key: TransportCapabilityKey,
    reservation: proxy::UpstreamAttemptReservation,
) -> NativeWsConnectOutcome {
    let start = Instant::now();
    let ws_url = match build_upstream_ws_url(&resolved.endpoint.base_url) {
        Ok(ws_url) => ws_url,
        Err(message) => {
            reservation.finish(
                proxy::AttemptOutcome::local_provider(
                    Some(StatusCode::BAD_REQUEST.as_u16() as i32),
                    "invalid_upstream_uri",
                    &message,
                    Some(start.elapsed().as_millis() as i64),
                ),
                &ctx.state.metrics,
            );
            return NativeWsConnectOutcome::Failed(WsBridgeError {
                status: StatusCode::BAD_REQUEST,
                error_type: "invalid_upstream_uri",
                message,
                scope: proxy::FailureScope::Provider,
            });
        }
    };

    let prepared_codex_auth =
        if resolved.provider.provider_type == crate::codex_oauth::PROVIDER_TYPE {
            match ctx
                .state
                .codex_oauth
                .prepare_auth(&ctx.state, resolved.key.id, false)
                .await
            {
                Ok(auth) => Some(auth),
                Err(error) => {
                    reservation.finish(
                        proxy::AttemptOutcome::upstream_response(
                            error.http_status().as_u16() as i32,
                            Some(error.code),
                            Some(&error.message),
                            Some(start.elapsed().as_millis() as i64),
                        ),
                        &ctx.state.metrics,
                    );
                    return NativeWsConnectOutcome::Unavailable(WsBridgeError {
                        status: error.http_status(),
                        error_type: error.code,
                        message: error.message,
                        scope: proxy::FailureScope::Key,
                    });
                }
            }
        } else {
            None
        };
    let upstream_secret = prepared_codex_auth
        .as_ref()
        .map_or(resolved.key.secret.as_str(), |auth| {
            auth.access_token.as_str()
        });
    let mut headers = build_upstream_ws_headers(&ctx.request_headers, upstream_secret);
    if let Some(auth) = prepared_codex_auth.as_ref() {
        crate::codex_oauth::apply_codex_headers(&mut headers, auth);
    }
    if let Err(error) = resolved.provider.request_overrides.apply_headers(
        &mut headers,
        ApiFormat::Responses,
        &ctx.request_override_context,
    ) {
        reservation.neutral();
        return NativeWsConnectOutcome::Failed(WsBridgeError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            error_type: "request_override_failed",
            message: format!("failed to apply provider request header overrides: {error}"),
            scope: proxy::FailureScope::Provider,
        });
    }
    let mut connected = connect_upstream_ws(&ctx.state, &ws_url, &headers).await;
    if connected
        .as_ref()
        .is_err_and(|error| error.status == StatusCode::UNAUTHORIZED)
        && resolved.provider.provider_type == crate::codex_oauth::PROVIDER_TYPE
        && let Ok(refreshed) = ctx
            .state
            .codex_oauth
            .prepare_auth(&ctx.state, resolved.key.id, true)
            .await
    {
        let mut retry_headers =
            build_upstream_ws_headers(&ctx.request_headers, &refreshed.access_token);
        crate::codex_oauth::apply_codex_headers(&mut retry_headers, &refreshed);
        if let Err(error) = resolved.provider.request_overrides.apply_headers(
            &mut retry_headers,
            ApiFormat::Responses,
            &ctx.request_override_context,
        ) {
            reservation.neutral();
            return NativeWsConnectOutcome::Failed(WsBridgeError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                error_type: "request_override_failed",
                message: format!("failed to apply provider request header overrides: {error}"),
                scope: proxy::FailureScope::Provider,
            });
        }
        connected = connect_upstream_ws(&ctx.state, &ws_url, &retry_headers).await;
    }
    if connected
        .as_ref()
        .is_err_and(|error| error.status == StatusCode::UNAUTHORIZED)
        && resolved.provider.provider_type == crate::codex_oauth::PROVIDER_TYPE
    {
        let _ = ctx
            .state
            .db
            .update_codex_auth_status(
                resolved.key.id,
                crate::codex_oauth::AUTH_STATUS_REAUTH_REQUIRED,
                Some("upstream websocket rejected the refreshed access token"),
                util::now_ms(),
            )
            .await;
        ctx.state.caches.upstream.invalidate();
    }
    match connected {
        Ok(ws) => {
            ctx.state
                .caches
                .transport_capability
                .mark_native_supported(key, util::now_ms());
            let Some(capacity) = reservation.into_capacity() else {
                return NativeWsConnectOutcome::Unavailable(WsBridgeError {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    error_type: "provider_capacity_unavailable",
                    message: "websocket provider capacity was released during connect".to_string(),
                    scope: proxy::FailureScope::Provider,
                });
            };
            NativeWsConnectOutcome::Connected(Box::new(ws), capacity)
        }
        Err(err) => {
            if is_deterministic_ws_unsupported(err.status) {
                reservation.neutral();
                ctx.state
                    .caches
                    .transport_capability
                    .mark_native_unsupported(key, util::now_ms());
                NativeWsConnectOutcome::Unsupported(err)
            } else {
                reservation.finish(
                    proxy::AttemptOutcome::upstream_response(
                        err.status.as_u16() as i32,
                        Some(err.error_type),
                        Some(&err.message),
                        Some(start.elapsed().as_millis() as i64),
                    ),
                    &ctx.state.metrics,
                );
                NativeWsConnectOutcome::Failed(err)
            }
        }
    }
}

fn is_deterministic_ws_unsupported(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::NOT_FOUND
            | StatusCode::METHOD_NOT_ALLOWED
            | StatusCode::UPGRADE_REQUIRED
            | StatusCode::NOT_IMPLEMENTED
    )
}

fn provider_has_beta_feature(resolved: &ResolvedUpstream, feature: &str) -> bool {
    resolved
        .provider
        .beta_features
        .iter()
        .any(|item| item == feature)
}

async fn connect_upstream_ws(
    state: &SharedState,
    ws_url: &str,
    headers: &HeaderMap,
) -> Result<UpstreamWs, WsBridgeError> {
    let mut request = ws_url.into_client_request().map_err(|err| WsBridgeError {
        status: StatusCode::BAD_REQUEST,
        error_type: "invalid_upstream_uri",
        message: err.to_string(),
        scope: proxy::FailureScope::Provider,
    })?;
    for (name, value) in headers {
        let name =
            WsHeaderName::from_bytes(name.as_str().as_bytes()).map_err(|err| WsBridgeError {
                status: StatusCode::BAD_REQUEST,
                error_type: "invalid_upstream_header",
                message: err.to_string(),
                scope: proxy::FailureScope::Provider,
            })?;
        let value = WsHeaderValue::from_bytes(value.as_bytes()).map_err(|err| WsBridgeError {
            status: StatusCode::BAD_REQUEST,
            error_type: "invalid_upstream_header",
            message: err.to_string(),
            scope: proxy::FailureScope::Provider,
        })?;
        request.headers_mut().append(name, value);
    }

    let connected = tokio::time::timeout(
        state.config.upstream_connect_timeout,
        connect_async(request),
    )
    .await
    .map_err(|_| WsBridgeError {
        status: StatusCode::GATEWAY_TIMEOUT,
        error_type: "upstream_timeout",
        message: format!(
            "upstream websocket connect timeout after {:?}",
            state.config.upstream_connect_timeout
        ),
        scope: proxy::FailureScope::Provider,
    })?;

    connected
        .map(|(ws, _response)| ws)
        .map_err(map_ws_connect_error)
}

fn map_ws_connect_error(err: WsError) -> WsBridgeError {
    match err {
        WsError::Http(response) => {
            let status =
                StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            WsBridgeError {
                status,
                error_type: "upstream_websocket_http_error",
                message: format!("upstream websocket handshake failed with status {status}"),
                scope: proxy::classify_failure_scope(
                    Some(status.as_u16() as i32),
                    proxy::OutcomeOrigin::UpstreamResponse,
                ),
            }
        }
        WsError::Io(err) => WsBridgeError {
            status: StatusCode::BAD_GATEWAY,
            error_type: "upstream_websocket_io_error",
            message: err.to_string(),
            scope: proxy::FailureScope::Provider,
        },
        other => WsBridgeError {
            status: StatusCode::BAD_GATEWAY,
            error_type: "upstream_websocket_error",
            message: other.to_string(),
            scope: proxy::FailureScope::Provider,
        },
    }
}

async fn forward_response_create<D, E>(
    ctx: &WsContext,
    downstream: &mut D,
    active: &mut ActiveUpstream,
    payload: String,
) -> ForwardResult
where
    D: Sink<Message, Error = E> + Unpin,
    E: Display,
{
    let turn_start = Instant::now();
    let mut telemetry_permit = match ctx.state.telemetry.try_reserve_permit() {
        Ok(p) => Some(p),
        Err(_) => {
            ctx.state.metrics.record_telemetry_dropped();
            None
        }
    };

    match &mut active.transport {
        ActiveTransport::NativeWs(ws) => {
            forward_native_response_create(
                ctx,
                downstream,
                &active.resolved,
                &active.requested_model,
                ws,
                payload,
                turn_start,
                &mut telemetry_permit,
            )
            .await
        }
        ActiveTransport::HttpBridge => {
            forward_http_bridge_response_create(
                ctx,
                downstream,
                &active.resolved,
                &active.requested_model,
                payload,
                turn_start,
                &mut telemetry_permit,
            )
            .await
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "native websocket forwarding needs independent sink, routing, timing, and telemetry handles"
)]
async fn forward_native_response_create<D, E>(
    ctx: &WsContext,
    downstream: &mut D,
    resolved: &ResolvedUpstream,
    requested_model: &str,
    ws: &mut UpstreamWs,
    payload: String,
    turn_start: Instant,
    telemetry_permit: &mut Option<mpsc::OwnedPermit<TelemetryEvent>>,
) -> ForwardResult
where
    D: Sink<Message, Error = E> + Unpin,
    E: Display,
{
    let reservation = match proxy::reserve_ws_turn(&ctx.state, resolved, util::now_ms()) {
        Ok(reservation) => reservation,
        Err(proxy::AttemptReservationError::Quota) => {
            let message = "upstream request quota is unavailable".to_string();
            let outcome = TurnOutcome::error(
                StatusCode::TOO_MANY_REQUESTS,
                "upstream_quota_unavailable",
                message.clone(),
                turn_start,
            );
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::NativeWs,
                &outcome,
                telemetry_permit,
                None,
            );
            return ForwardResult::RetryableBeforeEvent(WsBridgeError {
                status: outcome.status,
                error_type: "upstream_quota_unavailable",
                message,
                scope: proxy::FailureScope::Quota,
            });
        }
        Err(_) => {
            let message = "native websocket upstream target could not be reserved".to_string();
            let outcome = TurnOutcome::error(
                StatusCode::SERVICE_UNAVAILABLE,
                "provider_capacity_unavailable",
                message.clone(),
                turn_start,
            );
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::NativeWs,
                &outcome,
                telemetry_permit,
                None,
            );
            return ForwardResult::RetryableBeforeEvent(WsBridgeError {
                status: outcome.status,
                error_type: "provider_capacity_unavailable",
                message,
                scope: proxy::FailureScope::Provider,
            });
        }
    };
    ctx.state.metrics.record_upstream_attempt();
    if let Err(err) = ws.send(Message::Text(payload.into())).await {
        let message = format!("failed to send websocket request upstream: {err}");
        let outcome = TurnOutcome::provider_error(
            StatusCode::BAD_GATEWAY,
            "upstream_websocket_write_error",
            message.clone(),
            turn_start,
        );
        record_turn(
            ctx,
            resolved,
            requested_model,
            TurnTransport::NativeWs,
            &outcome,
            telemetry_permit,
            Some(reservation),
        );
        return ForwardResult::RetryableBeforeEvent(WsBridgeError {
            status: outcome.status,
            error_type: "upstream_websocket_write_error",
            message,
            scope: proxy::FailureScope::Provider,
        });
    }

    let t_stream_ms = Some(turn_start.elapsed().as_millis() as i64);
    let mut first_byte_ms = None;
    let mut first_token_ms = None;
    let mut emitted_event = false;
    let (status, error_type, error_message) = loop {
        match read_with_disconnect_grace(ctx, ws.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                first_byte_ms.get_or_insert_with(|| turn_start.elapsed().as_millis() as i64);
                if let Ok(event) = serde_json::from_str::<Value>(&text) {
                    ctx.observation.lock().observe(&event);
                    if first_token_ms.is_none() && is_responses_delta_event(&event) {
                        first_token_ms = Some(turn_start.elapsed().as_millis() as i64);
                    }
                    if is_terminal_response_event(&event) {
                        let outcome = terminal_status(&event);
                        observe_codex_account_error(
                            &ctx.state,
                            resolved,
                            outcome.0,
                            text.as_bytes(),
                        )
                        .await;
                        if !should_retry_terminal_before_event(&event, emitted_event) {
                            send_turn_event(ctx, downstream, Message::Text(text)).await;
                            emitted_event = true;
                        }
                        break outcome;
                    }
                }
                send_turn_event(ctx, downstream, Message::Text(text)).await;
                emitted_event = true;
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                if let Err(error) = ws.send(Message::Pong(payload)).await {
                    break (
                        StatusCode::BAD_GATEWAY,
                        Some("upstream_websocket_write_error".into()),
                        Some(error.to_string()),
                    );
                }
            }
            Ok(Some(Ok(Message::Binary(bytes)))) => {
                send_turn_event(ctx, downstream, Message::Binary(bytes)).await;
                emitted_event = true;
            }
            Ok(Some(Ok(Message::Pong(_) | Message::Frame(_)))) => {}
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => {
                break (
                    StatusCode::BAD_GATEWAY,
                    Some("upstream_websocket_closed".into()),
                    Some("upstream closed before terminal response event".into()),
                );
            }
            Ok(Some(Err(error))) => {
                break (
                    StatusCode::BAD_GATEWAY,
                    Some("upstream_websocket_read_error".into()),
                    Some(error.to_string()),
                );
            }
            Err(()) => {
                break (
                    StatusCode::GATEWAY_TIMEOUT,
                    Some("upstream_timeout".into()),
                    Some("upstream read deadline exceeded".into()),
                );
            }
        }
    };
    let outcome = TurnOutcome::from_parts(
        status,
        error_type,
        error_message,
        t_stream_ms,
        first_byte_ms,
        first_token_ms,
        Usage::default(),
        false,
        turn_start,
    );
    finish_forwarded_turn(
        ctx,
        resolved,
        requested_model,
        TurnTransport::NativeWs,
        outcome,
        emitted_event,
        telemetry_permit,
        reservation,
    )
}

async fn read_with_disconnect_grace<T>(
    ctx: &WsContext,
    read: impl std::future::Future<Output = T>,
) -> Result<T, ()> {
    let mut disconnected = ctx.disconnected_at.subscribe();
    let read_deadline = tokio::time::Instant::now() + ctx.state.config.upstream_request_timeout;
    tokio::pin!(read);
    loop {
        let disconnected_at = *disconnected.borrow();
        let deadline = disconnected_at
            .map(|at| tokio::time::Instant::from_std(at) + crate::response_events::DISCONNECT_GRACE)
            .map_or(read_deadline, |deadline| deadline.min(read_deadline));
        tokio::select! {
            result = tokio::time::timeout_at(deadline, &mut read) => return result.map_err(|_| ()),
            _ = disconnected.changed(), if disconnected_at.is_none() => {}
        }
    }
}

async fn send_turn_event<D, E>(ctx: &WsContext, downstream: &mut D, message: Message)
where
    D: Sink<Message, Error = E> + Unpin,
    E: Display,
{
    if ctx.disconnected_at.borrow().is_none() && downstream.send(message).await.is_err() {
        ctx.disconnected_at.send_replace(Some(Instant::now()));
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "settles a single forwarded turn with its owned reservation"
)]
fn finish_forwarded_turn(
    ctx: &WsContext,
    resolved: &ResolvedUpstream,
    requested_model: &str,
    transport: TurnTransport,
    outcome: TurnOutcome,
    emitted_event: bool,
    telemetry_permit: &mut Option<mpsc::OwnedPermit<TelemetryEvent>>,
    reservation: proxy::UpstreamAttemptReservation,
) -> ForwardResult {
    let disconnected = ctx.disconnected_at.borrow().is_some();
    let scope = proxy::classify_failure_scope(Some(outcome.status.as_u16() as i32), outcome.origin);
    if scope == proxy::FailureScope::Quota && !disconnected {
        ctx.state.quota.observe_response(
            resolved.key.id,
            outcome.status.as_u16() as i32,
            &HeaderMap::new(),
            util::now_ms(),
            ctx.state.config.rate_limit_fallback_cooldown,
        );
    }
    record_turn(
        ctx,
        resolved,
        requested_model,
        transport,
        &outcome,
        telemetry_permit,
        Some(reservation),
    );
    if disconnected {
        return ForwardResult::Fatal;
    }
    if !emitted_event && scope.is_retryable() {
        ForwardResult::RetryableBeforeEvent(WsBridgeError {
            status: outcome.status,
            error_type: "upstream_response_failed",
            message: outcome
                .error_message
                .unwrap_or_else(|| "upstream response failed".into()),
            scope,
        })
    } else if scope == proxy::FailureScope::Success {
        ForwardResult::Complete
    } else {
        ForwardResult::Fatal
    }
}

async fn forward_http_bridge_response_create<D, E>(
    ctx: &WsContext,
    downstream: &mut D,
    resolved: &ResolvedUpstream,
    requested_model: &str,
    payload: String,
    turn_start: Instant,
    telemetry_permit: &mut Option<mpsc::OwnedPermit<TelemetryEvent>>,
) -> ForwardResult
where
    D: Sink<Message, Error = E> + Unpin,
    E: Display,
{
    let mut body_value = match serde_json::from_str::<Value>(&payload) {
        Ok(value) => value,
        Err(err) => {
            let message = format!("failed to decode HTTP bridge payload: {err}");
            let outcome = TurnOutcome::error(
                StatusCode::BAD_REQUEST,
                "invalid_payload",
                message.clone(),
                turn_start,
            );
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::HttpBridge,
                &outcome,
                telemetry_permit,
                None,
            );
            let _ = send_ws_error(downstream, outcome.status, "invalid_payload", &message).await;
            return ForwardResult::Fatal;
        }
    };
    if let Some(root) = body_value.as_object_mut() {
        root.remove("type");
        root.insert("stream".to_string(), Value::Bool(true));
    }
    let body = match serde_json::to_vec(&body_value) {
        Ok(body) => Bytes::from(body),
        Err(err) => {
            let message = format!("failed to encode HTTP bridge payload: {err}");
            let outcome = TurnOutcome::error(
                StatusCode::BAD_REQUEST,
                "invalid_payload",
                message.clone(),
                turn_start,
            );
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::HttpBridge,
                &outcome,
                telemetry_permit,
                None,
            );
            let _ = send_ws_error(downstream, outcome.status, "invalid_payload", &message).await;
            return ForwardResult::Fatal;
        }
    };

    let reservation = match proxy::reserve_attempt(&ctx.state, resolved, util::now_ms()) {
        Ok(reservation) => reservation,
        Err(proxy::AttemptReservationError::Quota) => {
            let message = "upstream request quota is unavailable".to_string();
            let outcome = TurnOutcome::error(
                StatusCode::TOO_MANY_REQUESTS,
                "upstream_quota_unavailable",
                message.clone(),
                turn_start,
            );
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::HttpBridge,
                &outcome,
                telemetry_permit,
                None,
            );
            return ForwardResult::RetryableBeforeEvent(WsBridgeError {
                status: outcome.status,
                error_type: "upstream_quota_unavailable",
                message,
                scope: proxy::FailureScope::Quota,
            });
        }
        Err(_) => {
            let message = "HTTP bridge upstream target could not be reserved".to_string();
            let outcome = TurnOutcome::error(
                StatusCode::SERVICE_UNAVAILABLE,
                "provider_capacity_unavailable",
                message.clone(),
                turn_start,
            );
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::HttpBridge,
                &outcome,
                telemetry_permit,
                None,
            );
            return ForwardResult::RetryableBeforeEvent(WsBridgeError {
                status: outcome.status,
                error_type: "provider_capacity_unavailable",
                message,
                scope: proxy::FailureScope::Provider,
            });
        }
    };
    ctx.state.metrics.record_upstream_attempt();

    let upstream_uri = match build_upstream_http_responses_uri(&resolved.endpoint.base_url) {
        Ok(uri) => uri,
        Err(message) => {
            let outcome = TurnOutcome::provider_error(
                StatusCode::BAD_REQUEST,
                "invalid_upstream_uri",
                message.clone(),
                turn_start,
            );
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::HttpBridge,
                &outcome,
                telemetry_permit,
                Some(reservation),
            );
            return ForwardResult::RetryableBeforeEvent(WsBridgeError {
                status: outcome.status,
                error_type: "invalid_upstream_uri",
                message,
                scope: proxy::FailureScope::Provider,
            });
        }
    };

    let is_codex_oauth = resolved.provider.provider_type == crate::codex_oauth::PROVIDER_TYPE;
    let prepared_codex_auth = if is_codex_oauth {
        match ctx
            .state
            .codex_oauth
            .prepare_auth(&ctx.state, resolved.key.id, false)
            .await
        {
            Ok(auth) => Some(auth),
            Err(error) => {
                let outcome = TurnOutcome::upstream_response_error(
                    error.http_status(),
                    error.code,
                    error.message.clone(),
                    turn_start,
                );
                record_turn(
                    ctx,
                    resolved,
                    requested_model,
                    TurnTransport::HttpBridge,
                    &outcome,
                    telemetry_permit,
                    Some(reservation),
                );
                return ForwardResult::RetryableBeforeEvent(WsBridgeError {
                    status: error.http_status(),
                    error_type: error.code,
                    message: error.message,
                    scope: proxy::FailureScope::Key,
                });
            }
        }
    } else {
        None
    };
    let upstream_secret = prepared_codex_auth
        .as_ref()
        .map_or(resolved.key.secret.as_str(), |auth| {
            auth.access_token.as_str()
        });
    let mut headers =
        build_upstream_http_bridge_headers(&ctx.request_headers, upstream_secret, body.len());
    if let Some(auth) = prepared_codex_auth.as_ref() {
        crate::codex_oauth::apply_codex_headers(&mut headers, auth);
    }
    if let Err(error) = resolved.provider.request_overrides.apply_headers(
        &mut headers,
        ApiFormat::Responses,
        &ctx.request_override_context,
    ) {
        let message = format!("failed to apply provider request header overrides: {error}");
        let outcome = TurnOutcome::provider_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "request_override_failed",
            message.clone(),
            turn_start,
        );
        record_turn(
            ctx,
            resolved,
            requested_model,
            TurnTransport::HttpBridge,
            &outcome,
            telemetry_permit,
            Some(reservation),
        );
        return ForwardResult::RetryableBeforeEvent(WsBridgeError {
            status: outcome.status,
            error_type: "request_override_failed",
            message,
            scope: proxy::FailureScope::Provider,
        });
    }
    let mut response = proxy::dispatch_upstream_request(
        &ctx.state,
        &Method::POST,
        hyper::Version::HTTP_11,
        &headers,
        body.clone(),
        upstream_uri.clone(),
    )
    .await;
    if is_codex_oauth
        && response
            .as_ref()
            .is_ok_and(|response| response.status() == StatusCode::UNAUTHORIZED)
        && let Ok(refreshed) = ctx
            .state
            .codex_oauth
            .prepare_auth(&ctx.state, resolved.key.id, true)
            .await
    {
        let mut retry_headers = build_upstream_http_bridge_headers(
            &ctx.request_headers,
            &refreshed.access_token,
            body.len(),
        );
        crate::codex_oauth::apply_codex_headers(&mut retry_headers, &refreshed);
        if let Err(error) = resolved.provider.request_overrides.apply_headers(
            &mut retry_headers,
            ApiFormat::Responses,
            &ctx.request_override_context,
        ) {
            let message = format!("failed to apply provider request header overrides: {error}");
            let outcome = TurnOutcome::provider_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "request_override_failed",
                message.clone(),
                turn_start,
            );
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::HttpBridge,
                &outcome,
                telemetry_permit,
                Some(reservation),
            );
            return ForwardResult::RetryableBeforeEvent(WsBridgeError {
                status: outcome.status,
                error_type: "request_override_failed",
                message,
                scope: proxy::FailureScope::Provider,
            });
        }
        response = proxy::dispatch_upstream_request(
            &ctx.state,
            &Method::POST,
            hyper::Version::HTTP_11,
            &retry_headers,
            body,
            upstream_uri,
        )
        .await;
        retry_headers.clear();
    }
    headers.clear();
    if is_codex_oauth
        && response
            .as_ref()
            .is_ok_and(|response| response.status() == StatusCode::UNAUTHORIZED)
    {
        let _ = ctx
            .state
            .db
            .update_codex_auth_status(
                resolved.key.id,
                crate::codex_oauth::AUTH_STATUS_REAUTH_REQUIRED,
                Some("HTTP bridge rejected the refreshed access token"),
                util::now_ms(),
            )
            .await;
        ctx.state.caches.upstream.invalidate();
    }

    let upstream_resp = match response {
        Ok(response) => response,
        Err(error) => {
            let (status, error_type, message) = proxy::dispatch_error_to_http(error, &ctx.state);
            let outcome =
                TurnOutcome::provider_error(status, error_type, message.clone(), turn_start);
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::HttpBridge,
                &outcome,
                telemetry_permit,
                Some(reservation),
            );
            return ForwardResult::RetryableBeforeEvent(WsBridgeError {
                status: outcome.status,
                error_type,
                message,
                scope: proxy::FailureScope::Provider,
            });
        }
    };

    let t_stream_ms = Some(turn_start.elapsed().as_millis() as i64);
    let status = upstream_resp.status();
    let status_i32 = status.as_u16() as i32;
    ctx.state.quota.observe_response(
        resolved.key.id,
        status_i32,
        upstream_resp.headers(),
        util::now_ms(),
        ctx.state.config.rate_limit_fallback_cooldown,
    );
    let (parts, mut body) = upstream_resp.into_parts();
    let is_sse = parts
        .headers
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("text/event-stream"))
        .unwrap_or(false);

    let mut first_byte_ms = None;
    let mut first_token_ms = None;
    let mut terminal = None;
    let mut sse = SseToWsParser::default();
    let mut capture = BytesMut::new();
    let mut emitted_event = false;
    loop {
        let frame = match read_with_disconnect_grace(ctx, body.frame()).await {
            Ok(Some(Ok(frame))) => Some(frame),
            Ok(None) => None,
            Ok(Some(Err(error))) => {
                terminal = Some((
                    StatusCode::BAD_GATEWAY,
                    Some("upstream_body_error".into()),
                    Some(error.to_string()),
                ));
                None
            }
            Err(()) => {
                terminal = Some((
                    StatusCode::GATEWAY_TIMEOUT,
                    Some("upstream_timeout".into()),
                    Some("upstream read deadline exceeded".into()),
                ));
                None
            }
        };
        let eof = frame.is_none();
        let events = if let Some(data) = frame.as_ref().and_then(|frame| frame.data_ref()) {
            first_byte_ms.get_or_insert_with(|| turn_start.elapsed().as_millis() as i64);
            if is_sse {
                sse.push_bytes(data)
            } else {
                if capture.len().saturating_add(data.len())
                    > crate::response_events::MAX_EVENT_BYTES
                {
                    terminal = Some((
                        StatusCode::BAD_GATEWAY,
                        Some("response_too_large".into()),
                        Some("HTTP bridge JSON exceeds 4 MiB parsing limit".into()),
                    ));
                    break;
                }
                capture.extend_from_slice(data);
                Vec::new()
            }
        } else if eof {
            if is_sse {
                sse.finish()
            } else if !capture.is_empty() {
                vec![json_response_to_ws_event(status, &capture)]
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        for event in events {
            ctx.observation.lock().observe(&event);
            if first_token_ms.is_none() && is_responses_delta_event(&event) {
                first_token_ms = Some(turn_start.elapsed().as_millis() as i64);
            }
            let terminal_event = is_terminal_response_event(&event);
            if terminal_event {
                terminal = Some(terminal_status(&event));
                observe_codex_account_error(
                    &ctx.state,
                    resolved,
                    terminal.as_ref().map(|value| value.0).unwrap_or(status),
                    event.to_string().as_bytes(),
                )
                .await;
            }
            if !should_retry_terminal_before_event(&event, emitted_event) {
                send_turn_event(ctx, downstream, Message::Text(event.to_string().into())).await;
                emitted_event = true;
            }
        }
        if eof || terminal.is_some() {
            break;
        }
    }
    let (final_status, error_type, error_message) = terminal.unwrap_or_else(|| {
        (
            StatusCode::BAD_GATEWAY,
            Some("upstream_incomplete_response".into()),
            Some(
                sse.error
                    .unwrap_or_else(|| "upstream ended without terminal response event".into()),
            ),
        )
    });
    let outcome = TurnOutcome::from_parts(
        final_status,
        error_type,
        error_message,
        t_stream_ms,
        first_byte_ms,
        first_token_ms,
        Usage::default(),
        false,
        turn_start,
    );
    finish_forwarded_turn(
        ctx,
        resolved,
        requested_model,
        TurnTransport::HttpBridge,
        outcome,
        emitted_event,
        telemetry_permit,
        reservation,
    )
}

async fn observe_codex_account_error(
    state: &SharedState,
    resolved: &ResolvedUpstream,
    status: StatusCode,
    body: &[u8],
) {
    if resolved.provider.provider_type != crate::codex_oauth::PROVIDER_TYPE {
        return;
    }
    let now_ms = util::now_ms();
    if status == StatusCode::FORBIDDEN && crate::codex_oauth::is_account_forbidden_error(body) {
        let _ = state
            .db
            .update_codex_auth_status(
                resolved.key.id,
                crate::codex_oauth::AUTH_STATUS_FORBIDDEN,
                Some("Codex entitlement or workspace access was denied"),
                now_ms,
            )
            .await;
        state.caches.upstream.invalidate();
    }
    if matches!(
        status,
        StatusCode::PAYMENT_REQUIRED | StatusCode::TOO_MANY_REQUESTS
    ) && let Some(reset_at_ms) = crate::codex_oauth::quota_reset_hint_from_error(body, now_ms)
    {
        state
            .quota
            .set_cooldown_until(resolved.key.id, reset_at_ms, now_ms);
    }
}

impl TurnOutcome {
    fn error(
        status: StatusCode,
        error_type: impl Into<String>,
        error_message: String,
        start: Instant,
    ) -> Self {
        let mut outcome = Self::from_parts(
            status,
            Some(error_type.into()),
            Some(error_message),
            None,
            None,
            None,
            Usage::default(),
            false,
            start,
        );
        outcome.origin = proxy::OutcomeOrigin::Gateway;
        outcome
    }

    fn provider_error(
        status: StatusCode,
        error_type: impl Into<String>,
        error_message: String,
        start: Instant,
    ) -> Self {
        let mut outcome = Self::error(status, error_type, error_message, start);
        outcome.origin = proxy::OutcomeOrigin::LocalTransport;
        outcome
    }

    fn upstream_response_error(
        status: StatusCode,
        error_type: impl Into<String>,
        error_message: String,
        start: Instant,
    ) -> Self {
        let mut outcome = Self::error(status, error_type, error_message, start);
        outcome.origin = proxy::OutcomeOrigin::UpstreamResponse;
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    fn from_parts(
        status: StatusCode,
        error_type: Option<String>,
        error_message: Option<String>,
        t_stream_ms: Option<i64>,
        t_first_byte_ms: Option<i64>,
        t_first_token_ms: Option<i64>,
        usage: Usage,
        usage_observed: bool,
        start: Instant,
    ) -> Self {
        Self {
            status,
            error_type,
            error_message,
            t_stream_ms,
            t_first_byte_ms,
            t_first_token_ms,
            duration_ms: start.elapsed().as_millis() as i64,
            usage,
            usage_observed,
            origin: proxy::OutcomeOrigin::UpstreamEvent,
        }
    }
}

fn record_turn(
    ctx: &WsContext,
    resolved: &ResolvedUpstream,
    requested_model: &str,
    transport: TurnTransport,
    outcome: &TurnOutcome,
    telemetry_permit: &mut Option<mpsc::OwnedPermit<TelemetryEvent>>,
    reservation: Option<proxy::UpstreamAttemptReservation>,
) {
    let mut outcome = outcome.clone();
    let observation = ctx.observation.lock();
    if let Some(usage) = observation.usage {
        outcome.usage = usage;
        outcome.usage_observed = true;
    }
    let service_tier = observation.service_tier.clone();
    drop(observation);
    let disconnected = *ctx.disconnected_at.borrow();
    if let Some(at) = disconnected {
        outcome.duration_ms = outcome
            .duration_ms
            .saturating_sub(at.elapsed().as_millis() as i64)
            .max(0);
        outcome.error_type = Some("client_disconnected".into());
        outcome.error_message =
            Some("client disconnected; upstream metering collection finished".into());
        outcome.origin = proxy::OutcomeOrigin::Gateway;
    }
    let pricing = evaluate_price(
        &outcome.usage,
        outcome.usage_observed,
        resolved.price.as_ref(),
    );
    let status_i32 = outcome.status.as_u16() as i32;
    let error_type = outcome.error_type.as_deref();
    let error_message = outcome.error_message.as_deref();
    let observed_latency_ms = outcome
        .t_first_byte_ms
        .or(outcome.t_first_token_ms)
        .or(outcome.t_stream_ms);

    let now_ms = util::now_ms();
    let scope = proxy::classify_failure_scope(Some(status_i32), outcome.origin);
    let attempted_upstream = reservation.is_some();
    if let Some(reservation) = reservation {
        if disconnected.is_some() {
            reservation.neutral();
        } else {
            reservation.finish(
                proxy::AttemptOutcome {
                    status: Some(status_i32),
                    origin: outcome.origin,
                    error_type,
                    error_message,
                    observed_latency_ms,
                },
                &ctx.state.metrics,
            );
        }
    }
    if attempted_upstream && scope == proxy::FailureScope::Success {
        if let Some(identity) = extract_affinity_identity(&ctx.request_headers, &[], ctx.api_key.id)
        {
            if let Some(binding) = ctx.state.affinity.lookup(&identity, now_ms) {
                if binding.provider_id == resolved.provider.id {
                    if binding.confirmed {
                        let _ = ctx.state.affinity.refresh_if_provider(
                            &identity,
                            resolved.provider.id,
                            now_ms,
                        );
                    } else {
                        let _ = ctx.state.affinity.confirm(&identity, binding, now_ms);
                    }
                } else {
                    ctx.state
                        .affinity
                        .migrate(&identity, resolved.provider.id, now_ms);
                    ctx.state.metrics.record_affinity_migration();
                }
            } else {
                let binding = ctx
                    .state
                    .affinity
                    .claim(&identity, resolved.provider.id, now_ms);
                if binding.provider_id == resolved.provider.id {
                    let _ = ctx.state.affinity.confirm(&identity, binding, now_ms);
                }
            }
        }
    } else if attempted_upstream
        && scope.should_avoid_affinity_immediately()
        && let Some(identity) = extract_affinity_identity(&ctx.request_headers, &[], ctx.api_key.id)
    {
        ctx.state.affinity.mark_provider_failed(
            &identity,
            resolved.provider.id,
            now_ms,
            std::time::Duration::from_millis(
                resolved.provider.circuit_breaker_open_ms.max(1) as u64
            ),
        );
    }
    let event = TelemetryEvent {
        id: None,
        api_key_id: ctx.api_key.id,
        log_enabled: ctx.api_key.log_enabled,
        provider_id: Some(resolved.provider.id),
        endpoint_id: Some(resolved.endpoint.id),
        upstream_key_id: Some(resolved.key.id),
        api_format: "responses",
        upstream_api_format: Some("responses"),
        model: Some(requested_model.to_string()),
        http_status: Some(status_i32),
        error_type: outcome.error_type.clone(),
        error_message: outcome.error_message.clone(),
        t_stream_ms: outcome.t_stream_ms,
        t_first_byte_ms: outcome.t_first_byte_ms,
        t_first_token_ms: outcome.t_first_token_ms,
        duration_ms: Some(outcome.duration_ms),
        usage: outcome.usage,
        usage_observed: outcome.usage_observed,
        price_version_id: resolved.price.as_ref().map(|price| price.id),
        price_tier_index: pricing.tier_index,
        time_ms: util::now_ms(),
        span_kind: "ws_turn",
        transport: transport.as_log_value(),
        parent_id: Some(ctx.session_log_id.clone()),
        ws_session_id: Some(ctx.session_id.clone()),
        requested_service_tier: ctx.requested_service_tier.clone(),
        upstream_service_tier: ctx.upstream_service_tier.clone(),
        service_tier,
        routing_trace: None,
    };
    *ctx.pending_turn_log.lock() = Some(PendingTurnLog {
        permit: telemetry_permit.take(),
        event,
        pricing,
        succeeded: scope == proxy::FailureScope::Success,
    });
}

fn record_ws_setup_failed_turn(
    ctx: &WsContext,
    requested_model: Option<&str>,
    status: StatusCode,
    error_type: impl Into<String>,
    error_message: impl Into<String>,
    start: Instant,
) {
    let error_type = error_type.into();
    let error_message = error_message.into();
    let duration_ms = start.elapsed().as_millis() as i64;
    let status_i32 = status.as_u16() as i32;
    ctx.state.metrics.record_request(
        ApiFormat::Responses,
        RequestMetric {
            http_status: Some(status_i32),
            error_type: Some(&error_type),
            duration_ms: Some(duration_ms),
            usage: Usage::default(),
            pricing: PricingEvaluation::usage_missing(),
        },
    );

    let mut telemetry_permit = match ctx.state.telemetry.try_reserve_permit() {
        Ok(p) => Some(p),
        Err(_) => {
            ctx.state.metrics.record_telemetry_dropped();
            None
        }
    };
    let Some(permit) = telemetry_permit.take() else {
        return;
    };
    let _ = permit.send(TelemetryEvent {
        id: None,
        api_key_id: ctx.api_key.id,
        log_enabled: ctx.api_key.log_enabled,
        provider_id: None,
        endpoint_id: None,
        upstream_key_id: None,
        api_format: "responses",
        upstream_api_format: None,
        model: requested_model.map(ToString::to_string),
        http_status: Some(status_i32),
        error_type: Some(error_type),
        error_message: Some(error_message),
        t_stream_ms: None,
        t_first_byte_ms: None,
        t_first_token_ms: None,
        duration_ms: Some(duration_ms),
        usage: Usage::default(),
        usage_observed: false,
        price_version_id: None,
        price_tier_index: None,
        time_ms: util::now_ms(),
        span_kind: "ws_turn",
        transport: TurnTransport::WsSetup.as_log_value(),
        parent_id: Some(ctx.session_log_id.clone()),
        ws_session_id: Some(ctx.session_id.clone()),
        requested_service_tier: ctx.requested_service_tier.clone(),
        upstream_service_tier: None,
        service_tier: None,
        routing_trace: None,
    });
}

fn record_session_open(ctx: &WsContext) {
    let Ok(permit) = ctx.state.telemetry.try_reserve_permit() else {
        ctx.state.metrics.record_telemetry_dropped();
        return;
    };
    let _ = permit.send(TelemetryEvent {
        id: Some(ctx.session_log_id.clone()),
        api_key_id: ctx.api_key.id,
        log_enabled: ctx.api_key.log_enabled,
        provider_id: None,
        endpoint_id: None,
        upstream_key_id: None,
        api_format: "responses",
        upstream_api_format: None,
        model: None,
        http_status: Some(StatusCode::SWITCHING_PROTOCOLS.as_u16() as i32),
        error_type: None,
        error_message: None,
        t_stream_ms: None,
        t_first_byte_ms: None,
        t_first_token_ms: None,
        duration_ms: None,
        usage: Usage::default(),
        usage_observed: false,
        price_version_id: None,
        price_tier_index: None,
        time_ms: ctx.session_started_at_ms,
        span_kind: "ws_session",
        transport: "ws",
        parent_id: None,
        ws_session_id: Some(ctx.session_id.clone()),
        requested_service_tier: None,
        upstream_service_tier: None,
        service_tier: None,
        routing_trace: None,
    });
}

fn record_session_close(
    ctx: &WsContext,
    status: StatusCode,
    error_type: Option<String>,
    error_message: Option<String>,
) {
    let Ok(permit) = ctx.state.telemetry.try_reserve_permit() else {
        ctx.state.metrics.record_telemetry_dropped();
        return;
    };
    let disconnected = *ctx.disconnected_at.borrow();
    let duration_ms = util::now_ms()
        .saturating_sub(ctx.session_started_at_ms)
        .saturating_sub(disconnected.map_or(0, |at| at.elapsed().as_millis() as i64))
        .max(0);
    let (error_type, error_message) = if disconnected.is_some() {
        (
            Some("client_disconnected".into()),
            Some("client disconnected".into()),
        )
    } else {
        (error_type, error_message)
    };
    let _ = permit.send(TelemetryEvent {
        id: None,
        api_key_id: ctx.api_key.id,
        log_enabled: ctx.api_key.log_enabled,
        provider_id: None,
        endpoint_id: None,
        upstream_key_id: None,
        api_format: "responses",
        upstream_api_format: None,
        model: None,
        http_status: Some(status.as_u16() as i32),
        error_type,
        error_message,
        t_stream_ms: None,
        t_first_byte_ms: None,
        t_first_token_ms: None,
        duration_ms: Some(duration_ms),
        usage: Usage::default(),
        usage_observed: false,
        price_version_id: None,
        price_tier_index: None,
        time_ms: util::now_ms(),
        span_kind: "ws_session_close",
        transport: "ws",
        parent_id: Some(ctx.session_log_id.clone()),
        ws_session_id: Some(ctx.session_id.clone()),
        requested_service_tier: None,
        upstream_service_tier: None,
        service_tier: None,
        routing_trace: None,
    });
}

fn is_responses_delta_event(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|event_type| event_type.ends_with(".delta"))
        && proxy::responses_has_delta(value)
}

use crate::response_events::{is_terminal_response_event, terminal_status};

fn should_retry_terminal_before_event(value: &Value, emitted_event: bool) -> bool {
    if emitted_event
        || crate::response_events::event_usage(value).is_some()
        || !is_terminal_response_event(value)
    {
        return false;
    }
    let (status, _, _) = terminal_status(value);
    proxy::classify_failure_scope(
        Some(status.as_u16() as i32),
        proxy::OutcomeOrigin::UpstreamEvent,
    )
    .is_retryable()
}

type SseToWsParser = crate::response_events::SseDecoder;

fn json_response_to_ws_event(status: StatusCode, body: &[u8]) -> Value {
    let parsed = serde_json::from_slice::<Value>(body).unwrap_or_else(|_| {
        json!({
            "error": {
                "type": "upstream_error",
                "message": String::from_utf8_lossy(body)
            }
        })
    });

    if is_terminal_response_event(&parsed) && parsed.get("type").is_some() {
        return parsed;
    }
    if status.is_success() {
        return json!({
            "type": "response.completed",
            "response": parsed
        });
    }

    json!({
        "type": "error",
        "status": status.as_u16(),
        "response": parsed,
        "error": parsed.get("error").cloned().unwrap_or_else(|| parsed.clone())
    })
}

fn normalize_response_create(value: &mut Value, upstream_model: &str) {
    let Some(root) = value.as_object_mut() else {
        return;
    };
    root.insert(
        "model".to_string(),
        Value::String(upstream_model.to_string()),
    );
    root.insert("stream".to_string(), Value::Bool(true));
    root.remove("background");
}

fn build_upstream_http_responses_uri(base_url: &str) -> Result<Uri, String> {
    upstream_url::build_upstream_uri(base_url, UPSTREAM_RESPONSES_PATH)
}

fn build_upstream_ws_url(base_url: &str) -> Result<String, String> {
    upstream_url::build_upstream_websocket_url(base_url, UPSTREAM_RESPONSES_PATH)
}

fn build_upstream_http_bridge_headers(
    request_headers: &HeaderMap,
    upstream_secret: &str,
    body_len: usize,
) -> HeaderMap {
    let mut headers = proxy::build_upstream_headers(request_headers, body_len, upstream_secret);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    strip_websocket_beta_header(&mut headers);
    headers
}

fn strip_websocket_beta_header(headers: &mut HeaderMap) {
    let Some(existing) = headers
        .get("openai-beta")
        .and_then(|value| value.to_str().ok())
    else {
        return;
    };

    let kept = existing
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty() && *token != RESPONSES_WS_BETA)
        .collect::<Vec<_>>();
    if kept.is_empty() {
        headers.remove("openai-beta");
        return;
    }

    if let Ok(value) = HeaderValue::from_str(&kept.join(", ")) {
        headers.insert(HeaderName::from_static("openai-beta"), value);
    }
}

fn build_upstream_ws_headers(request_headers: &HeaderMap, upstream_secret: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    copy_header_by_name(request_headers, &mut headers, "openai-organization");
    copy_header_by_name(request_headers, &mut headers, "openai-project");
    copy_header_by_name(request_headers, &mut headers, "x-client-request-id");
    copy_header_by_name(request_headers, &mut headers, "session-id");
    copy_header_by_name(request_headers, &mut headers, "thread-id");
    copy_header_by_name(request_headers, &mut headers, "originator");
    copy_headers_by_prefix(request_headers, &mut headers, "x-codex-");
    copy_header(request_headers, &mut headers, USER_AGENT);
    insert_beta_header(request_headers, &mut headers);

    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {upstream_secret}")) {
        headers.insert(AUTHORIZATION, value);
    }
    headers
}

fn insert_beta_header(from: &HeaderMap, to: &mut HeaderMap) {
    let Some(existing) = from
        .get("openai-beta")
        .and_then(|value| value.to_str().ok())
    else {
        to.insert(
            HeaderName::from_static("openai-beta"),
            HeaderValue::from_static(RESPONSES_WS_BETA),
        );
        return;
    };

    if existing
        .split(',')
        .any(|token| token.trim() == RESPONSES_WS_BETA)
    {
        if let Some(value) = from.get("openai-beta") {
            to.insert(HeaderName::from_static("openai-beta"), value.clone());
        }
        return;
    }

    let value = format!("{existing}, {RESPONSES_WS_BETA}");
    if let Ok(value) = HeaderValue::from_str(&value) {
        to.insert(HeaderName::from_static("openai-beta"), value);
    }
}

fn copy_header(from: &HeaderMap, to: &mut HeaderMap, name: HeaderName) {
    if let Some(value) = from.get(&name) {
        to.insert(name, value.clone());
    }
}

fn copy_header_by_name(from: &HeaderMap, to: &mut HeaderMap, name: &'static str) {
    if let Some(value) = from.get(name) {
        to.insert(HeaderName::from_static(name), value.clone());
    }
}

fn copy_headers_by_prefix(from: &HeaderMap, to: &mut HeaderMap, prefix: &str) {
    for (name, value) in from {
        if name.as_str().starts_with(prefix) {
            to.append(name.clone(), value.clone());
        }
    }
}

async fn send_ws_error<D, E>(
    downstream: &mut D,
    status: StatusCode,
    code: &str,
    message: &str,
) -> Result<(), E>
where
    D: Sink<Message, Error = E> + Unpin,
{
    let payload = json!({
        "type": "error",
        "status": status.as_u16(),
        "error": {
            "type": "invalid_request_error",
            "code": code,
            "message": message
        }
    });
    downstream
        .send(Message::Text(payload.to_string().into()))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::{ACCEPT, CONTENT_LENGTH};

    #[test]
    fn build_upstream_ws_url_should_preserve_v1_base_path() {
        let url = build_upstream_ws_url("https://example.com/openai/v1").expect("url");

        assert_eq!(url, "wss://example.com/openai/v1/responses");
    }

    #[test]
    fn build_upstream_ws_headers_should_append_codex_beta_and_replace_auth() {
        let mut input = HeaderMap::new();
        input.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer client-visible-key"),
        );
        input.insert(CONTENT_LENGTH, HeaderValue::from_static("123"));
        input.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        input.insert("openai-beta", HeaderValue::from_static("responses=v1"));
        input.insert("x-codex-window-id", HeaderValue::from_static("thread:0"));
        input.insert(USER_AGENT, HeaderValue::from_static("codex-cli"));

        let headers = build_upstream_ws_headers(&input, "sk-upstream");

        assert_eq!(
            headers.get(AUTHORIZATION),
            Some(&HeaderValue::from_static("Bearer sk-upstream"))
        );
        assert!(headers.get(CONTENT_LENGTH).is_none());
        assert!(headers.get(ACCEPT).is_none());
        assert_eq!(
            headers.get("x-codex-window-id"),
            input.get("x-codex-window-id")
        );
        assert_eq!(headers.get(USER_AGENT), input.get(USER_AGENT));
        assert_eq!(
            headers
                .get("openai-beta")
                .and_then(|value| value.to_str().ok()),
            Some("responses=v1, responses_websockets=2026-02-06")
        );
    }

    #[test]
    fn build_upstream_http_bridge_headers_should_strip_websocket_beta() {
        let mut input = HeaderMap::new();
        input.insert(
            "openai-beta",
            HeaderValue::from_static("responses=v1, responses_websockets=2026-02-06"),
        );

        let headers = build_upstream_http_bridge_headers(&input, "sk-upstream", 2);

        assert_eq!(
            headers
                .get("openai-beta")
                .and_then(|value| value.to_str().ok()),
            Some("responses=v1")
        );
        assert_eq!(
            headers.get(ACCEPT),
            Some(&HeaderValue::from_static("text/event-stream"))
        );
    }

    #[test]
    fn sse_to_ws_parser_should_inject_event_type_when_missing() {
        let mut parser = SseToWsParser::default();

        let events = parser.push_bytes(&Bytes::from_static(
            b"event: response.output_text.delta\ndata: {\"delta\":\"hi\"}\n\n",
        ));

        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].get("type").and_then(Value::as_str),
            Some("response.output_text.delta")
        );
    }

    #[test]
    fn json_response_to_ws_event_should_wrap_success_response() {
        let event = json_response_to_ws_event(
            StatusCode::OK,
            br#"{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":2}}"#,
        );

        assert_eq!(
            event.get("type").and_then(Value::as_str),
            Some("response.completed")
        );
        assert_eq!(
            event
                .get("response")
                .and_then(|response| response.get("id"))
                .and_then(Value::as_str),
            Some("resp_1")
        );
    }

    #[test]
    fn deterministic_ws_unsupported_should_only_match_capability_statuses() {
        assert!(is_deterministic_ws_unsupported(StatusCode::NOT_FOUND));
        assert!(is_deterministic_ws_unsupported(
            StatusCode::METHOD_NOT_ALLOWED
        ));
        assert!(!is_deterministic_ws_unsupported(
            StatusCode::INTERNAL_SERVER_ERROR
        ));
        assert!(!is_deterministic_ws_unsupported(
            StatusCode::TOO_MANY_REQUESTS
        ));
    }

    #[test]
    fn websocket_provider_budget_should_allow_only_four_distinct_providers() {
        let mut budget = WsProviderBudget::default();

        assert_eq!(budget.try_note_attempt(1), Some(false));
        assert_eq!(budget.try_note_attempt(1), Some(false));
        assert_eq!(budget.try_note_attempt(2), Some(true));
        assert_eq!(budget.try_note_attempt(3), Some(true));
        assert_eq!(budget.try_note_attempt(4), Some(true));
        assert!(budget.exhausted());
        assert_eq!(budget.try_note_attempt(5), None);
    }

    #[test]
    fn response_failed_should_be_terminal_and_extract_response_error() {
        let event = json!({
            "type": "response.failed",
            "response": {
                "id": "resp_1",
                "status": "failed",
                "error": {
                    "code": "server_error",
                    "message": "model failed"
                }
            }
        });

        assert!(is_terminal_response_event(&event));
        let (status, error_type, error_message) = terminal_status(&event);
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(error_type.as_deref(), Some("server_error"));
        assert_eq!(error_message.as_deref(), Some("model failed"));
    }

    #[test]
    fn retryable_first_terminal_event_should_fail_over_before_forwarding() {
        let event = json!({
            "type": "response.failed",
            "response": {
                "status": "failed",
                "error": {"code": "server_error", "message": "failed"}
            }
        });

        assert!(should_retry_terminal_before_event(&event, false));
    }

    #[test]
    fn retryable_terminal_event_after_valid_output_should_not_fail_over() {
        let event = json!({
            "type": "error",
            "status": 503,
            "error": {"type": "server_error", "message": "failed"}
        });

        assert!(!should_retry_terminal_before_event(&event, true));
    }

    #[test]
    fn response_incomplete_should_be_terminal_and_extract_reason() {
        let event = json!({
            "type": "response.incomplete",
            "response": {
                "id": "resp_1",
                "status": "incomplete",
                "incomplete_details": {
                    "reason": "max_output_tokens"
                }
            }
        });

        assert!(is_terminal_response_event(&event));
        let (status, error_type, error_message) = terminal_status(&event);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(error_type.as_deref(), Some("response_incomplete"));
        assert_eq!(error_message.as_deref(), Some("max_output_tokens"));
        assert!(!should_retry_terminal_before_event(&event, false));
    }

    #[test]
    fn response_cancelled_should_be_terminal() {
        let event = json!({
            "type": "response.cancelled",
            "response": {
                "id": "resp_1",
                "status": "cancelled"
            }
        });

        assert!(is_terminal_response_event(&event));
        let (status, error_type, error_message) = terminal_status(&event);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(error_type.as_deref(), Some("response_cancelled"));
        assert_eq!(error_message.as_deref(), Some("response cancelled"));
    }

    #[test]
    fn normalize_response_create_should_rewrite_model_and_drop_background() {
        let mut value = json!({
            "type": "response.create",
            "model": "alias",
            "background": true,
            "input": []
        });

        normalize_response_create(&mut value, "upstream-model");

        assert_eq!(
            value.get("model").and_then(Value::as_str),
            Some("upstream-model")
        );
        assert_eq!(value.get("stream").and_then(Value::as_bool), Some(true));
        assert!(value.get("background").is_none());
    }
}
