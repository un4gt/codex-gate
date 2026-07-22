use std::collections::{HashSet, VecDeque};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;

use bytes::{Bytes, BytesMut};
use http_body_util::{BodyExt, Full};
use hyper::body::{Frame, Incoming, SizeHint};
use hyper::header::{
    ACCEPT, AUTHORIZATION, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, HOST, PROXY_AUTHENTICATE,
    PROXY_AUTHORIZATION, TE, TRAILER, TRANSFER_ENCODING, UPGRADE, USER_AGENT,
};
use hyper::http::HeaderMap;
use hyper::{Method, Request, Response, StatusCode, Uri};
use memchr::memchr;
use pin_project_lite::pin_project;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time;

use crate::affinity::{AffinityBinding, AffinityIdentity, extract_affinity_identity};
use crate::cache::upstream_cache::UpstreamSnapshot;
use crate::health::RuntimeHealthAttemptGuard;
use crate::http::{self, HttpResponse};
use crate::metrics::{FailoverKind, RequestMetric};
use crate::openai::{OpenAiRequestInfo, ensure_include_usage, parse_request_info};
use crate::pricing::{PriceVersion, PricingEvaluation, evaluate_price};
use crate::provider_runtime::{BreakerTransition, ProviderAttemptGuard, ProviderCapacityPermit};
use crate::selector;
use crate::state::SharedState;
use crate::telemetry::TelemetryEvent;
use crate::types::{ApiFormat, ApiKeyAuth, UpstreamKey, UpstreamProvider, Usage};
use crate::util;

pub async fn handle(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    match (req.method(), path) {
        (&Method::GET, "/v1/models") => list_models(req, state).await,
        (&Method::GET, "/v1/responses") if hyper_tungstenite::is_upgrade_request(&req) => {
            crate::responses_ws::handle(req, state).await
        }
        (&Method::POST, "/v1/chat/completions") => {
            proxy_openai(ApiFormat::ChatCompletions, req, state).await
        }
        (&Method::POST, "/v1/responses") => proxy_openai(ApiFormat::Responses, req, state).await,
        _ => http::json_error(StatusCode::NOT_FOUND, "not found"),
    }
}

