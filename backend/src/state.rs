use std::sync::Arc;

use crate::cache::Caches;
use crate::codex_oauth::CodexOauthManager;
use crate::config::Config;
use crate::db::Database;
use crate::health::{EndpointHealthBook, UpstreamKeyHealthBook};
use crate::metrics::Metrics;
use crate::telemetry::Telemetry;
use crate::upstream::UpstreamClient;

pub struct AppState {
    pub config: Config,
    pub db: Database,
    pub caches: Caches,
    pub telemetry: Telemetry,
    pub upstream: UpstreamClient,
    pub endpoint_health: Arc<EndpointHealthBook>,
    pub upstream_key_health: Arc<UpstreamKeyHealthBook>,
    pub metrics: Arc<Metrics>,
    pub codex_oauth: CodexOauthManager,
}

pub type SharedState = Arc<AppState>;
