use base64::Engine;
use http_body_util::{BodyExt, Full, Limited};
use hyper::Uri;
use hyper::body::Bytes;
use hyper::body::Incoming;
use hyper::header::HOST;
use hyper::{Method, Request, StatusCode};
use serde::Deserialize;
use serde_json::Value;
use std::str::FromStr;

use crate::db::{RequestLogFilter, UsageBreakdownBy};
use crate::health::{
    EndpointHealthView, ProviderHealthView, UpstreamKeyHealthView, summarize_provider_health,
};
use crate::http::{self, HttpResponse};
use crate::state::SharedState;
use crate::types::{ApiKeyAuth, UpstreamEndpoint, UpstreamKeyMeta, UpstreamProvider};
use crate::util;
use rust_decimal::Decimal;
use tokio::time as tokio_time;

const ALLOWED_PROVIDER_TYPES: [&str; 4] = [
    "openai",
    "openai_compatible",
    "openai_codex_oauth",
    "openai_compatible_responses",
];

// Admin endpoints sometimes probe upstreams that can return arbitrary HTML/JSON.
// Keep these payloads bounded to avoid untrusted memory spikes.
const ADMIN_UPSTREAM_MODELS_BODY_MAX_BYTES: usize = 1024 * 1024;
const ADMIN_UPSTREAM_TEST_BODY_MAX_BYTES: usize = 16 * 1024;

fn validate_upstream_base_url(value: &str) -> Result<(), &'static str> {
    let uri: Uri = value.parse().map_err(|_| "invalid base_url")?;
    if !matches!(uri.scheme_str(), Some("http" | "https")) {
        return Err("invalid base_url");
    }
    if uri.authority().is_none() {
        return Err("invalid base_url");
    }
    Ok(())
}

pub async fn handle(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    if let Some(resp) = require_admin(&req, &state) {
        return resp;
    }

    let path = req.uri().path();
    let method = req.method().clone();

    match (method, path) {
        (Method::GET, "/api/v1/ping") => return http::text(StatusCode::OK, "pong\n"),

        (Method::GET, "/api/v1/api-keys") => return list_api_keys(req, state).await,
        (Method::POST, "/api/v1/api-keys") => return create_api_key(req, state).await,

        (Method::GET, "/api/v1/providers") => return list_providers(req, state).await,
        (Method::POST, "/api/v1/providers") => return create_provider(req, state).await,

        (Method::GET, "/api/v1/routes") => return list_routes(req, state).await,
        (Method::GET, "/api/v1/prices") => return list_prices(req, state).await,
        (Method::POST, "/api/v1/prices") => return create_price(req, state).await,
        (Method::GET, "/api/v1/system/config") => return system_config(req, state).await,
        (Method::GET, "/api/v1/gateway-models") => return list_gateway_models(req, state).await,
        (Method::PATCH, "/api/v1/gateway-models") => return patch_gateway_model(req, state).await,

        (Method::GET, "/api/v1/stats/daily") => return stats_daily(req, state).await,
        (Method::GET, "/api/v1/stats/overview") => return stats_overview(req, state).await,
        (Method::GET, "/api/v1/stats/usage-breakdown") => {
            return stats_usage_breakdown(req, state).await;
        }
        (Method::GET, "/api/v1/logs") => return list_logs(req, state).await,
        _ => {}
    }

    // Prefix routes (IDs)
    if path.starts_with("/api/v1/api-keys/") {
        if req.method() == Method::PATCH {
            return update_api_key(req, state).await;
        }
        if req.method() == Method::DELETE {
            return delete_api_key(req, state).await;
        }
    }
    if path.starts_with("/api/v1/providers/") {
        if req.method() == Method::PATCH {
            return update_provider(req, state).await;
        }
        if req.method() == Method::GET && path.ends_with("/endpoints") {
            return list_provider_endpoints(req, state).await;
        }
        if req.method() == Method::POST && path.ends_with("/endpoints") {
            return create_provider_endpoint(req, state).await;
        }
        if req.method() == Method::GET && path.ends_with("/keys") {
            return list_provider_keys(req, state).await;
        }
        if req.method() == Method::POST && path.ends_with("/keys") {
            return create_provider_key(req, state).await;
        }
        if req.method() == Method::GET && path.ends_with("/models") {
            return list_provider_models(req, state).await;
        }
        if req.method() == Method::POST && path.ends_with("/models/sync") {
            return sync_provider_models(req, state).await;
        }
        if req.method() == Method::POST && path.ends_with("/codex-oauth/start") {
            return start_codex_oauth(req, state).await;
        }
    }
    if path.starts_with("/api/v1/endpoints/") && req.method() == Method::PATCH {
        return update_endpoint(req, state).await;
    }
    if path.starts_with("/api/v1/endpoints/")
        && req.method() == Method::POST
        && path.ends_with("/test")
    {
        return test_endpoint(req, state).await;
    }
    if path.starts_with("/api/v1/keys/") {
        if req.method() == Method::PATCH {
            return update_key(req, state).await;
        }
        if req.method() == Method::GET && path.ends_with("/models") {
            return list_key_models(req, state).await;
        }
        if req.method() == Method::POST && path.ends_with("/models/sync") {
            return sync_key_models(req, state).await;
        }
        if req.method() == Method::POST && path.ends_with("/models") {
            return add_key_models(req, state).await;
        }
    }
    if path.starts_with("/api/v1/provider-models/") {
        if req.method() == Method::PATCH {
            return patch_provider_model(req, state).await;
        }
        if req.method() == Method::DELETE {
            return delete_provider_model(req, state).await;
        }
    }
    if path.starts_with("/api/v1/key-models/") {
        if req.method() == Method::PATCH {
            return patch_key_model(req, state).await;
        }
        if req.method() == Method::DELETE {
            return delete_key_model(req, state).await;
        }
    }
    if path.starts_with("/api/v1/codex-oauth/") && req.method() == Method::GET {
        return get_codex_oauth_request(req, state).await;
    }
    if path.starts_with("/api/v1/routes/") && req.method() == Method::PUT {
        return upsert_route(req, state).await;
    }
    if path.starts_with("/api/v1/prices/") && req.method() == Method::GET {
        return get_price(req, state).await;
    }

    http::json_error(StatusCode::NOT_FOUND, "not found")
}

fn require_admin(req: &Request<Incoming>, state: &SharedState) -> Option<HttpResponse> {
    let Some(token) = http::bearer_token(req) else {
        return Some(http::json_error(
            StatusCode::UNAUTHORIZED,
            "missing bearer token",
        ));
    };
    if token != state.config.admin_token {
        return Some(http::json_error(StatusCode::UNAUTHORIZED, "invalid token"));
    }
    None
}

