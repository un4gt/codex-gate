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
}
impl RoutingAvailability {
    fn unavailable(reason: &'static str) -> Self {
        Self {
            available: false,
            reason: Some(reason),
        }
    }
    fn available() -> Self {
        Self {
            available: true,
            reason: None,
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
        return RoutingAvailability::unavailable("provider_capacity_exhausted");
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
    if snap.keys_by_provider.get(&provider.id).is_some_and(|keys| {
        keys.iter()
            .any(|key| account(state, snap, provider, key, None, false).available)
    }) {
        RoutingAvailability::available()
    } else {
        RoutingAvailability::unavailable("no_available_accounts")
    }
}
