use serde::Serialize;
use sqlx::{PgPool, Row, SqlitePool};

use crate::db::{Database, DbError};
use crate::types::Usage;

#[derive(Clone, Debug)]
pub struct ChannelRecord {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub config_enc: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct RuleRecord {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub config_json: String,
    pub next_run_at_ms: i64,
    pub last_window_end_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct AlertStateRecord {
    pub state: String,
    pub breach_count: i64,
    pub recovery_count: i64,
    pub opened_at_ms: Option<i64>,
    pub last_notified_at_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct DeliveryWorkItem {
    pub id: String,
    pub event_type: String,
    pub payload_json: String,
    pub channel_config_enc: String,
    pub attempts: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct DeliveryView {
    pub id: String,
    pub run_id: String,
    pub rule_id: Option<i64>,
    pub rule_name: String,
    pub event_type: String,
    pub channel_id: Option<i64>,
    pub channel_name: String,
    pub channel_kind: String,
    pub status: String,
    pub attempts: i32,
    pub next_attempt_at_ms: Option<i64>,
    pub last_attempt_at_ms: Option<i64>,
    pub delivered_at_ms: Option<i64>,
    pub last_error_code: Option<String>,
    pub last_error_message: Option<String>,
    pub created_at_ms: i64,
    pub window_from_ms: Option<i64>,
    pub window_to_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct DeliveryDetailView {
    pub delivery: DeliveryView,
    pub last_http_status: Option<i32>,
    pub last_request_body: Option<String>,
    pub last_response_body: Option<String>,
    pub event_payload_json: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DeliveryAttemptDiagnostics<'a> {
    pub http_status: Option<i32>,
    pub request_body: Option<&'a str>,
    pub response_body: Option<&'a str>,
}

#[derive(Clone, Copy, Debug)]
pub struct DeliveryFailure<'a> {
    pub retry_at_ms: Option<i64>,
    pub error_code: &'a str,
    pub error_message: &'a str,
    pub diagnostics: DeliveryAttemptDiagnostics<'a>,
}

#[derive(Clone, Debug)]
pub struct UsageGroupRow {
    pub provider_id: Option<i64>,
    pub api_key_id: i64,
    pub price_version_id: Option<i64>,
    pub price_tier_index: Option<i32>,
    pub request_success: i64,
    pub request_failed: i64,
    pub usage_observed_requests: i64,
    pub usage: Usage,
}

#[derive(Clone, Debug)]
pub struct AlertStateUpdate<'a> {
    pub state: &'a str,
    pub breach_count: i64,
    pub recovery_count: i64,
    pub opened_at_ms: Option<i64>,
    pub last_notified_at_ms: Option<i64>,
    pub last_value_json: Option<&'a str>,
    pub now_ms: i64,
}

pub async fn migrate_sqlite(pool: &SqlitePool) -> Result<(), DbError> {
    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  config_enc TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  next_run_at_ms INTEGER NOT NULL,
  last_window_end_ms INTEGER,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_rules_due
  ON notification_rules(enabled, next_run_at_ms, lease_until_ms);
CREATE TABLE IF NOT EXISTS notification_rule_channels (
  rule_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(rule_id, channel_id),
  FOREIGN KEY(rule_id) REFERENCES notification_rules(id) ON DELETE CASCADE,
  FOREIGN KEY(channel_id) REFERENCES notification_channels(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_notification_rule_channels_channel
  ON notification_rule_channels(channel_id);
CREATE TABLE IF NOT EXISTS notification_alert_states (
  rule_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  breach_count INTEGER NOT NULL,
  recovery_count INTEGER NOT NULL,
  opened_at_ms INTEGER,
  last_notified_at_ms INTEGER,
  last_value_json TEXT,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(rule_id) REFERENCES notification_rules(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notification_runs (
  id TEXT PRIMARY KEY,
  rule_id INTEGER,
  rule_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  scheduled_for_ms INTEGER NOT NULL,
  window_from_ms INTEGER,
  window_to_ms INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  FOREIGN KEY(rule_id) REFERENCES notification_rules(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_runs_unique_rule_event
  ON notification_runs(rule_id, event_type, scheduled_for_ms)
  WHERE rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_runs_created
  ON notification_runs(created_at_ms DESC);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  channel_id INTEGER,
  channel_name TEXT NOT NULL,
  channel_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at_ms INTEGER,
  last_attempt_at_ms INTEGER,
  delivered_at_ms INTEGER,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  last_http_status INTEGER,
  last_request_body TEXT,
  last_response_body TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(run_id, channel_id),
  FOREIGN KEY(run_id) REFERENCES notification_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(channel_id) REFERENCES notification_channels(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
  ON notification_deliveries(status, next_attempt_at_ms, lease_until_ms);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created
  ON notification_deliveries(created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_stats_events_provider_time
  ON stats_events(provider_id, time_ms);
CREATE INDEX IF NOT EXISTS idx_stats_events_api_key_time
  ON stats_events(api_key_id, time_ms);
"#,
    )
    .execute(pool)
    .await?;
    ensure_sqlite_column(pool, "last_http_status", "INTEGER").await?;
    ensure_sqlite_column(pool, "last_request_body", "TEXT").await?;
    ensure_sqlite_column(pool, "last_response_body", "TEXT").await?;
    Ok(())
}

pub async fn migrate_postgres(pool: &PgPool) -> Result<(), DbError> {
    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS notification_channels (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  config_enc TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_rules (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  config_json TEXT NOT NULL,
  next_run_at_ms BIGINT NOT NULL,
  last_window_end_ms BIGINT,
  lease_owner TEXT,
  lease_until_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_rules_due
  ON notification_rules(enabled, next_run_at_ms, lease_until_ms);
CREATE TABLE IF NOT EXISTS notification_rule_channels (
  rule_id BIGINT NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES notification_channels(id) ON DELETE RESTRICT,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY(rule_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_rule_channels_channel
  ON notification_rule_channels(channel_id);
CREATE TABLE IF NOT EXISTS notification_alert_states (
  rule_id BIGINT PRIMARY KEY REFERENCES notification_rules(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  breach_count BIGINT NOT NULL,
  recovery_count BIGINT NOT NULL,
  opened_at_ms BIGINT,
  last_notified_at_ms BIGINT,
  last_value_json TEXT,
  updated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_runs (
  id TEXT PRIMARY KEY,
  rule_id BIGINT REFERENCES notification_rules(id) ON DELETE SET NULL,
  rule_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  scheduled_for_ms BIGINT NOT NULL,
  window_from_ms BIGINT,
  window_to_ms BIGINT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_runs_unique_rule_event
  ON notification_runs(rule_id, event_type, scheduled_for_ms)
  WHERE rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_runs_created
  ON notification_runs(created_at_ms DESC);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES notification_runs(id) ON DELETE CASCADE,
  channel_id BIGINT REFERENCES notification_channels(id) ON DELETE SET NULL,
  channel_name TEXT NOT NULL,
  channel_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at_ms BIGINT,
  last_attempt_at_ms BIGINT,
  delivered_at_ms BIGINT,
  lease_owner TEXT,
  lease_until_ms BIGINT,
  last_error_code TEXT,
  last_error_message TEXT,
  last_http_status INTEGER,
  last_request_body TEXT,
  last_response_body TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE(run_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
  ON notification_deliveries(status, next_attempt_at_ms, lease_until_ms);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created
  ON notification_deliveries(created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_stats_events_provider_time
  ON stats_events(provider_id, time_ms);
CREATE INDEX IF NOT EXISTS idx_stats_events_api_key_time
  ON stats_events(api_key_id, time_ms);
"#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS last_http_status INTEGER;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS last_request_body TEXT;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS last_response_body TEXT;
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_sqlite_column(
    pool: &SqlitePool,
    column: &str,
    definition: &str,
) -> Result<(), DbError> {
    let rows = sqlx::query("PRAGMA table_info(notification_deliveries)")
        .fetch_all(pool)
        .await?;
    if rows
        .iter()
        .any(|row| row.get::<String, _>("name") == column)
    {
        return Ok(());
    }
    sqlx::query(&format!(
        "ALTER TABLE notification_deliveries ADD COLUMN {column} {definition}"
    ))
    .execute(pool)
    .await?;
    Ok(())
}

impl Database {
    pub async fn notification_list_channels(&self) -> Result<Vec<ChannelRecord>, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let rows = sqlx::query(
                    "SELECT id, name, kind, enabled, config_enc, created_at_ms, updated_at_ms FROM notification_channels ORDER BY id ASC",
                )
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().map(channel_from_sqlite).collect())
            }
            Self::Postgres(pool) => {
                let rows = sqlx::query(
                    "SELECT id, name, kind, enabled, config_enc, created_at_ms, updated_at_ms FROM notification_channels ORDER BY id ASC",
                )
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().map(channel_from_postgres).collect())
            }
        }
    }

    pub async fn notification_get_channel(
        &self,
        id: i64,
    ) -> Result<Option<ChannelRecord>, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let row = sqlx::query(
                    "SELECT id, name, kind, enabled, config_enc, created_at_ms, updated_at_ms FROM notification_channels WHERE id = ?",
                )
                .bind(id)
                .fetch_optional(pool)
                .await?;
                Ok(row.map(channel_from_sqlite))
            }
            Self::Postgres(pool) => {
                let row = sqlx::query(
                    "SELECT id, name, kind, enabled, config_enc, created_at_ms, updated_at_ms FROM notification_channels WHERE id = $1",
                )
                .bind(id)
                .fetch_optional(pool)
                .await?;
                Ok(row.map(channel_from_postgres))
            }
        }
    }

    pub async fn notification_insert_channel(
        &self,
        name: &str,
        kind: &str,
        enabled: bool,
        config_enc: &str,
        now_ms: i64,
    ) -> Result<i64, DbError> {
        match self {
            Self::Sqlite(pool) => Ok(sqlx::query(
                "INSERT INTO notification_channels (name, kind, enabled, config_enc, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .bind(name)
            .bind(kind)
            .bind(enabled)
            .bind(config_enc)
            .bind(now_ms)
            .bind(now_ms)
            .fetch_one(pool)
            .await?
            .get("id")),
            Self::Postgres(pool) => Ok(sqlx::query(
                "INSERT INTO notification_channels (name, kind, enabled, config_enc, created_at_ms, updated_at_ms) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            )
            .bind(name)
            .bind(kind)
            .bind(enabled)
            .bind(config_enc)
            .bind(now_ms)
            .bind(now_ms)
            .fetch_one(pool)
            .await?
            .get("id")),
        }
    }

    pub async fn notification_update_channel(
        &self,
        id: i64,
        name: &str,
        enabled: bool,
        config_enc: &str,
        now_ms: i64,
    ) -> Result<bool, DbError> {
        let rows_affected = match self {
            Self::Sqlite(pool) => sqlx::query(
                "UPDATE notification_channels SET name = ?, enabled = ?, config_enc = ?, updated_at_ms = ? WHERE id = ?",
            )
            .bind(name)
            .bind(enabled)
            .bind(config_enc)
            .bind(now_ms)
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected(),
            Self::Postgres(pool) => sqlx::query(
                "UPDATE notification_channels SET name = $1, enabled = $2, config_enc = $3, updated_at_ms = $4 WHERE id = $5",
            )
            .bind(name)
            .bind(enabled)
            .bind(config_enc)
            .bind(now_ms)
            .bind(id)
            .execute(pool)
            .await?
            .rows_affected(),
        };
        Ok(rows_affected > 0)
    }

    pub async fn notification_delete_channel(&self, id: i64) -> Result<bool, DbError> {
        let references = match self {
            Self::Sqlite(pool) => {
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM notification_rule_channels WHERE channel_id = ?",
                )
                .bind(id)
                .fetch_one(pool)
                .await?
            }
            Self::Postgres(pool) => {
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM notification_rule_channels WHERE channel_id = $1",
                )
                .bind(id)
                .fetch_one(pool)
                .await?
            }
        };
        if references > 0 {
            return Err(DbError::new("channel_in_use"));
        }
        let rows_affected = match self {
            Self::Sqlite(pool) => sqlx::query("DELETE FROM notification_channels WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await?
                .rows_affected(),
            Self::Postgres(pool) => sqlx::query("DELETE FROM notification_channels WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await?
                .rows_affected(),
        };
        Ok(rows_affected > 0)
    }

    pub async fn notification_list_rules(&self) -> Result<Vec<RuleRecord>, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let rows = sqlx::query(RULE_SELECT_SQL).fetch_all(pool).await?;
                Ok(rows.into_iter().map(rule_from_sqlite).collect())
            }
            Self::Postgres(pool) => {
                let rows = sqlx::query(RULE_SELECT_SQL).fetch_all(pool).await?;
                Ok(rows.into_iter().map(rule_from_postgres).collect())
            }
        }
    }

    pub async fn notification_get_rule(&self, id: i64) -> Result<Option<RuleRecord>, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let row = sqlx::query(&format!("{RULE_SELECT_SQL} WHERE id = ?"))
                    .bind(id)
                    .fetch_optional(pool)
                    .await?;
                Ok(row.map(rule_from_sqlite))
            }
            Self::Postgres(pool) => {
                let row = sqlx::query(&format!("{RULE_SELECT_SQL} WHERE id = $1"))
                    .bind(id)
                    .fetch_optional(pool)
                    .await?;
                Ok(row.map(rule_from_postgres))
            }
        }
    }

    pub async fn notification_rule_channel_ids(&self, rule_id: i64) -> Result<Vec<i64>, DbError> {
        match self {
            Self::Sqlite(pool) => Ok(sqlx::query_scalar(
                "SELECT channel_id FROM notification_rule_channels WHERE rule_id = ? ORDER BY channel_id ASC",
            )
            .bind(rule_id)
            .fetch_all(pool)
            .await?),
            Self::Postgres(pool) => Ok(sqlx::query_scalar(
                "SELECT channel_id FROM notification_rule_channels WHERE rule_id = $1 ORDER BY channel_id ASC",
            )
            .bind(rule_id)
            .fetch_all(pool)
            .await?),
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "rule persistence keeps the configuration and channel snapshot atomic"
    )]
    pub async fn notification_insert_rule(
        &self,
        name: &str,
        kind: &str,
        enabled: bool,
        config_json: &str,
        next_run_at_ms: i64,
        channel_ids: &[i64],
        now_ms: i64,
    ) -> Result<i64, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let mut tx = pool.begin().await?;
                let id: i64 = sqlx::query(
                    "INSERT INTO notification_rules (name, kind, enabled, config_json, next_run_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
                )
                .bind(name)
                .bind(kind)
                .bind(enabled)
                .bind(config_json)
                .bind(next_run_at_ms)
                .bind(now_ms)
                .bind(now_ms)
                .fetch_one(&mut *tx)
                .await?
                .get("id");
                for channel_id in channel_ids {
                    sqlx::query("INSERT INTO notification_rule_channels (rule_id, channel_id, created_at_ms) VALUES (?, ?, ?)")
                        .bind(id)
                        .bind(channel_id)
                        .bind(now_ms)
                        .execute(&mut *tx)
                        .await?;
                }
                tx.commit().await?;
                Ok(id)
            }
            Self::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let id: i64 = sqlx::query(
                    "INSERT INTO notification_rules (name, kind, enabled, config_json, next_run_at_ms, created_at_ms, updated_at_ms) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
                )
                .bind(name)
                .bind(kind)
                .bind(enabled)
                .bind(config_json)
                .bind(next_run_at_ms)
                .bind(now_ms)
                .bind(now_ms)
                .fetch_one(&mut *tx)
                .await?
                .get("id");
                for channel_id in channel_ids {
                    sqlx::query("INSERT INTO notification_rule_channels (rule_id, channel_id, created_at_ms) VALUES ($1, $2, $3)")
                        .bind(id)
                        .bind(channel_id)
                        .bind(now_ms)
                        .execute(&mut *tx)
                        .await?;
                }
                tx.commit().await?;
                Ok(id)
            }
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "rule persistence keeps the configuration and channel snapshot atomic"
    )]
    pub async fn notification_update_rule(
        &self,
        id: i64,
        name: &str,
        enabled: bool,
        config_json: &str,
        next_run_at_ms: i64,
        channel_ids: &[i64],
        now_ms: i64,
    ) -> Result<bool, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let mut tx = pool.begin().await?;
                let result = sqlx::query(
                    "UPDATE notification_rules SET name = ?, enabled = ?, config_json = ?, next_run_at_ms = ?, lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ? WHERE id = ?",
                )
                .bind(name)
                .bind(enabled)
                .bind(config_json)
                .bind(next_run_at_ms)
                .bind(now_ms)
                .bind(id)
                .execute(&mut *tx)
                .await?;
                if result.rows_affected() == 0 {
                    tx.rollback().await?;
                    return Ok(false);
                }
                sqlx::query("DELETE FROM notification_rule_channels WHERE rule_id = ?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                for channel_id in channel_ids {
                    sqlx::query("INSERT INTO notification_rule_channels (rule_id, channel_id, created_at_ms) VALUES (?, ?, ?)")
                        .bind(id)
                        .bind(channel_id)
                        .bind(now_ms)
                        .execute(&mut *tx)
                        .await?;
                }
                tx.commit().await?;
                Ok(true)
            }
            Self::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let result = sqlx::query(
                    "UPDATE notification_rules SET name = $1, enabled = $2, config_json = $3, next_run_at_ms = $4, lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = $5 WHERE id = $6",
                )
                .bind(name)
                .bind(enabled)
                .bind(config_json)
                .bind(next_run_at_ms)
                .bind(now_ms)
                .bind(id)
                .execute(&mut *tx)
                .await?;
                if result.rows_affected() == 0 {
                    tx.rollback().await?;
                    return Ok(false);
                }
                sqlx::query("DELETE FROM notification_rule_channels WHERE rule_id = $1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                for channel_id in channel_ids {
                    sqlx::query("INSERT INTO notification_rule_channels (rule_id, channel_id, created_at_ms) VALUES ($1, $2, $3)")
                        .bind(id)
                        .bind(channel_id)
                        .bind(now_ms)
                        .execute(&mut *tx)
                        .await?;
                }
                tx.commit().await?;
                Ok(true)
            }
        }
    }

