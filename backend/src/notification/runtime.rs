use std::sync::Arc;
use std::time::Duration;

use log::{error, warn};
use serde_json::json;
use tokio::sync::{Semaphore, mpsc};

use super::report::{AlertPayload, build_payload, metric_value};
use super::store::{
    AlertStateRecord, AlertStateUpdate, DeliveryAttemptDiagnostics, DeliveryFailure, RuleRecord,
};
use super::transport::{DeliveryContext, send_delivery};
use super::{
    ChannelConfig, DELIVERY_LEASE_MS, HISTORY_RETENTION_MS, NotificationError, NotificationLocale,
    RULE_LEASE_MS, RuleConfig, decode_rule_config, missed_occurrence_count, next_occurrences,
    previous_occurrence,
};
use crate::crypto;
use crate::state::SharedState;
use crate::util;

const POLL_INTERVAL: Duration = Duration::from_secs(15);
const ALERT_EVALUATION_MS: i64 = 60_000;
const RULE_RETRY_MS: i64 = 60_000;
const DELIVERY_BATCH: i64 = 32;
const RULE_BATCH: i64 = 16;
const DELIVERY_CONCURRENCY: usize = 4;

pub fn spawn(state: SharedState, mut wake_rx: mpsc::Receiver<()>) {
    tokio::spawn(async move {
        let semaphore = Arc::new(Semaphore::new(DELIVERY_CONCURRENCY));
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut next_cleanup_ms = util::now_ms();
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                value = wake_rx.recv() => {
                    if value.is_none() {
                        break;
                    }
                }
            }
            if let Err(error) = process_rules(&state).await {
                warn!("notification rule processing failed: {error}");
            }
            if let Err(error) = dispatch_deliveries(&state, semaphore.clone()).await {
                warn!("notification delivery dispatch failed: {error}");
            }
            let now_ms = util::now_ms();
            if now_ms >= next_cleanup_ms {
                let cutoff = now_ms.saturating_sub(HISTORY_RETENTION_MS);
                match state.db.notification_cleanup_history(cutoff).await {
                    Ok(removed) if removed > 0 => {
                        log::info!("notification history cleanup removed {removed} runs");
                    }
                    Ok(_) => {}
                    Err(error) => warn!("notification history cleanup failed: {error}"),
                }
                next_cleanup_ms = now_ms.saturating_add(86_400_000);
            }
        }
    });
}

async fn process_rules(state: &SharedState) -> Result<(), NotificationError> {
    let now_ms = util::now_ms();
    let rules = state
        .db
        .notification_list_due_rules(now_ms, RULE_BATCH)
        .await?;
    for rule in rules {
        let owner = state.instance_id.as_str();
        let claimed = state
            .db
            .notification_claim_rule(rule.id, owner, now_ms, now_ms.saturating_add(RULE_LEASE_MS))
            .await?;
        if !claimed {
            continue;
        }
        let result = process_rule(state, &rule, now_ms).await;
        if let Err(error) = result {
            warn!("notification rule {} failed: {}", rule.id, error);
            state
                .db
                .notification_release_rule(
                    rule.id,
                    owner,
                    now_ms.saturating_add(RULE_RETRY_MS),
                    now_ms,
                )
                .await?;
        }
    }
    Ok(())
}

