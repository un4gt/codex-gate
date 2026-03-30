use std::collections::HashSet;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;

use bytes::{Bytes, BytesMut};
use http_body_util::Full;
use hyper::body::{Frame, Incoming, SizeHint};
use hyper::header::{
    AUTHORIZATION, CONNECTION, CONTENT_LENGTH, HOST, PROXY_AUTHENTICATE, PROXY_AUTHORIZATION, TE,
    TRAILER, TRANSFER_ENCODING, UPGRADE,
};
use hyper::{Method, Request, Response, StatusCode, Uri};
use memchr::memchr;
use pin_project_lite::pin_project;
use rust_decimal::Decimal;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time;

use crate::health::{should_trip_endpoint, should_trip_key};
use crate::http::{self, HttpResponse};
use crate::metrics::FailoverKind;
use crate::openai::{OpenAiRequestInfo, ensure_include_usage, parse_request_info};
use crate::selector;
use crate::state::SharedState;
use crate::telemetry::TelemetryEvent;
use crate::types::{ApiFormat, ModelPriceData, Usage};
use crate::util;

pub async fn handle(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    match (req.method(), path) {
        (&Method::POST, "/v1/chat/completions") => {
            proxy_openai(ApiFormat::ChatCompletions, req, state).await
        }
        (&Method::POST, "/v1/responses") => proxy_openai(ApiFormat::Responses, req, state).await,
        _ => http::json_error(StatusCode::NOT_FOUND, "not found"),
    }
}

