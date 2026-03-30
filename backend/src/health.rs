use std::collections::HashMap;

use parking_lot::RwLock;
use serde::Serialize;

use crate::types::{UpstreamEndpoint, UpstreamKey};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CircuitState {
    #[default]
    Closed,
    Open,
    HalfOpen,
}

#[derive(Clone, Debug, Serialize)]
pub struct RuntimeHealthView {
    pub state: CircuitState,
    pub available: bool,
    pub consecutive_failures: u32,
    pub success_count: u64,
    pub failure_count: u64,
    pub last_status: Option<i32>,
    pub last_error_type: Option<String>,
    pub last_error_message: Option<String>,
    pub latency_ewma_ms: Option<i64>,
    pub open_until_ms: Option<i64>,
    pub last_success_at_ms: Option<i64>,
    pub last_failure_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
}

pub type EndpointHealthView = RuntimeHealthView;
pub type UpstreamKeyHealthView = RuntimeHealthView;

impl Default for RuntimeHealthView {
    fn default() -> Self {
        Self {
            state: CircuitState::Closed,
            available: true,
            consecutive_failures: 0,
            success_count: 0,
            failure_count: 0,
            last_status: None,
            last_error_type: None,
            last_error_message: None,
            latency_ewma_ms: None,
            open_until_ms: None,
            last_success_at_ms: None,
            last_failure_at_ms: None,
            updated_at_ms: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct RuntimeHealthState {
    consecutive_failures: u32,
    success_count: u64,
    failure_count: u64,
    last_status: Option<i32>,
    last_error_type: Option<String>,
    last_error_message: Option<String>,
    latency_ewma_ms: Option<f64>,
    open_until_ms: Option<i64>,
    last_success_at_ms: Option<i64>,
    last_failure_at_ms: Option<i64>,
    updated_at_ms: Option<i64>,
    half_open_probe_in_flight: bool,
}

pub struct RuntimeHealthBook {
    failure_threshold: u32,
    open_duration_ms: i64,
    ewma_alpha: f64,
    by_id: RwLock<HashMap<i64, RuntimeHealthState>>,
}

pub type EndpointHealthBook = RuntimeHealthBook;
pub type UpstreamKeyHealthBook = RuntimeHealthBook;

impl RuntimeHealthBook {
    pub fn new(failure_threshold: u32, open_duration_ms: i64) -> Self {
        Self {
            failure_threshold: failure_threshold.max(1),
            open_duration_ms: open_duration_ms.max(1),
            ewma_alpha: 0.2,
            by_id: RwLock::new(HashMap::new()),
        }
    }

    pub fn snapshot(&self, id: i64, now_ms: i64) -> RuntimeHealthView {
        let guard = self.by_id.read();
        let Some(state) = guard.get(&id) else {
            return RuntimeHealthView::default();
        };
        Self::to_view(state, now_ms)
    }

    pub fn try_acquire(&self, id: i64, now_ms: i64) -> bool {
        let mut guard = self.by_id.write();
        let Some(state) = guard.get_mut(&id) else {
            return true;
        };

        match Self::state_kind(state, now_ms) {
            CircuitState::Closed => true,
            CircuitState::Open => false,
            CircuitState::HalfOpen => {
                if state.half_open_probe_in_flight {
                    return false;
                }
                state.half_open_probe_in_flight = true;
                state.updated_at_ms = Some(now_ms);
                true
            }
        }
    }

    pub fn release_probe(&self, id: i64, now_ms: i64) {
        let mut guard = self.by_id.write();
        let Some(state) = guard.get_mut(&id) else {
            return;
        };

        if state.half_open_probe_in_flight {
            state.half_open_probe_in_flight = false;
            state.updated_at_ms = Some(now_ms);
        }
    }

    pub fn record_success(
        &self,
        id: i64,
        status: Option<i32>,
        observed_latency_ms: Option<i64>,
        now_ms: i64,
    ) {
        let mut guard = self.by_id.write();
        let state = guard.entry(id).or_default();

        state.success_count = state.success_count.saturating_add(1);
        state.consecutive_failures = 0;
        state.last_status = status;
        state.last_error_type = None;
        state.last_error_message = None;
        state.open_until_ms = None;
        state.last_success_at_ms = Some(now_ms);
        state.updated_at_ms = Some(now_ms);
        state.half_open_probe_in_flight = false;

        if let Some(latency_ms) = observed_latency_ms.filter(|value| *value >= 0) {
            state.latency_ewma_ms = Some(match state.latency_ewma_ms {
                Some(current) => {
                    current * (1.0 - self.ewma_alpha) + latency_ms as f64 * self.ewma_alpha
                }
                None => latency_ms as f64,
            });
        }
    }

    pub fn record_failure(
        &self,
        id: i64,
        status: Option<i32>,
        error_type: Option<&str>,
        error_message: Option<&str>,
        now_ms: i64,
    ) {
        let mut guard = self.by_id.write();
        let state = guard.entry(id).or_default();
        let previous_kind = Self::state_kind(state, now_ms);

        state.failure_count = state.failure_count.saturating_add(1);
        state.last_status = status;
        state.last_error_type = error_type.map(ToOwned::to_owned);
        state.last_error_message = error_message.map(ToOwned::to_owned);
        state.last_failure_at_ms = Some(now_ms);
        state.updated_at_ms = Some(now_ms);
        state.half_open_probe_in_flight = false;

        state.consecutive_failures = if previous_kind == CircuitState::HalfOpen {
            self.failure_threshold
        } else {
            state.consecutive_failures.saturating_add(1)
        };

        if state.consecutive_failures >= self.failure_threshold {
            state.open_until_ms = Some(now_ms + self.open_duration_ms);
        }
    }

    fn to_view(state: &RuntimeHealthState, now_ms: i64) -> RuntimeHealthView {
        let state_kind = Self::state_kind(state, now_ms);
        RuntimeHealthView {
            state: state_kind,
            available: match state_kind {
                CircuitState::Closed => true,
                CircuitState::Open => false,
                CircuitState::HalfOpen => !state.half_open_probe_in_flight,
            },
            consecutive_failures: state.consecutive_failures,
            success_count: state.success_count,
            failure_count: state.failure_count,
            last_status: state.last_status,
            last_error_type: state.last_error_type.clone(),
            last_error_message: state.last_error_message.clone(),
            latency_ewma_ms: state.latency_ewma_ms.map(|value| value.round() as i64),
            open_until_ms: match state_kind {
                CircuitState::Open => state.open_until_ms,
                _ => None,
            },
            last_success_at_ms: state.last_success_at_ms,
            last_failure_at_ms: state.last_failure_at_ms,
            updated_at_ms: state.updated_at_ms,
        }
    }

    fn state_kind(state: &RuntimeHealthState, now_ms: i64) -> CircuitState {
        match state.open_until_ms {
            Some(open_until_ms) if open_until_ms > now_ms => CircuitState::Open,
            Some(_) => CircuitState::HalfOpen,
            None => CircuitState::Closed,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct HealthCounts {
    pub total: u32,
    pub disabled: u32,
    pub closed: u32,
    pub half_open: u32,
    pub open: u32,
    pub available: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderHealthView {
    pub state: CircuitState,
    pub available: bool,
    pub consecutive_failures: u32,
    pub success_count: u64,
    pub failure_count: u64,
    pub last_status: Option<i32>,
    pub last_error_type: Option<String>,
    pub last_error_message: Option<String>,
    pub latency_ewma_ms: Option<i64>,
    pub open_until_ms: Option<i64>,
    pub last_success_at_ms: Option<i64>,
    pub last_failure_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
    pub endpoint_counts: HealthCounts,
    pub key_counts: HealthCounts,
}

impl Default for ProviderHealthView {
    fn default() -> Self {
        Self {
            state: CircuitState::Closed,
            available: false,
            consecutive_failures: 0,
            success_count: 0,
            failure_count: 0,
            last_status: None,
            last_error_type: None,
            last_error_message: None,
            latency_ewma_ms: None,
            open_until_ms: None,
            last_success_at_ms: None,
            last_failure_at_ms: None,
            updated_at_ms: None,
            endpoint_counts: HealthCounts::default(),
            key_counts: HealthCounts::default(),
        }
    }
}

pub fn summarize_provider_health(
    endpoints: &[UpstreamEndpoint],
    keys: &[UpstreamKey],
    endpoint_health: &EndpointHealthBook,
    key_health: &UpstreamKeyHealthBook,
    now_ms: i64,
) -> ProviderHealthView {
    let (endpoint_counts, endpoint_views) = summarize_children(
        endpoints,
        |item| item.id,
        |item| item.enabled,
        endpoint_health,
        now_ms,
    );
    let (key_counts, key_views) = summarize_children(
        keys,
        |item| item.id,
        |item| item.enabled,
        key_health,
        now_ms,
    );

    let available = endpoint_counts.available > 0 && key_counts.available > 0;
    let state = if !available {
        CircuitState::Open
    } else if endpoint_counts.closed > 0 && key_counts.closed > 0 {
        CircuitState::Closed
    } else {
        CircuitState::HalfOpen
    };

    let mut provider = ProviderHealthView {
        state,
        available,
        consecutive_failures: endpoint_views
            .iter()
            .chain(key_views.iter())
            .map(|view| view.consecutive_failures)
            .max()
            .unwrap_or(0),
        success_count: endpoint_views
            .iter()
            .chain(key_views.iter())
            .map(|view| view.success_count)
            .sum(),
        failure_count: endpoint_views
            .iter()
            .chain(key_views.iter())
            .map(|view| view.failure_count)
            .sum(),
        last_status: None,
        last_error_type: None,
        last_error_message: None,
        latency_ewma_ms: endpoint_views
            .iter()
            .filter_map(|view| view.latency_ewma_ms)
            .min(),
        open_until_ms: endpoint_views
            .iter()
            .chain(key_views.iter())
            .filter_map(|view| view.open_until_ms)
            .max(),
        last_success_at_ms: endpoint_views
            .iter()
            .chain(key_views.iter())
            .filter_map(|view| view.last_success_at_ms)
            .max(),
        last_failure_at_ms: endpoint_views
            .iter()
            .chain(key_views.iter())
            .filter_map(|view| view.last_failure_at_ms)
            .max(),
        updated_at_ms: endpoint_views
            .iter()
            .chain(key_views.iter())
            .filter_map(|view| view.updated_at_ms)
            .max(),
        endpoint_counts,
        key_counts,
    };

    if let Some(latest) = endpoint_views
        .iter()
        .chain(key_views.iter())
        .filter(|view| view.updated_at_ms.is_some())
        .max_by_key(|view| view.updated_at_ms.unwrap_or_default())
    {
        provider.last_status = latest.last_status;
        provider.last_error_type = latest.last_error_type.clone();
        provider.last_error_message = latest.last_error_message.clone();
    }

    provider
}

fn summarize_children<T, FId, FEnabled>(
    items: &[T],
    id: FId,
    enabled: FEnabled,
    book: &RuntimeHealthBook,
    now_ms: i64,
) -> (HealthCounts, Vec<RuntimeHealthView>)
where
    FId: Fn(&T) -> i64,
    FEnabled: Fn(&T) -> bool,
{
    let mut counts = HealthCounts::default();
    let mut views = Vec::new();

    for item in items {
        counts.total = counts.total.saturating_add(1);
        if !enabled(item) {
            counts.disabled = counts.disabled.saturating_add(1);
            continue;
        }

        let view = book.snapshot(id(item), now_ms);
        if view.available {
            counts.available = counts.available.saturating_add(1);
        }
        match view.state {
            CircuitState::Closed => counts.closed = counts.closed.saturating_add(1),
            CircuitState::HalfOpen => counts.half_open = counts.half_open.saturating_add(1),
            CircuitState::Open => counts.open = counts.open.saturating_add(1),
        }
        views.push(view);
    }

    (counts, views)
}

pub fn should_trip_endpoint(http_status: Option<i32>, error_type: Option<&str>) -> bool {
    if error_type.is_some() {
        return true;
    }

    matches!(http_status, Some(408 | 409 | 429)) || http_status.is_some_and(|status| status >= 500)
}

pub fn should_trip_key(http_status: Option<i32>, _error_type: Option<&str>) -> bool {
    matches!(http_status, Some(401 | 403))
}