async fn process_rule(
    state: &SharedState,
    rule: &RuleRecord,
    now_ms: i64,
) -> Result<(), NotificationError> {
    let config = decode_rule_config(&rule.config_json)?;
    let owner = state.instance_id.as_str();
    match config {
        RuleConfig::ScheduledReport(config) => {
            flush_recent_telemetry(state).await;
            let boundary = previous_occurrence(&config.cron, &config.timezone, now_ms + 1)?;
            let from_ms = match rule.last_window_end_ms {
                Some(value) if value < boundary => value,
                _ => previous_occurrence(&config.cron, &config.timezone, boundary)?,
            };
            let missed_occurrences = missed_occurrence_count(
                &config.cron,
                &config.timezone,
                rule.next_run_at_ms,
                boundary,
            )?;
            let catch_up = missed_occurrences > 0;
            let run_id = util::new_ulid();
            let payload = build_payload(
                state,
                &run_id,
                "scheduled_report",
                Some(rule.id),
                &rule.name,
                config.locale,
                config.top_n,
                from_ms,
                boundary,
                &config.timezone,
                catch_up,
                missed_occurrences,
                None,
            )
            .await?;
            let channel_ids = state.db.notification_rule_channel_ids(rule.id).await?;
            let payload_json = serde_json::to_string(&payload)?;
            let _ = state
                .db
                .notification_create_run(
                    &run_id,
                    Some(rule.id),
                    &rule.name,
                    "scheduled_report",
                    boundary,
                    Some(from_ms),
                    Some(boundary),
                    &payload_json,
                    &channel_ids,
                    now_ms,
                )
                .await?;
            let next = next_occurrences(&config.cron, &config.timezone, now_ms, 1)?
                .into_iter()
                .next()
                .ok_or_else(|| {
                    NotificationError::bad_request(
                        "cron_has_no_next_occurrence",
                        "cron expression has no future occurrence",
                        Some("cron"),
                    )
                })?;
            state
                .db
                .notification_complete_rule(rule.id, owner, next, Some(boundary), now_ms)
                .await?;
        }
        RuleConfig::ThresholdAlert(config) => {
            flush_recent_telemetry(state).await;
            let to_ms = now_ms;
            let from_ms = to_ms.saturating_sub(i64::from(config.window_minutes) * 60_000);
            let evaluation_id = util::new_ulid();
            let mut payload = build_payload(
                state,
                &evaluation_id,
                "alert_evaluation",
                Some(rule.id),
                &rule.name,
                config.locale,
                super::DEFAULT_TOP_N,
                from_ms,
                to_ms,
                super::DEFAULT_TIMEZONE,
                false,
                0,
                None,
            )
            .await?;
            let value = metric_value(&payload, &config);
            let state_record = state
                .db
                .notification_get_alert_state(rule.id)
                .await?
                .unwrap_or_else(|| default_alert_state(rule.id));
            let transition = evaluate_alert(&state_record, &config, value, now_ms);
            state
                .db
                .notification_upsert_alert_state(
                    rule.id,
                    AlertStateUpdate {
                        state: &transition.state,
                        breach_count: transition.breach_count,
                        recovery_count: transition.recovery_count,
                        opened_at_ms: transition.opened_at_ms,
                        last_notified_at_ms: transition.last_notified_at_ms,
                        last_value_json: transition.last_value_json.as_deref(),
                        now_ms,
                    },
                )
                .await?;
            if let (Some(event_type), Some(metric_value)) = (transition.event_type, value) {
                let run_id = util::new_ulid();
                payload.event.id = run_id.clone();
                payload.event.event_type = event_type.to_string();
                payload.alert = Some(AlertPayload {
                    metric: config.metric,
                    scope_kind: config.scope_kind,
                    scope_id: config.scope_id,
                    value: metric_value.value,
                    threshold: config.threshold,
                    complete: metric_value.complete,
                    state: transition.state.clone(),
                });
                let channel_ids = state.db.notification_rule_channel_ids(rule.id).await?;
                let payload_json = serde_json::to_string(&payload)?;
                let _ = state
                    .db
                    .notification_create_run(
                        &run_id,
                        Some(rule.id),
                        &rule.name,
                        event_type,
                        now_ms,
                        Some(from_ms),
                        Some(to_ms),
                        &payload_json,
                        &channel_ids,
                        now_ms,
                    )
                    .await?;
            }
            state
                .db
                .notification_complete_rule(
                    rule.id,
                    owner,
                    now_ms.saturating_add(ALERT_EVALUATION_MS),
                    None,
                    now_ms,
                )
                .await?;
        }
    }
    state.notifications.wake();
    Ok(())
}

