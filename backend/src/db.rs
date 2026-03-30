use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{PgPool, Postgres, QueryBuilder, Row, Sqlite, SqlitePool, postgres::PgPoolOptions};

use crate::crypto;
use crate::types::{
    ApiKeyAuth, ModelPrice, ModelPriceData, ModelRoute, RequestLogRow, StatsDailyRow,
    UpstreamEndpoint, UpstreamKey, UpstreamKeyMeta, UpstreamProvider,
};

#[derive(Clone, Debug, Serialize)]
pub struct UsageBreakdownRow {
    pub key: String,
    pub requests: i64,
    pub failed: i64,
    pub tokens: i64,
    pub cost_total_usd: String,
}

#[derive(Clone, Copy, Debug)]
pub enum UsageBreakdownBy {
    Model,
    ApiKey,
}

#[derive(Debug)]
pub struct DbError {
    msg: String,
}

impl DbError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self { msg: msg.into() }
    }
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for DbError {}

impl From<sqlx::Error> for DbError {
    fn from(value: sqlx::Error) -> Self {
        Self::new(value.to_string())
    }
}

#[derive(Clone, Debug, Default)]
pub struct RequestLogFilter {
    pub model: Option<String>,
    pub provider_id: Option<i64>,
    pub endpoint_id: Option<i64>,
    pub upstream_key_id: Option<i64>,
    pub api_key_id: Option<i64>,
    pub api_key_log_enabled: Option<bool>,
    pub api_format: Option<String>,
    pub error_type: Option<String>,
    pub status_class: Option<i32>,
    pub time_from_ms: Option<i64>,
    pub time_to_ms: Option<i64>,
    pub duration_ms_min: Option<i64>,
    pub duration_ms_max: Option<i64>,
    pub total_tokens_min: Option<i64>,
    pub total_tokens_max: Option<i64>,
    pub cost_total_min: Option<f64>,
    pub cost_total_max: Option<f64>,
    pub cache_read_input_tokens_min: Option<i64>,
    pub cache_read_input_tokens_max: Option<i64>,
    pub cache_creation_input_tokens_min: Option<i64>,
    pub cache_creation_input_tokens_max: Option<i64>,
}

#[derive(Clone)]
pub enum Database {
    Sqlite(SqlitePool),
    Postgres(PgPool),
}

impl Database {
    pub async fn connect(dsn: &str, max_connections: u32) -> Result<Self, DbError> {
        if dsn.starts_with("sqlite:") {
            let mut opts =
                SqliteConnectOptions::from_str(dsn).map_err(|e| DbError::new(e.to_string()))?;
            opts = opts.create_if_missing(true);

            let pool = SqlitePoolOptions::new()
                .max_connections(max_connections)
                .after_connect(|conn, _meta| {
                    Box::pin(async move {
                        // SQLite foreign keys are connection-local; enable for every pooled connection.
                        let _ = sqlx::query("PRAGMA foreign_keys = ON;").execute(conn).await;
                        Ok(())
                    })
                })
                .connect_with(opts)
                .await?;

            // Sensible defaults for a single-node gateway.
            // WAL improves concurrent reads; NORMAL is a good tradeoff for durability vs throughput.
            // NOTE: these PRAGMAs are per-connection; setting them via pool executes on one conn,
            // but SQLite applies some (like journal_mode) globally per DB file.
            let _ = sqlx::query("PRAGMA journal_mode = WAL;")
                .execute(&pool)
                .await;
            let _ = sqlx::query("PRAGMA synchronous = NORMAL;")
                .execute(&pool)
                .await;
            let _ = sqlx::query("PRAGMA temp_store = MEMORY;")
                .execute(&pool)
                .await;

            return Ok(Database::Sqlite(pool));
        }

        if dsn.starts_with("postgres:") || dsn.starts_with("postgresql:") {
            let pool = PgPoolOptions::new()
                .max_connections(max_connections)
                .connect(dsn)
                .await?;
            return Ok(Database::Postgres(pool));
        }

        Err(DbError::new(format!("unsupported DB_DSN scheme: {dsn}")))
    }

    pub async fn ping(&self) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => {
                sqlx::query("SELECT 1").execute(pool).await?;
            }
            Database::Postgres(pool) => {
                sqlx::query("SELECT 1").execute(pool).await?;
            }
        }
        Ok(())
    }

    pub async fn migrate(&self) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => migrate_sqlite(pool).await,
            Database::Postgres(pool) => migrate_postgres(pool).await,
        }
    }

    pub async fn find_api_key_by_hash(
        &self,
        key_hash: &str,
    ) -> Result<Option<ApiKeyAuth>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let row = sqlx::query(
                    r#"
SELECT id, enabled, expires_at_ms, log_enabled, name
FROM api_keys
WHERE key_hash = ?
LIMIT 1
"#,
                )
                .bind(key_hash)
                .fetch_optional(pool)
                .await?;

                let Some(row) = row else {
                    return Ok(None);
                };

                Ok(Some(ApiKeyAuth {
                    id: row.get::<i64, _>("id"),
                    enabled: row.get::<i64, _>("enabled") != 0,
                    expires_at_ms: row.get::<Option<i64>, _>("expires_at_ms"),
                    log_enabled: row.get::<i64, _>("log_enabled") != 0,
                    name: row.get::<String, _>("name"),
                }))
            }
            Database::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
SELECT id, enabled, expires_at_ms, log_enabled, name
FROM api_keys
WHERE key_hash = $1
LIMIT 1
"#,
                )
                .bind(key_hash)
                .fetch_optional(pool)
                .await?;

                let Some(row) = row else {
                    return Ok(None);
                };

                Ok(Some(ApiKeyAuth {
                    id: row.get::<i64, _>("id"),
                    enabled: row.get::<bool, _>("enabled"),
                    expires_at_ms: row.get::<Option<i64>, _>("expires_at_ms"),
                    log_enabled: row.get::<bool, _>("log_enabled"),
                    name: row.get::<String, _>("name"),
                }))
            }
        }
    }

    pub async fn insert_api_key(
        &self,
        key_hash: &str,
        name: &str,
        enabled: bool,
        expires_at_ms: Option<i64>,
        log_enabled: bool,
        now_ms: i64,
    ) -> Result<i64, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let res = sqlx::query(
                    r#"
INSERT INTO api_keys (key_hash, name, enabled, expires_at_ms, log_enabled, created_at_ms, updated_at_ms)
VALUES (?, ?, ?, ?, ?, ?, ?)
"#,
                )
                .bind(key_hash)
                .bind(name)
                .bind(if enabled { 1_i64 } else { 0_i64 })
                .bind(expires_at_ms)
                .bind(if log_enabled { 1_i64 } else { 0_i64 })
                .bind(now_ms)
                .bind(now_ms)
                .execute(pool)
                .await?;
                Ok(res.last_insert_rowid())
            }
            Database::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
INSERT INTO api_keys (key_hash, name, enabled, expires_at_ms, log_enabled, created_at_ms, updated_at_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id
"#,
                )
                .bind(key_hash)
                .bind(name)
                .bind(enabled)
                .bind(expires_at_ms)
                .bind(log_enabled)
                .bind(now_ms)
                .bind(now_ms)
                .fetch_one(pool)
                .await?;
                Ok(row.get::<i64, _>("id"))
            }
        }
    }

    pub async fn list_api_keys(&self) -> Result<Vec<ApiKeyAuth>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, enabled, expires_at_ms, log_enabled, name
FROM api_keys
ORDER BY id DESC
"#,
                )
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| ApiKeyAuth {
                        id: row.get::<i64, _>("id"),
                        enabled: row.get::<i64, _>("enabled") != 0,
                        expires_at_ms: row.get::<Option<i64>, _>("expires_at_ms"),
                        log_enabled: row.get::<i64, _>("log_enabled") != 0,
                        name: row.get::<String, _>("name"),
                    })
                    .collect())
            }
            Database::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, enabled, expires_at_ms, log_enabled, name
FROM api_keys
ORDER BY id DESC
"#,
                )
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| ApiKeyAuth {
                        id: row.get::<i64, _>("id"),
                        enabled: row.get::<bool, _>("enabled"),
                        expires_at_ms: row.get::<Option<i64>, _>("expires_at_ms"),
                        log_enabled: row.get::<bool, _>("log_enabled"),
                        name: row.get::<String, _>("name"),
                    })
                    .collect())
            }
        }
    }

    pub async fn find_api_key_by_id(&self, id: i64) -> Result<Option<ApiKeyAuth>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let row = sqlx::query(
                    r#"
SELECT id, enabled, expires_at_ms, log_enabled, name
FROM api_keys
WHERE id = ?
LIMIT 1
"#,
                )
                .bind(id)
                .fetch_optional(pool)
                .await?;
                let Some(row) = row else {
                    return Ok(None);
                };
                Ok(Some(ApiKeyAuth {
                    id: row.get::<i64, _>("id"),
                    enabled: row.get::<i64, _>("enabled") != 0,
                    expires_at_ms: row.get::<Option<i64>, _>("expires_at_ms"),
                    log_enabled: row.get::<i64, _>("log_enabled") != 0,
                    name: row.get::<String, _>("name"),
                }))
            }
            Database::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