async fn list_provider_models(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) = parse_provider_id_with_suffix(path, "/models") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
    };

    match state.db.list_provider_models_by_provider(provider_id).await {
        Ok(items) => http::json(StatusCode::OK, &items),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn sync_provider_models(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) = parse_provider_id_with_suffix(path, "/models/sync") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
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

    let Some(provider) = snap.providers.iter().find(|p| p.id == provider_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "provider not found");
    };
    let models_path = provider_models_sync_path(&provider.provider_type);

    let now_ms = util::now_ms();

    let keys = snap
        .keys_by_provider
        .get(&provider_id)
        .map(|items| items.iter().collect::<Vec<_>>())
        .unwrap_or_default();
    let ranked_keys =
        crate::selector::rank_key_refs_with_health(&keys, &state.upstream_key_health, now_ms);
    let Some(key) = ranked_keys.first() else {
        return http::json_error(StatusCode::CONFLICT, "no available upstream keys");
    };

    let endpoints = snap
        .endpoints_by_provider
        .get(&provider_id)
        .map(|items| items.iter().collect::<Vec<_>>())
        .unwrap_or_default();
    let ranked_endpoints = crate::selector::rank_endpoint_refs_with_health(
        &endpoints,
        &state.endpoint_health,
        state.config.endpoint_selector_strategy,
        now_ms,
    );
    let Some(endpoint) = ranked_endpoints.first() else {
        return http::json_error(StatusCode::CONFLICT, "no available upstream endpoints");
    };

    let uri = match build_upstream_uri(&endpoint.base_url, models_path) {
        Ok(uri) => uri,
        Err(e) => return http::json_error(StatusCode::BAD_REQUEST, e),
    };

    let upstream_req = match Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header("Authorization", format!("Bearer {}", key.secret))
        .body(Full::new(Bytes::new()))
    {
        Ok(req) => req,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let response = match tokio_time::timeout(
        state.config.upstream_request_timeout,
        state.upstream.request(upstream_req),
    )
    .await
    {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => return http::json_error(StatusCode::BAD_GATEWAY, e.to_string()),
        Err(_) => {
            return http::json_error(
                StatusCode::BAD_GATEWAY,
                format!("timeout after {:?}", state.config.upstream_request_timeout),
            );
        }
    };

    let status = response.status();
    let body_bytes = match Limited::new(
        response.into_body(),
        ADMIN_UPSTREAM_MODELS_BODY_MAX_BYTES,
    )
    .collect()
    .await
    {
        Ok(collected) => collected.to_bytes(),
        Err(e) => return http::json_error(StatusCode::BAD_GATEWAY, e.to_string()),
    };

    if status != StatusCode::OK {
        let body = String::from_utf8_lossy(&body_bytes).trim().to_string();
        return http::json_error(
            StatusCode::BAD_GATEWAY,
            format!(
                "upstream {models_path} failed: {} {}",
                status.as_u16(),
                body
            ),
        );
    }

    let parsed: Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::BAD_GATEWAY, format!("invalid json: {e}")),
    };

    let mut models: Vec<String> = parsed
        .get("data")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|value| value.as_str()))
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    models.sort();
    models.dedup();

    if models.is_empty() {
        return http::json_error(StatusCode::BAD_GATEWAY, "empty model list");
    }

    if let Err(e) = state
        .db
        .upsert_provider_models(provider_id, &models, util::now_ms())
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    state.caches.upstream.invalidate();

    match state.db.list_provider_models_by_provider(provider_id).await {
        Ok(items) => http::json(StatusCode::OK, &items),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct PatchProviderModelReq {
    alias: Option<Option<String>>,
    enabled: Option<bool>,
}

async fn patch_provider_model(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(model_id) = parse_id_suffix(path, "/api/v1/provider-models/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid model id");
    };

    let (_, patch, _raw) =
        match http::read_json_limited::<PatchProviderModelReq>(req, state.config.max_request_bytes)
            .await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };

    if let Err(e) = state
        .db
        .update_provider_model(model_id, patch.alias, patch.enabled, util::now_ms())
        .await
    {
        let message = e.to_string();
        if message.contains("idx_provider_models_alias_unique")
            || message.contains("provider_models.alias")
            || message.contains("UNIQUE constraint failed")
        {
            return http::json_error(StatusCode::CONFLICT, "alias already exists");
        }
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, message);
    }

    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

