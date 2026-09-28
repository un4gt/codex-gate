use super::{Database, DbError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use std::collections::HashMap;

macro_rules! with_pool {
    ($db:expr, $pool:ident, $body:block) => {
        match $db {
            Database::Sqlite($pool) => $body,
            Database::Postgres($pool) => $body,
        }
    };
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteTarget {
    pub provider_id: i64,
    pub priority: i32,
    pub weight: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutePolicy {
    pub model_name: String,
    pub mode: String,
    pub sticky: bool,
    pub failover: bool,
    pub targets: Vec<RouteTarget>,
}

impl Database {
    /// Versioned, atomic migration. Legacy tables remain as the compatibility snapshot.
    pub async fn migrate_upstream_config(&self) -> Result<(), DbError> {
        with_pool!(self, pool, {
            let mut tx = pool
                .begin_with(if matches!(self, Self::Sqlite(_)) {
                    "BEGIN IMMEDIATE"
                } else {
                    "BEGIN"
                })
                .await?;
            sqlx::raw_sql("CREATE TABLE IF NOT EXISTS upstream_migrations (version INTEGER PRIMARY KEY, report_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_key_authorization (api_key_id BIGINT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE, direct BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS api_key_allowed_providers (api_key_id BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE, provider_id BIGINT NOT NULL REFERENCES upstream_providers(id) ON DELETE CASCADE, PRIMARY KEY(api_key_id,provider_id));
CREATE TABLE IF NOT EXISTS model_route_policies (model_name TEXT PRIMARY KEY, data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS upstream_request_options (provider_id BIGINT PRIMARY KEY REFERENCES upstream_providers(id) ON DELETE CASCADE, timeout_ms BIGINT, endpoint_failover BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS upstream_sync_state (provider_id BIGINT PRIMARY KEY REFERENCES upstream_providers(id) ON DELETE CASCADE, last_attempt_ms BIGINT, last_success_ms BIGINT, error TEXT);").execute(&mut *tx).await?;
            let exists = sqlx::query("SELECT version FROM upstream_migrations WHERE version=1")
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
            if !exists {
                sqlx::query(
                    "INSERT INTO api_key_authorization (api_key_id) SELECT id FROM api_keys",
                )
                .execute(&mut *tx)
                .await?;
                sqlx::query("INSERT INTO api_key_allowed_providers SELECT DISTINCT k.api_key_id,p.provider_id FROM provider_group_api_keys k JOIN provider_group_providers p ON p.group_id=k.group_id").execute(&mut *tx).await?;
                let rows = sqlx::query(
                    "SELECT id,priority,weight FROM upstream_providers ORDER BY priority,id",
                )
                .fetch_all(&mut *tx)
                .await?;
                let targets = rows
                    .iter()
                    .map(|r| RouteTarget {
                        provider_id: r.get("id"),
                        priority: r.get("priority"),
                        weight: r.get("weight"),
                    })
                    .collect::<Vec<_>>();
                let policy = RoutePolicy {
                    model_name: "*".into(),
                    mode: if targets.is_empty() {
                        "ordered"
                    } else {
                        "weighted"
                    }
                    .into(),
                    sticky: true,
                    failover: true,
                    targets,
                };
                let data =
                    serde_json::to_string(&policy).map_err(|e| DbError::new(e.to_string()))?;
                sqlx::query("INSERT INTO model_route_policies VALUES ('*',$1)")
                    .bind(data)
                    .execute(&mut *tx)
                    .await?;
                let mut migrated_policies = vec![policy.clone()];
                let routes =
                    sqlx::query("SELECT id,model_name FROM model_routes WHERE enabled=TRUE")
                        .fetch_all(&mut *tx)
                        .await?;
                for route in routes {
                    let ids: Vec<i64> = sqlx::query_scalar(
                        "SELECT provider_id FROM model_route_providers WHERE route_id=$1",
                    )
                    .bind(route.get::<i64, _>("id"))
                    .fetch_all(&mut *tx)
                    .await?;
                    if ids.is_empty() {
                        continue;
                    }
                    let mut migrated = policy.clone();
                    migrated.model_name = route.get("model_name");
                    migrated.targets.retain(|t| ids.contains(&t.provider_id));
                    migrated_policies.push(migrated.clone());
                    let data = serde_json::to_string(&migrated)
                        .map_err(|e| DbError::new(e.to_string()))?;
                    sqlx::query("INSERT INTO model_route_policies VALUES ($1,$2)")
                        .bind(&migrated.model_name)
                        .bind(data)
                        .execute(&mut *tx)
                        .await?;
                }
                let inventory=sqlx::query("SELECT provider_id,upstream_model,enabled,available FROM provider_models").fetch_all(&mut *tx).await?.iter().map(|r|json!({"provider_id":r.get::<i64,_>("provider_id"),"model":r.get::<String,_>("upstream_model"),"enabled":r.get::<bool,_>("enabled"),"available":r.get::<bool,_>("available")})).collect::<Vec<_>>();
                let aliases=sqlx::query("SELECT id,alias_id,provider_id,priority,weight FROM model_alias_targets").fetch_all(&mut *tx).await?.iter().map(|r|json!({"target_id":r.get::<i64,_>("id"),"alias_id":r.get::<i64,_>("alias_id"),"provider_id":r.get::<i64,_>("provider_id"),"priority":r.get::<i32,_>("priority"),"weight":r.get::<i32,_>("weight")})).collect::<Vec<_>>();
                let selector:Option<String>=sqlx::query_scalar("SELECT value_json FROM runtime_settings WHERE key='endpoint_selector_strategy'").fetch_optional(&mut *tx).await?;
                let overrides = sqlx::query("SELECT k.api_key_id,p.provider_id,p.priority_override FROM provider_group_api_keys k JOIN provider_group_providers p ON p.group_id=k.group_id WHERE p.priority_override IS NOT NULL").fetch_all(&mut *tx).await?;
                let affected = overrides.iter().map(|r| json!({"api_key_id":r.get::<i64,_>("api_key_id"),"provider_id":r.get::<i64,_>("provider_id"),"old_priority":r.get::<i32,_>("priority_override")})).collect::<Vec<_>>();
                // Preserve a reviewable per-key priority comparison before removing group overrides.
                let authorizations = sqlx::query("SELECT api_key_id,provider_id FROM api_key_allowed_providers ORDER BY api_key_id,provider_id").fetch_all(&mut *tx).await?;
                let affected_keys = overrides
                    .iter()
                    .map(|r| r.get::<i64, _>("api_key_id"))
                    .collect::<std::collections::BTreeSet<_>>();
                let mut ordering_changes = Vec::new();
                for key_id in affected_keys {
                    let allowed = authorizations
                        .iter()
                        .filter(|r| r.get::<i64, _>("api_key_id") == key_id)
                        .map(|r| r.get::<i64, _>("provider_id"))
                        .collect::<Vec<_>>();
                    for route in &migrated_policies {
                        let mut candidates = route.targets.iter().filter(|t|allowed.contains(&t.provider_id)).map(|t| {
                            let old = overrides.iter().filter(|r| r.get::<i64,_>("api_key_id")==key_id && r.get::<i64,_>("provider_id")==t.provider_id).map(|r|r.get::<i32,_>("priority_override")).min().unwrap_or(t.priority);
                            json!({"provider_id":t.provider_id,"old_priority":old,"new_priority":t.priority,"models":inventory.iter().filter(|m|m["provider_id"]==t.provider_id).map(|m|m["model"].clone()).collect::<Vec<_>>()})
                        }).collect::<Vec<_>>();
                        candidates.sort_by_key(|c| {
                            (c["old_priority"].as_i64(), c["provider_id"].as_i64())
                        });
                        let old_order = candidates
                            .iter()
                            .map(|c| c["provider_id"].clone())
                            .collect::<Vec<_>>();
                        candidates.sort_by_key(|c| {
                            (c["new_priority"].as_i64(), c["provider_id"].as_i64())
                        });
                        let new_order = candidates
                            .iter()
                            .map(|c| c["provider_id"].clone())
                            .collect::<Vec<_>>();
                        ordering_changes.push(json!({"api_key_id":key_id,"model_route":route.model_name,"old_priority_order":old_order,"new_priority_order":new_order,"candidates":candidates}));
                    }
                }
                // Freeze the old multiplicative weight on the target; the router no longer multiplies it.
                sqlx::query("UPDATE model_alias_targets SET weight = CASE WHEN CAST(weight AS BIGINT) * (SELECT weight FROM upstream_providers p WHERE p.id=provider_id) > 2147483647 THEN 2147483647 ELSE CAST(weight AS BIGINT) * (SELECT weight FROM upstream_providers p WHERE p.id=provider_id) END WHERE alias_id IN (SELECT id FROM model_aliases WHERE mode='weighted')").execute(&mut *tx).await?;
                let report = json!({"version":1,"created_at_ms":crate::util::now_ms(),"removed_priority_overrides":affected,"ordering_changes":ordering_changes,"legacy_default_route":policy,"legacy_alias_targets":aliases,"model_inventory_at_migration":inventory,"legacy_endpoint_selector_setting":selector,"endpoint_selection":"healthy endpoints ordered by priority, id; weighted/latency deprecated","retry_limit":"legacy values retained; effective maximum is 3 attempts","rollback":"restore the pre-upgrade database backup"});
                sqlx::query("INSERT INTO upstream_migrations VALUES (1,$1)")
                    .bind(report.to_string())
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
            Ok(())
        })
    }
    pub async fn delete_upstream_provider(&self, id: i64) -> Result<bool, DbError> {
        with_pool!(self, pool, {
            let mut tx = pool
                .begin_with(if matches!(self, Self::Sqlite(_)) {
                    "BEGIN IMMEDIATE"
                } else {
                    "BEGIN"
                })
                .await?;
            let query = if matches!(self, Self::Postgres(_)) {
                "SELECT data_json FROM model_route_policies ORDER BY model_name FOR UPDATE"
            } else {
                "SELECT data_json FROM model_route_policies ORDER BY model_name"
            };
            let policies: Vec<String> = sqlx::query_scalar(query).fetch_all(&mut *tx).await?;
            for data in policies {
                let mut policy: RoutePolicy =
                    serde_json::from_str(&data).map_err(|e| DbError::new(e.to_string()))?;
                if policy.targets.iter().any(|t| t.provider_id == id) {
                    policy.targets.retain(|t| t.provider_id != id);
                    let data =
                        serde_json::to_string(&policy).map_err(|e| DbError::new(e.to_string()))?;
                    sqlx::query("UPDATE model_route_policies SET data_json=$1 WHERE model_name=$2")
                        .bind(data)
                        .bind(&policy.model_name)
                        .execute(&mut *tx)
                        .await?;
                }
            }
            let deleted = sqlx::query("DELETE FROM upstream_providers WHERE id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?
                .rows_affected()
                > 0;
            tx.commit().await?;
            Ok(deleted)
        })
    }
    pub async fn request_options(&self) -> Result<HashMap<i64, (Option<u64>, bool)>, DbError> {
        with_pool!(self, pool, {
            Ok(sqlx::query("SELECT * FROM upstream_request_options")
                .fetch_all(pool)
                .await?
                .iter()
                .map(|r| {
                    (
                        r.get("provider_id"),
                        (
                            r.get::<Option<i64>, _>("timeout_ms").map(|n| n as u64),
                            r.get("endpoint_failover"),
                        ),
                    )
                })
                .collect())
        })
    }
    pub async fn save_request_options(
        &self,
        id: i64,
        timeout: Option<u64>,
        failover: bool,
    ) -> Result<(), DbError> {
        with_pool!(self, pool, {
            sqlx::query("INSERT INTO upstream_request_options VALUES ($1,$2,$3) ON CONFLICT(provider_id) DO UPDATE SET timeout_ms=excluded.timeout_ms,endpoint_failover=excluded.endpoint_failover").bind(id).bind(timeout.map(|n|n as i64)).bind(failover).execute(pool).await?;
            Ok(())
        })
    }
    pub async fn allowed_provider_ids(&self, id: i64) -> Result<Vec<i64>, DbError> {
        with_pool!(self, pool, {
            Ok(sqlx::query_scalar("SELECT provider_id FROM api_key_allowed_providers WHERE api_key_id=$1 ORDER BY provider_id").bind(id).fetch_all(pool).await?)
        })
    }
    pub async fn authorization_is_direct(&self, id: i64) -> Result<bool, DbError> {
        with_pool!(self, pool, {
            Ok(sqlx::query_scalar::<_, bool>(
                "SELECT direct FROM api_key_authorization WHERE api_key_id=$1",
            )
            .bind(id)
            .fetch_optional(pool)
            .await?
            .unwrap_or(false))
        })
    }
    pub async fn replace_allowed_providers(&self, id: i64, ids: &[i64]) -> Result<(), DbError> {
        with_pool!(self, pool, {
            let mut tx = pool
                .begin_with(if matches!(self, Self::Sqlite(_)) {
                    "BEGIN IMMEDIATE"
                } else {
                    "BEGIN"
                })
                .await?;
            sqlx::query("INSERT INTO api_key_authorization VALUES ($1,TRUE) ON CONFLICT(api_key_id) DO UPDATE SET direct=TRUE").bind(id).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM api_key_allowed_providers WHERE api_key_id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            for provider_id in ids {
                sqlx::query("INSERT INTO api_key_allowed_providers VALUES ($1,$2)")
                    .bind(id)
                    .bind(provider_id)
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
            Ok(())
        })
    }
    /// Only compatibility-owned keys follow legacy group writes.
    pub async fn refresh_compat_authorizations(&self) -> Result<(), DbError> {
        with_pool!(self, pool, {
            let mut tx = pool
                .begin_with(if matches!(self, Self::Sqlite(_)) {
                    "BEGIN IMMEDIATE"
                } else {
                    "BEGIN"
                })
                .await?;
            sqlx::query("INSERT INTO api_key_authorization (api_key_id) SELECT id FROM api_keys WHERE TRUE ON CONFLICT(api_key_id) DO NOTHING").execute(&mut *tx).await?;
            sqlx::query("DELETE FROM api_key_allowed_providers WHERE api_key_id IN (SELECT api_key_id FROM api_key_authorization WHERE direct=FALSE)").execute(&mut *tx).await?;
            sqlx::query("INSERT INTO api_key_allowed_providers SELECT DISTINCT k.api_key_id,p.provider_id FROM provider_group_api_keys k JOIN provider_group_providers p ON p.group_id=k.group_id JOIN api_key_authorization a ON a.api_key_id=k.api_key_id WHERE a.direct=FALSE").execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(())
        })
    }
    pub async fn route_policies(&self) -> Result<HashMap<String, RoutePolicy>, DbError> {
        with_pool!(self, pool, {
            let rows: Vec<String> =
                sqlx::query_scalar("SELECT data_json FROM model_route_policies")
                    .fetch_all(pool)
                    .await?;
            rows.into_iter()
                .map(|s| {
                    let p: RoutePolicy =
                        serde_json::from_str(&s).map_err(|e| DbError::new(e.to_string()))?;
                    Ok((p.model_name.clone(), p))
                })
                .collect()
        })
    }
    pub async fn adapt_legacy_route(
        &self,
        model: &str,
        enabled: bool,
        ids: &[i64],
    ) -> Result<(), DbError> {
        if !enabled || ids.is_empty() {
            return with_pool!(self, pool, {
                sqlx::query(
                    "DELETE FROM model_route_policies WHERE model_name=$1 AND model_name<>'*'",
                )
                .bind(model)
                .execute(pool)
                .await?;
                Ok(())
            });
        }
        let policies = self.route_policies().await?;
        if let Some(default) = policies.get("*") {
            let mut policy = default.clone();
            policy.model_name = model.into();
            policy.targets.retain(|t| ids.contains(&t.provider_id));
            self.save_route_policy(&policy).await?;
        }
        Ok(())
    }
    pub async fn update_default_route_target(
        &self,
        id: i64,
        priority: i32,
        weight: i32,
        legacy_weighted: bool,
    ) -> Result<(), DbError> {
        with_pool!(self, pool, {
            let mut tx = pool
                .begin_with(if matches!(self, Self::Sqlite(_)) {
                    "BEGIN IMMEDIATE"
                } else {
                    "BEGIN"
                })
                .await?;
            let query = if matches!(self, Self::Postgres(_)) {
                "SELECT data_json FROM model_route_policies WHERE model_name='*' FOR UPDATE"
            } else {
                "SELECT data_json FROM model_route_policies WHERE model_name='*'"
            };
            let data: String = sqlx::query_scalar(query).fetch_one(&mut *tx).await?;
            let mut p: RoutePolicy =
                serde_json::from_str(&data).map_err(|e| DbError::new(e.to_string()))?;
            p.targets.retain(|t| t.provider_id != id);
            p.targets.push(RouteTarget {
                provider_id: id,
                priority,
                weight,
            });
            if legacy_weighted {
                p.mode = "weighted".into();
            }
            let data = serde_json::to_string(&p).map_err(|e| DbError::new(e.to_string()))?;
            sqlx::query("UPDATE model_route_policies SET data_json=$1 WHERE model_name='*'")
                .bind(data)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok(())
        })
    }
    pub async fn save_route_policy(&self, p: &RoutePolicy) -> Result<(), DbError> {
        let data = serde_json::to_string(p).map_err(|e| DbError::new(e.to_string()))?;
        with_pool!(self, pool, {
            sqlx::query("INSERT INTO model_route_policies VALUES ($1,$2) ON CONFLICT(model_name) DO UPDATE SET data_json=excluded.data_json").bind(&p.model_name).bind(data).execute(pool).await?;
            Ok(())
        })
    }
    pub async fn migration_report(&self) -> Result<serde_json::Value, DbError> {
        with_pool!(self, pool, {
            let data: String =
                sqlx::query_scalar("SELECT report_json FROM upstream_migrations WHERE version=1")
                    .fetch_one(pool)
                    .await?;
            serde_json::from_str(&data).map_err(|e| DbError::new(e.to_string()))
        })
    }
    pub async fn record_model_sync(
        &self,
        id: i64,
        started_at_ms: i64,
        status: u16,
    ) -> Result<(), DbError> {
        with_pool!(self, pool, {
            let success = (200..300).contains(&status);
            let error = (!success).then(|| {
                format!("Model synchronization failed (HTTP {status}); previous inventory retained")
            });
            sqlx::query("INSERT INTO upstream_sync_state (provider_id,last_attempt_ms,last_success_ms,error) VALUES ($1,$2,CASE WHEN $3 THEN $4 ELSE NULL END,$5) ON CONFLICT(provider_id) DO UPDATE SET last_attempt_ms=excluded.last_attempt_ms,last_success_ms=CASE WHEN $3 THEN excluded.last_success_ms ELSE upstream_sync_state.last_success_ms END,error=excluded.error").bind(id).bind(started_at_ms).bind(success).bind(crate::util::now_ms()).bind(error).execute(pool).await?;
            Ok(())
        })
    }
    pub async fn model_sync_states(&self) -> Result<HashMap<i64, serde_json::Value>, DbError> {
        with_pool!(self, pool, {
            Ok(sqlx::query("SELECT * FROM upstream_sync_state").fetch_all(pool).await?.iter().map(|r| (r.get("provider_id"),json!({"last_attempt_ms":r.get::<Option<i64>,_>("last_attempt_ms"),"last_success_ms":r.get::<Option<i64>,_>("last_success_ms"),"error":r.get::<Option<String>,_>("error")}))).collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn migration_unions_groups_preserves_direct_permissions_and_freezes_weights_once() {
        assert_permission_migration(Database::connect("sqlite::memory:", 1).await.unwrap()).await;
    }
    #[tokio::test]
    #[ignore = "requires isolated TEST_POSTGRES_DSN"]
    async fn postgres_permission_migration_is_atomic_and_idempotent() {
        let dsn = std::env::var("TEST_POSTGRES_DSN").expect("isolated database DSN");
        assert_permission_migration(Database::connect(&dsn, 2).await.unwrap()).await;
    }
    async fn assert_permission_migration(db: Database) {
        db.migrate().await.unwrap();
        with_pool!(&db, pool, {
            sqlx::raw_sql("DELETE FROM upstream_migrations; DELETE FROM model_route_policies;
INSERT INTO upstream_providers (id,name,provider_type,enabled,priority,weight,supports_include_usage,created_at_ms,updated_at_ms) VALUES (1,'a','openai',TRUE,100,3,TRUE,0,0),(2,'b','openai',FALSE,200,2,TRUE,0,0);
INSERT INTO api_keys (id,key_hash,name,enabled,log_enabled,created_at_ms,updated_at_ms) VALUES (1,'hash','client',TRUE,TRUE,0,0),(2,'empty','empty',TRUE,TRUE,0,0);
INSERT INTO provider_groups (id,name,normalized_name,is_default,created_at_ms,updated_at_ms) VALUES (10,'a','a',FALSE,0,0),(11,'b','b',FALSE,0,0);
INSERT INTO provider_group_providers VALUES (10,1,2,0,0),(11,1,NULL,0,0),(11,2,NULL,0,0);
INSERT INTO provider_group_api_keys VALUES (10,1,0),(11,1,0);
INSERT INTO model_routes (id,model_name,enabled,created_at_ms,updated_at_ms) VALUES (1,'explicit-model',TRUE,0,0);
INSERT INTO model_route_providers VALUES (1,1);
INSERT INTO model_aliases VALUES (1,'alias',TRUE,'weighted',0,0);
INSERT INTO model_alias_targets VALUES (1,1,1,'model',TRUE,100,4,0,0);").execute(pool).await.unwrap();
        });
        // An incompatible legacy model name forces a mid-migration failure; no permissions or
        // version marker may escape the transaction, on either database engine.
        with_pool!(&db, pool, {
            sqlx::raw_sql("INSERT INTO model_routes (id,model_name,enabled,created_at_ms,updated_at_ms) VALUES (2,'*',TRUE,0,0); INSERT INTO model_route_providers VALUES (2,1);").execute(pool).await.unwrap();
        });
        assert!(db.migrate_upstream_config().await.is_err());
        assert!(db.allowed_provider_ids(1).await.unwrap().is_empty());
        assert!(db.route_policies().await.unwrap().is_empty());
        assert_eq!(
            db.list_model_alias_targets(None).await.unwrap()[0].weight,
            4
        );
        with_pool!(&db, pool, {
            sqlx::query("DELETE FROM model_routes WHERE id=2")
                .execute(pool)
                .await
                .unwrap();
        });
        db.migrate_upstream_config().await.unwrap();
        assert_eq!(db.allowed_provider_ids(1).await.unwrap(), vec![1, 2]);
        let policies = db.route_policies().await.unwrap();
        assert_eq!(policies["explicit-model"].targets.len(), 1);
        assert_eq!(policies["explicit-model"].targets[0].provider_id, 1);
        assert_eq!(
            db.migration_report().await.unwrap()["ordering_changes"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(db.allowed_provider_ids(2).await.unwrap().is_empty());
        assert_eq!(
            db.list_model_alias_targets(None).await.unwrap()[0].weight,
            12
        );
        assert_eq!(
            db.migration_report().await.unwrap()["removed_priority_overrides"][0]["api_key_id"],
            1
        );
        db.replace_allowed_providers(1, &[2]).await.unwrap();
        db.refresh_compat_authorizations().await.unwrap();
        db.migrate_upstream_config().await.unwrap();
        assert_eq!(db.allowed_provider_ids(1).await.unwrap(), vec![2]);
        assert_eq!(
            db.list_model_alias_targets(None).await.unwrap()[0].weight,
            12
        );
        assert!(db.replace_allowed_providers(1, &[999]).await.is_err());
        assert_eq!(db.allowed_provider_ids(1).await.unwrap(), vec![2]);
        db.replace_allowed_providers(1, &[]).await.unwrap();
        assert!(db.allowed_provider_ids(1).await.unwrap().is_empty());
        db.delete_upstream_provider(1).await.unwrap();
        assert!(
            db.route_policies()
                .await
                .unwrap()
                .values()
                .all(|p| p.targets.iter().all(|t| t.provider_id != 1))
        );
    }
    #[tokio::test]
    async fn failed_sync_preserves_last_success_and_options_persist() {
        let db = Database::connect("sqlite::memory:", 1).await.unwrap();
        db.migrate().await.unwrap();
        let Database::Sqlite(pool) = &db else {
            unreachable!()
        };
        sqlx::query("INSERT INTO upstream_providers (id,name,provider_type,enabled,priority,weight,supports_include_usage,created_at_ms,updated_at_ms) VALUES (1,'a','openai',TRUE,100,1,TRUE,0,0)").execute(pool).await.unwrap();
        db.record_model_sync(1, 123, 200).await.unwrap();
        let success = db.model_sync_states().await.unwrap()[&1]["last_success_ms"].clone();
        db.record_model_sync(1, 456, 503).await.unwrap();
        let states = db.model_sync_states().await.unwrap();
        assert_eq!(states[&1]["last_success_ms"], success);
        assert_eq!(states[&1]["last_attempt_ms"], 456);
        assert!(states[&1]["error"].is_string());
        db.save_request_options(1, Some(1234), false).await.unwrap();
        assert_eq!(db.request_options().await.unwrap()[&1], (Some(1234), false));
    }
}
