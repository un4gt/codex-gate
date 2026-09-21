use super::*;

pub struct ProviderBundle<'a> {
    pub provider: &'a UpstreamProvider,
    pub groups: &'a [(i64, Option<i32>)],
    pub endpoints: &'a [UpstreamEndpoint],
    pub keys: &'a [UpstreamKey],
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bundle_rolls_back_on_failure_and_ordering_rejects_foreign_ids() {
        let db = Database::connect("sqlite::memory:", 1).await.unwrap();
        db.migrate().await.unwrap();
        let provider = UpstreamProvider {
            id: 0,
            name: "test".into(),
            provider_type: "openai".into(),
            enabled: true,
            priority: 100,
            weight: 1,
            supports_include_usage: true,
            websocket_enabled: false,
            beta_features: Vec::new(),
            request_overrides: RequestOverrides::default(),
            key_selection_strategy: "ordered".into(),
            max_attempts: 8,
            max_concurrency: None,
            circuit_breaker_enabled: true,
            circuit_breaker_failure_threshold: 3,
            circuit_breaker_open_ms: 30_000,
            circuit_breaker_half_open_success_threshold: 2,
        };
        let endpoints = [1, 2].map(|n| UpstreamEndpoint {
            id: 0,
            provider_id: 0,
            name: format!("endpoint {n}"),
            base_url: "https://example.invalid/v1".into(),
            enabled: true,
            priority: n * 10,
            weight: 1,
        });
        let keys = [UpstreamKey {
            id: 0,
            provider_id: 0,
            name: "key".into(),
            secret: "synthetic-key".into(),
            enabled: true,
            priority: 10,
            weight: 1,
        }];
        let group = db.list_provider_groups().await.unwrap()[0].id;
        let failed = db
            .insert_provider_bundle(
                ProviderBundle {
                    provider: &provider,
                    groups: &[(group, None), (group, None)],
                    endpoints: &endpoints,
                    keys: &keys,
                },
                "test-master",
                0,
            )
            .await;
        assert!(failed.is_err());
        assert!(db.list_upstream_providers().await.unwrap().is_empty());
        assert!(db.list_upstream_endpoints().await.unwrap().is_empty());
        assert!(db.list_upstream_keys_meta().await.unwrap().is_empty());

        let created = db
            .insert_provider_bundle(
                ProviderBundle {
                    provider: &provider,
                    groups: &[(group, None)],
                    endpoints: &endpoints,
                    keys: &keys,
                },
                "test-master",
                0,
            )
            .await
            .unwrap();
        assert_eq!(created.endpoint_ids.len(), 2);
        assert_eq!(created.key_ids.len(), 1);
        assert_eq!(
            db.list_upstream_providers().await.unwrap()[0].max_attempts,
            8
        );
        assert!(
            !db.reorder_provider_children(created.id, false, &[created.endpoint_ids[1], 99999], 1)
                .await
                .unwrap()
        );
        assert_eq!(
            db.list_upstream_endpoints_by_provider(created.id)
                .await
                .unwrap()[0]
                .id,
            created.endpoint_ids[0]
        );
        let reversed = [created.endpoint_ids[1], created.endpoint_ids[0]];
        assert!(
            db.reorder_provider_children(created.id, false, &reversed, 2)
                .await
                .unwrap()
        );
        assert_eq!(
            db.list_upstream_endpoints_by_provider(created.id)
                .await
                .unwrap()[0]
                .id,
            reversed[0]
        );
        let Database::Sqlite(pool) = &db else {
            unreachable!()
        };
        let secret: String = sqlx::query_scalar("SELECT secret_enc FROM upstream_keys")
            .fetch_one(pool)
            .await
            .unwrap();
        assert!(!secret.contains("synthetic-key"));
        assert_eq!(
            crypto::decrypt_secret("test-master", &secret).unwrap(),
            "synthetic-key"
        );
    }
}

#[derive(serde::Serialize)]
pub struct CreatedProviderBundle {
    pub id: i64,
    pub endpoint_ids: Vec<i64>,
    pub key_ids: Vec<i64>,
}

