use std::sync::Arc;
use std::time::Duration;

pub mod api_key_cache;
pub mod policy;
pub mod upstream_cache;

use api_key_cache::ApiKeyCache;
use policy::{ApiKeyCachePolicy, UpstreamCachePolicy};
use upstream_cache::UpstreamCache;

#[derive(Clone)]
pub struct Caches {
    pub api_keys: Arc<ApiKeyCache>,
    pub upstream: Arc<UpstreamCache>,
}

impl Caches {
    pub fn new(
        api_key_ttl: Duration,
        upstream_ttl: Duration,
        upstream_stale_grace: Duration,
        api_key_cache_max_entries: usize,
    ) -> Self {
        Self {
            api_keys: Arc::new(ApiKeyCache::new(ApiKeyCachePolicy::new(
                api_key_ttl,
                api_key_cache_max_entries,
            ))),
            upstream: Arc::new(UpstreamCache::new(UpstreamCachePolicy::new(
                upstream_ttl,
                upstream_stale_grace,
            ))),
        }
    }
}
