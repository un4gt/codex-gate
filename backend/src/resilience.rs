//! Small, process-local safeguards shared by every upstream transport.
use std::{collections::HashMap, time::Duration};

use hyper::HeaderMap;
use tokio::time::Instant;

pub const MAX_ATTEMPTS: usize = 3;
pub const COOLDOWN_BASE_MS: i64 = 30_000;
pub const COOLDOWN_MAX_MS: i64 = 300_000;

pub fn cooldown_ms(configured_ms: i64, failures: u32) -> i64 {
    let base = configured_ms.max(COOLDOWN_BASE_MS);
    base.saturating_mul(1_i64 << failures.saturating_sub(1).min(10))
        .min(COOLDOWN_MAX_MS.max(base))
}

/// A caller owns one budget for the whole request, including auth replay and failover.
pub struct AttemptBudget {
    used: usize,
    deadline: Instant,
    setup_credit: bool,
    sent_by_provider: HashMap<i64, usize>,
}

impl AttemptBudget {
    pub fn new(timeout: Duration) -> Self {
        Self {
            used: 0,
            deadline: Instant::now() + timeout,
            setup_credit: false,
            sent_by_provider: HashMap::new(),
        }
    }

    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    pub fn available(&self) -> bool {
        self.used < MAX_ATTEMPTS && !self.remaining().is_zero()
    }

    pub fn used(&self) -> usize {
        self.used
    }

    pub fn provider_available(&self, provider_id: i64, configured_max: i32) -> bool {
        self.sent_by_provider
            .get(&provider_id)
            .copied()
            .unwrap_or(0)
            < configured_max.max(1) as usize
    }

    pub fn note_send(&mut self, provider_id: i64) {
        *self.sent_by_provider.entry(provider_id).or_default() += 1;
    }

    pub async fn begin_for_provider(
        &mut self,
        provider_id: i64,
        configured_max: i32,
        turn: bool,
    ) -> bool {
        if turn && self.setup_credit {
            return self.begin_turn().await;
        }
        self.provider_available(provider_id, configured_max) && self.begin().await
    }

    pub fn credit_connected_setup(&mut self) {
        self.setup_credit = true;
    }

    pub async fn begin_turn(&mut self) -> bool {
        if std::mem::take(&mut self.setup_credit) {
            return !self.remaining().is_zero();
        }
        self.begin().await
    }

    pub async fn begin(&mut self) -> bool {
        self.setup_credit = false;
        if !self.available() {
            return false;
        }
        if self.used > 0 {
            let delay = Duration::from_millis((500 << (self.used - 1)) + fastrand::u64(0..=250));
            if delay >= self.remaining() {
                return false;
            }
            tokio::time::sleep(delay).await;
        }
        if self.remaining().is_zero() {
            return false;
        }
        self.used += 1;
        true
    }
}

/// Retry-After is a lower bound, including an HTTP-date; never truncate it to our fallback cap.
pub fn retry_after_ms(headers: &HeaderMap, now_ms: i64) -> Option<i64> {
    let value = headers.get("retry-after")?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1_000).min(i64::MAX as u64) as i64);
    }
    let date = httpdate::parse_http_date(value).ok()?;
    let timestamp = date.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    Some(
        (timestamp.min(i64::MAX as u128) as i64)
            .saturating_sub(now_ms)
            .max(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_grows_and_preserves_longer_operator_settings() {
        assert_eq!(
            [1, 2, 3, 4, 5, 20].map(|n| cooldown_ms(1_000, n)),
            [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]
        );
        assert_eq!(cooldown_ms(600_000, 1), 600_000);
    }

    #[test]
    fn retry_after_accepts_http_dates_and_long_delays() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "retry-after",
            "Thu, 01 Jan 1970 00:10:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after_ms(&headers, 1_000), Some(599_000));
        headers.insert("retry-after", "3600".parse().unwrap());
        assert_eq!(retry_after_ms(&headers, 0), Some(3_600_000));
    }

    #[tokio::test(start_paused = true)]
    async fn budget_delays_retries_and_stops_after_three_sends() {
        let mut budget = AttemptBudget::new(Duration::from_secs(120));
        assert!(budget.begin().await);
        let start = Instant::now();
        assert!(budget.begin().await);
        assert!(start.elapsed() >= Duration::from_millis(500));
        assert!(budget.begin().await);
        assert!(!budget.begin().await);
        assert_eq!(budget.used(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn provider_limit_counts_sends_and_allows_other_providers() {
        let mut budget = AttemptBudget::new(Duration::from_secs(120));
        assert!(budget.begin_for_provider(7, 1, false).await);
        budget.note_send(7);
        budget.credit_connected_setup();
        assert!(budget.begin_for_provider(7, 1, true).await);
        assert_eq!(budget.used(), 1);
        assert!(!budget.begin_for_provider(7, 1, false).await);
        assert!(budget.begin_for_provider(8, 1, false).await);
        budget.note_send(8);
        assert_eq!(budget.used(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn insufficient_deadline_stops_retry_without_waiting_or_sending() {
        let mut budget = AttemptBudget::new(Duration::from_millis(400));
        assert!(budget.begin().await);
        let start = Instant::now();
        assert!(!budget.begin().await);
        assert_eq!(budget.used(), 1);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn websocket_setup_and_first_turn_share_one_attempt() {
        let mut budget = AttemptBudget::new(Duration::from_secs(120));
        assert!(budget.begin().await);
        budget.credit_connected_setup();
        assert!(budget.begin_turn().await);
        assert_eq!(budget.used(), 1);
        assert!(budget.begin_turn().await);
        assert_eq!(budget.used(), 2);
    }
}
