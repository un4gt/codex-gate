use std::time::Duration;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioTimer};

pub type UpstreamClient = Client<HttpsConnector<HttpConnector>, Full<Bytes>>;

pub fn new_upstream_client(
    connect_timeout: Duration,
    pool_idle_timeout: Duration,
    pool_max_idle_per_host: usize,
) -> Result<UpstreamClient, String> {
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    http.set_connect_timeout(Some(connect_timeout));

    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_native_roots()
        .map_err(|e| e.to_string())?
        .https_or_http()
        .enable_http1()
        .enable_http2()
        .wrap_connector(http);

    let mut builder = Client::builder(TokioExecutor::new());
    // hyper-util only performs proactive idle eviction when a timer is installed.
    // Keep the pool bounded so traffic bursts cannot retain every HTTP/1 connection forever.
    builder
        .pool_timer(TokioTimer::new())
        .pool_idle_timeout(pool_idle_timeout)
        .pool_max_idle_per_host(pool_max_idle_per_host);

    Ok(builder.build(https))
}
