use base64::Engine;
use http_body_util::{BodyExt, Full, Limited};
use hyper::Uri;
use hyper::body::Bytes;
use hyper::body::Incoming;
use hyper::{Method, Request, StatusCode};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::collections::HashMap;

use crate::db::RequestLogFilter;
use crate::health::{
    EndpointHealthView, ProviderHealthView, UpstreamKeyHealthView, summarize_provider_health,
};
use crate::http::{self, HttpResponse};
use crate::pricing::PriceCard;
use crate::state::SharedState;
use crate::types::{
    ApiKeyAuth, ModelAlias, ModelAliasTarget, UpstreamEndpoint, UpstreamKeyMeta, UpstreamProvider,
};
use crate::util;
use tokio::time as tokio_time;

const ALLOWED_PROVIDER_TYPES: [&str; 3] =
    ["openai", "openai_compatible", "openai_compatible_responses"];
const BETA_FEATURE_RESPONSES_HTTP_TO_WS: &str = "responses-http-to-ws";

// Admin endpoints sometimes probe upstreams that can return arbitrary HTML/JSON.
// Keep these payloads bounded to avoid untrusted memory spikes.
const ADMIN_UPSTREAM_MODELS_BODY_MAX_BYTES: usize = 1024 * 1024;
const ADMIN_UPSTREAM_TEST_BODY_MAX_BYTES: usize = 16 * 1024;
const MILLIS_PER_HOUR: i64 = 3_600_000;
const MILLIS_PER_DAY: i64 = 86_400_000;
const ASIA_SHANGHAI_OFFSET_MS: i64 = 8 * MILLIS_PER_HOUR;

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn build_info() -> Value {
    serde_json::json!({
        "version": option_env!("LITTLE_GATE_VERSION").unwrap_or("dev"),
        "commit": option_env!("LITTLE_GATE_COMMIT").unwrap_or("unknown"),
    })
}