    pub async fn notification_delete_rule(&self, id: i64) -> Result<bool, DbError> {
        let rows_affected = match self {
            Self::Sqlite(pool) => sqlx::query("DELETE FROM notification_rules WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await?
                .rows_affected(),
            Self::Postgres(pool) => sqlx::query("DELETE FROM notification_rules WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await?
                .rows_affected(),
        };
        Ok(rows_affected > 0)
    }

    pub async fn notification_summary(&self, now_ms: i64) -> Result<(i64, i64, i64, i64), DbError> {
        let since = now_ms.saturating_sub(86_400_000);
        match self {
            Self::Sqlite(pool) => {
                let channels: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM notification_channels WHERE enabled != 0",
                )
                .fetch_one(pool)
                .await?;
                let rules: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM notification_rules WHERE enabled != 0",
                )
                .fetch_one(pool)
                .await?;
                let firing: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM notification_alert_states WHERE state = 'firing'",
                )
                .fetch_one(pool)
                .await?;
                let failed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notification_deliveries WHERE status = 'failed' AND created_at_ms >= ?").bind(since).fetch_one(pool).await?;
                Ok((channels, rules, firing, failed))
            }
            Self::Postgres(pool) => {
                let channels: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM notification_channels WHERE enabled")
                        .fetch_one(pool)
                        .await?;
                let rules: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM notification_rules WHERE enabled")
                        .fetch_one(pool)
                        .await?;
                let firing: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM notification_alert_states WHERE state = 'firing'",
                )
                .fetch_one(pool)
                .await?;
                let failed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notification_deliveries WHERE status = 'failed' AND created_at_ms >= $1").bind(since).fetch_one(pool).await?;
                Ok((channels, rules, firing, failed))
            }
        }
    }

    pub async fn notification_list_due_rules(
        &self,
        now_ms: i64,
        limit: i64,
    ) -> Result<Vec<RuleRecord>, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let rows = sqlx::query(&format!("{RULE_SELECT_SQL} WHERE enabled != 0 AND next_run_at_ms <= ? AND (lease_until_ms IS NULL OR lease_until_ms < ?) ORDER BY next_run_at_ms ASC LIMIT ?"))
                    .bind(now_ms).bind(now_ms).bind(limit).fetch_all(pool).await?;
                Ok(rows.into_iter().map(rule_from_sqlite).collect())
            }
            Self::Postgres(pool) => {
                let rows = sqlx::query(&format!("{RULE_SELECT_SQL} WHERE enabled AND next_run_at_ms <= $1 AND (lease_until_ms IS NULL OR lease_until_ms < $2) ORDER BY next_run_at_ms ASC LIMIT $3"))
                    .bind(now_ms).bind(now_ms).bind(limit).fetch_all(pool).await?;
                Ok(rows.into_iter().map(rule_from_postgres).collect())
            }
        }
    }

    pub async fn notification_claim_rule(
        &self,
        id: i64,
        owner: &str,
        now_ms: i64,
        lease_until_ms: i64,
    ) -> Result<bool, DbError> {
        let rows_affected = match self {
            Self::Sqlite(pool) => sqlx::query("UPDATE notification_rules SET lease_owner = ?, lease_until_ms = ? WHERE id = ? AND enabled != 0 AND next_run_at_ms <= ? AND (lease_until_ms IS NULL OR lease_until_ms < ?)")
                .bind(owner).bind(lease_until_ms).bind(id).bind(now_ms).bind(now_ms).execute(pool).await?.rows_affected(),
            Self::Postgres(pool) => sqlx::query("UPDATE notification_rules SET lease_owner = $1, lease_until_ms = $2 WHERE id = $3 AND enabled AND next_run_at_ms <= $4 AND (lease_until_ms IS NULL OR lease_until_ms < $5)")
                .bind(owner).bind(lease_until_ms).bind(id).bind(now_ms).bind(now_ms).execute(pool).await?.rows_affected(),
        };
        Ok(rows_affected == 1)
    }

    pub async fn notification_complete_rule(
        &self,
        id: i64,
        owner: &str,
        next_run_at_ms: i64,
        last_window_end_ms: Option<i64>,
        now_ms: i64,
    ) -> Result<(), DbError> {
        match self {
            Self::Sqlite(pool) => {
                sqlx::query("UPDATE notification_rules SET next_run_at_ms = ?, last_window_end_ms = COALESCE(?, last_window_end_ms), lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ? WHERE id = ? AND lease_owner = ?")
                    .bind(next_run_at_ms).bind(last_window_end_ms).bind(now_ms).bind(id).bind(owner).execute(pool).await?;
            }
            Self::Postgres(pool) => {
                sqlx::query("UPDATE notification_rules SET next_run_at_ms = $1, last_window_end_ms = COALESCE($2, last_window_end_ms), lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = $3 WHERE id = $4 AND lease_owner = $5")
                    .bind(next_run_at_ms).bind(last_window_end_ms).bind(now_ms).bind(id).bind(owner).execute(pool).await?;
            }
        }
        Ok(())
    }

    pub async fn notification_release_rule(
        &self,
        id: i64,
        owner: &str,
        retry_at_ms: i64,
        now_ms: i64,
    ) -> Result<(), DbError> {
        match self {
            Self::Sqlite(pool) => {
                sqlx::query("UPDATE notification_rules SET next_run_at_ms = ?, lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ? WHERE id = ? AND lease_owner = ?")
                    .bind(retry_at_ms).bind(now_ms).bind(id).bind(owner).execute(pool).await?;
            }
            Self::Postgres(pool) => {
                sqlx::query("UPDATE notification_rules SET next_run_at_ms = $1, lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = $2 WHERE id = $3 AND lease_owner = $4")
                    .bind(retry_at_ms).bind(now_ms).bind(id).bind(owner).execute(pool).await?;
            }
        }
        Ok(())
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "persisted run mirrors the immutable delivery snapshot"
    )]
    pub async fn notification_create_run(
        &self,
        run_id: &str,
        rule_id: Option<i64>,
        rule_name: &str,
        event_type: &str,
        scheduled_for_ms: i64,
        window_from_ms: Option<i64>,
        window_to_ms: Option<i64>,
        payload_json: &str,
        channel_ids: &[i64],
        now_ms: i64,
    ) -> Result<bool, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let mut tx = pool.begin().await?;
                let inserted = sqlx::query("INSERT OR IGNORE INTO notification_runs (id, rule_id, rule_name, event_type, scheduled_for_ms, window_from_ms, window_to_ms, payload_json, status, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
                    .bind(run_id).bind(rule_id).bind(rule_name).bind(event_type).bind(scheduled_for_ms).bind(window_from_ms).bind(window_to_ms).bind(payload_json).bind(now_ms).execute(&mut *tx).await?;
                if inserted.rows_affected() == 0 {
                    tx.rollback().await?;
                    return Ok(false);
                }
                let mut has_pending = false;
                for channel_id in channel_ids {
                    let row = sqlx::query(
                        "SELECT name, kind, enabled FROM notification_channels WHERE id = ?",
                    )
                    .bind(channel_id)
                    .fetch_optional(&mut *tx)
                    .await?;
                    let Some(row) = row else {
                        continue;
                    };
                    let enabled = row.get::<bool, _>("enabled");
                    has_pending |= enabled;
                    let delivery_id = format!("{run_id}-{channel_id}");
                    sqlx::query("INSERT INTO notification_deliveries (id, run_id, channel_id, channel_name, channel_kind, status, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)")
                        .bind(delivery_id).bind(run_id).bind(channel_id).bind(row.get::<String, _>("name")).bind(row.get::<String, _>("kind"))
                        .bind(if enabled { "pending" } else { "skipped" }).bind(if enabled { Some(now_ms) } else { None }).bind(now_ms).bind(now_ms).execute(&mut *tx).await?;
                }
                if !has_pending {
                    sqlx::query("UPDATE notification_runs SET status = 'skipped', completed_at_ms = ? WHERE id = ?")
                        .bind(now_ms)
                        .bind(run_id)
                        .execute(&mut *tx)
                        .await?;
                }
                tx.commit().await?;
                Ok(true)
            }
            Self::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let inserted = sqlx::query("INSERT INTO notification_runs (id, rule_id, rule_name, event_type, scheduled_for_ms, window_from_ms, window_to_ms, payload_json, status, created_at_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) ON CONFLICT (rule_id, event_type, scheduled_for_ms) WHERE rule_id IS NOT NULL DO NOTHING")
                    .bind(run_id).bind(rule_id).bind(rule_name).bind(event_type).bind(scheduled_for_ms).bind(window_from_ms).bind(window_to_ms).bind(payload_json).bind(now_ms).execute(&mut *tx).await?;
                if inserted.rows_affected() == 0 {
                    tx.rollback().await?;
                    return Ok(false);
                }
                let mut has_pending = false;
                for channel_id in channel_ids {
                    let row = sqlx::query(
                        "SELECT name, kind, enabled FROM notification_channels WHERE id = $1",
                    )
                    .bind(channel_id)
                    .fetch_optional(&mut *tx)
                    .await?;
                    let Some(row) = row else {
                        continue;
                    };
                    let enabled = row.get::<bool, _>("enabled");
                    has_pending |= enabled;
                    let delivery_id = format!("{run_id}-{channel_id}");
                    sqlx::query("INSERT INTO notification_deliveries (id, run_id, channel_id, channel_name, channel_kind, status, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9)")
                        .bind(delivery_id).bind(run_id).bind(channel_id).bind(row.get::<String, _>("name")).bind(row.get::<String, _>("kind"))
                        .bind(if enabled { "pending" } else { "skipped" }).bind(if enabled { Some(now_ms) } else { None }).bind(now_ms).bind(now_ms).execute(&mut *tx).await?;
                }
                if !has_pending {
                    sqlx::query("UPDATE notification_runs SET status = 'skipped', completed_at_ms = $1 WHERE id = $2")
                        .bind(now_ms)
                        .bind(run_id)
                        .execute(&mut *tx)
                        .await?;
                }
                tx.commit().await?;
                Ok(true)
            }
        }
    }

    pub async fn notification_list_due_deliveries(
        &self,
        now_ms: i64,
        limit: i64,
    ) -> Result<Vec<String>, DbError> {
        match self {
            Self::Sqlite(pool) => Ok(sqlx::query_scalar("SELECT id FROM notification_deliveries WHERE status = 'pending' AND next_attempt_at_ms <= ? AND (lease_until_ms IS NULL OR lease_until_ms < ?) ORDER BY next_attempt_at_ms ASC LIMIT ?")
                .bind(now_ms).bind(now_ms).bind(limit).fetch_all(pool).await?),
            Self::Postgres(pool) => Ok(sqlx::query_scalar("SELECT id FROM notification_deliveries WHERE status = 'pending' AND next_attempt_at_ms <= $1 AND (lease_until_ms IS NULL OR lease_until_ms < $2) ORDER BY next_attempt_at_ms ASC LIMIT $3")
                .bind(now_ms).bind(now_ms).bind(limit).fetch_all(pool).await?),
        }
    }

    pub async fn notification_claim_delivery(
        &self,
        id: &str,
        owner: &str,
        now_ms: i64,
        lease_until_ms: i64,
    ) -> Result<Option<DeliveryWorkItem>, DbError> {
        let claimed = match self {
            Self::Sqlite(pool) => sqlx::query("UPDATE notification_deliveries SET status = 'sending', lease_owner = ?, lease_until_ms = ?, last_attempt_at_ms = ?, attempts = attempts + 1, updated_at_ms = ? WHERE id = ? AND status = 'pending' AND next_attempt_at_ms <= ? AND (lease_until_ms IS NULL OR lease_until_ms < ?)")
                .bind(owner).bind(lease_until_ms).bind(now_ms).bind(now_ms).bind(id).bind(now_ms).bind(now_ms).execute(pool).await?.rows_affected(),
            Self::Postgres(pool) => sqlx::query("UPDATE notification_deliveries SET status = 'sending', lease_owner = $1, lease_until_ms = $2, last_attempt_at_ms = $3, attempts = attempts + 1, updated_at_ms = $4 WHERE id = $5 AND status = 'pending' AND next_attempt_at_ms <= $6 AND (lease_until_ms IS NULL OR lease_until_ms < $7)")
                .bind(owner).bind(lease_until_ms).bind(now_ms).bind(now_ms).bind(id).bind(now_ms).bind(now_ms).execute(pool).await?.rows_affected(),
        };
        if claimed == 0 {
            return Ok(None);
        }
        match self {
            Self::Sqlite(pool) => {
                let row = sqlx::query(DELIVERY_WORK_SQLITE)
                    .bind(id)
                    .fetch_one(pool)
                    .await?;
                Ok(Some(delivery_work_from_sqlite(row)))
            }
            Self::Postgres(pool) => {
                let row = sqlx::query(DELIVERY_WORK_POSTGRES)
                    .bind(id)
                    .fetch_one(pool)
                    .await?;
                Ok(Some(delivery_work_from_postgres(row)))
            }
        }
    }

    pub async fn notification_finish_delivery_success(
        &self,
        id: &str,
        owner: &str,
        diagnostics: DeliveryAttemptDiagnostics<'_>,
        now_ms: i64,
    ) -> Result<(), DbError> {
        match self {
            Self::Sqlite(pool) => {
                sqlx::query("UPDATE notification_deliveries SET status = 'succeeded', delivered_at_ms = ?, next_attempt_at_ms = NULL, lease_owner = NULL, lease_until_ms = NULL, last_error_code = NULL, last_error_message = NULL, last_http_status = ?, last_request_body = ?, last_response_body = ?, updated_at_ms = ? WHERE id = ? AND lease_owner = ?")
                .bind(now_ms).bind(diagnostics.http_status).bind(diagnostics.request_body).bind(diagnostics.response_body).bind(now_ms).bind(id).bind(owner).execute(pool).await?;
            }
            Self::Postgres(pool) => {
                sqlx::query("UPDATE notification_deliveries SET status = 'succeeded', delivered_at_ms = $1, next_attempt_at_ms = NULL, lease_owner = NULL, lease_until_ms = NULL, last_error_code = NULL, last_error_message = NULL, last_http_status = $2, last_request_body = $3, last_response_body = $4, updated_at_ms = $5 WHERE id = $6 AND lease_owner = $7")
                .bind(now_ms).bind(diagnostics.http_status).bind(diagnostics.request_body).bind(diagnostics.response_body).bind(now_ms).bind(id).bind(owner).execute(pool).await?;
            }
        }
        self.notification_refresh_run_status_for_delivery(id, now_ms)
            .await
    }

    pub async fn notification_finish_delivery_failure(
        &self,
        id: &str,
        owner: &str,
        failure: DeliveryFailure<'_>,
        now_ms: i64,
    ) -> Result<(), DbError> {
        let status = if failure.retry_at_ms.is_some() {
            "pending"
        } else {
            "failed"
        };
        match self {
            Self::Sqlite(pool) => {
                sqlx::query("UPDATE notification_deliveries SET status = ?, next_attempt_at_ms = ?, lease_owner = NULL, lease_until_ms = NULL, last_error_code = ?, last_error_message = ?, last_http_status = ?, last_request_body = ?, last_response_body = ?, updated_at_ms = ? WHERE id = ? AND lease_owner = ?")
                .bind(status).bind(failure.retry_at_ms).bind(failure.error_code).bind(failure.error_message).bind(failure.diagnostics.http_status).bind(failure.diagnostics.request_body).bind(failure.diagnostics.response_body).bind(now_ms).bind(id).bind(owner).execute(pool).await?;
            }
            Self::Postgres(pool) => {
                sqlx::query("UPDATE notification_deliveries SET status = $1, next_attempt_at_ms = $2, lease_owner = NULL, lease_until_ms = NULL, last_error_code = $3, last_error_message = $4, last_http_status = $5, last_request_body = $6, last_response_body = $7, updated_at_ms = $8 WHERE id = $9 AND lease_owner = $10")
                .bind(status).bind(failure.retry_at_ms).bind(failure.error_code).bind(failure.error_message).bind(failure.diagnostics.http_status).bind(failure.diagnostics.request_body).bind(failure.diagnostics.response_body).bind(now_ms).bind(id).bind(owner).execute(pool).await?;
            }
        }
        self.notification_refresh_run_status_for_delivery(id, now_ms)
            .await
    }

    async fn notification_refresh_run_status_for_delivery(
        &self,
        delivery_id: &str,
        now_ms: i64,
    ) -> Result<(), DbError> {
        let run_id: String = match self {
            Self::Sqlite(pool) => {
                sqlx::query_scalar("SELECT run_id FROM notification_deliveries WHERE id = ?")
                    .bind(delivery_id)
                    .fetch_one(pool)
                    .await?
            }
            Self::Postgres(pool) => {
                sqlx::query_scalar("SELECT run_id FROM notification_deliveries WHERE id = $1")
                    .bind(delivery_id)
                    .fetch_one(pool)
                    .await?
            }
        };
        let (pending, succeeded, failed): (i64, i64, i64) = match self {
            Self::Sqlite(pool) => {
                let row = sqlx::query("SELECT SUM(CASE WHEN status IN ('pending','sending') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM notification_deliveries WHERE run_id = ?").bind(&run_id).fetch_one(pool).await?;
                (row.get("pending"), row.get("succeeded"), row.get("failed"))
            }
            Self::Postgres(pool) => {
                let row = sqlx::query("SELECT COALESCE(SUM(CASE WHEN status IN ('pending','sending') THEN 1 ELSE 0 END),0)::BIGINT AS pending, COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END),0)::BIGINT AS succeeded, COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),0)::BIGINT AS failed FROM notification_deliveries WHERE run_id = $1").bind(&run_id).fetch_one(pool).await?;
                (row.get("pending"), row.get("succeeded"), row.get("failed"))
            }
        };
        let status = if pending > 0 {
            "sending"
        } else if failed == 0 {
            "succeeded"
        } else if succeeded > 0 {
            "partial"
        } else {
            "failed"
        };
        let completed = if pending == 0 { Some(now_ms) } else { None };
        match self {
            Self::Sqlite(pool) => {
                sqlx::query(
                    "UPDATE notification_runs SET status = ?, completed_at_ms = ? WHERE id = ?",
                )
                .bind(status)
                .bind(completed)
                .bind(run_id)
                .execute(pool)
                .await?;
            }
            Self::Postgres(pool) => {
                sqlx::query(
                    "UPDATE notification_runs SET status = $1, completed_at_ms = $2 WHERE id = $3",
                )
                .bind(status)
                .bind(completed)
                .bind(run_id)
                .execute(pool)
                .await?;
            }
        }
        Ok(())
    }

    pub async fn notification_list_deliveries(
        &self,
        offset: i64,
        limit: i64,
        status: Option<&str>,
        rule_id: Option<i64>,
    ) -> Result<Vec<DeliveryView>, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let rows = sqlx::query(DELIVERY_VIEW_SQLITE)
                    .bind(status)
                    .bind(status)
                    .bind(rule_id)
                    .bind(rule_id)
                    .bind(limit)
                    .bind(offset)
                    .fetch_all(pool)
                    .await?;
                Ok(rows.into_iter().map(delivery_view_from_sqlite).collect())
            }
            Self::Postgres(pool) => {
                let rows = sqlx::query(DELIVERY_VIEW_POSTGRES)
                    .bind(status)
                    .bind(rule_id)
                    .bind(limit)
                    .bind(offset)
                    .fetch_all(pool)
                    .await?;
                Ok(rows.into_iter().map(delivery_view_from_postgres).collect())
            }
        }
    }

    pub async fn notification_get_delivery(
        &self,
        id: &str,
    ) -> Result<Option<DeliveryView>, DbError> {
        let sql = "SELECT d.id, d.run_id, r.rule_id, r.rule_name, r.event_type, d.channel_id, d.channel_name, d.channel_kind, d.status, d.attempts, d.next_attempt_at_ms, d.last_attempt_at_ms, d.delivered_at_ms, d.last_error_code, d.last_error_message, d.created_at_ms, r.window_from_ms, r.window_to_ms FROM notification_deliveries d JOIN notification_runs r ON r.id = d.run_id WHERE d.id = ";
        match self {
            Self::Sqlite(pool) => Ok(sqlx::query(&format!("{sql}?"))
                .bind(id)
                .fetch_optional(pool)
                .await?
                .map(delivery_view_from_sqlite)),
            Self::Postgres(pool) => Ok(sqlx::query(&format!("{sql}$1"))
                .bind(id)
                .fetch_optional(pool)
                .await?
                .map(delivery_view_from_postgres)),
        }
    }

    pub async fn notification_get_delivery_detail(
        &self,
        id: &str,
    ) -> Result<Option<DeliveryDetailView>, DbError> {
        let sql = "SELECT d.id, d.run_id, r.rule_id, r.rule_name, r.event_type, d.channel_id, d.channel_name, d.channel_kind, d.status, d.attempts, d.next_attempt_at_ms, d.last_attempt_at_ms, d.delivered_at_ms, d.last_error_code, d.last_error_message, d.created_at_ms, r.window_from_ms, r.window_to_ms, d.last_http_status, d.last_request_body, d.last_response_body, r.payload_json AS event_payload_json FROM notification_deliveries d JOIN notification_runs r ON r.id = d.run_id WHERE d.id = ";
        match self {
            Self::Sqlite(pool) => Ok(sqlx::query(&format!("{sql}?"))
                .bind(id)
                .fetch_optional(pool)
                .await?
                .map(delivery_detail_from_sqlite)),
            Self::Postgres(pool) => Ok(sqlx::query(&format!("{sql}$1"))
                .bind(id)
                .fetch_optional(pool)
                .await?
                .map(delivery_detail_from_postgres)),
        }
    }

    pub async fn notification_retry_delivery(
        &self,
        id: &str,
        now_ms: i64,
    ) -> Result<bool, DbError> {
        let rows_affected = match self {
            Self::Sqlite(pool) => sqlx::query("UPDATE notification_deliveries SET status = 'pending', next_attempt_at_ms = ?, lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = ? WHERE id = ? AND status = 'failed'").bind(now_ms).bind(now_ms).bind(id).execute(pool).await?.rows_affected(),
            Self::Postgres(pool) => sqlx::query("UPDATE notification_deliveries SET status = 'pending', next_attempt_at_ms = $1, lease_owner = NULL, lease_until_ms = NULL, updated_at_ms = $2 WHERE id = $3 AND status = 'failed'").bind(now_ms).bind(now_ms).bind(id).execute(pool).await?.rows_affected(),
        };
        Ok(rows_affected == 1)
    }

    pub async fn notification_get_alert_state(
        &self,
        rule_id: i64,
    ) -> Result<Option<AlertStateRecord>, DbError> {
        match self {
            Self::Sqlite(pool) => Ok(sqlx::query("SELECT rule_id, state, breach_count, recovery_count, opened_at_ms, last_notified_at_ms, last_value_json FROM notification_alert_states WHERE rule_id = ?")
                .bind(rule_id).fetch_optional(pool).await?.map(alert_state_from_sqlite)),
            Self::Postgres(pool) => Ok(sqlx::query("SELECT rule_id, state, breach_count, recovery_count, opened_at_ms, last_notified_at_ms, last_value_json FROM notification_alert_states WHERE rule_id = $1")
                .bind(rule_id).fetch_optional(pool).await?.map(alert_state_from_postgres)),
        }
    }

    pub async fn notification_upsert_alert_state(
        &self,
        rule_id: i64,
        update: AlertStateUpdate<'_>,
    ) -> Result<(), DbError> {
        match self {
            Self::Sqlite(pool) => {
                sqlx::query("INSERT INTO notification_alert_states (rule_id, state, breach_count, recovery_count, opened_at_ms, last_notified_at_ms, last_value_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rule_id) DO UPDATE SET state = excluded.state, breach_count = excluded.breach_count, recovery_count = excluded.recovery_count, opened_at_ms = excluded.opened_at_ms, last_notified_at_ms = excluded.last_notified_at_ms, last_value_json = excluded.last_value_json, updated_at_ms = excluded.updated_at_ms")
                .bind(rule_id).bind(update.state).bind(update.breach_count).bind(update.recovery_count).bind(update.opened_at_ms).bind(update.last_notified_at_ms).bind(update.last_value_json).bind(update.now_ms).execute(pool).await?;
            }
            Self::Postgres(pool) => {
                sqlx::query("INSERT INTO notification_alert_states (rule_id, state, breach_count, recovery_count, opened_at_ms, last_notified_at_ms, last_value_json, updated_at_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT(rule_id) DO UPDATE SET state = EXCLUDED.state, breach_count = EXCLUDED.breach_count, recovery_count = EXCLUDED.recovery_count, opened_at_ms = EXCLUDED.opened_at_ms, last_notified_at_ms = EXCLUDED.last_notified_at_ms, last_value_json = EXCLUDED.last_value_json, updated_at_ms = EXCLUDED.updated_at_ms")
                .bind(rule_id).bind(update.state).bind(update.breach_count).bind(update.recovery_count).bind(update.opened_at_ms).bind(update.last_notified_at_ms).bind(update.last_value_json).bind(update.now_ms).execute(pool).await?;
            }
        }
        Ok(())
    }

    pub async fn notification_aggregate_usage(
        &self,
        from_ms: i64,
        to_ms: i64,
    ) -> Result<Vec<UsageGroupRow>, DbError> {
        match self {
            Self::Sqlite(pool) => {
                let rows = sqlx::query(USAGE_SQLITE)
                    .bind(from_ms)
                    .bind(to_ms)
                    .fetch_all(pool)
                    .await?;
                Ok(rows.into_iter().map(usage_from_sqlite).collect())
            }
            Self::Postgres(pool) => {
                let rows = sqlx::query(USAGE_POSTGRES)
                    .bind(from_ms)
                    .bind(to_ms)
                    .fetch_all(pool)
                    .await?;
                Ok(rows.into_iter().map(usage_from_postgres).collect())
            }
        }
    }

    pub async fn notification_cleanup_history(&self, cutoff_ms: i64) -> Result<u64, DbError> {
        let rows_affected = match self {
            Self::Sqlite(pool) => {
                sqlx::query("DELETE FROM notification_runs WHERE created_at_ms < ?")
                    .bind(cutoff_ms)
                    .execute(pool)
                    .await?
                    .rows_affected()
            }
            Self::Postgres(pool) => {
                sqlx::query("DELETE FROM notification_runs WHERE created_at_ms < $1")
                    .bind(cutoff_ms)
                    .execute(pool)
                    .await?
                    .rows_affected()
            }
        };
        Ok(rows_affected)
    }
}