SELECT id, enabled, expires_at_ms, log_enabled, name
FROM api_keys
WHERE id = $1
LIMIT 1
"#,
                )
                .bind(id)
                .fetch_optional(pool)
                .await?;
                let Some(row) = row else {
                    return Ok(None);
                };
                Ok(Some(ApiKeyAuth {
                    id: row.get::<i64, _>("id"),
                    enabled: row.get::<bool, _>("enabled"),
                    expires_at_ms: row.get::<Option<i64>, _>("expires_at_ms"),
                    log_enabled: row.get::<bool, _>("log_enabled"),
                    name: row.get::<String, _>("name"),
                }))
            }
        }
    }

    pub async fn update_api_key(
        &self,
        id: i64,
        name: &str,
        enabled: bool,
        expires_at_ms: Option<i64>,
        log_enabled: bool,
        now_ms: i64,
    ) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => {
                sqlx::query(
                    r#"
UPDATE api_keys
SET name = ?, enabled = ?, expires_at_ms = ?, log_enabled = ?, updated_at_ms = ?
WHERE id = ?
"#,
                )
                .bind(name)
                .bind(if enabled { 1_i64 } else { 0_i64 })
                .bind(expires_at_ms)
                .bind(if log_enabled { 1_i64 } else { 0_i64 })
                .bind(now_ms)
                .bind(id)
                .execute(pool)
                .await?;
                Ok(())
            }
            Database::Postgres(pool) => {
                sqlx::query(
                    r#"
UPDATE api_keys
SET name = $1, enabled = $2, expires_at_ms = $3, log_enabled = $4, updated_at_ms = $5
WHERE id = $6
"#,
                )
                .bind(name)
                .bind(enabled)
                .bind(expires_at_ms)
                .bind(log_enabled)
                .bind(now_ms)
                .bind(id)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn delete_api_key(&self, id: i64) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => {
                sqlx::query(
                    r#"
DELETE FROM api_keys
WHERE id = ?
"#,
                )
                .bind(id)
                .execute(pool)
                .await?;
                Ok(())
            }
            Database::Postgres(pool) => {
                sqlx::query(
                    r#"
DELETE FROM api_keys
WHERE id = $1
"#,
                )
                .bind(id)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn insert_upstream_provider(
        &self,
        name: &str,
        provider_type: &str,
        enabled: bool,
        priority: i32,
        weight: i32,
        supports_include_usage: bool,
        now_ms: i64,
    ) -> Result<i64, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let res = sqlx::query(
                    r#"
INSERT INTO upstream_providers (name, provider_type, enabled, priority, weight, supports_include_usage, created_at_ms, updated_at_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
"#,
                )
                .bind(name)
                .bind(provider_type)
                .bind(if enabled { 1_i64 } else { 0_i64 })
                .bind(priority as i64)
                .bind(weight as i64)
                .bind(if supports_include_usage { 1_i64 } else { 0_i64 })
                .bind(now_ms)
                .bind(now_ms)
                .execute(pool)
                .await?;
                Ok(res.last_insert_rowid())
            }
            Database::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
INSERT INTO upstream_providers (name, provider_type, enabled, priority, weight, supports_include_usage, created_at_ms, updated_at_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id
"#,
                )
                .bind(name)
                .bind(provider_type)
                .bind(enabled)
                .bind(priority)
                .bind(weight)
                .bind(supports_include_usage)
                .bind(now_ms)
                .bind(now_ms)
                .fetch_one(pool)
                .await?;
                Ok(row.get::<i64, _>("id"))
            }
        }
    }

    pub async fn update_upstream_provider(
        &self,
        provider: &UpstreamProvider,
        now_ms: i64,
    ) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => {
                sqlx::query(
                    r#"
UPDATE upstream_providers
SET name = ?, provider_type = ?, enabled = ?, priority = ?, weight = ?, supports_include_usage = ?, updated_at_ms = ?
WHERE id = ?
"#,
                )
                .bind(&provider.name)
                .bind(&provider.provider_type)
                .bind(if provider.enabled { 1_i64 } else { 0_i64 })
                .bind(provider.priority as i64)
                .bind(provider.weight as i64)
                .bind(if provider.supports_include_usage { 1_i64 } else { 0_i64 })
                .bind(now_ms)
                .bind(provider.id)
                .execute(pool)
                .await?;
                Ok(())
            }
            Database::Postgres(pool) => {
                sqlx::query(
                    r#"
UPDATE upstream_providers
SET name = $1, provider_type = $2, enabled = $3, priority = $4, weight = $5, supports_include_usage = $6, updated_at_ms = $7
WHERE id = $8
"#,
                )
                .bind(&provider.name)
                .bind(&provider.provider_type)
                .bind(provider.enabled)
                .bind(provider.priority)
                .bind(provider.weight)
                .bind(provider.supports_include_usage)
                .bind(now_ms)
                .bind(provider.id)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn insert_upstream_endpoint(
        &self,
        provider_id: i64,
        name: &str,
        base_url: &str,
        enabled: bool,
        priority: i32,
        weight: i32,
        now_ms: i64,
    ) -> Result<i64, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let res = sqlx::query(
                    r#"
INSERT INTO upstream_endpoints (provider_id, name, base_url, enabled, priority, weight, created_at_ms, updated_at_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
"#,
                )
                .bind(provider_id)
                .bind(name)
                .bind(base_url)
                .bind(if enabled { 1_i64 } else { 0_i64 })
                .bind(priority as i64)
                .bind(weight as i64)
                .bind(now_ms)
                .bind(now_ms)
                .execute(pool)
                .await?;
                Ok(res.last_insert_rowid())
            }
            Database::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
INSERT INTO upstream_endpoints (provider_id, name, base_url, enabled, priority, weight, created_at_ms, updated_at_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id
"#,
                )
                .bind(provider_id)
                .bind(name)
                .bind(base_url)
                .bind(enabled)
                .bind(priority)
                .bind(weight)
                .bind(now_ms)
                .bind(now_ms)
                .fetch_one(pool)
                .await?;
                Ok(row.get::<i64, _>("id"))
            }
        }
    }

    pub async fn list_upstream_endpoints_by_provider(
        &self,
        provider_id: i64,
    ) -> Result<Vec<UpstreamEndpoint>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, base_url, enabled, priority, weight
FROM upstream_endpoints
WHERE provider_id = ?
ORDER BY priority ASC, id ASC
"#,
                )
                .bind(provider_id)
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamEndpoint {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        base_url: row.get::<String, _>("base_url"),
                        enabled: row.get::<i64, _>("enabled") != 0,
                        priority: row.get::<i64, _>("priority") as i32,
                        weight: row.get::<i64, _>("weight") as i32,
                    })
                    .collect())
            }
            Database::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, base_url, enabled, priority, weight
FROM upstream_endpoints
WHERE provider_id = $1
ORDER BY priority ASC, id ASC
"#,
                )
                .bind(provider_id)
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamEndpoint {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        base_url: row.get::<String, _>("base_url"),
                        enabled: row.get::<bool, _>("enabled"),
                        priority: row.get::<i32, _>("priority"),
                        weight: row.get::<i32, _>("weight"),
                    })
                    .collect())
            }
        }
    }

    pub async fn update_upstream_endpoint(
        &self,
        endpoint: &UpstreamEndpoint,
        now_ms: i64,
    ) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => {
                sqlx::query(
                    r#"
UPDATE upstream_endpoints
SET name = ?, base_url = ?, enabled = ?, priority = ?, weight = ?, updated_at_ms = ?
WHERE id = ?
"#,
                )
                .bind(&endpoint.name)
                .bind(&endpoint.base_url)
                .bind(if endpoint.enabled { 1_i64 } else { 0_i64 })
                .bind(endpoint.priority as i64)
                .bind(endpoint.weight as i64)
                .bind(now_ms)
                .bind(endpoint.id)
                .execute(pool)
                .await?;
                Ok(())
            }
            Database::Postgres(pool) => {
                sqlx::query(
                    r#"
UPDATE upstream_endpoints
SET name = $1, base_url = $2, enabled = $3, priority = $4, weight = $5, updated_at_ms = $6
WHERE id = $7
"#,
                )
                .bind(&endpoint.name)
                .bind(&endpoint.base_url)
                .bind(endpoint.enabled)
                .bind(endpoint.priority)
                .bind(endpoint.weight)
                .bind(now_ms)
                .bind(endpoint.id)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn insert_upstream_key(
        &self,
        master_key: &str,
        provider_id: i64,
        name: &str,
        secret_plaintext: &str,
        enabled: bool,
        priority: i32,
        weight: i32,
        now_ms: i64,
    ) -> Result<i64, DbError> {
        let secret_enc = crypto::encrypt_secret(master_key, secret_plaintext)
            .map_err(|e| DbError::new(format!("encrypt upstream key failed: {e}")))?;

        match self {
            Database::Sqlite(pool) => {
                let res = sqlx::query(
                    r#"
INSERT INTO upstream_keys (provider_id, name, secret_enc, enabled, priority, weight, created_at_ms, updated_at_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
"#,
                )
                .bind(provider_id)
                .bind(name)
                .bind(secret_enc)
                .bind(if enabled { 1_i64 } else { 0_i64 })
                .bind(priority as i64)
                .bind(weight as i64)
                .bind(now_ms)
                .bind(now_ms)
                .execute(pool)
                .await?;
                Ok(res.last_insert_rowid())
            }
            Database::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
INSERT INTO upstream_keys (provider_id, name, secret_enc, enabled, priority, weight, created_at_ms, updated_at_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id
"#,
                )
                .bind(provider_id)
                .bind(name)
                .bind(secret_enc)
                .bind(enabled)
                .bind(priority)
                .bind(weight)
                .bind(now_ms)
                .bind(now_ms)
                .fetch_one(pool)
                .await?;
                Ok(row.get::<i64, _>("id"))
            }
        }
    }

    pub async fn list_upstream_keys_meta_by_provider(
        &self,
        provider_id: i64,
    ) -> Result<Vec<UpstreamKeyMeta>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, enabled, priority, weight
FROM upstream_keys
WHERE provider_id = ?
ORDER BY priority ASC, id ASC
"#,
                )
                .bind(provider_id)
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamKeyMeta {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        enabled: row.get::<i64, _>("enabled") != 0,
                        priority: row.get::<i64, _>("priority") as i32,
                        weight: row.get::<i64, _>("weight") as i32,
                    })
                    .collect())
            }
            Database::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, enabled, priority, weight
FROM upstream_keys
WHERE provider_id = $1
ORDER BY priority ASC, id ASC
"#,
                )
                .bind(provider_id)
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamKeyMeta {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        enabled: row.get::<bool, _>("enabled"),
                        priority: row.get::<i32, _>("priority"),
                        weight: row.get::<i32, _>("weight"),
                    })
                    .collect())
            }
        }
    }

    pub async fn list_upstream_keys_meta(&self) -> Result<Vec<UpstreamKeyMeta>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, enabled, priority, weight
FROM upstream_keys
ORDER BY provider_id ASC, priority ASC, id ASC
"#,
                )
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamKeyMeta {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        enabled: row.get::<i64, _>("enabled") != 0,
                        priority: row.get::<i64, _>("priority") as i32,
                        weight: row.get::<i64, _>("weight") as i32,
                    })
                    .collect())
            }
            Database::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, enabled, priority, weight
