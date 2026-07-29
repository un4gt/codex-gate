use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use parking_lot::RwLock;
use tokio::sync::Mutex as AsyncMutex;

use crate::cache::policy::UpstreamCachePolicy;
use crate::codex_oauth::CodexOAuthRoutingAccount;
use crate::db::Database;
use crate::pricing::PriceVersion;
use crate::types::{
    ModelAlias, ModelAliasTarget, ModelRoute, ProviderGroupMembership, UpstreamEndpoint,
    UpstreamKey, UpstreamProvider,
};

#[derive(Clone, Debug, Default)]
pub struct UpstreamSnapshot {
    pub providers: Vec<UpstreamProvider>,
    pub keys_by_provider: HashMap<i64, Vec<UpstreamKey>>,
    pub endpoints_by_provider: HashMap<i64, Vec<UpstreamEndpoint>>,
    pub groups_by_provider: HashMap<i64, Vec<ProviderGroupMembership>>,
    pub routes_by_model: HashMap<String, ModelRoute>,
    pub provider_models_by_provider: HashMap<i64, HashMap<String, ProviderModelState>>,
    pub alias_to_provider_model: HashMap<String, ProviderModelAliasTarget>,
    pub model_aliases_by_name: HashMap<String, ModelAlias>,
    pub alias_targets_by_alias: HashMap<i64, Vec<ModelAliasTarget>>,
    pub key_models_by_key: HashMap<i64, HashMap<String, bool>>,
    pub globally_disabled_models: HashSet<String>,
    pub codex_oauth_by_key: HashMap<i64, CodexOAuthRoutingAccount>,
    pub model_registry_ids: Vec<String>,
    pub provider_prices_by_model: HashMap<i64, HashMap<String, PriceVersion>>,
    pub global_prices_by_model: HashMap<String, PriceVersion>,
}

impl UpstreamSnapshot {
    pub fn find_price(&self, provider_id: i64, model_name: &str) -> Option<PriceVersion> {
        self.provider_prices_by_model
            .get(&provider_id)
            .and_then(|items| items.get(model_name))
            .cloned()
            .or_else(|| self.global_prices_by_model.get(model_name).cloned())
    }

    pub fn find_price_for_request(
        &self,
        provider_id: i64,
        requested_model: &str,
        upstream_model: &str,
    ) -> Option<PriceVersion> {
        self.find_price(provider_id, upstream_model).or_else(|| {
            if requested_model == upstream_model {
                None
            } else {
                self.find_price(provider_id, requested_model)
            }
        })
    }

    pub fn is_model_globally_enabled(&self, model_name: &str) -> bool {
        !self.globally_disabled_models.contains(model_name)
    }

    pub fn provider_model_state(
        &self,
        provider_id: i64,
        upstream_model: &str,
    ) -> Option<ProviderModelState> {
        self.provider_models_by_provider
            .get(&provider_id)
            .and_then(|models| models.get(upstream_model))
            .copied()
    }

    pub fn key_allows_model(&self, key_id: i64, upstream_model: &str) -> bool {
        match self.key_models_by_key.get(&key_id) {
            Some(models) => models.get(upstream_model).copied().unwrap_or(false),
            None => true,
        }
    }