async fn proxy_openai(
    api_format: ApiFormat,
    req: Request<Incoming>,
    state: SharedState,
) -> HttpResponse {
    let start = Instant::now();
    let _inflight = state.metrics.inflight_guard();
    let now_ms = util::now_ms();

    let record_request_metric = |http_status: Option<i32>, error_type: Option<&str>| {
        state.metrics.record_request(
            api_format,
            http_status,
            error_type,
            Some(start.elapsed().as_millis() as i64),
            &Usage::default(),
            Decimal::ZERO,
            Decimal::ZERO,
        );
    };

    let Some(api_key_plaintext) = http::bearer_token(&req) else {
        record_request_metric(
            Some(StatusCode::UNAUTHORIZED.as_u16() as i32),
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
            now_ms,
        )
        .await
    {
        Ok(v) => v,
        Err(e) => {
            record_request_metric(
                Some(StatusCode::INTERNAL_SERVER_ERROR.as_u16() as i32),
                Some("api_key_validate_failed"),
            );
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e);
        }
    };

    let Some(api_key) = auth else {
        record_request_metric(
            Some(StatusCode::UNAUTHORIZED.as_u16() as i32),
            Some("invalid_api_key"),
        );
        return http::json_error(StatusCode::UNAUTHORIZED, "invalid api key");
    };

    let mut telemetry_permit = match state.telemetry.reserve_permit().await {
        Ok(p) => Some(p),
        Err(_) => {
            record_request_metric(
                Some(StatusCode::SERVICE_UNAVAILABLE.as_u16() as i32),
                Some("telemetry_unavailable"),
            );
            return http::json_error(StatusCode::SERVICE_UNAVAILABLE, "telemetry unavailable");
        }
    };

    fn submit_with_permit(
        permit: &mut Option<mpsc::OwnedPermit<TelemetryEvent>>,
        event: TelemetryEvent,
    ) {
        let Some(permit) = permit.take() else {
            return;
        };
        let _ = permit.send(event);
    }

    let submit_err = |permit: &mut Option<mpsc::OwnedPermit<TelemetryEvent>>,
                      status: StatusCode,
                      error_type: &'static str,
                      error_message: String,
                      provider_id: Option<i64>,
                      endpoint_id: Option<i64>,
                      upstream_key_id: Option<i64>,
                      model: Option<String>| {
        submit_with_permit(
            permit,
            TelemetryEvent {
                api_key_id: api_key.id,
                log_enabled: api_key.log_enabled,
                provider_id,
                endpoint_id,
                upstream_key_id,
                api_format: match api_format {
                    ApiFormat::ChatCompletions => "chat_completions",
                    ApiFormat::Responses => "responses",
                },
                model,
                http_status: Some(status.as_u16() as i32),
                error_type: Some(error_type.to_string()),
                error_message: Some(error_message),
                t_stream_ms: None,
                t_first_byte_ms: None,
                t_first_token_ms: None,
                duration_ms: Some(start.elapsed().as_millis() as i64),
                usage: Usage::default(),
                cost_in_usd: Decimal::ZERO,
                cost_out_usd: Decimal::ZERO,
                time_ms: util::now_ms(),
            },
        );
    };

    let (parts, body_bytes) =
        match http::read_body_limited(req, state.config.max_request_bytes).await {
            Ok(v) => v,
            Err(resp) => {
                submit_err(
                    &mut telemetry_permit,
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request_too_large",
                    "request body too large".to_string(),
                    None,
                    None,
                    None,
                    None,
                );
                record_request_metric(
                    Some(StatusCode::PAYLOAD_TOO_LARGE.as_u16() as i32),
                    Some("request_too_large"),
                );
                return resp;
            }
        };

    let info = parse_request_info(&body_bytes);
    let Some(model_name) = info.model.clone() else {
        submit_err(
            &mut telemetry_permit,
            StatusCode::BAD_REQUEST,
            "missing_model",
            "missing model".to_string(),
            None,
            None,
            None,
            None,
        );
        record_request_metric(
            Some(StatusCode::BAD_REQUEST.as_u16() as i32),
            Some("missing_model"),
        );
        return http::json_error(StatusCode::BAD_REQUEST, "missing model");
    };

    let request_method = parts.method.clone();
    let request_version = parts.version;
    let request_headers = parts.headers.clone();
    let request_path_and_query = parts.uri.path_and_query().cloned();

    let api_format_str = match api_format {
        ApiFormat::ChatCompletions => "chat_completions",
        ApiFormat::Responses => "responses",
    };

    let attempts = match build_upstream_plan(&state, &model_name).await {
        Ok(v) => v,
        Err((status, msg)) => {
            submit_err(
                &mut telemetry_permit,
                status,
                "upstream_resolve_failed",
                msg.to_string(),
                None,
                None,
                None,
                Some(model_name.clone()),
            );
            record_request_metric(
                Some(status.as_u16() as i32),
                Some("upstream_resolve_failed"),
            );
            return http::json_error(status, msg);
        }
    };

    let mut exclusions = AttemptExclusions::default();
    let mut last_failure: Option<AttemptFailure> = None;

    for (index, resolved) in attempts.iter().enumerate() {
        if exclusions.should_skip(resolved) {
            continue;
        }

        if !reserve_attempt(&state, resolved, util::now_ms()) {
            continue;
        }
        state.metrics.record_upstream_attempt();

        let mut out_body = body_bytes.clone();
        if should_inject_include_usage(
            api_format,
            &info,
            resolved.provider.supports_include_usage,
            state.config.inject_include_usage,
        ) {
            if let Ok(body) = ensure_include_usage(out_body.clone()) {
                out_body = body;
            }
        }

        let upstream_uri = match build_upstream_uri(
            &resolved.endpoint.base_url,
            request_path_and_query.as_ref(),
        ) {
            Ok(uri) => uri,
            Err(error) => {
                record_pre_stream_outcome(
                    &state,
                    resolved,
                    Some(StatusCode::BAD_REQUEST.as_u16() as i32),
                    Some("invalid_upstream_uri"),
                    Some(&error),
                    None,
                );
                exclusions.note_attempt(resolved);
                exclusions.avoid_endpoint(resolved.endpoint.id);
                last_failure = Some(AttemptFailure::new(
                    resolved,
                    StatusCode::BAD_REQUEST,
                    "invalid_upstream_uri",
                    error.clone(),
                ));

                if has_remaining_candidate(&attempts, index + 1, &exclusions) {
                    state.metrics.record_failover(FailoverKind::Endpoint);
                    continue;
                }

                submit_err(
                    &mut telemetry_permit,
                    StatusCode::BAD_REQUEST,
                    "invalid_upstream_uri",
                    error.clone(),
                    Some(resolved.provider.id),
                    Some(resolved.endpoint.id),
                    Some(resolved.key.id),
                    Some(model_name.clone()),
                );
                record_request_metric(
                    Some(StatusCode::BAD_REQUEST.as_u16() as i32),
                    Some("invalid_upstream_uri"),
                );
                return http::json_error(StatusCode::BAD_REQUEST, error);
            }
        };

        let mut headers = request_headers.clone();
        sanitize_hop_headers(&mut headers);
        headers.remove(AUTHORIZATION);
        headers.remove(CONTENT_LENGTH);
        if let Ok(value) = hyper::header::HeaderValue::from_str(&out_body.len().to_string()) {
            headers.insert(CONTENT_LENGTH, value);
        }
        if let Ok(value) =
            hyper::header::HeaderValue::from_str(&format!("Bearer {}", resolved.key.secret))
        {
            headers.insert(AUTHORIZATION, value);
        }

        let mut upstream_req = Request::new(Full::new(out_body));
        *upstream_req.method_mut() = request_method.clone();
        *upstream_req.uri_mut() = upstream_uri;
        *upstream_req.version_mut() = request_version;
        *upstream_req.headers_mut() = headers;

        let upstream_resp = match time::timeout(
            state.config.upstream_request_timeout,
            state.upstream.request(upstream_req),
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                let error_message = error.to_string();
                record_pre_stream_outcome(
                    &state,
                    resolved,
                    Some(StatusCode::BAD_GATEWAY.as_u16() as i32),
                    Some("upstream_request_error"),
                    Some(&error_message),
                    None,
                );
                exclusions.note_attempt(resolved);
                exclusions.avoid_endpoint(resolved.endpoint.id);
                last_failure = Some(AttemptFailure::new(
                    resolved,
                    StatusCode::BAD_GATEWAY,
                    "upstream_request_error",
                    error_message.clone(),
                ));

                if has_remaining_candidate(&attempts, index + 1, &exclusions) {
                    state.metrics.record_failover(FailoverKind::Endpoint);
                    continue;
                }

                submit_err(
                    &mut telemetry_permit,
                    StatusCode::BAD_GATEWAY,
                    "upstream_request_error",
                    error_message.clone(),
                    Some(resolved.provider.id),
                    Some(resolved.endpoint.id),
                    Some(resolved.key.id),
                    Some(model_name.clone()),
                );
                record_request_metric(
                    Some(StatusCode::BAD_GATEWAY.as_u16() as i32),
                    Some("upstream_request_error"),
                );
                return http::json_error(
                    StatusCode::BAD_GATEWAY,
                    format!("upstream error: {error}"),
                );
            }
            Err(_) => {
                let error_message = format!(
                    "upstream request timeout after {:?}",
                    state.config.upstream_request_timeout
                );
                record_pre_stream_outcome(
                    &state,
                    resolved,
                    Some(StatusCode::GATEWAY_TIMEOUT.as_u16() as i32),
                    Some("upstream_timeout"),
                    Some(&error_message),
                    None,
                );
                exclusions.note_attempt(resolved);
                exclusions.avoid_endpoint(resolved.endpoint.id);
                last_failure = Some(AttemptFailure::new(
                    resolved,
                    StatusCode::GATEWAY_TIMEOUT,
                    "upstream_timeout",
                    error_message.clone(),
                ));

                if has_remaining_candidate(&attempts, index + 1, &exclusions) {
                    state.metrics.record_failover(FailoverKind::Endpoint);
                    continue;
                }

                submit_err(
                    &mut telemetry_permit,
                    StatusCode::GATEWAY_TIMEOUT,
                    "upstream_timeout",
                    error_message.clone(),
                    Some(resolved.provider.id),
                    Some(resolved.endpoint.id),
                    Some(resolved.key.id),
                    Some(model_name.clone()),
                );
                record_request_metric(
                    Some(StatusCode::GATEWAY_TIMEOUT.as_u16() as i32),
                    Some("upstream_timeout"),
                );
                return http::json_error(StatusCode::GATEWAY_TIMEOUT, "upstream timeout");
            }
        };

        let t_stream_ms = start.elapsed().as_millis() as i64;
        let status_code = upstream_resp.status();
        let status_i32 = status_code.as_u16() as i32;
        if should_retry_response_status(status_i32)
            && has_remaining_candidate(&attempts, index + 1, &exclusions)
        {
            record_pre_stream_outcome(
                &state,
                resolved,
                Some(status_i32),
                None,
                None,
                Some(t_stream_ms),
            );
            exclusions.note_attempt(resolved);
            let failover_kind = if should_avoid_key_on_retry(Some(status_i32), None) {
                exclusions.avoid_key(resolved.key.id);
                FailoverKind::Key
            } else if should_avoid_endpoint_on_retry(Some(status_i32), None) {
                exclusions.avoid_endpoint(resolved.endpoint.id);
                FailoverKind::Endpoint
            } else {
                FailoverKind::Generic
            };
            state.metrics.record_failover(failover_kind);
            last_failure = Some(AttemptFailure::new(
                resolved,
                status_code,
                "upstream_retry_status",
                format!("retryable upstream status {status_i32}"),
            ));
            drop(upstream_resp);
            continue;
        }

        let (mut resp_parts, body) = upstream_resp.into_parts();
        sanitize_hop_headers(&mut resp_parts.headers);

        let is_sse = resp_parts
            .headers
            .get(hyper::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.contains("text/event-stream"))
            .unwrap_or(false);

        let tap = ProxyTapBody::new(
            body,
            TapConfig {
                api_key_id: api_key.id,
                log_enabled: api_key.log_enabled,
                provider_id: Some(resolved.provider.id),
                endpoint_id: Some(resolved.endpoint.id),
                upstream_key_id: Some(resolved.key.id),
                api_format: api_format_str,
                model: Some(model_name.clone()),
                http_status: Some(resp_parts.status.as_u16() as i32),
                t_stream_ms: Some(t_stream_ms),
                start,
                is_sse,
                price: resolved.price.clone(),
                max_response_bytes: state.config.max_response_bytes,
                endpoint_health: state.endpoint_health.clone(),
                upstream_key_health: state.upstream_key_health.clone(),
                metrics: state.metrics.clone(),
            },
            telemetry_permit.take(),
        );

        return Response::from_parts(resp_parts, http::boxed(tap));
    }

    let failure = last_failure.unwrap_or_else(|| AttemptFailure {
        provider_id: None,
        endpoint_id: None,
        upstream_key_id: None,
        status: StatusCode::SERVICE_UNAVAILABLE,
        error_type: "upstream_retry_exhausted",
        error_message: "no available upstream targets after retries".to_string(),
    });

    submit_err(
        &mut telemetry_permit,
        failure.status,
        failure.error_type,
        failure.error_message.clone(),
        failure.provider_id,
        failure.endpoint_id,
        failure.upstream_key_id,
        Some(model_name.clone()),
    );
    record_request_metric(
        Some(failure.status.as_u16() as i32),
        Some(failure.error_type),
    );
    http::json_error(failure.status, failure.error_message)
}

