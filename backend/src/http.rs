use std::convert::Infallible;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, CONTENT_TYPE};
use hyper::{Request, Response, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type HttpBody = BoxBody<Bytes, BoxError>;
pub type HttpResponse = Response<HttpBody>;

pub fn empty(status: StatusCode) -> HttpResponse {
    Response::builder()
        .status(status)
        .body(full(Bytes::new(), None))
        .expect("response builder")
}

pub fn text(status: StatusCode, body: impl Into<Bytes>) -> HttpResponse {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(full(body.into(), None))
        .expect("response builder")
}

pub fn json<T: Serialize>(status: StatusCode, value: &T) -> HttpResponse {
    let bytes = match serde_json::to_vec(value) {
        Ok(v) => Bytes::from(v),
        Err(_) => Bytes::from_static(b"{\"error\":\"json_encode_failed\"}"),
    };
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .body(full(bytes, None))
        .expect("response builder")
}

pub fn json_error(status: StatusCode, message: impl Into<String>) -> HttpResponse {
    #[derive(Serialize)]
    struct ErrBody {
        error: String,
    }
    json(
        status,
        &ErrBody {
            error: message.into(),
        },
    )
}

pub fn bearer_token(req: &Request<Incoming>) -> Option<&str> {
    let raw = req.headers().get(AUTHORIZATION)?.to_str().ok()?;
    let raw = raw.trim();
    let rest = raw.strip_prefix("Bearer ")?;
    if rest.is_empty() {
        return None;
    }
    Some(rest)
}

pub async fn read_body_limited(
    req: Request<Incoming>,
    max_bytes: usize,
) -> Result<(hyper::http::request::Parts, Bytes), HttpResponse> {
    let (parts, body) = req.into_parts();
    let limited = Limited::new(body, max_bytes);
    let collected = limited.collect().await.map_err(|e| {
        json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("request body too large: {e}"),
        )
    })?;
    Ok((parts, collected.to_bytes()))
}

pub async fn read_json_limited<T: DeserializeOwned>(
    req: Request<Incoming>,
    max_bytes: usize,
) -> Result<(hyper::http::request::Parts, T, Bytes), HttpResponse> {
    let (parts, bytes) = read_body_limited(req, max_bytes).await?;
    let parsed = serde_json::from_slice::<T>(&bytes)
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, format!("invalid json: {e}")))?;
    Ok((parts, parsed, bytes))
}

pub fn full(bytes: Bytes, _hint: Option<usize>) -> HttpBody {
    // Map Infallible into BoxError.
    Full::new(bytes)
        .map_err(|never: Infallible| -> BoxError { match never {} })
        .boxed()
}

pub fn boxed<B>(body: B) -> HttpBody
where
    B: hyper::body::Body<Data = Bytes> + Send + Sync + 'static,
    B::Error: Into<BoxError>,
{
    body.map_err(Into::into).boxed()
}
