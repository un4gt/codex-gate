use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use hyper::HeaderMap;
use parking_lot::RwLock;
use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::health::CircuitState;
use crate::types::UpstreamProvider;

#[derive(Clone, Debug, Serialize)]
pub struct ProviderRuntimeView {
    pub state: CircuitState,
    pub available: bool,
    pub in_flight: u32,
    pub max_concurrency: Option<i32>,
    pub consecutive_failures: u32,
    pub success_count: u64,
    pub failure_count: u64,
    pub half_open_successes: u32,
    pub latency_ewma_ms: Option<i64>,
    pub open_until_ms: Option<i64>,
    pub last_status: Option<i32>,
    pub last_error_type: Option<String>,
    pub last_error_message: Option<String>,
    pub last_success_at_ms: Option<i64>,
    pub last_failure_at_ms: Option<i64>,
}

struct ProviderRuntimeState {
    in_flight: u32,
    generation: u64,
    next_probe_id: u64,
    probe_owner: Option<u64>,
    consecutive_failures: u32,
    success_count: u64,
    failure_count: u64,
    half_open_successes: u32,
    latency_ewma_ms: Option<f64>,
    open_until_ms: Option<i64>,
    last_status: Option<i32>,
    last_error_type: Option<String>,
    last_error_message: Option<String>,
    last_success_at_ms: Option<i64>,
    last_failure_at_ms: Option<i64>,
}

