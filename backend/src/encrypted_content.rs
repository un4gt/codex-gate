//! Opt-in recovery for Responses histories rejected with invalid_encrypted_content.
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use bytes::Bytes;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest as _, Sha256};

type Digest = [u8; 32];
const MAX_DIGESTS_PER_SESSION: usize = 512;
const MAX_SESSIONS: usize = 1024;

struct Session {
    digests: VecDeque<Digest>,
    last_seen_ms: i64,
}

pub struct RecoveryBook {
    sessions: Mutex<HashMap<String, Session>>,
    ttl_ms: i64,
    max_sessions: usize,
}

impl RecoveryBook {
    pub fn new(ttl: Duration, max_sessions: usize) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            ttl_ms: ttl.as_millis().min(i64::MAX as u128) as i64,
            max_sessions: max_sessions.clamp(1, MAX_SESSIONS),
        }
    }

    fn lookup(&self, key: &str, now_ms: i64) -> HashSet<Digest> {
        let mut sessions = self.sessions.lock();
        if sessions
            .get(key)
            .is_some_and(|entry| now_ms.saturating_sub(entry.last_seen_ms) >= self.ttl_ms)
        {
            sessions.remove(key);
        }
        let Some(entry) = sessions.get_mut(key) else {
            return HashSet::new();
        };
        entry.last_seen_ms = now_ms;
        entry.digests.iter().copied().collect()
    }

    fn remember(&self, key: &str, digests: &HashSet<Digest>, now_ms: i64) {
        if digests.is_empty() {
            return;
        }
        let mut sessions = self.sessions.lock();
        sessions.retain(|_, entry| now_ms.saturating_sub(entry.last_seen_ms) < self.ttl_ms);
        if !sessions.contains_key(key)
            && sessions.len() >= self.max_sessions
            && let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, entry)| entry.last_seen_ms)
                .map(|(key, _)| key.clone())
        {
            sessions.remove(&oldest);
        }
        let entry = sessions.entry(key.to_owned()).or_insert_with(|| Session {
            digests: VecDeque::new(),
            last_seen_ms: now_ms,
        });
        entry.last_seen_ms = now_ms;
        for digest in digests {
            if entry.digests.contains(digest) {
                continue;
            }
            if entry.digests.len() >= MAX_DIGESTS_PER_SESSION {
                entry.digests.pop_front();
            }
            entry.digests.push_back(*digest);
        }
    }
}

#[derive(Clone, Default, Serialize)]
pub struct RecoveryTrace {
    pub filtered_items: usize,
    pub stripped_items: usize,
    pub retries: usize,
}

#[derive(Default)]
pub struct RequestRecovery {
    pub enabled: bool,
    session_key: Option<String>,
    invalid: HashSet<Digest>,
    pub trace: RecoveryTrace,
}

impl RequestRecovery {
    pub fn new(enabled: bool, session_key: Option<String>) -> Self {
        Self {
            enabled,
            session_key,
            ..Self::default()
        }
    }

    pub fn filter_known(&mut self, book: &RecoveryBook, body: Bytes) -> Bytes {
        if !self.enabled {
            return body;
        }
        let mut invalid = self.invalid.clone();
        if let Some(key) = &self.session_key {
            invalid.extend(book.lookup(key, crate::util::now_ms()));
        }
        if invalid.is_empty() {
            return body;
        }
        let Some((cleaned, count)) = sanitize(&body, Some(&invalid), false) else {
            return body;
        };
        self.trace.filtered_items += count;
        cleaned
    }

