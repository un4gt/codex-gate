use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use hyper::HeaderMap;
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AffinitySource {
    SessionId,
    SessionIdUnderscore,
    XSessionId,
    ThreadId,
    PromptCacheKey,
    MetadataSessionId,
    MetadataUserId,
}

#[derive(Clone, Copy, Debug, Eq)]
struct AffinityKey([u8; 32]);

impl PartialEq for AffinityKey {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Hash for AffinityKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.hash(state);
    }
}

#[derive(Clone, Debug)]
pub struct AffinityIdentity {
    key: AffinityKey,
    pub source: AffinitySource,
    pub log_hash: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AffinityBinding {
    pub provider_id: i64,
    pub generation: u64,
    pub confirmed: bool,
}

#[derive(Clone, Copy, Debug)]
struct AffinityEntry {
    provider_id: i64,
    generation: u64,
    confirmed: bool,
    expires_at_ms: i64,
    last_seen_ms: i64,
}

#[derive(Clone, Copy, Debug)]
struct AvoidEntry {
    provider_id: i64,
    until_ms: i64,
    last_seen_ms: i64,
}

#[derive(Default)]
struct AffinityState {
    entries: HashMap<AffinityKey, AffinityEntry>,
    avoided: HashMap<AffinityKey, AvoidEntry>,
    next_generation: u64,
}

pub struct AffinityBook {
    ttl_ms: i64,
    max_entries: usize,
    state: RwLock<AffinityState>,
}

impl AffinityBook {
    pub fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl_ms: ttl.as_millis().min(i64::MAX as u128) as i64,
            max_entries: max_entries.max(1),
            state: RwLock::new(AffinityState::default()),
        }
    }

    pub fn lookup(&self, identity: &AffinityIdentity, now_ms: i64) -> Option<AffinityBinding> {
        let mut state = self.state.write();
        if state
            .entries
            .get(&identity.key)
            .is_some_and(|entry| entry.expires_at_ms <= now_ms)
        {
            state.entries.remove(&identity.key);
            return None;
        }
        let entry = state.entries.get_mut(&identity.key)?;
        entry.expires_at_ms = now_ms.saturating_add(self.ttl_ms);
        entry.last_seen_ms = now_ms;
        Some(AffinityBinding {
            provider_id: entry.provider_id,
            generation: entry.generation,
            confirmed: entry.confirmed,
        })
    }

    pub fn claim(
        &self,
        identity: &AffinityIdentity,
        provider_id: i64,
        now_ms: i64,
    ) -> AffinityBinding {
        let mut state = self.state.write();
        if state
            .entries
            .get(&identity.key)
            .is_some_and(|entry| entry.expires_at_ms <= now_ms)
        {
            state.entries.remove(&identity.key);
        }
        if let Some(entry) = state.entries.get_mut(&identity.key) {
            entry.expires_at_ms = now_ms.saturating_add(self.ttl_ms);
            entry.last_seen_ms = now_ms;
            return AffinityBinding {
                provider_id: entry.provider_id,
                generation: entry.generation,
                confirmed: entry.confirmed,
            };
        }

        ensure_entry_capacity(&mut state, self.max_entries, now_ms);
        state.next_generation = state.next_generation.wrapping_add(1).max(1);
        let generation = state.next_generation;
        state.entries.insert(
            identity.key,
            AffinityEntry {
                provider_id,
                generation,
                confirmed: false,
                expires_at_ms: now_ms.saturating_add(self.ttl_ms),
                last_seen_ms: now_ms,
            },
        );
        AffinityBinding {
            provider_id,
            generation,
            confirmed: false,
        }
    }

    pub fn confirm(
        &self,
        identity: &AffinityIdentity,
        binding: AffinityBinding,
        now_ms: i64,
    ) -> bool {
        let mut state = self.state.write();
        let Some(entry) = state.entries.get_mut(&identity.key) else {
            return false;
        };
        if entry.provider_id != binding.provider_id || entry.generation != binding.generation {
            return false;
        }
        entry.confirmed = true;
        entry.expires_at_ms = now_ms.saturating_add(self.ttl_ms);
        entry.last_seen_ms = now_ms;
        state.avoided.remove(&identity.key);
        true
    }

    pub fn migrate(
        &self,
        identity: &AffinityIdentity,
        provider_id: i64,
        now_ms: i64,
    ) -> AffinityBinding {
        let mut state = self.state.write();
        if !state.entries.contains_key(&identity.key) {
            ensure_entry_capacity(&mut state, self.max_entries, now_ms);
        }
        state.next_generation = state.next_generation.wrapping_add(1).max(1);
        let generation = state.next_generation;
        state.entries.insert(
            identity.key,
            AffinityEntry {
                provider_id,
                generation,
                confirmed: true,
                expires_at_ms: now_ms.saturating_add(self.ttl_ms),
                last_seen_ms: now_ms,
            },
        );
        state.avoided.remove(&identity.key);
        AffinityBinding {
            provider_id,
            generation,
            confirmed: true,
        }
    }

    pub fn refresh_if_provider(
        &self,
        identity: &AffinityIdentity,
        provider_id: i64,
        now_ms: i64,
    ) -> bool {
        let mut state = self.state.write();
        let Some(entry) = state.entries.get_mut(&identity.key) else {
            return false;
        };
        if entry.provider_id != provider_id {
            return false;
        }
        entry.confirmed = true;
        entry.expires_at_ms = now_ms.saturating_add(self.ttl_ms);
        entry.last_seen_ms = now_ms;
        true
    }

    pub fn clear_if_provider(&self, identity: &AffinityIdentity, provider_id: i64) -> bool {
        let mut state = self.state.write();
        let matches = state
            .entries
            .get(&identity.key)
            .is_some_and(|entry| entry.provider_id == provider_id);
        if matches {
            state.entries.remove(&identity.key);
        }
        matches
    }

    pub fn mark_provider_failed(
        &self,
        identity: &AffinityIdentity,
        provider_id: i64,
        now_ms: i64,
        avoid_for: Duration,
    ) {
        let avoid_ms = avoid_for.as_millis().min(i64::MAX as u128) as i64;
        let mut state = self.state.write();
        if state
            .entries
            .get(&identity.key)
            .is_some_and(|entry| entry.provider_id == provider_id)
        {
            state.entries.remove(&identity.key);
        }
        if !state.avoided.contains_key(&identity.key) {
            ensure_avoid_capacity(&mut state, self.max_entries, now_ms);
        }
        state.avoided.insert(
            identity.key,
            AvoidEntry {
                provider_id,
                until_ms: now_ms.saturating_add(avoid_ms),
                last_seen_ms: now_ms,
            },
        );
    }

    pub fn is_provider_avoided(
        &self,
        identity: &AffinityIdentity,
        provider_id: i64,
        now_ms: i64,
    ) -> bool {
        let mut state = self.state.write();
        let Some(entry) = state.avoided.get_mut(&identity.key) else {
            return false;
        };
        if entry.until_ms <= now_ms {
            state.avoided.remove(&identity.key);
            return false;
        }
        entry.last_seen_ms = now_ms;
        entry.provider_id == provider_id
    }

    pub fn purge_provider(&self, provider_id: i64) {
        let mut state = self.state.write();
        state
            .entries
            .retain(|_, entry| entry.provider_id != provider_id);
        state
            .avoided
            .retain(|_, entry| entry.provider_id != provider_id);
    }

    pub fn binding_counts_by_provider(&self, now_ms: i64) -> HashMap<i64, usize> {
        let mut state = self.state.write();
        remove_expired(&mut state, now_ms);
        let mut counts = HashMap::new();
        for entry in state.entries.values().filter(|entry| entry.confirmed) {
            *counts.entry(entry.provider_id).or_insert(0) += 1;
        }
        counts
    }
}