async fn flush_recent_telemetry(state: &SharedState) {
    if let Err(error) = state.telemetry.flush().await {
        warn!("notification telemetry flush barrier failed: {error}");
    }
}

#[derive(Clone, Debug)]
struct AlertTransition {
    state: String,
    breach_count: i64,
    recovery_count: i64,
    opened_at_ms: Option<i64>,
    last_notified_at_ms: Option<i64>,
    last_value_json: Option<String>,
    event_type: Option<&'static str>,
}

fn evaluate_alert(
    state: &AlertStateRecord,
    config: &super::ThresholdAlertConfig,
    value: Option<super::report::MetricValue>,
    now_ms: i64,
) -> AlertTransition {
    let Some(value) = value else {
        return unchanged_transition(state, None);
    };
    if config.metric == super::AlertMetric::ErrorRatePercent
        && value.sample_count < i64::from(config.minimum_requests)
    {
        return unchanged_transition(state, Some(value));
    }
    let breached = config.operator.matches(value.value, config.threshold);
    if !breached && !value.complete {
        return unchanged_transition(state, Some(value));
    }
    let value_json = serde_json::to_string(&json!({
        "value": value.value,
        "complete": value.complete,
        "sample_count": value.sample_count,
    }))
    .ok();
    match state.state.as_str() {
        "firing" if breached => {
            let cooldown_ms = i64::from(config.cooldown_minutes) * 60_000;
            let should_remind = state
                .last_notified_at_ms
                .is_none_or(|last| now_ms.saturating_sub(last) >= cooldown_ms);
            AlertTransition {
                state: "firing".to_string(),
                breach_count: state.breach_count,
                recovery_count: 0,
                opened_at_ms: state.opened_at_ms,
                last_notified_at_ms: if should_remind {
                    Some(now_ms)
                } else {
                    state.last_notified_at_ms
                },
                last_value_json: value_json,
                event_type: should_remind.then_some("alert_reminder"),
            }
        }
        "firing" => {
            let recovery_count = state.recovery_count.saturating_add(1);
            let recovered = recovery_count >= i64::from(config.recover_after);
            AlertTransition {
                state: if recovered { "normal" } else { "firing" }.to_string(),
                breach_count: if recovered { 0 } else { state.breach_count },
                recovery_count: if recovered { 0 } else { recovery_count },
                opened_at_ms: if recovered { None } else { state.opened_at_ms },
                last_notified_at_ms: if recovered && config.send_recovery {
                    Some(now_ms)
                } else {
                    state.last_notified_at_ms
                },
                last_value_json: value_json,
                event_type: (recovered && config.send_recovery).then_some("alert_recovered"),
            }
        }
        _ if breached => {
            let breach_count = state.breach_count.saturating_add(1);
            let triggered = breach_count >= i64::from(config.trigger_after);
            AlertTransition {
                state: if triggered { "firing" } else { "pending" }.to_string(),
                breach_count,
                recovery_count: 0,
                opened_at_ms: if triggered { Some(now_ms) } else { None },
                last_notified_at_ms: if triggered { Some(now_ms) } else { None },
                last_value_json: value_json,
                event_type: triggered.then_some("alert_triggered"),
            }
        }
        _ => AlertTransition {
            state: "normal".to_string(),
            breach_count: 0,
            recovery_count: 0,
            opened_at_ms: None,
            last_notified_at_ms: state.last_notified_at_ms,
            last_value_json: value_json,
            event_type: None,
        },
    }
}

fn unchanged_transition(
    state: &AlertStateRecord,
    value: Option<super::report::MetricValue>,
) -> AlertTransition {
    AlertTransition {
        state: state.state.clone(),
        breach_count: state.breach_count,
        recovery_count: state.recovery_count,
        opened_at_ms: state.opened_at_ms,
        last_notified_at_ms: state.last_notified_at_ms,
        last_value_json: value.and_then(|value| {
            serde_json::to_string(&json!({
                "value": value.value,
                "complete": value.complete,
                "sample_count": value.sample_count,
            }))
            .ok()
        }),
        event_type: None,
    }
}