async fn list_models(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let now_ms = util::now_ms();
    let requested_api_format = list_models_api_format(req.uri().query());

    let Some(api_key_plaintext) = http::bearer_token(&req) else {
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
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let Some(api_key) = auth else {
        return http::json_error(StatusCode::UNAUTHORIZED, "invalid api key");
    };
    let snap = match state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
    {
        Ok(items) => items,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let authorized_group_ids = api_key
        .provider_groups
        .iter()
        .map(|group| group.id)
        .collect::<HashSet<_>>();
    let mut enabled_provider_ids = HashSet::new();
    for provider in &snap.providers {
        if provider.enabled
            && provider_supports_api_format(&provider.provider_type, requested_api_format)
            && provider_matching_groups(&snap, provider.id, &authorized_group_ids)
                .next()
                .is_some()
        {
            enabled_provider_ids.insert(provider.id);
        }
    }

    let provider_model_enabled = |provider_id: i64, upstream_model: &str| -> bool {
        snap.provider_models_by_provider
            .get(&provider_id)
            .and_then(|items| items.get(upstream_model).copied())
            .unwrap_or(true)
    };

    let provider_has_usable_key_for_model = |provider_id: i64, upstream_model: &str| -> bool {
        let Some(keys) = snap.keys_by_provider.get(&provider_id) else {
            return false;
        };

        keys.iter().any(|key| {
            if !key.enabled {
                return false;
            }
            match snap.key_models_by_key.get(&key.id) {
                Some(models) => models.get(upstream_model).copied().unwrap_or(false),
                None => true,
            }
        })
    };

    let provider_can_serve_model = |provider_id: i64, upstream_model: &str| -> bool {
        if !enabled_provider_ids.contains(&provider_id) {
            return false;
        }
        if !provider_model_enabled(provider_id, upstream_model) {
            return false;
        }
        provider_has_usable_key_for_model(provider_id, upstream_model)
    };

    let route_allows_provider = |upstream_model: &str, provider_id: i64| -> bool {
        let Some(route) = snap.routes_by_model.get(upstream_model) else {
            return true;
        };
        if !route.enabled || route.provider_ids.is_empty() {
            return true;
        }
        route.provider_ids.contains(&provider_id)
    };

    let model_is_routable = |upstream_model: &str| -> bool {
        if let Some(route) = snap.routes_by_model.get(upstream_model)
            && route.enabled
            && !route.provider_ids.is_empty()
        {
            return route
                .provider_ids
                .iter()
                .copied()
                .any(|provider_id| provider_can_serve_model(provider_id, upstream_model));
        }

        enabled_provider_ids
            .iter()
            .copied()
            .any(|provider_id| provider_can_serve_model(provider_id, upstream_model))
    };

    let mut upstream_models = HashSet::new();
    for models in snap.provider_models_by_provider.values() {
        for (upstream_model, enabled) in models {
            if !enabled {
                continue;
            }
            if !snap.is_model_globally_enabled(upstream_model) {
                continue;
            }
            upstream_models.insert(upstream_model.clone());
        }
    }

    let mut ids: HashSet<String> = HashSet::new();
    for upstream_model in upstream_models {
        if !model_is_routable(&upstream_model) {
            continue;
        }
        ids.insert(upstream_model);
    }

    for alias in snap.model_aliases_by_name.values() {
        if !alias.enabled || !snap.is_model_globally_enabled(&alias.name) {
            continue;
        }
        let Some(targets) = snap.alias_targets_by_alias.get(&alias.id) else {
            continue;
        };
        let routable = targets.iter().any(|target| {
            target.enabled
                && snap.is_model_globally_enabled(&target.upstream_model)
                && route_allows_provider(&target.upstream_model, target.provider_id)
                && provider_can_serve_model(target.provider_id, &target.upstream_model)
        });
        if routable {
            ids.insert(alias.name.clone());
        }
    }

    // Keep legacy provider-model aliases routable while they are migrated into model_aliases.
    for (alias, target) in &snap.alias_to_provider_model {
        if !target.enabled {
            continue;
        }
        if !snap.is_model_globally_enabled(alias) {
            continue;
        }
        if !snap.is_model_globally_enabled(&target.upstream_model) {
            continue;
        }
        if !route_allows_provider(&target.upstream_model, target.provider_id) {
            continue;
        }
        if !provider_can_serve_model(target.provider_id, &target.upstream_model) {
            continue;
        }
        ids.insert(alias.clone());
    }

    let mut models: Vec<String> = ids.into_iter().collect();
    models.sort();

    let data = models
        .into_iter()
        .map(|id| {
            serde_json::json!({
                "id": id,
                "object": "model",
                "created": 0,
                "owned_by": "little-gate"
            })
        })
        .collect::<Vec<_>>();

    http::json(
        StatusCode::OK,
        &serde_json::json!({
            "object": "list",
            "data": data
        }),
    )
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
            RequestMetric {
                http_status,
                error_type,
                duration_ms: Some(start.elapsed().as_millis() as i64),
                usage: Usage::default(),
                pricing: PricingEvaluation::usage_missing(),
            },
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
    let routing_trace = std::sync::Arc::new(parking_lot::Mutex::new(RoutingTrace {
        authorized_groups: api_key
            .provider_groups
            .iter()
            .map(|group| serde_json::json!({ "id": group.id, "name": group.name }))
            .collect(),
        ..RoutingTrace::default()
    }));

    let mut telemetry_permit = match state.telemetry.try_reserve_permit() {
        Ok(p) => Some(p),
        Err(_) => {
            state.metrics.record_telemetry_dropped();
            None
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
        routing_trace.lock().terminal = Some(serde_json::json!({
            "status": status.as_u16(),
            "error_type": error_type,
            "message": error_message.clone(),
        }));
        submit_with_permit(
            permit,
            TelemetryEvent {
                id: None,
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
                usage_observed: false,
                price_version_id: None,
                price_tier_index: None,
                time_ms: util::now_ms(),
                span_kind: "request",
                transport: "http",
                parent_id: None,
                ws_session_id: None,
                routing_trace: Some(routing_trace_value(&routing_trace)),
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
    let affinity_identity = extract_affinity_identity(&request_headers, &body_bytes, api_key.id);
    let existing_affinity_binding = affinity_identity
        .as_ref()
        .and_then(|identity| state.affinity.lookup(identity, util::now_ms()));
    if affinity_identity.is_some() {
        state
            .metrics
            .record_affinity_lookup(existing_affinity_binding.is_some());
    }

    let api_format_str = match api_format {
        ApiFormat::ChatCompletions => "chat_completions",
        ApiFormat::Responses => "responses",
    };

    let mut plan = match build_upstream_plan(
        &state,
        api_format,
        &model_name,
        &api_key,
        affinity_identity.as_ref(),
    )
    .await
    {
        Ok(v) => v,
        Err((status, msg)) => {
            submit_err(
                &mut telemetry_permit,
                status,
                "upstream_resolve_failed",
                msg.clone(),
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
    let affinity_binding = apply_affinity_to_plan(
        &state,
        affinity_identity.as_ref(),
        existing_affinity_binding,
        &mut plan,
    );
    {
        let mut trace = routing_trace.lock();
        trace.affinity = affinity_identity.as_ref().map(|identity| {
            serde_json::json!({
                "source": identity.source,
                "hash": identity.log_hash,
                "hit": existing_affinity_binding.is_some(),
                "bound_provider_id": affinity_binding.map(|binding| binding.provider_id),
            })
        });
        let mut seen = HashSet::new();
        trace.candidates = plan
            .attempts
            .iter()
            .filter(|attempt| seen.insert(attempt.provider.id))
            .map(|attempt| {
                serde_json::json!({
                    "provider_id": attempt.provider.id,
                    "priority": attempt.provider.priority,
                    "weight": attempt.provider.weight,
                    "attempt_budget": attempt.provider.max_attempts,
                })
            })
            .collect();
    }

    let mut exclusions = AttemptExclusions::default();
    let mut last_failure: Option<AttemptFailure> = None;
    let mut faulted_providers = HashSet::new();
    let mut last_attempted_provider_id = None;

    for (index, resolved) in plan.attempts.iter().enumerate() {
        if exclusions.should_skip(resolved) {
            continue;
        }

        let Ok(reservation) = reserve_attempt(&state, resolved, util::now_ms()) else {
            trace_attempt(
                &routing_trace,
                resolved,
                None,
                Some("runtime_reservation_unavailable"),
                start.elapsed().as_millis() as i64,
            );
            continue;
        };
        let provider_switched =
            last_attempted_provider_id.is_some_and(|id| id != resolved.provider.id);
        if provider_switched {
            routing_trace.lock().provider_switches += 1;
        }
        if last_attempted_provider_id != Some(resolved.provider.id) {
            state.metrics.record_provider_selection(provider_switched);
        }
        last_attempted_provider_id = Some(resolved.provider.id);
        state.metrics.record_upstream_attempt();

        let mut out_body = if resolved.upstream_model == model_name {
            body_bytes.clone()
        } else {
            match rewrite_model_name(body_bytes.clone(), &resolved.upstream_model) {
                Ok(v) => v,
                Err(_) => {
                    submit_err(
                        &mut telemetry_permit,
                        StatusCode::BAD_REQUEST,
                        "invalid_model",
                        "invalid model".to_string(),
                        None,
                        None,
                        None,
                        Some(model_name.clone()),
                    );
                    record_request_metric(
                        Some(StatusCode::BAD_REQUEST.as_u16() as i32),
                        Some("invalid_model"),
                    );
                    return http::json_error(StatusCode::BAD_REQUEST, "invalid model");
                }
            }
        };
        if should_inject_include_usage(
            api_format,
            &info,
            resolved.provider.supports_include_usage,
            plan.runtime.inject_include_usage,
        ) && let Ok(body) = ensure_include_usage(out_body.clone())
        {
            out_body = body;
        }

        let upstream_uri = match build_upstream_uri(
            &resolved.endpoint.base_url,
            request_path_and_query.as_ref(),
        ) {
            Ok(uri) => uri,
            Err(error) => {
                trace_attempt(
                    &routing_trace,
                    resolved,
                    Some(StatusCode::BAD_REQUEST.as_u16() as i32),
                    Some("invalid_upstream_uri"),
                    start.elapsed().as_millis() as i64,
                );
                reservation.finish(
                    AttemptOutcome::local_provider(
                        Some(StatusCode::BAD_REQUEST.as_u16() as i32),
                        "invalid_upstream_uri",
                        &error,
                        None,
                    ),
                    &state.metrics,
                );
                exclusions.note_attempt(resolved);
                exclusions.avoid_endpoint(resolved.endpoint.id);
                if !has_remaining_provider_candidate(
                    &plan.attempts,
                    index + 1,
                    &exclusions,
                    resolved.provider.id,
                ) {
                    note_affinity_failure(
                        &state,
                        resolved,
                        FailureScope::Provider,
                        affinity_identity.as_ref(),
                        &mut faulted_providers,
                    );
                }
                last_failure = Some(AttemptFailure::new(
                    resolved,
                    StatusCode::BAD_REQUEST,
                    "invalid_upstream_uri",
                    error.clone(),
                ));

                if has_remaining_candidate(&plan.attempts, index + 1, &exclusions) {
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

        let headers =
            build_upstream_headers(&request_headers, out_body.len(), &resolved.key.secret);

        let upstream_response = dispatch_upstream_request(
            &state,
            &request_method,
            request_version,
            &headers,
            out_body,
            upstream_uri,
        )
        .await;

        let upstream_resp = match upstream_response {
            Ok(response) => response,
            Err(error) => {
                let (status, error_type, error_message) = dispatch_error_to_http(error, &state);
                trace_attempt(
                    &routing_trace,
                    resolved,
                    Some(status.as_u16() as i32),
                    Some(error_type),
                    start.elapsed().as_millis() as i64,
                );

                reservation.finish(
                    AttemptOutcome::local_provider(
                        Some(status.as_u16() as i32),
                        error_type,
                        &error_message,
                        None,
                    ),
                    &state.metrics,
                );
                exclusions.note_attempt(resolved);
                exclusions.avoid_endpoint(resolved.endpoint.id);
                if !has_remaining_provider_candidate(
                    &plan.attempts,
                    index + 1,
                    &exclusions,
                    resolved.provider.id,
                ) {
                    note_affinity_failure(
                        &state,
                        resolved,
                        FailureScope::Provider,
                        affinity_identity.as_ref(),
                        &mut faulted_providers,
                    );
                }
                last_failure = Some(AttemptFailure::new(
                    resolved,
                    status,
                    error_type,
                    error_message.clone(),
                ));

                if has_remaining_candidate(&plan.attempts, index + 1, &exclusions) {
                    state.metrics.record_failover(FailoverKind::Endpoint);
                    continue;
                }

                submit_err(
                    &mut telemetry_permit,
                    status,
                    error_type,
                    error_message.clone(),
                    Some(resolved.provider.id),
                    Some(resolved.endpoint.id),
                    Some(resolved.key.id),
                    Some(model_name.clone()),
                );
                record_request_metric(Some(status.as_u16() as i32), Some(error_type));
                return http::json_error(status, error_message);
            }
        };

        let t_stream_ms = start.elapsed().as_millis() as i64;
        let status_code = upstream_resp.status();
        let status_i32 = status_code.as_u16() as i32;
        state.quota.observe_response(
            resolved.key.id,
            status_i32,
            upstream_resp.headers(),
            util::now_ms(),
            state.config.rate_limit_fallback_cooldown,
        );
        if should_retry_response_status(status_i32) {
            trace_attempt(
                &routing_trace,
                resolved,
                Some(status_i32),
                Some("upstream_retry_status"),
                t_stream_ms,
            );
            exclusions.note_attempt(resolved);
            let failure_scope =
                classify_failure_scope(Some(status_i32), OutcomeOrigin::UpstreamResponse);
            let failover_kind = match failure_scope {
                FailureScope::Model => {
                    exclusions.avoid_provider(resolved.provider.id);
                    FailoverKind::Generic
                }
                FailureScope::Key | FailureScope::Quota => {
                    exclusions.avoid_key(resolved.key.id);
                    FailoverKind::Key
                }
                FailureScope::Provider => {
                    exclusions.avoid_endpoint(resolved.endpoint.id);
                    FailoverKind::Endpoint
                }
                FailureScope::Success | FailureScope::Client => FailoverKind::Generic,
            };
            let error_message = format!("retryable upstream status {status_i32}");
            last_failure = Some(AttemptFailure::new(
                resolved,
                status_code,
                "upstream_retry_status",
                error_message.clone(),
            ));
            if has_remaining_candidate(&plan.attempts, index + 1, &exclusions) {
                reservation.finish(
                    AttemptOutcome::upstream_response(
                        status_i32,
                        Some("upstream_retry_status"),
                        Some(&error_message),
                        Some(t_stream_ms),
                    ),
                    &state.metrics,
                );
                if !has_remaining_provider_candidate(
                    &plan.attempts,
                    index + 1,
                    &exclusions,
                    resolved.provider.id,
                ) {
                    note_affinity_failure(
                        &state,
                        resolved,
                        failure_scope,
                        affinity_identity.as_ref(),
                        &mut faulted_providers,
                    );
                }
                state.metrics.record_failover(failover_kind);
                drop(upstream_resp);
                continue;
            }
        }

        let (mut resp_parts, body) = upstream_resp.into_parts();
        sanitize_hop_headers(&mut resp_parts.headers);

        let is_sse = resp_parts
            .headers
            .get(hyper::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.contains("text/event-stream"))
            .unwrap_or(false);
        let body = if is_sse {
            match preflight_sse(
                body,
                api_format_str,
                state.config.stream_preflight_timeout,
                state.config.stream_preflight_max_bytes,
            )
            .await
            {
                Ok(body) => body,
                Err(error) => {
                    trace_attempt(
                        &routing_trace,
                        resolved,
                        Some(StatusCode::BAD_GATEWAY.as_u16() as i32),
                        Some("upstream_sse_preflight_failed"),
                        start.elapsed().as_millis() as i64,
                    );
                    reservation.finish(
                        AttemptOutcome::local_provider(
                            Some(StatusCode::BAD_GATEWAY.as_u16() as i32),
                            "upstream_sse_preflight_failed",
                            &error,
                            Some(t_stream_ms),
                        ),
                        &state.metrics,
                    );
                    exclusions.note_attempt(resolved);
                    exclusions.avoid_endpoint(resolved.endpoint.id);
                    if !has_remaining_provider_candidate(
                        &plan.attempts,
                        index + 1,
                        &exclusions,
                        resolved.provider.id,
                    ) {
                        note_affinity_failure(
                            &state,
                            resolved,
                            FailureScope::Provider,
                            affinity_identity.as_ref(),
                            &mut faulted_providers,
                        );
                    }
                    last_failure = Some(AttemptFailure::new(
                        resolved,
                        StatusCode::BAD_GATEWAY,
                        "upstream_sse_preflight_failed",
                        error.clone(),
                    ));
                    if has_remaining_candidate(&plan.attempts, index + 1, &exclusions) {
                        state.metrics.record_failover(FailoverKind::Endpoint);
                        continue;
                    }
                    submit_err(
                        &mut telemetry_permit,
                        StatusCode::BAD_GATEWAY,
                        "upstream_sse_preflight_failed",
                        error.clone(),
                        Some(resolved.provider.id),
                        Some(resolved.endpoint.id),
                        Some(resolved.key.id),
                        Some(model_name.clone()),
                    );
                    record_request_metric(
                        Some(StatusCode::BAD_GATEWAY.as_u16() as i32),
                        Some("upstream_sse_preflight_failed"),
                    );
                    return http::json_error(StatusCode::BAD_GATEWAY, error);
                }
            }
        } else {
            ReplayIncomingBody::new(body)
        };

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
                usage_capture_bytes: plan.runtime.usage_capture_bytes,
                usage_capture_tail_bytes: plan.runtime.usage_capture_tail_bytes,
                provider: resolved.provider.clone(),
                metrics: state.metrics.clone(),
                affinity: state.affinity.clone(),
                affinity_identity: affinity_identity.clone(),
                affinity_binding,
                affinity_should_migrate: affinity_binding.is_some_and(|binding| {
                    binding.provider_id != resolved.provider.id
                        && faulted_providers.contains(&binding.provider_id)
                }),
                routing_trace: routing_trace.clone(),
            },
            telemetry_permit.take(),
            reservation,
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

fn rewrite_model_name(body: Bytes, new_model: &str) -> Result<Bytes, String> {
    let mut value: Value =
        serde_json::from_slice(&body).map_err(|e| format!("invalid json: {e}"))?;
    let Some(root) = value.as_object_mut() else {
        return Err("invalid json object".to_string());
    };
    root.insert("model".to_string(), Value::String(new_model.to_string()));
    serde_json::to_vec(&value)
        .map(Bytes::from)
        .map_err(|e| format!("json encode failed: {e}"))
}

#[derive(Debug)]
pub(crate) enum UpstreamDispatchError {
    Request(String),
    Timeout,
}

pub(crate) async fn dispatch_upstream_request(
    state: &SharedState,
    request_method: &Method,
    request_version: hyper::Version,
    request_headers: &hyper::HeaderMap,
    body: Bytes,
    uri: Uri,
) -> Result<Response<Incoming>, UpstreamDispatchError> {
    let mut upstream_req = Request::new(Full::new(body));
    *upstream_req.method_mut() = request_method.clone();
    *upstream_req.uri_mut() = uri;
    *upstream_req.version_mut() = request_version;
    *upstream_req.headers_mut() = request_headers.clone();

    time::timeout(
        state.config.upstream_request_timeout,
        state.upstream.request(upstream_req),
    )
    .await
    .map_err(|_| UpstreamDispatchError::Timeout)?
    .map_err(|e| UpstreamDispatchError::Request(e.to_string()))
}

pub(crate) fn dispatch_error_to_http(
    error: UpstreamDispatchError,
    state: &SharedState,
) -> (StatusCode, &'static str, String) {
    match error {
        UpstreamDispatchError::Request(message) => {
            (StatusCode::BAD_GATEWAY, "upstream_request_error", message)
        }
        UpstreamDispatchError::Timeout => (
            StatusCode::GATEWAY_TIMEOUT,
            "upstream_timeout",
            format!(
                "upstream request timeout after {:?}",
                state.config.upstream_request_timeout
            ),
        ),
    }
}

fn provider_supports_api_format(provider_type: &str, api_format: ApiFormat) -> bool {
    match api_format {
        ApiFormat::ChatCompletions => provider_type != "openai_compatible_responses",
        ApiFormat::Responses => true,
    }
}

fn list_models_api_format(query: Option<&str>) -> ApiFormat {
    let value = query_param(query, "api_format").unwrap_or_else(|| "chat_completions".to_string());
    match value.trim().to_ascii_lowercase().as_str() {
        "responses" => ApiFormat::Responses,
        "chat" | "chat_completions" | "chat-completions" => ApiFormat::ChatCompletions,
        _ => ApiFormat::ChatCompletions,
    }
}

fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    fn decode_component(raw: &str) -> String {
        fn from_hex(byte: u8) -> Option<u8> {
            match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            }
        }

        let bytes = raw.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut idx = 0;
        while idx < bytes.len() {
            match bytes[idx] {
                b'+' => {
                    out.push(b' ');
                    idx += 1;
                }
                b'%' if idx + 2 < bytes.len() => {
                    let hi = from_hex(bytes[idx + 1]);
                    let lo = from_hex(bytes[idx + 2]);
                    if let (Some(hi), Some(lo)) = (hi, lo) {
                        out.push((hi << 4) | lo);
                        idx += 3;
                    } else {
                        out.push(bytes[idx]);
                        idx += 1;
                    }
                }
                byte => {
                    out.push(byte);
                    idx += 1;
                }
            }
        }

        String::from_utf8(out)
            .unwrap_or_else(|error| String::from_utf8_lossy(&error.into_bytes()).into_owned())
    }

    let query = query?;
    for part in query.split('&') {
        let mut items = part.splitn(2, '=');
        let key_name = items.next()?.trim();
        let value = items.next().unwrap_or("").trim();
        if key_name == key {
            return Some(decode_component(value));
        }
    }
    None
}

#[derive(Clone)]
pub(crate) struct ResolvedUpstream {
    pub(crate) upstream_model: String,
    pub(crate) provider: crate::types::UpstreamProvider,
    pub(crate) endpoint: crate::types::UpstreamEndpoint,
    pub(crate) key: crate::types::UpstreamKey,
    pub(crate) price: Option<PriceVersion>,
}

#[derive(Default)]
struct AttemptExclusions {
    attempted_pairs: HashSet<(i64, i64)>,
    provider_ids: HashSet<i64>,
    endpoint_ids: HashSet<i64>,
    key_ids: HashSet<i64>,
}

impl AttemptExclusions {
    fn should_skip(&self, resolved: &ResolvedUpstream) -> bool {
        self.provider_ids.contains(&resolved.provider.id)
            || self.endpoint_ids.contains(&resolved.endpoint.id)
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

    fn avoid_provider(&mut self, provider_id: i64) {
        self.provider_ids.insert(provider_id);
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

#[derive(Default, Serialize)]
struct RoutingTrace {
    authorized_groups: Vec<Value>,
    affinity: Option<Value>,
    candidates: Vec<Value>,
    attempts: Vec<Value>,
    provider_switches: usize,
    terminal: Option<Value>,
}

type SharedRoutingTrace = std::sync::Arc<parking_lot::Mutex<RoutingTrace>>;

fn routing_trace_value(trace: &SharedRoutingTrace) -> Value {
    serde_json::to_value(&*trace.lock()).unwrap_or(Value::Null)
}

fn trace_attempt(
    trace: &SharedRoutingTrace,
    resolved: &ResolvedUpstream,
    status: Option<i32>,
    error_type: Option<&str>,
    duration_ms: i64,
) {
    let mut trace = trace.lock();
    if trace.attempts.len() >= 40 {
        return;
    }
    trace.attempts.push(serde_json::json!({
        "provider_id": resolved.provider.id,
        "endpoint_id": resolved.endpoint.id,
        "upstream_key_id": resolved.key.id,
        "status": status,
        "error_type": error_type,
        "duration_ms": duration_ms,
    }));
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

pub(crate) struct UpstreamPlan {
    pub(crate) runtime: crate::runtime_settings::RuntimeSettingsSnapshot,
    pub(crate) attempts: Vec<ResolvedUpstream>,
    pub(crate) transient_spill_provider_ids: HashSet<i64>,
}

impl UpstreamPlan {
    pub(crate) fn prefer_provider(&mut self, provider_id: i64) -> bool {
        if !self
            .attempts
            .iter()
            .any(|attempt| attempt.provider.id == provider_id)
        {
            return false;
        }
        self.attempts
            .sort_by_key(|attempt| (attempt.provider.id != provider_id) as u8);
        true
    }
}

pub(crate) fn apply_affinity_to_plan(
    state: &SharedState,
    identity: Option<&AffinityIdentity>,
    existing: Option<AffinityBinding>,
    plan: &mut UpstreamPlan,
) -> Option<AffinityBinding> {
    let identity = identity?;
    if let Some(binding) = existing {
        if plan.prefer_provider(binding.provider_id)
            || plan
                .transient_spill_provider_ids
                .contains(&binding.provider_id)
        {
            return Some(binding);
        }
        let _ = state
            .affinity
            .clear_if_provider(identity, binding.provider_id);
    }

    let first_provider_id = plan.attempts.first()?.provider.id;
    let binding = state
        .affinity
        .claim(identity, first_provider_id, util::now_ms());
    let _ = plan.prefer_provider(binding.provider_id);
    Some(binding)
}

const MAX_PROVIDER_SWITCHES: usize = 3;
pub(crate) const MAX_DISTINCT_PROVIDERS: usize = MAX_PROVIDER_SWITCHES + 1;

#[derive(Clone)]
struct ProviderRoute {
    provider: UpstreamProvider,
    upstream_model: String,
    route_priority: Option<i32>,
    route_weight: Option<i32>,
}

struct SchedulableProvider {
    route: ProviderRoute,
    effective_priority: i32,
    effective_weight: i32,
    keys: Vec<UpstreamKey>,
    endpoints: Vec<crate::types::UpstreamEndpoint>,
    price: Option<PriceVersion>,
    in_flight: u32,
    max_concurrency: Option<i32>,
    latency_ewma_ms: Option<i64>,
}

pub(crate) async fn build_upstream_plan(
    state: &SharedState,
    api_format: ApiFormat,
    requested_model: &str,
    api_key: &ApiKeyAuth,
    affinity: Option<&AffinityIdentity>,
) -> Result<UpstreamPlan, (StatusCode, String)> {
    let snap = state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    if !snap.is_model_globally_enabled(requested_model) {
        return Err((StatusCode::FORBIDDEN, "model disabled".to_string()));
    }

    let runtime = state.runtime_settings.snapshot();
    let now_ms = util::now_ms();
    let routes = collect_provider_routes(&snap, api_format, requested_model)?;
    if routes.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "no providers can route this model".to_string(),
        ));
    }

    let authorized_group_ids = api_key
        .provider_groups
        .iter()
        .map(|group| group.id)
        .collect::<HashSet<_>>();
    let mut authorized_routes = routes
        .into_iter()
        .filter(|route| {
            provider_matching_groups(&snap, route.provider.id, &authorized_group_ids)
                .next()
                .is_some()
        })
        .collect::<Vec<_>>();
    if authorized_routes.is_empty() {
        return Err((
            StatusCode::FORBIDDEN,
            "API key is not authorized for any provider that can route this model".to_string(),
        ));
    }

    authorized_routes.retain(|route| route.provider.enabled);
    let affinity_provider_id = affinity
        .and_then(|identity| state.affinity.lookup(identity, now_ms))
        .map(|binding| binding.provider_id);
    let mut schedulable = Vec::new();
    let mut transient_spill_provider_ids = HashSet::new();
    for route in authorized_routes {
        let provider = &route.provider;
        if affinity.is_some_and(|identity| {
            state
                .affinity
                .is_provider_avoided(identity, provider.id, now_ms)
        }) {
            continue;
        }
        let provider_runtime = state.provider_runtime.snapshot(provider, now_ms);
        if !provider_runtime.available {
            if provider_runtime.state != crate::health::CircuitState::Open {
                state.metrics.record_provider_capacity_skip();
                transient_spill_provider_ids.insert(provider.id);
            }
            continue;
        }
        let model_keys = snap
            .keys_by_provider
            .get(&provider.id)
            .map(|items| {
                items
                    .iter()
                    .filter(|key| key_allows_model(&snap, key.id, &route.upstream_model))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let keys = model_keys
            .iter()
            .copied()
            .filter(|key| {
                let available = state.quota.is_available(key.id, now_ms);
                if !available {
                    state.metrics.record_quota_cooldown_skip();
                }
                available
            })
            .collect::<Vec<_>>();
        if !model_keys.is_empty() && keys.is_empty() {
            transient_spill_provider_ids.insert(provider.id);
        }
        let ranked_keys =
            selector::rank_key_refs_with_health(&keys, &state.upstream_key_health, now_ms);
        let ranked_keys = order_keys_for_provider(
            state,
            provider.id,
            &provider.key_selection_strategy,
            &ranked_keys,
        );
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
            runtime.endpoint_selector_strategy,
            now_ms,
        );
        if ranked_endpoints.is_empty() {
            continue;
        }

        let effective_priority = effective_provider_priority(
            &snap,
            provider,
            &authorized_group_ids,
            route.route_priority,
        );
        let effective_weight = provider
            .weight
            .max(0)
            .saturating_mul(route.route_weight.unwrap_or(1).max(0))
            .max(1);
        let price =
            snap.find_price_for_request(provider.id, requested_model, &route.upstream_model);
        schedulable.push(SchedulableProvider {
            route,
            effective_priority,
            effective_weight,
            keys: ranked_keys,
            endpoints: ranked_endpoints.into_iter().cloned().collect(),
            price,
            in_flight: provider_runtime.in_flight,
            max_concurrency: provider_runtime.max_concurrency,
            latency_ewma_ms: provider_runtime.latency_ewma_ms,
        });
    }

    if schedulable.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "no available upstream targets".to_string(),
        ));
    }

    let attempts = build_scheduled_attempts(schedulable, affinity_provider_id);

    if attempts.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "no available upstream targets".to_string(),
        ));
    }

    Ok(UpstreamPlan {
        runtime,
        attempts,
        transient_spill_provider_ids,
    })
}

fn build_scheduled_attempts(
    schedulable: Vec<SchedulableProvider>,
    affinity_provider_id: Option<i64>,
) -> Vec<ResolvedUpstream> {
    let mut attempts = Vec::new();
    for scheduled in order_schedulable_providers(schedulable, affinity_provider_id)
        .into_iter()
        .take(MAX_DISTINCT_PROVIDERS)
    {
        let max_attempts = scheduled.route.provider.max_attempts.max(1) as usize;
        let mut provider_attempts = 0usize;
        'pairs: for diagonal in 0..scheduled.endpoints.len() {
            for (key_index, key) in scheduled.keys.iter().enumerate() {
                let endpoint =
                    &scheduled.endpoints[(key_index + diagonal) % scheduled.endpoints.len()];
                attempts.push(ResolvedUpstream {
                    upstream_model: scheduled.route.upstream_model.clone(),
                    provider: scheduled.route.provider.clone(),
                    endpoint: endpoint.clone(),
                    key: key.clone(),
                    price: scheduled.price.clone(),
                });
                provider_attempts += 1;
                if provider_attempts >= max_attempts {
                    break 'pairs;
                }
            }
        }
    }
    attempts
}

fn collect_provider_routes(
    snap: &UpstreamSnapshot,
    api_format: ApiFormat,
    requested_model: &str,
) -> Result<Vec<ProviderRoute>, (StatusCode, String)> {
    let mut routes = Vec::new();
    if let Some(alias) = snap.model_aliases_by_name.get(requested_model) {
        if !alias.enabled {
            return Err((StatusCode::FORBIDDEN, "model disabled".to_string()));
        }
        let Some(targets) = snap.alias_targets_by_alias.get(&alias.id) else {
            return Ok(routes);
        };
        let mut seen = HashSet::new();
        for target in targets {
            if !target.enabled
                || !snap.is_model_globally_enabled(&target.upstream_model)
                || !route_allows_provider_for_model(
                    snap,
                    &target.upstream_model,
                    target.provider_id,
                )
            {
                continue;
            }
            if let Some(provider) = snap.providers.iter().find(|item| {
                item.id == target.provider_id
                    && provider_supports_api_format(&item.provider_type, api_format)
                    && provider_model_enabled(snap, item.id, &target.upstream_model)
            }) && seen.insert(target.provider_id)
            {
                routes.push(ProviderRoute {
                    provider: provider.clone(),
                    upstream_model: target.upstream_model.clone(),
                    route_priority: Some(target.priority),
                    route_weight: (alias.mode == "weighted").then_some(target.weight),
                });
            }
        }
        return Ok(routes);
    }

    let (upstream_model, forced_provider_id) =
        if let Some(target) = snap.alias_to_provider_model.get(requested_model) {
            if !target.enabled {
                return Err((StatusCode::FORBIDDEN, "model disabled".to_string()));
            }
            (target.upstream_model.clone(), Some(target.provider_id))
        } else {
            (requested_model.to_string(), None)
        };
    if !snap.is_model_globally_enabled(&upstream_model) {
        return Err((StatusCode::FORBIDDEN, "model disabled".to_string()));
    }
    for provider in &snap.providers {
        if forced_provider_id.is_some_and(|id| id != provider.id)
            || !route_allows_provider_for_model(snap, &upstream_model, provider.id)
            || !provider_supports_api_format(&provider.provider_type, api_format)
            || !provider_model_enabled(snap, provider.id, &upstream_model)
        {
            continue;
        }
        routes.push(ProviderRoute {
            provider: provider.clone(),
            upstream_model: upstream_model.clone(),
            route_priority: None,
            route_weight: None,
        });
    }
    Ok(routes)
}

fn provider_matching_groups<'a>(
    snap: &'a UpstreamSnapshot,
    provider_id: i64,
    authorized_group_ids: &'a HashSet<i64>,
) -> impl Iterator<Item = &'a crate::types::ProviderGroupMembership> {
    snap.groups_by_provider
        .get(&provider_id)
        .into_iter()
        .flatten()
        .filter(|membership| authorized_group_ids.contains(&membership.group_id))
}

fn effective_provider_priority(
    snap: &UpstreamSnapshot,
    provider: &UpstreamProvider,
    authorized_group_ids: &HashSet<i64>,
    route_priority: Option<i32>,
) -> i32 {
    effective_priority_from_memberships(
        provider,
        provider_matching_groups(snap, provider.id, authorized_group_ids),
        route_priority,
    )
}

fn effective_priority_from_memberships<'a>(
    provider: &UpstreamProvider,
    memberships: impl Iterator<Item = &'a crate::types::ProviderGroupMembership>,
    route_priority: Option<i32>,
) -> i32 {
    memberships
        .filter_map(|membership| membership.priority_override)
        .min()
        .unwrap_or_else(|| route_priority.unwrap_or(provider.priority))
}

fn order_schedulable_providers(
    mut providers: Vec<SchedulableProvider>,
    affinity_provider_id: Option<i64>,
) -> Vec<SchedulableProvider> {
    let mut ordered = Vec::with_capacity(providers.len());
    if let Some(provider_id) = affinity_provider_id
        && let Some(index) = providers
            .iter()
            .position(|provider| provider.route.provider.id == provider_id)
    {
        ordered.push(providers.swap_remove(index));
    }

    while !providers.is_empty() {
        let best_priority = providers
            .iter()
            .map(|provider| provider.effective_priority)
            .min()
            .unwrap_or(i32::MAX);
        let mut priority_group = Vec::new();
        let mut remaining = Vec::new();
        for provider in providers {
            if provider.effective_priority == best_priority {
                priority_group.push(provider);
            } else {
                remaining.push(provider);
            }
        }
        while !priority_group.is_empty() {
            let first = weighted_sample_provider(&priority_group);
            let second = weighted_sample_provider(&priority_group);
            let selected =
                if provider_load_is_lower(&priority_group[second], &priority_group[first]) {
                    second
                } else {
                    first
                };
            ordered.push(priority_group.swap_remove(selected));
        }
        providers = remaining;
    }
    ordered
}

fn weighted_sample_provider(providers: &[SchedulableProvider]) -> usize {
    let total_weight = providers
        .iter()
        .map(|provider| provider.effective_weight.max(0) as i64)
        .sum::<i64>();
    if total_weight <= 0 {
        return fastrand::usize(..providers.len());
    }
    let mut offset = fastrand::i64(0..total_weight);
    for (index, provider) in providers.iter().enumerate() {
        let weight = provider.effective_weight.max(0) as i64;
        if offset < weight {
            return index;
        }
        offset -= weight;
    }
    providers.len() - 1
}

fn provider_load_is_lower(left: &SchedulableProvider, right: &SchedulableProvider) -> bool {
    let utilization = |provider: &SchedulableProvider| {
        provider
            .max_concurrency
            .map_or(provider.in_flight as f64, |limit| {
                provider.in_flight as f64 / limit.max(1) as f64
            })
    };
    utilization(left)
        .total_cmp(&utilization(right))
        .then_with(|| {
            left.latency_ewma_ms
                .unwrap_or(i64::MAX)
                .cmp(&right.latency_ewma_ms.unwrap_or(i64::MAX))
        })
        .then_with(|| left.route.provider.id.cmp(&right.route.provider.id))
        .is_lt()
}

fn route_allows_provider_for_model(
    snap: &UpstreamSnapshot,
    upstream_model: &str,
    provider_id: i64,
) -> bool {
    let Some(route) = snap.routes_by_model.get(upstream_model) else {
        return true;
    };
    if !route.enabled || route.provider_ids.is_empty() {
        return true;
    }
    route.provider_ids.contains(&provider_id)
}

fn provider_model_enabled(snap: &UpstreamSnapshot, provider_id: i64, upstream_model: &str) -> bool {
    snap.provider_models_by_provider
        .get(&provider_id)
        .and_then(|items| items.get(upstream_model).copied())
        .unwrap_or(true)
}

fn key_allows_model(snap: &UpstreamSnapshot, key_id: i64, upstream_model: &str) -> bool {
    match snap.key_models_by_key.get(&key_id) {
        Some(models) => models.get(upstream_model).copied().unwrap_or(false),
        None => true,
    }
}

fn order_keys_for_provider(
    state: &SharedState,
    provider_id: i64,
    strategy: &str,
    ranked_keys: &[&UpstreamKey],
) -> Vec<UpstreamKey> {
    let keys = ranked_keys
        .iter()
        .map(|key| (*key).clone())
        .collect::<Vec<_>>();
    if strategy == "round_robin" {
        state.key_rotation.rotate_provider(provider_id, &keys)
    } else {
        keys
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureScope {
    Success,
    Key,
    Quota,
    Model,
    Provider,
    Client,
}

impl FailureScope {
    pub(crate) fn is_retryable(self) -> bool {
        matches!(self, Self::Key | Self::Quota | Self::Model | Self::Provider)
    }

    pub(crate) fn should_migrate_affinity(self) -> bool {
        matches!(self, Self::Key | Self::Model | Self::Provider)
    }

    pub(crate) fn should_avoid_affinity_immediately(self) -> bool {
        matches!(self, Self::Model | Self::Provider)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OutcomeOrigin {
    UpstreamResponse,
    UpstreamEvent,
    LocalTransport,
    Gateway,
}

pub(crate) fn classify_failure_scope(status: Option<i32>, origin: OutcomeOrigin) -> FailureScope {
    if origin == OutcomeOrigin::LocalTransport {
        return FailureScope::Provider;
    }
    match status {
        Some(200..=399) => FailureScope::Success,
        Some(401 | 403) => FailureScope::Key,
        Some(402 | 429) => FailureScope::Quota,
        Some(404) => FailureScope::Model,
        Some(408 | 409 | 425) => FailureScope::Provider,
        Some(code) if code >= 500 => FailureScope::Provider,
        Some(400..=499) => FailureScope::Client,
        _ => FailureScope::Provider,
    }
}

pub(crate) struct AttemptOutcome<'a> {
    pub(crate) status: Option<i32>,
    pub(crate) origin: OutcomeOrigin,
    pub(crate) error_type: Option<&'a str>,
    pub(crate) error_message: Option<&'a str>,
    pub(crate) observed_latency_ms: Option<i64>,
}

impl<'a> AttemptOutcome<'a> {
    pub(crate) fn upstream_response(
        status: i32,
        error_type: Option<&'a str>,
        error_message: Option<&'a str>,
        observed_latency_ms: Option<i64>,
    ) -> Self {
        Self {
            status: Some(status),
            origin: OutcomeOrigin::UpstreamResponse,
            error_type,
            error_message,
            observed_latency_ms,
        }
    }

    pub(crate) fn local_provider(
        status: Option<i32>,
        error_type: &'a str,
        error_message: &'a str,
        observed_latency_ms: Option<i64>,
    ) -> Self {
        Self {
            status,
            origin: OutcomeOrigin::LocalTransport,
            error_type: Some(error_type),
            error_message: Some(error_message),
            observed_latency_ms,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttemptReservationError {
    Provider,
    Key,
    Endpoint,
    Quota,
}

pub(crate) struct UpstreamAttemptReservation {
    capacity: Option<ProviderCapacityPermit>,
    provider: Option<ProviderAttemptGuard>,
    endpoint: Option<RuntimeHealthAttemptGuard>,
    key: Option<RuntimeHealthAttemptGuard>,
}

impl UpstreamAttemptReservation {
    pub(crate) fn finish(mut self, outcome: AttemptOutcome<'_>, metrics: &crate::metrics::Metrics) {
        let scope = classify_failure_scope(outcome.status, outcome.origin);
        let now_ms = util::now_ms();
        let error_type = outcome.error_type.unwrap_or("upstream_error");
        let error_message = outcome.error_message.unwrap_or("upstream attempt failed");

        match scope {
            FailureScope::Success => {
                if let Some(endpoint) = self.endpoint.take() {
                    endpoint.success(outcome.status, outcome.observed_latency_ms, now_ms);
                }
                if let Some(key) = self.key.take() {
                    key.success(outcome.status, outcome.observed_latency_ms, now_ms);
                }
                if let Some(provider) = self.provider.take() {
                    provider.success(outcome.status, outcome.observed_latency_ms, now_ms);
                }
            }
            FailureScope::Key => {
                if let Some(endpoint) = self.endpoint.take() {
                    endpoint.success(outcome.status, outcome.observed_latency_ms, now_ms);
                }
                if let Some(key) = self.key.take() {
                    key.failure(
                        outcome.status,
                        outcome.error_type,
                        outcome.error_message,
                        now_ms,
                    );
                }
                neutral_provider(self.provider.take());
            }
            FailureScope::Model | FailureScope::Client => {
                if let Some(endpoint) = self.endpoint.take() {
                    endpoint.success(outcome.status, outcome.observed_latency_ms, now_ms);
                }
                if let Some(key) = self.key.take() {
                    key.success(outcome.status, outcome.observed_latency_ms, now_ms);
                }
                neutral_provider(self.provider.take());
            }
            FailureScope::Quota => {
                neutral_health(self.endpoint.take(), now_ms);
                neutral_health(self.key.take(), now_ms);
                neutral_provider(self.provider.take());
            }
            FailureScope::Provider => {
                if let Some(endpoint) = self.endpoint.take() {
                    endpoint.failure(
                        outcome.status,
                        outcome.error_type,
                        outcome.error_message,
                        now_ms,
                    );
                }
                neutral_health(self.key.take(), now_ms);
                if let Some(provider) = self.provider.take()
                    && provider.failure(outcome.status, error_type, error_message, now_ms)
                        == BreakerTransition::Opened
                {
                    metrics.record_provider_breaker_open();
                }
            }
        }
    }

    pub(crate) fn neutral(mut self) {
        let now_ms = util::now_ms();
        neutral_health(self.endpoint.take(), now_ms);
        neutral_health(self.key.take(), now_ms);
        neutral_provider(self.provider.take());
    }

    pub(crate) fn into_capacity(mut self) -> Option<ProviderCapacityPermit> {
        let now_ms = util::now_ms();
        neutral_health(self.endpoint.take(), now_ms);
        neutral_health(self.key.take(), now_ms);
        neutral_provider(self.provider.take());
        self.capacity.take()
    }
}

fn neutral_health(guard: Option<RuntimeHealthAttemptGuard>, now_ms: i64) {
    if let Some(guard) = guard {
        guard.neutral(now_ms);
    }
}

fn neutral_provider(guard: Option<ProviderAttemptGuard>) {
    if let Some(guard) = guard {
        guard.neutral();
    }
}

pub(crate) fn reserve_attempt(
    state: &SharedState,
    resolved: &ResolvedUpstream,
    now_ms: i64,
) -> Result<UpstreamAttemptReservation, AttemptReservationError> {
    reserve_attempt_inner(state, resolved, now_ms, true, true)
}

pub(crate) fn reserve_ws_connection(
    state: &SharedState,
    resolved: &ResolvedUpstream,
    now_ms: i64,
) -> Result<UpstreamAttemptReservation, AttemptReservationError> {
    reserve_attempt_inner(state, resolved, now_ms, true, false)
}

pub(crate) fn reserve_ws_turn(
    state: &SharedState,
    resolved: &ResolvedUpstream,
    now_ms: i64,
) -> Result<UpstreamAttemptReservation, AttemptReservationError> {
    reserve_attempt_inner(state, resolved, now_ms, false, true)
}

fn reserve_attempt_inner(
    state: &SharedState,
    resolved: &ResolvedUpstream,
    now_ms: i64,
    acquire_capacity: bool,
    reserve_quota: bool,
) -> Result<UpstreamAttemptReservation, AttemptReservationError> {
    let capacity = if acquire_capacity {
        Some(
            state
                .provider_runtime
                .try_acquire_capacity(&resolved.provider)
                .ok_or(AttemptReservationError::Provider)?,
        )
    } else {
        None
    };
    let provider = state
        .provider_runtime
        .try_begin_attempt(&resolved.provider, now_ms)
        .ok_or(AttemptReservationError::Provider)?;
    if provider.is_half_open_probe() {
        state.metrics.record_provider_breaker_probe();
    }
    let key = state
        .upstream_key_health
        .try_begin_attempt(resolved.key.id, now_ms)
        .ok_or(AttemptReservationError::Key)?;
    let endpoint = state
        .endpoint_health
        .try_begin_attempt(resolved.endpoint.id, now_ms)
        .ok_or(AttemptReservationError::Endpoint)?;
    if reserve_quota && !state.quota.reserve_request(resolved.key.id, now_ms) {
        return Err(AttemptReservationError::Quota);
    }
    Ok(UpstreamAttemptReservation {
        capacity,
        provider: Some(provider),
        endpoint: Some(endpoint),
        key: Some(key),
    })
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

fn has_remaining_provider_candidate(
    attempts: &[ResolvedUpstream],
    start_index: usize,
    exclusions: &AttemptExclusions,
    provider_id: i64,
) -> bool {
    attempts[start_index..]
        .iter()
        .any(|resolved| resolved.provider.id == provider_id && !exclusions.should_skip(resolved))
}

pub(crate) fn should_retry_response_status(status: i32) -> bool {
    matches!(status, 401 | 402 | 403 | 404 | 408 | 409 | 425 | 429) || status >= 500
}

fn note_affinity_failure(
    state: &SharedState,
    resolved: &ResolvedUpstream,
    scope: FailureScope,
    affinity_identity: Option<&AffinityIdentity>,
    faulted_providers: &mut HashSet<i64>,
) {
    if !scope.should_migrate_affinity() {
        return;
    }
    faulted_providers.insert(resolved.provider.id);
    if scope.should_avoid_affinity_immediately()
        && let Some(identity) = affinity_identity
    {
        let now_ms = util::now_ms();
        state.affinity.mark_provider_failed(
            identity,
            resolved.provider.id,
            now_ms,
            std::time::Duration::from_millis(
                resolved.provider.circuit_breaker_open_ms.max(1) as u64
            ),
        );
    }
}

pub(crate) fn build_upstream_uri(
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

pub(crate) fn sanitize_hop_headers(headers: &mut hyper::HeaderMap) {
    headers.remove(CONNECTION);
    headers.remove(TRANSFER_ENCODING);
    headers.remove(UPGRADE);
    headers.remove(TE);
    headers.remove(TRAILER);
    headers.remove(PROXY_AUTHENTICATE);
    headers.remove(PROXY_AUTHORIZATION);
    headers.remove(HOST);
}

pub(crate) fn build_upstream_headers(
    request_headers: &HeaderMap,
    body_len: usize,
    upstream_secret: &str,
) -> HeaderMap {
    let mut headers = HeaderMap::new();
    copy_allowed_upstream_header(request_headers, &mut headers, CONTENT_TYPE);
    copy_allowed_upstream_header(request_headers, &mut headers, ACCEPT);
    copy_allowed_upstream_header_by_name(request_headers, &mut headers, "openai-beta");
    copy_allowed_upstream_header_by_name(request_headers, &mut headers, "openai-organization");
    copy_allowed_upstream_header_by_name(request_headers, &mut headers, "openai-project");
    copy_allowed_upstream_header_by_name(request_headers, &mut headers, "idempotency-key");
    copy_allowed_upstream_header_by_name(request_headers, &mut headers, "x-client-request-id");
    copy_allowed_upstream_header_by_name(request_headers, &mut headers, "session-id");
    copy_allowed_upstream_header_by_name(request_headers, &mut headers, "thread-id");
    copy_allowed_upstream_header_by_name(request_headers, &mut headers, "originator");
    copy_allowed_upstream_headers_by_prefix(request_headers, &mut headers, "x-codex-");
    copy_allowed_upstream_header(request_headers, &mut headers, USER_AGENT);

    if let Ok(value) = hyper::header::HeaderValue::from_str(&body_len.to_string()) {
        headers.insert(CONTENT_LENGTH, value);
    }
    if let Ok(value) = hyper::header::HeaderValue::from_str(&format!("Bearer {upstream_secret}")) {
        headers.insert(AUTHORIZATION, value);
    }
    headers
}

fn copy_allowed_upstream_header(
    from: &HeaderMap,
    to: &mut HeaderMap,
    name: hyper::header::HeaderName,
) {
    if let Some(value) = from.get(&name) {
        to.insert(name, value.clone());
    }
}

fn copy_allowed_upstream_header_by_name(from: &HeaderMap, to: &mut HeaderMap, name: &'static str) {
    if let Some(value) = from.get(name) {
        to.insert(hyper::header::HeaderName::from_static(name), value.clone());
    }
}

fn copy_allowed_upstream_headers_by_prefix(from: &HeaderMap, to: &mut HeaderMap, prefix: &str) {
    for (name, value) in from {
        if name.as_str().starts_with(prefix) {
            to.insert(name.clone(), value.clone());
        }
    }
}

struct ReplayIncomingBody {
    buffered: VecDeque<Frame<Bytes>>,
    inner: Incoming,
}

impl ReplayIncomingBody {
    fn new(inner: Incoming) -> Self {
        Self {
            buffered: VecDeque::new(),
            inner,
        }
    }
}

impl hyper::body::Body for ReplayIncomingBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        if let Some(frame) = self.buffered.pop_front() {
            return Poll::Ready(Some(Ok(frame)));
        }
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.buffered.is_empty() && self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        let buffered_bytes = self
            .buffered
            .iter()
            .filter_map(Frame::data_ref)
            .map(Bytes::len)
            .sum::<usize>() as u64;
        let inner = self.inner.size_hint();
        let mut hint = SizeHint::new();
        hint.set_lower(inner.lower().saturating_add(buffered_bytes));
        if let Some(upper) = inner
            .upper()
            .and_then(|value| value.checked_add(buffered_bytes))
        {
            hint.set_upper(upper);
        }
        hint
    }
}

async fn preflight_sse(
    mut inner: Incoming,
    api_format: &'static str,
    timeout: std::time::Duration,
    max_bytes: usize,
) -> Result<ReplayIncomingBody, String> {
    let preflight = async {
        let mut parser = SseParser::new(api_format);
        let mut buffered = VecDeque::new();
        let mut buffered_bytes = 0usize;
        loop {
            let Some(frame) = inner.frame().await else {
                return Err("upstream SSE ended before its first valid event".to_string());
            };
            let frame = frame.map_err(|error| {
                format!("upstream SSE failed before its first valid event: {error}")
            })?;
            if let Some(data) = frame.data_ref() {
                buffered_bytes = buffered_bytes.saturating_add(data.len());
                if buffered_bytes > max_bytes {
                    return Err(format!(
                        "upstream SSE exceeded the {max_bytes}-byte first-event buffer"
                    ));
                }
                let parsed = parser.push_bytes(data);
                if parsed.saw_error_event {
                    return Err(
                        "upstream SSE returned an error before its first valid event".to_string(),
                    );
                }
                buffered.push_back(frame);
                if parsed.saw_valid_event {
                    return Ok(ReplayIncomingBody { buffered, inner });
                }
            } else {
                buffered.push_back(frame);
            }
        }
    };

    time::timeout(timeout, preflight).await.map_err(|_| {
        format!(
            "upstream SSE did not produce a valid event within {} ms",
            timeout.as_millis()
        )
    })?
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
    price: Option<PriceVersion>,
    usage_capture_bytes: usize,
    usage_capture_tail_bytes: usize,
    provider: UpstreamProvider,
    metrics: std::sync::Arc<crate::metrics::Metrics>,
    affinity: std::sync::Arc<crate::affinity::AffinityBook>,
    affinity_identity: Option<AffinityIdentity>,
    affinity_binding: Option<AffinityBinding>,
    affinity_should_migrate: bool,
    routing_trace: SharedRoutingTrace,
}

struct TapFinalizeInputs<'a> {
    first_byte_ms: Option<i64>,
    first_token_ms: Option<i64>,
    usage: &'a mut Usage,
    usage_observed: &'a mut bool,
    error_type: &'a Option<String>,
    error_message: &'a Option<String>,
    capture: &'a UsageCaptureBuffer,
}

pin_project! {
    struct ProxyTapBody {
        #[pin]
        inner: ReplayIncomingBody,
        cfg: TapConfig,
        telemetry_permit: Option<mpsc::OwnedPermit<TelemetryEvent>>,
        reservation: Option<UpstreamAttemptReservation>,

        finalized: bool,
        first_byte_ms: Option<i64>,
        first_token_ms: Option<i64>,
        usage: Usage,
        usage_observed: bool,
        error_type: Option<String>,
        error_message: Option<String>,

        capture: UsageCaptureBuffer,
        sse: Option<SseParser>,
    }

    impl PinnedDrop for ProxyTapBody {
        fn drop(this: Pin<&mut Self>) {
            let this = this.project();
            finalize_tap(
                this.cfg,
                this.telemetry_permit,
                this.reservation,
                this.finalized,
                TapFinalizeInputs {
                    first_byte_ms: *this.first_byte_ms,
                    first_token_ms: *this.first_token_ms,
                    usage: this.usage,
                    usage_observed: this.usage_observed,
                    error_type: this.error_type,
                    error_message: this.error_message,
                    capture: this.capture,
                },
            );
        }
    }
}

impl ProxyTapBody {
    fn new(
        inner: ReplayIncomingBody,
        cfg: TapConfig,
        telemetry_permit: Option<mpsc::OwnedPermit<TelemetryEvent>>,
        reservation: UpstreamAttemptReservation,
    ) -> Self {
        let sse = if cfg.is_sse {
            Some(SseParser::new(cfg.api_format))
        } else {
            None
        };
        let capture =
            UsageCaptureBuffer::new(cfg.usage_capture_bytes, cfg.usage_capture_tail_bytes);
        Self {
            inner,
            cfg,
            telemetry_permit,
            reservation: Some(reservation),
            finalized: false,
            first_byte_ms: None,
            first_token_ms: None,
            usage: Usage::default(),
            usage_observed: false,
            error_type: None,
            error_message: None,
            capture,
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
                    this.reservation,
                    this.finalized,
                    TapFinalizeInputs {
                        first_byte_ms: *this.first_byte_ms,
                        first_token_ms: *this.first_token_ms,
                        usage: this.usage,
                        usage_observed: this.usage_observed,
                        error_type: this.error_type,
                        error_message: this.error_message,
                        capture: this.capture,
                    },
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
                            *this.usage_observed = true;
                        }
                    } else {
                        this.capture.push(data);
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
                    this.reservation,
                    this.finalized,
                    TapFinalizeInputs {
                        first_byte_ms: *this.first_byte_ms,
                        first_token_ms: *this.first_token_ms,
                        usage: this.usage,
                        usage_observed: this.usage_observed,
                        error_type: this.error_type,
                        error_message: this.error_message,
                        capture: this.capture,
                    },
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

fn finalize_tap(
    cfg: &TapConfig,
    telemetry_permit: &mut Option<mpsc::OwnedPermit<TelemetryEvent>>,
    reservation: &mut Option<UpstreamAttemptReservation>,
    finalized: &mut bool,
    inputs: TapFinalizeInputs<'_>,
) {
    if *finalized {
        return;
    }
    *finalized = true;

    if !cfg.is_sse
        && !inputs.capture.is_empty()
        && let Some(u) = extract_usage_from_capture(cfg.api_format, inputs.capture)
    {
        *inputs.usage = u;
        *inputs.usage_observed = true;
    }

    let pricing = evaluate_price(inputs.usage, *inputs.usage_observed, cfg.price.as_ref());
    let now_ms = util::now_ms();
    let origin = if inputs.error_type.is_some() {
        OutcomeOrigin::LocalTransport
    } else {
        OutcomeOrigin::UpstreamResponse
    };
    let scope = classify_failure_scope(cfg.http_status, origin);
    let observed_latency_ms = inputs
        .first_byte_ms
        .or(inputs.first_token_ms)
        .or(cfg.t_stream_ms)
        .or_else(|| Some(cfg.start.elapsed().as_millis() as i64));
    if let Some(reservation) = reservation.take() {
        reservation.finish(
            AttemptOutcome {
                status: cfg.http_status,
                origin,
                error_type: inputs.error_type.as_deref(),
                error_message: inputs.error_message.as_deref(),
                observed_latency_ms,
            },
            &cfg.metrics,
        );
    }
    if scope == FailureScope::Success {
        if let (Some(identity), Some(binding)) =
            (cfg.affinity_identity.as_ref(), cfg.affinity_binding)
        {
            if binding.provider_id == cfg.provider.id {
                if binding.confirmed {
                    let _ = cfg
                        .affinity
                        .refresh_if_provider(identity, cfg.provider.id, now_ms);
                } else {
                    let _ = cfg.affinity.confirm(identity, binding, now_ms);
                }
            } else if cfg.affinity_should_migrate {
                cfg.affinity.migrate(identity, cfg.provider.id, now_ms);
                cfg.metrics.record_affinity_migration();
            }
        }
    } else if scope.should_avoid_affinity_immediately()
        && let Some(identity) = cfg.affinity_identity.as_ref()
    {
        cfg.affinity.mark_provider_failed(
            identity,
            cfg.provider.id,
            now_ms,
            std::time::Duration::from_millis(cfg.provider.circuit_breaker_open_ms.max(1) as u64),
        );
    }
    let duration_ms = Some(cfg.start.elapsed().as_millis() as i64);
    {
        let mut trace = cfg.routing_trace.lock();
        if trace.attempts.len() < 40 {
            trace.attempts.push(serde_json::json!({
                "provider_id": cfg.provider_id,
                "endpoint_id": cfg.endpoint_id,
                "upstream_key_id": cfg.upstream_key_id,
                "status": cfg.http_status,
                "error_type": inputs.error_type,
                "duration_ms": duration_ms,
            }));
        }
        trace.terminal = Some(serde_json::json!({
            "status": cfg.http_status,
            "error_type": inputs.error_type,
        }));
    }
    cfg.metrics.record_request_str(
        cfg.api_format,
        RequestMetric {
            http_status: cfg.http_status,
            error_type: inputs.error_type.as_deref(),
            duration_ms,
            usage: *inputs.usage,
            pricing,
        },
    );

    let event = TelemetryEvent {
        id: None,
        api_key_id: cfg.api_key_id,
        log_enabled: cfg.log_enabled,
        provider_id: cfg.provider_id,
        endpoint_id: cfg.endpoint_id,
        upstream_key_id: cfg.upstream_key_id,
        api_format: cfg.api_format,
        model: cfg.model.clone(),
        http_status: cfg.http_status,
        error_type: inputs.error_type.clone(),
        error_message: inputs.error_message.clone(),
        t_stream_ms: cfg.t_stream_ms,
        t_first_byte_ms: inputs.first_byte_ms,
        t_first_token_ms: inputs.first_token_ms,
        duration_ms: Some(cfg.start.elapsed().as_millis() as i64),
        usage: *inputs.usage,
        usage_observed: *inputs.usage_observed,
        price_version_id: cfg.price.as_ref().map(|price| price.id),
        price_tier_index: pricing.tier_index,
        time_ms: util::now_ms(),
        span_kind: "request",
        transport: "http",
        parent_id: None,
        ws_session_id: None,
        routing_trace: Some(routing_trace_value(&cfg.routing_trace)),
    };

    let Some(permit) = telemetry_permit.take() else {
        return;
    };
    let _ = permit.send(event);
}

struct UsageCaptureBuffer {
    head: BytesMut,
    tail: BytesMut,
    total_seen: usize,
    head_limit: usize,
    tail_limit: usize,
}

impl UsageCaptureBuffer {
    fn new(max_bytes: usize, tail_bytes: usize) -> Self {
        let max_bytes = max_bytes.max(1);
        let tail_limit = tail_bytes.min(max_bytes);
        let head_limit = max_bytes - tail_limit;
        Self {
            head: BytesMut::with_capacity(head_limit.min(8 * 1024)),
            tail: BytesMut::with_capacity(tail_limit.min(8 * 1024)),
            total_seen: 0,
            head_limit,
            tail_limit,
        }
    }

    fn push(&mut self, data: &Bytes) {
        let mut remaining = data.as_ref();
        self.total_seen = self.total_seen.saturating_add(remaining.len());

        if self.head.len() < self.head_limit {
            let take = (self.head_limit - self.head.len()).min(remaining.len());
            self.head.extend_from_slice(&remaining[..take]);
            remaining = &remaining[take..];
        }

        self.push_tail(remaining);
    }

    fn push_tail(&mut self, bytes: &[u8]) {
        if self.tail_limit == 0 || bytes.is_empty() {
            return;
        }

        if bytes.len() >= self.tail_limit {
            self.tail.clear();
            self.tail
                .extend_from_slice(&bytes[bytes.len() - self.tail_limit..]);
            return;
        }

        self.tail.extend_from_slice(bytes);
        if self.tail.len() > self.tail_limit {
            let overflow = self.tail.len() - self.tail_limit;
            let _ = self.tail.split_to(overflow);
        }
    }

    fn is_empty(&self) -> bool {
        self.head.is_empty() && self.tail.is_empty()
    }

    fn is_truncated(&self) -> bool {
        self.total_seen > self.head_limit.saturating_add(self.tail_limit)
    }

    fn to_vec(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.head.len() + self.tail.len());
        out.extend_from_slice(&self.head);
        out.extend_from_slice(&self.tail);
        out
    }
}

fn extract_usage_from_capture(
    api_format: &'static str,
    capture: &UsageCaptureBuffer,
) -> Option<Usage> {
    let window = capture.to_vec();
    if !capture.is_truncated()
        && let Ok(v) = serde_json::from_slice::<Value>(&window)
        && let Some(usage) = extract_usage(api_format, &v)
    {
        return Some(usage);
    }

    extract_usage_from_window(api_format, &window)
}

fn extract_usage_from_window(api_format: &'static str, window: &[u8]) -> Option<Usage> {
    let mut search_end = window.len();
    while let Some(key_pos) = rfind_subslice(&window[..search_end], b"\"usage\"") {
        if let Some((start, end)) = json_value_span_after_key(window, key_pos)
            && let Ok(v) = serde_json::from_slice::<Value>(&window[start..end])
            && let Some(usage) = parse_usage_value(api_format, &v)
        {
            return Some(usage);
        }
        search_end = key_pos;
    }
    None
}

fn parse_usage_value(api_format: &'static str, value: &Value) -> Option<Usage> {
    match api_format {
        "chat_completions" => parse_chat_usage(value),
        "responses" => parse_responses_usage(value),
        _ => None,
    }
}

fn rfind_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rposition(|candidate| candidate == needle)
}

fn json_value_span_after_key(input: &[u8], key_pos: usize) -> Option<(usize, usize)> {
    let mut idx = key_pos.checked_add(b"\"usage\"".len())?;
    while idx < input.len() && input[idx].is_ascii_whitespace() {
        idx += 1;
    }
    if input.get(idx).copied()? != b':' {
        return None;
    }
    idx += 1;
    while idx < input.len() && input[idx].is_ascii_whitespace() {
        idx += 1;
    }
    let end = scan_json_value_end(input, idx)?;
    Some((idx, end))
}

fn scan_json_value_end(input: &[u8], start: usize) -> Option<usize> {
    if start >= input.len() {
        return None;
    }
    match input[start] {
        b'{' | b'[' => {
            let mut depth: i32 = 0;
            let mut in_string = false;
            let mut escape = false;
            let mut idx = start;
            while idx < input.len() {
                let byte = input[idx];
                if in_string {
                    if escape {
                        escape = false;
                    } else if byte == b'\\' {
                        escape = true;
                    } else if byte == b'"' {
                        in_string = false;
                    }
                    idx += 1;
                    continue;
                }

                match byte {
                    b'"' => {
                        in_string = true;
                        escape = false;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(idx + 1);
                        }
                    }
                    _ => {}
                }
                idx += 1;
            }
            None
        }
        b'"' => {
            let mut idx = start + 1;
            let mut escape = false;
            while idx < input.len() {
                let byte = input[idx];
                if escape {
                    escape = false;
                } else if byte == b'\\' {
                    escape = true;
                } else if byte == b'"' {
                    return Some(idx + 1);
                }
                idx += 1;
            }
            None
        }
        _ => {
            let mut idx = start;
            while idx < input.len() {
                let byte = input[idx];
                if byte == b',' || byte == b'}' || byte == b']' || byte.is_ascii_whitespace() {
                    break;
                }
                idx += 1;
            }
            Some(idx)
        }
    }
}

#[derive(Default)]
struct SsePushOut {
    saw_first_token: bool,
    saw_valid_event: bool,
    saw_error_event: bool,
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

            if let Some(after) = line
                .strip_prefix(b"data: ")
                .or_else(|| line.strip_prefix(b"data:"))
            {
                if after == b"[DONE]" {
                    continue;
                }

                if self.done_usage && self.done_first_token {
                    continue;
                }

                let Ok(v) = serde_json::from_slice::<Value>(after) else {
                    continue;
                };
                let event_type = self
                    .event
                    .as_deref()
                    .or_else(|| v.get("type").and_then(Value::as_str));
                if event_type.is_some_and(|value| {
                    value == "error"
                        || value.ends_with(".error")
                        || value.ends_with(".failed")
                        || value.ends_with("_error")
                }) || v.get("error").is_some_and(|error| !error.is_null())
                {
                    out.saw_error_event = true;
                    continue;
                }
                out.saw_valid_event = true;

                if !self.done_first_token {
                    if self.api_format == "chat_completions" && chat_has_output_delta(&v) {
                        out.saw_first_token = true;
                        self.done_first_token = true;
                    } else if self.api_format == "responses"
                        && let Some(ev) = self.event.as_deref()
                        && ev.ends_with(".delta")
                        && responses_has_delta(&v)
                    {
                        out.saw_first_token = true;
                        self.done_first_token = true;
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
    let cache_created = v
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cache_creation_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let reasoning = v
        .get("completion_tokens_details")
        .and_then(|d| d.get("reasoning_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);

    Some(Usage {
        input_tokens: (prompt - cached - cache_created).max(0),
        output_tokens: completion.max(0),
        cache_read_input_tokens: cached.max(0),
        cache_creation_input_tokens: cache_created.max(0),
        reasoning_output_tokens: reasoning.max(0),
    })
}

pub(crate) fn parse_responses_usage(v: &Value) -> Option<Usage> {
    let input = v.get("input_tokens")?.as_i64()?;
    let output = v.get("output_tokens")?.as_i64()?;
    let cached = v
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let cache_created = v
        .get("input_tokens_details")
        .and_then(|d| d.get("cache_creation_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let reasoning = v
        .get("output_tokens_details")
        .and_then(|d| d.get("reasoning_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);

    Some(Usage {
        input_tokens: (input - cached - cache_created).max(0),
        output_tokens: output.max(0),
        cache_read_input_tokens: cached.max(0),
        cache_creation_input_tokens: cache_created.max(0),
        reasoning_output_tokens: reasoning.max(0),
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

pub(crate) fn responses_has_delta(v: &Value) -> bool {
    v.get("delta")
        .and_then(|x| x.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{
        AttemptOutcome, FailureScope, OutcomeOrigin, ProviderRoute, SchedulableProvider, SseParser,
        UpstreamAttemptReservation, UsageCaptureBuffer, build_scheduled_attempts,
        build_upstream_headers, classify_failure_scope, effective_priority_from_memberships,
        extract_usage_from_capture, parse_chat_usage, parse_responses_usage,
        should_retry_response_status,
    };
    use crate::health::RuntimeHealthBook;
    use crate::metrics::Metrics;
    use crate::provider_runtime::ProviderRuntimeBook;
    use crate::types::{UpstreamKey, UpstreamProvider};
    use bytes::Bytes;
    use hyper::header::{
        ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HeaderName,
        HeaderValue, USER_AGENT,
    };
    use hyper::http::HeaderMap;
    use serde_json::json;
    use std::collections::HashSet;
    use std::sync::Arc;

    #[test]
    fn parse_chat_usage_should_split_cached_and_cache_creation_tokens() {
        let usage = parse_chat_usage(&json!({
            "prompt_tokens": 20,
        "completion_tokens": 7,
        "completion_tokens_details": {
            "reasoning_tokens": 2
        },
        "prompt_tokens_details": {
            "cached_tokens": 3,
            "cache_creation_tokens": 5
            }
        }))
        .expect("usage");

        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 7);
        assert_eq!(usage.cache_read_input_tokens, 3);
        assert_eq!(usage.cache_creation_input_tokens, 5);
        assert_eq!(usage.reasoning_output_tokens, 2);
    }

    #[test]
    fn parse_responses_usage_should_split_cached_and_cache_creation_tokens() {
        let usage = parse_responses_usage(&json!({
            "input_tokens": 18,
            "output_tokens": 4,
            "output_tokens_details": {
                "reasoning_tokens": 3
            },
            "input_tokens_details": {
                "cached_tokens": 2,
                "cache_creation_tokens": 6
            }
        }))
        .expect("usage");

        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 4);
        assert_eq!(usage.cache_read_input_tokens, 2);
        assert_eq!(usage.cache_creation_input_tokens, 6);
        assert_eq!(usage.reasoning_output_tokens, 3);
    }

    #[test]
    fn parse_chat_usage_should_record_reasoning_as_part_of_output_tokens() {
        let usage = parse_chat_usage(&json!({
            "prompt_tokens": 5,
            "completion_tokens": 11,
            "completion_tokens_details": {
                "reasoning_tokens": 7
            }
        }))
        .expect("usage");

        assert_eq!(usage.output_tokens, 11);
        assert_eq!(usage.reasoning_output_tokens, 7);
    }

    #[test]
    fn parse_responses_usage_should_record_reasoning_as_part_of_output_tokens() {
        let usage = parse_responses_usage(&json!({
            "input_tokens": 6,
            "output_tokens": 13,
            "output_tokens_details": {
                "reasoning_tokens": 8
            }
        }))
        .expect("usage");

        assert_eq!(usage.output_tokens, 13);
        assert_eq!(usage.reasoning_output_tokens, 8);
    }

    #[test]
    fn build_upstream_headers_should_preserve_allowed_api_headers() {
        let mut input = HeaderMap::new();
        input.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        input.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        input.insert("openai-beta", HeaderValue::from_static("responses=v1"));
        input.insert("openai-organization", HeaderValue::from_static("org_123"));
        input.insert("openai-project", HeaderValue::from_static("proj_123"));
        input.insert("idempotency-key", HeaderValue::from_static("request-123"));

        let headers = build_upstream_headers(&input, 37, "sk-upstream");

        assert_eq!(headers.get(CONTENT_TYPE), input.get(CONTENT_TYPE));
        assert_eq!(headers.get(ACCEPT), input.get(ACCEPT));
        assert_eq!(headers.get("openai-beta"), input.get("openai-beta"));
        assert_eq!(
            headers.get("openai-organization"),
            input.get("openai-organization")
        );
        assert_eq!(headers.get("openai-project"), input.get("openai-project"));
        assert_eq!(headers.get("idempotency-key"), input.get("idempotency-key"));
    }

    #[test]
    fn build_upstream_headers_should_preserve_codex_client_headers() {
        let mut input = HeaderMap::new();
        input.insert(
            "x-codex-beta-features",
            HeaderValue::from_static("remote_compaction_v2"),
        );
        input.insert(
            "x-codex-window-id",
            HeaderValue::from_static("019f1a41-81de-7591-8fff-a83093fb98b7:0"),
        );
        input.insert(
            "x-codex-turn-metadata",
            HeaderValue::from_static("{\"request_kind\":\"turn\"}"),
        );
        input.insert(
            "x-client-request-id",
            HeaderValue::from_static("019f1a41-81de-7591-8fff-a83093fb98b7"),
        );
        input.insert(
            "session-id",
            HeaderValue::from_static("019f1a41-81de-7591-8fff-a83093fb98b7"),
        );
        input.insert(
            "thread-id",
            HeaderValue::from_static("019f1a41-81de-7591-8fff-a83093fb98b7"),
        );
        input.insert("originator", HeaderValue::from_static("codex-tui"));

        let headers = build_upstream_headers(&input, 37, "sk-upstream");

        assert_eq!(
            headers.get("x-codex-beta-features"),
            input.get("x-codex-beta-features")
        );
        assert_eq!(
            headers.get("x-codex-window-id"),
            input.get("x-codex-window-id")
        );
        assert_eq!(
            headers.get("x-codex-turn-metadata"),
            input.get("x-codex-turn-metadata")
        );
        assert_eq!(
            headers.get("x-client-request-id"),
            input.get("x-client-request-id")
        );
        assert_eq!(headers.get("session-id"), input.get("session-id"));
        assert_eq!(headers.get("thread-id"), input.get("thread-id"));
        assert_eq!(headers.get("originator"), input.get("originator"));
    }

    #[test]
    fn build_upstream_headers_should_replace_auth_and_length_but_preserve_user_agent() {
        let mut input = HeaderMap::new();
        input.insert(AUTHORIZATION, HeaderValue::from_static("Bearer client-key"));
        input.insert(CONTENT_LENGTH, HeaderValue::from_static("999"));
        input.insert(USER_AGENT, HeaderValue::from_static("api-client/1.0"));

        let headers = build_upstream_headers(&input, 42, "sk-upstream");

        assert_eq!(
            headers.get(AUTHORIZATION),
            Some(&HeaderValue::from_static("Bearer sk-upstream"))
        );
        assert_eq!(
            headers.get(CONTENT_LENGTH),
            Some(&HeaderValue::from_static("42"))
        );
        assert_eq!(
            headers.get(USER_AGENT),
            Some(&HeaderValue::from_static("api-client/1.0"))
        );
    }

    #[test]
    fn build_upstream_headers_should_omit_user_agent_when_absent() {
        let input = HeaderMap::new();

        let headers = build_upstream_headers(&input, 42, "sk-upstream");

        assert!(headers.get(USER_AGENT).is_none());
    }

    #[test]
    fn build_upstream_headers_should_drop_proxy_and_cdn_headers() {
        let mut input = HeaderMap::new();
        for name in [
            "x-real-ip",
            "x-forwarded-for",
            "x-forwarded-proto",
            "forwarded",
            "via",
            "cf-ray",
            "cf-connecting-ip",
            "cdn-loop",
            "true-client-ip",
        ] {
            input.insert(
                HeaderName::from_static(name),
                HeaderValue::from_static("ingress-value"),
            );
        }
        input.insert(COOKIE, HeaderValue::from_static("session=secret"));
        input.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip, br"));

        let headers = build_upstream_headers(&input, 5, "sk-upstream");

        for name in [
            "x-real-ip",
            "x-forwarded-for",
            "x-forwarded-proto",
            "forwarded",
            "via",
            "cf-ray",
            "cf-connecting-ip",
            "cdn-loop",
            "true-client-ip",
            "cookie",
            "accept-encoding",
        ] {
            assert!(
                !headers.contains_key(name),
                "header {name} should not be forwarded"
            );
        }
    }

    #[test]
    fn retry_429_should_have_quota_scope() {
        assert!(should_retry_response_status(429));
        assert_eq!(
            classify_failure_scope(Some(429), OutcomeOrigin::UpstreamResponse),
            FailureScope::Quota,
        );
    }

    #[test]
    fn usage_capture_should_parse_complete_chat_body_inside_window() {
        let body = Bytes::from_static(
            br#"{"id":"chatcmpl","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":3,"cache_creation_tokens":5}}}"#,
        );
        let mut capture = UsageCaptureBuffer::new(4096, 1024);

        capture.push(&body);
        let usage = extract_usage_from_capture("chat_completions", &capture).expect("usage");

        assert!(!capture.is_truncated());
        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 7);
        assert_eq!(usage.cache_read_input_tokens, 3);
        assert_eq!(usage.cache_creation_input_tokens, 5);
        assert_eq!(usage.reasoning_output_tokens, 0);
    }

    #[test]
    fn usage_capture_should_parse_tail_chat_usage_after_truncation() {
        let mut body = Vec::new();
        body.extend_from_slice(br#"{"id":"chatcmpl","choices":[{"message":{"content":""#);
        body.extend(std::iter::repeat_n(b'a', 4096));
        body.extend_from_slice(
            br#""}}],"usage":{"prompt_tokens":20,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":3,"cache_creation_tokens":5}}}"#,
        );
        let mut capture = UsageCaptureBuffer::new(256, 192);

        capture.push(&Bytes::from(body));
        let usage = extract_usage_from_capture("chat_completions", &capture).expect("usage");

        assert!(capture.is_truncated());
        assert!(capture.to_vec().len() <= 256);
        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 7);
        assert_eq!(usage.cache_read_input_tokens, 3);
        assert_eq!(usage.cache_creation_input_tokens, 5);
        assert_eq!(usage.reasoning_output_tokens, 0);
    }

    fn test_provider(id: i64, priority: i32, max_attempts: i32) -> UpstreamProvider {
        UpstreamProvider {
            id,
            name: format!("provider-{id}"),
            provider_type: "openai".to_string(),
            enabled: true,
            priority,
            weight: 1,
            supports_include_usage: true,
            websocket_enabled: true,
            beta_features: Vec::new(),
            key_selection_strategy: "round_robin".to_string(),
            max_attempts,
            max_concurrency: None,
            circuit_breaker_enabled: true,
            circuit_breaker_failure_threshold: 3,
            circuit_breaker_open_ms: 30_000,
            circuit_breaker_half_open_success_threshold: 2,
        }
    }

    fn finish_attempt(
        status: i32,
    ) -> (
        crate::health::RuntimeHealthView,
        crate::health::RuntimeHealthView,
        crate::provider_runtime::ProviderRuntimeView,
    ) {
        let provider = test_provider(7, 100, 2);
        let provider_book = Arc::new(ProviderRuntimeBook::new());
        let endpoint_book = Arc::new(RuntimeHealthBook::new(1, 30_000));
        let key_book = Arc::new(RuntimeHealthBook::new(1, 30_000));
        let now_ms = 1_000;
        let reservation = UpstreamAttemptReservation {
            capacity: None,
            provider: Some(
                provider_book
                    .try_begin_attempt(&provider, now_ms)
                    .expect("provider attempt"),
            ),
            endpoint: Some(
                endpoint_book
                    .try_begin_attempt(70, now_ms)
                    .expect("endpoint attempt"),
            ),
            key: Some(key_book.try_begin_attempt(71, now_ms).expect("key attempt")),
        };
        let error = (status >= 400).then_some("upstream_status");
        reservation.finish(
            AttemptOutcome::upstream_response(status, error, error, Some(12)),
            &Metrics::new(),
        );
        (
            endpoint_book.snapshot(70, now_ms + 1),
            key_book.snapshot(71, now_ms + 1),
            provider_book.snapshot(&provider, now_ms + 1),
        )
    }

    #[test]
    fn key_failure_should_record_endpoint_and_key_once_without_provider_outcome() {
        let (endpoint, key, provider) = finish_attempt(401);

        assert_eq!((endpoint.success_count, endpoint.failure_count), (1, 0));
        assert_eq!((key.success_count, key.failure_count), (0, 1));
        assert_eq!((provider.success_count, provider.failure_count), (0, 0));
    }

    #[test]
    fn provider_failure_should_record_endpoint_and_provider_once() {
        let (endpoint, key, provider) = finish_attempt(503);

        assert_eq!((endpoint.success_count, endpoint.failure_count), (0, 1));
        assert_eq!((key.success_count, key.failure_count), (0, 0));
        assert_eq!((provider.success_count, provider.failure_count), (0, 1));
    }

    #[test]
    fn model_and_quota_failures_should_not_count_as_provider_outcomes() {
        for status in [404, 429] {
            let (_, _, provider) = finish_attempt(status);
            assert_eq!(
                (provider.success_count, provider.failure_count),
                (0, 0),
                "provider outcome changed for status {status}",
            );
        }
    }

    fn schedulable_provider(id: i64, priority: i32) -> SchedulableProvider {
        let provider = test_provider(id, priority, 2);
        SchedulableProvider {
            route: ProviderRoute {
                provider,
                upstream_model: "model-a".to_string(),
                route_priority: None,
                route_weight: None,
            },
            effective_priority: priority,
            effective_weight: 1,
            keys: vec![
                UpstreamKey {
                    id: id * 10,
                    provider_id: id,
                    name: "key-a".to_string(),
                    secret: "secret".to_string(),
                    enabled: true,
                    priority: 100,
                    weight: 1,
                },
                UpstreamKey {
                    id: id * 10 + 1,
                    provider_id: id,
                    name: "key-b".to_string(),
                    secret: "secret".to_string(),
                    enabled: true,
                    priority: 100,
                    weight: 1,
                },
            ],
            endpoints: vec![crate::types::UpstreamEndpoint {
                id: id * 100,
                provider_id: id,
                name: "endpoint".to_string(),
                base_url: "https://example.com".to_string(),
                enabled: true,
                priority: 100,
                weight: 1,
            }],
            price: None,
            in_flight: 0,
            max_concurrency: None,
            latency_ewma_ms: None,
        }
    }

    #[test]
    fn affinity_provider_should_remain_first_after_higher_priority_provider_is_added() {
        let attempts = build_scheduled_attempts(
            vec![schedulable_provider(1, 10), schedulable_provider(2, 0)],
            Some(1),
        );

        assert_eq!(attempts.first().map(|attempt| attempt.provider.id), Some(1));
    }

    #[test]
    fn request_should_use_at_most_four_providers_and_each_provider_budget() {
        let providers = (1..=6)
            .map(|id| schedulable_provider(id, 100))
            .collect::<Vec<_>>();
        let attempts = build_scheduled_attempts(providers, None);
        let provider_ids = attempts
            .iter()
            .map(|attempt| attempt.provider.id)
            .collect::<HashSet<_>>();

        assert_eq!(provider_ids.len(), 4);
        assert_eq!(attempts.len(), 8);
        for provider_id in provider_ids {
            assert_eq!(
                attempts
                    .iter()
                    .filter(|attempt| attempt.provider.id == provider_id)
                    .count(),
                2
            );
        }
    }

    #[test]
    fn matching_group_priority_should_override_route_and_global_priority() {
        let provider = test_provider(1, 100, 2);
        let memberships = [
            crate::types::ProviderGroupMembership {
                group_id: 1,
                group_name: "one".to_string(),
                priority_override: Some(20),
            },
            crate::types::ProviderGroupMembership {
                group_id: 2,
                group_name: "two".to_string(),
                priority_override: Some(5),
            },
        ];

        assert_eq!(
            effective_priority_from_memberships(&provider, memberships.iter(), Some(50)),
            5
        );
        assert_eq!(
            effective_priority_from_memberships(
                &provider,
                std::iter::empty::<&crate::types::ProviderGroupMembership>(),
                Some(50),
            ),
            50
        );
    }

    #[test]
    fn sse_preflight_parser_should_ignore_keepalive_and_accept_first_json_event() {
        let mut parser = SseParser::new("responses");
        let keepalive = parser.push_bytes(&Bytes::from_static(b": keepalive\n\n"));
        assert!(!keepalive.saw_valid_event);
        assert!(!keepalive.saw_error_event);

        let event = parser.push_bytes(&Bytes::from_static(
            b"event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
        ));
        assert!(event.saw_valid_event);
        assert!(!event.saw_error_event);
    }

    #[test]
    fn sse_preflight_parser_should_reject_error_event() {
        let mut parser = SseParser::new("responses");
        let event = parser.push_bytes(&Bytes::from_static(
            b"event: response.failed\ndata: {\"type\":\"response.failed\"}\n\n",
        ));

        assert!(event.saw_error_event);
        assert!(!event.saw_valid_event);
    }

    #[test]
    fn failure_scope_should_follow_gateway_classification_table() {
        for (status, expected) in [
            (200, FailureScope::Success),
            (302, FailureScope::Success),
            (401, FailureScope::Key),
            (403, FailureScope::Key),
            (402, FailureScope::Quota),
            (429, FailureScope::Quota),
            (404, FailureScope::Model),
            (408, FailureScope::Provider),
            (409, FailureScope::Provider),
            (425, FailureScope::Provider),
            (503, FailureScope::Provider),
            (422, FailureScope::Client),
        ] {
            assert_eq!(
                classify_failure_scope(Some(status), OutcomeOrigin::UpstreamResponse),
                expected,
                "unexpected scope for status {status}",
            );
        }
        assert_eq!(
            classify_failure_scope(Some(400), OutcomeOrigin::LocalTransport),
            FailureScope::Provider,
        );
    }
}
