use super::*;
use crate::db::upstream_config::RoutePolicy;

pub(super) async fn read(state: SharedState, id: Option<i64>, runtime_only: bool) -> HttpResponse {
    let snap = match state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
    {
        Ok(s) => s,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let sync = match state.db.model_sync_states().await {
        Ok(s) => s,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let now = util::now_ms();
    let counts = state.affinity.binding_counts_by_provider(now);
    let mut out = Vec::new();
    for p in snap
        .providers
        .iter()
        .filter(|p| id.is_none_or(|id| p.id == id))
    {
        let endpoints = snap
            .endpoints_by_provider
            .get(&p.id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let keys = snap
            .keys_by_provider
            .get(&p.id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let health = summarize_provider_health(
            endpoints,
            keys,
            &state.endpoint_health,
            &state.upstream_key_health,
            now,
        );
        let mut provider = provider_to_json(
            p,
            &[],
            health,
            state.provider_runtime.snapshot(p, now),
            counts.get(&p.id).copied().unwrap_or_default(),
        );
        for field in ["priority", "weight", "groups"] {
            provider.as_object_mut().map(|v| v.remove(field));
        }
        provider["request_timeout_ms"] = serde_json::json!(p.request_timeout_ms);
        provider["endpoint_failover"] = serde_json::json!(p.endpoint_failover);
        provider["max_retries"] = serde_json::json!(p.max_attempts.clamp(1, 3) - 1);
        provider["routing_availability"] =
            serde_json::json!(crate::routing_availability::provider(&state, &snap, p));
        provider["endpoint_count"] = serde_json::json!(endpoints.len());
        provider["key_count"] = serde_json::json!(keys.len());
        provider["model_count"] = serde_json::json!(
            snap.provider_models_by_provider
                .get(&p.id)
                .map_or(0, HashMap::len)
        );
        provider["model_sync"] = sync.get(&p.id).cloned().unwrap_or(Value::Null);
        let mut value = serde_json::json!({"provider":provider,"endpoints":[],"keys":[]});
        if id.is_some() {
            let accounts = match state
                .db
                .list_codex_oauth_account_views(&state.config.master_key, p.id)
                .await
            {
                Ok(a) => a,
                Err(e) => {
                    return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
                }
            };
            value["endpoints"] = serde_json::json!(
                endpoints
                    .iter()
                    .map(|e| endpoint_to_json(e, state.endpoint_health.snapshot(e.id, now)))
                    .collect::<Vec<_>>()
            );
            value["keys"] = serde_json::json!(
                keys.iter()
                    .map(|k| {
                        let meta = crate::types::UpstreamKeyMeta {
                            id: k.id,
                            provider_id: k.provider_id,
                            name: k.name.clone(),
                            enabled: k.enabled,
                            priority: k.priority,
                            weight: k.weight,
                        };
                        let mut v = upstream_key_to_json(
                            &meta,
                            state.upstream_key_health.snapshot(k.id, now),
                            state.quota.snapshot(k.id, now),
                            p.provider_type == crate::codex_oauth::PROVIDER_TYPE,
                            accounts.get(&k.id),
                        );
                        v["configured"] = Value::Bool(true);
                        v["routing_availability"] = serde_json::json!(
                            crate::routing_availability::account(&state, &snap, p, k, None, false)
                        );
                        v
                    })
                    .collect::<Vec<_>>()
            );
        }
        if runtime_only {
            return http::json(
                StatusCode::OK,
                &serde_json::json!({"provider":{
                    "id":p.id,"name":p.name,"enabled":p.enabled,
                    "runtime":value["provider"]["runtime"],
                    "health":value["provider"]["health"],
                    "affinity_sessions":value["provider"]["affinity_sessions"],
                    "routing_availability":value["provider"]["routing_availability"]
                },"endpoints":value["endpoints"],"keys":value["keys"],"recent_errors":state.provider_runtime.recent_errors(p.id)}),
            );
        }
        // The connection resource carries persisted configuration and a short availability summary.
        // Detailed counters, circuit diagnostics and error text belong to /runtime.
        if let Some(provider) = value["provider"].as_object_mut() {
            for field in [
                "health",
                "runtime",
                "affinity_sessions",
                "max_attempts",
                "circuit_breaker_enabled",
                "circuit_breaker_failure_threshold",
                "circuit_breaker_open_ms",
                "circuit_breaker_half_open_success_threshold",
            ] {
                provider.remove(field);
            }
        }
        for name in ["endpoints", "keys"] {
            if let Some(items) = value[name].as_array_mut() {
                for item in items {
                    if let Some(health) = item["health"].as_object_mut() {
                        health.retain(|name, _| matches!(name.as_str(), "available" | "state"));
                    }
                    if name == "endpoints" {
                        item.as_object_mut().map(|item| item.remove("weight"));
                    }
                }
            }
        }
        out.push(value);
    }
    if id.is_some() {
        return out.first().map_or_else(
            || http::json_error(StatusCode::NOT_FOUND, "upstream not found"),
            |v| http::json(StatusCode::OK, v),
        );
    }
    http::json(StatusCode::OK, &out)
}

pub(super) async fn routes(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    if req.method() == Method::GET {
        return match state.db.route_policies().await {
            Ok(p) => {
                let mut p = p.into_values().collect::<Vec<_>>();
                p.sort_by(|a, b| a.model_name.cmp(&b.model_name));
                http::json(StatusCode::OK, &p)
            }
            Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
    }
    if req.method() == Method::DELETE {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reset {
            model_name: String,
        }
        let (_, body, _) =
            match http::read_json_limited::<Reset>(req, state.config.max_request_bytes).await {
                Ok(v) => v,
                Err(e) => return e,
            };
        if body.model_name.trim().is_empty() || body.model_name == "*" {
            return http::json_error(StatusCode::BAD_REQUEST, "default route cannot be removed");
        }
        return match state
            .db
            .adapt_legacy_route(&body.model_name, false, &[])
            .await
        {
            Ok(()) => {
                state.caches.upstream.invalidate();
                state.affinity.clear();
                http::json(StatusCode::OK, &serde_json::json!({"ok":true}))
            }
            Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
    }
    let (_, policy, _) =
        match http::read_json_limited::<RoutePolicy>(req, state.config.max_request_bytes).await {
            Ok(v) => v,
            Err(e) => return e,
        };
    if policy.model_name.trim().is_empty()
        || !matches!(policy.mode.as_str(), "ordered" | "weighted")
        || policy
            .targets
            .iter()
            .any(|t| t.priority < 0 || t.weight < 1)
        || policy
            .targets
            .iter()
            .map(|t| t.provider_id)
            .collect::<std::collections::HashSet<_>>()
            .len()
            != policy.targets.len()
    {
        return http::json_error(StatusCode::BAD_REQUEST, "invalid model route policy");
    }
    let providers = match state.db.list_upstream_providers().await {
        Ok(p) => p,
        Err(e) => return http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if policy
        .targets
        .iter()
        .any(|t| !providers.iter().any(|p| p.id == t.provider_id))
    {
        return http::json_error(StatusCode::BAD_REQUEST, "unknown upstream");
    }
    match state.db.save_route_policy(&policy).await {
        Ok(()) => {
            state.caches.upstream.invalidate();
            state.affinity.clear();
            http::json(StatusCode::OK, &policy)
        }
        Err(e) => http::json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