const RULE_SELECT_SQL: &str = "SELECT id, name, kind, enabled, config_json, next_run_at_ms, last_window_end_ms, created_at_ms, updated_at_ms FROM notification_rules";

const DELIVERY_WORK_SQLITE: &str = "SELECT d.id, r.event_type, r.payload_json, c.config_enc AS channel_config_enc, d.attempts FROM notification_deliveries d JOIN notification_runs r ON r.id = d.run_id JOIN notification_channels c ON c.id = d.channel_id WHERE d.id = ?";
const DELIVERY_WORK_POSTGRES: &str = "SELECT d.id, r.event_type, r.payload_json, c.config_enc AS channel_config_enc, d.attempts FROM notification_deliveries d JOIN notification_runs r ON r.id = d.run_id JOIN notification_channels c ON c.id = d.channel_id WHERE d.id = $1";

const DELIVERY_VIEW_SQLITE: &str = "SELECT d.id, d.run_id, r.rule_id, r.rule_name, r.event_type, d.channel_id, d.channel_name, d.channel_kind, d.status, d.attempts, d.next_attempt_at_ms, d.last_attempt_at_ms, d.delivered_at_ms, d.last_error_code, d.last_error_message, d.created_at_ms, r.window_from_ms, r.window_to_ms FROM notification_deliveries d JOIN notification_runs r ON r.id = d.run_id WHERE (? IS NULL OR d.status = ?) AND (? IS NULL OR r.rule_id = ?) ORDER BY d.created_at_ms DESC LIMIT ? OFFSET ?";
const DELIVERY_VIEW_POSTGRES: &str = "SELECT d.id, d.run_id, r.rule_id, r.rule_name, r.event_type, d.channel_id, d.channel_name, d.channel_kind, d.status, d.attempts, d.next_attempt_at_ms, d.last_attempt_at_ms, d.delivered_at_ms, d.last_error_code, d.last_error_message, d.created_at_ms, r.window_from_ms, r.window_to_ms FROM notification_deliveries d JOIN notification_runs r ON r.id = d.run_id WHERE ($1::TEXT IS NULL OR d.status = $1) AND ($2::BIGINT IS NULL OR r.rule_id = $2) ORDER BY d.created_at_ms DESC LIMIT $3 OFFSET $4";