FROM upstream_keys
ORDER BY provider_id ASC, priority ASC, id ASC
"#,
                )
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamKeyMeta {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        enabled: row.get::<bool, _>("enabled"),
                        priority: row.get::<i32, _>("priority"),
                        weight: row.get::<i32, _>("weight"),
                    })
                    .collect())
            }
        }
    }

    pub async fn update_upstream_key(
        &self,
        master_key: &str,
        key: &UpstreamKey,
        now_ms: i64,
    ) -> Result<(), DbError> {
        let secret_enc = crypto::encrypt_secret(master_key, &key.secret)
            .map_err(|e| DbError::new(format!("encrypt upstream key failed: {e}")))?;

        match self {
            Database::Sqlite(pool) => {
                sqlx::query(
                    r#"
UPDATE upstream_keys
SET name = ?, secret_enc = ?, enabled = ?, priority = ?, weight = ?, updated_at_ms = ?
WHERE id = ?
"#,
                )
                .bind(&key.name)
                .bind(secret_enc)
                .bind(if key.enabled { 1_i64 } else { 0_i64 })
                .bind(key.priority as i64)
                .bind(key.weight as i64)
                .bind(now_ms)
                .bind(key.id)
                .execute(pool)
                .await?;
                Ok(())
            }
            Database::Postgres(pool) => {
                sqlx::query(
                    r#"
UPDATE upstream_keys
SET name = $1, secret_enc = $2, enabled = $3, priority = $4, weight = $5, updated_at_ms = $6
WHERE id = $7
"#,
                )
                .bind(&key.name)
                .bind(secret_enc)
                .bind(key.enabled)
                .bind(key.priority)
                .bind(key.weight)
                .bind(now_ms)
                .bind(key.id)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn upsert_model_route(
        &self,
        model_name: &str,
        enabled: bool,
        provider_ids: &[i64],
        now_ms: i64,
    ) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => {
                upsert_model_route_sqlite(pool, model_name, enabled, provider_ids, now_ms).await
            }
            Database::Postgres(pool) => {
                upsert_model_route_postgres(pool, model_name, enabled, provider_ids, now_ms).await
            }
        }
    }

    pub async fn insert_model_price(
        &self,
        provider_id: Option<i64>,
        model_name: &str,
        price_data_json: &str,
        now_ms: i64,
    ) -> Result<i64, DbError> {
        // Validate JSON early so bad data doesn't get into DB.
        let _: Value = serde_json::from_str(price_data_json)
            .map_err(|e| DbError::new(format!("invalid price_data_json: {e}")))?;

        match self {
            Database::Sqlite(pool) => {
                let res = sqlx::query(
                    r#"
INSERT INTO model_prices (provider_id, model_name, price_data_json, created_at_ms, updated_at_ms)
VALUES (?, ?, ?, ?, ?)
"#,
                )
                .bind(provider_id)
                .bind(model_name)
                .bind(price_data_json)
                .bind(now_ms)
                .bind(now_ms)
                .execute(pool)
                .await?;
                Ok(res.last_insert_rowid())
            }
            Database::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
INSERT INTO model_prices (provider_id, model_name, price_data_json, created_at_ms, updated_at_ms)
VALUES ($1, $2, $3, $4, $5)
RETURNING id
"#,
                )
                .bind(provider_id)
                .bind(model_name)
                .bind(price_data_json)
                .bind(now_ms)
                .bind(now_ms)
                .fetch_one(pool)
                .await?;
                Ok(row.get::<i64, _>("id"))
            }
        }
    }

    pub async fn list_stats_daily_by_date(
        &self,
        date: &str,
    ) -> Result<Vec<StatsDailyRow>, DbError> {
        match self {
            Database::Sqlite(pool) => list_stats_daily_by_date_sqlite(pool, date).await,
            Database::Postgres(pool) => list_stats_daily_by_date_postgres(pool, date).await,
        }
    }

    pub async fn upsert_stats_daily(&self, rows: &[StatsDailyRow]) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => upsert_stats_daily_sqlite(pool, rows).await,
            Database::Postgres(pool) => upsert_stats_daily_postgres(pool, rows).await,
        }
    }

    pub async fn list_stats_daily_range(
        &self,
        api_key_id: i64,
        start_date: &str,
        end_date: &str,
    ) -> Result<Vec<StatsDailyRow>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                list_stats_daily_range_sqlite(pool, api_key_id, start_date, end_date).await
            }
            Database::Postgres(pool) => {
                list_stats_daily_range_postgres(pool, api_key_id, start_date, end_date).await
            }
        }
    }

    pub async fn insert_request_logs(&self, rows: &[RequestLogRow]) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => insert_request_logs_sqlite(pool, rows).await,
            Database::Postgres(pool) => insert_request_logs_postgres(pool, rows).await,
        }
    }

    pub async fn delete_request_logs_before(
        &self,
        cutoff_time_ms: i64,
        limit: i64,
    ) -> Result<u64, DbError> {
        match self {
            Database::Sqlite(pool) => {
                delete_request_logs_before_sqlite(pool, cutoff_time_ms, limit).await
            }
            Database::Postgres(pool) => {
                delete_request_logs_before_postgres(pool, cutoff_time_ms, limit).await
            }
        }
    }

    pub async fn list_request_logs_before(
        &self,
        cutoff_time_ms: i64,
        limit: i64,
    ) -> Result<Vec<RequestLogRow>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                list_request_logs_before_sqlite(pool, cutoff_time_ms, limit).await
            }
            Database::Postgres(pool) => {
                list_request_logs_before_postgres(pool, cutoff_time_ms, limit).await
            }
        }
    }

    pub async fn delete_stats_daily_before(
        &self,
        cutoff_date: &str,
        limit: i64,
    ) -> Result<u64, DbError> {
        match self {
            Database::Sqlite(pool) => {
                delete_stats_daily_before_sqlite(pool, cutoff_date, limit).await
            }
            Database::Postgres(pool) => {
                delete_stats_daily_before_postgres(pool, cutoff_date, limit).await
            }
        }
    }

    pub async fn list_request_logs(
        &self,
        page: i64,
        page_size: i64,
        filter: &RequestLogFilter,
    ) -> Result<Vec<RequestLogRow>, DbError> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 200);
        let offset = (page - 1) * page_size;

        match self {
            Database::Sqlite(pool) => {
                list_request_logs_sqlite(pool, offset, page_size, filter).await
            }
            Database::Postgres(pool) => {
                list_request_logs_postgres(pool, offset, page_size, filter).await
            }
        }
    }

    pub async fn p95_request_latency_ms(
        &self,
        time_from_ms: i64,
        time_to_ms: i64,
    ) -> Result<i64, DbError> {
        match self {
            Database::Sqlite(pool) => {
                p95_request_latency_ms_sqlite(pool, time_from_ms, time_to_ms).await
            }
            Database::Postgres(pool) => {
                p95_request_latency_ms_postgres(pool, time_from_ms, time_to_ms).await
            }
        }
    }

    pub async fn list_usage_breakdown(
        &self,
        by: UsageBreakdownBy,
        time_from_ms: i64,
        time_to_ms: i64,
        limit: i64,
    ) -> Result<Vec<UsageBreakdownRow>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                list_usage_breakdown_sqlite(pool, by, time_from_ms, time_to_ms, limit).await
            }
            Database::Postgres(pool) => {
                list_usage_breakdown_postgres(pool, by, time_from_ms, time_to_ms, limit).await
            }
        }
    }

    pub async fn list_upstream_providers(&self) -> Result<Vec<UpstreamProvider>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, name, provider_type, enabled, priority, weight, supports_include_usage
FROM upstream_providers
ORDER BY priority ASC, id ASC
"#,
                )
                .fetch_all(pool)
                .await?;

                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamProvider {
                        id: row.get::<i64, _>("id"),
                        name: row.get::<String, _>("name"),
                        provider_type: row.get::<String, _>("provider_type"),
                        enabled: row.get::<i64, _>("enabled") != 0,
                        priority: row.get::<i64, _>("priority") as i32,
                        weight: row.get::<i64, _>("weight") as i32,
                        supports_include_usage: row.get::<i64, _>("supports_include_usage") != 0,
                    })
                    .collect())
            }
            Database::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, name, provider_type, enabled, priority, weight, supports_include_usage
FROM upstream_providers
ORDER BY priority ASC, id ASC
"#,
                )
                .fetch_all(pool)
                .await?;

                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamProvider {
                        id: row.get::<i64, _>("id"),
                        name: row.get::<String, _>("name"),
                        provider_type: row.get::<String, _>("provider_type"),
                        enabled: row.get::<bool, _>("enabled"),
                        priority: row.get::<i32, _>("priority"),
                        weight: row.get::<i32, _>("weight"),
                        supports_include_usage: row.get::<bool, _>("supports_include_usage"),
                    })
                    .collect())
            }
        }
    }

    pub async fn list_upstream_endpoints(&self) -> Result<Vec<UpstreamEndpoint>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, base_url, enabled, priority, weight
FROM upstream_endpoints
ORDER BY provider_id ASC, priority ASC, id ASC
"#,
                )
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamEndpoint {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        base_url: row.get::<String, _>("base_url"),
                        enabled: row.get::<i64, _>("enabled") != 0,
                        priority: row.get::<i64, _>("priority") as i32,
                        weight: row.get::<i64, _>("weight") as i32,
                    })
                    .collect())
            }
            Database::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, base_url, enabled, priority, weight
FROM upstream_endpoints
ORDER BY provider_id ASC, priority ASC, id ASC
"#,
                )
                .fetch_all(pool)
                .await?;
                Ok(rows
                    .into_iter()
                    .map(|row| UpstreamEndpoint {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        base_url: row.get::<String, _>("base_url"),
                        enabled: row.get::<bool, _>("enabled"),
                        priority: row.get::<i32, _>("priority"),
                        weight: row.get::<i32, _>("weight"),
                    })
                    .collect())
            }
        }
    }

    pub async fn list_upstream_keys(&self, master_key: &str) -> Result<Vec<UpstreamKey>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, secret_enc, enabled, priority, weight
