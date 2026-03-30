use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;

use crate::health::{CircuitState, summarize_provider_health};
use crate::state::SharedState;
use crate::types::{ApiFormat, Usage};
use crate::util;

pub enum FailoverKind {
    Endpoint,
    Key,
    Generic,
}

#[derive(Default)]
struct ApiCounters {
    ok_total: AtomicU64,
    error_total: AtomicU64,
    duration_ms_sum: AtomicU64,
    duration_ms_count: AtomicU64,
    input_tokens_total: AtomicU64,
    output_tokens_total: AtomicU64,
    cache_read_tokens_total: AtomicU64,
    cache_write_tokens_total: AtomicU64,
    cost_in_micro_usd_total: AtomicU64,
    cost_out_micro_usd_total: AtomicU64,
    cost_total_micro_usd_total: AtomicU64,
}

#[derive(Clone, Copy, Default)]
struct ApiCountersSnapshot {
    ok_total: u64,
    error_total: u64,
    duration_ms_sum: u64,
    duration_ms_count: u64,
    input_tokens_total: u64,
    output_tokens_total: u64,
    cache_read_tokens_total: u64,
    cache_write_tokens_total: u64,
    cost_in_micro_usd_total: u64,
    cost_out_micro_usd_total: u64,
    cost_total_micro_usd_total: u64,
}

impl ApiCounters {
    fn snapshot(&self) -> ApiCountersSnapshot {
        ApiCountersSnapshot {
            ok_total: self.ok_total.load(Ordering::Relaxed),
            error_total: self.error_total.load(Ordering::Relaxed),
            duration_ms_sum: self.duration_ms_sum.load(Ordering::Relaxed),
            duration_ms_count: self.duration_ms_count.load(Ordering::Relaxed),
            input_tokens_total: self.input_tokens_total.load(Ordering::Relaxed),
            output_tokens_total: self.output_tokens_total.load(Ordering::Relaxed),
            cache_read_tokens_total: self.cache_read_tokens_total.load(Ordering::Relaxed),
            cache_write_tokens_total: self.cache_write_tokens_total.load(Ordering::Relaxed),
            cost_in_micro_usd_total: self.cost_in_micro_usd_total.load(Ordering::Relaxed),
            cost_out_micro_usd_total: self.cost_out_micro_usd_total.load(Ordering::Relaxed),
            cost_total_micro_usd_total: self.cost_total_micro_usd_total.load(Ordering::Relaxed),
        }
    }
}

