mod admin;
mod cache;
mod codex_oauth;
mod config;
mod crypto;
mod db;
mod health;
mod http;
mod log_archive;
mod metrics;
mod openai;
mod proxy;
mod selector;
mod state;
mod telemetry;
mod types;
mod upstream;
mod util;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use hyper::header::{CACHE_CONTROL, CONTENT_TYPE};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as H12AutoBuilder;
use tokio::net::TcpListener;

use crate::http::HttpResponse;
use crate::state::{AppState, SharedState};

#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(all(feature = "jemalloc", not(feature = "mimalloc")))]
#[global_allocator]
static GLOBAL: jemallocator::Jemalloc = jemallocator::Jemalloc;

async fn handle(
    req: Request<hyper::body::Incoming>,
    state: SharedState,
) -> Result<HttpResponse, Infallible> {
    let path = req.uri().path();

    if req.method() == hyper::Method::GET && path == "/healthz" {
        return Ok(crate::http::text(StatusCode::OK, "ok\n"));
    }
    if req.method() == hyper::Method::GET && path == "/readyz" {
        let ready = state.db.ping().await.is_ok();
        return Ok(if ready {
            crate::http::text(StatusCode::OK, "ready\n")
        } else {
            crate::http::text(StatusCode::SERVICE_UNAVAILABLE, "not ready\n")
        });
    }
    if req.method() == hyper::Method::GET && path == "/metrics" {
        let body = crate::metrics::render_prometheus(&state).await;
        let response = Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")
            .body(crate::http::full(Bytes::from(body), None))
            .expect("metrics response builder");
        return Ok(response);
    }

    if req.method() == hyper::Method::GET && path == "/api/v1/codex-oauth/callback" {
        return Ok(crate::codex_oauth::handle_callback(req, state).await);
    }

    if path.starts_with("/api/v1/") {
        return Ok(crate::admin::handle(req, state).await);
    }

    if path.starts_with("/v1/") {
        return Ok(crate::proxy::handle(req, state).await);
    }

    Ok(serve_static(req, state).await)
}

fn sanitize_static_path(raw_path: &str) -> Option<PathBuf> {
    let trimmed = raw_path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Some(PathBuf::new());
    }

    let mut out = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

fn guess_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "webp" => "image/webp",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn cache_control_for(path: &Path) -> &'static str {
    if matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("html")
    ) {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    }
}

fn static_response(path: &Path, body: Bytes) -> HttpResponse {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, guess_content_type(path))
        .header(CACHE_CONTROL, cache_control_for(path))
        .body(crate::http::full(body, None))
        .expect("static response builder")
}

async fn serve_static(req: Request<hyper::body::Incoming>, state: SharedState) -> HttpResponse {
    if req.method() != hyper::Method::GET && req.method() != hyper::Method::HEAD {
        return crate::http::json_error(StatusCode::NOT_FOUND, "not found");
    }

    let base_dir = PathBuf::from(&state.config.static_dir);
    let request_path = req.uri().path();
    let Some(safe_path) = sanitize_static_path(request_path) else {
        return crate::http::json_error(StatusCode::BAD_REQUEST, "invalid path");
    };

    let wants_index = request_path == "/" || request_path.ends_with('/');
    let requested_file = if wants_index {
        base_dir.join("index.html")
    } else {
        base_dir.join(&safe_path)
    };

    let candidate = match tokio::fs::metadata(&requested_file).await {
        Ok(meta) if meta.is_file() => Some(requested_file),
        _ => None,
    };

    let file_to_serve = match candidate {
        Some(path) => path,
        None if !request_path.contains('.') => base_dir.join("index.html"),
        None => return crate::http::json_error(StatusCode::NOT_FOUND, "not found"),
    };

    match tokio::fs::read(&file_to_serve).await {
        Ok(bytes) => {
            let body = if req.method() == hyper::Method::HEAD {
                Bytes::new()
            } else {
                Bytes::from(bytes)
            };
            static_response(&file_to_serve, body)
        }
        Err(err) if file_to_serve.ends_with("index.html") => {
            log::warn!(
                "static index missing at {}: {}",
                file_to_serve.display(),
                err
            );
            crate::http::json_error(StatusCode::NOT_FOUND, "not found")
        }
        Err(err) => {
            log::warn!(
                "failed to read static asset {}: {}",
                file_to_serve.display(),
                err
            );
            crate::http::json_error(StatusCode::NOT_FOUND, "not found")
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let config = config::Config::from_env().map_err(|e| format!("config error: {e}"))?;

    if config.db_dsn.starts_with("sqlite:") {
        let _ = tokio::fs::create_dir_all("./data").await;
    }
    let _ = tokio::fs::create_dir_all(&config.static_dir).await;
    if config.request_log_archive_enabled {
        let _ = tokio::fs::create_dir_all(&config.request_log_archive_dir).await;
    }

    let db = db::Database::connect(&config.db_dsn, config.db_max_connections).await?;
    db.migrate().await?;

    let caches = cache::Caches::new(
        config.api_key_cache_ttl,
        config.upstream_cache_ttl,
        config.upstream_cache_stale_grace,
        config.api_key_cache_max_entries,
    );

    let retention = telemetry::RetentionPolicy::new(
        config.request_log_retention_days,
        config.stats_daily_retention_days,
        config.retention_cleanup_interval,
        config.retention_delete_batch,
        config.request_log_archive_enabled,
        config.request_log_archive_dir.clone(),
        config.request_log_archive_compress,
    );
    let telemetry = telemetry::Telemetry::start(
        db.clone(),
        config.stats_flush_interval,
        config.log_queue_capacity,
        retention,
    )
    .await?;
    let upstream = upstream::new_upstream_client(config.upstream_connect_timeout)
        .map_err(|e| format!("upstream client: {e}"))?;
    let endpoint_health = Arc::new(health::EndpointHealthBook::new(
        config.circuit_breaker_failure_threshold,
        config.circuit_breaker_open_ms,
    ));
    let upstream_key_health = Arc::new(health::UpstreamKeyHealthBook::new(
        config.circuit_breaker_failure_threshold,
        config.circuit_breaker_open_ms,
    ));

    let metrics = Arc::new(metrics::Metrics::new());
    let codex_oauth = codex_oauth::CodexOauthManager::new();

    let state: SharedState = Arc::new(AppState {
        config,
        db,
        caches,
        telemetry,
        upstream,
        endpoint_health,
        upstream_key_health,
        metrics,
        codex_oauth,
    });

    let addr: SocketAddr = state.config.listen_addr;
    log::info!("listening on {}", addr);

    let listener = TcpListener::bind(addr).await?;

    loop {
        let (stream, peer) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let state = state.clone();

        tokio::task::spawn(async move {
            let svc = service_fn(move |req| handle(req, state.clone()));
            if let Err(err) = H12AutoBuilder::new(TokioExecutor::new())
                .serve_connection(io, svc)
                .await
            {
                log::warn!("error serving connection from {}: {}", peer, err);
            }
        });
    }
}