impl Default for ProviderRuntimeState {
    fn default() -> Self {
        Self {
            in_flight: 0,
            generation: 1,
            next_probe_id: 0,
            probe_owner: None,
            consecutive_failures: 0,
            success_count: 0,
            failure_count: 0,
            half_open_successes: 0,
            latency_ewma_ms: None,
            open_until_ms: None,
            last_status: None,
            last_error_type: None,
            last_error_message: None,
            last_success_at_ms: None,
            last_failure_at_ms: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BreakerTransition {
    Unchanged,
    Opened,
}

#[derive(Clone, Copy, Debug)]
struct ProviderAttemptToken {
    generation: u64,
    probe_id: Option<u64>,
}

pub struct ProviderRuntimeBook {
    ewma_alpha: f64,
    by_provider: RwLock<HashMap<i64, ProviderRuntimeState>>,
}

impl ProviderRuntimeBook {
    pub fn new() -> Self {
        Self {
            ewma_alpha: 0.2,
            by_provider: RwLock::new(HashMap::new()),
        }
    }

    pub fn snapshot(&self, provider: &UpstreamProvider, now_ms: i64) -> ProviderRuntimeView {
        let guard = self.by_provider.read();
        let Some(state) = guard.get(&provider.id) else {
            return ProviderRuntimeView {
                state: CircuitState::Closed,
                available: provider.enabled,
                in_flight: 0,
                max_concurrency: provider.max_concurrency,
                consecutive_failures: 0,
                success_count: 0,
                failure_count: 0,
                half_open_successes: 0,
                latency_ewma_ms: None,
                open_until_ms: None,
                last_status: None,
                last_error_type: None,
                last_error_message: None,
                last_success_at_ms: None,
                last_failure_at_ms: None,
            };
        };
        to_view(provider, state, now_ms)
    }

    pub fn try_acquire_capacity(
        self: &Arc<Self>,
        provider: &UpstreamProvider,
    ) -> Option<ProviderCapacityPermit> {
        let mut guard = self.by_provider.write();
        let state = guard.entry(provider.id).or_default();
        if provider
            .max_concurrency
            .is_some_and(|limit| state.in_flight >= limit.max(0) as u32)
        {
            return None;
        }
        state.in_flight = state.in_flight.saturating_add(1);
        Some(ProviderCapacityPermit {
            book: self.clone(),
            provider_id: provider.id,
            released: false,
        })
    }

    pub fn try_begin_attempt(
        self: &Arc<Self>,
        provider: &UpstreamProvider,
        now_ms: i64,
    ) -> Option<ProviderAttemptGuard> {
        let mut guard = self.by_provider.write();
        let state = guard.entry(provider.id).or_default();
        let probe_id = match circuit_state(provider, state, now_ms) {
            CircuitState::Closed => None,
            CircuitState::Open => return None,
            CircuitState::HalfOpen => {
                if state.probe_owner.is_some() {
                    return None;
                }
                state.next_probe_id = state.next_probe_id.wrapping_add(1).max(1);
                state.probe_owner = Some(state.next_probe_id);
                Some(state.next_probe_id)
            }
        };
        Some(ProviderAttemptGuard {
            book: self.clone(),
            provider: provider.clone(),
            token: ProviderAttemptToken {
                generation: state.generation,
                probe_id,
            },
            active: true,
        })
    }

    fn finish_success(
        &self,
        provider: &UpstreamProvider,
        token: ProviderAttemptToken,
        status: Option<i32>,
        latency_ms: Option<i64>,
        now_ms: i64,
    ) {
        let mut guard = self.by_provider.write();
        let state = guard.entry(provider.id).or_default();
        state.success_count = state.success_count.saturating_add(1);
        if let Some(latency_ms) = latency_ms.filter(|value| *value >= 0) {
            state.latency_ewma_ms = Some(match state.latency_ewma_ms {
                Some(current) => {
                    current * (1.0 - self.ewma_alpha) + latency_ms as f64 * self.ewma_alpha
                }
                None => latency_ms as f64,
            });
        }
        if !attempt_token_matches(state, token) {
            return;
        }

        let previous_state = circuit_state(provider, state, now_ms);
        state.last_status = status;
        state.last_error_type = None;
        state.last_error_message = None;
        state.last_success_at_ms = Some(now_ms);
        release_probe_owner(state, token);

        if !provider.circuit_breaker_enabled {
            clear_breaker_state(state);
            return;
        }
        if previous_state == CircuitState::HalfOpen {
            state.half_open_successes = state.half_open_successes.saturating_add(1);
            if state.half_open_successes
                >= provider.circuit_breaker_half_open_success_threshold.max(1) as u32
            {
                advance_generation(state);
                clear_breaker_state(state);
            }
        } else {
            state.consecutive_failures = 0;
            state.open_until_ms = None;
            state.half_open_successes = 0;
        }
    }

    fn finish_failure(
        &self,
        provider: &UpstreamProvider,
        token: ProviderAttemptToken,
        status: Option<i32>,
        error_type: &str,
        error_message: &str,
        now_ms: i64,
    ) -> BreakerTransition {
        let mut guard = self.by_provider.write();
        let state = guard.entry(provider.id).or_default();
        state.failure_count = state.failure_count.saturating_add(1);
        if !attempt_token_matches(state, token) {
            return BreakerTransition::Unchanged;
        }

        let previous_state = circuit_state(provider, state, now_ms);
        state.last_status = status;
        state.last_error_type = Some(error_type.to_string());
        state.last_error_message = Some(error_message.to_string());
        state.last_failure_at_ms = Some(now_ms);
        release_probe_owner(state, token);

        if !provider.circuit_breaker_enabled {
            state.consecutive_failures = state.consecutive_failures.saturating_add(1);
            state.open_until_ms = None;
            state.half_open_successes = 0;
            return BreakerTransition::Unchanged;
        }
        state.consecutive_failures = if previous_state == CircuitState::HalfOpen {
            provider.circuit_breaker_failure_threshold.max(1) as u32
        } else {
            state.consecutive_failures.saturating_add(1)
        };
        if state.consecutive_failures >= provider.circuit_breaker_failure_threshold.max(1) as u32 {
            state.open_until_ms =
                Some(now_ms.saturating_add(provider.circuit_breaker_open_ms.max(1)));
            state.half_open_successes = 0;
            advance_generation(state);
            return BreakerTransition::Opened;
        }
        BreakerTransition::Unchanged
    }

    pub fn reset(&self, provider_id: i64) {
        let mut guard = self.by_provider.write();
        let state = guard.entry(provider_id).or_default();
        advance_generation(state);
        state.consecutive_failures = 0;
        state.half_open_successes = 0;
        state.probe_owner = None;
        state.open_until_ms = None;
        state.last_status = None;
        state.last_error_type = None;
        state.last_error_message = None;
        state.last_failure_at_ms = None;
    }

    pub fn purge_provider(&self, provider_id: i64) {
        self.by_provider.write().remove(&provider_id);
    }

    fn release_capacity(&self, provider_id: i64) {
        let mut guard = self.by_provider.write();
        let Some(state) = guard.get_mut(&provider_id) else {
            return;
        };
        state.in_flight = state.in_flight.saturating_sub(1);
    }

    fn finish_neutral(&self, provider_id: i64, token: ProviderAttemptToken) {
        let mut guard = self.by_provider.write();
        let Some(state) = guard.get_mut(&provider_id) else {
            return;
        };
        if attempt_token_matches(state, token) {
            release_probe_owner(state, token);
        }
    }
}

pub struct ProviderCapacityPermit {
    book: Arc<ProviderRuntimeBook>,
    provider_id: i64,
    released: bool,
}

impl Drop for ProviderCapacityPermit {
    fn drop(&mut self) {
        if !self.released {
            self.book.release_capacity(self.provider_id);
            self.released = true;
        }
    }
}

pub struct ProviderAttemptGuard {
    book: Arc<ProviderRuntimeBook>,
    provider: UpstreamProvider,
    token: ProviderAttemptToken,
    active: bool,
}

impl ProviderAttemptGuard {
    pub fn is_half_open_probe(&self) -> bool {
        self.token.probe_id.is_some()
    }

    pub fn success(mut self, status: Option<i32>, latency_ms: Option<i64>, now_ms: i64) {
        self.active = false;
        self.book
            .finish_success(&self.provider, self.token, status, latency_ms, now_ms);
    }

    pub fn failure(
        mut self,
        status: Option<i32>,
        error_type: &str,
        error_message: &str,
        now_ms: i64,
    ) -> BreakerTransition {
        self.active = false;
        self.book.finish_failure(
            &self.provider,
            self.token,
            status,
            error_type,
            error_message,
            now_ms,
        )
    }

    pub fn neutral(mut self) {
        self.active = false;
        self.book.finish_neutral(self.provider.id, self.token);
    }
}

impl Drop for ProviderAttemptGuard {
    fn drop(&mut self) {
        if self.active {
            self.book.finish_neutral(self.provider.id, self.token);
            self.active = false;
        }
    }
}

fn circuit_state(
    provider: &UpstreamProvider,
    state: &ProviderRuntimeState,
    now_ms: i64,
) -> CircuitState {
    if !provider.circuit_breaker_enabled {
        return CircuitState::Closed;
    }
    match state.open_until_ms {
        Some(until_ms) if until_ms > now_ms => CircuitState::Open,
        Some(_) => CircuitState::HalfOpen,
        None => CircuitState::Closed,
    }
}

fn to_view(
    provider: &UpstreamProvider,
    state: &ProviderRuntimeState,
    now_ms: i64,
) -> ProviderRuntimeView {
    let circuit_state = circuit_state(provider, state, now_ms);
    let capacity_available = provider
        .max_concurrency
        .is_none_or(|limit| state.in_flight < limit.max(0) as u32);
    ProviderRuntimeView {
        state: circuit_state,
        available: provider.enabled
            && capacity_available
            && match circuit_state {
                CircuitState::Closed => true,
                CircuitState::Open => false,
                CircuitState::HalfOpen => state.probe_owner.is_none(),
            },
        in_flight: state.in_flight,
        max_concurrency: provider.max_concurrency,
        consecutive_failures: state.consecutive_failures,
        success_count: state.success_count,
        failure_count: state.failure_count,
        half_open_successes: state.half_open_successes,
        latency_ewma_ms: state.latency_ewma_ms.map(|value| value.round() as i64),
        open_until_ms: (circuit_state == CircuitState::Open)
            .then_some(state.open_until_ms)
            .flatten(),
        last_status: state.last_status,
        last_error_type: state.last_error_type.clone(),
        last_error_message: state.last_error_message.clone(),
        last_success_at_ms: state.last_success_at_ms,
        last_failure_at_ms: state.last_failure_at_ms,
    }
}

fn attempt_token_matches(state: &ProviderRuntimeState, token: ProviderAttemptToken) -> bool {
    state.generation == token.generation
        && token
            .probe_id
            .is_none_or(|probe_id| state.probe_owner == Some(probe_id))
}

fn release_probe_owner(state: &mut ProviderRuntimeState, token: ProviderAttemptToken) {
    if token
        .probe_id
        .is_some_and(|probe_id| state.probe_owner == Some(probe_id))
    {
        state.probe_owner = None;
    }
}

fn advance_generation(state: &mut ProviderRuntimeState) {
    state.generation = state.generation.wrapping_add(1).max(1);
    state.probe_owner = None;
}

fn clear_breaker_state(state: &mut ProviderRuntimeState) {
    state.consecutive_failures = 0;
    state.open_until_ms = None;
    state.half_open_successes = 0;
    state.probe_owner = None;
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct QuotaRuntimeView {
    pub remaining_requests: Option<i64>,
    pub remaining_tokens: Option<i64>,
    pub reset_at_ms: Option<i64>,
    pub cooldown_until_ms: Option<i64>,
    pub consecutive_rate_limits: u32,
    pub updated_at_ms: Option<i64>,
}

#[derive(Default)]
struct QuotaState {
    remaining_requests: Option<i64>,
    remaining_tokens: Option<i64>,
    reset_at_ms: Option<i64>,
    cooldown_until_ms: Option<i64>,
    consecutive_rate_limits: u32,
    updated_at_ms: Option<i64>,
}

pub struct QuotaBook {
    by_key: RwLock<HashMap<i64, QuotaState>>,
}

impl QuotaBook {
    pub fn new() -> Self {
        Self {
            by_key: RwLock::new(HashMap::new()),
        }
    }

    pub fn is_available(&self, key_id: i64, now_ms: i64) -> bool {
        let mut guard = self.by_key.write();
        let Some(state) = guard.get_mut(&key_id) else {
            return true;
        };
        expire_quota_state(state, now_ms);
        state
            .cooldown_until_ms
            .is_none_or(|until_ms| until_ms <= now_ms)
            && !matches!(
                (state.remaining_requests, state.reset_at_ms),
                (Some(remaining), Some(reset_at)) if remaining <= 0 && reset_at > now_ms
            )
    }

    pub fn reserve_request(&self, key_id: i64, now_ms: i64) -> bool {
        let mut guard = self.by_key.write();
        let state = guard.entry(key_id).or_default();
        expire_quota_state(state, now_ms);
        let available = state
            .cooldown_until_ms
            .is_none_or(|until_ms| until_ms <= now_ms)
            && !matches!(
                (state.remaining_requests, state.reset_at_ms),
                (Some(remaining), Some(reset_at)) if remaining <= 0 && reset_at > now_ms
            );
        if !available {
            return false;
        }
        if let Some(remaining) = state.remaining_requests.as_mut() {
            *remaining = remaining.saturating_sub(1);
        }
        true
    }

    pub fn observe_response(
        &self,
        key_id: i64,
        status: i32,
        headers: &HeaderMap,
        now_ms: i64,
        fallback_cooldown: Duration,
    ) {
        let mut guard = self.by_key.write();
        let state = guard.entry(key_id).or_default();
        state.remaining_requests = first_i64_header(
            headers,
            &[
                "x-ratelimit-remaining-requests",
                "anthropic-ratelimit-requests-remaining",
            ],
        )
        .or(state.remaining_requests);
        state.remaining_tokens = first_i64_header(
            headers,
            &[
                "x-ratelimit-remaining-tokens",
                "anthropic-ratelimit-tokens-remaining",
            ],
        )
        .or(state.remaining_tokens);
        state.reset_at_ms = first_reset_header_ms(
            headers,
            &[
                "x-ratelimit-reset-requests",
                "anthropic-ratelimit-requests-reset",
                "x-ratelimit-reset-tokens",
                "anthropic-ratelimit-tokens-reset",
            ],
            now_ms,
        )
        .or(state.reset_at_ms);
        state.updated_at_ms = Some(now_ms);

        if matches!(status, 402 | 429) {
            state.consecutive_rate_limits = state.consecutive_rate_limits.saturating_add(1);
            let retry_after_ms = retry_after_ms(headers)
                .or_else(|| state.reset_at_ms.map(|reset| reset.saturating_sub(now_ms)))
                .filter(|value| *value > 0)
                .unwrap_or_else(|| {
                    let base = fallback_cooldown.as_millis().min(i64::MAX as u128) as i64;
                    let shift = state.consecutive_rate_limits.saturating_sub(1).min(4);
                    base.saturating_mul(1_i64 << shift)
                })
                .clamp(1_000, 5 * 60 * 1_000);
            state.cooldown_until_ms = Some(now_ms.saturating_add(retry_after_ms));
        } else if status < 400 {
            state.consecutive_rate_limits = 0;
            state.cooldown_until_ms = None;
        }
    }

    pub fn snapshot(&self, key_id: i64, now_ms: i64) -> QuotaRuntimeView {
        let mut guard = self.by_key.write();
        let Some(state) = guard.get_mut(&key_id) else {
            return QuotaRuntimeView::default();
        };
        expire_quota_state(state, now_ms);
        QuotaRuntimeView {
            remaining_requests: state.remaining_requests,
            remaining_tokens: state.remaining_tokens,
            reset_at_ms: state.reset_at_ms,
            cooldown_until_ms: state.cooldown_until_ms,
            consecutive_rate_limits: state.consecutive_rate_limits,
            updated_at_ms: state.updated_at_ms,
        }
    }

    pub fn purge_key(&self, key_id: i64) {
        self.by_key.write().remove(&key_id);
    }
}

fn expire_quota_state(state: &mut QuotaState, now_ms: i64) {
    if state.reset_at_ms.is_some_and(|reset_at| reset_at <= now_ms) {
        state.remaining_requests = None;
        state.remaining_tokens = None;
        state.reset_at_ms = None;
    }
    if state
        .cooldown_until_ms
        .is_some_and(|cooldown_until| cooldown_until <= now_ms)
    {
        state.cooldown_until_ms = None;
    }
}

fn first_i64_header(headers: &HeaderMap, names: &[&str]) -> Option<i64> {
    names.iter().find_map(|name| {
        headers
            .get(*name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<i64>().ok())
    })
}

fn first_reset_header_ms(headers: &HeaderMap, names: &[&str], now_ms: i64) -> Option<i64> {
    names.iter().find_map(|name| {
        let value = headers.get(*name)?.to_str().ok()?.trim();
        if let Ok(timestamp) = value.parse::<i64>() {
            if timestamp < 0 {
                return None;
            }
            return if timestamp > 10_000_000_000 {
                Some(timestamp)
            } else {
                timestamp.checked_mul(1_000)
            };
        }
        if let Ok(timestamp) = OffsetDateTime::parse(value, &Rfc3339) {
            let millis = timestamp.unix_timestamp_nanos() / 1_000_000;
            return i64::try_from(millis).ok().filter(|value| *value >= 0);
        }
        parse_relative_duration_ms(value).and_then(|duration| now_ms.checked_add(duration))
    })
}

fn retry_after_ms(headers: &HeaderMap) -> Option<i64> {
    let value = headers.get("retry-after")?.to_str().ok()?.trim();
    value
        .parse::<i64>()
        .ok()
        .map(|seconds| seconds.saturating_mul(1_000))
        .or_else(|| parse_relative_duration_ms(value))
}

fn parse_relative_duration_ms(value: &str) -> Option<i64> {
    let (number, multiplier) = if let Some(number) = value.strip_suffix("ms") {
        (number, 1.0)
    } else if let Some(number) = value.strip_suffix('s') {
        (number, 1_000.0)
    } else if let Some(number) = value.strip_suffix('m') {
        (number, 60_000.0)
    } else if let Some(number) = value.strip_suffix('h') {
        (number, 3_600_000.0)
    } else {
        return None;
    };
    let parsed = number.trim().parse::<f64>().ok()?;
    if !parsed.is_finite() || parsed < 0.0 {
        return None;
    }
    let millis = (parsed * multiplier).round();
    if !millis.is_finite() || millis > i64::MAX as f64 {
        return None;
    }
    Some(millis as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn provider() -> UpstreamProvider {
        UpstreamProvider {
            id: 7,
            name: "provider-a".to_string(),
            provider_type: "openai".to_string(),
            enabled: true,
            priority: 100,
            weight: 1,
            supports_include_usage: true,
            websocket_enabled: false,
            beta_features: Vec::new(),
            key_selection_strategy: "round_robin".to_string(),
            max_attempts: 2,
            max_concurrency: Some(1),
            circuit_breaker_enabled: true,
            circuit_breaker_failure_threshold: 3,
            circuit_breaker_open_ms: 30_000,
            circuit_breaker_half_open_success_threshold: 2,
        }
    }

    #[test]
    fn concurrency_permit_should_release_on_drop() {
        let book = Arc::new(ProviderRuntimeBook::new());
        let provider = provider();
        let permit = book.try_acquire_capacity(&provider).expect("first permit");
        assert!(book.try_acquire_capacity(&provider).is_none());
        drop(permit);
        assert!(book.try_acquire_capacity(&provider).is_some());
    }

    #[test]
    fn abandoned_half_open_permit_should_release_probe() {
        let book = Arc::new(ProviderRuntimeBook::new());
        let mut provider = provider();
        provider.circuit_breaker_failure_threshold = 1;
        book.try_begin_attempt(&provider, 100)
            .expect("closed attempt")
            .failure(Some(502), "upstream_error", "failed", 100);

        let attempt = book.try_begin_attempt(&provider, 100 + provider.circuit_breaker_open_ms);
        assert!(attempt.is_some());
        assert!(
            !book
                .snapshot(&provider, 100 + provider.circuit_breaker_open_ms)
                .available
        );

        drop(attempt);
        let view = book.snapshot(&provider, 100 + provider.circuit_breaker_open_ms);
        assert_eq!(view.state, CircuitState::HalfOpen);
        assert!(view.available);
    }

    #[test]
    fn circuit_should_open_after_logical_failure_threshold() {
        let book = Arc::new(ProviderRuntimeBook::new());
        let provider = provider();
        for now_ms in [1_000, 2_000, 3_000] {
            book.try_begin_attempt(&provider, now_ms)
                .expect("closed attempt")
                .failure(Some(502), "upstream_error", "failed", now_ms);
        }
        assert_eq!(book.snapshot(&provider, 3_001).state, CircuitState::Open);
        assert_eq!(
            book.snapshot(&provider, 33_001).state,
            CircuitState::HalfOpen
        );
    }

    #[test]
    fn half_open_should_require_two_successes() {
        let book = Arc::new(ProviderRuntimeBook::new());
        let provider = provider();
        for now_ms in [1_000, 2_000, 3_000] {
            book.try_begin_attempt(&provider, now_ms)
                .expect("closed attempt")
                .failure(Some(502), "upstream_error", "failed", now_ms);
        }
        book.try_begin_attempt(&provider, 33_001)
            .expect("first half-open probe")
            .success(Some(200), Some(10), 33_001);
        assert_eq!(
            book.snapshot(&provider, 33_002).state,
            CircuitState::HalfOpen
        );
        book.try_begin_attempt(&provider, 33_003)
            .expect("second half-open probe")
            .success(Some(200), Some(10), 33_003);
        assert_eq!(book.snapshot(&provider, 33_004).state, CircuitState::Closed);
    }

    #[test]
    fn old_generation_result_should_not_release_current_half_open_probe() {
        let book = Arc::new(ProviderRuntimeBook::new());
        let mut provider = provider();
        provider.circuit_breaker_failure_threshold = 1;
        let old_attempt = book
            .try_begin_attempt(&provider, 50)
            .expect("old closed attempt");
        book.try_begin_attempt(&provider, 51)
            .expect("opening attempt")
            .failure(Some(503), "upstream_error", "failed", 51);
        let probe_at = 51 + provider.circuit_breaker_open_ms;
        let current_probe = book
            .try_begin_attempt(&provider, probe_at)
            .expect("current half-open probe");

        old_attempt.success(Some(200), Some(10), probe_at + 1);

        let view = book.snapshot(&provider, probe_at + 1);
        assert_eq!(view.half_open_successes, 0);
        assert!(!view.available);
        drop(current_probe);
        assert!(book.snapshot(&provider, probe_at + 2).available);
    }

    #[test]
    fn reset_should_preserve_capacity_and_ignore_old_attempt_result() {
        let book = Arc::new(ProviderRuntimeBook::new());
        let provider = provider();
        let capacity = book
            .try_acquire_capacity(&provider)
            .expect("capacity permit");
        let old_attempt = book.try_begin_attempt(&provider, 100).expect("old attempt");

        book.reset(provider.id);
        assert_eq!(book.snapshot(&provider, 101).in_flight, 1);
        assert!(book.try_acquire_capacity(&provider).is_none());
        old_attempt.failure(Some(503), "upstream_error", "failed", 102);
        assert_eq!(book.snapshot(&provider, 103).state, CircuitState::Closed);
        assert_eq!(book.snapshot(&provider, 103).consecutive_failures, 0);

        drop(capacity);
        assert_eq!(book.snapshot(&provider, 104).in_flight, 0);
    }

    #[test]
    fn rate_limit_headers_should_cool_key_until_reset() {
        let book = QuotaBook::new();
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("2"));
        headers.insert(
            "x-ratelimit-remaining-requests",
            HeaderValue::from_static("0"),
        );
        book.observe_response(9, 429, &headers, 1_000, Duration::from_secs(30));

        assert!(!book.is_available(9, 2_999));
        assert!(book.is_available(9, 3_001));
    }

    #[test]
    fn rfc3339_reset_header_should_restore_key_after_deadline() {
        let book = QuotaBook::new();
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-ratelimit-requests-remaining",
            HeaderValue::from_static("0"),
        );
        headers.insert(
            "anthropic-ratelimit-requests-reset",
            HeaderValue::from_static("1970-01-01T00:00:03Z"),
        );
        book.observe_response(9, 429, &headers, 1_000, Duration::from_secs(30));

        assert!(!book.is_available(9, 2_999));
        assert!(book.is_available(9, 3_001));
    }

    #[test]
    fn one_remaining_request_should_allow_only_one_concurrent_reservation() {
        let book = Arc::new(QuotaBook::new());
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-ratelimit-remaining-requests",
            HeaderValue::from_static("1"),
        );
        headers.insert(
            "x-ratelimit-reset-requests",
            HeaderValue::from_static("100"),
        );
        book.observe_response(9, 200, &headers, 1_000, Duration::from_secs(30));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let book = book.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                book.reserve_request(9, 1_001)
            }));
        }
        barrier.wait();

        let reserved: usize = handles
            .into_iter()
            .map(|handle| usize::from(handle.join().expect("reservation thread")))
            .sum();
        assert_eq!(reserved, 1);
    }
}