pub struct Metrics {
    started_at_ms: i64,
    inflight_requests: AtomicI64,
    upstream_attempts_total: AtomicU64,
    failover_endpoint_total: AtomicU64,
    failover_key_total: AtomicU64,
    failover_generic_total: AtomicU64,
    chat: ApiCounters,
    responses: ApiCounters,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            started_at_ms: util::now_ms(),
            inflight_requests: AtomicI64::new(0),
            upstream_attempts_total: AtomicU64::new(0),
            failover_endpoint_total: AtomicU64::new(0),
            failover_key_total: AtomicU64::new(0),
            failover_generic_total: AtomicU64::new(0),
            chat: ApiCounters::default(),
            responses: ApiCounters::default(),
        }
    }

    pub fn inflight_guard(self: &Arc<Self>) -> InflightGuard {
        self.inflight_requests.fetch_add(1, Ordering::Relaxed);
        InflightGuard {
            metrics: self.clone(),
        }
    }

    pub fn record_upstream_attempt(&self) {
        self.upstream_attempts_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_failover(&self, kind: FailoverKind) {
        match kind {
            FailoverKind::Endpoint => {
                self.failover_endpoint_total.fetch_add(1, Ordering::Relaxed);
            }
            FailoverKind::Key => {
                self.failover_key_total.fetch_add(1, Ordering::Relaxed);
            }
            FailoverKind::Generic => {
                self.failover_generic_total.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn record_request(
        &self,
        api_format: ApiFormat,
        http_status: Option<i32>,
        error_type: Option<&str>,
        duration_ms: Option<i64>,
        usage: &Usage,
        cost_in_usd: Decimal,
        cost_out_usd: Decimal,
    ) {
        let target = match api_format {
            ApiFormat::ChatCompletions => &self.chat,
            ApiFormat::Responses => &self.responses,
        };
        Self::record_request_inner(
            target,
            http_status,
            error_type,
            duration_ms,
            usage,
            cost_in_usd,
            cost_out_usd,
        );
    }

    pub fn record_request_str(
        &self,
        api_format: &str,
        http_status: Option<i32>,
        error_type: Option<&str>,
        duration_ms: Option<i64>,
        usage: &Usage,
        cost_in_usd: Decimal,
        cost_out_usd: Decimal,
    ) {
        let target = if api_format == "responses" {
            &self.responses
        } else {
            &self.chat
        };
        Self::record_request_inner(
            target,
            http_status,
            error_type,
            duration_ms,
            usage,
            cost_in_usd,
            cost_out_usd,
        );
    }

    fn record_request_inner(
        target: &ApiCounters,
        http_status: Option<i32>,
        error_type: Option<&str>,
        duration_ms: Option<i64>,
        usage: &Usage,
        cost_in_usd: Decimal,
        cost_out_usd: Decimal,
    ) {
        let ok = http_status.unwrap_or(500) < 400 && error_type.is_none();
        if ok {
            target.ok_total.fetch_add(1, Ordering::Relaxed);
        } else {
            target.error_total.fetch_add(1, Ordering::Relaxed);
        }

        if let Some(duration_ms) = duration_ms.filter(|value| *value >= 0) {
            target
                .duration_ms_sum
                .fetch_add(duration_ms as u64, Ordering::Relaxed);
            target.duration_ms_count.fetch_add(1, Ordering::Relaxed);
        }

        target
            .input_tokens_total
            .fetch_add(usage.input_tokens.max(0) as u64, Ordering::Relaxed);
        target
            .output_tokens_total
            .fetch_add(usage.output_tokens.max(0) as u64, Ordering::Relaxed);
        target.cache_read_tokens_total.fetch_add(
            usage.cache_read_input_tokens.max(0) as u64,
            Ordering::Relaxed,
        );
        target.cache_write_tokens_total.fetch_add(
            usage.cache_creation_input_tokens.max(0) as u64,
            Ordering::Relaxed,
        );

        let cost_total = cost_in_usd + cost_out_usd;
        target
            .cost_in_micro_usd_total
            .fetch_add(decimal_to_micro_units(cost_in_usd), Ordering::Relaxed);
        target
            .cost_out_micro_usd_total
            .fetch_add(decimal_to_micro_units(cost_out_usd), Ordering::Relaxed);
        target
            .cost_total_micro_usd_total
            .fetch_add(decimal_to_micro_units(cost_total), Ordering::Relaxed);
    }
}

pub struct InflightGuard {
    metrics: Arc<Metrics>,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.metrics
            .inflight_requests
            .fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct EntityStateCounts {
    disabled: u64,
    closed: u64,
    half_open: u64,
    open: u64,
    available: u64,
}

pub async fn render_prometheus(state: &SharedState) -> String {
    let chat = state.metrics.chat.snapshot();
    let responses = state.metrics.responses.snapshot();
    let db_ready = state.db.ping().await.is_ok();
    let now_ms = util::now_ms();

    let mut provider_counts = EntityStateCounts::default();
    let mut key_counts = EntityStateCounts::default();
    let mut endpoint_counts = EntityStateCounts::default();
    let mut upstream_config_loaded = false;

    if let Ok(snapshot) = state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
    {
        upstream_config_loaded = true;

        for provider in &snapshot.providers {
            if !provider.enabled {
                provider_counts.disabled += 1;
                continue;
            }
            let endpoints = snapshot
                .endpoints_by_provider
                .get(&provider.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let keys = snapshot
                .keys_by_provider
                .get(&provider.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let summary = summarize_provider_health(
                endpoints,
                keys,
                &state.endpoint_health,
                &state.upstream_key_health,
                now_ms,
            );
            add_state_count(&mut provider_counts, summary.state, summary.available);
        }

        for keys in snapshot.keys_by_provider.values() {
            for key in keys {
                if !key.enabled {
                    key_counts.disabled += 1;
                    continue;
                }
                let view = state.upstream_key_health.snapshot(key.id, now_ms);
                add_state_count(&mut key_counts, view.state, view.available);
            }
        }

        for endpoints in snapshot.endpoints_by_provider.values() {
            for endpoint in endpoints {
                if !endpoint.enabled {
                    endpoint_counts.disabled += 1;
                    continue;
                }
                let view = state.endpoint_health.snapshot(endpoint.id, now_ms);
                add_state_count(&mut endpoint_counts, view.state, view.available);
            }
        }
    }

    let mut out = String::with_capacity(4096);
    out.push_str(
        "# HELP codex_gate_started_at_seconds Gateway process start time in Unix seconds.\n",
    );
    out.push_str("# TYPE codex_gate_started_at_seconds gauge\n");
    out.push_str(&format!(
        "codex_gate_started_at_seconds {}\n",
        state.metrics.started_at_ms as f64 / 1000.0
    ));

    out.push_str("# HELP codex_gate_db_ready Database readiness probe result.\n");
    out.push_str("# TYPE codex_gate_db_ready gauge\n");
    out.push_str(&format!(
        "codex_gate_db_ready {}\n",
        if db_ready { 1 } else { 0 }
    ));

    out.push_str("# HELP codex_gate_upstream_snapshot_loaded Upstream config snapshot loaded successfully on scrape.\n");
    out.push_str("# TYPE codex_gate_upstream_snapshot_loaded gauge\n");
    out.push_str(&format!(
        "codex_gate_upstream_snapshot_loaded {}\n",
        if upstream_config_loaded { 1 } else { 0 }
    ));

    out.push_str("# HELP codex_gate_inflight_requests Current in-flight proxy requests.\n");
    out.push_str("# TYPE codex_gate_inflight_requests gauge\n");
    out.push_str(&format!(
        "codex_gate_inflight_requests {}\n",
        state.metrics.inflight_requests.load(Ordering::Relaxed)
    ));

    if let Some(rss_bytes) = util::process_resident_memory_bytes() {
        out.push_str("# HELP codex_gate_process_resident_memory_bytes Resident memory used by the gateway process in bytes.\n");
        out.push_str("# TYPE codex_gate_process_resident_memory_bytes gauge\n");
        out.push_str(&format!(
            "codex_gate_process_resident_memory_bytes {}\n",
            rss_bytes
        ));
    }

    out.push_str(
        "# HELP codex_gate_upstream_attempts_total Total upstream attempts issued by the proxy.\n",
    );
    out.push_str("# TYPE codex_gate_upstream_attempts_total counter\n");
    out.push_str(&format!(
        "codex_gate_upstream_attempts_total {}\n",
        state
            .metrics
            .upstream_attempts_total
            .load(Ordering::Relaxed)
    ));

    out.push_str("# HELP codex_gate_failovers_total Total same-request failover continuations before response streaming starts.\n");
    out.push_str("# TYPE codex_gate_failovers_total counter\n");
    out.push_str(&format!(
        "codex_gate_failovers_total{{scope=\"endpoint\"}} {}\n",
        state
            .metrics
            .failover_endpoint_total
            .load(Ordering::Relaxed)
    ));
    out.push_str(&format!(
        "codex_gate_failovers_total{{scope=\"key\"}} {}\n",
        state.metrics.failover_key_total.load(Ordering::Relaxed)
    ));
    out.push_str(&format!(
        "codex_gate_failovers_total{{scope=\"generic\"}} {}\n",
        state.metrics.failover_generic_total.load(Ordering::Relaxed)
    ));

    write_api_metrics(&mut out, "chat_completions", chat);
    write_api_metrics(&mut out, "responses", responses);

    write_state_metrics(
        &mut out,
        "codex_gate_provider_health_total",
        &provider_counts,
    );
    write_state_metrics(
        &mut out,
        "codex_gate_upstream_key_health_total",
        &key_counts,
    );
    write_state_metrics(
        &mut out,
        "codex_gate_endpoint_health_total",
        &endpoint_counts,
    );

    out
}

fn add_state_count(counts: &mut EntityStateCounts, state: CircuitState, available: bool) {
    if available {
        counts.available += 1;
    }
    match state {
        CircuitState::Closed => counts.closed += 1,
        CircuitState::HalfOpen => counts.half_open += 1,
        CircuitState::Open => counts.open += 1,
    }
}

fn write_api_metrics(out: &mut String, api_format: &str, snapshot: ApiCountersSnapshot) {
    out.push_str("# HELP codex_gate_requests_total Total completed proxy requests by API format and result.\n");
    out.push_str("# TYPE codex_gate_requests_total counter\n");
    out.push_str(&format!(
        "codex_gate_requests_total{{api_format=\"{}\",result=\"ok\"}} {}\n",
        api_format, snapshot.ok_total
    ));
    out.push_str(&format!(
        "codex_gate_requests_total{{api_format=\"{}\",result=\"error\"}} {}\n",
        api_format, snapshot.error_total
    ));

    out.push_str("# HELP codex_gate_request_duration_ms_sum Sum of completed proxy request durations in milliseconds.\n");
    out.push_str("# TYPE codex_gate_request_duration_ms_sum counter\n");
    out.push_str(&format!(
        "codex_gate_request_duration_ms_sum{{api_format=\"{}\"}} {}\n",
        api_format, snapshot.duration_ms_sum
    ));

    out.push_str(
        "# HELP codex_gate_request_duration_ms_count Count of completed proxy request durations.\n",
    );
    out.push_str("# TYPE codex_gate_request_duration_ms_count counter\n");
    out.push_str(&format!(
        "codex_gate_request_duration_ms_count{{api_format=\"{}\"}} {}\n",
        api_format, snapshot.duration_ms_count
    ));

    out.push_str(
        "# HELP codex_gate_tokens_total Aggregated token counters by API format and token kind.\n",
    );
    out.push_str("# TYPE codex_gate_tokens_total counter\n");
    out.push_str(&format!(
        "codex_gate_tokens_total{{api_format=\"{}\",kind=\"input\"}} {}\n",
        api_format, snapshot.input_tokens_total
    ));
    out.push_str(&format!(
        "codex_gate_tokens_total{{api_format=\"{}\",kind=\"output\"}} {}\n",
        api_format, snapshot.output_tokens_total
    ));
    out.push_str(&format!(
        "codex_gate_tokens_total{{api_format=\"{}\",kind=\"cache_read\"}} {}\n",
        api_format, snapshot.cache_read_tokens_total
    ));
    out.push_str(&format!(
        "codex_gate_tokens_total{{api_format=\"{}\",kind=\"cache_write\"}} {}\n",
        api_format, snapshot.cache_write_tokens_total
    ));

    out.push_str("# HELP codex_gate_cost_usd_total Aggregated request cost in USD by API format and direction.\n");
    out.push_str("# TYPE codex_gate_cost_usd_total counter\n");
    out.push_str(&format!(
        "codex_gate_cost_usd_total{{api_format=\"{}\",kind=\"in\"}} {:.6}\n",
        api_format,
        micro_units_to_usd(snapshot.cost_in_micro_usd_total)
    ));
    out.push_str(&format!(
        "codex_gate_cost_usd_total{{api_format=\"{}\",kind=\"out\"}} {:.6}\n",
        api_format,
        micro_units_to_usd(snapshot.cost_out_micro_usd_total)
    ));
    out.push_str(&format!(
        "codex_gate_cost_usd_total{{api_format=\"{}\",kind=\"total\"}} {:.6}\n",
        api_format,
        micro_units_to_usd(snapshot.cost_total_micro_usd_total)
    ));
}

fn write_state_metrics(out: &mut String, metric_name: &str, counts: &EntityStateCounts) {
    out.push_str(&format!(
        "# HELP {} Runtime health counts by circuit state.\n",
        metric_name
    ));
    out.push_str(&format!("# TYPE {} gauge\n", metric_name));
    out.push_str(&format!(
        "{}{{state=\"closed\"}} {}\n",
        metric_name, counts.closed
    ));
    out.push_str(&format!(
        "{}{{state=\"half_open\"}} {}\n",
        metric_name, counts.half_open
    ));
    out.push_str(&format!(
        "{}{{state=\"open\"}} {}\n",
        metric_name, counts.open
    ));
    out.push_str(&format!(
        "{}{{state=\"disabled\"}} {}\n",
        metric_name, counts.disabled
    ));
    out.push_str(&format!(
        "{}{{state=\"available\"}} {}\n",
        metric_name, counts.available
    ));
}

fn decimal_to_micro_units(value: Decimal) -> u64 {
    let scaled = (value * Decimal::from(1_000_000u64)).round_dp(0);
    scaled.to_u64().unwrap_or(0)
}

fn micro_units_to_usd(value: u64) -> f64 {
    value as f64 / 1_000_000.0
}
