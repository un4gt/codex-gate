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
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{
    HeaderName as WsHeaderName, HeaderValue as WsHeaderValue,
};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use crate::cache::transport_capability::{TransportCapabilityKey, WsCapability};
use crate::http::{self, HttpResponse};
use crate::metrics::RequestMetric;
use crate::proxy::{self, ResolvedUpstream};
use crate::state::SharedState;
use crate::telemetry::TelemetryEvent;
use crate::types::{ApiFormat, ApiKeyAuth, Usage};
use crate::util;

type UpstreamWs = WebSocketStream<MaybeTlsStream<TcpStream>>;

const RESPONSES_PATH: &str = "/v1/responses";
const RESPONSES_WS_BETA: &str = "responses_websockets=2026-02-06";
const BETA_FEATURE_RESPONSES_HTTP_TO_WS: &str = "responses-http-to-ws";

#[derive(Clone)]
struct WsContext {
    state: SharedState,
    api_key: ApiKeyAuth,
    request_headers: HeaderMap,
    session_id: String,
    session_log_id: String,
    session_started_at_ms: i64,
}

struct ActiveUpstream {
    requested_model: String,
    resolved: ResolvedUpstream,
    transport: ActiveTransport,
}

enum ActiveTransport {
    NativeWs(Box<UpstreamWs>),
    HttpBridge,
}

struct WsBridgeError {
    status: StatusCode,
    error_type: &'static str,
    message: String,
}

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
    Connected(Box<UpstreamWs>),
    Unsupported(WsBridgeError),
    Failed(WsBridgeError),
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
        session_id: util::new_ulid(),
        session_log_id: util::new_ulid(),
        session_started_at_ms: util::now_ms(),
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
            cost_in_usd: Decimal::ZERO,
            cost_out_usd: Decimal::ZERO,
        },
    );
}

