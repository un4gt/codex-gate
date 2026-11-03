use hyper::HeaderMap;
use hyper::header::{AUTHORIZATION, HeaderName, HeaderValue};

pub const VERSION: &str = "2023-06-01";
const X_API_KEY: HeaderName = HeaderName::from_static("x-api-key");

/// Anthropic upstream credentials always use `x-api-key`.
/// This is separate from the gateway's inbound client auth, which also accepts
/// `Authorization: Bearer` because Claude Code uses ANTHROPIC_AUTH_TOKEN.
pub fn apply_upstream_auth(headers: &mut HeaderMap, secret: &str) {
    headers.remove(AUTHORIZATION);
    if let Ok(value) = HeaderValue::from_str(secret) {
        headers.insert(X_API_KEY, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_upstream_auth_always_uses_x_api_key() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer client"));
        apply_upstream_auth(&mut headers, "sk-ant-secret");
        assert_eq!(headers.get(&X_API_KEY).unwrap(), "sk-ant-secret");
        assert!(headers.get(AUTHORIZATION).is_none());
    }
}
