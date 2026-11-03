//! Normalize Responses input item IDs before they reach an upstream.
//!
//! Some Responses-compatible providers return a tool call with `call_id` used
//! as the item `id` (for example `custom_tool_call.id = "call_..."`). Codex
//! replays that item on the next turn, and stricter upstreams reject it:
//! `Invalid 'input[N].id': ... Expected an ID that begins with 'ctc'`.
//!
//! Keep this normalization at the final native Responses boundary. Chat-based
//! Responses conversion already uses `call_id` when building Chat tool calls.

use bytes::Bytes;
use hyper::HeaderMap;
use hyper::header::{CONTENT_LENGTH, HeaderValue};
use serde_json::Value;

const MAX_ITEM_ID_LEN: usize = 64;
const CALL_ITEM_ID_PREFIXES: [&str; 3] = ["ctc_", "fc_", "tsc_"];

/// Normalize a JSON Responses request body and update `Content-Length` when the
/// body changes. Invalid JSON or a payload without `input` items is returned
/// unchanged.
pub fn normalize_http_body(headers: &mut HeaderMap, body: &Bytes) -> Bytes {
    let mut value: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return body.slice(..),
    };
    if normalize_request_value(&mut value) == 0 {
        return body.slice(..);
    }
    let encoded = match serde_json::to_vec(&value) {
        Ok(encoded) => encoded,
        Err(_) => return body.slice(..),
    };
    if let Ok(length) = HeaderValue::from_str(&encoded.len().to_string()) {
        headers.insert(CONTENT_LENGTH, length);
    }
    Bytes::from(encoded)
}

/// Normalize item IDs in a decoded Responses request. Returns the number of
/// changed `input` items.
pub fn normalize_request_value(value: &mut Value) -> usize {
    let Some(root) = value.as_object_mut() else {
        return 0;
    };
    let Some(input) = root.get_mut("input") else {
        return 0;
    };
    normalize_input(input)
}

fn normalize_input(input: &mut Value) -> usize {
    match input {
        Value::Array(items) => items.iter_mut().map(normalize_item).sum(),
        Value::Object(_) => normalize_item(input),
        _ => 0,
    }
}

fn normalize_item(item: &mut Value) -> usize {
    let Some(object) = item.as_object_mut() else {
        return 0;
    };
    let Some(target_prefix) = object
        .get("type")
        .and_then(Value::as_str)
        .and_then(item_id_prefix)
    else {
        return 0;
    };
    let Some(id) = object.get("id").and_then(Value::as_str) else {
        return 0;
    };
    let normalized = normalize_item_id(id, target_prefix);
    if normalized == id {
        return 0;
    }
    object.insert("id".to_string(), Value::String(normalized));
    1
}

fn item_id_prefix(item_type: &str) -> Option<&'static str> {
    match item_type {
        "function_call" => Some("fc_"),
        "custom_tool_call" => Some("ctc_"),
        "custom_tool_call_output" => Some("ctco_"),
        "tool_search_call" => Some("tsc_"),
        _ => None,
    }
}

fn normalize_item_id(id: &str, target_prefix: &str) -> String {
    if id.is_empty() {
        return id.to_string();
    }
    if id.starts_with(target_prefix) {
        return cap_item_id(id.to_string());
    }
    if target_prefix == "tsc_"
        && let Some(rest) = id.strip_prefix("ts_")
    {
        return cap_item_id(format!("tsc_{rest}"));
    }
    for known in CALL_ITEM_ID_PREFIXES {
        if known != target_prefix
            && let Some(rest) = id.strip_prefix(known)
        {
            return cap_item_id(format!("{target_prefix}{rest}"));
        }
    }
    cap_item_id(format!("{target_prefix}{id}"))
}