async fn serve_websocket(websocket: hyper_tungstenite::HyperWebsocket, ctx: WsContext) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _inflight = ctx.state.metrics.inflight_guard();
    let mut downstream = match websocket.await {
        Ok(ws) => ws,
        Err(err) => {
            log::warn!("responses websocket upgrade failed: {err}");
            return;
        }
    };

    record_session_open(&ctx);
    let mut active: Option<ActiveUpstream> = None;
    let mut close_status = StatusCode::OK;
    let mut close_error_type: Option<String> = None;
    let mut close_error_message: Option<String> = None;
    while let Some(message) = downstream.next().await {
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
                let mut value = match serde_json::from_str::<Value>(&text) {
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

                if active.is_none() {
                    match connect_selected_upstream(&ctx, &requested_model).await {
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

                let Some(active) = active.as_mut() else {
                    break;
                };
                if active.requested_model != requested_model {
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

                normalize_response_create(&mut value, &active.resolved.upstream_model);
                let payload = match serde_json::to_string(&value) {
                    Ok(payload) => payload,
                    Err(err) => {
                        let _ = send_ws_error(
                            &mut downstream,
                            StatusCode::BAD_REQUEST,
                            "invalid_payload",
                            &format!("failed to encode websocket payload: {err}"),
                        )
                        .await;
                        continue;
                    }
                };

                let keep_open =
                    forward_response_create(&ctx, &mut downstream, active, payload).await;
                if !keep_open {
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
    record_session_close(&ctx, close_status, close_error_type, close_error_message);
}

async fn connect_selected_upstream(
    ctx: &WsContext,
    requested_model: &str,
) -> Result<ActiveUpstream, WsBridgeError> {
    let plan = proxy::build_upstream_plan(&ctx.state, ApiFormat::Responses, requested_model)
        .await
        .map_err(|(status, message)| WsBridgeError {
            status,
            error_type: "upstream_resolve_failed",
            message,
        })?;

    let attempts = plan
        .attempts
        .into_iter()
        .filter(|resolved| resolved.provider.websocket_enabled)
        .collect::<Vec<_>>();

    if attempts.is_empty() {
        return Err(WsBridgeError {
            status: StatusCode::UPGRADE_REQUIRED,
            error_type: "websocket_not_supported",
            message: "no websocket-enabled upstream target is available".to_string(),
        });
    }

    let mut last_error = None;
    let total = attempts.len();
    for (index, resolved) in attempts.into_iter().enumerate() {
        match connect_or_bridge_upstream(ctx, &resolved).await {
            NativeWsConnectOutcome::Connected(ws) => {
                return Ok(ActiveUpstream {
                    requested_model: requested_model.to_string(),
                    resolved,
                    transport: ActiveTransport::NativeWs(ws),
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
                });
            }
            NativeWsConnectOutcome::Unsupported(err) | NativeWsConnectOutcome::Failed(err) => {
                if index + 1 < total {
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
    }))
}

async fn connect_or_bridge_upstream(
    ctx: &WsContext,
    resolved: &ResolvedUpstream,
) -> NativeWsConnectOutcome {
    if !proxy::reserve_attempt(&ctx.state, resolved, util::now_ms()) {
        return NativeWsConnectOutcome::Failed(WsBridgeError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            error_type: "upstream_retry_exhausted",
            message: "websocket upstream target could not be reserved".to_string(),
        });
    }
    ctx.state.metrics.record_upstream_attempt();

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
        release_reserved_attempt(ctx, resolved);
        return NativeWsConnectOutcome::Unsupported(WsBridgeError {
            status: StatusCode::UPGRADE_REQUIRED,
            error_type: "upstream_websocket_capability_cached",
            message: "upstream websocket is cached as unsupported".to_string(),
        });
    }

    if ctx
        .state
        .caches
        .transport_capability
        .get(key, util::now_ms())
        == Some(WsCapability::NativeSupported)
    {
        // A recent native-WS success lets this request probe immediately instead of
        // serializing all healthy connects behind the single-flight lock.
        return connect_upstream_ws_once(ctx, resolved, key).await;
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
            release_reserved_attempt(ctx, resolved);
            return NativeWsConnectOutcome::Unsupported(WsBridgeError {
                status: StatusCode::UPGRADE_REQUIRED,
                error_type: "upstream_websocket_capability_cached",
                message: "upstream websocket is cached as unsupported".to_string(),
            });
        }
        Some(WsCapability::NativeSupported) => {
            return connect_upstream_ws_once(ctx, resolved, key).await;
        }
        None => {}
    }

    connect_upstream_ws_once(ctx, resolved, key).await
}

async fn connect_upstream_ws_once(
    ctx: &WsContext,
    resolved: &ResolvedUpstream,
    key: TransportCapabilityKey,
) -> NativeWsConnectOutcome {
    let start = Instant::now();
    let ws_url = match build_upstream_ws_url(&resolved.endpoint.base_url) {
        Ok(ws_url) => ws_url,
        Err(message) => {
            proxy::record_pre_stream_outcome(
                &ctx.state,
                resolved,
                Some(StatusCode::BAD_REQUEST.as_u16() as i32),
                Some("invalid_upstream_uri"),
                Some(&message),
                Some(start.elapsed().as_millis() as i64),
            );
            let now_ms = util::now_ms();
            ctx.state
                .endpoint_health
                .release_probe(resolved.endpoint.id, now_ms);
            ctx.state
                .upstream_key_health
                .release_probe(resolved.key.id, now_ms);
            return NativeWsConnectOutcome::Failed(WsBridgeError {
                status: StatusCode::BAD_REQUEST,
                error_type: "invalid_upstream_uri",
                message,
            });
        }
    };

    let headers = build_upstream_ws_headers(&ctx.request_headers, &resolved.key.secret);
    match connect_upstream_ws(&ctx.state, &ws_url, &headers).await {
        Ok(ws) => {
            ctx.state
                .caches
                .transport_capability
                .mark_native_supported(key, util::now_ms());
            proxy::record_pre_stream_outcome(
                &ctx.state,
                resolved,
                Some(StatusCode::SWITCHING_PROTOCOLS.as_u16() as i32),
                None,
                None,
                Some(start.elapsed().as_millis() as i64),
            );
            NativeWsConnectOutcome::Connected(Box::new(ws))
        }
        Err(err) => {
            if is_deterministic_ws_unsupported(err.status) {
                release_reserved_attempt(ctx, resolved);
                ctx.state
                    .caches
                    .transport_capability
                    .mark_native_unsupported(key, util::now_ms());
                NativeWsConnectOutcome::Unsupported(err)
            } else {
                proxy::record_pre_stream_outcome(
                    &ctx.state,
                    resolved,
                    Some(err.status.as_u16() as i32),
                    Some(err.error_type),
                    Some(&err.message),
                    Some(start.elapsed().as_millis() as i64),
                );
                NativeWsConnectOutcome::Failed(err)
            }
        }
    }
}

fn release_reserved_attempt(ctx: &WsContext, resolved: &ResolvedUpstream) {
    let now_ms = util::now_ms();
    ctx.state
        .endpoint_health
        .release_probe(resolved.endpoint.id, now_ms);
    ctx.state
        .upstream_key_health
        .release_probe(resolved.key.id, now_ms);
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
    })?;
    for (name, value) in headers {
        let name =
            WsHeaderName::from_bytes(name.as_str().as_bytes()).map_err(|err| WsBridgeError {
                status: StatusCode::BAD_REQUEST,
                error_type: "invalid_upstream_header",
                message: err.to_string(),
            })?;
        let value = WsHeaderValue::from_bytes(value.as_bytes()).map_err(|err| WsBridgeError {
            status: StatusCode::BAD_REQUEST,
            error_type: "invalid_upstream_header",
            message: err.to_string(),
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
            }
        }
        WsError::Io(err) => WsBridgeError {
            status: StatusCode::BAD_GATEWAY,
            error_type: "upstream_websocket_io_error",
            message: err.to_string(),
        },
        other => WsBridgeError {
            status: StatusCode::BAD_GATEWAY,
            error_type: "upstream_websocket_error",
            message: other.to_string(),
        },
    }
}

async fn forward_response_create<D, E>(
    ctx: &WsContext,
    downstream: &mut D,
    active: &mut ActiveUpstream,
    payload: String,
) -> bool
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
) -> bool
where
    D: Sink<Message, Error = E> + Unpin,
    E: Display,
{
    if let Err(err) = ws.send(Message::Text(payload.into())).await {
        let message = format!("failed to send websocket request upstream: {err}");
        let outcome = TurnOutcome::error(
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
        );
        let _ = send_ws_error(
            downstream,
            outcome.status,
            outcome.error_type.as_deref().unwrap_or("upstream_error"),
            &message,
        )
        .await;
        return false;
    }

    let t_stream_ms = Some(turn_start.elapsed().as_millis() as i64);
    let mut first_byte_ms = None;
    let mut first_token_ms = None;
    let mut usage = Usage::default();
    let mut usage_observed = false;

    loop {
        let polled =
            tokio::time::timeout(ctx.state.config.upstream_request_timeout, ws.next()).await;
        let message = match polled {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(err))) => {
                let error_message = err.to_string();
                let outcome = TurnOutcome::from_parts(
                    StatusCode::BAD_GATEWAY,
                    Some("upstream_websocket_read_error".to_string()),
                    Some(error_message.clone()),
                    t_stream_ms,
                    first_byte_ms,
                    first_token_ms,
                    usage,
                    usage_observed,
                    turn_start,
                );
                record_turn(
                    ctx,
                    resolved,
                    requested_model,
                    TurnTransport::NativeWs,
                    &outcome,
                    telemetry_permit,
                );
                let _ = send_ws_error(
                    downstream,
                    outcome.status,
                    outcome.error_type.as_deref().unwrap_or("upstream_error"),
                    &error_message,
                )
                .await;
                return false;
            }
            Ok(None) => {
                let error_message =
                    "upstream websocket closed before response completed".to_string();
                let outcome = TurnOutcome::from_parts(
                    StatusCode::BAD_GATEWAY,
                    Some("upstream_websocket_closed".to_string()),
                    Some(error_message.clone()),
                    t_stream_ms,
                    first_byte_ms,
                    first_token_ms,
                    usage,
                    usage_observed,
                    turn_start,
                );
                record_turn(
                    ctx,
                    resolved,
                    requested_model,
                    TurnTransport::NativeWs,
                    &outcome,
                    telemetry_permit,
                );
                let _ = send_ws_error(
                    downstream,
                    outcome.status,
                    "upstream_websocket_closed",
                    &error_message,
                )
                .await;
                return false;
            }
            Err(_) => {
                let error_message = format!(
                    "upstream websocket timeout after {:?}",
                    ctx.state.config.upstream_request_timeout
                );
                let outcome = TurnOutcome::from_parts(
                    StatusCode::GATEWAY_TIMEOUT,
                    Some("upstream_timeout".to_string()),
                    Some(error_message.clone()),
                    t_stream_ms,
                    first_byte_ms,
                    first_token_ms,
                    usage,
                    usage_observed,
                    turn_start,
                );
                record_turn(
                    ctx,
                    resolved,
                    requested_model,
                    TurnTransport::NativeWs,
                    &outcome,
                    telemetry_permit,
                );
                let _ = send_ws_error(
                    downstream,
                    outcome.status,
                    "upstream_timeout",
                    &error_message,
                )
                .await;
                return false;
            }
        };

        match message {
            Message::Text(text) => {
                if first_byte_ms.is_none() {
                    first_byte_ms = Some(turn_start.elapsed().as_millis() as i64);
                }

                let text_for_parse = text.to_string();
                let event = serde_json::from_str::<Value>(&text_for_parse).ok();
                if first_token_ms.is_none() && event.as_ref().is_some_and(is_responses_delta_event)
                {
                    first_token_ms = Some(turn_start.elapsed().as_millis() as i64);
                }
                if let Some(event) = event.as_ref()
                    && let Some(parsed) = parse_response_event_usage(event)
                {
                    usage = parsed;
                    usage_observed = true;
                }

                if downstream.send(Message::Text(text)).await.is_err() {
                    return false;
                }

                if let Some(event) = event.as_ref()
                    && is_terminal_response_event(event)
                {
                    let (status, error_type, error_message) = terminal_status(event);
                    let outcome = TurnOutcome::from_parts(
                        status,
                        error_type,
                        error_message,
                        t_stream_ms,
                        first_byte_ms,
                        first_token_ms,
                        usage,
                        usage_observed,
                        turn_start,
                    );
                    record_turn(
                        ctx,
                        resolved,
                        requested_model,
                        TurnTransport::NativeWs,
                        &outcome,
                        telemetry_permit,
                    );
                    return true;
                }
            }
            Message::Binary(bytes) => {
                if first_byte_ms.is_none() {
                    first_byte_ms = Some(turn_start.elapsed().as_millis() as i64);
                }
                if downstream.send(Message::Binary(bytes)).await.is_err() {
                    return false;
                }
            }
            Message::Ping(payload) => {
                if ws.send(Message::Pong(payload)).await.is_err() {
                    return false;
                }
            }
            Message::Pong(_) => {}
            Message::Close(frame) => {
                let error_message =
                    "upstream websocket closed before terminal response event".to_string();
                let outcome = TurnOutcome::from_parts(
                    StatusCode::BAD_GATEWAY,
                    Some("upstream_websocket_closed".to_string()),
                    Some(error_message),
                    t_stream_ms,
                    first_byte_ms,
                    first_token_ms,
                    usage,
                    usage_observed,
                    turn_start,
                );
                record_turn(
                    ctx,
                    resolved,
                    requested_model,
                    TurnTransport::NativeWs,
                    &outcome,
                    telemetry_permit,
                );
                let _ = downstream.send(Message::Close(frame)).await;
                return false;
            }
            Message::Frame(_) => {}
        }
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
) -> bool
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
            );
            let _ = send_ws_error(downstream, outcome.status, "invalid_payload", &message).await;
            return false;
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
            );
            let _ = send_ws_error(downstream, outcome.status, "invalid_payload", &message).await;
            return false;
        }
    };

    let upstream_uri = match build_upstream_http_responses_uri(&resolved.endpoint.base_url) {
        Ok(uri) => uri,
        Err(message) => {
            let outcome = TurnOutcome::error(
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
            );
            let _ =
                send_ws_error(downstream, outcome.status, "invalid_upstream_uri", &message).await;
            return false;
        }
    };

    let mut headers =
        build_upstream_http_bridge_headers(&ctx.request_headers, &resolved.key.secret, body.len());
    let response = proxy::dispatch_upstream_request(
        &ctx.state,
        &Method::POST,
        hyper::Version::HTTP_11,
        &headers,
        body,
        upstream_uri,
    )
    .await;
    headers.clear();

    let upstream_resp = match response {
        Ok(response) => response,
        Err(error) => {
            let (status, error_type, message) = proxy::dispatch_error_to_http(error, &ctx.state);
            let outcome = TurnOutcome::error(status, error_type, message.clone(), turn_start);
            record_turn(
                ctx,
                resolved,
                requested_model,
                TurnTransport::HttpBridge,
                &outcome,
                telemetry_permit,
            );
            let _ = send_ws_error(downstream, outcome.status, error_type, &message).await;
            return false;
        }
    };

    let t_stream_ms = Some(turn_start.elapsed().as_millis() as i64);
    let status = upstream_resp.status();
    let status_i32 = status.as_u16() as i32;
    let (parts, mut body) = upstream_resp.into_parts();
    let is_sse = parts
        .headers
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("text/event-stream"))
        .unwrap_or(false);

    let mut first_byte_ms = None;
    let mut first_token_ms = None;
    let mut usage = Usage::default();
    let mut usage_observed = false;
    let mut terminal: Option<(StatusCode, Option<String>, Option<String>)> = None;
    let mut sse = SseToWsParser::new();
    let mut capture = BytesMut::new();

    loop {
        let polled =
            tokio::time::timeout(ctx.state.config.upstream_request_timeout, body.frame()).await;
        let frame = match polled {
            Ok(Some(Ok(frame))) => frame,
            Ok(Some(Err(err))) => {
                let message = err.to_string();
                let outcome = TurnOutcome::from_parts(
                    StatusCode::BAD_GATEWAY,
                    Some("upstream_body_error".to_string()),
                    Some(message.clone()),
                    t_stream_ms,
                    first_byte_ms,
                    first_token_ms,
                    usage,
                    usage_observed,
                    turn_start,
                );
                record_turn(
                    ctx,
                    resolved,
                    requested_model,
                    TurnTransport::HttpBridge,
                    &outcome,
                    telemetry_permit,
                );
                let _ = send_ws_error(downstream, outcome.status, "upstream_body_error", &message)
                    .await;
                return false;
            }
            Ok(None) => break,
            Err(_) => {
                let message = format!(
                    "upstream HTTP bridge timeout after {:?}",
                    ctx.state.config.upstream_request_timeout
                );
                let outcome = TurnOutcome::from_parts(
                    StatusCode::GATEWAY_TIMEOUT,
                    Some("upstream_timeout".to_string()),
                    Some(message.clone()),
                    t_stream_ms,
                    first_byte_ms,
                    first_token_ms,
                    usage,
                    usage_observed,
                    turn_start,
                );
                record_turn(
                    ctx,
                    resolved,
                    requested_model,
                    TurnTransport::HttpBridge,
                    &outcome,
                    telemetry_permit,
                );
                let _ =
                    send_ws_error(downstream, outcome.status, "upstream_timeout", &message).await;
                return false;
            }
        };

        let Some(data) = frame.data_ref() else {
            continue;
        };
        if first_byte_ms.is_none() {
            first_byte_ms = Some(turn_start.elapsed().as_millis() as i64);
        }

        if is_sse {
            let events = sse.push_bytes(data);
            for event in events {
                if first_token_ms.is_none() && is_responses_delta_event(&event) {
                    first_token_ms = Some(turn_start.elapsed().as_millis() as i64);
                }
                if let Some(parsed) = parse_response_event_usage(&event) {
                    usage = parsed;
                    usage_observed = true;
                }
                if downstream
                    .send(Message::Text(event.to_string().into()))
                    .await
                    .is_err()
                {
                    return false;
                }
                if is_terminal_response_event(&event) {
                    terminal = Some(terminal_status(&event));
                }
            }
        } else {
            capture.extend_from_slice(data);
        }
    }

    if is_sse {
        for event in sse.finish() {
            if downstream
                .send(Message::Text(event.to_string().into()))
                .await
                .is_err()
            {
                return false;
            }
            if is_terminal_response_event(&event) {
                terminal = Some(terminal_status(&event));
            }
        }
    } else if !capture.is_empty() {
        let event = json_response_to_ws_event(status, &capture);
        if let Some(parsed) = event
            .get("response")
            .and_then(|response| response.get("usage"))
            .and_then(proxy::parse_responses_usage)
        {
            usage = parsed;
            usage_observed = true;
        }
        if downstream
            .send(Message::Text(event.to_string().into()))
            .await
            .is_err()
        {
            return false;
        }
        terminal = Some(terminal_status(&event));
    }

    let (final_status, error_type, error_message) = terminal.unwrap_or_else(|| {
        if status.is_success() {
            (StatusCode::OK, None, None)
        } else {
            (
                status,
                Some("upstream_http_error".to_string()),
                Some(format!("upstream HTTP bridge returned status {status_i32}")),
            )
        }
    });
    let outcome = TurnOutcome::from_parts(
        final_status,
        error_type,
        error_message,
        t_stream_ms,
        first_byte_ms,
        first_token_ms,
        usage,
        usage_observed,
        turn_start,
    );
    record_turn(
        ctx,
        resolved,
        requested_model,
        TurnTransport::HttpBridge,
        &outcome,
        telemetry_permit,
    );
    final_status.is_success() && outcome.error_type.is_none()
}