const USAGE_SQLITE: &str = r#"
SELECT provider_id, api_key_id, price_version_id, price_tier_index,
  SUM(CASE WHEN COALESCE(http_status, 500) < 400 AND error_type IS NULL THEN 1 ELSE 0 END) AS request_success,
  SUM(CASE WHEN COALESCE(http_status, 500) >= 400 OR error_type IS NOT NULL THEN 1 ELSE 0 END) AS request_failed,
  SUM(CASE WHEN usage_observed != 0 THEN 1 ELSE 0 END) AS usage_observed_requests,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
  COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens
FROM stats_events
WHERE time_ms >= ? AND time_ms < ?
GROUP BY provider_id, api_key_id, price_version_id, price_tier_index
ORDER BY provider_id, api_key_id
"#;

const USAGE_POSTGRES: &str = r#"
SELECT provider_id, api_key_id, price_version_id, price_tier_index,
  COALESCE(SUM(CASE WHEN COALESCE(http_status, 500) < 400 AND error_type IS NULL THEN 1 ELSE 0 END), 0)::BIGINT AS request_success,
  COALESCE(SUM(CASE WHEN COALESCE(http_status, 500) >= 400 OR error_type IS NOT NULL THEN 1 ELSE 0 END), 0)::BIGINT AS request_failed,
  COALESCE(SUM(CASE WHEN usage_observed THEN 1 ELSE 0 END), 0)::BIGINT AS usage_observed_requests,
  COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
  COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
  COALESCE(SUM(cache_read_input_tokens), 0)::BIGINT AS cache_read_input_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0)::BIGINT AS cache_creation_input_tokens,
  COALESCE(SUM(reasoning_output_tokens), 0)::BIGINT AS reasoning_output_tokens
