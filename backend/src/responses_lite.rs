//! Enforce the Responses Lite wire contract after provider overrides.

use bytes::Bytes;
use hyper::HeaderMap;
use hyper::header::{CONTENT_LENGTH, HeaderValue};
use serde_json::{Map, Value};

pub const HEADER: &str = "x-openai-internal-codex-responses-lite";

pub fn enabled(headers: &HeaderMap) -> bool {
    headers.get_all(HEADER).iter().any(|value| {
        value
            .to_str()
            .is_ok_and(|value| value.trim().eq_ignore_ascii_case("true"))
    })
}

pub fn normalize_object(root: &mut Map<String, Value>) {
    // Lite requires an explicit false even when tools or the parameter are absent.
    root.insert("parallel_tool_calls".into(), Value::Bool(false));
}

pub fn normalize_http_body(headers: &mut HeaderMap, body: Bytes) -> Result<Bytes, String> {
    if !enabled(headers) {
        return Ok(body);
    }
    let mut root: Map<String, Value> = serde_json::from_slice(&body)
        .map_err(|error| format!("invalid Responses Lite request: {error}"))?;
    normalize_object(&mut root);
    let body = serde_json::to_vec(&root).map_err(|error| error.to_string())?;
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&body.len().to_string()).map_err(|error| error.to_string())?,
    );
    Ok(Bytes::from(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lite_requires_false_with_or_without_tools_and_preserves_other_fields() {
        for parallel in [
            None,
            Some(json!(true)),
            Some(json!(false)),
            Some(Value::Null),
        ] {
            for tools in [
                None,
                Some(json!([])),
                Some(json!([{"type": "image_generation"}])),
            ] {
                let mut original = json!({"model": "m", "input": "中文", "stream": false});
                if let Some(value) = parallel.clone() {
                    original["parallel_tool_calls"] = value;
                }
                if let Some(value) = tools {
                    original["tools"] = value;
                }
                let mut headers = HeaderMap::new();
                headers.insert(HEADER, HeaderValue::from_static("true"));
                headers.insert(CONTENT_LENGTH, HeaderValue::from_static("999"));
                let body = normalize_http_body(
                    &mut headers,
                    Bytes::from(serde_json::to_vec(&original).unwrap()),
                )
                .unwrap();
                original["parallel_tool_calls"] = json!(false);
                assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), original);
                assert_eq!(headers[HEADER], "true");
                assert_eq!(headers[CONTENT_LENGTH], body.len().to_string());
            }
        }
    }

    #[test]
    fn non_lite_requests_keep_exact_body_and_headers() {
        for value in [None, Some("false"), Some("")] {
            let mut headers = HeaderMap::new();
            if let Some(value) = value {
                headers.insert(HEADER, HeaderValue::from_static(value));
            }
            let before = headers.clone();
            let body = Bytes::from_static(br#"{ "parallel_tool_calls": true }"#);
            assert_eq!(
                normalize_http_body(&mut headers, body.clone()).unwrap(),
                body
            );
            assert_eq!(headers, before);
        }
    }

    #[test]
    fn lite_header_handles_case_and_repeated_values_and_rejects_invalid_body() {
        let mut headers = HeaderMap::new();
        headers.append(HEADER, HeaderValue::from_static("false"));
        headers.append(HEADER, HeaderValue::from_static(" TRUE "));
        assert!(enabled(&headers));
        for body in ["[]", "null", "invalid"] {
            assert!(normalize_http_body(&mut headers, Bytes::from(body)).is_err());
        }
    }
}