impl TurnOutcome {
    fn error(
        status: StatusCode,
        error_type: impl Into<String>,
        error_message: String,
        start: Instant,
    ) -> Self {
        Self::from_parts(
            status,
            Some(error_type.into()),
            Some(error_message),
            None,
            None,
            None,
            Usage::default(),
            false,
            start,
        )
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
) {
    let (cost_in, cost_out) = proxy::compute_cost(&outcome.usage, resolved.price.as_ref());
    let status_i32 = outcome.status.as_u16() as i32;
    let error_type = outcome.error_type.as_deref();
    let error_message = outcome.error_message.as_deref();
    let observed_latency_ms = outcome
        .t_first_byte_ms
        .or(outcome.t_first_token_ms)
        .or(outcome.t_stream_ms);

    proxy::record_pre_stream_outcome(
        &ctx.state,
        resolved,
        Some(status_i32),
        error_type,
        error_message,
        observed_latency_ms,
    );
    ctx.state.metrics.record_request(
        ApiFormat::Responses,
        RequestMetric {
            http_status: Some(status_i32),
            error_type,
            duration_ms: Some(outcome.duration_ms),
            usage: outcome.usage,
            cost_in_usd: cost_in,
            cost_out_usd: cost_out,
        },
    );

    let Some(permit) = telemetry_permit.take() else {
        return;
    };
    let _ = permit.send(TelemetryEvent {
        id: None,
        api_key_id: ctx.api_key.id,
        log_enabled: ctx.api_key.log_enabled,
        provider_id: Some(resolved.provider.id),
        endpoint_id: Some(resolved.endpoint.id),
        upstream_key_id: Some(resolved.key.id),
        api_format: "responses",
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
        cost_in_usd: cost_in,
        cost_out_usd: cost_out,
        time_ms: util::now_ms(),
        span_kind: "ws_turn",
        transport: transport.as_log_value(),
        parent_id: Some(ctx.session_log_id.clone()),
        ws_session_id: Some(ctx.session_id.clone()),
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
            cost_in_usd: Decimal::ZERO,
            cost_out_usd: Decimal::ZERO,
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
        cost_in_usd: Decimal::ZERO,
        cost_out_usd: Decimal::ZERO,
        time_ms: util::now_ms(),
        span_kind: "ws_turn",
        transport: TurnTransport::WsSetup.as_log_value(),
        parent_id: Some(ctx.session_log_id.clone()),
        ws_session_id: Some(ctx.session_id.clone()),
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
        cost_in_usd: Decimal::ZERO,
        cost_out_usd: Decimal::ZERO,
        time_ms: ctx.session_started_at_ms,
        span_kind: "ws_session",
        transport: "ws",
        parent_id: None,
        ws_session_id: Some(ctx.session_id.clone()),
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
    let _ = permit.send(TelemetryEvent {
        id: None,
        api_key_id: ctx.api_key.id,
        log_enabled: ctx.api_key.log_enabled,
        provider_id: None,
        endpoint_id: None,
        upstream_key_id: None,
        api_format: "responses",
        model: None,
        http_status: Some(status.as_u16() as i32),
        error_type,
        error_message,
        t_stream_ms: None,
        t_first_byte_ms: None,
        t_first_token_ms: None,
        duration_ms: Some(util::now_ms().saturating_sub(ctx.session_started_at_ms)),
        usage: Usage::default(),
        usage_observed: false,
        cost_in_usd: Decimal::ZERO,
        cost_out_usd: Decimal::ZERO,
        time_ms: util::now_ms(),
        span_kind: "ws_session_close",
        transport: "ws",
        parent_id: Some(ctx.session_log_id.clone()),
        ws_session_id: Some(ctx.session_id.clone()),
    });
}

fn is_responses_delta_event(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|event_type| event_type.ends_with(".delta"))
        && proxy::responses_has_delta(value)
}

fn parse_response_event_usage(value: &Value) -> Option<Usage> {
    value
        .get("response")
        .and_then(|response| response.get("usage"))
        .and_then(proxy::parse_responses_usage)
}

fn is_terminal_response_event(value: &Value) -> bool {
    matches!(
        value.get("type").and_then(Value::as_str),
        Some(
            "response.completed"
                | "response.failed"
                | "response.incomplete"
                | "response.cancelled"
                | "error"
        )
    )
}

fn terminal_status(value: &Value) -> (StatusCode, Option<String>, Option<String>) {
    match value.get("type").and_then(Value::as_str) {
        Some("response.completed") => return (StatusCode::OK, None, None),
        Some("response.failed") => {
            return response_failure_status(value, "response_failed", "response failed");
        }
        Some("response.incomplete") => {
            return response_incomplete_status(value);
        }
        Some("response.cancelled") => {
            return response_cancelled_status(value);
        }
        _ => {}
    }

    let error = value.get("error");
    let status = status_from_value(Some(value))
        .or_else(|| status_from_value(error))
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let code = error
        .and_then(|error| error.get("code").or_else(|| error.get("type")))
        .and_then(Value::as_str)
        .unwrap_or("upstream_error")
        .to_string();
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("upstream websocket returned an error")
        .to_string();
    (status, Some(code), Some(message))
}

fn response_failure_status(
    value: &Value,
    fallback_code: &'static str,
    fallback_message: &'static str,
) -> (StatusCode, Option<String>, Option<String>) {
    let response = value.get("response");
    let error = response
        .and_then(|response| response.get("error"))
        .or_else(|| value.get("error"));
    let status = status_from_value(response)
        .or_else(|| status_from_value(error))
        .or_else(|| status_from_value(Some(value)))
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let (code, message) = error_fields(error, fallback_code, fallback_message);
    (status, Some(code), Some(message))
}

fn response_incomplete_status(value: &Value) -> (StatusCode, Option<String>, Option<String>) {
    let response = value.get("response");
    if response
        .and_then(|response| response.get("error"))
        .or_else(|| value.get("error"))
        .is_some()
    {
        return response_failure_status(value, "response_incomplete", "response incomplete");
    }

    let details = response.and_then(|response| response.get("incomplete_details"));
    let reason = details
        .and_then(|details| details.get("reason"))
        .and_then(Value::as_str)
        .or_else(|| {
            response
                .and_then(|response| response.get("status"))
                .and_then(Value::as_str)
        })
        .unwrap_or("response incomplete");
    let status = status_from_value(response)
        .or_else(|| status_from_value(Some(value)))
        .unwrap_or(StatusCode::OK);
    (
        status,
        Some("response_incomplete".to_string()),
        Some(reason.to_string()),
    )
}

fn response_cancelled_status(value: &Value) -> (StatusCode, Option<String>, Option<String>) {
    let response = value.get("response");
    if response
        .and_then(|response| response.get("error"))
        .or_else(|| value.get("error"))
        .is_some()
    {
        return response_failure_status(value, "response_cancelled", "response cancelled");
    }

    let status = status_from_value(response)
        .or_else(|| status_from_value(Some(value)))
        .unwrap_or(StatusCode::OK);
    (
        status,
        Some("response_cancelled".to_string()),
        Some("response cancelled".to_string()),
    )
}

fn status_from_value(value: Option<&Value>) -> Option<StatusCode> {
    let value = value?;
    let status = value.get("status").or_else(|| value.get("status_code"))?;
    let status = status.as_u64().or_else(|| {
        status
            .as_str()
            .and_then(|status| status.parse::<u64>().ok())
    })?;
    StatusCode::from_u16(status as u16).ok()
}

fn error_fields(
    error: Option<&Value>,
    fallback_code: &'static str,
    fallback_message: &'static str,
) -> (String, String) {
    let code = error
        .and_then(|error| error.get("code").or_else(|| error.get("type")))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_code)
        .to_string();
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_message)
        .to_string();
    (code, message)
}

