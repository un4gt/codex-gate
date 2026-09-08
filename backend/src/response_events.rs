//! Shared Responses event framing and metering. No model-specific protocol branches.
use crate::types::Usage;
use hyper::StatusCode;
use serde_json::Value;

pub(crate) const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const DISCONNECT_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Default)]
pub(crate) struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    event: Option<String>,
    frame_bytes: usize,
    discarding: bool,
    pub error: Option<String>,
}

impl SseDecoder {
    pub fn push_bytes(&mut self, bytes: &[u8]) -> Vec<Value> {
        let mut events = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                if let Some(event) = self.complete_line() {
                    events.push(event);
                }
            } else {
                self.frame_bytes = self.frame_bytes.saturating_add(1);
                if self.frame_bytes > MAX_EVENT_BYTES && !self.discarding {
                    self.error = Some("SSE frame exceeds 4 MiB parsing limit".into());
                    log::warn!("SSE frame exceeds 4 MiB parsing limit; skipping frame");
                    self.discarding = true;
                    self.line.clear();
                    self.data.clear();
                    self.event = None;
                }
                // Keep just enough state to recognize the next empty line after an oversized frame.
                if !self.discarding || self.line.len() < 2 {
                    self.line.push(byte);
                }
            }
        }
        events
    }

    fn complete_line(&mut self) -> Option<Value> {
        let mut line = std::mem::take(&mut self.line);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            let event = if self.discarding {
                None
            } else {
                self.take_event()
            };
            self.discarding = false;
            self.frame_bytes = 0;
            return event;
        }
        if self.discarding {
            return None;
        }
        if let Some(value) = line.strip_prefix(b"event:") {
            self.event = Some(String::from_utf8_lossy(value).trim().to_owned());
        } else if let Some(value) = line.strip_prefix(b"data:") {
            if !self.data.is_empty() {
                self.data.push(b'\n');
            }
            self.data
                .extend_from_slice(value.strip_prefix(b" ").unwrap_or(value));
        }
        None
    }

    fn take_event(&mut self) -> Option<Value> {
        let data = std::mem::take(&mut self.data);
        let kind = self.event.take();
        if data.is_empty() || data == b"[DONE]" {
            return None;
        }
        let mut value: Value = match serde_json::from_slice(&data) {
            Ok(value) => value,
            Err(_) => {
                self.error = Some("SSE data is not valid JSON".into());
                return None;
            }
        };
        if value.get("type").and_then(Value::as_str).is_none()
            && let (Some(kind), Some(root)) = (kind, value.as_object_mut())
        {
            root.insert("type".into(), Value::String(kind));
        }
        Some(value)
    }

    pub fn finish(&mut self) -> Vec<Value> {
        let mut events = Vec::new();
        if !self.line.is_empty()
            && let Some(event) = self.complete_line()
        {
            events.push(event);
        }
        if !self.discarding
            && let Some(event) = self.take_event()
        {
            events.push(event);
        }
        self.frame_bytes = 0;
        events
    }
}

pub(crate) fn is_terminal_response_event(value: &Value) -> bool {
    matches!(
        value
            .get("response")
            .unwrap_or(value)
            .get("status")
            .and_then(Value::as_str),
        Some("completed" | "failed" | "incomplete" | "cancelled" | "canceled")
    ) || matches!(
        value.get("type").and_then(Value::as_str),
        Some(
            "response.completed"
                | "response.done"
                | "response.failed"
                | "response.incomplete"
                | "response.cancelled"
                | "response.canceled"
                | "error"
        )
    )
}