FROM upstream_keys
ORDER BY provider_id ASC, priority ASC, id ASC
"#,
                )
                .fetch_all(pool)
                .await?;

                let mut out = Vec::with_capacity(rows.len());
                for row in rows {
                    let secret_enc = row.get::<String, _>("secret_enc");
                    let secret = crypto::decrypt_secret(master_key, &secret_enc)
                        .map_err(|e| DbError::new(format!("decrypt upstream key failed: {e}")))?;

                    out.push(UpstreamKey {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        secret,
                        enabled: row.get::<i64, _>("enabled") != 0,
                        priority: row.get::<i64, _>("priority") as i32,
                        weight: row.get::<i64, _>("weight") as i32,
                    });
                }
                Ok(out)
            }
            Database::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT id, provider_id, name, secret_enc, enabled, priority, weight
FROM upstream_keys
ORDER BY provider_id ASC, priority ASC, id ASC
"#,
                )
                .fetch_all(pool)
                .await?;

                let mut out = Vec::with_capacity(rows.len());
                for row in rows {
                    let secret_enc = row.get::<String, _>("secret_enc");
                    let secret = crypto::decrypt_secret(master_key, &secret_enc)
                        .map_err(|e| DbError::new(format!("decrypt upstream key failed: {e}")))?;

                    out.push(UpstreamKey {
                        id: row.get::<i64, _>("id"),
                        provider_id: row.get::<i64, _>("provider_id"),
                        name: row.get::<String, _>("name"),
                        secret,
                        enabled: row.get::<bool, _>("enabled"),
                        priority: row.get::<i32, _>("priority"),
                        weight: row.get::<i32, _>("weight"),
                    });
                }
                Ok(out)
            }
        }
    }

    pub async fn list_model_routes(&self) -> Result<Vec<ModelRoute>, DbError> {
        match self {
            Database::Sqlite(pool) => list_model_routes_sqlite(pool).await,
            Database::Postgres(pool) => list_model_routes_postgres(pool).await,
        }
    }

    pub async fn list_latest_model_prices(&self) -> Result<Vec<ModelPrice>, DbError> {
        match self {
            Database::Sqlite(pool) => list_latest_model_prices_sqlite(pool).await,
            Database::Postgres(pool) => list_latest_model_prices_postgres(pool).await,
        }
    }
}

async fn p95_request_latency_ms_sqlite(
    pool: &SqlitePool,
    time_from_ms: i64,
    time_to_ms: i64,
) -> Result<i64, DbError> {
    let row = sqlx::query(
        r#"
SELECT COUNT(*) AS total
FROM request_logs
WHERE time_ms >= ? AND time_ms <= ?
  AND COALESCE(duration_ms, t_first_token_ms, t_first_byte_ms) IS NOT NULL
"#,
    )
    .bind(time_from_ms)
    .bind(time_to_ms)
    .fetch_one(pool)
    .await?;

    let total = row.get::<i64, _>("total");
    if total <= 0 {
        return Ok(0);
    }

    // Same percentile convention as earlier UI: ceil(n * 0.95) - 1 (0-indexed).
    let idx = ((total as f64) * 0.95).ceil() as i64 - 1;
    let offset = idx.clamp(0, total.saturating_sub(1));

    let row = sqlx::query(
        r#"
SELECT COALESCE(duration_ms, t_first_token_ms, t_first_byte_ms) AS latency_ms
FROM request_logs
WHERE time_ms >= ? AND time_ms <= ?
  AND COALESCE(duration_ms, t_first_token_ms, t_first_byte_ms) IS NOT NULL
ORDER BY latency_ms ASC
LIMIT 1 OFFSET ?
"#,
    )
    .bind(time_from_ms)
    .bind(time_to_ms)
    .bind(offset)
    .fetch_one(pool)
    .await?;

    Ok(row.get::<i64, _>("latency_ms"))
}

async fn p95_request_latency_ms_postgres(
    pool: &PgPool,
    time_from_ms: i64,
    time_to_ms: i64,
) -> Result<i64, DbError> {
    let row = sqlx::query(
        r#"
SELECT COUNT(*)::BIGINT AS total
FROM request_logs
WHERE time_ms >= $1 AND time_ms <= $2
  AND COALESCE(duration_ms, t_first_token_ms, t_first_byte_ms) IS NOT NULL
"#,
    )
    .bind(time_from_ms)
    .bind(time_to_ms)
    .fetch_one(pool)
    .await?;

    let total = row.get::<i64, _>("total");
    if total <= 0 {
        return Ok(0);
    }

    let idx = ((total as f64) * 0.95).ceil() as i64 - 1;
    let offset = idx.clamp(0, total.saturating_sub(1));

    let row = sqlx::query(
        r#"
SELECT COALESCE(duration_ms, t_first_token_ms, t_first_byte_ms) AS latency_ms
FROM request_logs
WHERE time_ms >= $1 AND time_ms <= $2
  AND COALESCE(duration_ms, t_first_token_ms, t_first_byte_ms) IS NOT NULL
ORDER BY latency_ms ASC
LIMIT 1 OFFSET $3
"#,
    )
    .bind(time_from_ms)
    .bind(time_to_ms)
    .bind(offset)
    .fetch_one(pool)
    .await?;

    Ok(row.get::<i64, _>("latency_ms"))
}