pub fn extract_affinity_identity(
    headers: &HeaderMap,
    body: &[u8],
    api_key_id: i64,
) -> Option<AffinityIdentity> {
    let header_candidates = [
        ("session-id", AffinitySource::SessionId),
        ("session_id", AffinitySource::SessionIdUnderscore),
        ("x-session-id", AffinitySource::XSessionId),
        ("thread-id", AffinitySource::ThreadId),
    ];
    for (name, source) in header_candidates {
        if let Some(value) = headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(normalize_session_id)
        {
            return Some(build_identity(api_key_id, value, source));
        }
    }

    let root = serde_json::from_slice::<Value>(body).ok()?;
    if let Some(value) = root
        .get("prompt_cache_key")
        .and_then(Value::as_str)
        .and_then(normalize_session_id)
    {
        return Some(build_identity(
            api_key_id,
            value,
            AffinitySource::PromptCacheKey,
        ));
    }
    let metadata = root.get("metadata")?.as_object()?;
    if let Some(value) = metadata
        .get("session_id")
        .and_then(Value::as_str)
        .and_then(normalize_session_id)
    {
        return Some(build_identity(
            api_key_id,
            value,
            AffinitySource::MetadataSessionId,
        ));
    }
    let user_id = metadata.get("user_id")?.as_str()?;
    let structured = serde_json::from_str::<Value>(user_id)
        .ok()
        .and_then(|value| {
            value
                .get("session_id")
                .and_then(Value::as_str)
                .and_then(normalize_session_id)
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            user_id
                .rsplit_once("_session_")
                .and_then(|(_, session)| normalize_session_id(session))
                .map(ToOwned::to_owned)
        })?;
    Some(build_identity(
        api_key_id,
        &structured,
        AffinitySource::MetadataUserId,
    ))
}

fn normalize_session_id(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return None;
    }
    Some(value)
}

fn build_identity(api_key_id: i64, session_id: &str, source: AffinitySource) -> AffinityIdentity {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&api_key_id.to_le_bytes());
    hasher.update(&[0]);
    hasher.update(session_id.as_bytes());
    let hash = *hasher.finalize().as_bytes();
    AffinityIdentity {
        key: AffinityKey(hash),
        source,
        log_hash: hex::encode(&hash[..6]),
    }
}