pub(crate) fn service_tier(value: &Value) -> Option<String> {
    value
        .get("response")
        .and_then(|r| r.get("service_tier"))
        .or_else(|| value.get("service_tier"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(crate) fn parse_usage(value: &Value) -> Option<Usage> {
    let number = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| value.pointer(name).and_then(Value::as_i64))
            .filter(|n| *n >= 0)
    };
    let input = number(&["/input_tokens", "/prompt_tokens"])?;
    let output = number(&["/output_tokens", "/completion_tokens"])?;
    let cached = number(&[
        "/input_tokens_details/cached_tokens",
        "/prompt_tokens_details/cached_tokens",
        "/cached_tokens",
        "/cache_read_input_tokens",
    ])
    .unwrap_or(0);
    let created = number(&[
        "/input_tokens_details/cache_creation_tokens",
        "/input_tokens_details/cache_write_tokens",
        "/prompt_tokens_details/cache_creation_tokens",
        "/prompt_tokens_details/cache_write_tokens",
        "/cache_creation_tokens",
        "/cache_creation_input_tokens",
        "/cached_creation_tokens",
        "/cache_write_tokens",
    ])
    .unwrap_or(0);
    let reasoning = number(&[
        "/output_tokens_details/reasoning_tokens",
        "/completion_tokens_details/reasoning_tokens",
        "/reasoning_tokens",
    ])
    .unwrap_or(0);
    Some(Usage {
        input_tokens: input.saturating_sub(cached).saturating_sub(created).max(0),
        output_tokens: output,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: created,
        reasoning_output_tokens: reasoning,
    })
}

pub(crate) fn event_usage(value: &Value) -> Option<Usage> {
    value
        .get("response")
        .and_then(|r| r.get("usage"))
        .and_then(parse_usage)
        .or_else(|| value.get("usage").and_then(parse_usage))
}

#[derive(Default)]
pub(crate) struct Observation {
    pub usage: Option<Usage>,
    pub service_tier: Option<String>,
    pub terminal: bool,
    terminal_usage: bool,
}
impl Observation {
    pub fn observe(&mut self, value: &Value) {
        let terminal = is_terminal_response_event(value);
        if let Some(usage) = event_usage(value)
            && (terminal || !self.terminal_usage)
        {
            self.usage = Some(usage);
            self.terminal_usage |= terminal;
        }
        if let Some(tier) = service_tier(value) {
            self.service_tier = Some(tier);
        }
        self.terminal |= terminal;
    }
}

pub(crate) fn terminal_status(value: &Value) -> (StatusCode, Option<String>, Option<String>) {
    let status = value
        .get("response")
        .unwrap_or(value)
        .get("status")
        .and_then(Value::as_str);
    let kind = match status {
        Some("completed") => Some("response.completed"),
        Some("failed") => Some("response.failed"),
        Some("incomplete") => Some("response.incomplete"),
        Some("cancelled" | "canceled") => Some("response.cancelled"),
        _ => value.get("type").and_then(Value::as_str),
    };
    match kind {
        Some("response.completed" | "response.done") => return (StatusCode::OK, None, None),
        Some("response.failed") => {
            return response_failure_status(value, "response_failed", "response failed");
        }
        Some("response.incomplete") => {
            return response_incomplete_status(value);
        }
        Some("response.cancelled" | "response.canceled") => {
            return response_cancelled_status(value);
        }
        _ => {}
    }

    let error = value.get("error");
    let status = status_from_value(Some(value))
        .or_else(|| status_from_value(error))
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let code = error
        .and_then(|error| error.get("code").or_else(|| error.get("type")))
        .and_then(Value::as_str)
        .unwrap_or("upstream_error")
        .to_string();
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("upstream websocket returned an error")
        .to_string();
    (status, Some(code), Some(message))
}

fn response_failure_status(
    value: &Value,
    fallback_code: &'static str,
    fallback_message: &'static str,
) -> (StatusCode, Option<String>, Option<String>) {
    let response = value.get("response");
    let error = response
        .and_then(|response| response.get("error"))
        .or_else(|| value.get("error"));
    let status = status_from_value(response)
        .or_else(|| status_from_value(error))
        .or_else(|| status_from_value(Some(value)))
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let (code, message) = error_fields(error, fallback_code, fallback_message);
    (status, Some(code), Some(message))
}

fn response_incomplete_status(value: &Value) -> (StatusCode, Option<String>, Option<String>) {
    let response = value.get("response");
    if response
        .and_then(|response| response.get("error"))
        .or_else(|| value.get("error"))
        .is_some()
    {
        return response_failure_status(value, "response_incomplete", "response incomplete");
    }

    let details = response.and_then(|response| response.get("incomplete_details"));
    let reason = details
        .and_then(|details| details.get("reason"))
        .and_then(Value::as_str)
        .or_else(|| {
            response
                .and_then(|response| response.get("status"))
                .and_then(Value::as_str)
        })
        .unwrap_or("response incomplete");
    let status = status_from_value(response)
        .or_else(|| status_from_value(Some(value)))
        .unwrap_or(StatusCode::OK);
    (
        status,
        Some("response_incomplete".to_string()),
        Some(reason.to_string()),
    )
}

fn response_cancelled_status(value: &Value) -> (StatusCode, Option<String>, Option<String>) {
    let response = value.get("response");
    if response
        .and_then(|response| response.get("error"))
        .or_else(|| value.get("error"))
        .is_some()
    {
        return response_failure_status(value, "response_cancelled", "response cancelled");
    }

    let status = status_from_value(response)
        .or_else(|| status_from_value(Some(value)))
        .unwrap_or(StatusCode::OK);
    (
        status,
        Some("response_cancelled".to_string()),
        Some("response cancelled".to_string()),
    )
}

fn status_from_value(value: Option<&Value>) -> Option<StatusCode> {
    let value = value?;
    let status = value.get("status").or_else(|| value.get("status_code"))?;
    let status = status.as_u64().or_else(|| {
        status
            .as_str()
            .and_then(|status| status.parse::<u64>().ok())
    })?;
    StatusCode::from_u16(status as u16).ok()
}

fn error_fields(
    error: Option<&Value>,
    fallback_code: &'static str,
    fallback_message: &'static str,
) -> (String, String) {
    let code = error
        .and_then(|error| error.get("code").or_else(|| error.get("type")))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_code)
        .to_string();
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_message)
        .to_string();
    (code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn data_only_done_metering_is_independent_of_model_name() {
        for model in ["gpt-6-astra", "gpt-4.1"] {
            let event = json!({"type":"response.done", "response":{"model":model,"status":"completed","usage":{"input_tokens":10,"output_tokens":3},"service_tier":"default"}});
            let mut parser = SseDecoder::default();
            let bytes = format!("data: {event}\r\n\r\n");
            let mut observation = Observation::default();
            for chunk in bytes.as_bytes().chunks(7) {
                for value in parser.push_bytes(chunk) {
                    observation.observe(&value);
                }
            }
            assert!(observation.terminal);
            assert_eq!(observation.usage.unwrap().input_tokens, 10);
            assert_eq!(observation.service_tier.as_deref(), Some("default"));
        }
    }

    #[test]
    fn multiline_crlf_tail_and_json_type_override_sse_type() {
        let mut parser = SseDecoder::default();
        let mut values = parser.push_bytes(b"event: response.failed\r\ndata: {\"type\":\"response.done\",\r\ndata: \"response\":{\"status\":\"completed\"}}");
        values.extend(parser.finish());
        assert_eq!(values.len(), 1);
        assert_eq!(terminal_status(&values[0]).0, StatusCode::OK);
        assert!(
            parser.push_bytes(b"data: {\"delta\":\"no inherited event\"}\n\n")[0]
                .get("type")
                .is_none()
        );
    }

    #[test]
    fn large_frames_are_retained_and_oversized_frames_report_then_recover() {
        let mut parser = SseDecoder::default();
        let event = json!({"type":"response.done", "response":{"output":"x".repeat(256 * 1024),"usage":{"input_tokens":9,"output_tokens":2}}});
        let frame = format!("data: {event}\n\n");
        let mut values = Vec::new();
        for chunk in frame.as_bytes().chunks(8192) {
            values.extend(parser.push_bytes(chunk));
        }
        assert_eq!(event_usage(&values[0]).unwrap().input_tokens, 9);
        let oversized = format!(
            "data: {}\n\ndata: {{\"type\":\"response.done\"}}\n\n",
            "x".repeat(MAX_EVENT_BYTES)
        );
        let recovered = parser.push_bytes(oversized.as_bytes());
        assert_eq!(recovered.len(), 1);
        assert!(parser.error.as_deref().unwrap().contains("4 MiB"));
    }

    #[test]
    fn terminal_usage_wins_without_accumulating_duplicates_and_tier_stays_observable() {
        let mut observation = Observation::default();
        observation.observe(&json!({"usage":{"input_tokens":1,"output_tokens":1}}));
        let terminal = json!({"type":"response.failed","response":{"usage":{"input_tokens":15,"output_tokens":4}}});
        observation.observe(&terminal);
        observation.observe(&terminal);
        observation.observe(
            &json!({"usage":{"input_tokens":2,"output_tokens":2},"service_tier":"default"}),
        );
        observation.observe(&json!({"type":"response.done","response":{"usage":null}}));
        assert_eq!(observation.usage.unwrap().input_tokens, 15);
        assert_eq!(observation.service_tier.as_deref(), Some("default"));
    }

    #[test]
    fn explicit_zero_is_observed_but_missing_or_invalid_counts_are_not_inferred() {
        assert_eq!(
            event_usage(&json!({"usage":{"input_tokens":0,"output_tokens":0}}))
                .unwrap()
                .input_tokens,
            0
        );
        for value in [
            json!({}),
            json!({"usage":{}}),
            json!({"usage":{"input_tokens":2}}),
            json!({"usage":{"input_tokens":-1,"output_tokens":4}}),
        ] {
            assert!(event_usage(&value).is_none());
        }
    }

    #[test]
    fn field_aliases_preserve_cached_and_reasoning_counts() {
        let usage = parse_usage(&json!({"prompt_tokens":100,"completion_tokens":12,"cached_tokens":20,"cache_write_tokens":5,"completion_tokens_details":{"reasoning_tokens":3}})).unwrap();
        assert_eq!(
            (
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_input_tokens,
                usage.cache_creation_input_tokens,
                usage.reasoning_output_tokens
            ),
            (75, 12, 20, 5, 3)
        );
    }

    #[test]
    fn terminal_response_status_takes_precedence_over_done_event_name() {
        for status in ["failed", "incomplete", "cancelled", "canceled"] {
            let value = json!({"type":"response.done","response":{"status":status,"usage":{"input_tokens":4,"output_tokens":0}}});
            assert!(terminal_status(&value).1.is_some());
            assert!(event_usage(&value).is_some());
        }
    }
}