async fn upsert_model_route_sqlite(
    pool: &SqlitePool,
    model_name: &str,
    enabled: bool,
    provider_ids: &[i64],
    now_ms: i64,
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;

    let existing = sqlx::query(
        r#"
SELECT id
FROM model_routes
WHERE model_name = ?
LIMIT 1
"#,
    )
    .bind(model_name)
    .fetch_optional(&mut *tx)
    .await?;

    let route_id = if let Some(row) = existing {
        let id = row.get::<i64, _>("id");
        sqlx::query(
            r#"
UPDATE model_routes
SET enabled = ?, updated_at_ms = ?
WHERE id = ?
"#,
        )
        .bind(if enabled { 1_i64 } else { 0_i64 })
        .bind(now_ms)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM model_route_providers WHERE route_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        id
    } else {
        let res = sqlx::query(
            r#"
INSERT INTO model_routes (model_name, enabled, created_at_ms, updated_at_ms)
VALUES (?, ?, ?, ?)
"#,
        )
        .bind(model_name)
        .bind(if enabled { 1_i64 } else { 0_i64 })
        .bind(now_ms)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        res.last_insert_rowid()
    };

    for pid in provider_ids {
        sqlx::query(
            r#"
INSERT INTO model_route_providers (route_id, provider_id)
VALUES (?, ?)
ON CONFLICT(route_id, provider_id) DO NOTHING
"#,
        )
        .bind(route_id)
        .bind(*pid)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

async fn upsert_model_route_postgres(
    pool: &PgPool,
    model_name: &str,
    enabled: bool,
    provider_ids: &[i64],
    now_ms: i64,
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;

    let existing = sqlx::query(
        r#"
SELECT id
FROM model_routes
WHERE model_name = $1
LIMIT 1
"#,
    )
    .bind(model_name)
    .fetch_optional(&mut *tx)
    .await?;

    let route_id = if let Some(row) = existing {
        let id = row.get::<i64, _>("id");
        sqlx::query(
            r#"
UPDATE model_routes
SET enabled = $1, updated_at_ms = $2
WHERE id = $3
"#,
        )
        .bind(enabled)
        .bind(now_ms)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM model_route_providers WHERE route_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        id
    } else {
        let row = sqlx::query(
            r#"
INSERT INTO model_routes (model_name, enabled, created_at_ms, updated_at_ms)
VALUES ($1, $2, $3, $4)
RETURNING id
"#,
        )
        .bind(model_name)
        .bind(enabled)
        .bind(now_ms)
        .bind(now_ms)
        .fetch_one(&mut *tx)
        .await?;
        row.get::<i64, _>("id")
    };

    for pid in provider_ids {
        sqlx::query(
            r#"
INSERT INTO model_route_providers (route_id, provider_id)
VALUES ($1, $2)
ON CONFLICT(route_id, provider_id) DO NOTHING
"#,
        )
        .bind(route_id)
        .bind(*pid)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

async fn list_stats_daily_by_date_sqlite(
    pool: &SqlitePool,
    date: &str,
) -> Result<Vec<StatsDailyRow>, DbError> {
    let rows = sqlx::query(
        r#"
SELECT date, api_key_id, request_success, request_failed,
       input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
       cost_in_usd, cost_out_usd, cost_total_usd, wait_time_ms, updated_at_ms
FROM stats_daily
WHERE date = ?
ORDER BY api_key_id ASC
"#,
    )
    .bind(date)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(row_to_stats_daily_sqlite).collect())
}

async fn list_stats_daily_by_date_postgres(
    pool: &PgPool,
    date: &str,
) -> Result<Vec<StatsDailyRow>, DbError> {
    let rows = sqlx::query(
        r#"
SELECT date, api_key_id, request_success, request_failed,
       input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
       cost_in_usd, cost_out_usd, cost_total_usd, wait_time_ms, updated_at_ms
FROM stats_daily
WHERE date = $1
ORDER BY api_key_id ASC
"#,
    )
    .bind(date)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(row_to_stats_daily_postgres).collect())
}

fn row_to_stats_daily_sqlite(row: sqlx::sqlite::SqliteRow) -> StatsDailyRow {
    StatsDailyRow {
        date: row.get::<String, _>("date"),
        api_key_id: row.get::<i64, _>("api_key_id"),
        request_success: row.get::<i64, _>("request_success"),
        request_failed: row.get::<i64, _>("request_failed"),
        input_tokens: row.get::<i64, _>("input_tokens"),
        output_tokens: row.get::<i64, _>("output_tokens"),
        cache_read_input_tokens: row.get::<i64, _>("cache_read_input_tokens"),
        cache_creation_input_tokens: row.get::<i64, _>("cache_creation_input_tokens"),
        cost_in_usd: row.get::<String, _>("cost_in_usd"),
        cost_out_usd: row.get::<String, _>("cost_out_usd"),
        cost_total_usd: row.get::<String, _>("cost_total_usd"),
        wait_time_ms: row.get::<i64, _>("wait_time_ms"),
        updated_at_ms: row.get::<i64, _>("updated_at_ms"),
    }
}

fn row_to_stats_daily_postgres(row: sqlx::postgres::PgRow) -> StatsDailyRow {
    StatsDailyRow {
        date: row.get::<String, _>("date"),
        api_key_id: row.get::<i64, _>("api_key_id"),
        request_success: row.get::<i64, _>("request_success"),
        request_failed: row.get::<i64, _>("request_failed"),
        input_tokens: row.get::<i64, _>("input_tokens"),
        output_tokens: row.get::<i64, _>("output_tokens"),
        cache_read_input_tokens: row.get::<i64, _>("cache_read_input_tokens"),
        cache_creation_input_tokens: row.get::<i64, _>("cache_creation_input_tokens"),
        cost_in_usd: row.get::<String, _>("cost_in_usd"),
        cost_out_usd: row.get::<String, _>("cost_out_usd"),
        cost_total_usd: row.get::<String, _>("cost_total_usd"),
        wait_time_ms: row.get::<i64, _>("wait_time_ms"),
        updated_at_ms: row.get::<i64, _>("updated_at_ms"),
    }
}

async fn upsert_stats_daily_sqlite(
    pool: &SqlitePool,
    rows: &[StatsDailyRow],
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    for r in rows {
        sqlx::query(
            r#"
INSERT INTO stats_daily (
  date, api_key_id,
  request_success, request_failed,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  cost_in_usd, cost_out_usd, cost_total_usd,
  wait_time_ms, updated_at_ms
) VALUES (
  ?, ?,
  ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?
)
ON CONFLICT(date, api_key_id) DO UPDATE SET
  request_success = excluded.request_success,
  request_failed = excluded.request_failed,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  cache_read_input_tokens = excluded.cache_read_input_tokens,
  cache_creation_input_tokens = excluded.cache_creation_input_tokens,
  cost_in_usd = excluded.cost_in_usd,
  cost_out_usd = excluded.cost_out_usd,
  cost_total_usd = excluded.cost_total_usd,
  wait_time_ms = excluded.wait_time_ms,
  updated_at_ms = excluded.updated_at_ms
"#,
        )
        .bind(&r.date)
        .bind(r.api_key_id)
        .bind(r.request_success)
        .bind(r.request_failed)
        .bind(r.input_tokens)
        .bind(r.output_tokens)
        .bind(r.cache_read_input_tokens)
        .bind(r.cache_creation_input_tokens)
        .bind(&r.cost_in_usd)
        .bind(&r.cost_out_usd)
        .bind(&r.cost_total_usd)
        .bind(r.wait_time_ms)
        .bind(r.updated_at_ms)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn upsert_stats_daily_postgres(pool: &PgPool, rows: &[StatsDailyRow]) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    for r in rows {
        sqlx::query(
            r#"
INSERT INTO stats_daily (
  date, api_key_id,
  request_success, request_failed,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  cost_in_usd, cost_out_usd, cost_total_usd,
  wait_time_ms, updated_at_ms
) VALUES (
  $1, $2,
  $3, $4,
  $5, $6, $7, $8,
  $9, $10, $11,
  $12, $13
)
ON CONFLICT(date, api_key_id) DO UPDATE SET
  request_success = EXCLUDED.request_success,
  request_failed = EXCLUDED.request_failed,
  input_tokens = EXCLUDED.input_tokens,
  output_tokens = EXCLUDED.output_tokens,
  cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
  cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
  cost_in_usd = EXCLUDED.cost_in_usd,
  cost_out_usd = EXCLUDED.cost_out_usd,
  cost_total_usd = EXCLUDED.cost_total_usd,
  wait_time_ms = EXCLUDED.wait_time_ms,
  updated_at_ms = EXCLUDED.updated_at_ms
"#,
        )
        .bind(&r.date)
        .bind(r.api_key_id)
        .bind(r.request_success)
        .bind(r.request_failed)
        .bind(r.input_tokens)
        .bind(r.output_tokens)
        .bind(r.cache_read_input_tokens)
        .bind(r.cache_creation_input_tokens)
        .bind(&r.cost_in_usd)
        .bind(&r.cost_out_usd)
        .bind(&r.cost_total_usd)
        .bind(r.wait_time_ms)
        .bind(r.updated_at_ms)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn list_stats_daily_range_sqlite(
    pool: &SqlitePool,
    api_key_id: i64,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<StatsDailyRow>, DbError> {
    let rows = sqlx::query(
        r#"
SELECT date, api_key_id, request_success, request_failed,
       input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
       cost_in_usd, cost_out_usd, cost_total_usd, wait_time_ms, updated_at_ms
FROM stats_daily
WHERE api_key_id = ?
  AND date >= ?
  AND date <= ?
ORDER BY date ASC
"#,
    )
    .bind(api_key_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(row_to_stats_daily_sqlite).collect())
}

async fn list_stats_daily_range_postgres(
    pool: &PgPool,
    api_key_id: i64,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<StatsDailyRow>, DbError> {
    let rows = sqlx::query(
        r#"
SELECT date, api_key_id, request_success, request_failed,
       input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
       cost_in_usd, cost_out_usd, cost_total_usd, wait_time_ms, updated_at_ms
FROM stats_daily
WHERE api_key_id = $1
  AND date >= $2
  AND date <= $3
ORDER BY date ASC
"#,
    )
    .bind(api_key_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(row_to_stats_daily_postgres).collect())
}

async fn insert_request_logs_sqlite(
    pool: &SqlitePool,
    rows: &[RequestLogRow],
) -> Result<(), DbError> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for r in rows {
        sqlx::query(
            r#"
INSERT INTO request_logs (
  id, time_ms, api_key_id, provider_id, endpoint_id, upstream_key_id,
  api_format, model, http_status, error_type, error_message,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  cost_in_usd, cost_out_usd, cost_total_usd,
  t_stream_ms, t_first_byte_ms, t_first_token_ms, duration_ms,
  created_at_ms
) VALUES (
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?,
  ?
)
"#,
        )
        .bind(&r.id)
        .bind(r.time_ms)
        .bind(r.api_key_id)
        .bind(r.provider_id)
        .bind(r.endpoint_id)
        .bind(r.upstream_key_id)
        .bind(&r.api_format)
        .bind(&r.model)
        .bind(r.http_status)
        .bind(&r.error_type)
        .bind(&r.error_message)
        .bind(r.input_tokens)
        .bind(r.output_tokens)
        .bind(r.cache_read_input_tokens)
        .bind(r.cache_creation_input_tokens)
        .bind(&r.cost_in_usd)
        .bind(&r.cost_out_usd)
        .bind(&r.cost_total_usd)
        .bind(r.t_stream_ms)
        .bind(r.t_first_byte_ms)
        .bind(r.t_first_token_ms)
        .bind(r.duration_ms)
        .bind(r.created_at_ms)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn insert_request_logs_postgres(
    pool: &PgPool,
    rows: &[RequestLogRow],
) -> Result<(), DbError> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for r in rows {
        sqlx::query(
            r#"
INSERT INTO request_logs (
  id, time_ms, api_key_id, provider_id, endpoint_id, upstream_key_id,
  api_format, model, http_status, error_type, error_message,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  cost_in_usd, cost_out_usd, cost_total_usd,
  t_stream_ms, t_first_byte_ms, t_first_token_ms, duration_ms,
  created_at_ms
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9, $10, $11,
  $12, $13, $14, $15,
  $16, $17, $18,
  $19, $20, $21, $22,
  $23
)
"#,
        )
        .bind(&r.id)
        .bind(r.time_ms)
        .bind(r.api_key_id)
        .bind(r.provider_id)
        .bind(r.endpoint_id)
        .bind(r.upstream_key_id)
        .bind(&r.api_format)
        .bind(&r.model)
        .bind(r.http_status)
        .bind(&r.error_type)
        .bind(&r.error_message)
        .bind(r.input_tokens)
        .bind(r.output_tokens)
        .bind(r.cache_read_input_tokens)
        .bind(r.cache_creation_input_tokens)
        .bind(&r.cost_in_usd)
        .bind(&r.cost_out_usd)
        .bind(&r.cost_total_usd)
        .bind(r.t_stream_ms)
        .bind(r.t_first_byte_ms)
        .bind(r.t_first_token_ms)
        .bind(r.duration_ms)
        .bind(r.created_at_ms)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn list_request_logs_before_sqlite(
    pool: &SqlitePool,
    cutoff_time_ms: i64,
    limit: i64,
) -> Result<Vec<RequestLogRow>, DbError> {
    let rows = sqlx::query(
        r#"
SELECT
  id, time_ms, api_key_id, provider_id, endpoint_id, upstream_key_id,
  api_format, model, http_status, error_type, error_message,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  cost_in_usd, cost_out_usd, cost_total_usd,
  t_stream_ms, t_first_byte_ms, t_first_token_ms, duration_ms,
  created_at_ms
	FROM request_logs
	WHERE time_ms < ?
	ORDER BY time_ms ASC, id ASC
	LIMIT ?
	"#,
    )
    .bind(cutoff_time_ms)
    .bind(limit.max(1))
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(row_to_request_log_sqlite).collect())
}

async fn delete_request_logs_before_sqlite(
    pool: &SqlitePool,
    cutoff_time_ms: i64,
    limit: i64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        r#"
	DELETE FROM request_logs
	WHERE id IN (
	  SELECT id FROM request_logs
	  WHERE time_ms < ?
	  ORDER BY time_ms ASC, id ASC
	  LIMIT ?
	)
	"#,
    )
    .bind(cutoff_time_ms)
    .bind(limit.max(1))
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

async fn list_request_logs_before_postgres(
    pool: &PgPool,
    cutoff_time_ms: i64,
    limit: i64,
) -> Result<Vec<RequestLogRow>, DbError> {
    let rows = sqlx::query(
        r#"
SELECT
  id, time_ms, api_key_id, provider_id, endpoint_id, upstream_key_id,
  api_format, model, http_status, error_type, error_message,
  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  cost_in_usd, cost_out_usd, cost_total_usd,
  t_stream_ms, t_first_byte_ms, t_first_token_ms, duration_ms,
  created_at_ms
	FROM request_logs
	WHERE time_ms < $1
	ORDER BY time_ms ASC, id ASC
	LIMIT $2
	"#,
    )
    .bind(cutoff_time_ms)
    .bind(limit.max(1))
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(row_to_request_log_postgres).collect())
}

async fn delete_request_logs_before_postgres(
    pool: &PgPool,
    cutoff_time_ms: i64,
    limit: i64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        r#"
	DELETE FROM request_logs
	WHERE id IN (
	  SELECT id FROM request_logs
	  WHERE time_ms < $1
	  ORDER BY time_ms ASC, id ASC
	  LIMIT $2
	)
	"#,
    )
    .bind(cutoff_time_ms)
    .bind(limit.max(1))
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

async fn delete_stats_daily_before_sqlite(
    pool: &SqlitePool,
    cutoff_date: &str,
    limit: i64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        r#"
DELETE FROM stats_daily
WHERE rowid IN (
  SELECT rowid FROM stats_daily
  WHERE date < ?
  ORDER BY date ASC, api_key_id ASC
  LIMIT ?
)
"#,
    )
    .bind(cutoff_date)
    .bind(limit.max(1))
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

async fn delete_stats_daily_before_postgres(
    pool: &PgPool,
    cutoff_date: &str,
    limit: i64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        r#"
DELETE FROM stats_daily
WHERE (date, api_key_id) IN (
  SELECT date, api_key_id FROM stats_daily
  WHERE date < $1
  ORDER BY date ASC, api_key_id ASC
  LIMIT $2
)
"#,
    )
    .bind(cutoff_date)
    .bind(limit.max(1))
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

async fn list_request_logs_sqlite(
    pool: &SqlitePool,
    offset: i64,
    limit: i64,
    filter: &RequestLogFilter,
) -> Result<Vec<RequestLogRow>, DbError> {
    let mut qb = QueryBuilder::<Sqlite>::new(
        r#"
SELECT
  request_logs.id, request_logs.time_ms, request_logs.api_key_id, request_logs.provider_id, request_logs.endpoint_id, request_logs.upstream_key_id,
  request_logs.api_format, request_logs.model, request_logs.http_status, request_logs.error_type, request_logs.error_message,
  request_logs.input_tokens, request_logs.output_tokens, request_logs.cache_read_input_tokens, request_logs.cache_creation_input_tokens,
  request_logs.cost_in_usd, request_logs.cost_out_usd, request_logs.cost_total_usd,
  request_logs.t_stream_ms, request_logs.t_first_byte_ms, request_logs.t_first_token_ms, request_logs.duration_ms,
  request_logs.created_at_ms
FROM request_logs
"#,
    );
    append_request_logs_joins_sqlite(&mut qb, filter);
    append_request_logs_filters_sqlite(&mut qb, filter);
    qb.push(" ORDER BY request_logs.time_ms DESC LIMIT ");
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    let rows = qb.build().fetch_all(pool).await?;
    Ok(rows.into_iter().map(row_to_request_log_sqlite).collect())
}

async fn list_request_logs_postgres(
    pool: &PgPool,
    offset: i64,
    limit: i64,
    filter: &RequestLogFilter,
) -> Result<Vec<RequestLogRow>, DbError> {
    let mut qb = QueryBuilder::<Postgres>::new(
        r#"
SELECT
  request_logs.id, request_logs.time_ms, request_logs.api_key_id, request_logs.provider_id, request_logs.endpoint_id, request_logs.upstream_key_id,
  request_logs.api_format, request_logs.model, request_logs.http_status, request_logs.error_type, request_logs.error_message,
  request_logs.input_tokens, request_logs.output_tokens, request_logs.cache_read_input_tokens, request_logs.cache_creation_input_tokens,
  request_logs.cost_in_usd, request_logs.cost_out_usd, request_logs.cost_total_usd,
  request_logs.t_stream_ms, request_logs.t_first_byte_ms, request_logs.t_first_token_ms, request_logs.duration_ms,
  request_logs.created_at_ms
FROM request_logs
"#,
    );
    append_request_logs_joins_postgres(&mut qb, filter);
    append_request_logs_filters_postgres(&mut qb, filter);
    qb.push(" ORDER BY request_logs.time_ms DESC LIMIT ");
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    let rows = qb.build().fetch_all(pool).await?;
    Ok(rows.into_iter().map(row_to_request_log_postgres).collect())
}

fn append_request_logs_joins_sqlite(qb: &mut QueryBuilder<'_, Sqlite>, filter: &RequestLogFilter) {
    if filter.api_key_log_enabled.is_some() {
        qb.push(" JOIN api_keys ak ON ak.id = request_logs.api_key_id");
    }
}

fn append_request_logs_filters_sqlite(
    qb: &mut QueryBuilder<'_, Sqlite>,
    filter: &RequestLogFilter,
) {
    let mut has_where = false;

    if let Some(model) = filter
        .model
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("model LIKE ");
        qb.push_bind(format!("%{model}%"));
    }
    if let Some(provider_id) = filter.provider_id {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("provider_id = ");
        qb.push_bind(provider_id);
    }
    if let Some(endpoint_id) = filter.endpoint_id {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("endpoint_id = ");
        qb.push_bind(endpoint_id);
    }
    if let Some(upstream_key_id) = filter.upstream_key_id {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("upstream_key_id = ");
        qb.push_bind(upstream_key_id);
    }
    if let Some(api_key_id) = filter.api_key_id {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("api_key_id = ");
        qb.push_bind(api_key_id);
    }
    if let Some(api_key_log_enabled) = filter.api_key_log_enabled {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("ak.log_enabled = ");
        qb.push_bind(if api_key_log_enabled { 1_i64 } else { 0_i64 });
    }
    if let Some(api_format) = filter
        .api_format
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("api_format = ");
        qb.push_bind(api_format);
    }
    if let Some(error_type) = filter
        .error_type
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("error_type LIKE ");
        qb.push_bind(format!("%{error_type}%"));
    }
    if let Some(status_class) = filter.status_class {
        let start = (status_class as i64) * 100;
        let end = start + 100;
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("http_status >= ");
        qb.push_bind(start);
        qb.push(" AND http_status < ");
        qb.push_bind(end);
    }
    if let Some(time_from_ms) = filter.time_from_ms {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("time_ms >= ");
        qb.push_bind(time_from_ms);
    }
    if let Some(time_to_ms) = filter.time_to_ms {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("time_ms <= ");
        qb.push_bind(time_to_ms);
    }
    if let Some(duration_ms_min) = filter.duration_ms_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("duration_ms >= ");
        qb.push_bind(duration_ms_min);
    }
    if let Some(duration_ms_max) = filter.duration_ms_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("duration_ms <= ");
        qb.push_bind(duration_ms_max);
    }
    if let Some(total_tokens_min) = filter.total_tokens_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens) >= ");
        qb.push_bind(total_tokens_min);
    }
    if let Some(total_tokens_max) = filter.total_tokens_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens) <= ");
        qb.push_bind(total_tokens_max);
    }
    if let Some(cost_total_min) = filter.cost_total_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("CAST(cost_total_usd AS REAL) >= ");
        qb.push_bind(cost_total_min);
    }
    if let Some(cost_total_max) = filter.cost_total_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("CAST(cost_total_usd AS REAL) <= ");
        qb.push_bind(cost_total_max);
    }
    if let Some(cache_read_input_tokens_min) = filter.cache_read_input_tokens_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("cache_read_input_tokens >= ");
        qb.push_bind(cache_read_input_tokens_min);
    }
    if let Some(cache_read_input_tokens_max) = filter.cache_read_input_tokens_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("cache_read_input_tokens <= ");
        qb.push_bind(cache_read_input_tokens_max);
    }
    if let Some(cache_creation_input_tokens_min) = filter.cache_creation_input_tokens_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("cache_creation_input_tokens >= ");
        qb.push_bind(cache_creation_input_tokens_min);
    }
    if let Some(cache_creation_input_tokens_max) = filter.cache_creation_input_tokens_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        qb.push("cache_creation_input_tokens <= ");
        qb.push_bind(cache_creation_input_tokens_max);
    }
}

