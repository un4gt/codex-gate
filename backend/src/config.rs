use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use crate::selector::EndpointSelectorStrategy;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub db_dsn: String,
    pub db_max_connections: u32,
    pub admin_token: String,
    pub master_key: String,
    pub inject_include_usage: bool,
    pub endpoint_selector_strategy: EndpointSelectorStrategy,
    pub circuit_breaker_failure_threshold: u32,
    pub circuit_breaker_open_ms: i64,
    pub api_key_cache_ttl: Duration,
    pub upstream_cache_ttl: Duration,
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
    pub log_queue_capacity: usize,
    pub stats_flush_interval: Duration,
    pub upstream_connect_timeout: Duration,
    pub upstream_request_timeout: Duration,
    pub request_log_retention_days: u32,
    pub stats_daily_retention_days: u32,
    pub retention_cleanup_interval: Duration,
    pub retention_delete_batch: usize,
    pub request_log_archive_enabled: bool,
    pub request_log_archive_dir: String,
    pub request_log_archive_compress: bool,
    pub static_dir: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let listen_addr = getenv_parse("LISTEN_ADDR")
            .transpose()?
            .unwrap_or(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8080));

        let db_dsn = getenv_string("DB_DSN")
            .or_else(|| getenv_string("DATABASE_URL"))
            .unwrap_or_else(|| "sqlite://./data/codex_gate.sqlite".to_string());

        let db_max_connections = getenv_usize("DB_MAX_CONNECTIONS").unwrap_or(10) as u32;

        let admin_token = getenv_string("ADMIN_TOKEN").ok_or("missing env ADMIN_TOKEN")?;
        if admin_token.trim().is_empty() {
            return Err("env ADMIN_TOKEN is empty".to_string());
        }

        let master_key = getenv_string("MASTER_KEY").unwrap_or_else(|| {
            log::warn!("env MASTER_KEY not set; falling back to ADMIN_TOKEN (not recommended for production)");
            admin_token.clone()
        });

        let inject_include_usage = getenv_bool("INJECT_INCLUDE_USAGE").unwrap_or(true);
        let endpoint_selector_strategy =
            getenv_endpoint_selector_strategy("ENDPOINT_SELECTOR_STRATEGY")
                .unwrap_or(EndpointSelectorStrategy::Weighted);
        let circuit_breaker_failure_threshold =
            getenv_u32("CIRCUIT_BREAKER_FAILURE_THRESHOLD").unwrap_or(3);
        let circuit_breaker_open_ms =
            getenv_u64("CIRCUIT_BREAKER_OPEN_MS").unwrap_or(30_000) as i64;

        let api_key_cache_ttl =
            Duration::from_millis(getenv_u64("API_KEY_CACHE_TTL_MS").unwrap_or(30_000));
        let upstream_cache_ttl =
            Duration::from_millis(getenv_u64("UPSTREAM_CACHE_TTL_MS").unwrap_or(2_000));

        let max_request_bytes = getenv_usize("MAX_REQUEST_BYTES").unwrap_or(10 * 1024 * 1024);
        let max_response_bytes = getenv_usize("MAX_RESPONSE_BYTES").unwrap_or(20 * 1024 * 1024);
        let log_queue_capacity = getenv_usize("LOG_QUEUE_CAPACITY").unwrap_or(2048);
        let stats_flush_interval =
            Duration::from_millis(getenv_u64("STATS_FLUSH_INTERVAL_MS").unwrap_or(2_000));

        // Upstream timeouts: keep bounded so failover/circuit-breaker can engage.
        let upstream_connect_timeout = Duration::from_millis(
            getenv_u64("UPSTREAM_CONNECT_TIMEOUT_MS")
                .unwrap_or(2_000)
                .max(100),
        );
        let upstream_request_timeout = Duration::from_millis(
            getenv_u64("UPSTREAM_REQUEST_TIMEOUT_MS")
                .unwrap_or(120_000)
                .max(1_000),
        );

        let request_log_retention_days = getenv_u32("REQUEST_LOG_RETENTION_DAYS").unwrap_or(30);
        let stats_daily_retention_days = getenv_u32("STATS_DAILY_RETENTION_DAYS").unwrap_or(400);
        let retention_cleanup_interval = Duration::from_millis(
            getenv_u64("RETENTION_CLEANUP_INTERVAL_MS")
                .unwrap_or(6 * 60 * 60 * 1_000)
                .max(1_000),
        );
        let retention_delete_batch = getenv_usize("RETENTION_DELETE_BATCH")
            .unwrap_or(2_000)
            .max(1);
        let request_log_archive_enabled =
            getenv_bool("REQUEST_LOG_ARCHIVE_ENABLED").unwrap_or(false);
        let request_log_archive_dir = getenv_string("REQUEST_LOG_ARCHIVE_DIR")
            .unwrap_or_else(|| "./data/archive/request_logs".to_string());
        let request_log_archive_compress =
            getenv_bool("REQUEST_LOG_ARCHIVE_COMPRESS").unwrap_or(false);
        let static_dir = getenv_string("STATIC_DIR").unwrap_or_else(|| "./static".to_string());

        Ok(Self {
            listen_addr,
            db_dsn,
            db_max_connections,
            admin_token,
            master_key,
            inject_include_usage,
            endpoint_selector_strategy,
            circuit_breaker_failure_threshold,
            circuit_breaker_open_ms,
            api_key_cache_ttl,
            upstream_cache_ttl,
            max_request_bytes,
            max_response_bytes,
            log_queue_capacity,
            stats_flush_interval,
            upstream_connect_timeout,
            upstream_request_timeout,
            request_log_retention_days,
            stats_daily_retention_days,
            retention_cleanup_interval,
            retention_delete_batch,
            request_log_archive_enabled,
            request_log_archive_dir,
            request_log_archive_compress,
            static_dir,
        })
    }
}

fn getenv_string(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn getenv_parse<T: std::str::FromStr>(key: &str) -> Option<Result<T, String>> {
    getenv_string(key).map(|raw| {
        raw.parse::<T>()
            .map_err(|_| format!("invalid env {key}: {raw}"))
    })
}

fn getenv_bool(key: &str) -> Option<bool> {
    let raw = getenv_string(key)?;
    match raw.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "y" | "on" => Some(true),
        "0" | "false" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

fn getenv_endpoint_selector_strategy(key: &str) -> Option<EndpointSelectorStrategy> {
    let raw = getenv_string(key)?;
    EndpointSelectorStrategy::parse(&raw)
}

fn getenv_u64(key: &str) -> Option<u64> {
    getenv_string(key)?.parse::<u64>().ok()
}

fn getenv_u32(key: &str) -> Option<u32> {
    getenv_string(key)?.parse::<u32>().ok()
}

fn getenv_usize(key: &str) -> Option<usize> {
    getenv_string(key)?.parse::<usize>().ok()
}