    fn rebuild_model_registry_ids(&mut self) {
        let mut ids = BTreeSet::new();
        let mut active_targets: HashMap<i64, HashSet<String>> = HashMap::new();

        for provider in self.providers.iter().filter(|provider| provider.enabled) {
            let Some(models) = self.provider_models_by_provider.get(&provider.id) else {
                continue;
            };
            let Some(keys) = self.keys_by_provider.get(&provider.id) else {
                continue;
            };
            for (upstream_model, state) in models {
                if !state.is_active() || !self.is_model_globally_enabled(upstream_model) {
                    continue;
                }
                if !keys.iter().any(|key| {
                    key.enabled
                        && self.key_allows_model(key.id, upstream_model)
                        && (provider.provider_type != crate::codex_oauth::PROVIDER_TYPE
                            || self
                                .codex_oauth_by_key
                                .get(&key.id)
                                .is_some_and(|account| account.is_routable(crate::util::now_ms())))
                }) {
                    continue;
                }
                ids.insert(upstream_model.clone());
                active_targets
                    .entry(provider.id)
                    .or_default()
                    .insert(upstream_model.clone());
            }
        }

        for alias in self.model_aliases_by_name.values() {
            if !alias.enabled || !self.is_model_globally_enabled(&alias.name) {
                continue;
            }
            let Some(targets) = self.alias_targets_by_alias.get(&alias.id) else {
                continue;
            };
            if targets.iter().any(|target| {
                target.enabled
                    && self.is_model_globally_enabled(&target.upstream_model)
                    && active_targets
                        .get(&target.provider_id)
                        .is_some_and(|models| models.contains(&target.upstream_model))
            }) {
                ids.insert(alias.name.clone());
            }
        }

        for (alias, target) in &self.alias_to_provider_model {
            if target.enabled
                && self.is_model_globally_enabled(alias)
                && self.is_model_globally_enabled(&target.upstream_model)
                && active_targets
                    .get(&target.provider_id)
                    .is_some_and(|models| models.contains(&target.upstream_model))
            {
                ids.insert(alias.clone());
            }
        }

        self.model_registry_ids = ids.into_iter().collect();
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProviderModelState {
    pub enabled: bool,
    pub available: bool,
    pub responses_via_chat_enabled: bool,
}

impl ProviderModelState {
    pub fn is_active(&self) -> bool {
        self.enabled && self.available
    }
}

#[derive(Clone, Debug)]
pub struct ProviderModelAliasTarget {
    pub provider_id: i64,
    pub upstream_model: String,
    pub enabled: bool,
}

#[derive(Clone)]
struct UpstreamCached {
    value: Arc<UpstreamSnapshot>,
    loaded_at: Instant,
}

pub struct UpstreamCache {
    policy: UpstreamCachePolicy,
    state: RwLock<Option<UpstreamCached>>,
    refresh_lock: AsyncMutex<()>,
}

impl UpstreamCache {
    pub fn new(policy: UpstreamCachePolicy) -> Self {
        Self {
            policy,
            state: RwLock::new(None),
            refresh_lock: AsyncMutex::new(()),
        }
    }

    pub async fn get(
        &self,
        db: &Database,
        master_key: &str,
    ) -> Result<Arc<UpstreamSnapshot>, String> {
        if let Some(hit) = self.get_fresh() {
            return Ok(hit);
        }

        let stale = self.get_stale_within_grace();
        let _refresh_guard = self.refresh_lock.lock().await;

        if let Some(hit) = self.get_fresh() {
            return Ok(hit);
        }

        match self.load_snapshot(db, master_key).await {
            Ok(snapshot) => {
                self.set_snapshot(snapshot.clone());
                Ok(snapshot)
            }
            Err(error) => stale.ok_or(error),
        }
    }

    pub fn invalidate(&self) {
        *self.state.write() = None;
    }

    fn get_fresh(&self) -> Option<Arc<UpstreamSnapshot>> {
        let guard = self.state.read();
        let hit = guard.as_ref()?;
        if hit.loaded_at.elapsed() > self.policy.ttl {
            return None;
        }
        Some(hit.value.clone())
    }

    fn get_stale_within_grace(&self) -> Option<Arc<UpstreamSnapshot>> {
        let guard = self.state.read();
        let hit = guard.as_ref()?;
        if hit.loaded_at.elapsed() > self.policy.ttl.saturating_add(self.policy.stale_grace) {
            return None;
        }
        Some(hit.value.clone())
    }

    fn set_snapshot(&self, snapshot: Arc<UpstreamSnapshot>) {
        *self.state.write() = Some(UpstreamCached {
            value: snapshot,
            loaded_at: Instant::now(),
        });
    }

    async fn load_snapshot(
        &self,
        db: &Database,
        master_key: &str,
    ) -> Result<Arc<UpstreamSnapshot>, String> {
        let (providers, groups_by_provider) = tokio::try_join!(
            db.list_upstream_providers(),
            db.list_provider_group_memberships(),
        )
        .map_err(|e| e.to_string())?;
        let upstream_keys = db
            .list_upstream_keys(master_key)
            .await
            .map_err(|e| e.to_string())?;
        let codex_accounts = db
            .list_codex_oauth_accounts(master_key)
            .await
            .map_err(|e| e.to_string())?;
        let endpoints = db
            .list_upstream_endpoints()
            .await
            .map_err(|e| e.to_string())?;
        let routes = db.list_model_routes().await.map_err(|e| e.to_string())?;
        let provider_models = db
            .list_all_provider_models()
            .await
            .map_err(|e| e.to_string())?;
        let model_aliases = db.list_model_aliases().await.map_err(|e| e.to_string())?;
        let model_alias_targets = db
            .list_model_alias_targets(None)
            .await
            .map_err(|e| e.to_string())?;
        let gateway_model_policies = db
            .list_gateway_model_policies()
            .await
            .map_err(|e| e.to_string())?;
        let key_models = db
            .list_all_upstream_key_models()
            .await
            .map_err(|e| e.to_string())?;
        let prices = db
            .list_latest_model_prices()
            .await
            .map_err(|e| e.to_string())?;

        let mut keys_by_provider: HashMap<i64, Vec<UpstreamKey>> = HashMap::new();
        for key in upstream_keys {
            keys_by_provider
                .entry(key.provider_id)
                .or_default()
                .push(key);
        }
        let codex_oauth_by_key = codex_accounts
            .into_iter()
            .map(|account| (account.upstream_key_id, account.routing()))
            .collect::<HashMap<_, _>>();
        let mut endpoints_by_provider: HashMap<i64, Vec<UpstreamEndpoint>> = HashMap::new();
        for endpoint in endpoints {
            endpoints_by_provider
                .entry(endpoint.provider_id)
                .or_default()
                .push(endpoint);
        }

        let mut routes_by_model = HashMap::new();
        for route in routes {
            routes_by_model.insert(route.model_name.clone(), route);
        }

        let mut provider_models_by_provider: HashMap<i64, HashMap<String, ProviderModelState>> =
            HashMap::new();
        let mut alias_to_provider_model: HashMap<String, ProviderModelAliasTarget> = HashMap::new();
        for model in provider_models {
            provider_models_by_provider
                .entry(model.provider_id)
                .or_default()
                .insert(
                    model.upstream_model.clone(),
                    ProviderModelState {
                        enabled: model.enabled,
                        available: model.available,
                        responses_via_chat_enabled: model.responses_via_chat_enabled,
                    },
                );

            if let Some(alias) = model
                .alias
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                alias_to_provider_model.insert(
                    alias.to_string(),
                    ProviderModelAliasTarget {
                        provider_id: model.provider_id,
                        upstream_model: model.upstream_model.clone(),
                        enabled: model.enabled && model.available,
                    },
                );
            }
        }

        let mut model_aliases_by_name = HashMap::new();
        for alias in model_aliases {
            model_aliases_by_name.insert(alias.name.clone(), alias);
        }

        let mut alias_targets_by_alias: HashMap<i64, Vec<ModelAliasTarget>> = HashMap::new();
        for target in model_alias_targets {
            alias_targets_by_alias
                .entry(target.alias_id)
                .or_default()
                .push(target);
        }
        for targets in alias_targets_by_alias.values_mut() {
            targets.sort_by(|left, right| {
                left.priority
                    .cmp(&right.priority)
                    .then_with(|| right.weight.cmp(&left.weight))
                    .then_with(|| left.id.cmp(&right.id))
            });
        }

        let mut key_models_by_key: HashMap<i64, HashMap<String, bool>> = HashMap::new();
        for model in key_models {
            key_models_by_key
                .entry(model.upstream_key_id)
                .or_default()
                .insert(model.model_name, model.enabled);
        }

        let globally_disabled_models = gateway_model_policies
            .into_iter()
            .filter(|policy| !policy.enabled)
            .map(|policy| policy.model_name)
            .collect::<HashSet<_>>();

        let mut provider_prices_by_model: HashMap<i64, HashMap<String, PriceVersion>> =
            HashMap::new();
        let mut global_prices_by_model = HashMap::new();
        for price in prices {
            if let Some(provider_id) = price.provider_id {
                provider_prices_by_model
                    .entry(provider_id)
                    .or_default()
                    .insert(
                        price.model_name.clone(),
                        PriceVersion {
                            id: price.id,
                            card: price.price.clone(),
                        },
                    );
            } else {
                global_prices_by_model.insert(
                    price.model_name.clone(),
                    PriceVersion {
                        id: price.id,
                        card: price.price.clone(),
                    },
                );
            }
        }

        let mut snapshot = UpstreamSnapshot {
            providers,
            keys_by_provider,
            endpoints_by_provider,
            groups_by_provider,
            routes_by_model,
            provider_models_by_provider,
            alias_to_provider_model,
            model_aliases_by_name,
            alias_targets_by_alias,
            key_models_by_key,
            globally_disabled_models,
            codex_oauth_by_key,
            model_registry_ids: Vec::new(),
            provider_prices_by_model,
            global_prices_by_model,
        };
        snapshot.rebuild_model_registry_ids();
        Ok(Arc::new(snapshot))
    }
}

#[cfg(test)]
mod tests {
    use super::{ProviderModelAliasTarget, ProviderModelState, UpstreamSnapshot};
    use crate::pricing::{PriceCard, PriceRates, PriceVersion};
    use crate::types::{ModelAlias, ModelAliasTarget, UpstreamKey, UpstreamProvider};
    use rust_decimal::Decimal;
    use std::collections::{HashMap, HashSet};