fn should_inject_include_usage(
    api_format: ApiFormat,
    info: &OpenAiRequestInfo,
    provider_supports: bool,
    inject_enabled: bool,
) -> bool {
    if !inject_enabled || !provider_supports {
        return false;
    }
    match api_format {
        ApiFormat::ChatCompletions => info.stream,
        ApiFormat::Responses => false,
    }
}

#[derive(Clone)]
struct ResolvedUpstream {
    provider: crate::types::UpstreamProvider,
    endpoint: crate::types::UpstreamEndpoint,
    key: crate::types::UpstreamKey,
    price: Option<ModelPriceData>,
}

#[derive(Default)]
struct AttemptExclusions {
    attempted_pairs: HashSet<(i64, i64)>,
    endpoint_ids: HashSet<i64>,
    key_ids: HashSet<i64>,
}

impl AttemptExclusions {
    fn should_skip(&self, resolved: &ResolvedUpstream) -> bool {
        self.endpoint_ids.contains(&resolved.endpoint.id)
            || self.key_ids.contains(&resolved.key.id)
            || self
                .attempted_pairs
                .contains(&(resolved.key.id, resolved.endpoint.id))
    }

    fn note_attempt(&mut self, resolved: &ResolvedUpstream) {
        self.attempted_pairs
            .insert((resolved.key.id, resolved.endpoint.id));
    }

