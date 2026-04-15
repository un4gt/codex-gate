use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use parking_lot::RwLock;
use tokio::sync::Mutex as AsyncMutex;

use crate::cache::policy::UpstreamCachePolicy;
use crate::db::Database;
use crate::types::{ModelPriceData, ModelRoute, UpstreamEndpoint, UpstreamKey, UpstreamProvider};

#[derive(Clone, Debug)]
pub struct UpstreamSnapshot {
    pub providers: Vec<UpstreamProvider>,
    pub keys_by_provider: HashMap<i64, Vec<UpstreamKey>>,
    pub endpoints_by_provider: HashMap<i64, Vec<UpstreamEndpoint>>,
    pub routes_by_model: HashMap<String, ModelRoute>,
    pub provider_models_by_provider: HashMap<i64, HashMap<String, bool>>,
    pub alias_to_provider_model: HashMap<String, ProviderModelAliasTarget>,
    pub key_models_by_key: HashMap<i64, HashMap<String, bool>>,
    pub globally_disabled_models: HashSet<String>,
    pub provider_prices_by_model: HashMap<i64, HashMap<String, ModelPriceData>>,
    pub global_prices_by_model: HashMap<String, ModelPriceData>,
}

impl UpstreamSnapshot {
    pub fn find_price(&self, provider_id: i64, model_name: &str) -> Option<ModelPriceData> {
        self.provider_prices_by_model
            .get(&provider_id)
            .and_then(|items| items.get(model_name))
            .cloned()
            .or_else(|| self.global_prices_by_model.get(model_name).cloned())
    }

    pub fn is_model_globally_enabled(&self, model_name: &str) -> bool {
        !self.globally_disabled_models.contains(model_name)
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
        let providers = db
            .list_upstream_providers()
            .await
            .map_err(|e| e.to_string())?;
        let upstream_keys = db
            .list_upstream_keys(master_key)
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

        let mut provider_models_by_provider: HashMap<i64, HashMap<String, bool>> = HashMap::new();
        let mut alias_to_provider_model: HashMap<String, ProviderModelAliasTarget> = HashMap::new();
        for model in provider_models {
            provider_models_by_provider
                .entry(model.provider_id)
                .or_default()
                .insert(model.upstream_model.clone(), model.enabled);

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
                        enabled: model.enabled,
                    },
                );
            }
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

        let mut provider_prices_by_model: HashMap<i64, HashMap<String, ModelPriceData>> =
            HashMap::new();
        let mut global_prices_by_model = HashMap::new();
        for price in prices {
            if let Some(provider_id) = price.provider_id {
                provider_prices_by_model
                    .entry(provider_id)
                    .or_default()
                    .insert(price.model_name.clone(), price.price.clone());
            } else {
                global_prices_by_model.insert(price.model_name.clone(), price.price.clone());
            }
        }

        Ok(Arc::new(UpstreamSnapshot {
            providers,
            keys_by_provider,
            endpoints_by_provider,
            routes_by_model,
            provider_models_by_provider,
            alias_to_provider_model,
            key_models_by_key,
            globally_disabled_models,
            provider_prices_by_model,
            global_prices_by_model,
        }))
    }
}
