use std::collections::HashSet;

use bytes::Bytes;
use hyper::HeaderMap;
use hyper::header::{
    AUTHORIZATION, CONNECTION, CONTENT_LENGTH, HOST, HeaderName, HeaderValue, PROXY_AUTHENTICATE,
    PROXY_AUTHORIZATION, TE, TRAILER, TRANSFER_ENCODING, UPGRADE,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ulid::Ulid;

use crate::types::ApiFormat;

const MAX_HEADER_OVERRIDES: usize = 64;
const MAX_BODY_OVERRIDES: usize = 128;
const MAX_CONFIG_BYTES: usize = 256 * 1024;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;
const MAX_BODY_PATH_BYTES: usize = 512;
const MAX_BODY_PATH_DEPTH: usize = 16;
const MAX_BODY_VALUE_BYTES: usize = 64 * 1024;
const REQUEST_ID_TEMPLATE: &str = "{{request_id}}";

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct RequestOverrides {
    #[serde(default)]
    pub headers: Vec<RequestHeaderOverride>,
    #[serde(default)]
    pub body: Vec<RequestBodyOverride>,
}

impl RequestOverrides {
    pub fn from_storage(raw: &str) -> Self {
        serde_json::from_str::<Self>(raw)
            .ok()
            .filter(|overrides| overrides.validate().is_ok())
            .unwrap_or_default()
    }

    pub fn to_storage(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| r#"{"headers":[],"body":[]}"#.to_string())
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_request_overrides(self)
    }

    pub fn apply_body(
        &self,
        body: Bytes,
        api_format: ApiFormat,
        context: &RequestOverrideContext,
    ) -> Result<Bytes, String> {
        apply_body_overrides(self, api_format.into(), body, context)
    }

    pub fn apply_body_value(
        &self,
        value: &mut Value,
        api_format: ApiFormat,
        context: &RequestOverrideContext,
    ) -> Result<(), String> {
        apply_body_overrides_to_value(self, api_format.into(), value, context)
    }

    pub fn apply_headers(
        &self,
        headers: &mut HeaderMap,
        api_format: ApiFormat,
        context: &RequestOverrideContext,
    ) -> Result<(), String> {
        apply_header_overrides(self, api_format.into(), headers, context)
    }

    pub fn apply_headers_for_target(
        &self,
        headers: &mut HeaderMap,
        target: RequestOverrideTarget,
        context: &RequestOverrideContext,
    ) -> Result<(), String> {
        apply_header_overrides(self, target, headers, context)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RequestHeaderOverride {
    #[serde(default)]
    pub scope: RequestOverrideScope,
    #[serde(default)]
    pub operation: RequestOverrideOperation,
    pub name: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RequestBodyOverride {
    #[serde(default)]
    pub scope: RequestOverrideScope,
    #[serde(default)]
    pub operation: RequestOverrideOperation,
    pub path: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Hash, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestOverrideScope {
    #[default]
    All,
    ChatCompletions,
    Responses,
}

impl RequestOverrideScope {
    fn matches(self, target: RequestOverrideTarget) -> bool {
        match self {
            Self::All => true,
            Self::ChatCompletions => target == RequestOverrideTarget::ChatCompletions,
            Self::Responses => target == RequestOverrideTarget::Responses,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestOverrideOperation {
    #[default]
    Set,
    Remove,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestOverrideTarget {
    Models,
    ChatCompletions,
    Responses,
}

impl From<ApiFormat> for RequestOverrideTarget {
    fn from(value: ApiFormat) -> Self {
        match value {
            ApiFormat::ChatCompletions => Self::ChatCompletions,
            ApiFormat::Responses => Self::Responses,
        }
    }
}

fn target_specific_scope(target: RequestOverrideTarget) -> Option<RequestOverrideScope> {
    match target {
        RequestOverrideTarget::Models => None,
        RequestOverrideTarget::ChatCompletions => Some(RequestOverrideScope::ChatCompletions),
        RequestOverrideTarget::Responses => Some(RequestOverrideScope::Responses),
    }
}

#[derive(Clone, Debug)]
pub struct RequestOverrideContext {
    request_id: String,
}

impl RequestOverrideContext {
    pub fn new() -> Self {
        Self {
            request_id: Ulid::new().to_string(),
        }
    }

    #[cfg(test)]
    fn with_request_id(request_id: &str) -> Self {
        Self {
            request_id: request_id.to_string(),
        }
    }
}

pub fn validate_request_overrides(overrides: &RequestOverrides) -> Result<(), String> {
    let encoded = serde_json::to_vec(overrides)
        .map_err(|error| format!("request overrides could not be encoded: {error}"))?;
    if encoded.len() > MAX_CONFIG_BYTES {
        return Err(format!(
            "request overrides exceed the {MAX_CONFIG_BYTES} byte limit"
        ));
    }
    if overrides.headers.len() > MAX_HEADER_OVERRIDES {
        return Err(format!(
            "request header overrides exceed the {MAX_HEADER_OVERRIDES} rule limit"
        ));
    }
    if overrides.body.len() > MAX_BODY_OVERRIDES {
        return Err(format!(
            "request body overrides exceed the {MAX_BODY_OVERRIDES} rule limit"
        ));
    }

    let mut seen_headers = HashSet::new();
    for rule in &overrides.headers {
        let name = rule.name.trim();
        let parsed_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| format!("invalid request override header {name:?}: {error}"))?;
        if is_reserved_header(&parsed_name) {
            return Err(format!(
                "request override header {} is managed by the gateway",
                parsed_name.as_str()
            ));
        }
        if rule.value.len() > MAX_HEADER_VALUE_BYTES {
            return Err(format!(
                "request override header {} exceeds the {MAX_HEADER_VALUE_BYTES} byte value limit",
                parsed_name.as_str()
            ));
        }
        if rule.operation == RequestOverrideOperation::Set {
            HeaderValue::from_str(&rule.value).map_err(|error| {
                format!(
                    "invalid value for request override header {}: {error}",
                    parsed_name.as_str()
                )
            })?;
        }
        let key = (rule.scope, parsed_name.as_str().to_ascii_lowercase());
        if !seen_headers.insert(key) {
            return Err(format!(
                "duplicate request override header {} in the same scope",
                parsed_name.as_str()
            ));
        }
    }

    let mut seen_body_paths = HashSet::new();
    for rule in &overrides.body {
        let segments = body_path_segments(&rule.path)?;
        let first = segments.first().map(String::as_str).unwrap_or_default();
        if is_reserved_body_root(first) {
            return Err(format!(
                "request body field {first} is managed by the gateway"
            ));
        }
        if rule.operation == RequestOverrideOperation::Set {
            let encoded_value = serde_json::to_vec(&rule.value)
                .map_err(|error| format!("request body override value is invalid: {error}"))?;
            if encoded_value.len() > MAX_BODY_VALUE_BYTES {
                return Err(format!(
                    "request body override {} exceeds the {MAX_BODY_VALUE_BYTES} byte value limit",
                    rule.path.trim()
                ));
            }
        }
        let canonical_path = segments.join(".");
        if !seen_body_paths.insert((rule.scope, canonical_path.clone())) {
            return Err(format!(
                "duplicate request body override path {canonical_path} in the same scope"
            ));
        }
    }

    Ok(())
}

pub fn apply_body_overrides(
    overrides: &RequestOverrides,
    target: RequestOverrideTarget,
    body: Bytes,
    context: &RequestOverrideContext,
) -> Result<Bytes, String> {
    if !overrides.body.iter().any(|rule| rule.scope.matches(target)) {
        return Ok(body);
    }

    let mut value: Value = serde_json::from_slice(&body)
        .map_err(|error| format!("request body is not valid JSON: {error}"))?;
    apply_body_overrides_to_value(overrides, target, &mut value, context)?;
    serde_json::to_vec(&value)
        .map(Bytes::from)
        .map_err(|error| format!("request body overrides could not be encoded: {error}"))
}

pub fn apply_body_overrides_to_value(
    overrides: &RequestOverrides,
    target: RequestOverrideTarget,
    value: &mut Value,
    context: &RequestOverrideContext,
) -> Result<(), String> {
    for scope in [
        Some(RequestOverrideScope::All),
        target_specific_scope(target),
    ]
    .into_iter()
    .flatten()
    {
        for rule in overrides.body.iter().filter(|rule| rule.scope == scope) {
            let segments = body_path_segments(&rule.path)?;
            match rule.operation {
                RequestOverrideOperation::Set => {
                    let expanded = expand_value_templates(&rule.value, context);
                    set_body_path(value, &segments, expanded)?;
                }
                RequestOverrideOperation::Remove => remove_body_path(value, &segments),
            }
        }
    }
    Ok(())
}

pub fn apply_header_overrides(
    overrides: &RequestOverrides,
    target: RequestOverrideTarget,
    headers: &mut HeaderMap,
    context: &RequestOverrideContext,
) -> Result<(), String> {
    for scope in [
        Some(RequestOverrideScope::All),
        target_specific_scope(target),
    ]
    .into_iter()
    .flatten()
    {
        for rule in overrides.headers.iter().filter(|rule| rule.scope == scope) {
            let name = HeaderName::from_bytes(rule.name.trim().as_bytes())
                .map_err(|error| format!("invalid request override header: {error}"))?;
            match rule.operation {
                RequestOverrideOperation::Set => {
                    let expanded = expand_template(&rule.value, context);
                    let value = HeaderValue::from_str(&expanded).map_err(|error| {
                        format!(
                            "invalid value for request override header {}: {error}",
                            name.as_str()
                        )
                    })?;
                    headers.insert(name, value);
                }
                RequestOverrideOperation::Remove => {
                    headers.remove(name);
                }
            }
        }
    }
    Ok(())
}

fn is_reserved_header(name: &HeaderName) -> bool {
    let value = name.as_str();
    if value.starts_with("sec-websocket-") || value.starts_with("x-forwarded-") {
        return true;
    }

    [
        AUTHORIZATION.as_str(),
        CONNECTION.as_str(),
        CONTENT_LENGTH.as_str(),
        HOST.as_str(),
        PROXY_AUTHENTICATE.as_str(),
        PROXY_AUTHORIZATION.as_str(),
        TE.as_str(),
        TRAILER.as_str(),
        TRANSFER_ENCODING.as_str(),
        UPGRADE.as_str(),
        "accept-encoding",
        "content-encoding",
        "expect",
        "keep-alive",
        "proxy-connection",
        "cookie",
        "set-cookie",
        "x-api-key",
        "api-key",
        "x-goog-api-key",
        "chatgpt-account-id",
        "forwarded",
        "via",
        "x-real-ip",
        "cf-connecting-ip",
        "cf-ray",
        "cdn-loop",
        "true-client-ip",
        "x-http-method-override",
        "x-http-method",
        "x-method-override",
        "x-original-host",
        "x-original-url",
        "x-original-uri",
        "x-rewrite-url",
        "x-envoy-original-path",
    ]
    .iter()
    .any(|reserved| value.eq_ignore_ascii_case(reserved))
}

fn is_reserved_body_root(value: &str) -> bool {
    ["model", "stream", "type"]
        .iter()
        .any(|reserved| value.eq_ignore_ascii_case(reserved))
}

fn body_path_segments(path: &str) -> Result<Vec<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("request body override path is empty".to_string());
    }
    if trimmed.len() > MAX_BODY_PATH_BYTES {
        return Err(format!(
            "request body override path exceeds the {MAX_BODY_PATH_BYTES} byte limit"
        ));
    }
    let segments = trimmed
        .split('.')
        .map(str::trim)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if segments.len() > MAX_BODY_PATH_DEPTH {
        return Err(format!(
            "request body override path exceeds the {MAX_BODY_PATH_DEPTH} segment limit"
        ));
    }
    if segments.iter().any(String::is_empty) {
        return Err(format!(
            "request body override path {trimmed:?} contains an empty segment"
        ));
    }
    Ok(segments)
}

fn set_body_path(value: &mut Value, segments: &[String], replacement: Value) -> Result<(), String> {
    let Some((last, parents)) = segments.split_last() else {
        return Err("request body override path is empty".to_string());
    };
    let Some(mut current) = value.as_object_mut() else {
        return Err("request body overrides require a JSON object body".to_string());
    };

    for segment in parents {
        let entry = current
            .entry(segment.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        let Some(next) = entry.as_object_mut() else {
            return Err(format!(
                "request body override path could not create object segment {segment}"
            ));
        };
        current = next;
    }
    current.insert(last.clone(), replacement);
    Ok(())
}

fn remove_body_path(value: &mut Value, segments: &[String]) {
    let Some((last, parents)) = segments.split_last() else {
        return;
    };
    let Some(mut current) = value.as_object_mut() else {
        return;
    };
    for segment in parents {
        let Some(next) = current.get_mut(segment).and_then(Value::as_object_mut) else {
            return;
        };
        current = next;
    }
    current.remove(last);
}

fn expand_value_templates(value: &Value, context: &RequestOverrideContext) -> Value {
    match value {
        Value::String(value) => Value::String(expand_template(value, context)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| expand_value_templates(value, context))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), expand_value_templates(value, context)))
                .collect(),
        ),
        value => value.clone(),
    }
}

fn expand_template(value: &str, context: &RequestOverrideContext) -> String {
    value.replace(REQUEST_ID_TEMPLATE, &context.request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn codex_overrides() -> RequestOverrides {
        RequestOverrides {
            headers: vec![RequestHeaderOverride {
                scope: RequestOverrideScope::All,
                operation: RequestOverrideOperation::Set,
                name: "x-codex-window-id".to_string(),
                value: REQUEST_ID_TEMPLATE.to_string(),
            }],
            body: vec![RequestBodyOverride {
                scope: RequestOverrideScope::Responses,
                operation: RequestOverrideOperation::Set,
                path: "client_metadata.x-codex-window-id".to_string(),
                value: Value::String(REQUEST_ID_TEMPLATE.to_string()),
            }],
        }
    }

    #[test]
    fn validate_request_overrides_accepts_codex_identity_rules() {
        assert!(validate_request_overrides(&codex_overrides()).is_ok());
    }

    #[test]
    fn validate_request_overrides_rejects_gateway_managed_headers() {
        for name in [
            "Authorization",
            "Accept-Encoding",
            "X-Forwarded-For",
            "Sec-WebSocket-Key",
            "X-HTTP-Method-Override",
        ] {
            let overrides = RequestOverrides {
                headers: vec![RequestHeaderOverride {
                    scope: RequestOverrideScope::All,
                    operation: RequestOverrideOperation::Set,
                    name: name.to_string(),
                    value: "blocked".to_string(),
                }],
                body: Vec::new(),
            };

            let error = validate_request_overrides(&overrides).unwrap_err();

            assert!(error.contains("managed by the gateway"), "{name}: {error}");
        }
    }

    #[test]
    fn validate_request_overrides_rejects_routing_body_fields() {
        let overrides = RequestOverrides {
            headers: Vec::new(),
            body: vec![RequestBodyOverride {
                scope: RequestOverrideScope::Responses,
                operation: RequestOverrideOperation::Set,
                path: "model".to_string(),
                value: json!("different-model"),
            }],
        };

        let error = validate_request_overrides(&overrides).unwrap_err();

        assert!(error.contains("managed by the gateway"));
    }

    #[test]
    fn apply_body_overrides_sets_nested_values_and_expands_request_id() {
        let context = RequestOverrideContext::with_request_id("request-123");
        let mut value = json!({"model":"gpt-5.6-sol","input":[]});

        apply_body_overrides_to_value(
            &codex_overrides(),
            RequestOverrideTarget::Responses,
            &mut value,
            &context,
        )
        .expect("apply body overrides");

        assert_eq!(
            value.pointer("/client_metadata/x-codex-window-id"),
            Some(&json!("request-123"))
        );
    }

    #[test]
    fn apply_body_overrides_skips_rules_for_other_api_formats() {
        let context = RequestOverrideContext::with_request_id("request-123");
        let mut value = json!({"messages":[]});

        apply_body_overrides_to_value(
            &codex_overrides(),
            RequestOverrideTarget::ChatCompletions,
            &mut value,
            &context,
        )
        .expect("apply body overrides");

        assert_eq!(value, json!({"messages":[]}));
    }

    #[test]
    fn apply_header_overrides_replaces_templates() {
        let context = RequestOverrideContext::with_request_id("request-123");
        let mut headers = HeaderMap::new();

        apply_header_overrides(
            &codex_overrides(),
            RequestOverrideTarget::Responses,
            &mut headers,
            &context,
        )
        .expect("apply header overrides");

        assert_eq!(
            headers
                .get("x-codex-window-id")
                .and_then(|value| value.to_str().ok()),
            Some("request-123")
        );
    }

    #[test]
    fn api_specific_header_rules_override_all_scope_regardless_of_storage_order() {
        let overrides = RequestOverrides {
            headers: vec![
                RequestHeaderOverride {
                    scope: RequestOverrideScope::Responses,
                    operation: RequestOverrideOperation::Set,
                    name: "x-client-mode".to_string(),
                    value: "responses".to_string(),
                },
                RequestHeaderOverride {
                    scope: RequestOverrideScope::All,
                    operation: RequestOverrideOperation::Set,
                    name: "x-client-mode".to_string(),
                    value: "all".to_string(),
                },
            ],
            body: Vec::new(),
        };
        let mut headers = HeaderMap::new();

        apply_header_overrides(
            &overrides,
            RequestOverrideTarget::Responses,
            &mut headers,
            &RequestOverrideContext::with_request_id("request-123"),
        )
        .expect("apply layered headers");

        assert_eq!(
            headers
                .get("x-client-mode")
                .and_then(|value| value.to_str().ok()),
            Some("responses")
        );
    }

    #[test]
    fn api_specific_body_rules_override_all_scope_regardless_of_storage_order() {
        let overrides = RequestOverrides {
            headers: Vec::new(),
            body: vec![
                RequestBodyOverride {
                    scope: RequestOverrideScope::Responses,
                    operation: RequestOverrideOperation::Set,
                    path: "client_metadata.mode".to_string(),
                    value: json!("responses"),
                },
                RequestBodyOverride {
                    scope: RequestOverrideScope::All,
                    operation: RequestOverrideOperation::Set,
                    path: "client_metadata.mode".to_string(),
                    value: json!("all"),
                },
            ],
        };
        let mut value = json!({});

        apply_body_overrides_to_value(
            &overrides,
            RequestOverrideTarget::Responses,
            &mut value,
            &RequestOverrideContext::with_request_id("request-123"),
        )
        .expect("apply layered body overrides");

        assert_eq!(
            value.pointer("/client_metadata/mode"),
            Some(&json!("responses"))
        );
    }

    #[test]
    fn all_scope_headers_apply_to_model_inventory_requests() {
        let context = RequestOverrideContext::with_request_id("request-123");
        let mut headers = HeaderMap::new();

        apply_header_overrides(
            &codex_overrides(),
            RequestOverrideTarget::Models,
            &mut headers,
            &context,
        )
        .expect("apply model inventory headers");

        assert_eq!(
            headers
                .get("x-codex-window-id")
                .and_then(|value| value.to_str().ok()),
            Some("request-123")
        );
    }

    #[test]
    fn request_overrides_storage_round_trip_preserves_rules() {
        let overrides = codex_overrides();

        let decoded = RequestOverrides::from_storage(&overrides.to_storage());

        assert_eq!(decoded, overrides);
    }
}
