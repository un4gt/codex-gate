use std::convert::Infallible;

use bytes::Bytes;
use hyper::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, HeaderValue, X_CONTENT_TYPE_OPTIONS,
};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as H12AutoBuilder;
use tokio::net::TcpListener;

use crate::http::{self, HttpResponse};
use crate::state::SharedState;

pub fn spawn(state: SharedState) {
    tokio::spawn(async move {
        let addr = state.config.codex_oauth_callback_listen_addr;
        let listener = match TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(error) => {
                log::warn!(
                    "Codex OAuth callback listener unavailable on {}: {}. Manual callback submission remains available.",
                    addr,
                    error
                );
                return;
            }
        };
        log::info!("Codex OAuth callback listener on {}", addr);

        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(connection) => connection,
                Err(error) => {
                    log::warn!("Codex OAuth callback accept failed: {}", error);
                    continue;
                }
            };
            let io = TokioIo::new(stream);
            let state = state.clone();
            tokio::spawn(async move {
                let service = service_fn(move |request| handle(request, state.clone()));
                if let Err(error) = H12AutoBuilder::new(TokioExecutor::new())
                    .serve_connection(io, service)
                    .await
                {
                    log::warn!(
                        "error serving Codex OAuth callback connection from {}: {}",
                        peer,
                        error
                    );
                }
            });
        }
    });
}

async fn handle(
    request: Request<hyper::body::Incoming>,
    state: SharedState,
) -> Result<HttpResponse, Infallible> {
    if request.method() != Method::GET {
        return Ok(callback_page(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method Not Allowed",
            "Return to the admin console and start sign-in again.",
        ));
    }
    if request.uri().path() != "/auth/callback" {
        return Ok(callback_page(
            StatusCode::NOT_FOUND,
            "Callback Not Found",
            "Return to the admin console and start sign-in again.",
        ));
    }
    let path_and_query = request
        .uri()
        .path_and_query()
        .map_or("/auth/callback", |value| value.as_str());
    let redirect_url = format!("http://localhost:1455{path_and_query}");
    let response = match state
        .codex_oauth
        .submit_callback_url(state.clone(), &redirect_url)
        .await
    {
        Ok(_) => callback_page(
            StatusCode::OK,
            "Codex Sign-In Received",
            "You can close this tab and return to the admin console.",
        ),
        Err(error) => {
            log::warn!("Codex OAuth callback rejected: {}", error.code);
            callback_page(
                error.http_status(),
                "Codex Sign-In Could Not Be Completed",
                "Return to the admin console to retry or submit the callback URL manually.",
            )
        }
    };
    Ok(response)
}

fn callback_page(status: StatusCode, title: &str, message: &str) -> HttpResponse {
    let body = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>body{{margin:0;background:#111;color:#eee;font:16px/1.6 system-ui,sans-serif}}main{{max-width:42rem;margin:12vh auto;padding:2rem;border:1px solid #444}}h1{{font-size:1.4rem;margin:0 0 1rem}}p{{color:#bbb;margin:0}}</style></head><body><main><h1>{title}</h1><p>{message}</p></main></body></html>"
    );
    let mut response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header("referrer-policy", "no-referrer")
        .body(http::full(Bytes::from(body), None))
        .expect("OAuth callback response builder");
    response.headers_mut().insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        ),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn callback_page_never_caches_or_embeds_callback_secrets() {
        let response = callback_page(
            StatusCode::OK,
            "Codex Sign-In Received",
            "You can close this tab.",
        );
        assert_eq!(
            response.headers().get(CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );
        let body = http_body_util::BodyExt::collect(response.into_body())
            .await
            .expect("callback body")
            .to_bytes();
        let body = String::from_utf8(body.to_vec()).expect("UTF-8 callback body");
        assert!(!body.contains("code="));
        assert!(!body.contains("state="));
    }
}