    fn price(tag: i64) -> PriceVersion {
        PriceVersion {
            id: tag,
            card: PriceCard {
                base: PriceRates {
                    input: Some(Decimal::new(tag, 0)),
                    ..PriceRates::default()
                },
                tiers: Vec::new(),
            },
        }
    }

    fn snapshot_with_prices() -> UpstreamSnapshot {
        let mut provider_prices_by_model = HashMap::new();
        provider_prices_by_model
            .insert(7, HashMap::from([("upstream-model".to_string(), price(7))]));

        let global_prices_by_model = HashMap::from([("gateway-alias".to_string(), price(3))]);

        UpstreamSnapshot {
            providers: Vec::new(),
            keys_by_provider: HashMap::new(),
            endpoints_by_provider: HashMap::new(),
            groups_by_provider: HashMap::new(),
            routes_by_model: HashMap::new(),
            provider_models_by_provider: HashMap::new(),
            alias_to_provider_model: HashMap::new(),
            model_aliases_by_name: HashMap::new(),
            alias_targets_by_alias: HashMap::new(),
            key_models_by_key: HashMap::new(),
            globally_disabled_models: HashSet::new(),
            codex_oauth_by_key: HashMap::new(),
            model_registry_ids: Vec::new(),
            provider_prices_by_model,
            global_prices_by_model,
        }
    }