fn default_alert_state(_rule_id: i64) -> AlertStateRecord {
    AlertStateRecord {
        state: "normal".to_string(),
        breach_count: 0,
        recovery_count: 0,
        opened_at_ms: None,
        last_notified_at_ms: None,
    }
}

async fn dispatch_deliveries(
    state: &SharedState,
    semaphore: Arc<Semaphore>,
) -> Result<(), NotificationError> {
    let now_ms = util::now_ms();
    let ids = state
        .db
        .notification_list_due_deliveries(now_ms, DELIVERY_BATCH)
        .await?;
    for id in ids {
        let state = state.clone();
        let semaphore = semaphore.clone();
        tokio::spawn(async move {
            let Ok(_permit) = semaphore.acquire_owned().await else {
                return;
            };
            if let Err(error) = deliver_one(&state, &id).await {
                error!("notification delivery {id} failed to update: {error}");
            }
        });
    }
    Ok(())
}

async fn deliver_one(state: &SharedState, id: &str) -> Result<(), NotificationError> {
    let now_ms = util::now_ms();
    let owner = state.instance_id.as_str();
    let Some(work) = state
        .db
        .notification_claim_delivery(id, owner, now_ms, now_ms.saturating_add(DELIVERY_LEASE_MS))
        .await?
    else {
        return Ok(());
    };
    let config_json =
        match crypto::decrypt_secret(&state.config.master_key, &work.channel_config_enc) {
            Ok(value) => value,
            Err(error) => {
                state
                    .db
                    .notification_finish_delivery_failure(
                        &work.id,
                        owner,
                        DeliveryFailure {
                            retry_at_ms: None,
                            error_code: "channel_decryption_failed",
                            error_message: &format!(
                                "failed to decrypt channel configuration: {error}"
                            ),
                            diagnostics: DeliveryAttemptDiagnostics::default(),
                        },
                        now_ms,
                    )
                    .await?;
                return Ok(());
            }
        };
    let config: ChannelConfig = serde_json::from_str(&config_json).map_err(|error| {
        NotificationError::internal(format!("invalid channel configuration: {error}"))
    })?;
    let result = send_delivery(
        state.upstream.clone(),
        &config,
        DeliveryContext {
            delivery_id: &work.id,
            event_type: &work.event_type,
            payload_json: &work.payload_json,
        },
    )
    .await;
    match result {
        Ok(diagnostics) => {
            state
                .db
                .notification_finish_delivery_success(
                    &work.id,
                    owner,
                    DeliveryAttemptDiagnostics {
                        http_status: diagnostics.http_status.map(i32::from),
                        request_body: diagnostics.request_body.as_deref(),
                        response_body: diagnostics.response_body.as_deref(),
                    },
                    util::now_ms(),
                )
                .await?;
        }
        Err(error) => {
            let retry_at_ms = if error.retryable && work.attempts < 3 {
                let fallback = match work.attempts {
                    1 => 60_000,
                    _ => 300_000,
                };
                Some(util::now_ms().saturating_add(error.retry_after_ms.unwrap_or(fallback)))
            } else {
                None
            };
            state
                .db
                .notification_finish_delivery_failure(
                    &work.id,
                    owner,
                    DeliveryFailure {
                        retry_at_ms,
                        error_code: error.code,
                        error_message: &error.message,
                        diagnostics: DeliveryAttemptDiagnostics {
                            http_status: error.diagnostics.http_status.map(i32::from),
                            request_body: error.diagnostics.request_body.as_deref(),
                            response_body: error.diagnostics.response_body.as_deref(),
                        },
                    },
                    util::now_ms(),
                )
                .await?;
        }
    }
    Ok(())
}

