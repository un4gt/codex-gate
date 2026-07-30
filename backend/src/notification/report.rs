use std::collections::HashMap;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::store::UsageGroupRow;
use super::{
    AlertMetric, AlertScopeKind, NotificationError, NotificationLocale, ThresholdAlertConfig,
};
use crate::health::{CircuitState, summarize_provider_health};
use crate::pricing::PriceVersion;
use crate::state::SharedState;
use crate::types::Usage;
use crate::util;

const SCHEMA_VERSION: u8 = 1;
const MAX_WEBHOOK_DIMENSION_ITEMS: usize = 1_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NotificationPayload {
    pub schema_version: u8,
    pub event: EventPayload,
    pub rule: RulePayload,
    pub instance: InstancePayload,
    pub window: WindowPayload,
    pub server: ServerPayload,
    pub usage: UsagePayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alert: Option<AlertPayload>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EventPayload {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub occurred_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RulePayload {
    pub id: Option<i64>,
    pub name: String,
    pub locale: String,
    pub top_n: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InstancePayload {
    pub id: String,
    pub hostname: Option<String>,
    pub version: String,
    pub commit: String,
    pub started_at_ms: i64,
    pub uptime_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WindowPayload {
    pub from_ms: i64,
    pub to_ms: i64,
    pub timezone: String,
    pub catch_up: bool,
    pub missed_occurrences: u32,
    pub data_complete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServerPayload {
    pub database_ready: bool,
    pub scope: String,
    pub cpu_usage_percent: Option<f64>,
    pub cpu_capacity_cores: f64,
    pub cpu_sample_ms: Option<u64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub memory_usage_percent: Option<f64>,
    pub memory_limited: bool,
    pub providers_enabled: usize,
    pub healthy: u32,
    pub warning: u32,
    pub error: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UsagePayload {
    pub totals: UsageAggregate,
    pub providers: Vec<UsageDimension>,
    pub client_keys: Vec<UsageDimension>,
    pub truncated: bool,
    pub total_provider_items: usize,
    pub total_client_key_items: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct UsageAggregate {
    pub requests: i64,
    pub failed: i64,
    pub error_rate_percent: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
    pub usage_observed_requests: i64,
    pub usage_coverage_percent: f64,
    pub estimated_cost_usd: String,
    pub unpriced_requests: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UsageDimension {
    pub id: i64,
    pub name: String,
    #[serde(flatten)]
    pub aggregate: UsageAggregate,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AlertPayload {
    pub metric: AlertMetric,
    pub scope_kind: AlertScopeKind,
    pub scope_id: Option<i64>,
    pub value: f64,
    pub threshold: f64,
    pub complete: bool,
    pub state: String,
}

#[derive(Clone, Copy, Debug)]
pub struct MetricValue {
    pub value: f64,
    pub complete: bool,
    pub sample_count: i64,
}

#[derive(Clone, Debug, Default)]
struct MutableAggregate {
    requests: i64,
    failed: i64,
    usage_observed_requests: i64,
    usage: Usage,
    estimated_cost_usd: Decimal,
    unpriced_requests: i64,
}

impl MutableAggregate {
    fn add(&mut self, row: &UsageGroupRow, price: Option<&PriceVersion>) {
        let requests = row.request_success.saturating_add(row.request_failed);
        self.requests = self.requests.saturating_add(requests);
        self.failed = self.failed.saturating_add(row.request_failed);
        self.usage_observed_requests = self
            .usage_observed_requests
            .saturating_add(row.usage_observed_requests);
        self.usage.input_tokens = self
            .usage
            .input_tokens
            .saturating_add(row.usage.input_tokens);
        self.usage.output_tokens = self
            .usage
            .output_tokens
            .saturating_add(row.usage.output_tokens);
        self.usage.cache_read_input_tokens = self
            .usage
            .cache_read_input_tokens
            .saturating_add(row.usage.cache_read_input_tokens);
        self.usage.cache_creation_input_tokens = self
            .usage
            .cache_creation_input_tokens
            .saturating_add(row.usage.cache_creation_input_tokens);
        self.usage.reasoning_output_tokens = self
            .usage
            .reasoning_output_tokens
            .saturating_add(row.usage.reasoning_output_tokens);

        let Some(price) = price else {
            self.unpriced_requests = self
                .unpriced_requests
                .saturating_add(row.usage_observed_requests);
            return;
        };
        let tier_index = row.price_tier_index.unwrap_or(0);
        if let Some(cost) = price.card.cost_for_usage(&row.usage, tier_index) {
            self.estimated_cost_usd += cost.input_usd + cost.output_usd;
        } else {
            self.unpriced_requests = self
                .unpriced_requests
                .saturating_add(row.usage_observed_requests);
        }
    }

    fn finish(self) -> UsageAggregate {
        let total_tokens = self
            .usage
            .input_tokens
            .saturating_add(self.usage.output_tokens)
            .saturating_add(self.usage.cache_read_input_tokens)
            .saturating_add(self.usage.cache_creation_input_tokens);
        UsageAggregate {
            requests: self.requests,
            failed: self.failed,
            error_rate_percent: percent(self.failed, self.requests),
            input_tokens: self.usage.input_tokens,
            output_tokens: self.usage.output_tokens,
            cache_read_input_tokens: self.usage.cache_read_input_tokens,
            cache_creation_input_tokens: self.usage.cache_creation_input_tokens,
            reasoning_output_tokens: self.usage.reasoning_output_tokens,
            total_tokens,
            usage_observed_requests: self.usage_observed_requests,
            usage_coverage_percent: percent(self.usage_observed_requests, self.requests),
            estimated_cost_usd: self.estimated_cost_usd.normalize().to_string(),
            unpriced_requests: self.unpriced_requests,
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "payload captures an immutable notification event"
)]
pub async fn build_payload(
    state: &SharedState,
    event_id: &str,
    event_type: &str,
    rule_id: Option<i64>,
    rule_name: &str,
    locale: NotificationLocale,
    top_n: u16,
    from_ms: i64,
    to_ms: i64,
    timezone: &str,
    catch_up: bool,
    missed_occurrences: u32,
    alert: Option<AlertPayload>,
) -> Result<NotificationPayload, NotificationError> {
    let rows = state
        .db
        .notification_aggregate_usage(from_ms, to_ms)
        .await?;
    let mut price_ids = rows
        .iter()
        .filter_map(|row| row.price_version_id)
        .collect::<Vec<_>>();
    price_ids.sort_unstable();
    price_ids.dedup();
    let prices = state.db.list_price_versions(&price_ids).await?;
    let prices = prices
        .into_iter()
        .map(|price| (price.id, price))
        .collect::<HashMap<_, _>>();
    let providers = state.db.list_upstream_providers().await?;
    let provider_names = providers
        .iter()
        .map(|provider| (provider.id, provider.name.clone()))
        .collect::<HashMap<_, _>>();
    let api_keys = state.db.list_api_keys().await?;
    let api_key_names = api_keys
        .into_iter()
        .map(|key| (key.id, key.name))
        .collect::<HashMap<_, _>>();

    let mut totals = MutableAggregate::default();
    let mut by_provider = HashMap::<i64, MutableAggregate>::new();
    let mut by_client_key = HashMap::<i64, MutableAggregate>::new();
    for row in &rows {
        let price = row.price_version_id.and_then(|id| prices.get(&id));
        totals.add(row, price);
        if let Some(provider_id) = row.provider_id {
            by_provider.entry(provider_id).or_default().add(row, price);
        }
        by_client_key
            .entry(row.api_key_id)
            .or_default()
            .add(row, price);
    }

    let mut provider_rows = by_provider
        .into_iter()
        .map(|(id, aggregate)| UsageDimension {
            id,
            name: provider_names
                .get(&id)
                .cloned()
                .unwrap_or_else(|| format!("Provider #{id}")),
            aggregate: aggregate.finish(),
        })
        .collect::<Vec<_>>();
    let mut client_key_rows = by_client_key
        .into_iter()
        .map(|(id, aggregate)| UsageDimension {
            id,
            name: api_key_names
                .get(&id)
                .cloned()
                .unwrap_or_else(|| format!("Key #{id}")),
            aggregate: aggregate.finish(),
        })
        .collect::<Vec<_>>();
    sort_dimensions(&mut provider_rows);
    sort_dimensions(&mut client_key_rows);
    let total_provider_items = provider_rows.len();
    let total_client_key_items = client_key_rows.len();
    let truncated = truncate_dimensions(&mut provider_rows, locale)
        | truncate_dimensions(&mut client_key_rows, locale);

    let now_ms = util::now_ms();
    let retention_days = state.runtime_settings.snapshot().request_log_retention_days as i64;
    let retention_cutoff = now_ms.saturating_sub(retention_days.saturating_mul(86_400_000));
    let data_complete = retention_days == 0 || from_ms >= retention_cutoff;
    let mut warnings = Vec::new();
    if !data_complete {
        warnings.push(super::localized(
            locale,
            "报表窗口早于明细统计保留期，数据可能不完整。",
            "The report window exceeds detailed-stat retention and may be incomplete.",
        ));
    }
    let total_aggregate = totals.finish();
    if total_aggregate.usage_observed_requests < total_aggregate.requests {
        warnings.push(super::localized(
            locale,
            "部分请求未返回用量，Token 和成本为已观测下限。",
            "Some requests did not return usage; token and cost values are observed lower bounds.",
        ));
    }
    if total_aggregate.unpriced_requests > 0 {
        warnings.push(super::localized(
            locale,
            "部分请求缺少价格，成本未覆盖全部用量。",
            "Some requests are unpriced, so cost does not cover all usage.",
        ));
    }
    if truncated {
        warnings.push(super::localized(
            locale,
            "维度明细超过 Webhook 安全上限，尾部项目已合并为“其他”。",
            "Dimension details exceeded the Webhook safety limit; trailing items were grouped as Other.",
        ));
    }

    let server_status = state.system_status.snapshot();
    let database_ready = tokio::time::timeout(std::time::Duration::from_secs(2), state.db.ping())
        .await
        .is_ok_and(|result| result.is_ok());
    let (healthy, warning, error) = provider_health_counts(state, now_ms).await?;

    Ok(NotificationPayload {
        schema_version: SCHEMA_VERSION,
        event: EventPayload {
            id: event_id.to_string(),
            event_type: event_type.to_string(),
            occurred_at_ms: now_ms,
        },
        rule: RulePayload {
            id: rule_id,
            name: rule_name.to_string(),
            locale: locale.as_str().to_string(),
            top_n,
        },
        instance: InstancePayload {
            id: state.instance_id.clone(),
            hostname: std::env::var("HOSTNAME")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            version: option_env!("LITTLE_GATE_VERSION")
                .unwrap_or("dev")
                .to_string(),
            commit: option_env!("LITTLE_GATE_COMMIT")
                .unwrap_or("unknown")
                .to_string(),
            started_at_ms: state.started_at_ms,
            uptime_ms: now_ms.saturating_sub(state.started_at_ms),
        },
        window: WindowPayload {
            from_ms,
            to_ms,
            timezone: timezone.to_string(),
            catch_up,
            missed_occurrences,
            data_complete,
        },
        server: ServerPayload {
            database_ready,
            scope: server_status.scope.to_string(),
            cpu_usage_percent: server_status.cpu_usage_percent,
            cpu_capacity_cores: server_status.cpu_capacity_cores,
            cpu_sample_ms: server_status.cpu_sample_ms,
            memory_used_bytes: server_status.memory_used_bytes,
            memory_total_bytes: server_status.memory_total_bytes,
            memory_usage_percent: server_status.memory_usage_percent,
            memory_limited: server_status.memory_limited,
            providers_enabled: providers.iter().filter(|provider| provider.enabled).count(),
            healthy,
            warning,
            error,
        },
        usage: UsagePayload {
            total_provider_items,
            total_client_key_items,
            totals: total_aggregate,
            providers: provider_rows,
            client_keys: client_key_rows,
            truncated,
        },
        alert,
        warnings,
    })
}

pub fn metric_value(
    payload: &NotificationPayload,
    config: &ThresholdAlertConfig,
) -> Option<MetricValue> {
    match config.metric {
        AlertMetric::CpuUsagePercent => payload.server.cpu_usage_percent.map(|value| MetricValue {
            value,
            complete: true,
            sample_count: 1,
        }),
        AlertMetric::MemoryUsagePercent => {
            payload
                .server
                .memory_usage_percent
                .map(|value| MetricValue {
                    value,
                    complete: true,
                    sample_count: 1,
                })
        }
        AlertMetric::UnhealthyProviderCount => Some(MetricValue {
            value: f64::from(payload.server.warning.saturating_add(payload.server.error)),
            complete: true,
            sample_count: payload.server.providers_enabled as i64,
        }),
        metric => {
            let aggregate = aggregate_for_scope(payload, config.scope_kind, config.scope_id)?;
            let value = match metric {
                AlertMetric::RequestCount => aggregate.requests as f64,
                AlertMetric::ErrorRatePercent => aggregate.error_rate_percent,
                AlertMetric::TotalTokens => aggregate.total_tokens as f64,
                AlertMetric::EstimatedCostUsd => {
                    aggregate.estimated_cost_usd.parse::<f64>().ok()?
                }
                _ => return None,
            };
            let complete = match metric {
                AlertMetric::TotalTokens => aggregate.usage_observed_requests >= aggregate.requests,
                AlertMetric::EstimatedCostUsd => {
                    aggregate.usage_observed_requests >= aggregate.requests
                        && aggregate.unpriced_requests == 0
                }
                _ => true,
            };
            Some(MetricValue {
                value,
                complete,
                sample_count: aggregate.requests,
            })
        }
    }
}

fn aggregate_for_scope(
    payload: &NotificationPayload,
    scope: AlertScopeKind,
    scope_id: Option<i64>,
) -> Option<&UsageAggregate> {
    match scope {
        AlertScopeKind::Global => Some(&payload.usage.totals),
        AlertScopeKind::Provider => payload
            .usage
            .providers
            .iter()
            .find(|item| Some(item.id) == scope_id)
            .map(|item| &item.aggregate),
        AlertScopeKind::ClientKey => payload
            .usage
            .client_keys
            .iter()
            .find(|item| Some(item.id) == scope_id)
            .map(|item| &item.aggregate),
    }
}

async fn provider_health_counts(
    state: &SharedState,
    now_ms: i64,
) -> Result<(u32, u32, u32), NotificationError> {
    let snapshot = state
        .caches
        .upstream
        .get(&state.db, &state.config.master_key)
        .await
        .map_err(NotificationError::internal)?;
    let mut healthy = 0_u32;
    let mut warning = 0_u32;
    let mut error = 0_u32;
    for provider in &snapshot.providers {
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
        let health = summarize_provider_health(
            endpoints,
            keys,
            &state.endpoint_health,
            &state.upstream_key_health,
            now_ms,
        );
        match health.state {
            CircuitState::Closed => healthy += 1,
            CircuitState::HalfOpen => warning += 1,
            CircuitState::Open => error += 1,
        }
    }
    Ok((healthy, warning, error))
}

fn sort_dimensions(items: &mut [UsageDimension]) {
    items.sort_by(|left, right| {
        let left_cost = left
            .aggregate
            .estimated_cost_usd
            .parse::<Decimal>()
            .unwrap_or_default();
        let right_cost = right
            .aggregate
            .estimated_cost_usd
            .parse::<Decimal>()
            .unwrap_or_default();
        right_cost
            .cmp(&left_cost)
            .then_with(|| {
                right
                    .aggregate
                    .total_tokens
                    .cmp(&left.aggregate.total_tokens)
            })
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn truncate_dimensions(items: &mut Vec<UsageDimension>, locale: NotificationLocale) -> bool {
    if items.len() <= MAX_WEBHOOK_DIMENSION_ITEMS {
        return false;
    }
    let remainder = items.split_off(MAX_WEBHOOK_DIMENSION_ITEMS - 1);
    let mut aggregate = UsageAggregate::default();
    let mut cost = Decimal::ZERO;
    for item in remainder {
        aggregate.requests = aggregate.requests.saturating_add(item.aggregate.requests);
        aggregate.failed = aggregate.failed.saturating_add(item.aggregate.failed);
        aggregate.input_tokens = aggregate
            .input_tokens
            .saturating_add(item.aggregate.input_tokens);
        aggregate.output_tokens = aggregate
            .output_tokens
            .saturating_add(item.aggregate.output_tokens);
        aggregate.cache_read_input_tokens = aggregate
            .cache_read_input_tokens
            .saturating_add(item.aggregate.cache_read_input_tokens);
        aggregate.cache_creation_input_tokens = aggregate
            .cache_creation_input_tokens
            .saturating_add(item.aggregate.cache_creation_input_tokens);
        aggregate.reasoning_output_tokens = aggregate
            .reasoning_output_tokens
            .saturating_add(item.aggregate.reasoning_output_tokens);
        aggregate.total_tokens = aggregate
            .total_tokens
            .saturating_add(item.aggregate.total_tokens);
        aggregate.usage_observed_requests = aggregate
            .usage_observed_requests
            .saturating_add(item.aggregate.usage_observed_requests);
        aggregate.unpriced_requests = aggregate
            .unpriced_requests
            .saturating_add(item.aggregate.unpriced_requests);
        cost += item
            .aggregate
            .estimated_cost_usd
            .parse::<Decimal>()
            .unwrap_or_default();
    }
    aggregate.error_rate_percent = percent(aggregate.failed, aggregate.requests);
    aggregate.usage_coverage_percent =
        percent(aggregate.usage_observed_requests, aggregate.requests);
    aggregate.estimated_cost_usd = cost.normalize().to_string();
    items.push(UsageDimension {
        id: 0,
        name: super::localized(locale, "其他", "Other"),
        aggregate,
    });
    true
}

fn percent(numerator: i64, denominator: i64) -> f64 {
    if denominator <= 0 {
        0.0
    } else {
        (numerator.max(0) as f64 / denominator as f64) * 100.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutable_aggregate_marks_missing_price_as_unpriced() {
        let row = UsageGroupRow {
            provider_id: Some(1),
            api_key_id: 2,
            price_version_id: None,
            price_tier_index: None,
            request_success: 2,
            request_failed: 0,
            usage_observed_requests: 2,
            usage: Usage {
                input_tokens: 10,
                output_tokens: 5,
                ..Usage::default()
            },
        };
        let mut aggregate = MutableAggregate::default();
        aggregate.add(&row, None);
        assert_eq!(aggregate.finish().unpriced_requests, 2);
    }

    #[test]
    fn incomplete_usage_is_not_treated_as_full_coverage() {
        let aggregate = MutableAggregate {
            requests: 4,
            usage_observed_requests: 2,
            ..MutableAggregate::default()
        }
        .finish();
        assert_eq!(aggregate.usage_coverage_percent, 50.0);
    }

    #[test]
    fn webhook_dimensions_group_items_beyond_the_limit() {
        let mut items = (1..=1_001)
            .map(|id| UsageDimension {
                id,
                name: format!("item-{id}"),
                aggregate: UsageAggregate {
                    requests: 1,
                    estimated_cost_usd: "0".to_string(),
                    ..UsageAggregate::default()
                },
            })
            .collect::<Vec<_>>();
        assert!(truncate_dimensions(&mut items, NotificationLocale::EnUs));
        assert_eq!(items.len(), MAX_WEBHOOK_DIMENSION_ITEMS);
        assert_eq!(items.last().map(|item| item.aggregate.requests), Some(2));
    }
}
