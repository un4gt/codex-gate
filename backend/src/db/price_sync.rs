use super::{Database, DbError};
use crate::price_sync::{CatalogModel, Conflict, Counts, Job};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::{BTreeMap, HashSet};

// Both supported databases accept numbered parameters and SQL boolean literals.
macro_rules! with_pool {
    ($db:expr, $pool:ident, $body:block) => {
        match $db {
            Database::Sqlite($pool) => $body,
            Database::Postgres($pool) => $body,
        }
    };
}
impl Database {
    pub async fn migrate_price_sync(&self) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => {
                for (name, definition) in [
                    ("source", "TEXT NOT NULL DEFAULT 'manual'"),
                    ("source_version", "TEXT"),
                ] {
                    if !super::sqlite_column_exists(pool, "model_prices", name).await? {
                        sqlx::query(&format!(
                            "ALTER TABLE model_prices ADD COLUMN {name} {definition}"
                        ))
                        .execute(pool)
                        .await?;
                    }
                }
            }
            Database::Postgres(pool) => {
                sqlx::query("ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual', ADD COLUMN IF NOT EXISTS source_version TEXT").execute(pool).await?;
            }
        }
        with_pool!(self, pool, {
            sqlx::raw_sql("CREATE TABLE IF NOT EXISTS cloud_model_catalog (model_name TEXT PRIMARY KEY, data_json TEXT NOT NULL, source_version TEXT NOT NULL, present BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS price_sync_missing (model_name TEXT PRIMARY KEY, source_version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS price_sync_jobs (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, created_at_ms BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS price_sync_control (id INTEGER PRIMARY KEY, owner TEXT, lease_until_ms BIGINT NOT NULL DEFAULT 0, last_success_ms BIGINT, last_attempt_ms BIGINT, last_job_id TEXT, catalog_version TEXT, catalog_generation BIGINT NOT NULL DEFAULT 0);
INSERT INTO price_sync_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING;").execute(pool).await?;
            Ok(())
        })
    }
    pub async fn sync_has_missing(&self, version: &str) -> Result<bool, DbError> {
        with_pool!(self, pool, {
            let row = sqlx::query("SELECT 1 FROM provider_models pm WHERE NOT EXISTS (SELECT 1 FROM model_prices p WHERE p.active=TRUE AND p.model_name=pm.upstream_model AND (p.provider_id IS NULL OR p.provider_id=pm.provider_id)) AND NOT EXISTS (SELECT 1 FROM price_sync_missing n WHERE n.model_name=pm.upstream_model AND n.source_version=$1) LIMIT 1").bind(version).fetch_optional(pool).await?;
            Ok(row.is_some())
        })
    }
    pub async fn sync_lease(&self, owner: &str, job_id: &str, now: i64) -> Result<bool, DbError> {
        with_pool!(self, pool, {
            Ok(sqlx::query("UPDATE price_sync_control SET owner=$1, last_job_id=$4, lease_until_ms=$2, last_attempt_ms=$3 WHERE id=1 AND lease_until_ms <= $3").bind(owner).bind(now+300_000).bind(now).bind(job_id).execute(pool).await?.rows_affected()==1)
        })
    }
    pub async fn sync_renew(&self, owner: &str, now: i64) -> Result<bool, DbError> {
        with_pool!(self, pool, {
            Ok(sqlx::query("UPDATE price_sync_control SET lease_until_ms=$1 WHERE id=1 AND owner=$2 AND lease_until_ms>$3").bind(now+300_000).bind(owner).bind(now).execute(pool).await?.rows_affected()==1)
        })
    }
    pub async fn sync_release(&self, owner: &str) -> Result<(), DbError> {
        with_pool!(self, pool, {
            sqlx::query("UPDATE price_sync_control SET owner=NULL, lease_until_ms=0 WHERE id=1 AND owner=$1").bind(owner).execute(pool).await?;
            Ok(())
        })
    }
    pub async fn sync_status(&self) -> Result<Value, DbError> {
        with_pool!(self, pool, {
            let r = sqlx::query("SELECT * FROM price_sync_control WHERE id=1")
                .fetch_one(pool)
                .await?;
            Ok(
                json!({"running": r.get::<i64,_>("lease_until_ms") > crate::util::now_ms(), "last_success_ms":r.get::<Option<i64>,_>("last_success_ms"),"last_attempt_ms":r.get::<Option<i64>,_>("last_attempt_ms"),"last_job_id":r.get::<Option<String>,_>("last_job_id"),"catalog_version":r.get::<Option<String>,_>("catalog_version"),"catalog_generation":r.get::<i64,_>("catalog_generation")}),
            )
        })
    }
    pub async fn save_sync_job(&self, job: &Job) -> Result<(), DbError> {
        let data = serde_json::to_string(job).map_err(|e| DbError::new(e.to_string()))?;
        with_pool!(self, pool, {
            sqlx::query("INSERT INTO price_sync_jobs (id,data_json,created_at_ms) VALUES ($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json").bind(&job.id).bind(&data).bind(job.created_at_ms).execute(pool).await?;
            sqlx::query("DELETE FROM price_sync_jobs WHERE created_at_ms < $1")
                .bind(crate::util::now_ms() - 86_400_000)
                .execute(pool)
                .await?;
            Ok(())
        })
    }
    pub async fn sync_job(&self, id: &str) -> Result<Option<Job>, DbError> {
        with_pool!(self, pool, {
            let r = sqlx::query("SELECT data_json FROM price_sync_jobs WHERE id=$1")
                .bind(id)
                .fetch_optional(pool)
                .await?;
            r.map(|r| {
                serde_json::from_str(&r.get::<String, _>("data_json"))
                    .map_err(|e| DbError::new(e.to_string()))
            })
            .transpose()
        })
    }
    pub async fn cloud_display(&self) -> Result<BTreeMap<String, Value>, DbError> {
        with_pool!(self, pool, {
            let rows = sqlx::query("SELECT model_name,data_json,present FROM cloud_model_catalog")
                .fetch_all(pool)
                .await?;
            rows.into_iter().map(|r| { let m:CatalogModel=serde_json::from_str(&r.get::<String,_>("data_json")).map_err(|e| DbError::new(e.to_string()))?;
                Ok((r.get("model_name"),json!({"display_name":m.display_name,"brand":m.brand,"aliases":m.aliases,"quote_provider":m.quote_provider,"adaptation":m.adaptation,"present":r.get::<bool,_>("present")}))) }).collect()
        })
    }
    pub async fn price_sources(&self) -> Result<BTreeMap<i64, Value>, DbError> {
        with_pool!(self, pool, {
            Ok(sqlx::query("SELECT id,source,source_version FROM model_prices WHERE active=TRUE").fetch_all(pool).await?.into_iter().map(|r| (r.get("id"),json!({"source":r.get::<String,_>("source"),"source_version":r.get::<Option<String>,_>("source_version")}))).collect())
        })
    }
    pub async fn prepare_sync(&self, job: &mut Job) -> Result<(), DbError> {
        job.catalog_generation = self.sync_status().await?["catalog_generation"]
            .as_i64()
            .ok_or_else(|| DbError::new("invalid catalog generation"))?;
        let prices = self.list_latest_model_prices().await?;
        let sources = self.price_sources().await?;
        let prices: BTreeMap<_, _> = prices
            .iter()
            .filter(|p| p.provider_id.is_none())
            .map(|p| (p.model_name.as_str(), p))
            .collect();
        for m in &job.models {
            if let Some(p) = prices.get(m.model_name.as_str()) {
                job.expected.insert(m.model_name.clone(), p.id);
            }
            let Some(card) = &m.price_data else { continue };
            match prices.get(m.model_name.as_str()) {
                Some(p)
                    if sources
                        .get(&p.id)
                        .ok_or_else(|| DbError::new("local prices changed during preview"))?["source"]
                        == "manual" =>
                {
                    job.counts.manual_preserved += 1;
                    job.conflicts.push(Conflict {
                        model_name: m.model_name.clone(),
                        local_id: p.id,
                        local_price: p.price.to_json(),
                        cloud_price: card.clone(),
                    });
                }
                Some(p) if p.price.to_json() == *card => job.counts.unchanged += 1,
                Some(_) => job.counts.updated += 1,
                None => job.counts.added += 1,
            }
        }
        Ok(())
    }
    pub async fn apply_sync(
        &self,
        job: &Job,
        selected: &HashSet<String>,
        owner: &str,
    ) -> Result<Counts, DbError> {
        let now = crate::util::now_ms();
        with_pool!(self, pool, {
            let mut tx = pool.begin().await?;
            // Fence the lease for the entire transaction, including a recovered worker.
            if sqlx::query("UPDATE price_sync_control SET lease_until_ms=$1 WHERE id=1 AND owner=$2 AND lease_until_ms>$3").bind(now+300_000).bind(owner).bind(now).execute(&mut *tx).await?.rows_affected()!=1 {return Err(DbError::new("sync lease expired"));}
            let control =
                sqlx::query("SELECT catalog_generation FROM price_sync_control WHERE id=1")
                    .fetch_one(&mut *tx)
                    .await?;
            if control.get::<i64, _>("catalog_generation") != job.catalog_generation {
                return Err(DbError::new(
                    "catalog changed since preview; create a new preview",
                ));
            }
            let mut counts = Counts {
                failed: job.counts.failed,
                ..Counts::default()
            };
            sqlx::query("UPDATE cloud_model_catalog SET present=FALSE")
                .execute(&mut *tx)
                .await?;
            for m in &job.models {
                let data = serde_json::to_string(m).map_err(|e| DbError::new(e.to_string()))?;
                sqlx::query("INSERT INTO cloud_model_catalog(model_name,data_json,source_version,present) VALUES($1,$2,$3,TRUE) ON CONFLICT(model_name) DO UPDATE SET data_json=excluded.data_json,source_version=excluded.source_version,present=TRUE").bind(&m.model_name).bind(data).bind(&job.source_version).execute(&mut *tx).await?;
                let Some(card) = &m.price_data else { continue };
                let current=sqlx::query("SELECT id,source,price_data_json FROM model_prices WHERE provider_id IS NULL AND model_name=$1 AND active=TRUE").bind(&m.model_name).fetch_optional(&mut *tx).await?;
                let current_id = current.as_ref().map(|r| r.get::<i64, _>("id"));
                if current_id != job.expected.get(&m.model_name).copied() {
                    return Err(DbError::new(format!(
                        "price changed since preview: {}",
                        m.model_name
                    )));
                }
                if let Some(r) = current.as_ref() {
                    if r.get::<String, _>("source") == "manual" && !selected.contains(&m.model_name)
                    {
                        counts.manual_preserved += 1;
                        continue;
                    }
                    let old =
                        super::parse_model_price_data(&r.get::<String, _>("price_data_json"))?;
                    if old.to_json() == *card && r.get::<String, _>("source") == "cloud" {
                        counts.unchanged += 1;
                        continue;
                    }
                    let changed=sqlx::query("UPDATE model_prices SET active=FALSE,updated_at_ms=$1 WHERE id=$2 AND active=TRUE").bind(now).bind(current_id).execute(&mut *tx).await?.rows_affected();
                    if changed != 1 {
                        return Err(DbError::new("price changed during apply"));
                    }
                    counts.updated += 1;
                } else {
                    counts.added += 1;
                }
                sqlx::query("INSERT INTO model_prices(provider_id,model_name,price_data_json,active,created_at_ms,updated_at_ms,source,source_version) VALUES(NULL,$1,$2,TRUE,$3,$3,'cloud',$4)").bind(&m.model_name).bind(card.to_string()).bind(now).bind(&job.source_version).execute(&mut *tx).await?;
            }
            sqlx::query("DELETE FROM price_sync_missing")
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT INTO price_sync_missing(model_name,source_version) SELECT DISTINCT pm.upstream_model,$1 FROM provider_models pm WHERE NOT EXISTS (SELECT 1 FROM model_prices p WHERE p.active=TRUE AND p.model_name=pm.upstream_model AND (p.provider_id IS NULL OR p.provider_id=pm.provider_id))").bind(&job.source_version).execute(&mut *tx).await?;
            sqlx::query(
                "UPDATE price_sync_control SET last_success_ms=$1,catalog_version=$2,catalog_generation=catalog_generation+1 WHERE id=1",
            )
            .bind(now)
            .bind(&job.source_version)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            Ok(counts)
        })
    }
}