    fn avoid_endpoint(&mut self, endpoint_id: i64) {
        self.endpoint_ids.insert(endpoint_id);
    }

    fn avoid_key(&mut self, key_id: i64) {
        self.key_ids.insert(key_id);
    }
}

struct AttemptFailure {
    provider_id: Option<i64>,
    endpoint_id: Option<i64>,
    upstream_key_id: Option<i64>,
    status: StatusCode,
    error_type: &'static str,
    error_message: String,
}

impl AttemptFailure {
    fn new(
        resolved: &ResolvedUpstream,
        status: StatusCode,
        error_type: &'static str,
        error_message: String,
    ) -> Self {
        Self {
            provider_id: Some(resolved.provider.id),
            endpoint_id: Some(resolved.endpoint.id),
            upstream_key_id: Some(resolved.key.id),
            status,
            error_type,
            error_message,
        }
    }
}

async fn build_upstream_plan(
    state: &SharedState,
    model: &str,
) -> Result<Vec<ResolvedUpstream>, (StatusCode, &'static str)> {
    let snap = state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to load upstream config",
            )
        })?;

    let candidates: Vec<&crate::types::UpstreamProvider> =
        if let Some(route) = snap.routes_by_model.get(model) {
            if route.enabled && !route.provider_ids.is_empty() {
                snap.providers
                    .iter()
                    .filter(|provider| route.provider_ids.contains(&provider.id))
                    .collect()
            } else {
                snap.providers.iter().collect()
            }
        } else {
            snap.providers.iter().collect()
        };

    let now_ms = util::now_ms();
    let ranked_providers = selector::rank_provider_refs_with_health(
        &candidates,
        &snap.keys_by_provider,
        &snap.endpoints_by_provider,
        &state.upstream_key_health,
        &state.endpoint_health,
        now_ms,
    );
    if ranked_providers.is_empty() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "no available providers"));
    }

    let mut attempts = Vec::new();
    for provider in ranked_providers {
        let keys = snap
            .keys_by_provider
            .get(&provider.id)
            .map(|items| items.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        let ranked_keys =
            selector::rank_key_refs_with_health(&keys, &state.upstream_key_health, now_ms);
        if ranked_keys.is_empty() {
            continue;
        }

        let endpoints = snap
            .endpoints_by_provider
            .get(&provider.id)
            .map(|items| items.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        let ranked_endpoints = selector::rank_endpoint_refs_with_health(
            &endpoints,
            &state.endpoint_health,
            state.config.endpoint_selector_strategy,
            now_ms,
        );
        if ranked_endpoints.is_empty() {
            continue;
        }

        let price = snap.find_price(provider.id, model);
        for key in &ranked_keys {
            for endpoint in &ranked_endpoints {
                attempts.push(ResolvedUpstream {
                    provider: provider.clone(),
                    endpoint: (*endpoint).clone(),
                    key: (*key).clone(),
                    price: price.clone(),
                });
            }
        }
    }

    if attempts.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "no available upstream targets",
        ));
    }

    Ok(attempts)
}