async fn delete_provider_model(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(model_id) = parse_id_suffix(path, "/api/v1/provider-models/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid model id");
    };

    match state.db.delete_provider_model(model_id).await {
        Ok(()) => {
            state.caches.upstream.invalidate();
            http::empty(StatusCode::NO_CONTENT)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_key_models(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(upstream_key_id) = parse_id_suffix(path, "/api/v1/keys/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid key id");
    };

    match state
        .db
        .list_upstream_key_models_by_key(upstream_key_id)
        .await
    {
        Ok(items) => http::json(StatusCode::OK, &items),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn sync_key_models(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(upstream_key_id) = parse_id_suffix(path, "/api/v1/keys/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid key id");
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

    let mut provider_id: Option<i64> = None;
    let mut key_secret: Option<String> = None;
    for (pid, keys) in &snap.keys_by_provider {
        for key in keys {
            if key.id == upstream_key_id {
                provider_id = Some(*pid);
                key_secret = Some(key.secret.clone());
                break;
            }
        }
        if provider_id.is_some() {
            break;
        }
    }

    let Some(provider_id) = provider_id else {
        return http::json_error(StatusCode::NOT_FOUND, "key not found");
    };
    let Some(key_secret) = key_secret else {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, "failed to resolve key");
    };
    let Some(provider) = snap.providers.iter().find(|p| p.id == provider_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "provider not found");
    };
    let models_path = provider_models_sync_path(&provider.provider_type);

    let now_ms = util::now_ms();
    let endpoints = snap
        .endpoints_by_provider
        .get(&provider_id)
        .map(|items| items.iter().collect::<Vec<_>>())
        .unwrap_or_default();
    let ranked_endpoints = crate::selector::rank_endpoint_refs_with_health(
        &endpoints,
        &state.endpoint_health,
        state.config.endpoint_selector_strategy,
        now_ms,
    );
    let Some(endpoint) = ranked_endpoints.first() else {
        return http::json_error(StatusCode::CONFLICT, "no available upstream endpoints");
    };

    let uri = match build_upstream_uri(&endpoint.base_url, models_path) {
        Ok(uri) => uri,
        Err(e) => return http::json_error(StatusCode::BAD_REQUEST, e),
    };

    let upstream_req = match Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header("Authorization", format!("Bearer {}", key_secret))
        .body(Full::new(Bytes::new()))
    {
        Ok(req) => req,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let response = match tokio_time::timeout(
        state.config.upstream_request_timeout,
        state.upstream.request(upstream_req),
    )
    .await
    {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => return http::json_error(StatusCode::BAD_GATEWAY, e.to_string()),
        Err(_) => {
            return http::json_error(
                StatusCode::BAD_GATEWAY,
                format!("timeout after {:?}", state.config.upstream_request_timeout),
            );
        }
    };

    let status = response.status();
    let body_bytes = match Limited::new(
        response.into_body(),
        ADMIN_UPSTREAM_MODELS_BODY_MAX_BYTES,
    )
    .collect()
    .await
    {
        Ok(collected) => collected.to_bytes(),
        Err(e) => return http::json_error(StatusCode::BAD_GATEWAY, e.to_string()),
    };
    if status != StatusCode::OK {
        let body = String::from_utf8_lossy(&body_bytes).trim().to_string();
        return http::json_error(
            StatusCode::BAD_GATEWAY,
            format!(
                "upstream {models_path} failed: {} {}",
                status.as_u16(),
                body
            ),
        );
    }

    let parsed: Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::BAD_GATEWAY, format!("invalid json: {e}")),
    };

    let mut models: Vec<String> = parsed
        .get("data")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|value| value.as_str()))
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    models.sort();
    models.dedup();

    if models.is_empty() {
        return http::json_error(StatusCode::BAD_GATEWAY, "empty model list");
    }

    if let Err(e) = state
        .db
        .upsert_upstream_key_models(upstream_key_id, &models, util::now_ms())
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.caches.upstream.invalidate();

    match state
        .db
        .list_upstream_key_models_by_key(upstream_key_id)
        .await
    {
        Ok(items) => http::json(StatusCode::OK, &items),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct AddKeyModelsReq {
    models: Vec<String>,
}

async fn add_key_models(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(upstream_key_id) = parse_id_suffix(path, "/api/v1/keys/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid key id");
    };

    let (_, body, _raw) =
        match http::read_json_limited::<AddKeyModelsReq>(req, state.config.max_request_bytes).await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };

    let mut models = body
        .models
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();

    if models.is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "models is empty");
    }

    if let Err(e) = state
        .db
        .upsert_upstream_key_models(upstream_key_id, &models, util::now_ms())
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    state.caches.upstream.invalidate();
    match state
        .db
        .list_upstream_key_models_by_key(upstream_key_id)
        .await
    {
        Ok(items) => http::json(StatusCode::OK, &items),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct PatchKeyModelReq {
    enabled: bool,
}

async fn patch_key_model(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(model_id) = parse_id_suffix(path, "/api/v1/key-models/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid model id");
    };

    let (_, patch, _raw) = match http::read_json_limited::<PatchKeyModelReq>(
        req,
        state.config.max_request_bytes,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    if let Err(e) = state
        .db
        .update_upstream_key_model(model_id, patch.enabled, util::now_ms())
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

async fn delete_key_model(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(model_id) = parse_id_suffix(path, "/api/v1/key-models/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid model id");
    };

    match state.db.delete_upstream_key_model(model_id).await {
        Ok(()) => {
            state.caches.upstream.invalidate();
            http::empty(StatusCode::NO_CONTENT)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_gateway_models(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    match state.db.list_gateway_model_policies().await {
        Ok(items) => http::json(StatusCode::OK, &items),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct PatchGatewayModelReq {
    model_name: String,
    enabled: bool,
}

async fn patch_gateway_model(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let (_, patch, _raw) =
        match http::read_json_limited::<PatchGatewayModelReq>(req, state.config.max_request_bytes)
            .await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };

    if patch.model_name.trim().is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "model_name is empty");
    }

    if let Err(e) = state
        .db
        .upsert_gateway_model_policy(patch.model_name.trim(), patch.enabled, util::now_ms())
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

async fn start_codex_oauth(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) = parse_provider_id_with_suffix(path, "/codex-oauth/start") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
    };
    let redirect_uri = format!("{}/api/v1/codex-oauth/callback", request_origin(&req));

    let snap = match state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
    {
        Ok(items) => items,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let Some(provider) = snap.providers.iter().find(|p| p.id == provider_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "provider not found");
    };
    if provider.provider_type != "openai_codex_oauth" {
        return http::json_error(
            StatusCode::CONFLICT,
            "provider type is not openai_codex_oauth",
        );
    }

    match state.codex_oauth.start(provider_id, redirect_uri).await {
        Ok(resp) => http::json(StatusCode::OK, &resp),
        Err(message) => http::json_error(StatusCode::BAD_GATEWAY, message),
    }
}

async fn get_codex_oauth_request(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(request_id) = parse_string_suffix(path, "/api/v1/codex-oauth/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid request id");
    };

    match state.codex_oauth.get_view(&request_id, util::now_ms()) {
        Some(view) => http::json(StatusCode::OK, &view),
        None => http::json_error(StatusCode::NOT_FOUND, "request not found"),
    }
}

fn build_upstream_uri(base_url: &str, path: &str) -> Result<Uri, String> {
    let trimmed_base = base_url.trim_end_matches('/');
    let base = if path.starts_with("/v1/") {
        trimmed_base.strip_suffix("/v1").unwrap_or(trimmed_base)
    } else {
        trimmed_base
    };

    let mut out = String::with_capacity(base_url.len() + 64);
    out.push_str(base);
    out.push_str(path);
    out.parse::<Uri>().map_err(|e| e.to_string())
}

fn provider_models_sync_path(provider_type: &str) -> &'static str {
    if provider_type == "openai_compatible_responses" {
        "/v1/models?api_format=responses"
    } else {
        "/v1/models"
    }
}

#[derive(Debug, Deserialize)]
struct CreateApiKeyReq {
    name: String,
    enabled: Option<bool>,
    #[serde(alias = "expiresAtMs")]
    expires_at_ms: Option<i64>,
    #[serde(alias = "logEnabled")]
    log_enabled: Option<bool>,
}

async fn list_api_keys(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    match state.db.list_api_keys().await {
        Ok(items) => http::json(
            StatusCode::OK,
            &items.iter().map(api_key_to_json).collect::<Vec<_>>(),
        ),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn create_api_key(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let (_, body, _raw) =
        match http::read_json_limited::<CreateApiKeyReq>(req, state.config.max_request_bytes).await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };

    if body.name.trim().is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "name is empty");
    }

    let enabled = body.enabled.unwrap_or(true);
    let log_enabled = body.log_enabled.unwrap_or(false);

    // Generate plaintext key, store only hash.
    let api_key_plaintext = generate_api_key_plaintext();
    let key_hash = crate::crypto::hash_api_key(&state.config.master_key, &api_key_plaintext);

    let now_ms = util::now_ms();
    let id = match state
        .db
        .insert_api_key(
            &key_hash,
            body.name.trim(),
            enabled,
            body.expires_at_ms,
            log_enabled,
            now_ms,
        )
        .await
    {
        Ok(id) => id,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    state.caches.api_keys.invalidate_all();

    let resp = serde_json::json!({
        "id": id,
        "api_key": api_key_plaintext,
        "name": body.name.trim(),
        "enabled": enabled,
        "expires_at_ms": body.expires_at_ms,
        "log_enabled": log_enabled
    });
    http::json(StatusCode::OK, &resp)
}

#[derive(Debug, Deserialize)]
struct PatchApiKeyReq {
    name: Option<String>,
    enabled: Option<bool>,
    #[serde(alias = "expiresAtMs")]
    expires_at_ms: Option<Option<i64>>,
    #[serde(alias = "logEnabled")]
    log_enabled: Option<bool>,
}

async fn update_api_key(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(id) = parse_id_suffix(path, "/api/v1/api-keys/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid api key id");
    };

    let (_, patch, _raw) = match http::read_json_limited::<PatchApiKeyReq>(
        req,
        state.config.max_request_bytes,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    let Some(current) = (match state.db.find_api_key_by_id(id).await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }) else {
        return http::json_error(StatusCode::NOT_FOUND, "api key not found");
    };

    let new_name = patch.name.as_deref().unwrap_or(&current.name);
    if new_name.trim().is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "name is empty");
    }
    let new_enabled = patch.enabled.unwrap_or(current.enabled);
    let new_expires = patch.expires_at_ms.unwrap_or(current.expires_at_ms);
    let new_log_enabled = patch.log_enabled.unwrap_or(current.log_enabled);

    let now_ms = util::now_ms();
    if let Err(e) = state
        .db
        .update_api_key(
            id,
            new_name.trim(),
            new_enabled,
            new_expires,
            new_log_enabled,
            now_ms,
        )
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    state.caches.api_keys.invalidate_all();
    http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

