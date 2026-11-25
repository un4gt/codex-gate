use std::collections::HashMap;
use std::str::FromStr;

use rust_decimal::Decimal;
use sqlx::Row;

use super::{Database, DbError};
use crate::api_key_usage::{ApiKeyLimit, ApiKeyUsage};
use crate::pricing::{PriceCard, PricedCost};
use crate::types::Usage;

const CREATE_USAGE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS api_key_lifetime_usage (
  api_key_id BIGINT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  observed_requests BIGINT NOT NULL DEFAULT 0,
  priced_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd TEXT
)
"#;

pub(super) fn decode_limit(value: Option<String>) -> Result<Option<ApiKeyLimit>, DbError> {
    value
        .map(|value| serde_json::from_str(&value).map_err(|error| DbError::new(error.to_string())))
        .transpose()
}

fn decode_usage(
    total_tokens: i64,
    observed_requests: i64,
    priced_tokens: i64,
    cost_usd: Option<String>,
) -> Result<ApiKeyUsage, DbError> {
    Ok(ApiKeyUsage {
        total_tokens,
        observed_requests,
        priced_tokens,
        cost_usd: cost_usd
            .map(|value| Decimal::from_str(&value).map_err(|error| DbError::new(error.to_string())))
            .transpose()?,
    })
}

macro_rules! usage_from_row {
    ($row:expr) => {
        decode_usage(
            $row.get("total_tokens"),
            $row.get("observed_requests"),
            $row.get("priced_tokens"),
            $row.get("cost_usd"),
        )
    };
}

macro_rules! with_pool {
    ($db:expr, $pool:ident, $body:block) => {
        match $db {
            Database::Sqlite($pool) => $body,
            Database::Postgres($pool) => $body,
        }
    };
}

macro_rules! backfill_usage {
    ($tx:ident) => {{
        sqlx::query(CREATE_USAGE_TABLE).execute(&mut *$tx).await?;
        let ids: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM api_keys WHERE NOT EXISTS (SELECT 1 FROM api_key_lifetime_usage WHERE api_key_id = api_keys.id)",
        )
        .fetch_all(&mut *$tx)
        .await?;
        if ids.is_empty() {
            $tx.commit().await?;
            return Ok(());
        }

        let versions = sqlx::query("SELECT id, price_data_json FROM model_prices")
            .fetch_all(&mut *$tx)
            .await?;
        let prices: HashMap<i64, PriceCard> = versions
            .into_iter()
            .filter_map(|row| {
                let raw: String = row.get("price_data_json");
                let card = PriceCard::from_json(&serde_json::from_str(&raw).ok()?).ok()?;
                Some((row.get("id"), card))
            })
            .collect();
        let hourly = sqlx::query(
            r#"
SELECT h.api_key_id, h.bucket_ms / 86400000 AS day, h.price_version_id, h.price_tier_index,
       CAST(SUM(h.input_tokens) AS BIGINT) AS input_tokens,
       CAST(SUM(h.output_tokens) AS BIGINT) AS output_tokens,
       CAST(SUM(h.cache_read_input_tokens) AS BIGINT) AS cache_read_input_tokens,
       CAST(SUM(h.cache_creation_input_tokens) AS BIGINT) AS cache_creation_input_tokens,
       CAST(SUM(h.usage_observed_requests) AS BIGINT) AS observed_requests
FROM stats_hourly h
JOIN api_keys k ON k.id = h.api_key_id
WHERE h.bucket_ms >= k.created_at_ms - k.created_at_ms % 3600000
  AND NOT EXISTS (SELECT 1 FROM api_key_lifetime_usage u WHERE u.api_key_id = k.id)
GROUP BY h.api_key_id, h.bucket_ms / 86400000, h.price_version_id, h.price_tier_index
"#,
        )
        .fetch_all(&mut *$tx)
        .await?;
        let daily = sqlx::query(
            r#"
SELECT d.*, k.created_at_ms FROM stats_daily d JOIN api_keys k ON k.id = d.api_key_id
WHERE NOT EXISTS (SELECT 1 FROM api_key_lifetime_usage u WHERE u.api_key_id = k.id)
"#,
        )
        .fetch_all(&mut *$tx)
        .await?;

        let mut lifetime = HashMap::<i64, ApiKeyUsage>::new();
        let mut days = HashMap::<(i64, String), (i64, i64)>::new();
        for row in hourly {
            let key_id = row.get::<i64, _>("api_key_id");
            let day = row.get::<i64, _>("day");
            let Some(date) = utc_date(day.saturating_mul(86_400_000)) else {
                continue;
            };
            let usage = usage_tokens!(row);
            let tokens = ApiKeyUsage::tokens(&usage);
            let observed = row.get::<i64, _>("observed_requests");
            let totals = days.entry((key_id, date)).or_default();
            totals.0 = totals.0.saturating_add(tokens);
            totals.1 = totals.1.saturating_add(observed);
            if (observed > 0 || tokens > 0)
                && let Some(card) = prices.get(&row.get::<i64, _>("price_version_id"))
                && let Some(cost) = card.cost_for_usage(&usage, row.get("price_tier_index"))
            {
                lifetime.entry(key_id).or_default().add_priced(tokens, cost);
            }
        }
        // Daily and hourly rows overlap. A day's higher total preserves legacy daily-only usage.
        for row in daily {
            let date = row.get::<String, _>("date");
            if utc_date(row.get("created_at_ms")).is_some_and(|created| date < created) {
                continue;
            }
            let totals = days.entry((row.get("api_key_id"), date)).or_default();
            totals.0 = totals.0.max(ApiKeyUsage::tokens(&usage_tokens!(row)));
            totals.1 = totals.1.max(row.get("usage_observed_requests"));
        }
        for ((key_id, _), (tokens, observed)) in days {
            let totals = lifetime.entry(key_id).or_default();
            totals.total_tokens = totals.total_tokens.saturating_add(tokens);
            totals.observed_requests = totals.observed_requests.saturating_add(observed);
        }
        for key_id in ids {
            let totals = lifetime.remove(&key_id).unwrap_or_default();
            sqlx::query(
                "INSERT INTO api_key_lifetime_usage (api_key_id, total_tokens, observed_requests, priced_tokens, cost_usd) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(api_key_id) DO NOTHING",
            )
            .bind(key_id)
            .bind(totals.total_tokens)
            .bind(totals.observed_requests)
            .bind(totals.priced_tokens)
            .bind(totals.cost_usd.map(|cost| cost.normalize().to_string()))
            .execute(&mut *$tx)
            .await?;
        }
        $tx.commit().await?;
        Ok(())
    }};
}