fn reserve_attempt(state: &SharedState, resolved: &ResolvedUpstream, now_ms: i64) -> bool {
    if !state
        .upstream_key_health
        .try_acquire(resolved.key.id, now_ms)
    {
        return false;
    }
    if !state
        .endpoint_health
        .try_acquire(resolved.endpoint.id, now_ms)
    {
        state
            .upstream_key_health
            .release_probe(resolved.key.id, now_ms);
        return false;
    }
    true
}

fn has_remaining_candidate(
    attempts: &[ResolvedUpstream],
    start_index: usize,
    exclusions: &AttemptExclusions,
) -> bool {
    attempts[start_index..]
        .iter()
        .any(|resolved| !exclusions.should_skip(resolved))
}

fn should_retry_response_status(status: i32) -> bool {
    matches!(status, 401 | 403 | 408 | 409 | 429) || status >= 500
}

fn should_avoid_endpoint_on_retry(status: Option<i32>, error_type: Option<&str>) -> bool {
    error_type.is_some()
        || matches!(status, Some(408 | 409 | 429))
        || status.is_some_and(|code| code >= 500)
}

fn should_avoid_key_on_retry(status: Option<i32>, _error_type: Option<&str>) -> bool {
    matches!(status, Some(401 | 403))
}

fn record_pre_stream_outcome(
    state: &SharedState,
    resolved: &ResolvedUpstream,
    status: Option<i32>,
    error_type: Option<&str>,
    error_message: Option<&str>,
    observed_latency_ms: Option<i64>,
) {
    record_endpoint_outcome_for_id(
        &state.endpoint_health,
        Some(resolved.endpoint.id),
        status,
        observed_latency_ms,
        error_type,
        error_message,
    );
    record_upstream_key_outcome_for_id(
        &state.upstream_key_health,
        Some(resolved.key.id),
        status,
        observed_latency_ms,
        error_type,
        error_message,
    );
}
fn build_upstream_uri(
    base_url: &str,
    path_and_query: Option<&hyper::http::uri::PathAndQuery>,
) -> Result<Uri, String> {
    let Some(pq) = path_and_query else {
        return Err("missing path".to_string());
    };

    let pq_str = pq.as_str();
    let trimmed_base = base_url.trim_end_matches('/');
    let base = if pq_str.starts_with("/v1/") {
        trimmed_base.strip_suffix("/v1").unwrap_or(trimmed_base)
    } else {
        trimmed_base
    };

    let mut out = String::with_capacity(base_url.len() + 128);
    out.push_str(base);
    out.push_str(pq.as_str());
    out.parse::<Uri>().map_err(|e| e.to_string())
}

fn sanitize_hop_headers(headers: &mut hyper::HeaderMap) {
    headers.remove(CONNECTION);
    headers.remove(TRANSFER_ENCODING);
    headers.remove(UPGRADE);
    headers.remove(TE);
    headers.remove(TRAILER);
    headers.remove(PROXY_AUTHENTICATE);
    headers.remove(PROXY_AUTHORIZATION);
    headers.remove(HOST);
}

