//! Effective routing state shared by management views and request admission.
use crate::{
    cache::upstream_cache::UpstreamSnapshot,
    state::SharedState,
    types::{UpstreamKey, UpstreamProvider},
};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub(crate) struct RoutingAvailability {
    pub available: bool,
    pub reason: Option<&'static str>,
    pub retry_at_ms: Option<i64>,
}
impl RoutingAvailability {
    fn unavailable(reason: &'static str) -> Self {
        Self {
            available: false,
            reason: Some(reason),
            retry_at_ms: None,
        }
    }
    fn available() -> Self {
        Self {
            available: true,
            reason: None,
            retry_at_ms: None,
        }
    }
}

pub(crate) fn account(
    state: &SharedState,
    snap: &UpstreamSnapshot,
    provider: &UpstreamProvider,
    key: &UpstreamKey,
    model: Option<&str>,
    owns_capacity: bool,
) -> RoutingAvailability {
    let now = crate::util::now_ms();
    if !provider.enabled {
        return RoutingAvailability::unavailable("provider_disabled");
    }
    if !key.enabled {
        return RoutingAvailability::unavailable("account_disabled");
    }
    if provider.provider_type == crate::codex_oauth::PROVIDER_TYPE {
        let Some(account) = snap.codex_oauth_by_key.get(&key.id) else {
            return RoutingAvailability::unavailable("reauth_required");
        };
        if account.auth_status != crate::codex_oauth::AUTH_STATUS_ACTIVE {
            return RoutingAvailability::unavailable(
                if account.auth_status == crate::codex_oauth::AUTH_STATUS_FORBIDDEN {
                    "account_forbidden"
                } else {
                    "reauth_required"
                },
            );
        }
        if !account.is_routable(now) {
            return RoutingAvailability::unavailable("quota_unavailable");
        }
    }
    if !state.quota.is_available(key.id, now) {
        return RoutingAvailability::unavailable("quota_unavailable");
    }
    let allows = |name: &str| {
        snap.key_allows_model(key.id, name)
            && snap.is_model_globally_enabled(name)
            && snap
                .provider_models_by_provider
                .get(&provider.id)
                .is_none_or(|models| models.get(name).is_some_and(|model| model.is_active()))
            && snap.routes_by_model.get(name).is_none_or(|route| {
                !route.enabled
                    || route.provider_ids.is_empty()
                    || route.provider_ids.contains(&provider.id)
            })
    };
    let model_available = match model {
        Some(name) => allows(name),
        None => match snap.provider_models_by_provider.get(&provider.id) {
            Some(models) => models.keys().any(|name| allows(name)),
            None => snap
                .key_models_by_key
                .get(&key.id)
                .is_none_or(|models| models.is_empty() || models.keys().any(|name| allows(name))),
        },
    };
    if !model_available {
        return RoutingAvailability::unavailable("no_allowed_models");
    }
    let runtime = state.provider_runtime.snapshot(provider, now);
    if runtime.state == crate::health::CircuitState::Open {
        return RoutingAvailability::unavailable("provider_circuit_open");
    }
    if !owns_capacity && !runtime.available {
        return RoutingAvailability::unavailable(
            if runtime.state == crate::health::CircuitState::HalfOpen {
                "recovery_probe_in_progress"
            } else {
                "provider_capacity_exhausted"
            },
        );
    }
    if !state.upstream_key_health.snapshot(key.id, now).available {
        return RoutingAvailability::unavailable("account_unhealthy");
    }
    if !snap
        .endpoints_by_provider
        .get(&provider.id)
        .is_some_and(|endpoints| {
            endpoints.iter().any(|endpoint| {
                endpoint.enabled && state.endpoint_health.snapshot(endpoint.id, now).available
            })
        })
    {
        return RoutingAvailability::unavailable("no_available_endpoint");
    }
    RoutingAvailability::available()
}

pub(crate) fn provider(
    state: &SharedState,
    snap: &UpstreamSnapshot,
    provider: &UpstreamProvider,
) -> RoutingAvailability {
    if !provider.enabled {
        return RoutingAvailability::unavailable("provider_disabled");
    }
    let mut failures = Vec::new();
    if let Some(keys) = snap.keys_by_provider.get(&provider.id) {
        for key in keys {
            let status = account(state, snap, provider, key, None, false);
            if status.available {
                return status;
            }
            if key.enabled {
                failures.push(status);
            }
        }
    }
    let mut result = failures
        .into_iter()
        .next()
        .unwrap_or_else(|| RoutingAvailability::unavailable("no_available_accounts"));
    result.retry_at_ms = provider_retry_at(state, snap, provider, None);
    result
}

/// Earliest full path through a provider; every blocking layer on that path must recover.
pub(crate) fn provider_retry_at(
    state: &SharedState,
    snap: &UpstreamSnapshot,
    provider: &UpstreamProvider,
    model: Option<&str>,
) -> Option<i64> {
    let now = crate::util::now_ms();
    let runtime = state.provider_runtime.snapshot(provider, now);
    let endpoint_at = snap
        .endpoints_by_provider
        .get(&provider.id)?
        .iter()
        .filter(|item| item.enabled)
        .map(|item| {
            state
                .endpoint_health
                .snapshot(item.id, now)
                .open_until_ms
                .unwrap_or(now)
        })
        .min()?;
    snap.keys_by_provider
        .get(&provider.id)?
        .iter()
        .filter(|key| key.enabled && model.is_none_or(|name| snap.key_allows_model(key.id, name)))
        .filter_map(|key| {
            let health = state.upstream_key_health.snapshot(key.id, now);
            let quota = state.quota.snapshot(key.id, now);
            let until = [
                runtime.open_until_ms,
                health.open_until_ms,
                quota.cooldown_until_ms,
                quota.blocked_until_ms(),
                snap.codex_oauth_by_key
                    .get(&key.id)
                    .and_then(|account| account.quota.as_ref())
                    .and_then(|quota| quota.blocked_until_ms(now)),
                Some(endpoint_at),
            ]
            .into_iter()
            .flatten()
            .max()?;
            Some(until)
        })
        .min()
        .filter(|until| *until > now)
}

pub(crate) async fn health_counts(state: &SharedState) -> Result<(u32, u32, u32), String> {
    let snap = state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await?;
    let mut counts = (0, 0, 0);
    for item in snap.providers.iter().filter(|item| item.enabled) {
        let status = provider(state, &snap, item);
        if status.available {
            if state
                .provider_runtime
                .snapshot(item, crate::util::now_ms())
                .state
                == crate::health::CircuitState::HalfOpen
            {
                counts.1 += 1;
            } else {
                counts.0 += 1;
            }
        } else if matches!(
            status.reason,
            Some("provider_capacity_exhausted" | "recovery_probe_in_progress")
        ) {
            counts.1 += 1;
        } else {
            counts.2 += 1;
        }
    }
    Ok(counts)
}