fn append_request_logs_joins_postgres(
    qb: &mut QueryBuilder<'_, Postgres>,
    filter: &RequestLogFilter,
) {
    if filter.api_key_log_enabled.is_some() {
        qb.push(" JOIN api_keys ak ON ak.id = request_logs.api_key_id");
    }
}

fn append_request_logs_filters_postgres(
    qb: &mut QueryBuilder<'_, Postgres>,
    filter: &RequestLogFilter,
) {
    let mut has_where = false;

    if let Some(model) = filter
        .model
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("model ILIKE ");
        qb.push_bind(format!("%{model}%"));
    }
    if let Some(provider_id) = filter.provider_id {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("provider_id = ");
        qb.push_bind(provider_id);
    }
    if let Some(endpoint_id) = filter.endpoint_id {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("endpoint_id = ");
        qb.push_bind(endpoint_id);
    }
    if let Some(upstream_key_id) = filter.upstream_key_id {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("upstream_key_id = ");
        qb.push_bind(upstream_key_id);
    }
    if let Some(api_key_id) = filter.api_key_id {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("api_key_id = ");
        qb.push_bind(api_key_id);
    }
    if let Some(api_key_log_enabled) = filter.api_key_log_enabled {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("ak.log_enabled = ");
        qb.push_bind(api_key_log_enabled);
    }
    if let Some(api_format) = filter
        .api_format
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("api_format = ");
        qb.push_bind(api_format);
    }
    if let Some(error_type) = filter
        .error_type
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("error_type ILIKE ");
        qb.push_bind(format!("%{error_type}%"));
    }
    if let Some(status_class) = filter.status_class {
        let start = (status_class as i64) * 100;
        let end = start + 100;
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("http_status >= ");
        qb.push_bind(start);
        qb.push(" AND http_status < ");
        qb.push_bind(end);
    }
    if let Some(time_from_ms) = filter.time_from_ms {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("time_ms >= ");
        qb.push_bind(time_from_ms);
    }
    if let Some(time_to_ms) = filter.time_to_ms {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("time_ms <= ");
        qb.push_bind(time_to_ms);
    }
    if let Some(duration_ms_min) = filter.duration_ms_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("duration_ms >= ");
        qb.push_bind(duration_ms_min);
    }
    if let Some(duration_ms_max) = filter.duration_ms_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("duration_ms <= ");
        qb.push_bind(duration_ms_max);
    }
    if let Some(total_tokens_min) = filter.total_tokens_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens) >= ");
        qb.push_bind(total_tokens_min);
    }
    if let Some(total_tokens_max) = filter.total_tokens_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens) <= ");
        qb.push_bind(total_tokens_max);
    }
    if let Some(cost_total_min) = filter.cost_total_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("CAST(cost_total_usd AS DOUBLE PRECISION) >= ");
        qb.push_bind(cost_total_min);
    }
    if let Some(cost_total_max) = filter.cost_total_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("CAST(cost_total_usd AS DOUBLE PRECISION) <= ");
        qb.push_bind(cost_total_max);
    }
    if let Some(cache_read_input_tokens_min) = filter.cache_read_input_tokens_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("cache_read_input_tokens >= ");
        qb.push_bind(cache_read_input_tokens_min);
    }
    if let Some(cache_read_input_tokens_max) = filter.cache_read_input_tokens_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("cache_read_input_tokens <= ");
        qb.push_bind(cache_read_input_tokens_max);
    }
    if let Some(cache_creation_input_tokens_min) = filter.cache_creation_input_tokens_min {
        qb.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        qb.push("cache_creation_input_tokens >= ");
        qb.push_bind(cache_creation_input_tokens_min);
    }
    if let Some(cache_creation_input_tokens_max) = filter.cache_creation_input_tokens_max {
        qb.push(if has_where { " AND " } else { " WHERE " });
        qb.push("cache_creation_input_tokens <= ");
        qb.push_bind(cache_creation_input_tokens_max);
    }
}