async fn delete_api_key(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(id) = parse_id_suffix(path, "/api/v1/api-keys/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid api key id");
    };

    let Some(_) = (match state.db.find_api_key_by_id(id).await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }) else {
        return http::json_error(StatusCode::NOT_FOUND, "api key not found");
    };

    if let Err(e) = state.db.delete_api_key(id).await {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    state.caches.api_keys.invalidate_all();
    http::empty(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct CreateProviderReq {
    name: String,
    #[serde(alias = "providerType")]
    provider_type: String,
    enabled: Option<bool>,
    priority: Option<i32>,
    weight: Option<i32>,
    #[serde(alias = "supportsIncludeUsage")]
    supports_include_usage: Option<bool>,
    #[serde(alias = "websocketEnabled")]
    websocket_enabled: Option<bool>,
}

async fn list_providers(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let snap = match state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
    {
        Ok(items) => items,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let now_ms = util::now_ms();
    let out = snap
        .providers
        .iter()
        .map(|provider| {
            let endpoints = snap
                .endpoints_by_provider
                .get(&provider.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let keys = snap
                .keys_by_provider
                .get(&provider.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let health = summarize_provider_health(
                endpoints,
                keys,
                &state.endpoint_health,
                &state.upstream_key_health,
                now_ms,
            );
            provider_to_json(provider, health)
        })
        .collect::<Vec<_>>();

    http::json(StatusCode::OK, &out)
}

async fn create_provider(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let (_, body, _raw) =
        match http::read_json_limited::<CreateProviderReq>(req, state.config.max_request_bytes)
            .await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };
    if body.name.trim().is_empty() || body.provider_type.trim().is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "name/provider_type is empty");
    }
    if !is_valid_provider_type(body.provider_type.trim()) {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider_type");
    }
    let enabled = body.enabled.unwrap_or(true);
    let priority = body.priority.unwrap_or(100);
    let weight = body.weight.unwrap_or(1);
    let supports_include_usage = body.supports_include_usage.unwrap_or(true);
    let websocket_enabled = body.websocket_enabled.unwrap_or(false);

    let now_ms = util::now_ms();
    let id = match state
        .db
        .insert_upstream_provider(
            body.name.trim(),
            body.provider_type.trim(),
            enabled,
            priority,
            weight,
            supports_include_usage,
            websocket_enabled,
            now_ms,
        )
        .await
    {
        Ok(id) => id,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "id": id }))
}

#[derive(Debug, Deserialize)]
struct PatchProviderReq {
    name: Option<String>,
    #[serde(alias = "providerType")]
    provider_type: Option<String>,
    enabled: Option<bool>,
    priority: Option<i32>,
    weight: Option<i32>,
    #[serde(alias = "supportsIncludeUsage")]
    supports_include_usage: Option<bool>,
    #[serde(alias = "websocketEnabled")]
    websocket_enabled: Option<bool>,
}

async fn update_provider(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) = parse_id_suffix(path, "/api/v1/providers/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
    };

    let (_, patch, _raw) = match http::read_json_limited::<PatchProviderReq>(
        req,
        state.config.max_request_bytes,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    let providers = match state.db.list_upstream_providers().await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some(mut current) = providers.into_iter().find(|p| p.id == provider_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "provider not found");
    };

    if let Some(name) = patch.name {
        if name.trim().is_empty() {
            return http::json_error(StatusCode::BAD_REQUEST, "name is empty");
        }
        current.name = name.trim().to_string();
    }
    if let Some(t) = patch.provider_type {
        if t.trim().is_empty() {
            return http::json_error(StatusCode::BAD_REQUEST, "provider_type is empty");
        }
        if !is_valid_provider_type(t.trim()) {
            return http::json_error(StatusCode::BAD_REQUEST, "invalid provider_type");
        }
        current.provider_type = t.trim().to_string();
    }
    if let Some(v) = patch.enabled {
        current.enabled = v;
    }
    if let Some(v) = patch.priority {
        current.priority = v;
    }
    if let Some(v) = patch.weight {
        current.weight = v;
    }
    if let Some(v) = patch.supports_include_usage {
        current.supports_include_usage = v;
    }
    if let Some(v) = patch.websocket_enabled {
        current.websocket_enabled = v;
    }

    if let Err(e) = state
        .db
        .update_upstream_provider(&current, util::now_ms())
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

#[derive(Debug, Deserialize)]
struct CreateEndpointReq {
    name: String,
    #[serde(alias = "baseUrl")]
    base_url: String,
    enabled: Option<bool>,
    priority: Option<i32>,
    weight: Option<i32>,
}

async fn list_provider_endpoints(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) = parse_provider_id_with_suffix(path, "/endpoints") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
    };
    match state
        .db
        .list_upstream_endpoints_by_provider(provider_id)
        .await
    {
        Ok(items) => {
            let now_ms = util::now_ms();
            let out = items
                .iter()
                .map(|endpoint| {
                    endpoint_to_json(
                        endpoint,
                        state.endpoint_health.snapshot(endpoint.id, now_ms),
                    )
                })
                .collect::<Vec<_>>();
            http::json(StatusCode::OK, &out)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn create_provider_endpoint(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) = parse_provider_id_with_suffix(path, "/endpoints") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
    };
    let (_, body, _raw) =
        match http::read_json_limited::<CreateEndpointReq>(req, state.config.max_request_bytes)
            .await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };
    if body.name.trim().is_empty() || body.base_url.trim().is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "name/base_url is empty");
    }
    let enabled = body.enabled.unwrap_or(true);
    let priority = body.priority.unwrap_or(100);
    let weight = body.weight.unwrap_or(1);
    let base_url = normalize_base_url(body.base_url.trim());
    if let Err(message) = validate_upstream_base_url(&base_url) {
        return http::json_error(StatusCode::BAD_REQUEST, message);
    }

    let now_ms = util::now_ms();
    let id = match state
        .db
        .insert_upstream_endpoint(
            provider_id,
            body.name.trim(),
            &base_url,
            enabled,
            priority,
            weight,
            now_ms,
        )
        .await
    {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "id": id }))
}

#[derive(Debug, Deserialize)]
struct PatchEndpointReq {
    name: Option<String>,
    #[serde(alias = "baseUrl")]
    base_url: Option<String>,
    enabled: Option<bool>,
    priority: Option<i32>,
    weight: Option<i32>,
}

async fn update_endpoint(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(endpoint_id) = parse_id_suffix(path, "/api/v1/endpoints/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid endpoint id");
    };

    let (_, patch, _raw) = match http::read_json_limited::<PatchEndpointReq>(
        req,
        state.config.max_request_bytes,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    // Find endpoint by scanning list (admin path, OK).
    let endpoints = match state.db.list_upstream_endpoints().await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some(mut current) = endpoints.into_iter().find(|e| e.id == endpoint_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "endpoint not found");
    };

    if let Some(name) = patch.name {
        if name.trim().is_empty() {
            return http::json_error(StatusCode::BAD_REQUEST, "name is empty");
        }
        current.name = name.trim().to_string();
    }
    if let Some(b) = patch.base_url {
        if b.trim().is_empty() {
            return http::json_error(StatusCode::BAD_REQUEST, "base_url is empty");
        }
        let base_url = normalize_base_url(b.trim());
        if let Err(message) = validate_upstream_base_url(&base_url) {
            return http::json_error(StatusCode::BAD_REQUEST, message);
        }
        current.base_url = base_url;
    }
    if let Some(v) = patch.enabled {
        current.enabled = v;
    }
    if let Some(v) = patch.priority {
        current.priority = v;
    }
    if let Some(v) = patch.weight {
        current.weight = v;
    }

    if let Err(e) = state
        .db
        .update_upstream_endpoint(&current, util::now_ms())
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

