use http_body_util::Full;
use hyper::body::Bytes;
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use std::time::Duration;

pub type UpstreamClient = Client<HttpsConnector<HttpConnector>, Full<Bytes>>;

pub fn new_upstream_client(connect_timeout: Duration) -> Result<UpstreamClient, String> {
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

    Ok(Client::builder(TokioExecutor::new()).build(https))
}