    fn provider(id: i64, enabled: bool) -> UpstreamProvider {
        UpstreamProvider {
            id,
            name: format!("provider-{id}"),
            provider_type: "openai_compatible".to_string(),
            enabled,
            priority: 100,
            weight: 1,
            supports_include_usage: true,
            websocket_enabled: false,
            beta_features: Vec::new(),
            key_selection_strategy: "weighted".to_string(),
            max_attempts: 2,
            max_concurrency: None,
            circuit_breaker_enabled: true,
            circuit_breaker_failure_threshold: 3,
            circuit_breaker_open_ms: 30_000,
            circuit_breaker_half_open_success_threshold: 2,
        }
    }

    fn key(id: i64, provider_id: i64, enabled: bool) -> UpstreamKey {
        UpstreamKey {
            id,
            provider_id,
            name: format!("key-{id}"),
            secret: "secret".to_string(),
            enabled,
            priority: 100,
            weight: 1,
        }
    }

    fn active_model(responses_via_chat_enabled: bool) -> ProviderModelState {
        ProviderModelState {
            enabled: true,
            available: true,
            responses_via_chat_enabled,
        }
    }

    #[test]
    fn find_price_for_request_prefers_upstream_model_price() {
        let snapshot = snapshot_with_prices();

        let found = snapshot
            .find_price_for_request(7, "gateway-alias", "upstream-model")
            .and_then(|item| item.card.base.input);

        assert_eq!(found, Some(Decimal::new(7, 0)));
    }