fn row_to_request_log_sqlite(row: sqlx::sqlite::SqliteRow) -> RequestLogRow {
    RequestLogRow {
        id: row.get::<String, _>("id"),
        time_ms: row.get::<i64, _>("time_ms"),
        api_key_id: row.get::<i64, _>("api_key_id"),
        provider_id: row.get::<Option<i64>, _>("provider_id"),
        endpoint_id: row.get::<Option<i64>, _>("endpoint_id"),
        upstream_key_id: row.get::<Option<i64>, _>("upstream_key_id"),
        api_format: row.get::<String, _>("api_format"),
        model: row.get::<Option<String>, _>("model"),
        http_status: row.get::<Option<i32>, _>("http_status"),
        error_type: row.get::<Option<String>, _>("error_type"),
        error_message: row.get::<Option<String>, _>("error_message"),
        input_tokens: row.get::<i64, _>("input_tokens"),
        output_tokens: row.get::<i64, _>("output_tokens"),
        cache_read_input_tokens: row.get::<i64, _>("cache_read_input_tokens"),
        cache_creation_input_tokens: row.get::<i64, _>("cache_creation_input_tokens"),
        cost_in_usd: row.get::<String, _>("cost_in_usd"),
        cost_out_usd: row.get::<String, _>("cost_out_usd"),
        cost_total_usd: row.get::<String, _>("cost_total_usd"),
        t_stream_ms: row.get::<Option<i64>, _>("t_stream_ms"),
        t_first_byte_ms: row.get::<Option<i64>, _>("t_first_byte_ms"),
        t_first_token_ms: row.get::<Option<i64>, _>("t_first_token_ms"),
        duration_ms: row.get::<Option<i64>, _>("duration_ms"),
        created_at_ms: row.get::<i64, _>("created_at_ms"),
    }
}

fn row_to_request_log_postgres(row: sqlx::postgres::PgRow) -> RequestLogRow {
    RequestLogRow {
        id: row.get::<String, _>("id"),
        time_ms: row.get::<i64, _>("time_ms"),
        api_key_id: row.get::<i64, _>("api_key_id"),
        provider_id: row.get::<Option<i64>, _>("provider_id"),
        endpoint_id: row.get::<Option<i64>, _>("endpoint_id"),
        upstream_key_id: row.get::<Option<i64>, _>("upstream_key_id"),
        api_format: row.get::<String, _>("api_format"),
        model: row.get::<Option<String>, _>("model"),
        http_status: row.get::<Option<i32>, _>("http_status"),
        error_type: row.get::<Option<String>, _>("error_type"),
        error_message: row.get::<Option<String>, _>("error_message"),
        input_tokens: row.get::<i64, _>("input_tokens"),
        output_tokens: row.get::<i64, _>("output_tokens"),
        cache_read_input_tokens: row.get::<i64, _>("cache_read_input_tokens"),
        cache_creation_input_tokens: row.get::<i64, _>("cache_creation_input_tokens"),
        cost_in_usd: row.get::<String, _>("cost_in_usd"),
        cost_out_usd: row.get::<String, _>("cost_out_usd"),
        cost_total_usd: row.get::<String, _>("cost_total_usd"),
        t_stream_ms: row.get::<Option<i64>, _>("t_stream_ms"),
        t_first_byte_ms: row.get::<Option<i64>, _>("t_first_byte_ms"),
        t_first_token_ms: row.get::<Option<i64>, _>("t_first_token_ms"),
        duration_ms: row.get::<Option<i64>, _>("duration_ms"),
        created_at_ms: row.get::<i64, _>("created_at_ms"),
    }
}

// NOTE: we intentionally avoid an "aggregate all" query based on request logs for KPIs.
// `request_logs` is optional per API key, while `stats_daily` always reflects all traffic.

async fn list_usage_breakdown_sqlite(
    pool: &SqlitePool,
    by: UsageBreakdownBy,
    time_from_ms: i64,
    time_to_ms: i64,
    limit: i64,
) -> Result<Vec<UsageBreakdownRow>, DbError> {
    let safe_limit = limit.clamp(1, 100);
    let group_expr = match by {
        UsageBreakdownBy::Model => "COALESCE(model, 'unknown')",
        UsageBreakdownBy::ApiKey => "CAST(api_key_id AS TEXT)",
    };

    let sql = format!(
        r#"
SELECT
  {group_expr} AS item_key,
  COUNT(*) AS requests,
  SUM(CASE WHEN http_status >= 400 OR error_type IS NOT NULL THEN 1 ELSE 0 END) AS failed,
  SUM(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens) AS tokens,
  COALESCE(SUM(CAST(cost_total_usd AS REAL)), 0) AS cost_total
FROM request_logs
WHERE time_ms >= ? AND time_ms <= ?
GROUP BY {group_expr}
ORDER BY cost_total DESC, requests DESC
LIMIT ?
"#
    );

    let rows = sqlx::query(&sql)
        .bind(time_from_ms)
        .bind(time_to_ms)
        .bind(safe_limit)
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| UsageBreakdownRow {
            key: row.get::<String, _>("item_key"),
            requests: row.get::<i64, _>("requests"),
            failed: row.get::<Option<i64>, _>("failed").unwrap_or(0),
            tokens: row.get::<Option<i64>, _>("tokens").unwrap_or(0),
            cost_total_usd: format!(
                "{:.15}",
                row.get::<Option<f64>, _>("cost_total").unwrap_or(0.0)
            ),
        })
        .collect())
}

async fn list_usage_breakdown_postgres(
    pool: &PgPool,
    by: UsageBreakdownBy,
    time_from_ms: i64,
    time_to_ms: i64,
    limit: i64,
) -> Result<Vec<UsageBreakdownRow>, DbError> {
    let safe_limit = limit.clamp(1, 100);
    let group_expr = match by {
        UsageBreakdownBy::Model => "COALESCE(model, 'unknown')",
        UsageBreakdownBy::ApiKey => "CAST(api_key_id AS TEXT)",
    };

    let sql = format!(
        r#"
SELECT
  {group_expr} AS item_key,
  COUNT(*)::BIGINT AS requests,
  SUM(CASE WHEN http_status >= 400 OR error_type IS NOT NULL THEN 1 ELSE 0 END)::BIGINT AS failed,
  SUM(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens)::BIGINT AS tokens,
  COALESCE(SUM(CAST(cost_total_usd AS DOUBLE PRECISION)), 0)::DOUBLE PRECISION AS cost_total
FROM request_logs
WHERE time_ms >= $1 AND time_ms <= $2
GROUP BY {group_expr}
ORDER BY cost_total DESC, requests DESC
LIMIT $3
"#
    );

    let rows = sqlx::query(&sql)
        .bind(time_from_ms)
        .bind(time_to_ms)
        .bind(safe_limit)
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| UsageBreakdownRow {
            key: row.get::<String, _>("item_key"),
            requests: row.get::<i64, _>("requests"),
            failed: row.get::<Option<i64>, _>("failed").unwrap_or(0),
            tokens: row.get::<Option<i64>, _>("tokens").unwrap_or(0),
            cost_total_usd: format!(
                "{:.15}",
                row.get::<Option<f64>, _>("cost_total").unwrap_or(0.0)
            ),
        })
        .collect())
}