async fn test_endpoint(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(endpoint_id) = parse_id_suffix(path, "/api/v1/endpoints/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid endpoint id");
    };

    let endpoints = match state.db.list_upstream_endpoints().await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some(endpoint) = endpoints
        .into_iter()
        .find(|endpoint| endpoint.id == endpoint_id)
    else {
        return http::json_error(StatusCode::NOT_FOUND, "endpoint not found");
    };

    // Probe the configured base URL directly. Many OpenAI-compatible upstreams do not expose /healthz.
    // Reachability matters more than "OK" response semantics here; 401/404 still prove the endpoint is alive.
    let url = normalize_base_url(&endpoint.base_url);
    let uri: Uri = match url.parse() {
        Ok(uri) => uri,
        Err(_) => return http::json_error(StatusCode::BAD_REQUEST, "invalid endpoint url"),
    };

    let upstream_req = match Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Full::new(Bytes::new()))
    {
        Ok(req) => req,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    match tokio_time::timeout(
        state.config.upstream_request_timeout,
        state.upstream.request(upstream_req),
    )
    .await
    {
        Ok(Ok(resp)) => {
            let status = resp.status().as_u16();
            let body_bytes = match Limited::new(
                resp.into_body(),
                ADMIN_UPSTREAM_TEST_BODY_MAX_BYTES,
            )
            .collect()
            .await
            {
                Ok(collected) => collected.to_bytes(),
                Err(e) => {
                    return http::json(
                        StatusCode::OK,
                        &serde_json::json!({
                            "ok": status < 500,
                            "status": status,
                            "url": url,
                            "message": e.to_string(),
                        }),
                    )
                }
            };
            let body_text = String::from_utf8_lossy(&body_bytes).trim().to_string();
            http::json(
                StatusCode::OK,
                &serde_json::json!({
                    "ok": status < 500,
                    "status": status,
                    "url": url,
                    "message": if body_text.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(body_text) }
                }),
            )
        }
        Ok(Err(e)) => http::json(
            StatusCode::OK,
            &serde_json::json!({
                "ok": false,
                "status": serde_json::Value::Null,
                "url": url,
                "message": e.to_string()
            }),
        ),
        Err(_) => http::json(
            StatusCode::OK,
            &serde_json::json!({
                "ok": false,
                "status": serde_json::Value::Null,
                "url": url,
                "message": format!("timeout after {:?}", state.config.upstream_request_timeout)
            }),
        ),
    }
}

#[derive(Debug, Deserialize)]
struct CreateKeyReq {
    name: String,
    secret: String,
    enabled: Option<bool>,
    priority: Option<i32>,
    weight: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct PatchKeyReq {
    name: Option<String>,
    secret: Option<String>,
    enabled: Option<bool>,
    priority: Option<i32>,
    weight: Option<i32>,
}

async fn list_provider_keys(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) = parse_provider_id_with_suffix(path, "/keys") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
    };
    match state
        .db
        .list_upstream_keys_meta_by_provider(provider_id)
        .await
    {
        Ok(items) => {
            let now_ms = util::now_ms();
            let out = items
                .iter()
                .map(|key| {
                    upstream_key_to_json(key, state.upstream_key_health.snapshot(key.id, now_ms))
                })
                .collect::<Vec<_>>();
            http::json(StatusCode::OK, &out)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn create_provider_key(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) = parse_provider_id_with_suffix(path, "/keys") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
    };
    let (_, body, _raw) =
        match http::read_json_limited::<CreateKeyReq>(req, state.config.max_request_bytes).await {
            Ok(v) => v,
            Err(resp) => return resp,
        };
    if body.name.trim().is_empty() || body.secret.trim().is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "name/secret is empty");
    }
    let enabled = body.enabled.unwrap_or(true);
    let priority = body.priority.unwrap_or(100);
    let weight = body.weight.unwrap_or(1);

    let now_ms = util::now_ms();
    let id = match state
        .db
        .insert_upstream_key(
            &state.config.master_key,
            provider_id,
            body.name.trim(),
            body.secret.trim(),
            enabled,
            priority,
            weight,
            now_ms,
        )
        .await
    {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "id": id }))
}

async fn update_key(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(key_id) = parse_id_suffix(path, "/api/v1/keys/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid key id");
    };

    let (_, patch, _raw) =
        match http::read_json_limited::<PatchKeyReq>(req, state.config.max_request_bytes).await {
            Ok(v) => v,
            Err(resp) => return resp,
        };

    let keys = match state.db.list_upstream_keys(&state.config.master_key).await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some(mut current) = keys.into_iter().find(|k| k.id == key_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "key not found");
    };

    if let Some(name) = patch.name {
        if name.trim().is_empty() {
            return http::json_error(StatusCode::BAD_REQUEST, "name is empty");
        }
        current.name = name.trim().to_string();
    }
    if let Some(secret) = patch.secret {
        if secret.trim().is_empty() {
            return http::json_error(StatusCode::BAD_REQUEST, "secret is empty");
        }
        current.secret = secret.trim().to_string();
    }
    if let Some(v) = patch.enabled {
        current.enabled = v;
    }
    if let Some(v) = patch.priority {
        current.priority = v;
    }
    if let Some(v) = patch.weight {
        current.weight = v;
    }

    if let Err(e) = state
        .db
        .update_upstream_key(&state.config.master_key, &current, util::now_ms())
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