    pub fn record_failure(&mut self, book: &RecoveryBook, body: &[u8]) {
        if !self.enabled {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(body) {
            visit_input(&value, |item| {
                if supported_item(item)
                    && let Some(digest) = encrypted_digest(item)
                {
                    self.invalid.insert(digest);
                }
            });
        }
        if let Some(key) = &self.session_key {
            book.remember(key, &self.invalid, crate::util::now_ms());
        }
    }

    pub fn can_retry(&self) -> bool {
        self.enabled && self.trace.retries == 0
    }

    pub fn prepare_retry(&mut self, body: &[u8], websocket: bool) -> Option<Bytes> {
        if !self.can_retry() {
            return None;
        }
        let (body, count) = sanitize(body, None, websocket)?;
        self.trace.stripped_items += count;
        self.trace.retries += 1;
        Some(body)
    }
}

/// Match the structured error code, never user-controlled text mentioning it.
pub fn is_invalid_encrypted_content(value: &Value) -> bool {
    [value.get("error"), value.pointer("/response/error")]
        .into_iter()
        .flatten()
        .any(|error| error.get("code").and_then(Value::as_str) == Some("invalid_encrypted_content"))
}

pub fn rejection_without_output(value: &Value) -> bool {
    is_invalid_encrypted_content(value)
        && crate::response_events::event_usage(value).is_none()
        && value
            .get("output")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        && value
            .pointer("/response/output")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
}

fn supported_item(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("reasoning" | "compaction" | "compaction_summary")
    )
}

fn encrypted_digest(item: &Value) -> Option<Digest> {
    let encrypted = item.get("encrypted_content")?.as_str()?;
    (!encrypted.is_empty()).then(|| Sha256::digest(encrypted.as_bytes()).into())
}

fn visit_input(value: &Value, mut visit: impl FnMut(&Value)) {
    match value.get("input") {
        Some(Value::Array(items)) => items.iter().for_each(visit),
        Some(item @ Value::Object(_)) => visit(item),
        _ => {}
    }
}

