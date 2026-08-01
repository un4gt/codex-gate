mod admin;
mod report;
mod runtime;
mod store;
mod transport;

use std::str::FromStr;

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use hyper::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::http::HttpResponse;
use crate::state::SharedState;

pub const DEFAULT_TIMEZONE: &str = "Asia/Shanghai";
pub const DEFAULT_LOCALE: &str = "zh-CN";
pub const DEFAULT_TOP_N: u16 = 20;
pub const MAX_TOP_N: u16 = 100;
pub const MIN_TOP_N: u16 = 5;
pub const HISTORY_RETENTION_MS: i64 = 90 * 86_400_000;
pub const DELIVERY_LEASE_MS: i64 = 120_000;
pub const RULE_LEASE_MS: i64 = 120_000;
pub const DELIVERY_TIMEOUT_SECS: u64 = 15;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelKind {
    Smtp,
    Webhook,
}

impl ChannelKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Smtp => "smtp",
            Self::Webhook => "webhook",
        }
    }
}

impl FromStr for ChannelKind {
    type Err = NotificationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "smtp" => Ok(Self::Smtp),
            "webhook" => Ok(Self::Webhook),
            _ => Err(NotificationError::bad_request(
                "invalid_channel_kind",
                "channel kind must be smtp or webhook",
                Some("kind"),
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleKind {
    ScheduledReport,
    ThresholdAlert,
}

impl RuleKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ScheduledReport => "scheduled_report",
            Self::ThresholdAlert => "threshold_alert",
        }
    }
}