macro_rules! usage_tokens {
    ($row:expr) => {
        Usage {
            input_tokens: $row.get("input_tokens"),
            output_tokens: $row.get("output_tokens"),
            cache_read_input_tokens: $row.get("cache_read_input_tokens"),
            cache_creation_input_tokens: $row.get("cache_creation_input_tokens"),
            reasoning_output_tokens: 0,
        }
    };
}

fn utc_date(time_ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(time_ms).map(|date| date.format("%Y%m%d").to_string())
}

impl Database {
    pub(super) async fn migrate_api_key_usage(&self) -> Result<(), DbError> {
        match self {
            Self::Sqlite(pool) => {
                let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
                let has_limit: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM pragma_table_info('api_keys') WHERE name = 'usage_limit'",
                )
                .fetch_one(&mut *tx)
                .await?;
                if has_limit == 0 {
                    sqlx::query("ALTER TABLE api_keys ADD COLUMN usage_limit TEXT")
                        .execute(&mut *tx)
                        .await?;
                }
                backfill_usage!(tx)
            }
            Self::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                sqlx::query("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS usage_limit TEXT")
                    .execute(&mut *tx)
                    .await?;
                backfill_usage!(tx)
            }
        }
    }

    pub async fn list_api_key_usage(&self) -> Result<HashMap<i64, ApiKeyUsage>, DbError> {
        with_pool!(self, pool, {
            sqlx::query("SELECT api_key_id, total_tokens, observed_requests, priced_tokens, cost_usd FROM api_key_lifetime_usage")
                .fetch_all(pool)
                .await?
                .into_iter()
                .map(|row| Ok((row.get("api_key_id"), usage_from_row!(row)?)))
                .collect()
        })
    }

    pub async fn get_live_api_key_usage(
        &self,
        key_id: i64,
        now_ms: i64,
    ) -> Result<Option<(Option<ApiKeyLimit>, ApiKeyUsage)>, DbError> {
        with_pool!(self, pool, {
            let row = sqlx::query(
                r#"
SELECT k.usage_limit, u.cost_usd,
       COALESCE(u.total_tokens, 0) AS total_tokens,
       COALESCE(u.observed_requests, 0) AS observed_requests,
       COALESCE(u.priced_tokens, 0) AS priced_tokens
FROM api_keys k LEFT JOIN api_key_lifetime_usage u ON k.id = u.api_key_id
WHERE k.id = $1 AND k.enabled = TRUE AND (k.expires_at_ms IS NULL OR k.expires_at_ms > $2)
"#,
            )
            .bind(key_id)
            .bind(now_ms)
            .fetch_optional(pool)
            .await?;
            row.map(|row| Ok((decode_limit(row.get("usage_limit"))?, usage_from_row!(row)?)))
                .transpose()
        })
    }

    pub async fn add_api_key_usage(
        &self,
        key_id: i64,
        usage: &Usage,
        cost: Option<PricedCost>,
    ) -> Result<(), DbError> {
        let (begin, lock) = match self {
            Self::Sqlite(_) => ("BEGIN IMMEDIATE", ""),
            Self::Postgres(_) => ("BEGIN", " FOR UPDATE"),
        };
        let tokens = ApiKeyUsage::tokens(usage);
        with_pool!(self, pool, {
            let mut tx = pool.begin_with(begin).await?;
            sqlx::query(
                "INSERT INTO api_key_lifetime_usage (api_key_id) SELECT id FROM api_keys WHERE id = $1 ON CONFLICT(api_key_id) DO NOTHING",
            )
            .bind(key_id)
            .execute(&mut *tx)
            .await?;
            let statement = format!(
                "SELECT total_tokens, observed_requests, priced_tokens, cost_usd FROM api_key_lifetime_usage WHERE api_key_id = $1{lock}"
            );
            let row = sqlx::query(&statement)
                .bind(key_id)
                .fetch_optional(&mut *tx)
                .await?;
            if let Some(row) = row {
                let mut totals = usage_from_row!(row)?;
                totals.total_tokens = totals.total_tokens.saturating_add(tokens);
                totals.observed_requests = totals.observed_requests.saturating_add(1);
                if let Some(cost) = cost {
                    totals.add_priced(tokens, cost);
                }
                sqlx::query(
                    "UPDATE api_key_lifetime_usage SET total_tokens = $1, observed_requests = $2, priced_tokens = $3, cost_usd = $4 WHERE api_key_id = $5",
                )
                .bind(totals.total_tokens)
                .bind(totals.observed_requests)
                .bind(totals.priced_tokens)
                .bind(totals.cost_usd.map(|cost| cost.normalize().to_string()))
                .bind(key_id)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            Ok(())
        })
    }
}
