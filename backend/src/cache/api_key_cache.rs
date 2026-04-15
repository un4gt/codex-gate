use std::collections::HashMap;
use std::time::Instant;

use parking_lot::RwLock;

use crate::cache::policy::ApiKeyCachePolicy;
use crate::crypto;
use crate::db::Database;
use crate::types::ApiKeyAuth;

#[derive(Clone, Debug)]
struct ApiKeyEntry {
    value: ApiKeyAuth,
    loaded_at: Instant,
}

pub struct ApiKeyCache {
    policy: ApiKeyCachePolicy,
    by_hash: RwLock<HashMap<String, ApiKeyEntry>>,
}

impl ApiKeyCache {
    pub fn new(policy: ApiKeyCachePolicy) -> Self {
        Self {
            policy,
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
                key_hash,
                ApiKeyEntry {
                    value: row.clone(),
                    loaded_at: Instant::now(),
                },
            );
            self.trim_to_budget(&mut guard);
        }

        Ok(from_db.and_then(|v| Self::check_live(v, now_ms)))
    }

    fn get_fresh(&self, key_hash: &str) -> Option<ApiKeyAuth> {
        let guard = self.by_hash.read();
        let hit = guard.get(key_hash)?;
        if hit.loaded_at.elapsed() > self.policy.ttl {
            return None;
        }
        Some(hit.value.clone())
    }

    fn trim_to_budget(&self, cache: &mut HashMap<String, ApiKeyEntry>) {
        if cache.len() <= self.policy.max_entries {
            return;
        }

        let overflow = cache.len().saturating_sub(self.policy.max_entries);
        let mut victims = cache
            .iter()
            .map(|(key, entry)| (key.clone(), entry.loaded_at))
            .collect::<Vec<_>>();
        victims.sort_by_key(|(_, loaded_at)| *loaded_at);

        for (key, _) in victims.into_iter().take(overflow) {
            cache.remove(&key);
        }
    }

    fn check_live(mut api_key: ApiKeyAuth, now_ms: i64) -> Option<ApiKeyAuth> {
        if !api_key.enabled {
            return None;
        }
        if let Some(expires_at) = api_key.expires_at_ms
            && expires_at <= now_ms
        {
            return None;
        }
        api_key.enabled = true;
        Some(api_key)
    }

    pub fn invalidate_all(&self) {
        self.by_hash.write().clear();
    }
}