FROM stats_events
WHERE time_ms >= $1 AND time_ms < $2
GROUP BY provider_id, api_key_id, price_version_id, price_tier_index
ORDER BY provider_id, api_key_id
"#;

fn channel_from_sqlite(row: sqlx::sqlite::SqliteRow) -> ChannelRecord {
    ChannelRecord {
        id: row.get("id"),
        name: row.get("name"),
        kind: row.get("kind"),
        enabled: row.get("enabled"),
        config_enc: row.get("config_enc"),
        created_at_ms: row.get("created_at_ms"),
        updated_at_ms: row.get("updated_at_ms"),
    }
}

fn channel_from_postgres(row: sqlx::postgres::PgRow) -> ChannelRecord {
    ChannelRecord {
        id: row.get("id"),
        name: row.get("name"),
        kind: row.get("kind"),
        enabled: row.get("enabled"),
        config_enc: row.get("config_enc"),
        created_at_ms: row.get("created_at_ms"),
        updated_at_ms: row.get("updated_at_ms"),
    }
}

fn rule_from_sqlite(row: sqlx::sqlite::SqliteRow) -> RuleRecord {
    RuleRecord {
        id: row.get("id"),
        name: row.get("name"),
        kind: row.get("kind"),
        enabled: row.get("enabled"),
        config_json: row.get("config_json"),
        next_run_at_ms: row.get("next_run_at_ms"),
        last_window_end_ms: row.get("last_window_end_ms"),
        created_at_ms: row.get("created_at_ms"),
        updated_at_ms: row.get("updated_at_ms"),
    }
}