struct SseToWsParser {
    buf: BytesMut,
    event_type: Option<String>,
    data_lines: Vec<String>,
}

impl SseToWsParser {
    fn new() -> Self {
        Self {
            buf: BytesMut::with_capacity(8 * 1024),
            event_type: None,
            data_lines: Vec::new(),
        }
    }

    fn push_bytes(&mut self, data: &Bytes) -> Vec<Value> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        while let Some(pos) = memchr::memchr(b'\n', &self.buf) {
            let mut line = self.buf.split_to(pos + 1);
            if line.ends_with(b"\n") {
                line.truncate(line.len() - 1);
            }
            if line.ends_with(b"\r") {
                line.truncate(line.len() - 1);
            }
            if line.is_empty() {
                if let Some(event) = self.take_event() {
                    out.push(event);
                }
                continue;
            }
            if line.starts_with(b":") {
                continue;
            }
            if let Some(rest) = line.strip_prefix(b"event:") {
                self.event_type = Some(String::from_utf8_lossy(rest).trim().to_string());
                continue;
            }
            if let Some(rest) = line.strip_prefix(b"data:") {
                let data = String::from_utf8_lossy(rest).trim_start().to_string();
                if data == "[DONE]" {
                    continue;
                }
                self.data_lines.push(data);
            }
        }
        self.cap_buffer();
        out
    }

    fn finish(&mut self) -> Vec<Value> {
        self.take_event().into_iter().collect()
    }

    fn take_event(&mut self) -> Option<Value> {
        if self.data_lines.is_empty() {
            self.event_type = None;
            return None;
        }
        let data = self.data_lines.join("\n");
        self.data_lines.clear();
        let event_type = self.event_type.take();
        let mut value = serde_json::from_str::<Value>(&data).unwrap_or_else(|_| {
            json!({
                "type": event_type.as_deref().unwrap_or("response.output_text.delta"),
                "delta": data
            })
        });
        if let Some(event_type) = event_type
            && value.get("type").is_none()
            && let Some(root) = value.as_object_mut()
        {
            root.insert("type".to_string(), Value::String(event_type));
        }
        Some(value)
    }

    fn cap_buffer(&mut self) {
        const MAX_BUF: usize = 128 * 1024;
        if self.buf.len() <= MAX_BUF {
            return;
        }
        let keep = MAX_BUF / 2;
        let start = self.buf.len().saturating_sub(keep);
        let tail = self.buf.split_off(start);
        self.buf = tail;
    }
}