pub async fn enqueue_channel_test(
    state: &SharedState,
    channel_id: i64,
    locale: NotificationLocale,
) -> Result<String, NotificationError> {
    let channel = state
        .db
        .notification_get_channel(channel_id)
        .await?
        .ok_or_else(|| NotificationError::not_found("notification channel not found"))?;
    let now_ms = util::now_ms();
    flush_recent_telemetry(state).await;
    let run_id = util::new_ulid();
    let payload = build_payload(
        state,
        &run_id,
        "test",
        None,
        &super::localized(locale, "通知通道测试", "Notification channel test"),
        locale,
        super::DEFAULT_TOP_N,
        now_ms.saturating_sub(300_000),
        now_ms,
        super::DEFAULT_TIMEZONE,
        false,
        0,
        None,
    )
    .await?;
    let payload_json = serde_json::to_string(&payload)?;
    state
        .db
        .notification_create_run(
            &run_id,
            None,
            "channel-test",
            "test",
            now_ms,
            Some(now_ms.saturating_sub(300_000)),
            Some(now_ms),
            &payload_json,
            &[channel.id],
            now_ms,
        )
        .await?;
    state.notifications.wake();
    Ok(run_id)
}

pub async fn enqueue_rule_run(
    state: &SharedState,
    rule: &RuleRecord,
) -> Result<String, NotificationError> {
    let config = decode_rule_config(&rule.config_json)?;
    let RuleConfig::ScheduledReport(config) = config else {
        return Err(NotificationError::conflict(
            "rule_not_runnable",
            "only scheduled_report rules support manual run",
        ));
    };
    let now_ms = util::now_ms();
    flush_recent_telemetry(state).await;
    let from_ms = previous_occurrence(&config.cron, &config.timezone, now_ms)?;
    let run_id = util::new_ulid();
    let payload = build_payload(
        state,
        &run_id,
        "manual_report",
        Some(rule.id),
        &rule.name,
        config.locale,
        config.top_n,
        from_ms,
        now_ms,
        &config.timezone,
        false,
        0,
        None,
    )
    .await?;
    let channel_ids = state.db.notification_rule_channel_ids(rule.id).await?;
    let payload_json = serde_json::to_string(&payload)?;
    state
        .db
        .notification_create_run(
            &run_id,
            Some(rule.id),
            &rule.name,
            "manual_report",
            now_ms,
            Some(from_ms),
            Some(now_ms),
            &payload_json,
            &channel_ids,
            now_ms,
        )
        .await?;
    state.notifications.wake();
    Ok(run_id)
}

#[cfg(test)]
mod tests {
    use super::super::{AlertMetric, AlertOperator, AlertScopeKind, ThresholdAlertConfig};
    use super::*;

    fn config() -> ThresholdAlertConfig {
        ThresholdAlertConfig {
            metric: AlertMetric::CpuUsagePercent,
            scope_kind: AlertScopeKind::Global,
            scope_id: None,
            operator: AlertOperator::Gte,
            threshold: 80.0,
            window_minutes: 15,
            minimum_requests: 20,
            trigger_after: 2,
            recover_after: 2,
            cooldown_minutes: 30,
            send_recovery: true,
            locale: NotificationLocale::ZhCn,
        }
    }

    #[test]
    fn alert_requires_configured_consecutive_breaches() {
        let state = default_alert_state(1);
        let transition = evaluate_alert(
            &state,
            &config(),
            Some(super::super::report::MetricValue {
                value: 90.0,
                complete: true,
                sample_count: 1,
            }),
            100,
        );
        assert_eq!(transition.state, "pending");
    }

    #[test]
    fn incomplete_metric_does_not_recover_firing_alert() {
        let state = AlertStateRecord {
            state: "firing".to_string(),
            breach_count: 2,
            recovery_count: 0,
            opened_at_ms: Some(10),
            last_notified_at_ms: Some(10),
        };
        let transition = evaluate_alert(
            &state,
            &config(),
            Some(super::super::report::MetricValue {
                value: 10.0,
                complete: false,
                sample_count: 1,
            }),
            100,
        );
        assert_eq!(transition.state, "firing");
    }
}