fn rule_from_postgres(row: sqlx::postgres::PgRow) -> RuleRecord {
    RuleRecord {
        id: row.get("id"),
        name: row.get("name"),
        kind: row.get("kind"),
        enabled: row.get("enabled"),
        config_json: row.get("config_json"),
        next_run_at_ms: row.get("next_run_at_ms"),
        last_window_end_ms: row.get("last_window_end_ms"),
        created_at_ms: row.get("created_at_ms"),
        updated_at_ms: row.get("updated_at_ms"),
    }
}

fn alert_state_from_sqlite(row: sqlx::sqlite::SqliteRow) -> AlertStateRecord {
    AlertStateRecord {
        state: row.get("state"),
        breach_count: row.get("breach_count"),
        recovery_count: row.get("recovery_count"),
        opened_at_ms: row.get("opened_at_ms"),
        last_notified_at_ms: row.get("last_notified_at_ms"),
    }
}

fn alert_state_from_postgres(row: sqlx::postgres::PgRow) -> AlertStateRecord {
    AlertStateRecord {
        state: row.get("state"),
        breach_count: row.get("breach_count"),
        recovery_count: row.get("recovery_count"),
        opened_at_ms: row.get("opened_at_ms"),
        last_notified_at_ms: row.get("last_notified_at_ms"),
    }
}