#[derive(Clone)]
struct TapConfig {
    api_key_id: i64,
    log_enabled: bool,
    provider_id: Option<i64>,
    endpoint_id: Option<i64>,
    upstream_key_id: Option<i64>,
    api_format: &'static str,
    model: Option<String>,
    http_status: Option<i32>,
    t_stream_ms: Option<i64>,
    start: Instant,
    is_sse: bool,
    price: Option<ModelPriceData>,
    max_response_bytes: usize,
    endpoint_health: std::sync::Arc<crate::health::EndpointHealthBook>,
    upstream_key_health: std::sync::Arc<crate::health::UpstreamKeyHealthBook>,
    metrics: std::sync::Arc<crate::metrics::Metrics>,
}

pin_project! {
    struct ProxyTapBody {
        #[pin]
        inner: Incoming,
        cfg: TapConfig,
        telemetry_permit: Option<mpsc::OwnedPermit<TelemetryEvent>>,

        finalized: bool,
        first_byte_ms: Option<i64>,
        first_token_ms: Option<i64>,
        usage: Usage,
        error_type: Option<String>,
        error_message: Option<String>,

        collected: BytesMut,
        sse: Option<SseParser>,
    }

    impl PinnedDrop for ProxyTapBody {
        fn drop(this: Pin<&mut Self>) {
            let this = this.project();
            finalize_tap(
                this.cfg,
                this.telemetry_permit,
                this.finalized,
                *this.first_byte_ms,
                *this.first_token_ms,
                this.usage,
                this.error_type,
                this.error_message,
                this.collected,
            );
        }
    }
}

impl ProxyTapBody {
    fn new(
        inner: Incoming,
        cfg: TapConfig,
        telemetry_permit: Option<mpsc::OwnedPermit<TelemetryEvent>>,
    ) -> Self {
        let sse = if cfg.is_sse {
            Some(SseParser::new(cfg.api_format))
        } else {
            None
        };
        Self {
            inner,
            cfg,
            telemetry_permit,
            finalized: false,
            first_byte_ms: None,
            first_token_ms: None,
            usage: Usage::default(),
            error_type: None,
            error_message: None,
            collected: BytesMut::new(),
            sse,
        }
    }
}