    #[test]
    fn find_price_for_request_falls_back_to_requested_model_price() {
        let mut snapshot = snapshot_with_prices();
        snapshot.provider_prices_by_model.clear();

        let found = snapshot
            .find_price_for_request(7, "gateway-alias", "upstream-model")
            .and_then(|item| item.card.base.input);

        assert_eq!(found, Some(Decimal::new(3, 0)));
    }

    #[test]
    fn model_registry_should_include_active_models_and_aliases() {
        let mut snapshot = UpstreamSnapshot::default();
        snapshot.providers.push(provider(7, true));
        snapshot.keys_by_provider.insert(7, vec![key(70, 7, true)]);
        snapshot.provider_models_by_provider.insert(
            7,
            HashMap::from([("kimi-k3".to_string(), active_model(true))]),
        );
        snapshot.alias_to_provider_model.insert(
            "kimi-latest".to_string(),
            ProviderModelAliasTarget {
                provider_id: 7,
                upstream_model: "kimi-k3".to_string(),
                enabled: true,
            },
        );
        snapshot.model_aliases_by_name.insert(
            "coding-default".to_string(),
            ModelAlias {
                id: 11,
                name: "coding-default".to_string(),
                enabled: true,
                mode: "priority".to_string(),
                created_at_ms: 1,
                updated_at_ms: 1,
            },
        );
        snapshot.alias_targets_by_alias.insert(
            11,
            vec![ModelAliasTarget {
                id: 12,
                alias_id: 11,
                provider_id: 7,
                upstream_model: "kimi-k3".to_string(),
                enabled: true,
                priority: 10,
                weight: 1,
                created_at_ms: 1,
                updated_at_ms: 1,
            }],
        );

        snapshot.rebuild_model_registry_ids();

        assert_eq!(
            snapshot.model_registry_ids,
            vec![
                "coding-default".to_string(),
                "kimi-k3".to_string(),
                "kimi-latest".to_string(),
            ]
        );
    }

    #[test]
    fn model_registry_should_require_an_enabled_model_capable_key() {
        let mut snapshot = UpstreamSnapshot::default();
        snapshot.providers.push(provider(7, true));
        snapshot.keys_by_provider.insert(7, vec![key(70, 7, true)]);
        snapshot.provider_models_by_provider.insert(
            7,
            HashMap::from([("kimi-k3".to_string(), active_model(true))]),
        );
        snapshot
            .key_models_by_key
            .insert(70, HashMap::from([("other-model".to_string(), true)]));

        snapshot.rebuild_model_registry_ids();

        assert!(snapshot.model_registry_ids.is_empty());
    }

    #[test]
    fn model_registry_should_ignore_routes_protocol_and_runtime_state() {
        let mut snapshot = UpstreamSnapshot::default();
        snapshot.providers.push(provider(7, true));
        snapshot.keys_by_provider.insert(7, vec![key(70, 7, true)]);
        snapshot.provider_models_by_provider.insert(
            7,
            HashMap::from([("kimi-k3".to_string(), active_model(false))]),
        );

        snapshot.rebuild_model_registry_ids();

        assert_eq!(snapshot.model_registry_ids, vec!["kimi-k3".to_string()]);
    }
}
