use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::RwLock;

use crate::crypto;
use crate::db::Database;
use crate::types::{
    ApiKeyAuth, ModelPriceData, ModelRoute, UpstreamEndpoint, UpstreamKey, UpstreamProvider,
};

#[derive(Clone)]
pub struct Caches {
    pub api_keys: Arc<ApiKeyCache>,
    pub upstream: Arc<UpstreamCache>,
}

impl Caches {
    pub fn new(api_key_ttl: Duration, upstream_ttl: Duration) -> Self {
        Self {
            api_keys: Arc::new(ApiKeyCache::new(api_key_ttl)),
            upstream: Arc::new(UpstreamCache::new(upstream_ttl)),
        }
    }
}

struct Cached<T> {
    value: T,
    loaded_at: Instant,
}

pub struct ApiKeyCache {
    ttl: Duration,
    by_hash: RwLock<HashMap<String, Cached<ApiKeyAuth>>>,
}

impl ApiKeyCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            by_hash: RwLock::new(HashMap::new()),
        }
    }

    pub async fn validate(
        &self,
        db: &Database,
        master_key: &str,
        api_key_plaintext: &str,
        now_ms: i64,
    ) -> Result<Option<ApiKeyAuth>, String> {
        let key_hash = crypto::hash_api_key(master_key, api_key_plaintext);

        if let Some(hit) = self.get_fresh(&key_hash) {
            return Ok(Self::check_live(hit, now_ms));
        }

        let from_db = db
            .find_api_key_by_hash(&key_hash)
            .await
            .map_err(|e| e.to_string())?;

        if let Some(ref row) = from_db {
            let mut guard = self.by_hash.write();
            guard.insert(
                key_hash.clone(),
                Cached {
                    value: row.clone(),
                    loaded_at: Instant::now(),
                },
            );
        }

        Ok(from_db.and_then(|v| Self::check_live(v, now_ms)))
    }

    fn get_fresh(&self, key_hash: &str) -> Option<ApiKeyAuth> {
        let guard = self.by_hash.read();
        let hit = guard.get(key_hash)?;
        if hit.loaded_at.elapsed() > self.ttl {
            return None;
        }
        Some(hit.value.clone())
    }

    fn check_live(mut api_key: ApiKeyAuth, now_ms: i64) -> Option<ApiKeyAuth> {
        if !api_key.enabled {
            return None;
        }
        if let Some(expires_at) = api_key.expires_at_ms {
            if expires_at <= now_ms {
                return None;
            }
        }
        api_key.enabled = true;
        Some(api_key)
    }

    pub fn invalidate_all(&self) {
        self.by_hash.write().clear();
    }
}

#[derive(Clone, Debug)]
pub struct UpstreamSnapshot {
    pub providers: Vec<UpstreamProvider>,
    pub keys_by_provider: HashMap<i64, Vec<UpstreamKey>>,
    pub endpoints_by_provider: HashMap<i64, Vec<UpstreamEndpoint>>,
    pub routes_by_model: HashMap<String, ModelRoute>,
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
}

pub struct UpstreamCache {
    ttl: Duration,
    state: RwLock<Option<Cached<Arc<UpstreamSnapshot>>>>,
}

impl UpstreamCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            state: RwLock::new(None),
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
        for ep in endpoints {
            endpoints_by_provider
                .entry(ep.provider_id)
                .or_default()
                .push(ep);
        }

        let mut routes_by_model = HashMap::new();
        for route in routes {
            routes_by_model.insert(route.model_name.clone(), route);
        }

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

        let snap = Arc::new(UpstreamSnapshot {
            providers,
            keys_by_provider,
            endpoints_by_provider,
            routes_by_model,
            provider_prices_by_model,
            global_prices_by_model,
        });

        let mut guard = self.state.write();
        *guard = Some(Cached {
            value: snap.clone(),
            loaded_at: Instant::now(),
        });

        Ok(snap)
    }

    fn get_fresh(&self) -> Option<Arc<UpstreamSnapshot>> {
        let guard = self.state.read();
        let hit = guard.as_ref()?;
        if hit.loaded_at.elapsed() > self.ttl {
            return None;
        }
        Some(hit.value.clone())
    }

    pub fn invalidate(&self) {
        *self.state.write() = None;
    }
}
