use std::time::Duration;

#[derive(Clone, Copy, Debug)]
pub struct ApiKeyCachePolicy {
    pub ttl: Duration,
    pub max_entries: usize,
}

impl ApiKeyCachePolicy {
    pub fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl,
            max_entries: max_entries.max(1),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct UpstreamCachePolicy {
    pub ttl: Duration,
    pub stale_grace: Duration,
}

impl UpstreamCachePolicy {
    pub fn new(ttl: Duration, stale_grace: Duration) -> Self {
        Self { ttl, stale_grace }
    }
}