fn remove_expired(state: &mut AffinityState, now_ms: i64) {
    state
        .entries
        .retain(|_, entry| entry.expires_at_ms > now_ms);
    state.avoided.retain(|_, entry| entry.until_ms > now_ms);
}

fn ensure_entry_capacity(state: &mut AffinityState, max_entries: usize, now_ms: i64) {
    if state.entries.len() < max_entries {
        return;
    }
    state
        .entries
        .retain(|_, entry| entry.expires_at_ms > now_ms);
    while state.entries.len() >= max_entries {
        let Some(oldest_key) = state
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_seen_ms)
            .map(|(key, _)| *key)
        else {
            break;
        };
        state.entries.remove(&oldest_key);
        state.avoided.remove(&oldest_key);
    }
}

fn ensure_avoid_capacity(state: &mut AffinityState, max_entries: usize, now_ms: i64) {
    if state.avoided.len() < max_entries {
        return;
    }
    state.avoided.retain(|_, entry| entry.until_ms > now_ms);
    while state.avoided.len() >= max_entries {
        let Some(oldest_key) = state
            .avoided
            .iter()
            .min_by_key(|(_, entry)| entry.last_seen_ms)
            .map(|(key, _)| *key)
        else {
            break;
        };
        state.avoided.remove(&oldest_key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    #[test]
    fn extract_affinity_should_prefer_session_header_and_ignore_request_id() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-client-request-id",
            HeaderValue::from_static("request-only"),
        );
        headers.insert("session-id", HeaderValue::from_static("conversation-a"));

        let identity = extract_affinity_identity(&headers, br#"{"prompt_cache_key":"cache-b"}"#, 7)
            .expect("affinity identity");

        assert_eq!(identity.source, AffinitySource::SessionId);
    }

    #[test]
    fn extract_affinity_should_not_use_client_request_id() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-client-request-id",
            HeaderValue::from_static("request-only"),
        );

        assert!(extract_affinity_identity(&headers, br#"{}"#, 7).is_none());
    }

    #[test]
    fn first_claim_should_win_until_binding_migrates() {
        let book = AffinityBook::new(Duration::from_secs(30), 10);
        let identity = build_identity(7, "conversation-a", AffinitySource::SessionId);

        let first = book.claim(&identity, 11, 1_000);
        let second = book.claim(&identity, 22, 1_001);
        assert_eq!(first.provider_id, second.provider_id);

        book.migrate(&identity, 22, 1_002);
        assert_eq!(
            book.lookup(&identity, 1_003).map(|item| item.provider_id),
            Some(22)
        );
    }

    #[test]
    fn expired_binding_should_allow_new_provider() {
        let book = AffinityBook::new(Duration::from_millis(10), 10);
        let identity = build_identity(7, "conversation-a", AffinitySource::SessionId);
        book.claim(&identity, 11, 1_000);

        assert_eq!(book.claim(&identity, 22, 1_011).provider_id, 22);
    }

    #[test]
    fn affinity_lookup_should_extend_sliding_ttl() {
        let book = AffinityBook::new(Duration::from_millis(100), 10);
        let identity = build_identity(7, "conversation-a", AffinitySource::SessionId);
        let binding = book.claim(&identity, 11, 1_000);
        assert!(book.confirm(&identity, binding, 1_000));

        assert!(book.lookup(&identity, 1_090).is_some());
        assert!(book.lookup(&identity, 1_150).is_some());
        assert!(book.lookup(&identity, 1_251).is_none());
    }

    #[test]
    fn lookup_should_not_scan_and_remove_unrelated_expired_bindings() {
        let book = AffinityBook::new(Duration::from_millis(10), 10);
        let expired = build_identity(7, "expired", AffinitySource::SessionId);
        let active = build_identity(7, "active", AffinitySource::SessionId);
        book.claim(&expired, 11, 1_000);
        book.claim(&active, 22, 1_005);

        assert!(book.lookup(&active, 1_012).is_some());
        assert!(book.state.read().entries.contains_key(&expired.key));
    }

    #[test]
    fn inserting_at_capacity_should_remove_expired_and_bound_entry_count() {
        let book = AffinityBook::new(Duration::from_millis(10), 2);
        let expired = build_identity(7, "expired", AffinitySource::SessionId);
        let active = build_identity(7, "active", AffinitySource::SessionId);
        let newcomer = build_identity(7, "new", AffinitySource::SessionId);
        book.claim(&expired, 11, 1_000);
        book.claim(&active, 22, 1_005);

        book.claim(&newcomer, 33, 1_011);

        let state = book.state.read();
        assert_eq!(state.entries.len(), 2);
        assert!(!state.entries.contains_key(&expired.key));
        assert!(state.entries.contains_key(&active.key));
        assert!(state.entries.contains_key(&newcomer.key));
    }

    #[test]
    fn avoided_bindings_should_be_bounded_by_configured_capacity() {
        let book = AffinityBook::new(Duration::from_secs(30), 2);
        for session in ["a", "b", "c"] {
            let identity = build_identity(7, session, AffinitySource::SessionId);
            book.mark_provider_failed(&identity, 11, 1_000, Duration::from_secs(30));
        }

        assert_eq!(book.state.read().avoided.len(), 2);
    }
}
