use hyper::Uri;
use hyper::http::uri::PathAndQuery;

const DEFAULT_API_BASE_PATH: &str = "/v1";

pub(crate) fn normalize_base_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("invalid base_url".to_string());
    }

    let uri = trimmed
        .parse::<Uri>()
        .map_err(|_| "invalid base_url".to_string())?;
    if !matches!(uri.scheme_str(), Some("http" | "https")) || uri.authority().is_none() {
        return Err("invalid base_url".to_string());
    }
    if uri.path_and_query().and_then(PathAndQuery::query).is_some() {
        return Err("invalid base_url: query parameters are not allowed".to_string());
    }

    Ok(trimmed.trim_end_matches('/').to_string())
}

pub(crate) fn build_upstream_uri(
    base_url: &str,
    endpoint_path_and_query: &str,
) -> Result<Uri, String> {
    let normalized = normalize_base_url(base_url)?;
    let base_uri = normalized
        .parse::<Uri>()
        .map_err(|_| "invalid base_url".to_string())?;
    let endpoint = endpoint_path_and_query
        .parse::<PathAndQuery>()
        .map_err(|error| format!("invalid upstream endpoint path: {error}"))?;
    if endpoint.path() == "/" || !endpoint.path().starts_with('/') {
        return Err("invalid upstream endpoint path".to_string());
    }

    let configured_path = base_uri.path().trim_end_matches('/');
    let api_base_path = if configured_path.is_empty() {
        DEFAULT_API_BASE_PATH
    } else {
        configured_path
    };
    let mut combined = String::with_capacity(
        api_base_path.len() + endpoint.path().len() + endpoint.query().map_or(0, str::len) + 1,
    );
    combined.push_str(api_base_path);
    combined.push_str(endpoint.path());
    if let Some(query) = endpoint.query() {
        combined.push('?');
        combined.push_str(query);
    }

    let mut parts = base_uri.into_parts();
    parts.path_and_query = Some(
        combined
            .parse::<PathAndQuery>()
            .map_err(|error| format!("invalid upstream path: {error}"))?,
    );
    Uri::from_parts(parts).map_err(|error| error.to_string())
}

pub(crate) fn build_upstream_websocket_url(
    base_url: &str,
    endpoint_path_and_query: &str,
) -> Result<String, String> {
    let uri = build_upstream_uri(base_url, endpoint_path_and_query)?;
    let mut parts = uri.into_parts();
    let websocket_scheme = match parts.scheme.as_ref().map(|scheme| scheme.as_str()) {
        Some("http") => "ws",
        Some("https") => "wss",
        Some(other) => return Err(format!("unsupported upstream scheme: {other}")),
        None => return Err("missing upstream scheme".to_string()),
    };
    parts.scheme = Some(
        websocket_scheme
            .parse()
            .map_err(|error| format!("invalid upstream scheme: {error}"))?,
    );
    Uri::from_parts(parts)
        .map(|uri| uri.to_string())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_should_add_default_v1_for_bare_origin() {
        let uri = build_upstream_uri("https://api.openai.com", "/models").expect("uri");

        assert_eq!(uri, "https://api.openai.com/v1/models");
    }

    #[test]
    fn models_should_preserve_configured_v1_prefix() {
        let uri = build_upstream_uri("http://127.0.0.1:8317/v1", "/models").expect("uri");

        assert_eq!(uri, "http://127.0.0.1:8317/v1/models");
    }

    #[test]
    fn models_should_preserve_vendor_api_prefix() {
        let uri = build_upstream_uri("https://ark.cn-beijing.volces.com/api/coding/v3", "/models")
            .expect("uri");

        assert_eq!(
            uri,
            "https://ark.cn-beijing.volces.com/api/coding/v3/models"
        );
    }

    #[test]
    fn models_should_ignore_trailing_slash_on_custom_prefix() {
        let uri = build_upstream_uri("https://open.bigmodel.cn/api/coding/paas/v4/", "/models")
            .expect("uri");

        assert_eq!(uri, "https://open.bigmodel.cn/api/coding/paas/v4/models");
    }

    #[test]
    fn chat_should_preserve_custom_version_prefix() {
        let uri = build_upstream_uri("https://gateway.example.com/openai/v2", "/chat/completions")
            .expect("uri");

        assert_eq!(
            uri,
            "https://gateway.example.com/openai/v2/chat/completions"
        );
    }

    #[test]
    fn responses_should_preserve_request_query() {
        let uri = build_upstream_uri(
            "https://gateway.example.com/openai/v3",
            "/responses?trace=true",
        )
        .expect("uri");

        assert_eq!(
            uri,
            "https://gateway.example.com/openai/v3/responses?trace=true"
        );
    }

    #[test]
    fn websocket_should_preserve_custom_api_prefix() {
        let url =
            build_upstream_websocket_url("https://gateway.example.com/api/coding/v3", "/responses")
                .expect("url");

        assert_eq!(url, "wss://gateway.example.com/api/coding/v3/responses");
    }

    #[test]
    fn normalize_should_reject_base_url_query() {
        let error = normalize_base_url("https://api.example.com/v1?api-version=1")
            .expect_err("query should be rejected");

        assert_eq!(error, "invalid base_url: query parameters are not allowed");
    }

    #[test]
    fn normalize_should_reject_unsupported_scheme() {
        let error =
            normalize_base_url("ftp://api.example.com/v1").expect_err("scheme should be rejected");

        assert_eq!(error, "invalid base_url");
    }

    #[test]
    fn normalize_should_reject_relative_url() {
        let error =
            normalize_base_url("api.example.com/v1").expect_err("relative URL should be rejected");

        assert_eq!(error, "invalid base_url");
    }
}