fn stats_window(period: &str, now_ms: i64) -> Option<(i64, i64)> {
    match period {
        "today" => {
            let today = ((now_ms + ASIA_SHANGHAI_OFFSET_MS) / MILLIS_PER_DAY) * MILLIS_PER_DAY
                - ASIA_SHANGHAI_OFFSET_MS;
            Some((today, now_ms))
        }
        "7h" => Some((now_ms.saturating_sub(7 * MILLIS_PER_HOUR), now_ms)),
        "24h" => Some((now_ms.saturating_sub(24 * MILLIS_PER_HOUR), now_ms)),
        "week" | "7d" => Some((now_ms.saturating_sub(7 * MILLIS_PER_DAY), now_ms)),
        "month" | "30d" => Some((now_ms.saturating_sub(30 * MILLIS_PER_DAY), now_ms)),
        _ => None,
    }
}

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

        (Method::GET, "/api/v1/provider-groups") => return list_provider_groups(req, state).await,
        (Method::POST, "/api/v1/provider-groups") => {
            return create_provider_group(req, state).await;
        }

        (Method::GET, "/api/v1/providers") => return list_providers(req, state).await,
        (Method::POST, "/api/v1/providers") => return create_provider(req, state).await,

        (Method::GET, "/api/v1/routes") => return list_routes(req, state).await,
        (Method::GET, "/api/v1/prices") => return list_prices(req, state).await,
        (Method::POST, "/api/v1/prices") => return create_price(req, state).await,
        (Method::GET, "/api/v1/system/config") => return system_config(req, state).await,
        (Method::GET, "/api/v1/runtime-settings") => return runtime_settings(req, state).await,
        (Method::PATCH, "/api/v1/runtime-settings") => {
            return patch_runtime_setting(req, state).await;
        }
        (Method::POST, "/api/v1/runtime-settings/env-preview") => {
            return runtime_settings_env_preview(req, state).await;
        }
        (Method::GET, "/api/v1/gateway-models") => return list_gateway_models(req, state).await,
        (Method::PATCH, "/api/v1/gateway-models") => return patch_gateway_model(req, state).await,
        (Method::GET, "/api/v1/model-aliases") => return list_model_aliases(req, state).await,
        (Method::POST, "/api/v1/model-aliases") => return create_model_alias(req, state).await,

        (Method::GET, "/api/v1/stats/daily") => return stats_daily(req, state).await,
        (Method::GET, "/api/v1/stats/overview") => return stats_overview(req, state).await,
        (Method::GET, "/api/v1/stats/live") => return stats_live(req, state).await,
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
    if path.starts_with("/api/v1/provider-groups/") {
        if req.method() == Method::PATCH {
            return update_provider_group(req, state).await;
        }
        if req.method() == Method::DELETE {
            return delete_provider_group(req, state).await;
        }
    }
    if path.starts_with("/api/v1/providers/") {
        if req.method() == Method::POST && path.ends_with("/circuit/reset") {
            return reset_provider_circuit(req, state).await;
        }
        if req.method() == Method::PATCH {
            return update_provider(req, state).await;
        }
        if req.method() == Method::DELETE {
            return delete_provider(req, state).await;
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
    }
    if path.starts_with("/api/v1/endpoints/") {
        if req.method() == Method::PATCH {
            return update_endpoint(req, state).await;
        }
        if req.method() == Method::DELETE {
            return delete_endpoint(req, state).await;
        }
        if req.method() == Method::POST && path.ends_with("/test") {
            return test_endpoint(req, state).await;
        }
    }
    if path.starts_with("/api/v1/keys/") {
        if req.method() == Method::PATCH {
            return update_key(req, state).await;
        }
        if req.method() == Method::DELETE {
            return delete_key(req, state).await;
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
    if path.starts_with("/api/v1/model-aliases/") {
        if req.method() == Method::PATCH && !path.ends_with("/targets") {
            return patch_model_alias(req, state).await;
        }
        if req.method() == Method::DELETE && !path.ends_with("/targets") {
            return delete_model_alias(req, state).await;
        }
        if req.method() == Method::GET && path.ends_with("/targets") {
            return list_model_alias_targets(req, state).await;
        }
        if req.method() == Method::POST && path.ends_with("/targets") {
            return create_model_alias_target(req, state).await;
        }
    }
    if path.starts_with("/api/v1/model-alias-targets/") {
        if req.method() == Method::PATCH {
            return patch_model_alias_target(req, state).await;
        }
        if req.method() == Method::DELETE {
            return delete_model_alias_target(req, state).await;
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
    let body_bytes = match Limited::new(response.into_body(), ADMIN_UPSTREAM_MODELS_BODY_MAX_BYTES)
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
    let body_bytes = match Limited::new(response.into_body(), ADMIN_UPSTREAM_MODELS_BODY_MAX_BYTES)
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

async fn list_model_aliases(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let aliases = match state.db.list_model_aliases().await {
        Ok(items) => items,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let targets = match state.db.list_model_alias_targets(None).await {
        Ok(items) => items,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let payload = aliases
        .iter()
        .map(|alias| {
            let alias_targets = targets
                .iter()
                .filter(|target| target.alias_id == alias.id)
                .cloned()
                .collect::<Vec<_>>();
            model_alias_to_json(alias, alias_targets)
        })
        .collect::<Vec<_>>();
    http::json(StatusCode::OK, &payload)
}

#[derive(Debug, Deserialize)]
struct CreateModelAliasReq {
    name: String,
    enabled: Option<bool>,
    mode: Option<String>,
}

async fn create_model_alias(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let (_, body, _raw) =
        match http::read_json_limited::<CreateModelAliasReq>(req, state.config.max_request_bytes)
            .await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };
    let name = body.name.trim();
    if name.is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "name is empty");
    }
    let mode = body.mode.as_deref().unwrap_or("ordered").trim();
    if !is_valid_alias_mode(mode) {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid mode");
    }
    match state
        .db
        .insert_model_alias(name, body.enabled.unwrap_or(true), mode, util::now_ms())
        .await
    {
        Ok(id) => {
            state.caches.upstream.invalidate();
            http::json(StatusCode::OK, &serde_json::json!({ "id": id }))
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct PatchModelAliasReq {
    name: Option<String>,
    enabled: Option<bool>,
    mode: Option<String>,
}

async fn patch_model_alias(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(alias_id) = parse_id_suffix(path, "/api/v1/model-aliases/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid alias id");
    };
    let (_, patch, _raw) =
        match http::read_json_limited::<PatchModelAliasReq>(req, state.config.max_request_bytes)
            .await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };
    let aliases = match state.db.list_model_aliases().await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some(current) = aliases.into_iter().find(|item| item.id == alias_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "alias not found");
    };
    let name = patch.name.unwrap_or(current.name).trim().to_string();
    if name.is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "name is empty");
    }
    let mode = patch.mode.unwrap_or(current.mode).trim().to_string();
    if !is_valid_alias_mode(&mode) {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid mode");
    }
    let enabled = patch.enabled.unwrap_or(current.enabled);
    match state
        .db
        .update_model_alias(alias_id, &name, enabled, &mode, util::now_ms())
        .await
    {
        Ok(()) => {
            state.caches.upstream.invalidate();
            http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn delete_model_alias(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(alias_id) = parse_id_suffix(path, "/api/v1/model-aliases/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid alias id");
    };
    match state.db.delete_model_alias(alias_id).await {
        Ok(()) => {
            state.caches.upstream.invalidate();
            http::empty(StatusCode::NO_CONTENT)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_model_alias_targets(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(alias_id) =
        parse_provider_id_with_prefix_and_suffix(path, "/api/v1/model-aliases/", "/targets")
    else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid alias id");
    };
    match state.db.list_model_alias_targets(Some(alias_id)).await {
        Ok(items) => http::json(StatusCode::OK, &items),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct CreateAliasTargetReq {
    #[serde(alias = "providerId")]
    provider_id: i64,
    #[serde(alias = "upstreamModel")]
    upstream_model: String,
    enabled: Option<bool>,
    priority: Option<i32>,
    weight: Option<i32>,
}

async fn create_model_alias_target(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(alias_id) =
        parse_provider_id_with_prefix_and_suffix(path, "/api/v1/model-aliases/", "/targets")
    else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid alias id");
    };
    let (_, body, _raw) =
        match http::read_json_limited::<CreateAliasTargetReq>(req, state.config.max_request_bytes)
            .await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };
    if body.upstream_model.trim().is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "upstream_model is empty");
    }
    match state
        .db
        .insert_model_alias_target(
            alias_id,
            body.provider_id,
            body.upstream_model.trim(),
            body.enabled.unwrap_or(true),
            body.priority.unwrap_or(100),
            body.weight.unwrap_or(1),
            util::now_ms(),
        )
        .await
    {
        Ok(id) => {
            state.caches.upstream.invalidate();
            http::json(StatusCode::OK, &serde_json::json!({ "id": id }))
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct PatchAliasTargetReq {
    #[serde(alias = "providerId")]
    provider_id: Option<i64>,
    #[serde(alias = "upstreamModel")]
    upstream_model: Option<String>,
    enabled: Option<bool>,
    priority: Option<i32>,
    weight: Option<i32>,
}

async fn patch_model_alias_target(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(target_id) = parse_id_suffix(path, "/api/v1/model-alias-targets/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid target id");
    };
    let (_, patch, _raw) =
        match http::read_json_limited::<PatchAliasTargetReq>(req, state.config.max_request_bytes)
            .await
        {
            Ok(v) => v,
            Err(resp) => return resp,
        };
    let targets = match state.db.list_model_alias_targets(None).await {
        Ok(v) => v,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let Some(current) = targets.into_iter().find(|target| target.id == target_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "target not found");
    };
    let upstream_model = patch
        .upstream_model
        .unwrap_or(current.upstream_model)
        .trim()
        .to_string();
    if upstream_model.is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "upstream_model is empty");
    }
    match state
        .db
        .update_model_alias_target(
            target_id,
            patch.provider_id.unwrap_or(current.provider_id),
            &upstream_model,
            patch.enabled.unwrap_or(current.enabled),
            patch.priority.unwrap_or(current.priority),
            patch.weight.unwrap_or(current.weight),
            util::now_ms(),
        )
        .await
    {
        Ok(()) => {
            state.caches.upstream.invalidate();
            http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn delete_model_alias_target(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(target_id) = parse_id_suffix(path, "/api/v1/model-alias-targets/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid target id");
    };
    match state.db.delete_model_alias_target(target_id).await {
        Ok(()) => {
            state.caches.upstream.invalidate();
            http::empty(StatusCode::NO_CONTENT)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct PatchRuntimeSettingReq {
    key: String,
    value: Value,
}

async fn runtime_settings(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    match state.runtime_settings.views(&state.config, &state.db).await {
        Ok(settings) => http::json(
            StatusCode::OK,
            &serde_json::json!({
                "settings": settings,
                "updated_at_ms": util::now_ms()
            }),
        ),
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn patch_runtime_setting(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let (_, body, _raw) = match http::read_json_limited::<PatchRuntimeSettingReq>(
        req,
        state.config.max_request_bytes,
    )
    .await
    {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    let key = body.key.trim();
    if key.is_empty() {
        return http::json_error(StatusCode::BAD_REQUEST, "key is empty");
    }

    match state
        .runtime_settings
        .update(&state.db, key, body.value, util::now_ms())
        .await
    {
        Ok(()) => http::json(StatusCode::OK, &serde_json::json!({ "ok": true })),
        Err(message) if message == "unknown setting" => {
            http::json_error(StatusCode::NOT_FOUND, message)
        }
        Err(message) if message == "setting requires restart" => {
            http::json_error(StatusCode::CONFLICT, message)
        }
        Err(message) => http::json_error(StatusCode::BAD_REQUEST, message),
    }
}

async fn runtime_settings_env_preview(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let runtime = state.runtime_settings.snapshot();
    let payload = serde_json::json!({
        "profile": "low_memory",
        "hot_settings": [
            {
                "key": "inject_include_usage",
                "label": "返回用量",
                "value": runtime.inject_include_usage,
            },
            {
                "key": "endpoint_selector_strategy",
                "label": "节点分配",
                "value": format!("{:?}", runtime.endpoint_selector_strategy).to_ascii_lowercase(),
            },
            {
                "key": "usage_capture_bytes",
                "label": "用量采样",
                "value": runtime.usage_capture_bytes,
            },
            {
                "key": "usage_capture_tail_bytes",
                "label": "尾部采样",
                "value": runtime.usage_capture_tail_bytes,
            },
            {
                "key": "request_log_retention_days",
                "label": "日志保留",
                "value": runtime.request_log_retention_days,
            },
            {
                "key": "stats_daily_retention_days",
                "label": "统计保留",
                "value": runtime.stats_daily_retention_days,
            }
        ],
        "restart_settings": [
            {
                "key": "db_max_connections",
                "label": "数据库连接",
                "current": state.config.db_max_connections,
                "recommended": 2,
            },
            {
                "key": "api_key_cache_max_entries",
                "label": "密钥缓存",
                "current": state.config.api_key_cache_max_entries,
                "recommended": 2048,
            },
            {
                "key": "max_request_bytes",
                "label": "请求大小",
                "current": state.config.max_request_bytes,
                "recommended": 4 * 1024 * 1024,
            },
            {
                "key": "log_queue_capacity",
                "label": "日志队列",
                "current": state.config.log_queue_capacity,
                "recommended": 256,
            },
            {
                "key": "stats_flush_interval_ms",
                "label": "统计刷新",
                "current": state.config.stats_flush_interval.as_millis() as u64,
                "recommended": 5000,
            }
        ]
    });
    http::json(StatusCode::OK, &payload)
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
struct ProviderGroupReq {
    name: String,
}

fn normalize_provider_group_name(value: &str) -> Result<(String, String), &'static str> {
    let name = value.trim();
    if name.is_empty() {
        return Err("group name is empty");
    }
    if name.chars().count() > 64 {
        return Err("group name must be at most 64 characters");
    }
    let normalized = name.to_lowercase();
    if normalized == "default" {
        return Err("default group is reserved");
    }
    Ok((name.to_string(), normalized))
}

fn validate_provider_group_ids(
    group_ids: &[i64],
    available: &[crate::types::ProviderGroup],
) -> Result<(), &'static str> {
    if group_ids.is_empty() {
        return Err("at least one provider group is required");
    }
    let mut unique = std::collections::HashSet::with_capacity(group_ids.len());
    for group_id in group_ids {
        if !unique.insert(*group_id) {
            return Err("provider group ids must be unique");
        }
        if !available.iter().any(|group| group.id == *group_id) {
            return Err("provider group not found");
        }
    }
    Ok(())
}

fn default_provider_group_id(groups: &[crate::types::ProviderGroup]) -> Option<i64> {
    groups
        .iter()
        .find(|group| group.is_default)
        .map(|group| group.id)
}

async fn list_provider_groups(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    match state.db.list_provider_groups().await {
        Ok(groups) => http::json(StatusCode::OK, &groups),
        Err(error) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn create_provider_group(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let (_, body, _) = match http::read_json_limited::<ProviderGroupReq>(
        req,
        state.config.max_request_bytes,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (name, normalized_name) = match normalize_provider_group_name(&body.name) {
        Ok(value) => value,
        Err(message) => return http::json_error(StatusCode::BAD_REQUEST, message),
    };
    let groups = match state.db.list_provider_groups().await {
        Ok(value) => value,
        Err(error) => {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    if groups
        .iter()
        .any(|group| group.normalized_name == normalized_name)
    {
        return http::json_error(StatusCode::CONFLICT, "provider group already exists");
    }
    match state
        .db
        .insert_provider_group(&name, &normalized_name, util::now_ms())
        .await
    {
        Ok(id) => http::json(StatusCode::OK, &serde_json::json!({ "id": id })),
        Err(error) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn update_provider_group(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let Some(group_id) = parse_id_suffix(req.uri().path(), "/api/v1/provider-groups/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider group id");
    };
    let (_, body, _) = match http::read_json_limited::<ProviderGroupReq>(
        req,
        state.config.max_request_bytes,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (name, normalized_name) = match normalize_provider_group_name(&body.name) {
        Ok(value) => value,
        Err(message) => return http::json_error(StatusCode::BAD_REQUEST, message),
    };
    let groups = match state.db.list_provider_groups().await {
        Ok(value) => value,
        Err(error) => {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let Some(current) = groups.iter().find(|group| group.id == group_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "provider group not found");
    };
    if current.is_default {
        return http::json_error(StatusCode::CONFLICT, "default group cannot be renamed");
    }
    if groups
        .iter()
        .any(|group| group.id != group_id && group.normalized_name == normalized_name)
    {
        return http::json_error(StatusCode::CONFLICT, "provider group already exists");
    }
    match state
        .db
        .update_provider_group(group_id, &name, &normalized_name, util::now_ms())
        .await
    {
        Ok(true) => {
            state.caches.upstream.invalidate();
            state.caches.api_keys.invalidate_all();
            http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
        }
        Ok(false) => http::json_error(StatusCode::NOT_FOUND, "provider group not found"),
        Err(error) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn delete_provider_group(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let Some(group_id) = parse_id_suffix(req.uri().path(), "/api/v1/provider-groups/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider group id");
    };
    let groups = match state.db.list_provider_groups().await {
        Ok(value) => value,
        Err(error) => {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let Some(current) = groups.iter().find(|group| group.id == group_id) else {
        return http::json_error(StatusCode::NOT_FOUND, "provider group not found");
    };
    if current.is_default {
        return http::json_error(StatusCode::CONFLICT, "default group cannot be deleted");
    }
    if current.provider_count > 0 || current.api_key_count > 0 {
        return http::json(
            StatusCode::CONFLICT,
            &serde_json::json!({
                "error": "provider group is still assigned",
                "provider_count": current.provider_count,
                "api_key_count": current.api_key_count,
            }),
        );
    }
    match state.db.delete_provider_group(group_id).await {
        Ok(true) => http::empty(StatusCode::NO_CONTENT),
        Ok(false) => http::json_error(StatusCode::CONFLICT, "provider group cannot be deleted"),
        Err(error) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
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
    #[serde(default, alias = "providerGroupIds")]
    provider_group_ids: Option<Vec<i64>>,
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
    let available_groups = match state.db.list_provider_groups().await {
        Ok(value) => value,
        Err(error) => {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let provider_group_ids = match body.provider_group_ids {
        Some(value) => value,
        None => match default_provider_group_id(&available_groups) {
            Some(group_id) => vec![group_id],
            None => {
                return http::json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "default provider group is missing",
                );
            }
        },
    };
    if let Err(message) = validate_provider_group_ids(&provider_group_ids, &available_groups) {
        return http::json_error(StatusCode::BAD_REQUEST, message);
    }

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

    if let Err(error) = state
        .db
        .replace_api_key_provider_groups(id, &provider_group_ids, now_ms)
        .await
    {
        let _ = state.db.delete_api_key(id).await;
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }

    state.caches.api_keys.invalidate_all();

    let resp = serde_json::json!({
        "id": id,
        "api_key": api_key_plaintext,
        "name": body.name.trim(),
        "enabled": enabled,
        "expires_at_ms": body.expires_at_ms,
        "log_enabled": log_enabled,
        "provider_groups": available_groups
            .iter()
            .filter(|group| provider_group_ids.contains(&group.id))
            .map(|group| serde_json::json!({ "id": group.id, "name": group.name }))
            .collect::<Vec<_>>()
    });
    http::json(StatusCode::OK, &resp)
}

#[derive(Debug, Deserialize)]
struct PatchApiKeyReq {
    name: Option<String>,
    enabled: Option<bool>,
    #[serde(
        default,
        alias = "expiresAtMs",
        deserialize_with = "deserialize_present_option"
    )]
    expires_at_ms: Option<Option<i64>>,
    #[serde(alias = "logEnabled")]
    log_enabled: Option<bool>,
    #[serde(alias = "providerGroupIds")]
    provider_group_ids: Option<Vec<i64>>,
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
    let available_groups = match state.db.list_provider_groups().await {
        Ok(value) => value,
        Err(error) => {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    if let Some(group_ids) = patch.provider_group_ids.as_deref()
        && let Err(message) = validate_provider_group_ids(group_ids, &available_groups)
    {
        return http::json_error(StatusCode::BAD_REQUEST, message);
    }

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

    if let Some(group_ids) = patch.provider_group_ids
        && let Err(error) = state
            .db
            .replace_api_key_provider_groups(id, &group_ids, now_ms)
            .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
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
struct ProviderGroupAssignmentReq {
    #[serde(alias = "groupId")]
    group_id: i64,
    #[serde(alias = "priorityOverride")]
    priority_override: Option<i32>,
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
    #[serde(default, alias = "betaFeatures")]
    beta_features: Vec<String>,
    #[serde(alias = "keySelectionStrategy")]
    key_selection_strategy: Option<String>,
    #[serde(default)]
    groups: Option<Vec<ProviderGroupAssignmentReq>>,
    #[serde(alias = "maxAttempts")]
    max_attempts: Option<i32>,
    #[serde(alias = "maxConcurrency")]
    max_concurrency: Option<i32>,
    #[serde(alias = "circuitBreakerEnabled")]
    circuit_breaker_enabled: Option<bool>,
    #[serde(alias = "circuitBreakerFailureThreshold")]
    circuit_breaker_failure_threshold: Option<i32>,
    #[serde(alias = "circuitBreakerOpenMs")]
    circuit_breaker_open_ms: Option<i64>,
    #[serde(alias = "circuitBreakerHalfOpenSuccessThreshold")]
    circuit_breaker_half_open_success_threshold: Option<i32>,
}

fn validate_provider_routing(
    priority: Option<i32>,
    weight: Option<i32>,
) -> Result<(), &'static str> {
    if priority.is_some_and(|value| value < 0) {
        return Err("priority must be greater than or equal to 0");
    }
    if weight.is_some_and(|value| value < 1) {
        return Err("weight must be greater than or equal to 1");
    }
    Ok(())
}

fn validate_provider_resilience(
    max_attempts: i32,
    max_concurrency: Option<i32>,
    failure_threshold: i32,
    open_ms: i64,
    half_open_success_threshold: i32,
) -> Result<(), &'static str> {
    if !(1..=10).contains(&max_attempts) {
        return Err("max_attempts must be between 1 and 10");
    }
    if max_concurrency.is_some_and(|value| !(1..=100_000).contains(&value)) {
        return Err("max_concurrency must be null or between 1 and 100000");
    }
    if !(1..=100).contains(&failure_threshold) {
        return Err("circuit breaker failure threshold must be between 1 and 100");
    }
    if !(1_000..=86_400_000).contains(&open_ms) {
        return Err("circuit breaker open duration must be between 1000 and 86400000 ms");
    }
    if !(1..=20).contains(&half_open_success_threshold) {
        return Err("half-open success threshold must be between 1 and 20");
    }
    Ok(())
}

fn validate_provider_group_assignments(
    assignments: &[ProviderGroupAssignmentReq],
    available: &[crate::types::ProviderGroup],
) -> Result<(), &'static str> {
    let group_ids = assignments
        .iter()
        .map(|assignment| assignment.group_id)
        .collect::<Vec<_>>();
    validate_provider_group_ids(&group_ids, available)?;
    if assignments
        .iter()
        .any(|assignment| assignment.priority_override.is_some_and(|value| value < 0))
    {
        return Err("group priority override must be greater than or equal to 0");
    }
    Ok(())
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
    let affinity_counts = state.affinity.binding_counts_by_provider(now_ms);
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
            let runtime = state.provider_runtime.snapshot(provider, now_ms);
            provider_to_json(
                provider,
                snap.groups_by_provider
                    .get(&provider.id)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                health,
                runtime,
                affinity_counts
                    .get(&provider.id)
                    .copied()
                    .unwrap_or_default(),
            )
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
    if let Err(message) = validate_provider_routing(Some(priority), Some(weight)) {
        return http::json_error(StatusCode::BAD_REQUEST, message);
    }
    let supports_include_usage = body.supports_include_usage.unwrap_or(true);
    let websocket_enabled = body.websocket_enabled.unwrap_or(false);
    let beta_features = normalize_beta_features(body.beta_features);
    let key_selection_strategy = body
        .key_selection_strategy
        .as_deref()
        .unwrap_or("round_robin")
        .trim();
    if !is_valid_key_selection_strategy(key_selection_strategy) {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid key_selection_strategy");
    }
    let max_attempts = body.max_attempts.unwrap_or(2);
    let max_concurrency = body.max_concurrency;
    let circuit_breaker_enabled = body.circuit_breaker_enabled.unwrap_or(true);
    let circuit_breaker_failure_threshold = body.circuit_breaker_failure_threshold.unwrap_or(3);
    let circuit_breaker_open_ms = body.circuit_breaker_open_ms.unwrap_or(30_000);
    let circuit_breaker_half_open_success_threshold = body
        .circuit_breaker_half_open_success_threshold
        .unwrap_or(2);
    if let Err(message) = validate_provider_resilience(
        max_attempts,
        max_concurrency,
        circuit_breaker_failure_threshold,
        circuit_breaker_open_ms,
        circuit_breaker_half_open_success_threshold,
    ) {
        return http::json_error(StatusCode::BAD_REQUEST, message);
    }
    let available_groups = match state.db.list_provider_groups().await {
        Ok(value) => value,
        Err(error) => {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let group_assignments = match body.groups {
        Some(value) => value,
        None => match default_provider_group_id(&available_groups) {
            Some(group_id) => vec![ProviderGroupAssignmentReq {
                group_id,
                priority_override: None,
            }],
            None => {
                return http::json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "default provider group is missing",
                );
            }
        },
    };
    if let Err(message) = validate_provider_group_assignments(&group_assignments, &available_groups)
    {
        return http::json_error(StatusCode::BAD_REQUEST, message);
    }

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
            &beta_features,
            key_selection_strategy,
            max_attempts,
            max_concurrency,
            circuit_breaker_enabled,
            circuit_breaker_failure_threshold,
            circuit_breaker_open_ms,
            circuit_breaker_half_open_success_threshold,
            now_ms,
        )
        .await
    {
        Ok(id) => id,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let group_rows = group_assignments
        .iter()
        .map(|assignment| (assignment.group_id, assignment.priority_override))
        .collect::<Vec<_>>();
    if let Err(error) = state
        .db
        .replace_provider_group_memberships(id, &group_rows, now_ms)
        .await
    {
        let _ = state.db.delete_upstream_provider(id).await;
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }

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
    #[serde(default, alias = "betaFeatures")]
    beta_features: Option<Vec<String>>,
    #[serde(alias = "keySelectionStrategy")]
    key_selection_strategy: Option<String>,
    groups: Option<Vec<ProviderGroupAssignmentReq>>,
    #[serde(alias = "maxAttempts")]
    max_attempts: Option<i32>,
    #[serde(
        default,
        alias = "maxConcurrency",
        deserialize_with = "deserialize_present_option"
    )]
    max_concurrency: Option<Option<i32>>,
    #[serde(alias = "circuitBreakerEnabled")]
    circuit_breaker_enabled: Option<bool>,
    #[serde(alias = "circuitBreakerFailureThreshold")]
    circuit_breaker_failure_threshold: Option<i32>,
    #[serde(alias = "circuitBreakerOpenMs")]
    circuit_breaker_open_ms: Option<i64>,
    #[serde(alias = "circuitBreakerHalfOpenSuccessThreshold")]
    circuit_breaker_half_open_success_threshold: Option<i32>,
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
    if let Err(message) = validate_provider_routing(patch.priority, patch.weight) {
        return http::json_error(StatusCode::BAD_REQUEST, message);
    }

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
    if let Some(v) = patch.beta_features {
        current.beta_features = normalize_beta_features(v);
    }
    if let Some(v) = patch.key_selection_strategy {
        let value = v.trim();
        if !is_valid_key_selection_strategy(value) {
            return http::json_error(StatusCode::BAD_REQUEST, "invalid key_selection_strategy");
        }
        current.key_selection_strategy = value.to_string();
    }
    if let Some(value) = patch.max_attempts {
        current.max_attempts = value;
    }
    if let Some(value) = patch.max_concurrency {
        current.max_concurrency = value;
    }
    if let Some(value) = patch.circuit_breaker_enabled {
        current.circuit_breaker_enabled = value;
    }
    if let Some(value) = patch.circuit_breaker_failure_threshold {
        current.circuit_breaker_failure_threshold = value;
    }
    if let Some(value) = patch.circuit_breaker_open_ms {
        current.circuit_breaker_open_ms = value;
    }
    if let Some(value) = patch.circuit_breaker_half_open_success_threshold {
        current.circuit_breaker_half_open_success_threshold = value;
    }
    if let Err(message) = validate_provider_resilience(
        current.max_attempts,
        current.max_concurrency,
        current.circuit_breaker_failure_threshold,
        current.circuit_breaker_open_ms,
        current.circuit_breaker_half_open_success_threshold,
    ) {
        return http::json_error(StatusCode::BAD_REQUEST, message);
    }

    let available_groups = if patch.groups.is_some() {
        match state.db.list_provider_groups().await {
            Ok(value) => value,
            Err(error) => {
                return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
            }
        }
    } else {
        Vec::new()
    };
    if let Some(assignments) = patch.groups.as_deref()
        && let Err(message) = validate_provider_group_assignments(assignments, &available_groups)
    {
        return http::json_error(StatusCode::BAD_REQUEST, message);
    }

    if let Err(e) = state
        .db
        .update_upstream_provider(&current, util::now_ms())
        .await
    {
        return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    if let Some(assignments) = patch.groups {
        let rows = assignments
            .iter()
            .map(|assignment| (assignment.group_id, assignment.priority_override))
            .collect::<Vec<_>>();
        if let Err(error) = state
            .db
            .replace_provider_group_memberships(provider_id, &rows, util::now_ms())
            .await
        {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    }
    if !current.enabled {
        state.affinity.purge_provider(provider_id);
        state.provider_runtime.purge_provider(provider_id);
    }
    state.caches.upstream.invalidate();
    http::json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

async fn delete_provider(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) = parse_provider_id_with_suffix(path, "") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
    };

    let key_ids = state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
        .ok()
        .and_then(|snapshot| snapshot.keys_by_provider.get(&provider_id).cloned())
        .unwrap_or_default()
        .into_iter()
        .map(|key| key.id)
        .collect::<Vec<_>>();
    match state.db.delete_upstream_provider(provider_id).await {
        Ok(true) => {
            state.caches.upstream.invalidate();
            state.provider_runtime.purge_provider(provider_id);
            state.affinity.purge_provider(provider_id);
            for key_id in key_ids {
                state.quota.purge_key(key_id);
            }
            http::empty(StatusCode::NO_CONTENT)
        }
        Ok(false) => http::json_error(StatusCode::NOT_FOUND, "provider not found"),
        Err(error) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn reset_provider_circuit(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(provider_id) =
        parse_provider_id_with_prefix_and_suffix(path, "/api/v1/providers/", "/circuit/reset")
    else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid provider id");
    };
    let providers = match state.db.list_upstream_providers().await {
        Ok(value) => value,
        Err(error) => {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    if !providers.iter().any(|provider| provider.id == provider_id) {
        return http::json_error(StatusCode::NOT_FOUND, "provider not found");
    }
    state.provider_runtime.reset(provider_id);
    state.metrics.record_provider_breaker_reset();
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

async fn delete_endpoint(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(endpoint_id) = parse_id_suffix(path, "/api/v1/endpoints/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid endpoint id");
    };

    match state.db.delete_upstream_endpoint(endpoint_id).await {
        Ok(()) => {
            state.caches.upstream.invalidate();
            http::empty(StatusCode::NO_CONTENT)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
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
            let body_bytes =
                match Limited::new(resp.into_body(), ADMIN_UPSTREAM_TEST_BODY_MAX_BYTES)
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
                        );
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
                    upstream_key_to_json(
                        key,
                        state.upstream_key_health.snapshot(key.id, now_ms),
                        state.quota.snapshot(key.id, now_ms),
                    )
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

async fn delete_key(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path();
    let Some(key_id) = parse_id_suffix(path, "/api/v1/keys/") else {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid key id");
    };

    match state.db.delete_upstream_key(key_id).await {
        Ok(()) => {
            state.caches.upstream.invalidate();
            state.quota.purge_key(key_id);
            http::empty(StatusCode::NO_CONTENT)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
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
                    serde_json::json!({
                        "id": p.id,
                        "provider_id": p.provider_id,
                        "model_name": p.model_name,
                        "price_data": p.price.to_json(),
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
    if let Err(error) = PriceCard::from_json(&body.price_data) {
        return http::json_error(StatusCode::BAD_REQUEST, error);
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
    http::json(
        StatusCode::OK,
        &serde_json::json!({
            "id": p.id,
            "provider_id": p.provider_id,
            "model_name": p.model_name,
            "price_data": p.price.to_json(),
            "created_at_ms": p.created_at_ms,
            "updated_at_ms": p.updated_at_ms
        }),
    )
}

async fn system_config(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let config = &state.config;
    let payload = serde_json::json!({
        "build": build_info(),
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
            "usage_capture_bytes": config.usage_capture_bytes,
            "usage_capture_tail_bytes": config.usage_capture_tail_bytes,
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
    let (from_ms, to_ms) = match stats_window(period.as_str(), now_ms) {
        Some(window) => window,
        None => return http::json_error(StatusCode::BAD_REQUEST, "invalid period"),
    };

    let (agg, pricing_groups) = match tokio::join!(
        state.db.aggregate_stats_events_range(from_ms, to_ms),
        state.db.aggregate_pricing_usage_groups(from_ms, to_ms)
    ) {
        (Ok(agg), Ok(groups)) => (agg, groups),
        (Err(error), _) | (_, Err(error)) => {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let mut price_version_ids = pricing_groups
        .iter()
        .filter_map(|group| group.price_version_id)
        .collect::<Vec<_>>();
    price_version_ids.sort_unstable();
    price_version_ids.dedup();
    let price_versions = match state.db.list_price_versions(&price_version_ids).await {
        Ok(versions) => versions,
        Err(error) => {
            return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let pricing_versions_json = price_versions
        .into_iter()
        .map(|version| {
            serde_json::json!({
                "id": version.id,
                "card": version.card.to_json(),
            })
        })
        .collect::<Vec<_>>();
    let pricing_groups_json = pricing_groups
        .into_iter()
        .map(|group| {
            serde_json::json!({
                "price_version_id": group.price_version_id,
                "tier_index": group.price_tier_index,
                "request_count": group.request_count,
                "input_tokens": group.input_tokens,
                "output_tokens": group.output_tokens,
                "cache_read_input_tokens": group.cache_read_input_tokens,
                "cache_creation_input_tokens": group.cache_creation_input_tokens,
            })
        })
        .collect::<Vec<_>>();

    let requests_total = agg.request_success + agg.request_failed;
    let failed_total = agg.request_failed;
    let total_tokens = agg.input_tokens
        + agg.output_tokens
        + agg.cache_read_input_tokens
        + agg.cache_creation_input_tokens;
    let visible_output_tokens = agg
        .output_tokens
        .saturating_sub(agg.reasoning_output_tokens);
    let p95 = approximate_p95_latency_ms(&[
        agg.latency_lt_500ms,
        agg.latency_lt_1000ms,
        agg.latency_lt_2000ms,
        agg.latency_lt_5000ms,
        agg.latency_lt_15000ms,
        agg.latency_gte_15000ms,
    ]);
    let avg_latency_ms = if requests_total > 0 {
        agg.wait_time_ms / requests_total
    } else {
        0
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
    let server_status = state.system_status.snapshot();

    let payload = serde_json::json!({
        "period": period,
        "window": { "from_ms": from_ms, "to_ms": to_ms },
        "kpis": {
            "requests": requests_total,
            "failed": failed_total,
            "error_rate": error_rate,
            "p95_latency_ms": p95,
            "avg_latency_ms": avg_latency_ms
        },
        "service_health": {
            "providers_enabled": providers_enabled,
            "endpoints_enabled": endpoints_enabled,
            "upstream_keys_enabled": keys_enabled,
            "healthy": healthy,
            "warning": warning,
            "error": error
        },
        "server_status": server_status,
        "token_usage": {
            "total_tokens": total_tokens,
            "input_tokens": agg.input_tokens,
            "output_tokens": agg.output_tokens,
            "visible_output_tokens": visible_output_tokens,
            "cache_read_input_tokens": agg.cache_read_input_tokens,
            "cache_creation_input_tokens": agg.cache_creation_input_tokens,
            "reasoning_output_tokens": agg.reasoning_output_tokens,
            "usage_observed_requests": agg.usage_observed_requests
        },
        "pricing": {
            "versions": pricing_versions_json,
            "usage_groups": pricing_groups_json
        }
    });

    http::json(StatusCode::OK, &payload)
}

async fn stats_live(_req: Request<Incoming>, state: SharedState) -> HttpResponse {
    http::json(
        StatusCode::OK,
        &serde_json::json!({
            "metrics": state.metrics.live_snapshot(),
            "process": {
                "rss_bytes": util::process_resident_memory_bytes(),
                "now_ms": util::now_ms()
            }
        }),
    )
}

async fn list_logs(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    let page = query_i64(req.uri().query(), "page").unwrap_or(1);
    let page_size = query_i64(req.uri().query(), "page_size").unwrap_or(20);
    let query =
        query_string(req.uri().query(), "query").or_else(|| query_string(req.uri().query(), "q"));
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
    let usage_observed = match query_string(req.uri().query(), "usage_observed").as_deref() {
        Some("true") | Some("1") => Some(true),
        Some("false") | Some("0") => Some(false),
        Some(_) => return http::json_error(StatusCode::BAD_REQUEST, "invalid usage_observed"),
        None => None,
    };
    let reasoning_output_tokens_min = query_i64(req.uri().query(), "reasoning_output_tokens_min");
    let reasoning_output_tokens_max = query_i64(req.uri().query(), "reasoning_output_tokens_max");
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
    if let Some(status_class) = status_class
        && !(1..=5).contains(&status_class)
    {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid status_class");
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
    if let (Some(min_tokens), Some(max_tokens)) =
        (reasoning_output_tokens_min, reasoning_output_tokens_max)
        && min_tokens > max_tokens
    {
        return http::json_error(
            StatusCode::BAD_REQUEST,
            "reasoning_output_tokens_min must be <= reasoning_output_tokens_max",
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
        query,
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
        usage_observed,
        reasoning_output_tokens_min,
        reasoning_output_tokens_max,
        cache_read_input_tokens_min,
        cache_read_input_tokens_max,
        cache_creation_input_tokens_min,
        cache_creation_input_tokens_max,
    };

    match state.db.list_request_logs(page, page_size, &filter).await {
        Ok(rows) => {
            let mut price_version_ids = rows
                .iter()
                .filter_map(|row| row.price_version_id)
                .collect::<Vec<_>>();
            price_version_ids.sort_unstable();
            price_version_ids.dedup();
            let versions = match state.db.list_price_versions(&price_version_ids).await {
                Ok(versions) => versions,
                Err(error) => {
                    return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                }
            };
            let cards_by_id = versions
                .into_iter()
                .map(|version| (version.id, version.card.to_json()))
                .collect::<HashMap<_, _>>();
            let payload = rows
                .into_iter()
                .map(|row| request_log_to_json(row, &cards_by_id))
                .collect::<Vec<_>>();
            http::json(StatusCode::OK, &payload)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn request_log_to_json(
    row: crate::types::RequestLogRow,
    cards_by_id: &HashMap<i64, Value>,
) -> Value {
    let price_version_id = row.price_version_id;
    let tier_index = row.price_tier_index;
    let mut value = serde_json::to_value(row).unwrap_or(Value::Null);
    let Some(object) = value.as_object_mut() else {
        return value;
    };
    object.remove("price_version_id");
    object.remove("price_tier_index");
    let pricing = price_version_id.map(|version_id| {
        serde_json::json!({
            "price_version_id": version_id,
            "tier_index": tier_index,
            "card": cards_by_id.get(&version_id),
        })
    });
    object.insert("pricing".to_string(), pricing.unwrap_or(Value::Null));
    value
}

fn api_key_to_json(k: &ApiKeyAuth) -> Value {
    serde_json::json!({
        "id": k.id,
        "name": k.name,
        "enabled": k.enabled,
        "expires_at_ms": k.expires_at_ms,
        "log_enabled": k.log_enabled,
        "provider_groups": k.provider_groups
    })
}

fn provider_to_json(
    p: &UpstreamProvider,
    groups: &[crate::types::ProviderGroupMembership],
    health: ProviderHealthView,
    runtime: crate::provider_runtime::ProviderRuntimeView,
    affinity_sessions: usize,
) -> Value {
    serde_json::json!({
        "id": p.id,
        "name": p.name,
        "provider_type": p.provider_type,
        "enabled": p.enabled,
        "priority": p.priority,
        "weight": p.weight,
        "supports_include_usage": p.supports_include_usage,
        "websocket_enabled": p.websocket_enabled,
        "beta_features": p.beta_features,
        "key_selection_strategy": p.key_selection_strategy,
        "groups": groups,
        "max_attempts": p.max_attempts,
        "max_concurrency": p.max_concurrency,
        "circuit_breaker_enabled": p.circuit_breaker_enabled,
        "circuit_breaker_failure_threshold": p.circuit_breaker_failure_threshold,
        "circuit_breaker_open_ms": p.circuit_breaker_open_ms,
        "circuit_breaker_half_open_success_threshold": p.circuit_breaker_half_open_success_threshold,
        "health": health,
        "runtime": runtime,
        "affinity_sessions": affinity_sessions
    })
}

fn is_valid_provider_type(provider_type: &str) -> bool {
    ALLOWED_PROVIDER_TYPES.contains(&provider_type)
}

fn is_valid_key_selection_strategy(value: &str) -> bool {
    matches!(value, "round_robin" | "weighted")
}

fn normalize_beta_features(features: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for feature in features {
        let feature = feature.trim();
        if !matches!(feature, BETA_FEATURE_RESPONSES_HTTP_TO_WS) {
            continue;
        }
        if out.iter().any(|existing| existing == feature) {
            continue;
        }
        out.push(feature.to_string());
    }
    out
}

fn model_alias_to_json(alias: &ModelAlias, targets: Vec<ModelAliasTarget>) -> Value {
    serde_json::json!({
        "id": alias.id,
        "name": alias.name,
        "enabled": alias.enabled,
        "mode": alias.mode,
        "created_at_ms": alias.created_at_ms,
        "updated_at_ms": alias.updated_at_ms,
        "targets": targets,
    })
}

fn is_valid_alias_mode(value: &str) -> bool {
    matches!(value, "ordered" | "weighted")
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

fn upstream_key_to_json(
    k: &UpstreamKeyMeta,
    health: UpstreamKeyHealthView,
    quota: crate::provider_runtime::QuotaRuntimeView,
) -> Value {
    serde_json::json!({
        "id": k.id,
        "provider_id": k.provider_id,
        "name": k.name,
        "enabled": k.enabled,
        "priority": k.priority,
        "weight": k.weight,
        "health": health,
        "quota": quota
    })
}

fn approximate_p95_latency_ms(buckets: &[i64; 6]) -> Option<i64> {
    let total: i64 = buckets.iter().sum();
    if total <= 0 {
        return None;
    }
    let target = ((total as f64) * 0.95).ceil() as i64;
    let mut seen = 0_i64;
    let bounds = [500_i64, 1_000, 2_000, 5_000, 15_000, 15_000];
    for (idx, count) in buckets.iter().enumerate() {
        seen += *count;
        if seen >= target {
            return Some(bounds[idx]);
        }
    }
    Some(15_000)
}

fn parse_id_suffix(path: &str, prefix: &str) -> Option<i64> {
    let rest = path.strip_prefix(prefix)?;
    let rest = rest.trim_matches('/');
    // If there are more segments (like /endpoints), ignore here.
    let id_str = rest.split('/').next()?;
    id_str.parse::<i64>().ok()
}

fn parse_provider_id_with_suffix(path: &str, suffix: &str) -> Option<i64> {
    // /api/v1/providers/{id}{suffix}
    let rest = path.strip_prefix("/api/v1/providers/")?;
    let rest = rest.strip_suffix(suffix)?;
    let rest = rest.trim_matches('/');
    rest.parse::<i64>().ok()
}

fn parse_provider_id_with_prefix_and_suffix(path: &str, prefix: &str, suffix: &str) -> Option<i64> {
    let rest = path.strip_prefix(prefix)?;
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

fn normalize_base_url(input: &str) -> String {
    input.trim_end_matches('/').to_string()
}

fn generate_api_key_plaintext() -> String {
    let mut bytes = [0u8; 24];
    fastrand::fill(&mut bytes);
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    format!("cg_{}", raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_window_today_should_start_at_asia_shanghai_midnight() {
        let now_ms = 1_787_076_000_000; // 2026-08-19 02:00:00 +08:00
        let expected_start_ms = 1_787_068_800_000; // 2026-08-19 00:00:00 +08:00

        assert_eq!(
            stats_window("today", now_ms),
            Some((expected_start_ms, now_ms))
        );
    }

    #[test]
    fn stats_window_today_should_handle_asia_shanghai_date_before_utc_midnight() {
        let now_ms = 1_787_072_400_000; // 2026-08-19 01:00:00 +08:00
        let expected_start_ms = 1_787_068_800_000; // 2026-08-19 00:00:00 +08:00

        assert_eq!(
            stats_window("today", now_ms),
            Some((expected_start_ms, now_ms))
        );
    }

    #[test]
    fn stats_window_7h_should_use_exact_rolling_window() {
        let now_ms = 1_787_100_000_000;

        assert_eq!(
            stats_window("7h", now_ms),
            Some((now_ms - 7 * MILLIS_PER_HOUR, now_ms))
        );
    }

    #[test]
    fn provider_routing_validation_should_accept_boundary_values() {
        assert_eq!(validate_provider_routing(Some(0), Some(1)), Ok(()));
    }

    #[test]
    fn provider_routing_validation_should_reject_negative_priority() {
        assert_eq!(
            validate_provider_routing(Some(-1), Some(1)),
            Err("priority must be greater than or equal to 0")
        );
    }

    #[test]
    fn provider_routing_validation_should_reject_zero_weight() {
        assert_eq!(
            validate_provider_routing(Some(0), Some(0)),
            Err("weight must be greater than or equal to 1")
        );
    }

    #[test]
    fn provider_routing_validation_should_ignore_omitted_patch_fields() {
        assert_eq!(validate_provider_routing(None, None), Ok(()));
    }

    #[test]
    fn nullable_provider_concurrency_should_distinguish_missing_and_null() {
        let missing: PatchProviderReq =
            serde_json::from_value(serde_json::json!({})).expect("missing field");
        let cleared: PatchProviderReq =
            serde_json::from_value(serde_json::json!({ "max_concurrency": null }))
                .expect("nullable field");
        let limited: PatchProviderReq =
            serde_json::from_value(serde_json::json!({ "max_concurrency": 12 }))
                .expect("numeric field");

        assert_eq!(missing.max_concurrency, None);
        assert_eq!(cleared.max_concurrency, Some(None));
        assert_eq!(limited.max_concurrency, Some(Some(12)));
    }

    #[test]
    fn provider_delete_path_should_accept_exact_provider_id() {
        assert_eq!(
            parse_provider_id_with_suffix("/api/v1/providers/42", ""),
            Some(42)
        );
    }

    #[test]
    fn provider_delete_path_should_reject_nested_provider_resource() {
        assert_eq!(
            parse_provider_id_with_suffix("/api/v1/providers/42/endpoints", ""),
            None
        );
    }
}