async fn migrate_sqlite(pool: &SqlitePool) -> Result<(), DbError> {
    // Core tables
    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  expires_at_ms INTEGER,
  log_enabled INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS upstream_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  weight INTEGER NOT NULL,
  supports_include_usage INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS upstream_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  weight INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_upstream_endpoints_provider ON upstream_endpoints(provider_id);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS upstream_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  weight INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_upstream_keys_provider ON upstream_keys(provider_id);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS model_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_route_providers (
  route_id INTEGER NOT NULL,
  provider_id INTEGER NOT NULL,
  PRIMARY KEY(route_id, provider_id),
  FOREIGN KEY(route_id) REFERENCES model_routes(id) ON DELETE CASCADE,
  FOREIGN KEY(provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_model_route_providers_route ON model_route_providers(route_id);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS model_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER,
  model_name TEXT NOT NULL,
  price_data_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_model_prices_model_created ON model_prices(model_name, created_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_model_prices_provider_model_created ON model_prices(provider_id, model_name, created_at_ms DESC, id DESC);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS stats_daily (
  date TEXT NOT NULL,
  api_key_id INTEGER NOT NULL,
  request_success INTEGER NOT NULL,
  request_failed INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cost_in_usd TEXT NOT NULL,
  cost_out_usd TEXT NOT NULL,
  cost_total_usd TEXT NOT NULL,
  wait_time_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(date, api_key_id)
);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  time_ms INTEGER NOT NULL,
  api_key_id INTEGER NOT NULL,
  provider_id INTEGER,
  endpoint_id INTEGER,
  upstream_key_id INTEGER,
  api_format TEXT NOT NULL,
  model TEXT,
  http_status INTEGER,
  error_type TEXT,
  error_message TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cost_in_usd TEXT NOT NULL,
  cost_out_usd TEXT NOT NULL,
  cost_total_usd TEXT NOT NULL,
  t_stream_ms INTEGER,
  t_first_byte_ms INTEGER,
  t_first_token_ms INTEGER,
  duration_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs(time_ms DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key_time ON request_logs(api_key_id, time_ms DESC);
"#,
    )
    .execute(pool)
    .await?;

    ensure_sqlite_model_prices_provider_scope(pool).await?;
    Ok(())
}

async fn migrate_postgres(pool: &PgPool) -> Result<(), DbError> {
    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  expires_at_ms BIGINT,
  log_enabled BOOLEAN NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS upstream_providers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  priority INTEGER NOT NULL,
  weight INTEGER NOT NULL,
  supports_include_usage BOOLEAN NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS upstream_endpoints (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES upstream_providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  priority INTEGER NOT NULL,
  weight INTEGER NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upstream_endpoints_provider ON upstream_endpoints(provider_id);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS upstream_keys (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES upstream_providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  priority INTEGER NOT NULL,
  weight INTEGER NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upstream_keys_provider ON upstream_keys(provider_id);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS model_routes (
  id BIGSERIAL PRIMARY KEY,
  model_name TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_route_providers (
  route_id BIGINT NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
  provider_id BIGINT NOT NULL REFERENCES upstream_providers(id) ON DELETE CASCADE,
  PRIMARY KEY(route_id, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_model_route_providers_route ON model_route_providers(route_id);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS model_prices (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT REFERENCES upstream_providers(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  price_data_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_prices_model_created ON model_prices(model_name, created_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_model_prices_provider_model_created ON model_prices(provider_id, model_name, created_at_ms DESC, id DESC);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS stats_daily (
  date TEXT NOT NULL,
  api_key_id BIGINT NOT NULL,
  request_success BIGINT NOT NULL,
  request_failed BIGINT NOT NULL,
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cache_read_input_tokens BIGINT NOT NULL,
  cache_creation_input_tokens BIGINT NOT NULL,
  cost_in_usd TEXT NOT NULL,
  cost_out_usd TEXT NOT NULL,
  cost_total_usd TEXT NOT NULL,
  wait_time_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY(date, api_key_id)
);
"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  time_ms BIGINT NOT NULL,
  api_key_id BIGINT NOT NULL,
  provider_id BIGINT,
  endpoint_id BIGINT,
  upstream_key_id BIGINT,
  api_format TEXT NOT NULL,
  model TEXT,
  http_status INTEGER,
  error_type TEXT,
  error_message TEXT,
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cache_read_input_tokens BIGINT NOT NULL,
  cache_creation_input_tokens BIGINT NOT NULL,
  cost_in_usd TEXT NOT NULL,
  cost_out_usd TEXT NOT NULL,
  cost_total_usd TEXT NOT NULL,
  t_stream_ms BIGINT,
  t_first_byte_ms BIGINT,
  t_first_token_ms BIGINT,
  duration_ms BIGINT,
  created_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs(time_ms DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key_time ON request_logs(api_key_id, time_ms DESC);
"#,
    )
    .execute(pool)
    .await?;

    ensure_postgres_model_prices_provider_scope(pool).await?;
    Ok(())
}

async fn sqlite_column_exists(
    pool: &SqlitePool,
    table_name: &str,
    column_name: &str,
) -> Result<bool, DbError> {
    let query = format!("PRAGMA table_info({table_name})");
    let rows = sqlx::query(&query).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .any(|row| row.get::<String, _>("name") == column_name))
}

async fn ensure_sqlite_model_prices_provider_scope(pool: &SqlitePool) -> Result<(), DbError> {
    if !sqlite_column_exists(pool, "model_prices", "provider_id").await? {
        sqlx::query("ALTER TABLE model_prices ADD COLUMN provider_id INTEGER")
            .execute(pool)
            .await?;
    }
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_model_prices_provider_model_created ON model_prices(provider_id, model_name, created_at_ms DESC, id DESC)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_postgres_model_prices_provider_scope(pool: &PgPool) -> Result<(), DbError> {
    sqlx::query("ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS provider_id BIGINT")
        .execute(pool)
        .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_model_prices_provider_model_created ON model_prices(provider_id, model_name, created_at_ms DESC, id DESC)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn list_model_routes_sqlite(pool: &SqlitePool) -> Result<Vec<ModelRoute>, DbError> {
    let routes_rows = sqlx::query(
        r#"
SELECT id, model_name, enabled
FROM model_routes
ORDER BY model_name ASC
"#,
    )
    .fetch_all(pool)
    .await?;

    let mapping_rows = sqlx::query(
        r#"
SELECT route_id, provider_id
FROM model_route_providers
"#,
    )
    .fetch_all(pool)
    .await?;

    let mut provider_ids_by_route: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in mapping_rows {
        provider_ids_by_route
            .entry(row.get::<i64, _>("route_id"))
            .or_default()
            .push(row.get::<i64, _>("provider_id"));
    }

    Ok(routes_rows
        .into_iter()
        .map(|row| {
            let id = row.get::<i64, _>("id");
            ModelRoute {
                id,
                model_name: row.get::<String, _>("model_name"),
                enabled: row.get::<i64, _>("enabled") != 0,
                provider_ids: provider_ids_by_route.remove(&id).unwrap_or_default(),
            }
        })
        .collect())
}

async fn list_model_routes_postgres(pool: &PgPool) -> Result<Vec<ModelRoute>, DbError> {
    let routes_rows = sqlx::query(
        r#"
SELECT id, model_name, enabled
FROM model_routes
ORDER BY model_name ASC
"#,
    )
    .fetch_all(pool)
    .await?;

    let mapping_rows = sqlx::query(
        r#"
SELECT route_id, provider_id
FROM model_route_providers
"#,
    )
    .fetch_all(pool)
    .await?;

    let mut provider_ids_by_route: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in mapping_rows {
        provider_ids_by_route
            .entry(row.get::<i64, _>("route_id"))
            .or_default()
            .push(row.get::<i64, _>("provider_id"));
    }

    Ok(routes_rows
        .into_iter()
        .map(|row| {
            let id = row.get::<i64, _>("id");
            ModelRoute {
                id,
                model_name: row.get::<String, _>("model_name"),
                enabled: row.get::<bool, _>("enabled"),
                provider_ids: provider_ids_by_route.remove(&id).unwrap_or_default(),
            }
        })
        .collect())
}

async fn list_latest_model_prices_sqlite(pool: &SqlitePool) -> Result<Vec<ModelPrice>, DbError> {
    let rows = sqlx::query(
        r#"
SELECT id, provider_id, model_name, price_data_json, created_at_ms, updated_at_ms
FROM model_prices
ORDER BY (provider_id IS NOT NULL) ASC, provider_id ASC, model_name ASC, created_at_ms DESC, id DESC
"#,
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::new();
    let mut seen: HashMap<(Option<i64>, String), ()> = HashMap::new();

    for row in rows {
        let provider_id = row.get::<Option<i64>, _>("provider_id");
        let model_name = row.get::<String, _>("model_name");
        let dedupe_key = (provider_id, model_name.clone());
        if seen.contains_key(&dedupe_key) {
            continue;
        }
        seen.insert(dedupe_key, ());

        let price_data_json = row.get::<String, _>("price_data_json");
        let price = parse_model_price_data(&price_data_json)?;

        out.push(ModelPrice {
            id: row.get::<i64, _>("id"),
            provider_id,
            model_name,
            price_data_json,
            price,
            created_at_ms: row.get::<i64, _>("created_at_ms"),
            updated_at_ms: row.get::<i64, _>("updated_at_ms"),
        });
    }

    Ok(out)
}

async fn list_latest_model_prices_postgres(pool: &PgPool) -> Result<Vec<ModelPrice>, DbError> {
    let rows = sqlx::query(
        r#"
SELECT id, provider_id, model_name, price_data_json, created_at_ms, updated_at_ms
FROM model_prices
ORDER BY (provider_id IS NOT NULL) ASC, provider_id ASC, model_name ASC, created_at_ms DESC, id DESC
"#,
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::new();
    let mut seen: HashMap<(Option<i64>, String), ()> = HashMap::new();

    for row in rows {
        let provider_id = row.get::<Option<i64>, _>("provider_id");
        let model_name = row.get::<String, _>("model_name");
        let dedupe_key = (provider_id, model_name.clone());
        if seen.contains_key(&dedupe_key) {
            continue;
        }
        seen.insert(dedupe_key, ());

        let price_data_json = row.get::<String, _>("price_data_json");
        let price = parse_model_price_data(&price_data_json)?;

        out.push(ModelPrice {
            id: row.get::<i64, _>("id"),
            provider_id,
            model_name,
            price_data_json,
            price,
            created_at_ms: row.get::<i64, _>("created_at_ms"),
            updated_at_ms: row.get::<i64, _>("updated_at_ms"),
        });
    }

    Ok(out)
}

fn parse_model_price_data(json: &str) -> Result<ModelPriceData, DbError> {
    let v: Value = serde_json::from_str(json)
        .map_err(|e| DbError::new(format!("invalid price_data_json: {e}")))?;
    Ok(ModelPriceData {
        input_cost_per_token: extract_decimal(v.get("input_cost_per_token")),
        output_cost_per_token: extract_decimal(v.get("output_cost_per_token")),
        cache_creation_input_token_cost: extract_decimal(v.get("cache_creation_input_token_cost")),
        cache_creation_input_token_cost_above_1hr: extract_decimal(
            v.get("cache_creation_input_token_cost_above_1hr"),
        ),
        cache_read_input_token_cost: extract_decimal(v.get("cache_read_input_token_cost")),
    })
}

fn extract_decimal(v: Option<&Value>) -> Option<Decimal> {
    let v = v?;
    match v {
        Value::Number(n) => Decimal::from_str(&n.to_string()).ok(),
        Value::String(s) => Decimal::from_str(s).ok(),
        _ => None,
    }
}