fn json_response_to_ws_event(status: StatusCode, body: &[u8]) -> Value {
    let parsed = serde_json::from_slice::<Value>(body).unwrap_or_else(|_| {
        json!({
            "error": {
                "type": "upstream_error",
                "message": String::from_utf8_lossy(body)
            }
        })
    });

    if status.is_success() {
        return json!({
            "type": "response.completed",
            "response": parsed
        });
    }

    json!({
        "type": "error",
        "status": status.as_u16(),
        "error": parsed.get("error").cloned().unwrap_or(parsed)
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
    let path = RESPONSES_PATH
        .parse::<hyper::http::uri::PathAndQuery>()
        .map_err(|err| err.to_string())?;
    proxy::build_upstream_uri(base_url, Some(&path))
}

fn build_upstream_ws_url(base_url: &str) -> Result<String, String> {
    let trimmed_base = base_url.trim_end_matches('/');
    let base = trimmed_base.strip_suffix("/v1").unwrap_or(trimmed_base);
    let http_uri = format!("{base}{RESPONSES_PATH}")
        .parse::<Uri>()
        .map_err(|err| err.to_string())?;
    let mut parts = http_uri.into_parts();
    let next_scheme = match parts.scheme.as_ref().map(|scheme| scheme.as_str()) {
        Some("http" | "ws") => "ws",
        Some("https" | "wss") => "wss",
        Some(other) => return Err(format!("unsupported upstream scheme: {other}")),
        None => return Err("missing upstream scheme".to_string()),
    };
    parts.scheme = Some(next_scheme.parse().map_err(|err| format!("{err}"))?);
    Uri::from_parts(parts)
        .map(|uri| uri.to_string())
        .map_err(|err| err.to_string())
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
        let mut parser = SseToWsParser::new();

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