async fn list_routes(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    match state.db.list_model_routes().await {
        Ok(routes) => http::json(StatusCode::OK, &routes),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct UpsertRouteReq {
    enabled: bool,
    #[serde(alias = "providerIds")]
    provider_ids: Vec<i64>,
}

async fn upsert_route(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let model_name = req
        .uri()
        .path()
        .strip_prefix("/api/v1/routes/")
        .unwrap_or("")
        .trim_matches('/')
        .to_string();
    if model_name.is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "missing model name");
    }
    let (_, body, _raw) = match http::read_json_limited::<UpsertRouteReq>(
        req,
        state.config.max_request_bytes,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    if let Err(e) = state
        .db
        .upsert_model_route(
            &model_name,
            body.enabled,
            &body.provider_ids,
            util::now_ms(),
        )
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

async fn list_prices(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let provider_id = query_i64(req.uri().query(), "provider_id");

    match state.db.list_latest_model_prices().await {
        Ok(items) => {
            let out: Vec<Value> = items
                .into_iter()
                .filter(|p| provider_id.is_none_or(|id| p.provider_id == Some(id)))
                .map(|p| {
                    let price_data: Value =
                        serde_json::from_str(&p.price_data_json).unwrap_or(Value::Null);
                    serde_json::json!({
                        "id": p.id,
                        "provider_id": p.provider_id,
                        "model_name": p.model_name,
                        "price_data": price_data,
                        "created_at_ms": p.created_at_ms,
                        "updated_at_ms": p.updated_at_ms
                    })
                })
                .collect();
            http::json(StatusCode::OK, &out)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct CreatePriceReq {
    #[serde(alias = "providerId")]
    provider_id: Option<i64>,
    #[serde(alias = "modelName")]
    model_name: String,
    #[serde(alias = "priceData")]
    price_data: Value,
}

async fn create_price(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let (_, body, _raw) = match http::read_json_limited::<CreatePriceReq>(
        req,
        state.config.max_request_bytes,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if body.model_name.trim().is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "model_name is empty");
    }
    if !body.price_data.is_object() {
        return http::json_error(StatusCode::BAD_REQUEST, "price_data must be an object");
    }
    if let Some(provider_id) = body.provider_id {
        let providers = match state.db.list_upstream_providers().await {
            Ok(v) => v,
            Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        if !providers
            .into_iter()
            .any(|provider| provider.id == provider_id)
        {
            return http::json_error(StatusCode::NOT_FOUND, "provider not found");
        }
    }
    let json_str = match serde_json::to_string(&body.price_data) {
        Ok(v) => v,
        Err(e) => {
            return http::json_error(StatusCode::BAD_REQUEST, format!("invalid price_data: {e}"));
        }
    };
    let id = match state
        .db
        .insert_model_price(
            body.provider_id,
            body.model_name.trim(),
            &json_str,
            util::now_ms(),
        )
        .await
    {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "id": id }))
}

async fn get_price(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let model_name = path
        .strip_prefix("/api/v1/prices/")
        .unwrap_or("")
        .trim_matches('/');
    if model_name.is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "missing model name");
    }

    let provider_id = query_i64(req.uri().query(), "provider_id");
    let items = match state.db.list_latest_model_prices().await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let price = if let Some(provider_id) = provider_id {
        items
            .iter()
            .find(|p| p.model_name == model_name && p.provider_id == Some(provider_id))
            .or_else(|| {
                items
                    .iter()
                    .find(|p| p.model_name == model_name && p.provider_id.is_none())
            })
    } else {
        items
            .iter()
            .find(|p| p.model_name == model_name && p.provider_id.is_none())
            .or_else(|| items.iter().find(|p| p.model_name == model_name))
    };
    let Some(p) = price else {
        return http::json_error(StatusCode::NOT_FOUND, "price not found");
    };
    let price_data: Value = serde_json::from_str(&p.price_data_json).unwrap_or(Value::Null);
    http::json(
        StatusCode::OK,
        &serde_json::json!({
            "id": p.id,
            "provider_id": p.provider_id,
            "model_name": p.model_name,
            "price_data": price_data,
            "created_at_ms": p.created_at_ms,
            "updated_at_ms": p.updated_at_ms
        }),
    )
}

async fn system_config(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let config = &state.config;
    let payload = serde_json::json!({
        "connection": {
            "api_base": format!("http://{}", config.listen_addr),
            "healthz_path": "/healthz",
            "readyz_path": "/readyz",
            "metrics_path": "/metrics",
        },
        "basic": {
            "db_dsn": config.db_dsn,
            "static_dir": config.static_dir,
            "max_request_bytes": config.max_request_bytes,
            "max_response_bytes": config.max_response_bytes,
            "log_queue_capacity": config.log_queue_capacity,
            "stats_flush_interval_ms": config.stats_flush_interval.as_millis() as u64,
        },
        "routing": {
            "endpoint_selector_strategy": format!("{:?}", config.endpoint_selector_strategy).to_ascii_lowercase(),
            "inject_include_usage": config.inject_include_usage,
            "upstream_cache_ttl_ms": config.upstream_cache_ttl.as_millis() as u64,
            "upstream_cache_stale_grace_ms": config.upstream_cache_stale_grace.as_millis() as u64,
            "api_key_cache_ttl_ms": config.api_key_cache_ttl.as_millis() as u64,
            "api_key_cache_max_entries": config.api_key_cache_max_entries,
        },
        "stability": {
            "circuit_breaker_failure_threshold": config.circuit_breaker_failure_threshold,
            "circuit_breaker_open_ms": config.circuit_breaker_open_ms,
            "upstream_connect_timeout_ms": config.upstream_connect_timeout.as_millis() as u64,
            "upstream_request_timeout_ms": config.upstream_request_timeout.as_millis() as u64,
        },
        "retention": {
            "request_log_retention_days": config.request_log_retention_days,
            "stats_daily_retention_days": config.stats_daily_retention_days,
            "cleanup_interval_ms": config.retention_cleanup_interval.as_millis() as u64,
            "delete_batch": config.retention_delete_batch,
            "archive_enabled": config.request_log_archive_enabled,
            "archive_dir": config.request_log_archive_dir,
            "archive_compress": config.request_log_archive_compress,
        }
    });
    http::json(StatusCode::OK, &payload)
}

async fn stats_daily(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let api_key_id = query_i64(req.uri().query(), "api_key_id").unwrap_or(0);
    let days = query_i64(req.uri().query(), "days")
        .unwrap_or(378)
        .clamp(1, 2000);

    let now = time::OffsetDateTime::now_utc();
    let end = now;
    let start = now - time::Duration::days(days - 1);
    let fmt = time::format_description::parse("[year][month][day]").expect("valid date format");
    let start_str = start
        .format(&fmt)
        .unwrap_or_else(|_| "19700101".to_string());
    let end_str = end.format(&fmt).unwrap_or_else(|_| "19700101".to_string());

    match state
        .db
        .list_stats_daily_range(api_key_id, &start_str, &end_str)
        .await
    {
        Ok(rows) => http::json(StatusCode::OK, &rows),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn stats_overview(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let period = query_string(req.uri().query(), "period").unwrap_or_else(|| "today".to_string());
    let now_ms = util::now_ms();
    let (from_ms, to_ms) = match period.as_str() {
        "today" => {
            let today = (now_ms / 86_400_000) * 86_400_000;
            (today, now_ms)
        }
        "7d" => (now_ms - 7 * 86_400_000, now_ms),
        "30d" => (now_ms - 30 * 86_400_000, now_ms),
        _ => return http::json_error(StatusCode::BAD_REQUEST, "invalid period"),
    };

    // KPIs must represent *all traffic*, even when request logging is disabled per API key.
    // `stats_daily` is always updated by telemetry, while `request_logs` is optional.
    let now = time::OffsetDateTime::now_utc();
    let (start_date, end_date) = match period.as_str() {
        "today" => {
            let fmt =
                time::format_description::parse("[year][month][day]").expect("valid date format");
            let day = now.format(&fmt).unwrap_or_else(|_| "19700101".to_string());
            (day.clone(), day)
        }
        "7d" => {
            let fmt =
                time::format_description::parse("[year][month][day]").expect("valid date format");
            let end = now.format(&fmt).unwrap_or_else(|_| "19700101".to_string());
            let start = (now - time::Duration::days(6))
                .format(&fmt)
                .unwrap_or_else(|_| "19700101".to_string());
            (start, end)
        }
        "30d" => {
            let fmt =
                time::format_description::parse("[year][month][day]").expect("valid date format");
            let end = now.format(&fmt).unwrap_or_else(|_| "19700101".to_string());
            let start = (now - time::Duration::days(29))
                .format(&fmt)
                .unwrap_or_else(|_| "19700101".to_string());
            (start, end)
        }
        _ => return http::json_error(StatusCode::BAD_REQUEST, "invalid period"),
    };

    let daily_rows = match state
        .db
        .list_stats_daily_range(0, &start_date, &end_date)
        .await
    {
        Ok(rows) => rows,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let mut requests_total: i64 = 0;
    let mut failed_total: i64 = 0;
    let mut cost_total = Decimal::ZERO;
    for row in &daily_rows {
        requests_total += row.request_success + row.request_failed;
        failed_total += row.request_failed;
        cost_total += Decimal::from_str(&row.cost_total_usd).unwrap_or(Decimal::ZERO);
    }

    let p95 = match state.db.p95_request_latency_ms(from_ms, to_ms).await {
        Ok(value) => value,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let error_rate = if requests_total > 0 {
        (failed_total as f64 / requests_total as f64) * 100.0
    } else {
        0.0
    };

    let providers = match state.db.list_upstream_providers().await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let endpoints = match state.db.list_upstream_endpoints().await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let keys = match state.db.list_upstream_keys_meta().await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let providers_enabled = providers.iter().filter(|p| p.enabled).count();
    let endpoints_enabled = endpoints.iter().filter(|e| e.enabled).count();
    let keys_enabled = keys.iter().filter(|k| k.enabled).count();

    let snap = match state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
    {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let mut healthy = 0_u32;
    let mut warning = 0_u32;
    let mut error = 0_u32;
    for provider in &snap.providers {
        let provider_endpoints = snap
            .endpoints_by_provider
            .get(&provider.id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let provider_keys = snap
            .keys_by_provider
            .get(&provider.id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let health = summarize_provider_health(
            provider_endpoints,
            provider_keys,
            &state.endpoint_health,
            &state.upstream_key_health,
            now_ms,
        );
        match health.state {
            crate::health::CircuitState::Closed => healthy += 1,
            crate::health::CircuitState::HalfOpen => warning += 1,
            crate::health::CircuitState::Open => error += 1,
        }
    }

    let anomalies = match state
        .db
        .list_request_logs(
            1,
            5,
            &RequestLogFilter {
                time_from_ms: Some(from_ms),
                time_to_ms: Some(to_ms),
                status_class: Some(4),
                ..RequestLogFilter::default()
            },
        )
        .await
    {
        Ok(mut rows) => {
            let mut rows_5xx = state
                .db
                .list_request_logs(
                    1,
                    5,
                    &RequestLogFilter {
                        time_from_ms: Some(from_ms),
                        time_to_ms: Some(to_ms),
                        status_class: Some(5),
                        ..RequestLogFilter::default()
                    },
                )
                .await
                .unwrap_or_default();
            // Also treat non-HTTP failures recorded via `error_type` as anomalies (e.g. upstream body errors).
            let mut rows_error_type = state
                .db
                .list_request_logs(
                    1,
                    5,
                    &RequestLogFilter {
                        time_from_ms: Some(from_ms),
                        time_to_ms: Some(to_ms),
                        error_type: Some("%".to_string()),
                        ..RequestLogFilter::default()
                    },
                )
                .await
                .unwrap_or_default();
            rows.append(&mut rows_5xx);
            rows.append(&mut rows_error_type);
            rows.sort_by(|a, b| b.time_ms.cmp(&a.time_ms));
            rows.into_iter().take(5).collect::<Vec<_>>()
        }
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let top_models = match state
        .db
        .list_usage_breakdown(UsageBreakdownBy::Model, from_ms, to_ms, 5)
        .await
    {
        Ok(rows) => rows,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let top_keys = match state
        .db
        .list_usage_breakdown(UsageBreakdownBy::ApiKey, from_ms, to_ms, 5)
        .await
    {
        Ok(rows) => rows,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let payload = serde_json::json!({
        "period": period,
        "window": { "from_ms": from_ms, "to_ms": to_ms },
        "kpis": {
            "requests": requests_total,
            "failed": failed_total,
            "error_rate": error_rate,
            "p95_latency_ms": p95,
            "cost_total_usd": format!("{:.15}", cost_total)
        },
        "service_health": {
            "providers_enabled": providers_enabled,
            "endpoints_enabled": endpoints_enabled,
            "upstream_keys_enabled": keys_enabled,
            "healthy": healthy,
            "warning": warning,
            "error": error
        },
        "recent_anomalies": anomalies,
        "top_models": top_models,
        "top_keys": top_keys
    });

    http::json(StatusCode::OK, &payload)
}

async fn stats_usage_breakdown(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let by = match query_string(req.uri().query(), "by").as_deref() {
        Some("api_key") => UsageBreakdownBy::ApiKey,
        Some("model") | None => UsageBreakdownBy::Model,
        _ => return http::json_error(StatusCode::BAD_REQUEST, "invalid by"),
    };
    let period = query_string(req.uri().query(), "period").unwrap_or_else(|| "today".to_string());
    let now_ms = util::now_ms();
    let (from_ms, to_ms) = match period.as_str() {
        "today" => {
            let today = (now_ms / 86_400_000) * 86_400_000;
            (today, now_ms)
        }
        "7d" => (now_ms - 7 * 86_400_000, now_ms),
        "30d" => (now_ms - 30 * 86_400_000, now_ms),
        _ => return http::json_error(StatusCode::BAD_REQUEST, "invalid period"),
    };
    let limit = query_i64(req.uri().query(), "limit")
        .unwrap_or(20)
        .clamp(1, 100);

    match state
        .db
        .list_usage_breakdown(by, from_ms, to_ms, limit)
        .await
    {
        Ok(rows) => http::json(
            StatusCode::OK,
            &serde_json::json!({
                "by": match by {
                    UsageBreakdownBy::Model => "model",
                    UsageBreakdownBy::ApiKey => "api_key",
                },
                "period": period,
                "window": { "from_ms": from_ms, "to_ms": to_ms },
                "rows": rows
            }),
        ),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_logs(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let page = query_i64(req.uri().query(), "page").unwrap_or(1);
    let page_size = query_i64(req.uri().query(), "page_size").unwrap_or(20);
    let model = query_string(req.uri().query(), "model");
    let provider_id = query_i64(req.uri().query(), "provider_id");
    let endpoint_id = query_i64(req.uri().query(), "endpoint_id");
    let upstream_key_id = query_i64(req.uri().query(), "upstream_key_id");
    let api_key_id = query_i64(req.uri().query(), "api_key_id");
    let api_key_log_enabled = match query_string(req.uri().query(), "api_key_log_enabled")
        .as_deref()
    {
        Some("true") | Some("1") => Some(true),
        Some("false") | Some("0") => Some(false),
        Some(_) => return http::json_error(StatusCode::BAD_REQUEST, "invalid api_key_log_enabled"),
        None => None,
    };
    let api_format = query_string(req.uri().query(), "api_format");
    let error_type = query_string(req.uri().query(), "error_type");
    let status_class = query_i64(req.uri().query(), "status_class").map(|value| value as i32);
    let time_from_ms = query_i64(req.uri().query(), "time_from_ms");
    let time_to_ms = query_i64(req.uri().query(), "time_to_ms");
    let duration_ms_min = query_i64(req.uri().query(), "duration_ms_min");
    let duration_ms_max = query_i64(req.uri().query(), "duration_ms_max");
    let total_tokens_min = query_i64(req.uri().query(), "total_tokens_min");
    let total_tokens_max = query_i64(req.uri().query(), "total_tokens_max");
    let cost_total_min = query_f64(req.uri().query(), "cost_total_min");
    let cost_total_max = query_f64(req.uri().query(), "cost_total_max");
    let cache_read_input_tokens_min = query_i64(req.uri().query(), "cache_read_input_tokens_min");
    let cache_read_input_tokens_max = query_i64(req.uri().query(), "cache_read_input_tokens_max");
    let cache_creation_input_tokens_min =
        query_i64(req.uri().query(), "cache_creation_input_tokens_min");
    let cache_creation_input_tokens_max =
        query_i64(req.uri().query(), "cache_creation_input_tokens_max");

    if let Some(format) = api_format.as_deref()
        && !matches!(format, "chat_completions" | "responses")
    {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid api_format");
    }
    if let (Some(from_ms), Some(to_ms)) = (time_from_ms, time_to_ms)
        && from_ms > to_ms
    {
        return http::json_error(
            StatusCode::BAD_REQUEST,
            "time_from_ms must be <= time_to_ms",
        );
    }
    if let (Some(min_ms), Some(max_ms)) = (duration_ms_min, duration_ms_max)
        && min_ms > max_ms
    {
        return http::json_error(
            StatusCode::BAD_REQUEST,
            "duration_ms_min must be <= duration_ms_max",
        );
    }
    if let (Some(min_tokens), Some(max_tokens)) = (total_tokens_min, total_tokens_max)
        && min_tokens > max_tokens
    {
        return http::json_error(
            StatusCode::BAD_REQUEST,
            "total_tokens_min must be <= total_tokens_max",
        );
    }
    if let (Some(min_cost), Some(max_cost)) = (cost_total_min, cost_total_max)
        && min_cost > max_cost
    {
        return http::json_error(
            StatusCode::BAD_REQUEST,
            "cost_total_min must be <= cost_total_max",
        );
    }
    if let (Some(min_tokens), Some(max_tokens)) =
        (cache_read_input_tokens_min, cache_read_input_tokens_max)
        && min_tokens > max_tokens
    {
        return http::json_error(
            StatusCode::BAD_REQUEST,
            "cache_read_input_tokens_min must be <= cache_read_input_tokens_max",
        );
    }
    if let (Some(min_tokens), Some(max_tokens)) = (
        cache_creation_input_tokens_min,
        cache_creation_input_tokens_max,
    ) && min_tokens > max_tokens
    {
        return http::json_error(
            StatusCode::BAD_REQUEST,
            "cache_creation_input_tokens_min must be <= cache_creation_input_tokens_max",
        );
    }

    let filter = RequestLogFilter {
        model,
        provider_id,
        endpoint_id,
        upstream_key_id,
        api_key_id,
        api_key_log_enabled,
        api_format,
        error_type,
        status_class,
        time_from_ms,
        time_to_ms,
        duration_ms_min,
        duration_ms_max,
        total_tokens_min,
        total_tokens_max,
        cost_total_min,
        cost_total_max,
        cache_read_input_tokens_min,
        cache_read_input_tokens_max,
        cache_creation_input_tokens_min,
        cache_creation_input_tokens_max,
    };

    match state.db.list_request_logs(page, page_size, &filter).await {
        Ok(rows) => http::json(StatusCode::OK, &rows),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn api_key_to_json(k: &ApiKeyAuth) -> Value {
    serde_json::json!({
        "id": k.id,
        "name": k.name,
        "enabled": k.enabled,
        "expires_at_ms": k.expires_at_ms,
        "log_enabled": k.log_enabled
    })
}

fn provider_to_json(p: &UpstreamProvider, health: ProviderHealthView) -> Value {
    serde_json::json!({
        "id": p.id,
        "name": p.name,
        "provider_type": p.provider_type,
        "enabled": p.enabled,
        "priority": p.priority,
        "weight": p.weight,
        "supports_include_usage": p.supports_include_usage,
        "websocket_enabled": p.websocket_enabled,
        "health": health
    })
}

fn is_valid_provider_type(provider_type: &str) -> bool {
    ALLOWED_PROVIDER_TYPES.contains(&provider_type)
}

fn endpoint_to_json(e: &UpstreamEndpoint, health: EndpointHealthView) -> Value {
    serde_json::json!({
        "id": e.id,
        "provider_id": e.provider_id,
        "name": e.name,
        "base_url": e.base_url,
        "enabled": e.enabled,
        "priority": e.priority,
        "weight": e.weight,
        "health": health
    })
}

fn upstream_key_to_json(k: &UpstreamKeyMeta, health: UpstreamKeyHealthView) -> Value {
    serde_json::json!({
        "id": k.id,
        "provider_id": k.provider_id,
        "name": k.name,
        "enabled": k.enabled,
        "priority": k.priority,
        "weight": k.weight,
        "health": health
    })
}

fn parse_id_suffix(path: &str, prefix: &str) -> Option<i64> {
    let rest = path.strip_prefix(prefix)?;
    let rest = rest.trim_matches('/');
    // If there are more segments (like /endpoints), ignore here.
    let id_str = rest.split('/').next()?;
    id_str.parse::<i64>().ok()
}

fn parse_string_suffix(path: &str, prefix: &str) -> Option<String> {
    let rest = path.strip_prefix(prefix)?;
    let rest = rest.trim_matches('/');
    if rest.is_empty() {
        return None;
    }
    Some(rest.to_string())
}

fn parse_provider_id_with_suffix(path: &str, suffix: &str) -> Option<i64> {
    // /api/v1/providers/{id}{suffix}
    let rest = path.strip_prefix("/api/v1/providers/")?;
    let rest = rest.strip_suffix(suffix)?;
    let rest = rest.trim_matches('/');
    rest.parse::<i64>().ok()
}

fn query_i64(q: Option<&str>, key: &str) -> Option<i64> {
    let q = q?;
    for part in q.split('&') {
        let mut it = part.splitn(2, '=');
        let k = it.next()?.trim();
        let v = it.next().unwrap_or("").trim();
        if k == key && !v.is_empty() {
            return v.parse::<i64>().ok();
        }
    }
    None
}

fn query_string(q: Option<&str>, key: &str) -> Option<String> {
    fn decode_query_value(raw: &str) -> String {
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
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                b'%' if i + 2 < bytes.len() => {
                    let hi = from_hex(bytes[i + 1]);
                    let lo = from_hex(bytes[i + 2]);
                    if let (Some(hi), Some(lo)) = (hi, lo) {
                        out.push((hi << 4) | lo);
                        i += 3;
                    } else {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
                byte => {
                    out.push(byte);
                    i += 1;
                }
            }
        }

        String::from_utf8(out)
            .unwrap_or_else(|e| String::from_utf8_lossy(&e.into_bytes()).into_owned())
    }

    let q = q?;
    for part in q.split('&') {
        let mut it = part.splitn(2, '=');
        let k = it.next()?.trim();
        let v = it.next().unwrap_or("").trim();
        if k == key && !v.is_empty() {
            return Some(decode_query_value(v));
        }
    }
    None
}

fn query_f64(q: Option<&str>, key: &str) -> Option<f64> {
    let q = q?;
    for part in q.split('&') {
        let mut it = part.splitn(2, '=');
        let k = it.next()?.trim();
        let v = it.next().unwrap_or("").trim();
        if k == key && !v.is_empty() {
            return v.parse::<f64>().ok();
        }
    }
    None
}

fn normalize_base_url(input: &str) -> String {
    input.trim_end_matches('/').to_string()
}

fn request_origin(req: &Request<Incoming>) -> String {
    let scheme = req
        .headers()
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.split(',').next())
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .unwrap_or("http");

    let host = req
        .headers()
        .get("x-forwarded-host")
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.split(',').next())
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .or_else(|| {
            req.headers()
                .get(HOST)
                .and_then(|value| value.to_str().ok())
        })
        .unwrap_or("localhost");

    format!("{scheme}://{host}")
}

fn generate_api_key_plaintext() -> String {
    let mut bytes = [0u8; 24];
    fastrand::fill(&mut bytes);
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    format!("cg_{}", raw)
}