impl Database {
    /// Store a service and all its credentials together. Network discovery runs after commit.
    pub async fn insert_provider_bundle(
        &self,
        bundle: ProviderBundle<'_>,
        master_key: &str,
        now_ms: i64,
    ) -> Result<CreatedProviderBundle, DbError> {
        let p = bundle.provider;
        let encrypted = bundle
            .keys
            .iter()
            .map(|key| {
                crypto::encrypt_secret(master_key, &key.secret)
                    .map_err(|e| DbError::new(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;

        macro_rules! insert {
            ($pool:expr, $db:ty, $begin:literal) => {{
                let mut tx = $pool.begin_with($begin).await?;
                let mut query = QueryBuilder::<$db>::new("INSERT INTO upstream_providers (name, provider_type, enabled, priority, weight, supports_include_usage, websocket_enabled, beta_features, request_overrides_json, key_selection_strategy, max_attempts, max_concurrency, circuit_breaker_enabled, circuit_breaker_failure_threshold, circuit_breaker_open_ms, circuit_breaker_half_open_success_threshold, created_at_ms, updated_at_ms) ");
                query.push_values([p], |mut row, p| {
                    row.push_bind(&p.name).push_bind(&p.provider_type).push_bind(p.enabled)
                        .push_bind(p.priority).push_bind(p.weight).push_bind(p.supports_include_usage)
                        .push_bind(p.websocket_enabled).push_bind(beta_features_to_json(&p.beta_features))
                        .push_bind(p.request_overrides.to_storage()).push_bind(&p.key_selection_strategy)
                        .push_bind(p.max_attempts).push_bind(p.max_concurrency).push_bind(p.circuit_breaker_enabled)
                        .push_bind(p.circuit_breaker_failure_threshold).push_bind(p.circuit_breaker_open_ms)
                        .push_bind(p.circuit_breaker_half_open_success_threshold).push_bind(now_ms).push_bind(now_ms);
                });
                query.push(" RETURNING id");
                let id: i64 = query.build_query_scalar().fetch_one(&mut *tx).await?;
                for (group_id, priority) in bundle.groups {
                    let mut query = QueryBuilder::<$db>::new("INSERT INTO provider_group_providers (group_id, provider_id, priority_override, created_at_ms, updated_at_ms) ");
                    query.push_values([()], |mut row, ()| {
                        row.push_bind(group_id).push_bind(id).push_bind(priority).push_bind(now_ms).push_bind(now_ms);
                    });
                    query.build().execute(&mut *tx).await?;
                }
                let mut endpoint_ids = Vec::with_capacity(bundle.endpoints.len());
                for endpoint in bundle.endpoints {
                    let mut query = QueryBuilder::<$db>::new("INSERT INTO upstream_endpoints (provider_id, name, base_url, enabled, priority, weight, created_at_ms, updated_at_ms) ");
                    query.push_values([endpoint], |mut row, e| {
                        row.push_bind(id).push_bind(&e.name).push_bind(&e.base_url).push_bind(e.enabled)
                            .push_bind(e.priority).push_bind(e.weight).push_bind(now_ms).push_bind(now_ms);
                    });
                    query.push(" RETURNING id");
                    endpoint_ids.push(query.build_query_scalar().fetch_one(&mut *tx).await?);
                }
                let mut key_ids = Vec::with_capacity(bundle.keys.len());
                for (key, secret) in bundle.keys.iter().zip(&encrypted) {
                    let mut query = QueryBuilder::<$db>::new("INSERT INTO upstream_keys (provider_id, name, secret_enc, enabled, priority, weight, created_at_ms, updated_at_ms) ");
                    query.push_values([key], |mut row, k| {
                        row.push_bind(id).push_bind(&k.name).push_bind(secret).push_bind(k.enabled)
                            .push_bind(k.priority).push_bind(k.weight).push_bind(now_ms).push_bind(now_ms);
                    });
                    query.push(" RETURNING id");
                    key_ids.push(query.build_query_scalar().fetch_one(&mut *tx).await?);
                }
                tx.commit().await?;
                Ok(CreatedProviderBundle { id, endpoint_ids, key_ids })
            }};
        }
        match self {
            Self::Sqlite(pool) => insert!(pool, Sqlite, "BEGIN IMMEDIATE"),
            Self::Postgres(pool) => insert!(pool, Postgres, "BEGIN"),
        }
    }

    /// Reject stale or foreign IDs and apply the whole ordering in one transaction.
    pub async fn reorder_provider_children(
        &self,
        provider_id: i64,
        keys: bool,
        ids: &[i64],
        now_ms: i64,
    ) -> Result<bool, DbError> {
        let table = if keys {
            "upstream_keys"
        } else {
            "upstream_endpoints"
        };
        let expected = ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        if expected.len() != ids.len() || ids.len() > 10_000 {
            return Ok(false);
        }
        macro_rules! reorder {
            ($pool:expr, $db:ty, $begin:literal) => {{
                let mut tx = $pool.begin_with($begin).await?;
                let mut query = QueryBuilder::<$db>::new(format!(
                    "SELECT id FROM {table} WHERE provider_id = "
                ));
                query.push_bind(provider_id);
                let current: Vec<i64> = query.build_query_scalar().fetch_all(&mut *tx).await?;
                if current
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    != expected
                {
                    return Ok(false);
                }
                for (index, id) in ids.iter().enumerate() {
                    let mut query =
                        QueryBuilder::<$db>::new(format!("UPDATE {table} SET priority = "));
                    query
                        .push_bind((index as i32 + 1) * 10)
                        .push(", updated_at_ms = ")
                        .push_bind(now_ms)
                        .push(" WHERE provider_id = ")
                        .push_bind(provider_id)
                        .push(" AND id = ")
                        .push_bind(id);
                    query.build().execute(&mut *tx).await?;
                }
                tx.commit().await?;
                Ok(true)
            }};
        }
        match self {
            Self::Sqlite(pool) => reorder!(pool, Sqlite, "BEGIN IMMEDIATE"),
            Self::Postgres(pool) => reorder!(pool, Postgres, "BEGIN"),
        }
    }
}