impl hyper::body::Body for ProxyTapBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let mut this = self.project();

        let polled = this.inner.as_mut().poll_frame(cx);
        match polled {
            Poll::Pending => Poll::Pending,
            Poll::Ready(None) => {
                finalize_tap(
                    this.cfg,
                    this.telemetry_permit,
                    this.finalized,
                    *this.first_byte_ms,
                    *this.first_token_ms,
                    this.usage,
                    this.error_type,
                    this.error_message,
                    this.collected,
                );
                Poll::Ready(None)
            }
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    if this.first_byte_ms.is_none() {
                        *this.first_byte_ms = Some(this.cfg.start.elapsed().as_millis() as i64);
                    }

                    if let Some(parser) = this.sse.as_mut().as_mut() {
                        let out = parser.push_bytes(data);
                        if out.saw_first_token && this.first_token_ms.is_none() {
                            *this.first_token_ms =
                                Some(this.cfg.start.elapsed().as_millis() as i64);
                        }
                        if let Some(u) = out.usage {
                            *this.usage = u;
                        }
                    } else {
                        if this.collected.len() < this.cfg.max_response_bytes {
                            let remaining = this.cfg.max_response_bytes - this.collected.len();
                            let slice = if data.len() > remaining {
                                &data[..remaining]
                            } else {
                                &data[..]
                            };
                            this.collected.extend_from_slice(slice);
                        }
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => {
                *this.error_type = Some("upstream_body_error".to_string());
                *this.error_message = Some(e.to_string());
                finalize_tap(
                    this.cfg,
                    this.telemetry_permit,
                    this.finalized,
                    *this.first_byte_ms,
                    *this.first_token_ms,
                    this.usage,
                    this.error_type,
                    this.error_message,
                    this.collected,
                );
                Poll::Ready(Some(Err(e)))
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn record_endpoint_outcome_for_id(
    health: &crate::health::EndpointHealthBook,
    endpoint_id: Option<i64>,
    status: Option<i32>,
    observed_latency_ms: Option<i64>,
    error_type: Option<&str>,
    error_message: Option<&str>,
) {
    let Some(endpoint_id) = endpoint_id else {
        return;
    };

    let now_ms = util::now_ms();
    if should_trip_endpoint(status, error_type) {
        health.record_failure(endpoint_id, status, error_type, error_message, now_ms);
        return;
    }

    health.record_success(endpoint_id, status, observed_latency_ms, now_ms);
}

fn should_record_key_success(status: Option<i32>, error_type: Option<&str>) -> bool {
    status.is_some() && error_type.is_none() && !should_trip_key(status, error_type)
}

fn record_upstream_key_outcome_for_id(
    health: &crate::health::UpstreamKeyHealthBook,
    upstream_key_id: Option<i64>,
    status: Option<i32>,
    observed_latency_ms: Option<i64>,
    error_type: Option<&str>,
    error_message: Option<&str>,
) {
    let Some(upstream_key_id) = upstream_key_id else {
        return;
    };

    let now_ms = util::now_ms();
    if should_trip_key(status, error_type) {
        health.record_failure(upstream_key_id, status, error_type, error_message, now_ms);
        return;
    }

    if should_record_key_success(status, error_type) {
        health.record_success(upstream_key_id, status, observed_latency_ms, now_ms);
    } else {
        health.release_probe(upstream_key_id, now_ms);
    }
}

fn record_runtime_outcomes(
    cfg: &TapConfig,
    first_byte_ms: Option<i64>,
    first_token_ms: Option<i64>,
    error_type: Option<&str>,
    error_message: Option<&str>,
) {
    let observed_latency_ms = first_byte_ms
        .or(first_token_ms)
        .or(cfg.t_stream_ms)
        .or_else(|| Some(cfg.start.elapsed().as_millis() as i64));

    record_endpoint_outcome_for_id(
        &cfg.endpoint_health,
        cfg.endpoint_id,
        cfg.http_status,
        observed_latency_ms,
        error_type,
        error_message,
    );
    record_upstream_key_outcome_for_id(
        &cfg.upstream_key_health,
        cfg.upstream_key_id,
        cfg.http_status,
        observed_latency_ms,
        error_type,
        error_message,
    );
}

fn finalize_tap(
    cfg: &TapConfig,
    telemetry_permit: &mut Option<mpsc::OwnedPermit<TelemetryEvent>>,
    finalized: &mut bool,
    first_byte_ms: Option<i64>,
    first_token_ms: Option<i64>,
    usage: &mut Usage,
    error_type: &Option<String>,
    error_message: &Option<String>,
    collected: &BytesMut,
) {
    if *finalized {
        return;
    }
    *finalized = true;

    if !cfg.is_sse && !collected.is_empty() {
        if let Ok(v) = serde_json::from_slice::<Value>(collected) {
            if let Some(u) = extract_usage(cfg.api_format, &v) {
                *usage = u;
            }
        }
    }

    let (cost_in, cost_out) = compute_cost(usage, cfg.price.as_ref());
    record_runtime_outcomes(
        cfg,
        first_byte_ms,
        first_token_ms,
        error_type.as_deref(),
        error_message.as_deref(),
    );
    cfg.metrics.record_request_str(
        cfg.api_format,
        cfg.http_status,
        error_type.as_deref(),
        Some(cfg.start.elapsed().as_millis() as i64),
        usage,
        cost_in,
        cost_out,
    );

    let event = TelemetryEvent {
        api_key_id: cfg.api_key_id,
        log_enabled: cfg.log_enabled,
        provider_id: cfg.provider_id,
        endpoint_id: cfg.endpoint_id,
        upstream_key_id: cfg.upstream_key_id,
        api_format: cfg.api_format,
        model: cfg.model.clone(),
        http_status: cfg.http_status,
        error_type: error_type.clone(),
        error_message: error_message.clone(),
        t_stream_ms: cfg.t_stream_ms,
        t_first_byte_ms: first_byte_ms,
        t_first_token_ms: first_token_ms,
        duration_ms: Some(cfg.start.elapsed().as_millis() as i64),
        usage: *usage,
        cost_in_usd: cost_in,
        cost_out_usd: cost_out,
        time_ms: util::now_ms(),
    };

    let Some(permit) = telemetry_permit.take() else {
        return;
    };
    let _ = permit.send(event);
}

#[derive(Default)]
struct SsePushOut {
    saw_first_token: bool,
    usage: Option<Usage>,
}

struct SseParser {
    api_format: &'static str,
    buf: BytesMut,
    event: Option<String>,
    done_usage: bool,
    done_first_token: bool,
}

impl SseParser {
    fn new(api_format: &'static str) -> Self {
        Self {
            api_format,
            buf: BytesMut::with_capacity(8 * 1024),
            event: None,
            done_usage: false,
            done_first_token: false,
        }
    }

    fn push_bytes(&mut self, data: &Bytes) -> SsePushOut {
        let mut out = SsePushOut::default();
        if self.done_usage && self.done_first_token {
            return out;
        }

        self.buf.extend_from_slice(data);

        while let Some(pos) = memchr(b'\n', &self.buf) {
            let mut line = self.buf.split_to(pos + 1);
            if line.ends_with(b"\n") {
                line.truncate(line.len() - 1);
            }
            if line.ends_with(b"\r") {
                line.truncate(line.len() - 1);
            }
            if line.is_empty() {
                continue;
            }

            if let Some(after) = line.strip_prefix(b"event: ") {
                self.event = Some(String::from_utf8_lossy(after).trim().to_string());
                continue;
            }

            if let Some(after) = line.strip_prefix(b"data: ") {
                if after == b"[DONE]" {
                    continue;
                }

                if self.done_usage && self.done_first_token {
                    continue;
                }

                let Ok(v) = serde_json::from_slice::<Value>(after) else {
                    continue;
                };

                if !self.done_first_token {
                    if self.api_format == "chat_completions" && chat_has_output_delta(&v) {
                        out.saw_first_token = true;
                        self.done_first_token = true;
                    } else if self.api_format == "responses" {
                        if let Some(ev) = self.event.as_deref() {
                            if ev.ends_with(".delta") && responses_has_delta(&v) {
                                out.saw_first_token = true;
                                self.done_first_token = true;
                            }
                        }
                    }
                }

                if !self.done_usage {
                    let usage = if self.api_format == "chat_completions" {
                        v.get("usage").and_then(parse_chat_usage)
                    } else if self.api_format == "responses" {
                        if self.event.as_deref() == Some("response.completed") {
                            v.get("response")
                                .and_then(|r| r.get("usage"))
                                .and_then(parse_responses_usage)
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    if let Some(u) = usage {
                        out.usage = Some(u);
                        self.done_usage = true;
                    }
                }
            }
        }

        // Cap buffer to avoid unbounded growth.
        const MAX_BUF: usize = 128 * 1024;
        if self.buf.len() > MAX_BUF {
            let keep = MAX_BUF / 2;
            let start = self.buf.len().saturating_sub(keep);
            let tail = self.buf.split_off(start);
            self.buf = tail;
        }

        out
    }
}

fn extract_usage(api_format: &'static str, root: &Value) -> Option<Usage> {
    match api_format {
        "chat_completions" => root.get("usage").and_then(parse_chat_usage),
        "responses" => root.get("usage").and_then(parse_responses_usage),
        _ => None,
    }
}

fn parse_chat_usage(v: &Value) -> Option<Usage> {
    let prompt = v.get("prompt_tokens")?.as_i64()?;
    let completion = v.get("completion_tokens")?.as_i64()?;
    let cached = v
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);

    Some(Usage {
        input_tokens: (prompt - cached).max(0),
        output_tokens: completion.max(0),
        cache_read_input_tokens: cached.max(0),
        cache_creation_input_tokens: 0,
    })
}

fn parse_responses_usage(v: &Value) -> Option<Usage> {
    let input = v.get("input_tokens")?.as_i64()?;
    let output = v.get("output_tokens")?.as_i64()?;
    let cached = v
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);

    Some(Usage {
        input_tokens: (input - cached).max(0),
        output_tokens: output.max(0),
        cache_read_input_tokens: cached.max(0),
        cache_creation_input_tokens: 0,
    })
}

fn chat_has_output_delta(v: &Value) -> bool {
    let Some(choices) = v.get("choices").and_then(|c| c.as_array()) else {
        return false;
    };
    let Some(first) = choices.first() else {
        return false;
    };
    let Some(delta) = first.get("delta") else {
        return false;
    };
    if delta
        .get("content")
        .and_then(|x| x.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    if delta
        .get("tool_calls")
        .and_then(|x| x.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    if delta.get("function_call").is_some() {
        return true;
    }
    false
}

fn responses_has_delta(v: &Value) -> bool {
    v.get("delta")
        .and_then(|x| x.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

fn compute_cost(usage: &Usage, price: Option<&ModelPriceData>) -> (Decimal, Decimal) {
    let Some(price) = price else {
        return (Decimal::ZERO, Decimal::ZERO);
    };

    let input_tokens = Decimal::from(usage.input_tokens);
    let output_tokens = Decimal::from(usage.output_tokens);
    let cache_read = Decimal::from(usage.cache_read_input_tokens);
    let cache_create = Decimal::from(usage.cache_creation_input_tokens);

    let mut cost_in = Decimal::ZERO;
    let mut cost_out = Decimal::ZERO;

    if let Some(v) = price.input_cost_per_token {
        cost_in += input_tokens * v;
    }
    if let Some(v) = price.output_cost_per_token {
        cost_out += output_tokens * v;
    }
    if let Some(v) = price.cache_read_input_token_cost {
        cost_in += cache_read * v;
    }
    if let Some(v) = price.cache_creation_input_token_cost {
        cost_in += cache_create * v;
    }

    (cost_in, cost_out)
}