impl FromStr for RuleKind {
    type Err = NotificationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "scheduled_report" => Ok(Self::ScheduledReport),
            "threshold_alert" => Ok(Self::ThresholdAlert),
            _ => Err(NotificationError::bad_request(
                "invalid_rule_kind",
                "rule kind must be scheduled_report or threshold_alert",
                Some("kind"),
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlertMetric {
    CpuUsagePercent,
    MemoryUsagePercent,
    UnhealthyProviderCount,
    RequestCount,
    ErrorRatePercent,
    TotalTokens,
    EstimatedCostUsd,
}

impl AlertMetric {
    pub const fn is_usage(self) -> bool {
        matches!(
            self,
            Self::RequestCount
                | Self::ErrorRatePercent
                | Self::TotalTokens
                | Self::EstimatedCostUsd
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlertScopeKind {
    Global,
    Provider,
    ClientKey,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlertOperator {
    Gt,
    Gte,
    Lt,
    Lte,
}

impl AlertOperator {
    pub fn matches(self, value: f64, threshold: f64) -> bool {
        match self {
            Self::Gt => value > threshold,
            Self::Gte => value >= threshold,
            Self::Lt => value < threshold,
            Self::Lte => value <= threshold,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub enum NotificationLocale {
    #[serde(rename = "zh-CN")]
    #[default]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

impl NotificationLocale {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ZhCn => DEFAULT_LOCALE,
            Self::EnUs => "en-US",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SmtpSecurity {
    Starttls,
    Tls,
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SmtpChannelConfig {
    pub host: String,
    pub port: u16,
    pub security: SmtpSecurity,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub from_name: Option<String>,
    pub from_email: String,
    pub recipients: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebhookHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebhookFormat {
    #[default]
    Generic,
    Feishu,
    Wecom,
    Dingtalk,
    Slack,
    Discord,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebhookChannelConfig {
    pub url: String,
    #[serde(default)]
    pub format: WebhookFormat,
    #[serde(default)]
    pub signing_secret: String,
    #[serde(default)]
    pub headers: Vec<WebhookHeader>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "config", rename_all = "snake_case")]
pub enum ChannelConfig {
    Smtp(SmtpChannelConfig),
    Webhook(WebhookChannelConfig),
}

impl ChannelConfig {
    pub const fn kind(&self) -> ChannelKind {
        match self {
            Self::Smtp(_) => ChannelKind::Smtp,
            Self::Webhook(_) => ChannelKind::Webhook,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScheduledReportConfig {
    pub cron: String,
    #[serde(default = "default_timezone")]
    pub timezone: String,
    #[serde(default)]
    pub locale: NotificationLocale,
    #[serde(default = "default_top_n")]
    pub top_n: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ThresholdAlertConfig {
    pub metric: AlertMetric,
    pub scope_kind: AlertScopeKind,
    #[serde(default)]
    pub scope_id: Option<i64>,
    pub operator: AlertOperator,
    pub threshold: f64,
    #[serde(default = "default_window_minutes")]
    pub window_minutes: u16,
    #[serde(default = "default_minimum_requests")]
    pub minimum_requests: u32,
    #[serde(default = "default_trigger_after")]
    pub trigger_after: u8,
    #[serde(default = "default_recover_after")]
    pub recover_after: u8,
    #[serde(default = "default_cooldown_minutes")]
    pub cooldown_minutes: u16,
    #[serde(default = "default_true")]
    pub send_recovery: bool,
    #[serde(default)]
    pub locale: NotificationLocale,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "config", rename_all = "snake_case")]
pub enum RuleConfig {
    ScheduledReport(ScheduledReportConfig),
    ThresholdAlert(ThresholdAlertConfig),
}

impl RuleConfig {
    pub const fn kind(&self) -> RuleKind {
        match self {
            Self::ScheduledReport(_) => RuleKind::ScheduledReport,
            Self::ThresholdAlert(_) => RuleKind::ThresholdAlert,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(flatten)]
    pub config: ChannelConfig,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UpdateChannelRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub config: Option<ChannelConfig>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreateRuleRequest {
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub channel_ids: Vec<i64>,
    #[serde(flatten)]
    pub config: RuleConfig,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UpdateRuleRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub channel_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub config: Option<RuleConfig>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SchedulePreviewRequest {
    pub cron: String,
    #[serde(default = "default_timezone")]
    pub timezone: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ApiErrorEnvelope {
    pub error: ApiErrorBody,
}

#[derive(Clone, Debug, Serialize)]
pub struct ApiErrorBody {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<&'static str>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct NotificationError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub field: Option<&'static str>,
}

impl NotificationError {
    pub fn bad_request(
        code: &'static str,
        message: impl Into<String>,
        field: Option<&'static str>,
    ) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
            field,
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
            field: None,
        }
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message: message.into(),
            field: None,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "notification_internal_error",
            message: message.into(),
            field: None,
        }
    }

    pub fn response(&self) -> HttpResponse {
        crate::http::json(
            self.status,
            &ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: self.code,
                    message: self.message.clone(),
                    field: self.field,
                },
            },
        )
    }
}

impl From<crate::db::DbError> for NotificationError {
    fn from(error: crate::db::DbError) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<serde_json::Error> for NotificationError {
    fn from(error: serde_json::Error) -> Self {
        Self::internal(error.to_string())
    }
}

#[derive(Clone)]
pub struct NotificationHandle {
    wake_tx: mpsc::Sender<()>,
}

impl NotificationHandle {
    pub fn new() -> (Self, mpsc::Receiver<()>) {
        let (wake_tx, wake_rx) = mpsc::channel(8);
        (Self { wake_tx }, wake_rx)
    }

    pub fn wake(&self) {
        let _ = self.wake_tx.try_send(());
    }
}

pub async fn handle_admin(
    req: hyper::Request<hyper::body::Incoming>,
    state: SharedState,
) -> HttpResponse {
    admin::handle(req, state).await
}

pub fn spawn(state: SharedState, wake_rx: mpsc::Receiver<()>) {
    runtime::spawn(state, wake_rx);
}

pub(crate) async fn migrate_sqlite(pool: &sqlx::SqlitePool) -> Result<(), crate::db::DbError> {
    store::migrate_sqlite(pool).await
}

pub(crate) async fn migrate_postgres(pool: &sqlx::PgPool) -> Result<(), crate::db::DbError> {
    store::migrate_postgres(pool).await
}

pub fn validate_channel_config(config: &ChannelConfig) -> Result<(), NotificationError> {
    match config {
        ChannelConfig::Smtp(config) => transport::validate_smtp_config(config),
        ChannelConfig::Webhook(config) => transport::validate_webhook_config(config),
    }
}

pub fn validate_rule_config(config: &RuleConfig) -> Result<(), NotificationError> {
    match config {
        RuleConfig::ScheduledReport(config) => {
            if !(MIN_TOP_N..=MAX_TOP_N).contains(&config.top_n) {
                return Err(NotificationError::bad_request(
                    "invalid_top_n",
                    format!("top_n must be between {MIN_TOP_N} and {MAX_TOP_N}"),
                    Some("top_n"),
                ));
            }
            let _ = parse_schedule(&config.cron, &config.timezone)?;
        }
        RuleConfig::ThresholdAlert(config) => {
            if !config.threshold.is_finite() {
                return Err(NotificationError::bad_request(
                    "invalid_threshold",
                    "threshold must be finite",
                    Some("threshold"),
                ));
            }
            if !(5..=1_440).contains(&config.window_minutes) {
                return Err(NotificationError::bad_request(
                    "invalid_window_minutes",
                    "window_minutes must be between 5 and 1440",
                    Some("window_minutes"),
                ));
            }
            if !(1..=10).contains(&config.trigger_after) {
                return Err(NotificationError::bad_request(
                    "invalid_trigger_after",
                    "trigger_after must be between 1 and 10",
                    Some("trigger_after"),
                ));
            }
            if !(1..=10).contains(&config.recover_after) {
                return Err(NotificationError::bad_request(
                    "invalid_recover_after",
                    "recover_after must be between 1 and 10",
                    Some("recover_after"),
                ));
            }
            if !(5..=1_440).contains(&config.cooldown_minutes) {
                return Err(NotificationError::bad_request(
                    "invalid_cooldown_minutes",
                    "cooldown_minutes must be between 5 and 1440",
                    Some("cooldown_minutes"),
                ));
            }
            match config.scope_kind {
                AlertScopeKind::Global if config.scope_id.is_some() => {
                    return Err(NotificationError::bad_request(
                        "invalid_scope",
                        "global scope must not include scope_id",
                        Some("scope_id"),
                    ));
                }
                AlertScopeKind::Provider | AlertScopeKind::ClientKey
                    if config.scope_id.unwrap_or_default() <= 0 =>
                {
                    return Err(NotificationError::bad_request(
                        "invalid_scope",
                        "provider and client_key scopes require a positive scope_id",
                        Some("scope_id"),
                    ));
                }
                _ => {}
            }
            if !config.metric.is_usage() && config.scope_kind != AlertScopeKind::Global {
                return Err(NotificationError::bad_request(
                    "metric_scope_unsupported",
                    "server metrics only support global scope",
                    Some("scope_kind"),
                ));
            }
        }
    }
    Ok(())
}

pub fn next_occurrences(
    expression: &str,
    timezone: &str,
    from_ms: i64,
    count: usize,
) -> Result<Vec<i64>, NotificationError> {
    let (schedule, timezone) = parse_schedule(expression, timezone)?;
    let from = datetime_from_ms(from_ms)?.with_timezone(&timezone);
    Ok(schedule
        .after(&from)
        .take(count)
        .map(|value| value.timestamp_millis())
        .collect())
}

pub fn previous_occurrence(
    expression: &str,
    timezone: &str,
    at_ms: i64,
) -> Result<i64, NotificationError> {
    let (schedule, timezone) = parse_schedule(expression, timezone)?;
    let at = datetime_from_ms(at_ms)?.with_timezone(&timezone);
    schedule
        .after(&at)
        .next_back()
        .map(|value| value.timestamp_millis())
        .ok_or_else(|| {
            NotificationError::bad_request(
                "cron_has_no_previous_occurrence",
                "cron expression has no previous occurrence",
                Some("cron"),
            )
        })
}

pub fn missed_occurrence_count(
    expression: &str,
    timezone: &str,
    scheduled_from_ms: i64,
    boundary_ms: i64,
) -> Result<u32, NotificationError> {
    if scheduled_from_ms >= boundary_ms {
        return Ok(0);
    }
    let (schedule, timezone) = parse_schedule(expression, timezone)?;
    let from = datetime_from_ms(scheduled_from_ms.saturating_sub(1))?.with_timezone(&timezone);
    let count = schedule
        .after(&from)
        .take_while(|value| value.timestamp_millis() <= boundary_ms)
        .take(u32::MAX as usize)
        .count();
    Ok(u32::try_from(count.saturating_sub(1)).unwrap_or(u32::MAX))
}

pub fn parse_schedule(
    expression: &str,
    timezone: &str,
) -> Result<(Schedule, Tz), NotificationError> {
    let expression = expression.trim();
    if expression.split_whitespace().count() != 5 {
        return Err(NotificationError::bad_request(
            "invalid_cron",
            "cron expression must contain 5 fields: minute hour day month weekday",
            Some("cron"),
        ));
    }
    let normalized = format!("0 {expression}");
    let schedule = Schedule::from_str(&normalized).map_err(|error| {
        NotificationError::bad_request("invalid_cron", error.to_string(), Some("cron"))
    })?;
    let timezone = timezone.trim().parse::<Tz>().map_err(|_| {
        NotificationError::bad_request(
            "invalid_timezone",
            "timezone must be a valid IANA timezone",
            Some("timezone"),
        )
    })?;
    Ok((schedule, timezone))
}

pub fn decode_rule_config(raw: &str) -> Result<RuleConfig, NotificationError> {
    serde_json::from_str(raw).map_err(|error| NotificationError::internal(error.to_string()))
}

pub fn encode_json(value: &impl Serialize) -> Result<String, NotificationError> {
    serde_json::to_string(value).map_err(Into::into)
}

pub fn localized(locale: NotificationLocale, zh: &str, en: &str) -> String {
    match locale {
        NotificationLocale::ZhCn => zh.to_string(),
        NotificationLocale::EnUs => en.to_string(),
    }
}

fn datetime_from_ms(ms: i64) -> Result<DateTime<Utc>, NotificationError> {
    Utc.timestamp_millis_opt(ms).single().ok_or_else(|| {
        NotificationError::bad_request(
            "invalid_timestamp",
            "timestamp is outside the supported range",
            None,
        )
    })
}

fn default_timezone() -> String {
    DEFAULT_TIMEZONE.to_string()
}

const fn default_top_n() -> u16 {
    DEFAULT_TOP_N
}

const fn default_window_minutes() -> u16 {
    15
}

const fn default_minimum_requests() -> u32 {
    20
}

const fn default_trigger_after() -> u8 {
    3
}

const fn default_recover_after() -> u8 {
    2
}

const fn default_cooldown_minutes() -> u16 {
    30
}

const fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_parser_rejects_six_fields() {
        let error = parse_schedule("0 0 9 * * *", DEFAULT_TIMEZONE).unwrap_err();
        assert_eq!(error.code, "invalid_cron");
    }

    #[test]
    fn schedule_preview_uses_rule_timezone() {
        let next = next_occurrences("0 9 * * *", DEFAULT_TIMEZONE, 0, 1).expect("schedule preview");
        assert_eq!(next.len(), 1);
    }

    #[test]
    fn missed_occurrences_count_all_collapsed_schedule_boundaries() {
        let scheduled = Utc
            .with_ymd_and_hms(2026, 1, 2, 0, 0, 0)
            .single()
            .expect("scheduled")
            .timestamp_millis();
        let boundary = Utc
            .with_ymd_and_hms(2026, 1, 4, 0, 0, 0)
            .single()
            .expect("boundary")
            .timestamp_millis();
        let missed = missed_occurrence_count("0 0 * * *", "UTC", scheduled, boundary)
            .expect("missed occurrences");
        assert_eq!(missed, 2);
    }

    #[test]
    fn server_metric_rejects_provider_scope() {
        let config = RuleConfig::ThresholdAlert(ThresholdAlertConfig {
            metric: AlertMetric::CpuUsagePercent,
            scope_kind: AlertScopeKind::Provider,
            scope_id: Some(1),
            operator: AlertOperator::Gte,
            threshold: 80.0,
            window_minutes: 15,
            minimum_requests: 20,
            trigger_after: 3,
            recover_after: 2,
            cooldown_minutes: 30,
            send_recovery: true,
            locale: NotificationLocale::ZhCn,
        });
        let error = validate_rule_config(&config).unwrap_err();
        assert_eq!(error.code, "metric_scope_unsupported");
    }
}