fn delivery_work_from_sqlite(row: sqlx::sqlite::SqliteRow) -> DeliveryWorkItem {
    DeliveryWorkItem {
        id: row.get("id"),
        event_type: row.get("event_type"),
        payload_json: row.get("payload_json"),
        channel_config_enc: row.get("channel_config_enc"),
        attempts: row.get("attempts"),
    }
}

fn delivery_work_from_postgres(row: sqlx::postgres::PgRow) -> DeliveryWorkItem {
    DeliveryWorkItem {
        id: row.get("id"),
        event_type: row.get("event_type"),
        payload_json: row.get("payload_json"),
        channel_config_enc: row.get("channel_config_enc"),
        attempts: row.get("attempts"),
    }
}

fn delivery_view_from_sqlite(row: sqlx::sqlite::SqliteRow) -> DeliveryView {
    DeliveryView {
        id: row.get("id"),
        run_id: row.get("run_id"),
        rule_id: row.get("rule_id"),
        rule_name: row.get("rule_name"),
        event_type: row.get("event_type"),
        channel_id: row.get("channel_id"),
        channel_name: row.get("channel_name"),
        channel_kind: row.get("channel_kind"),
        status: row.get("status"),
        attempts: row.get("attempts"),
        next_attempt_at_ms: row.get("next_attempt_at_ms"),
        last_attempt_at_ms: row.get("last_attempt_at_ms"),
        delivered_at_ms: row.get("delivered_at_ms"),
        last_error_code: row.get("last_error_code"),
        last_error_message: row.get("last_error_message"),
        created_at_ms: row.get("created_at_ms"),
        window_from_ms: row.get("window_from_ms"),
        window_to_ms: row.get("window_to_ms"),
    }
}