fn cap_item_id(id: String) -> String {
    if id.chars().count() <= MAX_ITEM_ID_LEN {
        return id;
    }
    let hash = blake3::hash(id.as_bytes());
    let suffix = format!("_{}", hex::encode(&hash.as_bytes()[..8]));
    let keep = MAX_ITEM_ID_LEN.saturating_sub(suffix.len());
    let prefix: String = id.chars().take(keep).collect();
    format!("{prefix}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn normalized(input: Value) -> Value {
        let mut value = json!({ "input": input });
        assert!(normalize_request_value(&mut value) > 0);
        value["input"].clone()
    }

    #[test]
    fn custom_tool_call_uses_ctc_prefix_and_keeps_call_id() {
        let item = normalized(json!([{
            "type": "custom_tool_call",
            "id": "call_abc",
            "call_id": "call_abc",
            "name": "exec",
            "input": "pwd"
        }]));
        assert_eq!(item[0]["id"], "ctc_call_abc");
        assert_eq!(item[0]["call_id"], "call_abc");
        assert_eq!(item[0]["name"], "exec");
        assert_eq!(item[0]["input"], "pwd");
    }

    #[test]
    fn known_call_prefixes_are_retyped_without_double_prefixing() {
        let item = normalized(json!([{
            "type": "custom_tool_call",
            "id": "fc_abc",
            "call_id": "call_1",
            "name": "exec",
            "input": "pwd"
        }]));
        assert_eq!(item[0]["id"], "ctc_abc");

        let item = normalized(json!([{
            "type": "function_call",
            "id": "ctc_abc",
            "call_id": "call_1",
            "name": "lookup",
            "arguments": "{}"
        }]));
        assert_eq!(item[0]["id"], "fc_abc");

        let item = normalized(json!([{
            "type": "tool_search_call",
            "id": "ts_abc",
            "call_id": "call_1",
            "arguments": {}
        }]));
        assert_eq!(item[0]["id"], "tsc_abc");
    }

    #[test]
    fn output_and_function_ids_are_normalized() {
        let item = normalized(json!([
            {
                "type": "custom_tool_call_output",
                "id": "call_output",
                "call_id": "call_1",
                "output": "ok"
            },
            {
                "type": "function_call",
                "id": "call_function",
                "call_id": "call_2",
                "name": "lookup",
                "arguments": "{}"
            }
        ]));
        assert_eq!(item[0]["id"], "ctco_call_output");
        assert_eq!(item[0]["call_id"], "call_1");
        assert_eq!(item[1]["id"], "fc_call_function");
        assert_eq!(item[1]["call_id"], "call_2");
    }

    #[test]
    fn valid_and_unrelated_ids_are_unchanged() {
        let mut value = json!({
            "input": [
                {"type": "custom_tool_call", "id": "ctc_ok", "call_id": "call_1", "name": "exec", "input": ""},
                {"type": "message", "id": "call_not_a_tool", "role": "user", "content": []},
                {"type": "custom_tool_call", "call_id": "call_2", "name": "exec", "input": ""},
                {"type": "custom_tool_call", "id": "", "call_id": "call_3", "name": "exec", "input": ""}
            ]
        });
        assert_eq!(normalize_request_value(&mut value), 0);
        assert_eq!(value["input"][0]["id"], "ctc_ok");
        assert_eq!(value["input"][1]["id"], "call_not_a_tool");
        assert!(value["input"][2].get("id").is_none());
        assert_eq!(value["input"][3]["id"], "");
    }

    #[test]
    fn normalization_is_deterministic_idempotent_and_bounded() {
        let original = json!([{
            "type": "custom_tool_call",
            "id": format!("call_{}", "a".repeat(80)),
            "call_id": "call_long",
            "name": "exec",
            "input": ""
        }]);
        let first = normalized(original.clone());
        let second = normalized(original);
        assert_eq!(first, second);
        assert!(first[0]["id"].as_str().unwrap().len() <= MAX_ITEM_ID_LEN);
        assert!(first[0]["id"].as_str().unwrap().starts_with("ctc_"));

        let mut again = json!({ "input": first });
        assert_eq!(normalize_request_value(&mut again), 0);
    }

    #[test]
    fn http_body_updates_length_only_when_changed() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("999"));
        let body = Bytes::from_static(
            br#"{"input":[{"type":"custom_tool_call","id":"call_1","call_id":"call_1","name":"exec","input":""}]}"#,
        );
        let normalized = normalize_http_body(&mut headers, &body);
        assert!(
            normalized
                .windows(b"ctc_call_1".len())
                .any(|window| window == b"ctc_call_1")
        );
        assert_eq!(headers[CONTENT_LENGTH], normalized.len().to_string());

        let valid = Bytes::from_static(
            br#"{"input":[{"type":"custom_tool_call","id":"ctc_1","call_id":"call_1","name":"exec","input":""}]}"#,
        );
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("999"));
        assert_eq!(normalize_http_body(&mut headers, &valid), valid);
        assert_eq!(headers[CONTENT_LENGTH], "999");
    }

    #[test]
    fn malformed_or_unrelated_bodies_are_unchanged() {
        let mut headers = HeaderMap::new();
        for body in [
            Bytes::from_static(b"not json"),
            Bytes::from_static(br#"{"input":"hello"}"#),
            Bytes::from_static(br#"{"model":"m"}"#),
        ] {
            assert_eq!(normalize_http_body(&mut headers, &body), body);
        }
    }

    #[test]
    fn single_object_input_is_normalized() {
        let mut value = json!({
            "input": {
                "type": "custom_tool_call",
                "id": "call_1",
                "call_id": "call_1",
                "name": "exec",
                "input": ""
            }
        });
        assert_eq!(normalize_request_value(&mut value), 1);
        assert_eq!(value["input"]["id"], "ctc_call_1");
    }

    #[test]
    fn normalization_preserves_other_fields_and_item_order() {
        let original = json!([
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
            {"type": "custom_tool_call", "id": "fc_a", "call_id": "call_a", "name": "exec", "input": "a"},
            {"type": "custom_tool_call_output", "id": "call_a_out", "call_id": "call_a", "output": "ok"}
        ]);
        let item = normalized(original);
        assert_eq!(item[0]["content"][0]["text"], "hi");
        assert_eq!(item[1]["call_id"], "call_a");
        assert_eq!(item[2]["call_id"], "call_a");
        assert_eq!(item[1]["id"], "ctc_a");
        assert_eq!(item[2]["id"], "ctco_call_a_out");
    }

    #[test]
    fn non_tool_input_shapes_are_unchanged() {
        let mut value = json!({"input": []});
        assert_eq!(normalize_request_value(&mut value), 0);
        let mut value = json!({"input": {"type": "message", "id": "call_x"}});
        assert_eq!(normalize_request_value(&mut value), 0);
    }

    #[test]
    fn content_length_is_updated_when_header_is_absent() {
        let mut headers = HeaderMap::new();
        let body = Bytes::from_static(
            br#"{"input":[{"type":"custom_tool_call","id":"call_1","call_id":"call_1","name":"exec","input":""}]}"#,
        );
        let normalized = normalize_http_body(&mut headers, &body);
        assert_eq!(headers[CONTENT_LENGTH], normalized.len().to_string());
    }

    #[test]
    fn does_not_mutate_invalid_items() {
        let mut value = json!({
            "input": [
                {"type": "custom_tool_call", "id": 42, "call_id": "call_1"},
                {"type": "custom_tool_call", "id": null, "call_id": "call_2"},
                {"type": "custom_tool_call", "id": "fc_a", "call_id": null}
            ]
        });
        assert_eq!(normalize_request_value(&mut value), 1);
        assert_eq!(value["input"][0]["id"], 42);
        assert_eq!(value["input"][1]["id"], Value::Null);
        assert_eq!(value["input"][2]["id"], "ctc_a");
    }

    #[test]
    fn max_length_hash_is_stable_for_the_same_id() {
        let id = format!("ctc_{}", "z".repeat(80));
        let first = cap_item_id(id.clone());
        let second = cap_item_id(id);
        assert_eq!(first, second);
        assert_eq!(first.chars().count(), MAX_ITEM_ID_LEN);
    }
}
