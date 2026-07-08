use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;
use tokio::sync::Mutex as AsyncMutex;

const WS_CAPABILITY_TTL_BASE_MS: i64 = 600_000;
const WS_CAPABILITY_TTL_JITTER_MIN_MS: usize = 480_000;
const WS_CAPABILITY_TTL_JITTER_MAX_MS: usize = 720_001;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TransportCapabilityKey {
    pub provider_id: i64,
    pub endpoint_id: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WsCapability {
    NativeSupported,
    NativeUnsupported,
}

#[derive(Clone, Copy, Debug)]
struct CapabilityEntry {
    capability: WsCapability,
    expires_at_ms: i64,
}

pub struct TransportCapabilityCache {
    entries: RwLock<HashMap<TransportCapabilityKey, CapabilityEntry>>,
    probe_locks: RwLock<HashMap<TransportCapabilityKey, Arc<AsyncMutex<()>>>>,
}

impl TransportCapabilityCache {
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            probe_locks: RwLock::new(HashMap::new()),
        }
    }

    pub fn get(&self, key: TransportCapabilityKey, now_ms: i64) -> Option<WsCapability> {
        let guard = self.entries.read();
        let entry = guard.get(&key)?;
        if entry.expires_at_ms <= now_ms {
            return None;
        }
        Some(entry.capability)
    }

    pub fn mark_native_supported(&self, key: TransportCapabilityKey, now_ms: i64) {
        self.set(key, WsCapability::NativeSupported, now_ms);
    }

    pub fn mark_native_unsupported(&self, key: TransportCapabilityKey, now_ms: i64) {
        self.set(key, WsCapability::NativeUnsupported, now_ms);
    }

    pub fn probe_lock(&self, key: TransportCapabilityKey) -> Arc<AsyncMutex<()>> {
        if let Some(lock) = self.probe_locks.read().get(&key) {
            return lock.clone();
        }

        let mut guard = self.probe_locks.write();
        guard
            .entry(key)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    fn set(&self, key: TransportCapabilityKey, capability: WsCapability, now_ms: i64) {
        let ttl_ms = jittered_ttl_ms();
        self.entries.write().insert(
            key,
            CapabilityEntry {
                capability,
                expires_at_ms: now_ms.saturating_add(ttl_ms),
            },
        );
    }
}

fn jittered_ttl_ms() -> i64 {
    let ttl = fastrand::usize(WS_CAPABILITY_TTL_JITTER_MIN_MS..WS_CAPABILITY_TTL_JITTER_MAX_MS);
    (ttl as i64).max(WS_CAPABILITY_TTL_BASE_MS / 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_cache_should_expire_entries() {
        let cache = TransportCapabilityCache::new();
        let key = TransportCapabilityKey {
            provider_id: 1,
            endpoint_id: 2,
        };

        cache.mark_native_unsupported(key, 1_000);

        assert_eq!(cache.get(key, 1_001), Some(WsCapability::NativeUnsupported));
        assert_eq!(cache.get(key, 1_000_000), None);
    }
}