fn sanitize(
    body: &[u8],
    invalid: Option<&HashSet<Digest>>,
    websocket: bool,
) -> Option<(Bytes, usize)> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    let mut count = 0;
    let mut clean = |item: &mut Value| {
        if !supported_item(item) || item.get("encrypted_content").is_none() {
            return true;
        }
        if let Some(invalid) = invalid
            && !encrypted_digest(item).is_some_and(|digest| invalid.contains(&digest))
        {
            return true;
        }
        count += 1;
        if item.get("type").and_then(Value::as_str) != Some("reasoning") {
            // Encrypted compaction has no plaintext equivalent. The Beta setting documents this loss.
            return false;
        }
        if let Some(item) = item.as_object_mut() {
            item.remove("encrypted_content");
            if item.get("content") == Some(&Value::Null) {
                item.remove("content");
            }
            return item.len() > 1;
        }
        true
    };
    match value.get_mut("input") {
        Some(Value::Array(items)) => items.retain_mut(&mut clean),
        Some(item @ Value::Object(_)) => {
            if !clean(item) {
                *item = Value::Array(Vec::new());
            }
        }
        _ => return None,
    }
    if count == 0 {
        return None;
    }
    // A WS continuation can depend on a tool call stored in the previous response.
    let mut has_tool_output = false;
    visit_input(&value, |item| {
        has_tool_output |= item.get("type").and_then(Value::as_str) == Some("function_call_output");
    });
    if websocket
        && !has_tool_output
        && let Some(root) = value.as_object_mut()
    {
        root.remove("previous_response_id");
    }
    serde_json::to_vec(&value)
        .ok()
        .map(|body| (Bytes::from(body), count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_preserves_visible_history_and_tool_chain() {
        let input = json!({"previous_response_id":"resp_previous", "input":[
            {"role":"user","content":"continue"},
            {"type":"reasoning","id":"rs_1","encrypted_content":"old","content":null,"summary":[{"text":"keep"}]},
            {"type":"reasoning","encrypted_content":"empty"},
            {"type":"compaction","encrypted_content":"compact"},
            {"type":"compaction_summary","encrypted_content":"summary"},
            {"type":"function_call","call_id":"c1","name":"shell","arguments":"{}"},
            {"type":"function_call_output","call_id":"c1","output":"already done"},
            {"type":"agent_message","encrypted_content":"unsupported"}
        ]});
        let mut recovery = RequestRecovery::new(true, None);
        let cleaned = recovery
            .prepare_retry(&serde_json::to_vec(&input).unwrap(), true)
            .unwrap();
        let value: Value = serde_json::from_slice(&cleaned).unwrap();
        assert_eq!(
            value,
            json!({"previous_response_id":"resp_previous","input":[
                input["input"][0],
                {"type":"reasoning","id":"rs_1","summary":[{"text":"keep"}]},
                input["input"][5], input["input"][6], input["input"][7]
            ]})
        );
        assert!(recovery.prepare_retry(&cleaned, true).is_none());
    }

    #[test]
    fn continuation_is_removed_only_for_ws_without_tool_output() {
        let raw = br#"{"previous_response_id":"resp_old","input":{"type":"reasoning","encrypted_content":"old"}}"#;
        for websocket in [false, true] {
            let cleaned = RequestRecovery::new(true, None)
                .prepare_retry(raw, websocket)
                .unwrap();
            let value: Value = serde_json::from_slice(&cleaned).unwrap();
            assert_eq!(value.get("previous_response_id").is_none(), websocket);
            assert_eq!(value["input"], json!([]));
        }
    }

    #[test]
    fn remembered_digests_do_not_strip_new_ciphertext_or_other_sessions() {
        let book = RecoveryBook::new(Duration::from_secs(60), 10);
        let raw = Bytes::from_static(br#"{"input":[{"type":"reasoning","encrypted_content":"old"},{"type":"reasoning","encrypted_content":"new"}]}"#);
        let mut first = RequestRecovery::new(true, Some("key1/session1".into()));
        first.record_failure(
            &book,
            br#"{"input":[{"type":"reasoning","encrypted_content":"old"}]}"#,
        );
        let mut next = RequestRecovery::new(true, Some("key1/session1".into()));
        let filtered = next.filter_known(&book, raw.clone());
        let value: Value = serde_json::from_slice(&filtered).unwrap();
        assert_eq!(
            value,
            json!({"input":[{"type":"reasoning","encrypted_content":"new"}]})
        );
        for session in ["key2/session1", "key1/session2"] {
            assert_eq!(
                RequestRecovery::new(true, Some(session.into())).filter_known(&book, raw.clone()),
                raw
            );
        }
        assert_eq!(
            RequestRecovery::new(false, Some("key1/session1".into()))
                .filter_known(&book, raw.clone()),
            raw
        );
    }

    #[test]
    fn cache_is_bounded_and_expires_without_retaining_ciphertext() {
        let book = RecoveryBook::new(Duration::from_millis(100), 2);
        let digests = (0_u32..600)
            .map(|n| Sha256::digest(n.to_be_bytes()).into())
            .collect();
        book.remember("one", &digests, 0);
        assert_eq!(book.lookup("one", 1).len(), MAX_DIGESTS_PER_SESSION);
        book.remember("two", &digests, 2);
        book.remember("three", &digests, 3);
        assert!(book.lookup("one", 4).is_empty());
        assert!(!book.lookup("two", 50).is_empty());
        assert!(book.lookup("three", 103).is_empty());
        assert!(book.lookup("two", 150).is_empty());
    }

    #[test]
    fn only_exact_errors_without_usage_or_output_are_recoverable() {
        assert!(rejection_without_output(
            &json!({"error":{"code":"invalid_encrypted_content"}})
        ));
        assert!(rejection_without_output(
            &json!({"type":"response.failed","response":{"error":{"code":"invalid_encrypted_content"}}})
        ));
        for value in [
            json!({"error":{"message":"invalid_encrypted_content","code":"other"}}),
            json!({"error":{"code":"invalid_encrypted_content"},"usage":{"input_tokens":0,"output_tokens":0}}),
            json!({"error":{"code":"invalid_encrypted_content"},"response":{"output":[{"type":"function_call"}]}}),
        ] {
            assert!(!rejection_without_output(&value));
        }
    }
}
