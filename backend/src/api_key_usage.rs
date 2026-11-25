use std::collections::HashMap;
use std::sync::{Arc, Weak};

use hyper::StatusCode;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::db::Database;
use crate::pricing::{PricedCost, total_input_tokens};
use crate::types::{ApiKeyAuth, Usage};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ApiKeyLimit {
    Tokens(i64),
    CostUsd(#[serde(with = "rust_decimal::serde::str")] Decimal),
}

impl ApiKeyLimit {
    pub fn is_positive(self) -> bool {
        match self {
            Self::Tokens(value) => value > 0,
            Self::CostUsd(value) => value > Decimal::ZERO,
        }
    }

    pub fn reached(self, usage: &ApiKeyUsage) -> bool {
        match self {
            Self::Tokens(value) => usage.total_tokens >= value,
            Self::CostUsd(value) => usage.cost_usd.is_some_and(|cost| cost >= value),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct ApiKeyUsage {
    pub total_tokens: i64,
    pub observed_requests: i64,
    pub priced_tokens: i64,
    #[serde(with = "rust_decimal::serde::str_option")]
    pub cost_usd: Option<Decimal>,
}

impl ApiKeyUsage {
    pub fn tokens(usage: &Usage) -> i64 {
        total_input_tokens(usage).saturating_add(usage.output_tokens.max(0))
    }

    pub fn add_priced(&mut self, tokens: i64, cost: PricedCost) {
        self.priced_tokens = self.priced_tokens.saturating_add(tokens);
        let total = self.cost_usd.unwrap_or_default();
        self.cost_usd = Some(
            total
                .checked_add(cost.input_usd)
                .and_then(|value| value.checked_add(cost.output_usd))
                .unwrap_or(Decimal::MAX),
        );
    }
}

pub type ApiKeyUsagePermit = Arc<OwnedMutexGuard<()>>;

#[derive(Default)]
pub struct ApiKeyUsageLimiter {
    active: parking_lot::Mutex<HashMap<i64, Weak<Mutex<()>>>>,
}

impl ApiKeyUsageLimiter {
    pub async fn admit(
        &self,
        db: &Database,
        key: &ApiKeyAuth,
    ) -> Result<Option<ApiKeyUsagePermit>, KeyAdmissionError> {
        if key.usage_limit.is_none() {
            return Ok(None);
        }

        let gate = {
            let mut active = self.active.lock();
            active.retain(|_, gate| gate.strong_count() > 0);
            active
                .get(&key.id)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| {
                    let gate = Arc::new(Mutex::new(()));
                    active.insert(key.id, Arc::downgrade(&gate));
                    gate
                })
        };
        // A limited key has one admitted generation at a time within this gateway process.
        let permit = gate.lock_owned().await;
        let (limit, usage) = db
            .get_live_api_key_usage(key.id, crate::util::now_ms())
            .await
            .map_err(|error| {
                log::error!("failed to check API key {} usage: {error}", key.id);
                KeyAdmissionError::Unavailable
            })?
            .ok_or(KeyAdmissionError::Invalid)?;
        if limit.is_some_and(|limit| limit.reached(&usage)) {
            return Err(KeyAdmissionError::Exhausted);
        }
        Ok(limit.map(|_| Arc::new(permit)))
    }
}

#[derive(Clone, Copy)]
pub enum KeyAdmissionError {
    Exhausted,
    Invalid,
    Unavailable,
}

impl KeyAdmissionError {
    pub fn status(self) -> StatusCode {
        match self {
            Self::Exhausted => StatusCode::TOO_MANY_REQUESTS,
            Self::Invalid => StatusCode::UNAUTHORIZED,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Exhausted => "api_key_limit_reached",
            Self::Invalid => "invalid_api_key",
            Self::Unavailable => "api_key_usage_unavailable",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Exhausted => "API key usage limit reached",
            Self::Invalid => "API key expired, disabled or removed",
            Self::Unavailable => "API key usage is unavailable",
        }
    }
}

pub async fn settle_api_key_usage(
    db: &Database,
    key_id: i64,
    usage: Usage,
    usage_observed: bool,
    cost: Option<PricedCost>,
) {
    if usage_observed && let Err(error) = db.add_api_key_usage(key_id, &usage, cost).await {
        log::error!("failed to settle API key {key_id} usage: {error}");
    }
}