fn delivery_view_from_postgres(row: sqlx::postgres::PgRow) -> DeliveryView {
    DeliveryView {
        id: row.get("id"),
        run_id: row.get("run_id"),
        rule_id: row.get("rule_id"),
        rule_name: row.get("rule_name"),
        event_type: row.get("event_type"),
        channel_id: row.get("channel_id"),
        channel_name: row.get("channel_name"),
        channel_kind: row.get("channel_kind"),
        status: row.get("status"),
        attempts: row.get("attempts"),
        next_attempt_at_ms: row.get("next_attempt_at_ms"),
        last_attempt_at_ms: row.get("last_attempt_at_ms"),
        delivered_at_ms: row.get("delivered_at_ms"),
        last_error_code: row.get("last_error_code"),
        last_error_message: row.get("last_error_message"),
        created_at_ms: row.get("created_at_ms"),
        window_from_ms: row.get("window_from_ms"),
        window_to_ms: row.get("window_to_ms"),
    }
}

fn delivery_detail_from_sqlite(row: sqlx::sqlite::SqliteRow) -> DeliveryDetailView {
    let last_http_status = row.get("last_http_status");
    let last_request_body = row.get("last_request_body");
    let last_response_body = row.get("last_response_body");
    let event_payload_json = row.get("event_payload_json");
    DeliveryDetailView {
        delivery: delivery_view_from_sqlite(row),
        last_http_status,
        last_request_body,
        last_response_body,
        event_payload_json,
    }
}

fn delivery_detail_from_postgres(row: sqlx::postgres::PgRow) -> DeliveryDetailView {
    let last_http_status = row.get("last_http_status");
    let last_request_body = row.get("last_request_body");
    let last_response_body = row.get("last_response_body");
    let event_payload_json = row.get("event_payload_json");
    DeliveryDetailView {
        delivery: delivery_view_from_postgres(row),
        last_http_status,
        last_request_body,
        last_response_body,
        event_payload_json,
    }
}

fn usage_from_sqlite(row: sqlx::sqlite::SqliteRow) -> UsageGroupRow {
    UsageGroupRow {
        provider_id: row.get("provider_id"),
        api_key_id: row.get("api_key_id"),
        price_version_id: row.get("price_version_id"),
        price_tier_index: row.get("price_tier_index"),
        request_success: row.get("request_success"),
        request_failed: row.get("request_failed"),
        usage_observed_requests: row.get("usage_observed_requests"),
        usage: Usage {
            input_tokens: row.get("input_tokens"),
            output_tokens: row.get("output_tokens"),
            cache_read_input_tokens: row.get("cache_read_input_tokens"),
            cache_creation_input_tokens: row.get("cache_creation_input_tokens"),
            reasoning_output_tokens: row.get("reasoning_output_tokens"),
        },
    }
}

fn usage_from_postgres(row: sqlx::postgres::PgRow) -> UsageGroupRow {
    UsageGroupRow {
        provider_id: row.get("provider_id"),
        api_key_id: row.get("api_key_id"),
        price_version_id: row.get("price_version_id"),
        price_tier_index: row.get("price_tier_index"),
        request_success: row.get("request_success"),
        request_failed: row.get("request_failed"),
        usage_observed_requests: row.get("usage_observed_requests"),
        usage: Usage {
            input_tokens: row.get("input_tokens"),
            output_tokens: row.get("output_tokens"),
            cache_read_input_tokens: row.get("cache_read_input_tokens"),
            cache_creation_input_tokens: row.get("cache_creation_input_tokens"),
            reasoning_output_tokens: row.get("reasoning_output_tokens"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn sqlite_memory_db() -> Database {
        let database = Database::connect("sqlite::memory:", 1)
            .await
            .expect("connect");
        database.migrate().await.expect("core migrate");
        database
    }

    #[tokio::test]
    async fn notification_migration_is_idempotent() {
        let database = sqlite_memory_db().await;
        database.migrate().await.expect("second migrate");
        let channels = database
            .notification_list_channels()
            .await
            .expect("channels");
        assert!(channels.is_empty());
    }

    #[tokio::test]
    async fn rule_claim_allows_only_one_owner() {
        let database = sqlite_memory_db().await;
        let id = database
            .notification_insert_rule("daily", "scheduled_report", true, "{}", 100, &[], 1)
            .await
            .expect("insert rule");
        assert!(
            database
                .notification_claim_rule(id, "a", 100, 1_000)
                .await
                .expect("claim a")
        );
        assert!(
            !database
                .notification_claim_rule(id, "b", 100, 1_000)
                .await
                .expect("claim b")
        );
    }

    #[tokio::test]
    async fn run_with_only_disabled_channels_is_completed_as_skipped() {
        let database = sqlite_memory_db().await;
        let channel_id = database
            .notification_insert_channel("disabled", "webhook", false, "encrypted", 1)
            .await
            .expect("insert channel");
        database
            .notification_create_run(
                "run-disabled",
                None,
                "test",
                "test",
                1,
                None,
                None,
                "{}",
                &[channel_id],
                1,
            )
            .await
            .expect("create run");
        let delivery = database
            .notification_get_delivery(&format!("run-disabled-{channel_id}"))
            .await
            .expect("get delivery")
            .expect("delivery");
        assert_eq!(delivery.status, "skipped");
    }
}
