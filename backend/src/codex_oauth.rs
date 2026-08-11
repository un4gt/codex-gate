use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::{
    ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT,
};
use hyper::{Method, Request, StatusCode, Uri};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{PgPool, Row, SqlitePool};
use tokio::sync::Mutex as AsyncMutex;

use crate::crypto;
use crate::db::{Database, DbError};
use crate::state::SharedState;
use crate::util;

pub const PROVIDER_TYPE: &str = "openai_codex_oauth";
pub const DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
pub const DEVICE_VERIFICATION_URI: &str = "https://auth.openai.com/codex/device";

const DEVICE_USER_CODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_MODELS_URL: &str =
    "https://chatgpt.com/backend-api/codex/models?client_version=0.144.1";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USER_AGENT: &str = "codex_cli_rs/0.144.1 (Linux; x86_64) little-gate/0.1";
const CODEX_ORIGINATOR: &str = "codex_cli_rs";

const DEVICE_SESSION_TTL_MS: i64 = 15 * 60 * 1_000;
const DEVICE_SESSION_TOMBSTONE_MS: i64 = 5 * 60 * 1_000;
const DEVICE_DEFAULT_POLL_INTERVAL_MS: i64 = 5_000;
const OAUTH_BODY_MAX_BYTES: usize = 1024 * 1024;
const QUOTA_BODY_MAX_BYTES: usize = 512 * 1024;
const MODEL_BODY_MAX_BYTES: usize = 4 * 1024 * 1024;
const REFRESH_LEEWAY_MS: i64 = 60_000;
const REFRESH_LEASE_MS: i64 = 30_000;
const REFRESH_LEASE_WAIT_ATTEMPTS: usize = 20;
const REFRESH_LEASE_WAIT: Duration = Duration::from_millis(250);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub const AUTH_STATUS_ACTIVE: &str = "active";
pub const AUTH_STATUS_REAUTH_REQUIRED: &str = "reauth_required";
pub const AUTH_STATUS_FORBIDDEN: &str = "forbidden";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CodexQuotaWindow {
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub window_seconds: Option<i64>,
    pub reset_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct CodexQuotaCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<f64>,
    pub reset_credits: Option<f64>,
    pub subscription_end_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CodexQuotaSnapshot {
    pub plan_type: Option<String>,
    pub allowed: Option<bool>,
    pub primary_window: Option<CodexQuotaWindow>,
    pub secondary_window: Option<CodexQuotaWindow>,
    pub code_review_window: Option<CodexQuotaWindow>,
    pub credits: CodexQuotaCredits,
}

impl CodexQuotaSnapshot {
    pub fn blocked_until_ms(&self, now_ms: i64) -> Option<i64> {
        let mut resets = [
            self.primary_window.as_ref(),
            self.secondary_window.as_ref(),
            self.code_review_window.as_ref(),
        ]
        .into_iter()
        .flatten()
        .filter(|window| window.remaining_percent <= 0.0)
        .filter_map(|window| window.reset_at_ms)
        .filter(|reset| *reset > now_ms);
        let first = resets.next();
        resets.fold(first, |current, reset| {
            Some(current.map_or(reset, |value| value.max(reset)))
        })
    }

    pub fn is_exhausted_without_reset(&self) -> bool {
        self.allowed == Some(false)
            && [
                self.primary_window.as_ref(),
                self.secondary_window.as_ref(),
                self.code_review_window.as_ref(),
            ]
            .into_iter()
            .flatten()
            .all(|window| window.reset_at_ms.is_none())
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct CodexOAuthCredentials {
    refresh_token: String,
    id_token: String,
    account_id: String,
    email: String,
}

#[derive(Clone)]
pub(crate) struct CodexOAuthAccount {
    pub upstream_key_id: i64,
    pub provider_id: i64,
    pub access_token: String,
    credentials: CodexOAuthCredentials,
    pub plan_type: Option<String>,
    pub token_expires_at_ms: Option<i64>,
    pub last_refresh_at_ms: Option<i64>,
    pub auth_status: String,
    pub last_error: Option<String>,
    pub quota: Option<CodexQuotaSnapshot>,
    pub quota_checked_at_ms: Option<i64>,
    pub refresh_lease_until_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub(crate) struct CodexOAuthRoutingAccount {
    pub auth_status: String,
    pub quota: Option<CodexQuotaSnapshot>,
}

impl CodexOAuthRoutingAccount {
    pub fn is_routable(&self, now_ms: i64) -> bool {
        if self.auth_status != AUTH_STATUS_ACTIVE {
            return false;
        }
        let Some(quota) = self.quota.as_ref() else {
            return true;
        };
        quota.blocked_until_ms(now_ms).is_none() && !quota.is_exhausted_without_reset()
    }
}

impl CodexOAuthAccount {
    pub(crate) fn routing(&self) -> CodexOAuthRoutingAccount {
        CodexOAuthRoutingAccount {
            auth_status: self.auth_status.clone(),
            quota: self.quota.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct CodexOAuthAccountView {
    pub upstream_key_id: i64,
    pub provider_id: i64,
    pub email_masked: Option<String>,
    pub account_id_suffix: Option<String>,
    pub plan_type: Option<String>,
    pub token_expires_at_ms: Option<i64>,
    pub last_refresh_at_ms: Option<i64>,
    pub auth_status: String,
    pub last_error: Option<String>,
    pub quota: Option<CodexQuotaSnapshot>,
    pub quota_checked_at_ms: Option<i64>,
}

impl From<&CodexOAuthAccount> for CodexOAuthAccountView {
    fn from(account: &CodexOAuthAccount) -> Self {
        Self {
            upstream_key_id: account.upstream_key_id,
            provider_id: account.provider_id,
            email_masked: mask_email(&account.credentials.email),
            account_id_suffix: mask_account_id(&account.credentials.account_id),
            plan_type: account.plan_type.clone(),
            token_expires_at_ms: account.token_expires_at_ms,
            last_refresh_at_ms: account.last_refresh_at_ms,
            auth_status: account.auth_status.clone(),
            last_error: account.last_error.clone(),
            quota: account.quota.clone(),
            quota_checked_at_ms: account.quota_checked_at_ms,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexLoginOperation {
    Created,
    Updated,
}

impl CodexLoginOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Updated => "updated",
        }
    }
}

pub struct SaveCodexLogin<'a> {
    pub provider_id: i64,
    pub replace_key_id: Option<i64>,
    pub account_hash: &'a str,
    pub access_token: &'a str,
    pub refresh_token: &'a str,
    pub id_token: &'a str,
    pub account_id: &'a str,
    pub email: &'a str,
    pub plan_type: Option<&'a str>,
    pub token_expires_at_ms: Option<i64>,
    pub now_ms: i64,
}

#[derive(Clone, Copy, Debug)]
pub struct SaveCodexLoginResult {
    pub key_id: i64,
    pub operation: CodexLoginOperation,
}

impl Database {
    pub async fn list_codex_oauth_accounts(
        &self,
        master_key: &str,
    ) -> Result<Vec<CodexOAuthAccount>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT account.upstream_key_id, account.provider_id, account.account_hash,
       key.secret_enc, account.credentials_enc, account.plan_type,
       account.token_expires_at_ms, account.last_refresh_at_ms,
       account.auth_status, account.last_error, account.quota_json,
       account.quota_checked_at_ms, account.refresh_lease_owner,
       account.refresh_lease_until_ms, account.created_at_ms, account.updated_at_ms
FROM codex_oauth_accounts account
JOIN upstream_keys key ON key.id = account.upstream_key_id
ORDER BY account.provider_id ASC, account.upstream_key_id ASC
"#,
                )
                .fetch_all(pool)
                .await?;
                rows.into_iter()
                    .map(|row| decode_sqlite_account(master_key, &row))
                    .collect()
            }
            Database::Postgres(pool) => {
                let rows = sqlx::query(
                    r#"
SELECT account.upstream_key_id, account.provider_id, account.account_hash,
       key.secret_enc, account.credentials_enc, account.plan_type,
       account.token_expires_at_ms, account.last_refresh_at_ms,
       account.auth_status, account.last_error, account.quota_json,
       account.quota_checked_at_ms, account.refresh_lease_owner,
       account.refresh_lease_until_ms, account.created_at_ms, account.updated_at_ms
FROM codex_oauth_accounts account
JOIN upstream_keys key ON key.id = account.upstream_key_id
ORDER BY account.provider_id ASC, account.upstream_key_id ASC
"#,
                )
                .fetch_all(pool)
                .await?;
                rows.into_iter()
                    .map(|row| decode_postgres_account(master_key, &row))
                    .collect()
            }
        }
    }

    pub async fn find_codex_oauth_account(
        &self,
        master_key: &str,
        key_id: i64,
    ) -> Result<Option<CodexOAuthAccount>, DbError> {
        match self {
            Database::Sqlite(pool) => {
                let row = sqlx::query(
                    r#"
SELECT account.upstream_key_id, account.provider_id, account.account_hash,
       key.secret_enc, account.credentials_enc, account.plan_type,
       account.token_expires_at_ms, account.last_refresh_at_ms,
       account.auth_status, account.last_error, account.quota_json,
       account.quota_checked_at_ms, account.refresh_lease_owner,
       account.refresh_lease_until_ms, account.created_at_ms, account.updated_at_ms
FROM codex_oauth_accounts account
JOIN upstream_keys key ON key.id = account.upstream_key_id
WHERE account.upstream_key_id = ?
LIMIT 1
"#,
                )
                .bind(key_id)
                .fetch_optional(pool)
                .await?;
                row.map(|row| decode_sqlite_account(master_key, &row))
                    .transpose()
            }
            Database::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
SELECT account.upstream_key_id, account.provider_id, account.account_hash,
       key.secret_enc, account.credentials_enc, account.plan_type,
       account.token_expires_at_ms, account.last_refresh_at_ms,
       account.auth_status, account.last_error, account.quota_json,
       account.quota_checked_at_ms, account.refresh_lease_owner,
       account.refresh_lease_until_ms, account.created_at_ms, account.updated_at_ms
FROM codex_oauth_accounts account
JOIN upstream_keys key ON key.id = account.upstream_key_id
WHERE account.upstream_key_id = $1
LIMIT 1
"#,
                )
                .bind(key_id)
                .fetch_optional(pool)
                .await?;
                row.map(|row| decode_postgres_account(master_key, &row))
                    .transpose()
            }
        }
    }

    pub async fn list_codex_oauth_account_views(
        &self,
        master_key: &str,
        provider_id: i64,
    ) -> Result<HashMap<i64, CodexOAuthAccountView>, DbError> {
        Ok(self
            .list_codex_oauth_accounts(master_key)
            .await?
            .into_iter()
            .filter(|account| account.provider_id == provider_id)
            .map(|account| {
                let key_id = account.upstream_key_id;
                (key_id, CodexOAuthAccountView::from(&account))
            })
            .collect())
    }

    pub async fn save_codex_oauth_login(
        &self,
        master_key: &str,
        input: SaveCodexLogin<'_>,
    ) -> Result<SaveCodexLoginResult, DbError> {
        let access_token_enc = crypto::encrypt_secret(master_key, input.access_token)
            .map_err(|error| DbError::new(format!("encrypt Codex access token failed: {error}")))?;
        let credentials = CodexOAuthCredentials {
            refresh_token: input.refresh_token.to_string(),
            id_token: input.id_token.to_string(),
            account_id: input.account_id.to_string(),
            email: input.email.to_string(),
        };
        let credentials_json = serde_json::to_string(&credentials)
            .map_err(|error| DbError::new(format!("encode Codex credentials failed: {error}")))?;
        let credentials_enc = crypto::encrypt_secret(master_key, &credentials_json)
            .map_err(|error| DbError::new(format!("encrypt Codex credentials failed: {error}")))?;
        let default_name = default_account_name(input.email, input.account_id);

        match self {
            Database::Sqlite(pool) => {
                save_codex_login_sqlite(
                    pool,
                    &input,
                    &default_name,
                    &access_token_enc,
                    &credentials_enc,
                )
                .await
            }
            Database::Postgres(pool) => {
                save_codex_login_postgres(
                    pool,
                    &input,
                    &default_name,
                    &access_token_enc,
                    &credentials_enc,
                )
                .await
            }
        }
    }

    pub async fn try_acquire_codex_refresh_lease(
        &self,
        key_id: i64,
        owner: &str,
        lease_until_ms: i64,
        now_ms: i64,
    ) -> Result<bool, DbError> {
        let affected = match self {
            Database::Sqlite(pool) => sqlx::query(
                r#"
UPDATE codex_oauth_accounts
SET refresh_lease_owner = ?, refresh_lease_until_ms = ?, updated_at_ms = ?
WHERE upstream_key_id = ?
  AND (refresh_lease_until_ms IS NULL OR refresh_lease_until_ms <= ? OR refresh_lease_owner = ?)
"#,
            )
            .bind(owner)
            .bind(lease_until_ms)
            .bind(now_ms)
            .bind(key_id)
            .bind(now_ms)
            .bind(owner)
            .execute(pool)
            .await?
            .rows_affected(),
            Database::Postgres(pool) => sqlx::query(
                r#"
UPDATE codex_oauth_accounts
SET refresh_lease_owner = $1, refresh_lease_until_ms = $2, updated_at_ms = $3
WHERE upstream_key_id = $4
  AND (refresh_lease_until_ms IS NULL OR refresh_lease_until_ms <= $5 OR refresh_lease_owner = $1)
"#,
            )
            .bind(owner)
            .bind(lease_until_ms)
            .bind(now_ms)
            .bind(key_id)
            .bind(now_ms)
            .execute(pool)
            .await?
            .rows_affected(),
        };
        Ok(affected == 1)
    }

    pub async fn release_codex_refresh_lease(
        &self,
        key_id: i64,
        owner: &str,
        now_ms: i64,
    ) -> Result<(), DbError> {
        match self {
            Database::Sqlite(pool) => {
                sqlx::query(
                    "UPDATE codex_oauth_accounts SET refresh_lease_owner = NULL, refresh_lease_until_ms = NULL, updated_at_ms = ? WHERE upstream_key_id = ? AND refresh_lease_owner = ?",
                )
                .bind(now_ms)
                .bind(key_id)
                .bind(owner)
                .execute(pool)
                .await?;
            }
            Database::Postgres(pool) => {
                sqlx::query(
                    "UPDATE codex_oauth_accounts SET refresh_lease_owner = NULL, refresh_lease_until_ms = NULL, updated_at_ms = $1 WHERE upstream_key_id = $2 AND refresh_lease_owner = $3",
                )
                .bind(now_ms)
                .bind(key_id)
                .bind(owner)
                .execute(pool)
                .await?;
            }
        }
        Ok(())
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "token rotation atomically updates the access token, credential blob, metadata, and lease"
    )]
    async fn persist_codex_token_refresh(
        &self,
        master_key: &str,
        key_id: i64,
        owner: &str,
        access_token: &str,
        credentials: &CodexOAuthCredentials,
        plan_type: Option<&str>,
        token_expires_at_ms: Option<i64>,
        auth_status: &str,
        last_error: Option<&str>,
        now_ms: i64,
    ) -> Result<bool, DbError> {
        let access_token_enc = crypto::encrypt_secret(master_key, access_token)
            .map_err(|error| DbError::new(format!("encrypt Codex access token failed: {error}")))?;
        let credentials_json = serde_json::to_string(credentials)
            .map_err(|error| DbError::new(format!("encode Codex credentials failed: {error}")))?;
        let credentials_enc = crypto::encrypt_secret(master_key, &credentials_json)
            .map_err(|error| DbError::new(format!("encrypt Codex credentials failed: {error}")))?;
        let last_error = last_error.map(sanitize_persisted_error);

        match self {
            Database::Sqlite(pool) => {
                let mut tx = pool.begin().await?;
                let result = sqlx::query(
                    r#"
UPDATE codex_oauth_accounts
SET credentials_enc = ?, plan_type = ?, token_expires_at_ms = ?,
    last_refresh_at_ms = ?, auth_status = ?, last_error = ?,
    refresh_lease_owner = NULL, refresh_lease_until_ms = NULL, updated_at_ms = ?
WHERE upstream_key_id = ? AND refresh_lease_owner = ?
"#,
                )
                .bind(credentials_enc)
                .bind(plan_type)
                .bind(token_expires_at_ms)
                .bind(now_ms)
                .bind(auth_status)
                .bind(last_error)
                .bind(now_ms)
                .bind(key_id)
                .bind(owner)
                .execute(&mut *tx)
                .await?;
                if result.rows_affected() != 1 {
                    tx.rollback().await?;
                    return Ok(false);
                }
                sqlx::query(
                    "UPDATE upstream_keys SET secret_enc = ?, updated_at_ms = ? WHERE id = ?",
                )
                .bind(access_token_enc)
                .bind(now_ms)
                .bind(key_id)
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;
            }
            Database::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let result = sqlx::query(
                    r#"
UPDATE codex_oauth_accounts
SET credentials_enc = $1, plan_type = $2, token_expires_at_ms = $3,
    last_refresh_at_ms = $4, auth_status = $5, last_error = $6,
    refresh_lease_owner = NULL, refresh_lease_until_ms = NULL, updated_at_ms = $7
WHERE upstream_key_id = $8 AND refresh_lease_owner = $9
"#,
                )
                .bind(credentials_enc)
                .bind(plan_type)
                .bind(token_expires_at_ms)
                .bind(now_ms)
                .bind(auth_status)
                .bind(last_error)
                .bind(now_ms)
                .bind(key_id)
                .bind(owner)
                .execute(&mut *tx)
                .await?;
                if result.rows_affected() != 1 {
                    tx.rollback().await?;
                    return Ok(false);
                }
                sqlx::query(
                    "UPDATE upstream_keys SET secret_enc = $1, updated_at_ms = $2 WHERE id = $3",
                )
                .bind(access_token_enc)
                .bind(now_ms)
                .bind(key_id)
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;
            }
        }
        Ok(true)
    }

    pub async fn update_codex_auth_status(
        &self,
        key_id: i64,
        status: &str,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<(), DbError> {
        let error = error.map(sanitize_persisted_error);
        match self {
            Database::Sqlite(pool) => {
                sqlx::query(
                    "UPDATE codex_oauth_accounts SET auth_status = ?, last_error = ?, updated_at_ms = ? WHERE upstream_key_id = ?",
                )
                .bind(status)
                .bind(error)
                .bind(now_ms)
                .bind(key_id)
                .execute(pool)
                .await?;
            }
            Database::Postgres(pool) => {
                sqlx::query(
                    "UPDATE codex_oauth_accounts SET auth_status = $1, last_error = $2, updated_at_ms = $3 WHERE upstream_key_id = $4",
                )
                .bind(status)
                .bind(error)
                .bind(now_ms)
                .bind(key_id)
                .execute(pool)
                .await?;
            }
        }
        Ok(())
    }

    pub async fn update_codex_quota_success(
        &self,
        key_id: i64,
        quota: &CodexQuotaSnapshot,
        now_ms: i64,
    ) -> Result<(), DbError> {
        let quota_json = serde_json::to_string(quota)
            .map_err(|error| DbError::new(format!("encode Codex quota failed: {error}")))?;
        match self {
            Database::Sqlite(pool) => {
                sqlx::query(
                    "UPDATE codex_oauth_accounts SET quota_json = ?, quota_checked_at_ms = ?, auth_status = 'active', last_error = NULL, updated_at_ms = ? WHERE upstream_key_id = ?",
                )
                .bind(quota_json)
                .bind(now_ms)
                .bind(now_ms)
                .bind(key_id)
                .execute(pool)
                .await?;
            }
            Database::Postgres(pool) => {
                sqlx::query(
                    "UPDATE codex_oauth_accounts SET quota_json = $1, quota_checked_at_ms = $2, auth_status = 'active', last_error = NULL, updated_at_ms = $3 WHERE upstream_key_id = $4",
                )
                .bind(quota_json)
                .bind(now_ms)
                .bind(now_ms)
                .bind(key_id)
                .execute(pool)
                .await?;
            }
        }
        Ok(())
    }

    pub async fn update_codex_temporary_error(
        &self,
        key_id: i64,
        error: &str,
        now_ms: i64,
    ) -> Result<(), DbError> {
        let error = sanitize_persisted_error(error);
        match self {
            Database::Sqlite(pool) => {
                sqlx::query(
                    "UPDATE codex_oauth_accounts SET last_error = ?, updated_at_ms = ? WHERE upstream_key_id = ?",
                )
                .bind(error)
                .bind(now_ms)
                .bind(key_id)
                .execute(pool)
                .await?;
            }
            Database::Postgres(pool) => {
                sqlx::query(
                    "UPDATE codex_oauth_accounts SET last_error = $1, updated_at_ms = $2 WHERE upstream_key_id = $3",
                )
                .bind(error)
                .bind(now_ms)
                .bind(key_id)
                .execute(pool)
                .await?;
            }
        }
        Ok(())
    }
}

fn decode_sqlite_account(
    master_key: &str,
    row: &sqlx::sqlite::SqliteRow,
) -> Result<CodexOAuthAccount, DbError> {
    decode_account_fields(
        master_key,
        row.get("upstream_key_id"),
        row.get("provider_id"),
        row.get("account_hash"),
        row.get("secret_enc"),
        row.get("credentials_enc"),
        row.get("plan_type"),
        row.get("token_expires_at_ms"),
        row.get("last_refresh_at_ms"),
        row.get("auth_status"),
        row.get("last_error"),
        row.get("quota_json"),
        row.get("quota_checked_at_ms"),
        row.get("refresh_lease_owner"),
        row.get("refresh_lease_until_ms"),
        row.get("created_at_ms"),
        row.get("updated_at_ms"),
    )
}

fn decode_postgres_account(
    master_key: &str,
    row: &sqlx::postgres::PgRow,
) -> Result<CodexOAuthAccount, DbError> {
    decode_account_fields(
        master_key,
        row.get("upstream_key_id"),
        row.get("provider_id"),
        row.get("account_hash"),
        row.get("secret_enc"),
        row.get("credentials_enc"),
        row.get("plan_type"),
        row.get("token_expires_at_ms"),
        row.get("last_refresh_at_ms"),
        row.get("auth_status"),
        row.get("last_error"),
        row.get("quota_json"),
        row.get("quota_checked_at_ms"),
        row.get("refresh_lease_owner"),
        row.get("refresh_lease_until_ms"),
        row.get("created_at_ms"),
        row.get("updated_at_ms"),
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "the decoder mirrors the additive OAuth account table without exposing raw SQL rows"
)]
fn decode_account_fields(
    master_key: &str,
    upstream_key_id: i64,
    provider_id: i64,
    _account_hash: String,
    secret_enc: String,
    credentials_enc: String,
    plan_type: Option<String>,
    token_expires_at_ms: Option<i64>,
    last_refresh_at_ms: Option<i64>,
    auth_status: String,
    last_error: Option<String>,
    quota_json: Option<String>,
    quota_checked_at_ms: Option<i64>,
    _refresh_lease_owner: Option<String>,
    refresh_lease_until_ms: Option<i64>,
    _created_at_ms: i64,
    _updated_at_ms: i64,
) -> Result<CodexOAuthAccount, DbError> {
    let access_token = crypto::decrypt_secret(master_key, &secret_enc)
        .map_err(|error| DbError::new(format!("decrypt Codex access token failed: {error}")))?;
    let credentials_json = crypto::decrypt_secret(master_key, &credentials_enc)
        .map_err(|error| DbError::new(format!("decrypt Codex credentials failed: {error}")))?;
    let credentials = serde_json::from_str(&credentials_json)
        .map_err(|error| DbError::new(format!("decode Codex credentials failed: {error}")))?;
    let quota = quota_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| DbError::new(format!("decode Codex quota failed: {error}")))?;
    Ok(CodexOAuthAccount {
        upstream_key_id,
        provider_id,
        access_token,
        credentials,
        plan_type,
        token_expires_at_ms,
        last_refresh_at_ms,
        auth_status,
        last_error,
        quota,
        quota_checked_at_ms,
        refresh_lease_until_ms,
    })
}

async fn save_codex_login_sqlite(
    pool: &SqlitePool,
    input: &SaveCodexLogin<'_>,
    default_name: &str,
    access_token_enc: &str,
    credentials_enc: &str,
) -> Result<SaveCodexLoginResult, DbError> {
    let mut tx = pool.begin().await?;
    let existing_key_id = sqlx::query(
        "SELECT upstream_key_id FROM codex_oauth_accounts WHERE provider_id = ? AND account_hash = ?",
    )
    .bind(input.provider_id)
    .bind(input.account_hash)
    .fetch_optional(&mut *tx)
    .await?
    .map(|row| row.get::<i64, _>("upstream_key_id"));

    let (key_id, operation) = if let Some(replace_key_id) = input.replace_key_id {
        let owner = sqlx::query("SELECT provider_id FROM upstream_keys WHERE id = ?")
            .bind(replace_key_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(owner) = owner else {
            return Err(DbError::new("replacement upstream key not found"));
        };
        if owner.get::<i64, _>("provider_id") != input.provider_id {
            return Err(DbError::new(
                "replacement upstream key belongs to another provider",
            ));
        }
        if existing_key_id.is_some_and(|existing| existing != replace_key_id) {
            return Err(DbError::new(
                "Codex account is already attached to another key",
            ));
        }
        (replace_key_id, CodexLoginOperation::Updated)
    } else if let Some(existing_key_id) = existing_key_id {
        (existing_key_id, CodexLoginOperation::Updated)
    } else {
        let inserted = sqlx::query(
            r#"
INSERT INTO upstream_keys (provider_id, name, secret_enc, enabled, priority, weight, created_at_ms, updated_at_ms)
VALUES (?, ?, ?, 1, 100, 1, ?, ?)
"#,
        )
        .bind(input.provider_id)
        .bind(default_name)
        .bind(access_token_enc)
        .bind(input.now_ms)
        .bind(input.now_ms)
        .execute(&mut *tx)
        .await?;
        (inserted.last_insert_rowid(), CodexLoginOperation::Created)
    };

    sqlx::query("UPDATE upstream_keys SET secret_enc = ?, updated_at_ms = ? WHERE id = ?")
        .bind(access_token_enc)
        .bind(input.now_ms)
        .bind(key_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"
INSERT INTO codex_oauth_accounts (
  upstream_key_id, provider_id, account_hash, credentials_enc, plan_type,
  token_expires_at_ms, last_refresh_at_ms, auth_status, last_error,
  quota_json, quota_checked_at_ms, refresh_lease_owner, refresh_lease_until_ms,
  created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, NULL, NULL, ?, ?)
ON CONFLICT(upstream_key_id) DO UPDATE SET
  provider_id = excluded.provider_id,
  account_hash = excluded.account_hash,
  credentials_enc = excluded.credentials_enc,
  plan_type = excluded.plan_type,
  token_expires_at_ms = excluded.token_expires_at_ms,
  last_refresh_at_ms = excluded.last_refresh_at_ms,
  auth_status = 'active',
  last_error = NULL,
  refresh_lease_owner = NULL,
  refresh_lease_until_ms = NULL,
  updated_at_ms = excluded.updated_at_ms
"#,
    )
    .bind(key_id)
    .bind(input.provider_id)
    .bind(input.account_hash)
    .bind(credentials_enc)
    .bind(input.plan_type)
    .bind(input.token_expires_at_ms)
    .bind(input.now_ms)
    .bind(input.now_ms)
    .bind(input.now_ms)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(SaveCodexLoginResult { key_id, operation })
}

async fn save_codex_login_postgres(
    pool: &PgPool,
    input: &SaveCodexLogin<'_>,
    default_name: &str,
    access_token_enc: &str,
    credentials_enc: &str,
) -> Result<SaveCodexLoginResult, DbError> {
    let mut tx = pool.begin().await?;
    let existing_key_id = sqlx::query(
        "SELECT upstream_key_id FROM codex_oauth_accounts WHERE provider_id = $1 AND account_hash = $2",
    )
    .bind(input.provider_id)
    .bind(input.account_hash)
    .fetch_optional(&mut *tx)
    .await?
    .map(|row| row.get::<i64, _>("upstream_key_id"));

    let (key_id, operation) = if let Some(replace_key_id) = input.replace_key_id {
        let owner = sqlx::query("SELECT provider_id FROM upstream_keys WHERE id = $1")
            .bind(replace_key_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(owner) = owner else {
            return Err(DbError::new("replacement upstream key not found"));
        };
        if owner.get::<i64, _>("provider_id") != input.provider_id {
            return Err(DbError::new(
                "replacement upstream key belongs to another provider",
            ));
        }
        if existing_key_id.is_some_and(|existing| existing != replace_key_id) {
            return Err(DbError::new(
                "Codex account is already attached to another key",
            ));
        }
        (replace_key_id, CodexLoginOperation::Updated)
    } else if let Some(existing_key_id) = existing_key_id {
        (existing_key_id, CodexLoginOperation::Updated)
    } else {
        let row = sqlx::query(
            r#"
INSERT INTO upstream_keys (provider_id, name, secret_enc, enabled, priority, weight, created_at_ms, updated_at_ms)
VALUES ($1, $2, $3, TRUE, 100, 1, $4, $4)
RETURNING id
"#,
        )
        .bind(input.provider_id)
        .bind(default_name)
        .bind(access_token_enc)
        .bind(input.now_ms)
        .fetch_one(&mut *tx)
        .await?;
        (row.get::<i64, _>("id"), CodexLoginOperation::Created)
    };

    sqlx::query("UPDATE upstream_keys SET secret_enc = $1, updated_at_ms = $2 WHERE id = $3")
        .bind(access_token_enc)
        .bind(input.now_ms)
        .bind(key_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"
INSERT INTO codex_oauth_accounts (
  upstream_key_id, provider_id, account_hash, credentials_enc, plan_type,
  token_expires_at_ms, last_refresh_at_ms, auth_status, last_error,
  quota_json, quota_checked_at_ms, refresh_lease_owner, refresh_lease_until_ms,
  created_at_ms, updated_at_ms
) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL, NULL, NULL, NULL, NULL, $7, $7)
ON CONFLICT(upstream_key_id) DO UPDATE SET
  provider_id = EXCLUDED.provider_id,
  account_hash = EXCLUDED.account_hash,
  credentials_enc = EXCLUDED.credentials_enc,
  plan_type = EXCLUDED.plan_type,
  token_expires_at_ms = EXCLUDED.token_expires_at_ms,
  last_refresh_at_ms = EXCLUDED.last_refresh_at_ms,
  auth_status = 'active',
  last_error = NULL,
  refresh_lease_owner = NULL,
  refresh_lease_until_ms = NULL,
  updated_at_ms = EXCLUDED.updated_at_ms
"#,
    )
    .bind(key_id)
    .bind(input.provider_id)
    .bind(input.account_hash)
    .bind(credentials_enc)
    .bind(input.plan_type)
    .bind(input.token_expires_at_ms)
    .bind(input.now_ms)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(SaveCodexLoginResult { key_id, operation })
}

pub(crate) async fn migrate_sqlite(pool: &SqlitePool) -> Result<(), DbError> {
    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS codex_oauth_accounts (
  upstream_key_id INTEGER PRIMARY KEY,
  provider_id INTEGER NOT NULL,
  account_hash TEXT NOT NULL,
  credentials_enc TEXT NOT NULL,
  plan_type TEXT,
  token_expires_at_ms INTEGER,
  last_refresh_at_ms INTEGER,
  auth_status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  quota_json TEXT,
  quota_checked_at_ms INTEGER,
  refresh_lease_owner TEXT,
  refresh_lease_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY(upstream_key_id) REFERENCES upstream_keys(id) ON DELETE CASCADE,
  FOREIGN KEY(provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE,
  UNIQUE(provider_id, account_hash)
);
CREATE INDEX IF NOT EXISTS idx_codex_oauth_accounts_provider ON codex_oauth_accounts(provider_id);
CREATE INDEX IF NOT EXISTS idx_codex_oauth_accounts_refresh_lease ON codex_oauth_accounts(refresh_lease_until_ms);
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn migrate_postgres(pool: &PgPool) -> Result<(), DbError> {
    sqlx::query(
        r#"
CREATE TABLE IF NOT EXISTS codex_oauth_accounts (
  upstream_key_id BIGINT PRIMARY KEY REFERENCES upstream_keys(id) ON DELETE CASCADE,
  provider_id BIGINT NOT NULL REFERENCES upstream_providers(id) ON DELETE CASCADE,
  account_hash TEXT NOT NULL,
  credentials_enc TEXT NOT NULL,
  plan_type TEXT,
  token_expires_at_ms BIGINT,
  last_refresh_at_ms BIGINT,
  auth_status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  quota_json TEXT,
  quota_checked_at_ms BIGINT,
  refresh_lease_owner TEXT,
  refresh_lease_until_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  UNIQUE(provider_id, account_hash)
);
CREATE INDEX IF NOT EXISTS idx_codex_oauth_accounts_provider ON codex_oauth_accounts(provider_id);
CREATE INDEX IF NOT EXISTS idx_codex_oauth_accounts_refresh_lease ON codex_oauth_accounts(refresh_lease_until_ms);
"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionStatus {
    Pending,
    Completed,
    Failed,
    Cancelled,
    Expired,
}

impl SessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
        }
    }

    fn terminal(self) -> bool {
        self != Self::Pending
    }
}

struct SessionRecord {
    session_id: String,
    provider_id: i64,
    replace_key_id: Option<i64>,
    device_auth_id: String,
    user_code: String,
    poll_interval_ms: i64,
    expires_at_ms: i64,
    terminal_at_ms: Option<i64>,
    status: SessionStatus,
    cancel_requested: Arc<AtomicBool>,
    save_gate: Arc<AsyncMutex<()>>,
    key_id: Option<i64>,
    operation: Option<CodexLoginOperation>,
    warnings: Vec<String>,
    error_code: Option<String>,
    error_message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CodexOAuthSessionView {
    pub session_id: String,
    pub status: String,
    pub verification_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    pub expires_at_ms: i64,
    pub poll_interval_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Clone)]
pub struct CodexOAuthManager {
    sessions: Arc<Mutex<HashMap<String, SessionRecord>>>,
    starting_targets: StartingTargets,
    refresh_locks: Arc<Mutex<HashMap<i64, Arc<AsyncMutex<()>>>>>,
}

type SessionTarget = (i64, Option<i64>);
type StartingTargets = Arc<Mutex<HashSet<SessionTarget>>>;

#[derive(Debug)]
struct StartingTargetGuard {
    targets: StartingTargets,
    target: SessionTarget,
    armed: bool,
}

impl StartingTargetGuard {
    fn new(targets: StartingTargets, target: SessionTarget) -> Self {
        Self {
            targets,
            target,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StartingTargetGuard {
    fn drop(&mut self) {
        if self.armed {
            self.targets.lock().remove(&self.target);
        }
    }
}

impl CodexOAuthManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            starting_targets: Arc::new(Mutex::new(HashSet::new())),
            refresh_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start_session(
        &self,
        state: SharedState,
        provider_id: i64,
        replace_key_id: Option<i64>,
    ) -> Result<CodexOAuthSessionView, CodexOAuthError> {
        let now_ms = util::now_ms();
        self.prune_sessions(now_ms);
        let target = (provider_id, replace_key_id);
        let mut starting_guard = self.reserve_starting_target(target)?;

        let started = async {
            let response = request_device_user_code(&state).await?;
            let user_code = response
                .user_code
                .or(response.user_code_alt)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    CodexOAuthError::upstream(
                        "device_code_invalid",
                        "device code response did not include a user code",
                    )
                })?;
            let device_auth_id = response.device_auth_id.trim().to_string();
            if device_auth_id.is_empty() {
                return Err(CodexOAuthError::upstream(
                    "device_code_invalid",
                    "device code response did not include a device auth id",
                ));
            }
            let poll_interval_ms = parse_poll_interval_ms(response.interval.as_ref());
            let session_id = util::new_ulid();
            let record = SessionRecord {
                session_id: session_id.clone(),
                provider_id,
                replace_key_id,
                device_auth_id,
                user_code,
                poll_interval_ms,
                expires_at_ms: now_ms.saturating_add(DEVICE_SESSION_TTL_MS),
                terminal_at_ms: None,
                status: SessionStatus::Pending,
                cancel_requested: Arc::new(AtomicBool::new(false)),
                save_gate: Arc::new(AsyncMutex::new(())),
                key_id: None,
                operation: None,
                warnings: Vec::new(),
                error_code: None,
                error_message: None,
            };
            let view = session_view(&record, true);
            Ok::<_, CodexOAuthError>((session_id, record, view))
        }
        .await;
        let (session_id, record, view) = match started {
            Ok(started) => started,
            Err(error) => return Err(error),
        };
        {
            let mut starting_targets = self.starting_targets.lock();
            self.sessions.lock().insert(session_id.clone(), record);
            starting_targets.remove(&target);
        }
        starting_guard.disarm();

        let manager = self.clone();
        tokio::spawn(async move {
            manager.run_session(state, session_id).await;
        });
        Ok(view)
    }

    fn reserve_starting_target(
        &self,
        target: SessionTarget,
    ) -> Result<StartingTargetGuard, CodexOAuthError> {
        let mut starting_targets = self.starting_targets.lock();
        let sessions = self.sessions.lock();
        if starting_targets.contains(&target)
            || sessions.values().any(|session| {
                session.status == SessionStatus::Pending
                    && (session.provider_id, session.replace_key_id) == target
            })
        {
            return Err(CodexOAuthError::conflict(
                "oauth_session_in_progress",
                "an OAuth session is already active for this target",
            ));
        }
        starting_targets.insert(target);
        Ok(StartingTargetGuard::new(
            self.starting_targets.clone(),
            target,
        ))
    }

    pub async fn get_session(&self, session_id: &str) -> Option<CodexOAuthSessionView> {
        let now_ms = util::now_ms();
        self.prune_sessions(now_ms);
        let save_gate = self.session_save_gate(session_id)?;
        let _save_guard = save_gate.lock().await;
        let mut sessions = self.sessions.lock();
        let record = sessions.get_mut(session_id)?;
        if record.status == SessionStatus::Pending && now_ms >= record.expires_at_ms {
            record.status = SessionStatus::Expired;
            record.terminal_at_ms = Some(now_ms);
            record.error_code = Some("oauth_session_expired".to_string());
            record.error_message = Some("the device login session expired".to_string());
            record.cancel_requested.store(true, Ordering::SeqCst);
        }
        Some(session_view(record, true))
    }

    pub async fn cancel_session(&self, session_id: &str) -> bool {
        let now_ms = util::now_ms();
        self.prune_sessions(now_ms);
        let Some(save_gate) = self.session_save_gate(session_id) else {
            return false;
        };
        let _save_guard = save_gate.lock().await;
        let mut sessions = self.sessions.lock();
        let Some(record) = sessions.get_mut(session_id) else {
            return false;
        };
        record.cancel_requested.store(true, Ordering::SeqCst);
        if record.status == SessionStatus::Pending {
            record.status = SessionStatus::Cancelled;
            record.terminal_at_ms = Some(now_ms);
            record.error_code = None;
            record.error_message = None;
        }
        true
    }

    fn session_save_gate(&self, session_id: &str) -> Option<Arc<AsyncMutex<()>>> {
        self.sessions
            .lock()
            .get(session_id)
            .map(|record| record.save_gate.clone())
    }

    fn prune_sessions(&self, now_ms: i64) {
        self.sessions.lock().retain(|_, session| {
            if !session.status.terminal() {
                return now_ms
                    < session
                        .expires_at_ms
                        .saturating_add(DEVICE_SESSION_TOMBSTONE_MS);
            }
            session.terminal_at_ms.is_none_or(|terminal| {
                now_ms < terminal.saturating_add(DEVICE_SESSION_TOMBSTONE_MS)
            })
        });
    }

    async fn run_session(&self, state: SharedState, session_id: String) {
        let token = loop {
            let Some(snapshot) = self.session_poll_snapshot(&session_id) else {
                return;
            };
            if snapshot.cancel_requested.load(Ordering::SeqCst) {
                return;
            }
            if util::now_ms() >= snapshot.expires_at_ms {
                self.mark_session_error(
                    &session_id,
                    SessionStatus::Expired,
                    "oauth_session_expired",
                    "the device login session expired",
                );
                return;
            }

            match poll_device_token(&state, &snapshot.device_auth_id, &snapshot.user_code).await {
                Ok(DevicePoll::Pending) => {
                    tokio::time::sleep(Duration::from_millis(
                        snapshot.poll_interval_ms.max(1) as u64
                    ))
                    .await;
                }
                Ok(DevicePoll::Ready(token)) => break token,
                Err(error) => {
                    self.mark_session_error(
                        &session_id,
                        SessionStatus::Failed,
                        error.code,
                        &error.message,
                    );
                    return;
                }
            }
        };

        if self.session_cancelled(&session_id) {
            return;
        }
        let token_bundle = match exchange_device_code(&state, &token).await {
            Ok(bundle) => bundle,
            Err(error) => {
                self.mark_session_error(
                    &session_id,
                    SessionStatus::Failed,
                    error.code,
                    &error.message,
                );
                return;
            }
        };
        if self.session_cancelled(&session_id) {
            return;
        }
        let claims = match parse_id_token(&token_bundle.id_token) {
            Ok(claims) => claims,
            Err(error) => {
                self.mark_session_error(
                    &session_id,
                    SessionStatus::Failed,
                    error.code,
                    &error.message,
                );
                return;
            }
        };
        if claims.account_id.trim().is_empty() {
            self.mark_session_error(
                &session_id,
                SessionStatus::Failed,
                "account_claim_missing",
                "the ID token did not include a ChatGPT account id",
            );
            return;
        }
        let Some(save_gate) = self.session_save_gate(&session_id) else {
            return;
        };
        let _save_guard = save_gate.lock().await;
        if self.session_cancelled(&session_id) {
            return;
        }
        let Some(target) = self.session_target(&session_id) else {
            return;
        };
        let now_ms = util::now_ms();
        let account_hash =
            crypto::hash_codex_account(&state.config.master_key, claims.account_id.trim());
        let saved = state
            .db
            .save_codex_oauth_login(
                &state.config.master_key,
                SaveCodexLogin {
                    provider_id: target.0,
                    replace_key_id: target.1,
                    account_hash: &account_hash,
                    access_token: &token_bundle.access_token,
                    refresh_token: &token_bundle.refresh_token,
                    id_token: &token_bundle.id_token,
                    account_id: claims.account_id.trim(),
                    email: claims.email.trim(),
                    plan_type: claims.plan_type.as_deref(),
                    token_expires_at_ms: Some(
                        now_ms
                            .saturating_add(token_bundle.expires_in_seconds.saturating_mul(1_000)),
                    ),
                    now_ms,
                },
            )
            .await;
        let saved = match saved {
            Ok(saved) => saved,
            Err(error) => {
                self.mark_session_error(
                    &session_id,
                    SessionStatus::Failed,
                    "credential_save_failed",
                    &sanitize_persisted_error(&error.to_string()),
                );
                return;
            }
        };
        state.caches.upstream.invalidate();

        let mut warnings = Vec::new();
        if let Err(error) = self.refresh_quota(&state, saved.key_id).await {
            warnings.push(format!("quota: {}", error.message));
        }
        match self.fetch_models(&state, saved.key_id).await {
            Ok(models) => {
                if let Err(error) = state
                    .db
                    .upsert_provider_models(target.0, &models, util::now_ms())
                    .await
                {
                    warnings.push(format!(
                        "models: {}",
                        sanitize_persisted_error(&error.to_string())
                    ));
                } else {
                    state.caches.upstream.invalidate();
                }
            }
            Err(error) => warnings.push(format!("models: {}", error.message)),
        }
        self.mark_session_completed(&session_id, saved, warnings);
    }

    fn session_poll_snapshot(&self, session_id: &str) -> Option<SessionPollSnapshot> {
        let sessions = self.sessions.lock();
        let record = sessions.get(session_id)?;
        (record.status == SessionStatus::Pending).then(|| SessionPollSnapshot {
            device_auth_id: record.device_auth_id.clone(),
            user_code: record.user_code.clone(),
            poll_interval_ms: record.poll_interval_ms,
            expires_at_ms: record.expires_at_ms,
            cancel_requested: record.cancel_requested.clone(),
        })
    }

    fn session_target(&self, session_id: &str) -> Option<(i64, Option<i64>)> {
        let sessions = self.sessions.lock();
        let record = sessions.get(session_id)?;
        Some((record.provider_id, record.replace_key_id))
    }

    fn session_cancelled(&self, session_id: &str) -> bool {
        let sessions = self.sessions.lock();
        sessions.get(session_id).is_none_or(|record| {
            record.status != SessionStatus::Pending
                || record.cancel_requested.load(Ordering::SeqCst)
        })
    }

    fn mark_session_error(
        &self,
        session_id: &str,
        status: SessionStatus,
        code: &str,
        message: &str,
    ) {
        let mut sessions = self.sessions.lock();
        let Some(record) = sessions.get_mut(session_id) else {
            return;
        };
        if record.status != SessionStatus::Pending {
            return;
        }
        record.status = status;
        record.terminal_at_ms = Some(util::now_ms());
        record.error_code = Some(code.to_string());
        record.error_message = Some(sanitize_persisted_error(message));
    }

    fn mark_session_completed(
        &self,
        session_id: &str,
        saved: SaveCodexLoginResult,
        warnings: Vec<String>,
    ) {
        let mut sessions = self.sessions.lock();
        let Some(record) = sessions.get_mut(session_id) else {
            return;
        };
        if record.status != SessionStatus::Pending || record.cancel_requested.load(Ordering::SeqCst)
        {
            return;
        }
        record.status = SessionStatus::Completed;
        record.terminal_at_ms = Some(util::now_ms());
        record.key_id = Some(saved.key_id);
        record.operation = Some(saved.operation);
        record.warnings = warnings;
    }

    fn refresh_lock(&self, key_id: i64) -> Arc<AsyncMutex<()>> {
        self.refresh_locks
            .lock()
            .entry(key_id)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    pub async fn prepare_auth(
        &self,
        state: &SharedState,
        key_id: i64,
        force_refresh: bool,
    ) -> Result<PreparedCodexAuth, CodexOAuthError> {
        self.prepare_auth_with_status(state, key_id, force_refresh, false)
            .await
    }

    async fn prepare_auth_for_quota(
        &self,
        state: &SharedState,
        key_id: i64,
        force_refresh: bool,
    ) -> Result<PreparedCodexAuth, CodexOAuthError> {
        self.prepare_auth_with_status(state, key_id, force_refresh, true)
            .await
    }

    async fn prepare_auth_with_status(
        &self,
        state: &SharedState,
        key_id: i64,
        force_refresh: bool,
        allow_forbidden: bool,
    ) -> Result<PreparedCodexAuth, CodexOAuthError> {
        let local_lock = self.refresh_lock(key_id);
        let _guard = local_lock.lock().await;
        let mut account = self.load_account(state, key_id, allow_forbidden).await?;
        let now_ms = util::now_ms();
        let still_valid = account
            .token_expires_at_ms
            .is_none_or(|expires| expires > now_ms.saturating_add(REFRESH_LEEWAY_MS));
        if !force_refresh && still_valid {
            return Ok(prepared_auth(&account));
        }
        if account.credentials.refresh_token.trim().is_empty() {
            state
                .db
                .update_codex_auth_status(
                    key_id,
                    AUTH_STATUS_REAUTH_REQUIRED,
                    Some("refresh token is missing"),
                    now_ms,
                )
                .await
                .map_err(CodexOAuthError::database)?;
            state.caches.upstream.invalidate();
            return Err(CodexOAuthError::reauth(
                "refresh_token_missing",
                "the account must be signed in again",
            ));
        }

        let lease_owner = util::new_ulid();
        let mut acquired = state
            .db
            .try_acquire_codex_refresh_lease(
                key_id,
                &lease_owner,
                now_ms.saturating_add(REFRESH_LEASE_MS),
                now_ms,
            )
            .await
            .map_err(CodexOAuthError::database)?;
        if !acquired {
            for _ in 0..REFRESH_LEASE_WAIT_ATTEMPTS {
                tokio::time::sleep(REFRESH_LEASE_WAIT).await;
                account = self.load_account(state, key_id, allow_forbidden).await?;
                let current = util::now_ms();
                if account
                    .token_expires_at_ms
                    .is_some_and(|expires| expires > current.saturating_add(REFRESH_LEEWAY_MS))
                {
                    return Ok(prepared_auth(&account));
                }
                if account
                    .refresh_lease_until_ms
                    .is_none_or(|until| until <= current)
                {
                    acquired = state
                        .db
                        .try_acquire_codex_refresh_lease(
                            key_id,
                            &lease_owner,
                            current.saturating_add(REFRESH_LEASE_MS),
                            current,
                        )
                        .await
                        .map_err(CodexOAuthError::database)?;
                    if acquired {
                        break;
                    }
                }
            }
        }
        if !acquired {
            return Err(CodexOAuthError::temporary(
                "refresh_in_progress",
                "another gateway instance is refreshing this account",
            ));
        }

        let refreshed = refresh_tokens(state, &account.credentials.refresh_token).await;
        let refreshed = match refreshed {
            Ok(refreshed) => refreshed,
            Err(error) => {
                let _ = state
                    .db
                    .release_codex_refresh_lease(key_id, &lease_owner, util::now_ms())
                    .await;
                if error.reauth_required {
                    let _ = state
                        .db
                        .update_codex_auth_status(
                            key_id,
                            AUTH_STATUS_REAUTH_REQUIRED,
                            Some(&error.message),
                            util::now_ms(),
                        )
                        .await;
                    state.caches.upstream.invalidate();
                }
                return Err(error);
            }
        };

        let claims = refreshed
            .id_token
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(parse_id_token)
            .transpose()?;
        let credentials = CodexOAuthCredentials {
            refresh_token: refreshed
                .refresh_token
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| account.credentials.refresh_token.clone()),
            id_token: refreshed
                .id_token
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| account.credentials.id_token.clone()),
            account_id: account.credentials.account_id.clone(),
            email: claims
                .as_ref()
                .map(|claims| claims.email.clone())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| account.credentials.email.clone()),
        };
        let plan_type = claims
            .as_ref()
            .and_then(|claims| claims.plan_type.as_deref())
            .or(account.plan_type.as_deref());
        let refreshed_at_ms = util::now_ms();
        let expires_at_ms = Some(
            refreshed_at_ms
                .saturating_add(refreshed.expires_in_seconds.max(1).saturating_mul(1_000)),
        );
        let preserved_auth_status = account.auth_status.clone();
        let preserved_last_error = (preserved_auth_status != AUTH_STATUS_ACTIVE)
            .then_some(account.last_error.as_deref())
            .flatten();
        let persisted = state
            .db
            .persist_codex_token_refresh(
                &state.config.master_key,
                key_id,
                &lease_owner,
                &refreshed.access_token,
                &credentials,
                plan_type,
                expires_at_ms,
                &preserved_auth_status,
                preserved_last_error,
                refreshed_at_ms,
            )
            .await
            .map_err(CodexOAuthError::database)?;
        if !persisted {
            return Err(CodexOAuthError::temporary(
                "refresh_lease_lost",
                "the account refresh lease was lost before credentials were saved",
            ));
        }
        state.caches.upstream.invalidate();
        account = self.load_account(state, key_id, allow_forbidden).await?;
        Ok(prepared_auth(&account))
    }

    async fn load_account(
        &self,
        state: &SharedState,
        key_id: i64,
        allow_forbidden: bool,
    ) -> Result<CodexOAuthAccount, CodexOAuthError> {
        let account = state
            .db
            .find_codex_oauth_account(&state.config.master_key, key_id)
            .await
            .map_err(CodexOAuthError::database)?
            .ok_or_else(|| {
                CodexOAuthError::reauth(
                    "oauth_metadata_missing",
                    "this legacy Codex key must be signed in again",
                )
            })?;
        match account.auth_status.as_str() {
            AUTH_STATUS_ACTIVE => Ok(account),
            AUTH_STATUS_FORBIDDEN if allow_forbidden => Ok(account),
            AUTH_STATUS_FORBIDDEN => Err(CodexOAuthError::forbidden(
                "account_forbidden",
                "the Codex account is not currently entitled to use the service",
            )),
            _ => Err(CodexOAuthError::reauth(
                "reauth_required",
                "the Codex account must be signed in again",
            )),
        }
    }

    pub async fn refresh_quota(
        &self,
        state: &SharedState,
        key_id: i64,
    ) -> Result<CodexOAuthAccountView, CodexOAuthError> {
        let mut auth = self.prepare_auth_for_quota(state, key_id, false).await?;
        let mut response = request_quota(state, &auth).await?;
        if response.0 == StatusCode::UNAUTHORIZED {
            auth = self.prepare_auth_for_quota(state, key_id, true).await?;
            response = request_quota(state, &auth).await?;
        }
        let now_ms = util::now_ms();
        match response.0 {
            StatusCode::OK => {
                let quota = parse_quota_snapshot(&response.1, now_ms)?;
                state
                    .db
                    .update_codex_quota_success(key_id, &quota, now_ms)
                    .await
                    .map_err(CodexOAuthError::database)?;
                if let Some(until) = quota.blocked_until_ms(now_ms) {
                    state.quota.set_cooldown_until(key_id, until, now_ms);
                } else {
                    state.quota.clear_cooldown(key_id, now_ms);
                }
                state.caches.upstream.invalidate();
            }
            StatusCode::UNAUTHORIZED => {
                state
                    .db
                    .update_codex_auth_status(
                        key_id,
                        AUTH_STATUS_REAUTH_REQUIRED,
                        Some("upstream rejected the refreshed access token"),
                        now_ms,
                    )
                    .await
                    .map_err(CodexOAuthError::database)?;
                state.caches.upstream.invalidate();
                return Err(CodexOAuthError::reauth(
                    "access_token_rejected",
                    "the Codex account must be signed in again",
                ));
            }
            StatusCode::FORBIDDEN => {
                state
                    .db
                    .update_codex_auth_status(
                        key_id,
                        AUTH_STATUS_FORBIDDEN,
                        Some("the quota endpoint returned 403"),
                        now_ms,
                    )
                    .await
                    .map_err(CodexOAuthError::database)?;
                state.caches.upstream.invalidate();
                return Err(CodexOAuthError::forbidden(
                    "quota_forbidden",
                    "the Codex quota endpoint denied this account",
                ));
            }
            status => {
                let message = format!("quota endpoint returned status {}", status.as_u16());
                let _ = state
                    .db
                    .update_codex_temporary_error(key_id, &message, now_ms)
                    .await;
                return Err(CodexOAuthError::temporary("quota_request_failed", message));
            }
        }

        let account = state
            .db
            .find_codex_oauth_account(&state.config.master_key, key_id)
            .await
            .map_err(CodexOAuthError::database)?
            .ok_or_else(|| {
                CodexOAuthError::database(DbError::new("Codex OAuth account disappeared"))
            })?;
        Ok(CodexOAuthAccountView::from(&account))
    }

    pub async fn fetch_models(
        &self,
        state: &SharedState,
        key_id: i64,
    ) -> Result<Vec<String>, CodexOAuthError> {
        let mut auth = self.prepare_auth(state, key_id, false).await?;
        let mut response = request_models(state, &auth).await?;
        if response.0 == StatusCode::UNAUTHORIZED {
            auth = self.prepare_auth(state, key_id, true).await?;
            response = request_models(state, &auth).await?;
        }
        if response.0 == StatusCode::UNAUTHORIZED {
            state
                .db
                .update_codex_auth_status(
                    key_id,
                    AUTH_STATUS_REAUTH_REQUIRED,
                    Some("model endpoint rejected the refreshed access token"),
                    util::now_ms(),
                )
                .await
                .map_err(CodexOAuthError::database)?;
            state.caches.upstream.invalidate();
            return Err(CodexOAuthError::reauth(
                "access_token_rejected",
                "the Codex account must be signed in again",
            ));
        }
        if response.0 != StatusCode::OK {
            return Err(CodexOAuthError::upstream(
                "models_request_failed",
                format!("models endpoint returned status {}", response.0.as_u16()),
            ));
        }
        parse_model_ids(&response.1)
    }
}

impl Default for CodexOAuthManager {
    fn default() -> Self {
        Self::new()
    }
}

struct SessionPollSnapshot {
    device_auth_id: String,
    user_code: String,
    poll_interval_ms: i64,
    expires_at_ms: i64,
    cancel_requested: Arc<AtomicBool>,
}

fn session_view(record: &SessionRecord, include_user_code: bool) -> CodexOAuthSessionView {
    CodexOAuthSessionView {
        session_id: record.session_id.clone(),
        status: record.status.as_str().to_string(),
        verification_uri: DEVICE_VERIFICATION_URI.to_string(),
        user_code: include_user_code.then(|| record.user_code.clone()),
        expires_at_ms: record.expires_at_ms,
        poll_interval_ms: record.poll_interval_ms,
        key_id: record.key_id,
        operation: record
            .operation
            .map(|operation| operation.as_str().to_string()),
        warnings: record.warnings.clone(),
        error_code: record.error_code.clone(),
        error_message: record.error_message.clone(),
    }
}

pub struct PreparedCodexAuth {
    pub access_token: String,
    pub account_id: String,
}

fn prepared_auth(account: &CodexOAuthAccount) -> PreparedCodexAuth {
    PreparedCodexAuth {
        access_token: account.access_token.clone(),
        account_id: account.credentials.account_id.clone(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexOAuthErrorKind {
    BadRequest,
    Conflict,
    Temporary,
    Upstream,
    ReauthRequired,
    Forbidden,
    Database,
}

#[derive(Clone, Debug)]
pub struct CodexOAuthError {
    pub code: &'static str,
    pub message: String,
    pub kind: CodexOAuthErrorKind,
    pub reauth_required: bool,
}

impl CodexOAuthError {
    fn new(code: &'static str, message: impl Into<String>, kind: CodexOAuthErrorKind) -> Self {
        Self {
            code,
            message: sanitize_persisted_error(&message.into()),
            kind,
            reauth_required: kind == CodexOAuthErrorKind::ReauthRequired,
        }
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message, CodexOAuthErrorKind::BadRequest)
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message, CodexOAuthErrorKind::Conflict)
    }

    pub fn temporary(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message, CodexOAuthErrorKind::Temporary)
    }

    pub fn upstream(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message, CodexOAuthErrorKind::Upstream)
    }

    pub fn reauth(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message, CodexOAuthErrorKind::ReauthRequired)
    }

    pub fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message, CodexOAuthErrorKind::Forbidden)
    }

    pub fn database(error: DbError) -> Self {
        Self::new(
            "oauth_database_error",
            error.to_string(),
            CodexOAuthErrorKind::Database,
        )
    }

    pub fn http_status(&self) -> StatusCode {
        match self.kind {
            CodexOAuthErrorKind::BadRequest => StatusCode::BAD_REQUEST,
            CodexOAuthErrorKind::Conflict => StatusCode::CONFLICT,
            CodexOAuthErrorKind::Forbidden => StatusCode::FORBIDDEN,
            CodexOAuthErrorKind::ReauthRequired => StatusCode::UNAUTHORIZED,
            CodexOAuthErrorKind::Temporary => StatusCode::SERVICE_UNAVAILABLE,
            CodexOAuthErrorKind::Upstream => StatusCode::BAD_GATEWAY,
            CodexOAuthErrorKind::Database => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Deserialize)]
struct DeviceUserCodeResponse {
    device_auth_id: String,
    user_code: Option<String>,
    #[serde(rename = "usercode")]
    user_code_alt: Option<String>,
    interval: Option<Value>,
}

#[derive(Deserialize)]
struct DeviceTokenResponse {
    authorization_code: String,
    code_verifier: String,
    code_challenge: String,
}

enum DevicePoll {
    Pending,
    Ready(DeviceTokenResponse),
}

struct TokenBundle {
    access_token: String,
    refresh_token: String,
    id_token: String,
    expires_in_seconds: i64,
}

struct RefreshTokenBundle {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in_seconds: i64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
}

struct IdTokenClaims {
    account_id: String,
    email: String,
    plan_type: Option<String>,
}

async fn request_device_user_code(
    state: &SharedState,
) -> Result<DeviceUserCodeResponse, CodexOAuthError> {
    let body = serde_json::json!({ "client_id": CODEX_CLIENT_ID });
    let (status, bytes) = request_json(
        state,
        Method::POST,
        DEVICE_USER_CODE_URL,
        Some(&body),
        &HeaderMap::new(),
        REQUEST_TIMEOUT,
        OAUTH_BODY_MAX_BYTES,
    )
    .await?;
    if !status.is_success() {
        return Err(CodexOAuthError::upstream(
            if status == StatusCode::NOT_FOUND {
                "device_endpoint_unavailable"
            } else {
                "device_code_request_failed"
            },
            format!("device code endpoint returned status {}", status.as_u16()),
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        CodexOAuthError::upstream(
            "device_code_invalid",
            "device code endpoint returned invalid JSON",
        )
    })
}

async fn poll_device_token(
    state: &SharedState,
    device_auth_id: &str,
    user_code: &str,
) -> Result<DevicePoll, CodexOAuthError> {
    let body = serde_json::json!({
        "device_auth_id": device_auth_id,
        "user_code": user_code,
    });
    let (status, bytes) = request_json(
        state,
        Method::POST,
        DEVICE_TOKEN_URL,
        Some(&body),
        &HeaderMap::new(),
        REQUEST_TIMEOUT,
        OAUTH_BODY_MAX_BYTES,
    )
    .await?;
    if matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND) {
        return Ok(DevicePoll::Pending);
    }
    if !status.is_success() {
        return Err(CodexOAuthError::upstream(
            "device_token_poll_failed",
            format!("device token endpoint returned status {}", status.as_u16()),
        ));
    }
    let parsed: DeviceTokenResponse = serde_json::from_slice(&bytes).map_err(|_| {
        CodexOAuthError::upstream(
            "device_token_invalid",
            "device token endpoint returned invalid JSON",
        )
    })?;
    if parsed.authorization_code.trim().is_empty()
        || parsed.code_verifier.trim().is_empty()
        || parsed.code_challenge.trim().is_empty()
    {
        return Err(CodexOAuthError::upstream(
            "device_token_invalid",
            "device token endpoint omitted required fields",
        ));
    }
    Ok(DevicePoll::Ready(parsed))
}

async fn exchange_device_code(
    state: &SharedState,
    device: &DeviceTokenResponse,
) -> Result<TokenBundle, CodexOAuthError> {
    let form = form_urlencode(&[
        ("grant_type", "authorization_code"),
        ("client_id", CODEX_CLIENT_ID),
        ("code", device.authorization_code.trim()),
        ("redirect_uri", DEVICE_REDIRECT_URI),
        ("code_verifier", device.code_verifier.trim()),
    ]);
    let (status, bytes) = request_form(state, TOKEN_URL, form).await?;
    if status != StatusCode::OK {
        return Err(CodexOAuthError::upstream(
            "token_exchange_failed",
            format!("OAuth token exchange returned status {}", status.as_u16()),
        ));
    }
    let token: TokenResponse = serde_json::from_slice(&bytes).map_err(|_| {
        CodexOAuthError::upstream(
            "token_exchange_invalid",
            "OAuth token exchange returned invalid JSON",
        )
    })?;
    let refresh_token = token.refresh_token.unwrap_or_default();
    let id_token = token.id_token.unwrap_or_default();
    if token.access_token.trim().is_empty()
        || refresh_token.trim().is_empty()
        || id_token.trim().is_empty()
    {
        return Err(CodexOAuthError::upstream(
            "token_exchange_invalid",
            "OAuth token exchange omitted required tokens",
        ));
    }
    Ok(TokenBundle {
        access_token: token.access_token,
        refresh_token,
        id_token,
        expires_in_seconds: token.expires_in.unwrap_or(3_600).max(1),
    })
}

async fn refresh_tokens(
    state: &SharedState,
    refresh_token: &str,
) -> Result<RefreshTokenBundle, CodexOAuthError> {
    let form = form_urlencode(&[
        ("client_id", CODEX_CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("scope", "openid profile email"),
    ]);
    let (status, bytes) = request_form(state, TOKEN_URL, form).await?;
    if status != StatusCode::OK {
        let classification = classify_refresh_failure(status, &bytes);
        return Err(classification);
    }
    let token: TokenResponse = serde_json::from_slice(&bytes).map_err(|_| {
        CodexOAuthError::upstream(
            "token_refresh_invalid",
            "OAuth token refresh returned invalid JSON",
        )
    })?;
    if token.access_token.trim().is_empty() {
        return Err(CodexOAuthError::upstream(
            "token_refresh_invalid",
            "OAuth token refresh omitted the access token",
        ));
    }
    Ok(RefreshTokenBundle {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        id_token: token.id_token,
        expires_in_seconds: token.expires_in.unwrap_or(3_600).max(1),
    })
}

fn classify_refresh_failure(status: StatusCode, bytes: &[u8]) -> CodexOAuthError {
    let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    let non_recoverable = status == StatusCode::BAD_REQUEST
        && [
            "invalid_grant",
            "refresh_token_reused",
            "token_reused",
            "revoked",
        ]
        .iter()
        .any(|needle| text.contains(needle));
    if non_recoverable {
        let code = if text.contains("refresh_token_reused") || text.contains("token_reused") {
            "refresh_token_reused"
        } else {
            "token_refresh_rejected"
        };
        return CodexOAuthError::reauth(
            code,
            "the refresh token is no longer valid; sign in again",
        );
    }
    CodexOAuthError::temporary(
        "token_refresh_failed",
        format!("OAuth token refresh returned status {}", status.as_u16()),
    )
}

fn parse_id_token(token: &str) -> Result<IdTokenClaims, CodexOAuthError> {
    let mut parts = token.split('.');
    let _header = parts.next();
    let payload = parts.next().ok_or_else(|| {
        CodexOAuthError::upstream("id_token_invalid", "ID token has an invalid format")
    })?;
    if parts.next().is_none() || parts.next().is_some() {
        return Err(CodexOAuthError::upstream(
            "id_token_invalid",
            "ID token has an invalid format",
        ));
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .map_err(|_| {
            CodexOAuthError::upstream("id_token_invalid", "ID token payload is not valid base64")
        })?;
    let value: Value = serde_json::from_slice(&decoded).map_err(|_| {
        CodexOAuthError::upstream("id_token_invalid", "ID token payload is not valid JSON")
    })?;
    let auth = value
        .get("https://api.openai.com/auth")
        .and_then(Value::as_object);
    Ok(IdTokenClaims {
        account_id: auth
            .and_then(|auth| auth.get("chatgpt_account_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        email: value
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        plan_type: auth
            .and_then(|auth| auth.get("chatgpt_plan_type"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

async fn request_form(
    state: &SharedState,
    url: &str,
    form: String,
) -> Result<(StatusCode, Bytes), CodexOAuthError> {
    let uri = url.parse::<Uri>().map_err(|_| {
        CodexOAuthError::bad_request("oauth_uri_invalid", "OAuth endpoint URI is invalid")
    })?;
    let request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(ACCEPT, "application/json")
        .body(Full::new(Bytes::from(form)))
        .map_err(|_| {
            CodexOAuthError::bad_request("oauth_request_invalid", "OAuth request is invalid")
        })?;
    send_bounded(state, request, REQUEST_TIMEOUT, OAUTH_BODY_MAX_BYTES).await
}

async fn request_json(
    state: &SharedState,
    method: Method,
    url: &str,
    body: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    max_bytes: usize,
) -> Result<(StatusCode, Bytes), CodexOAuthError> {
    let uri = url.parse::<Uri>().map_err(|_| {
        CodexOAuthError::bad_request("oauth_uri_invalid", "OAuth endpoint URI is invalid")
    })?;
    let bytes = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| {
            CodexOAuthError::bad_request("oauth_request_invalid", "OAuth request JSON is invalid")
        })?
        .map(Bytes::from)
        .unwrap_or_default();
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .body(Full::new(bytes))
        .map_err(|_| {
            CodexOAuthError::bad_request("oauth_request_invalid", "OAuth request is invalid")
        })?;
    *request.headers_mut() = headers.clone();
    if body.is_some() {
        request
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    request
        .headers_mut()
        .insert(ACCEPT, HeaderValue::from_static("application/json"));
    send_bounded(state, request, timeout, max_bytes).await
}

async fn send_bounded(
    state: &SharedState,
    request: Request<Full<Bytes>>,
    timeout: Duration,
    max_bytes: usize,
) -> Result<(StatusCode, Bytes), CodexOAuthError> {
    let response = tokio::time::timeout(timeout, state.upstream.request(request))
        .await
        .map_err(|_| {
            CodexOAuthError::temporary("oauth_request_timeout", "upstream OAuth request timed out")
        })?
        .map_err(|_| {
            CodexOAuthError::temporary(
                "oauth_request_unavailable",
                "upstream OAuth endpoint is unavailable",
            )
        })?;
    let status = response.status();
    let bytes = Limited::new(response.into_body(), max_bytes)
        .collect()
        .await
        .map_err(|_| {
            CodexOAuthError::upstream(
                "oauth_response_too_large",
                "upstream OAuth response exceeded the safety limit",
            )
        })?
        .to_bytes();
    Ok((status, bytes))
}

async fn request_quota(
    state: &SharedState,
    auth: &PreparedCodexAuth,
) -> Result<(StatusCode, Bytes), CodexOAuthError> {
    let mut headers = HeaderMap::new();
    apply_codex_headers(&mut headers, auth);
    request_json(
        state,
        Method::GET,
        CODEX_USAGE_URL,
        None,
        &headers,
        REQUEST_TIMEOUT,
        QUOTA_BODY_MAX_BYTES,
    )
    .await
}

async fn request_models(
    state: &SharedState,
    auth: &PreparedCodexAuth,
) -> Result<(StatusCode, Bytes), CodexOAuthError> {
    let mut headers = HeaderMap::new();
    apply_codex_headers(&mut headers, auth);
    request_json(
        state,
        Method::GET,
        CODEX_MODELS_URL,
        None,
        &headers,
        REQUEST_TIMEOUT,
        MODEL_BODY_MAX_BYTES,
    )
    .await
}

pub fn apply_codex_headers(headers: &mut HeaderMap, auth: &PreparedCodexAuth) {
    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {}", auth.access_token)) {
        headers.insert(AUTHORIZATION, value);
    }
    if let Ok(value) = HeaderValue::from_str(&auth.account_id) {
        headers.insert(HeaderName::from_static("chatgpt-account-id"), value);
    }
    if !headers.contains_key(USER_AGENT) {
        headers.insert(USER_AGENT, HeaderValue::from_static(CODEX_USER_AGENT));
    }
    if !headers.contains_key("originator") {
        headers.insert(
            HeaderName::from_static("originator"),
            HeaderValue::from_static(CODEX_ORIGINATOR),
        );
    }
}

pub fn normalize_responses_request(
    body: &[u8],
    upstream_model: &str,
) -> Result<(Bytes, bool), String> {
    let mut value: Value = serde_json::from_slice(body).map_err(|error| error.to_string())?;
    let Some(root) = value.as_object_mut() else {
        return Err("request body must be a JSON object".to_string());
    };
    let downstream_stream = root.get("stream").and_then(Value::as_bool).unwrap_or(false);
    normalize_responses_object(root, upstream_model);
    serde_json::to_vec(&value)
        .map(|value| (Bytes::from(value), downstream_stream))
        .map_err(|error| error.to_string())
}

pub fn normalize_response_create_value(value: &mut Value, upstream_model: &str) {
    if let Some(root) = value.as_object_mut() {
        normalize_responses_object(root, upstream_model);
    }
}

fn normalize_responses_object(root: &mut Map<String, Value>, upstream_model: &str) {
    root.insert(
        "model".to_string(),
        Value::String(upstream_model.to_string()),
    );
    if let Some(Value::String(input)) = root.get("input").cloned() {
        root.insert(
            "input".to_string(),
            serde_json::json!([{
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": input }]
            }]),
        );
    }
    if let Some(Value::Array(items)) = root.get_mut("input") {
        for item in items {
            if let Some(object) = item.as_object_mut()
                && object.get("role").and_then(Value::as_str) == Some("system")
            {
                object.insert("role".to_string(), Value::String("developer".to_string()));
            }
        }
    }
    root.insert("stream".to_string(), Value::Bool(true));
    root.insert("store".to_string(), Value::Bool(false));
    root.insert(
        "include".to_string(),
        Value::Array(vec![Value::String(
            "reasoning.encrypted_content".to_string(),
        )]),
    );
    let has_tools = root
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty());
    if has_tools {
        root.insert("parallel_tool_calls".to_string(), Value::Bool(true));
    } else {
        root.remove("parallel_tool_calls");
    }
    if root.get("instructions").is_none_or(Value::is_null) {
        root.insert("instructions".to_string(), Value::String(String::new()));
    }
    for field in [
        "max_output_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "truncation",
        "user",
        "context_management",
    ] {
        root.remove(field);
    }
    if root
        .get("service_tier")
        .and_then(Value::as_str)
        .is_some_and(|tier| tier != "priority")
    {
        root.remove("service_tier");
    }
    normalize_tool_aliases(root.get_mut("tools"));
    if let Some(tool_choice) = root.get_mut("tool_choice")
        && let Some(object) = tool_choice.as_object_mut()
    {
        normalize_tool_type(object.get_mut("type"));
        normalize_tool_aliases(object.get_mut("tools"));
    }
    root.remove("background");
}

fn normalize_tool_aliases(value: Option<&mut Value>) {
    let Some(Value::Array(tools)) = value else {
        return;
    };
    for tool in tools {
        if let Some(object) = tool.as_object_mut() {
            normalize_tool_type(object.get_mut("type"));
        }
    }
}

fn normalize_tool_type(value: Option<&mut Value>) {
    let Some(Value::String(tool_type)) = value else {
        return;
    };
    if matches!(
        tool_type.as_str(),
        "web_search_preview" | "web_search_preview_2025_03_11"
    ) {
        *tool_type = "web_search".to_string();
    }
}

pub fn collect_completed_response_from_sse(body: &[u8]) -> Result<Bytes, String> {
    let text = std::str::from_utf8(body).map_err(|_| "upstream SSE was not UTF-8".to_string())?;
    let mut data_lines = Vec::new();
    let mut completed = None;
    for line in text.lines().chain(std::iter::once("")) {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if !data_lines.is_empty() {
                let data = data_lines.join("\n");
                data_lines.clear();
                if data == "[DONE]" {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(&data) {
                    if value.get("type").and_then(Value::as_str) == Some("error") {
                        return Err("Codex stream returned an error event".to_string());
                    }
                    if value.get("type").and_then(Value::as_str) == Some("response.completed")
                        && let Some(response) = value.get("response")
                    {
                        completed = Some(response.clone());
                    }
                }
            }
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start());
        }
    }
    let response = completed
        .ok_or_else(|| "Codex stream ended without a response.completed event".to_string())?;
    serde_json::to_vec(&response)
        .map(Bytes::from)
        .map_err(|error| error.to_string())
}

pub fn parse_model_ids(bytes: &[u8]) -> Result<Vec<String>, CodexOAuthError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        CodexOAuthError::upstream("models_invalid", "models endpoint returned invalid JSON")
    })?;
    let arrays = [value.get("models"), value.get("data")];
    let mut models = arrays
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .flat_map(|items| items.iter())
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    if models.is_empty() {
        return Err(CodexOAuthError::upstream(
            "models_empty",
            "models endpoint returned an empty inventory",
        ));
    }
    Ok(models)
}

pub fn parse_quota_snapshot(
    bytes: &[u8],
    now_ms: i64,
) -> Result<CodexQuotaSnapshot, CodexOAuthError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        CodexOAuthError::upstream("quota_invalid", "quota endpoint returned invalid JSON")
    })?;
    let rate_limit = value.get("rate_limit").unwrap_or(&value);
    let code_review = value.get("code_review_rate_limit");
    Ok(CodexQuotaSnapshot {
        plan_type: string_at(&value, &["plan_type"]),
        allowed: bool_at(rate_limit, &["allowed"]).or_else(|| bool_at(&value, &["allowed"])),
        primary_window: parse_quota_window(
            rate_limit
                .get("primary_window")
                .or_else(|| value.get("primary_window")),
            now_ms,
        ),
        secondary_window: parse_quota_window(
            rate_limit
                .get("secondary_window")
                .or_else(|| value.get("secondary_window")),
            now_ms,
        ),
        code_review_window: parse_quota_window(
            code_review
                .and_then(|item| item.get("primary_window"))
                .or_else(|| value.get("code_review_window")),
            now_ms,
        ),
        credits: parse_credits(value.get("credits"), &value),
    })
}

fn parse_quota_window(value: Option<&Value>, now_ms: i64) -> Option<CodexQuotaWindow> {
    let value = value?;
    let used_percent = number_at(value, &["used_percent"])
        .or_else(|| number_at(value, &["used_fraction"]).map(|fraction| fraction * 100.0))
        .unwrap_or(0.0)
        .clamp(0.0, 100.0);
    let window_seconds = integer_at(value, &["limit_window_seconds", "window_seconds", "window"]);
    let reset_at_ms = timestamp_ms_at(value, &["reset_at", "resets_at"]).or_else(|| {
        integer_at(value, &["reset_after_seconds", "resets_in_seconds"])
            .and_then(|seconds| now_ms.checked_add(seconds.saturating_mul(1_000)))
    });
    Some(CodexQuotaWindow {
        used_percent,
        remaining_percent: (100.0 - used_percent).clamp(0.0, 100.0),
        window_seconds,
        reset_at_ms,
    })
}

fn parse_credits(value: Option<&Value>, root: &Value) -> CodexQuotaCredits {
    let value = value.unwrap_or(&Value::Null);
    CodexQuotaCredits {
        has_credits: bool_at(value, &["has_credits"]).unwrap_or(false),
        unlimited: bool_at(value, &["unlimited"]).unwrap_or(false),
        balance: number_at(value, &["balance"]),
        reset_credits: number_at(value, &["reset_credits", "reset_amount"]),
        subscription_end_at_ms: timestamp_ms_at(
            value,
            &["subscription_end_at", "subscription_expires_at"],
        )
        .or_else(|| {
            timestamp_ms_at(
                root,
                &["chatgpt_subscription_active_until", "subscription_end_at"],
            )
        }),
    }
}

pub fn quota_reset_hint_from_error(bytes: &[u8], now_ms: i64) -> Option<i64> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    timestamp_ms_at(&value, &["resets_at", "reset_at"])
        .or_else(|| {
            value
                .get("error")
                .and_then(|error| timestamp_ms_at(error, &["resets_at", "reset_at"]))
        })
        .or_else(|| {
            integer_at(&value, &["resets_in_seconds", "reset_after_seconds"])
                .and_then(|seconds| now_ms.checked_add(seconds.saturating_mul(1_000)))
        })
        .or_else(|| {
            value.get("error").and_then(|error| {
                integer_at(error, &["resets_in_seconds", "reset_after_seconds"])
                    .and_then(|seconds| now_ms.checked_add(seconds.saturating_mul(1_000)))
            })
        })
}

pub fn is_account_forbidden_error(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    [
        "missing entitlement",
        "missing_entitlement",
        "missing_codex_entitlement",
        "workspace deactivated",
        "workspace_deactivated",
        "account deactivated",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bool_at(value: &Value, keys: &[&str]) -> Option<bool> {
    let value = keys.iter().find_map(|key| value.get(*key))?;
    value.as_bool().or_else(|| {
        value.as_str().and_then(|raw| match raw.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        })
    })
}

fn number_at(value: &Value, keys: &[&str]) -> Option<f64> {
    let value = keys.iter().find_map(|key| value.get(*key))?;
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|raw| raw.trim().parse().ok()))
        .filter(|number| number.is_finite())
}

fn integer_at(value: &Value, keys: &[&str]) -> Option<i64> {
    let value = keys.iter().find_map(|key| value.get(*key))?;
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|raw| raw.trim().parse().ok()))
}

fn timestamp_ms_at(value: &Value, keys: &[&str]) -> Option<i64> {
    let raw = integer_at(value, keys)?;
    if raw <= 0 {
        return None;
    }
    if raw > 10_000_000_000 {
        Some(raw)
    } else {
        raw.checked_mul(1_000)
    }
}

fn parse_poll_interval_ms(value: Option<&Value>) -> i64 {
    value
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|raw| raw.trim().parse().ok()))
        })
        .filter(|seconds| *seconds > 0)
        .and_then(|seconds| seconds.checked_mul(1_000))
        .unwrap_or(DEVICE_DEFAULT_POLL_INTERVAL_MS)
}

fn default_account_name(email: &str, account_id: &str) -> String {
    let email = email.trim();
    if !email.is_empty() {
        return format!("Codex {email}");
    }
    let suffix = account_id
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    format!("Codex {suffix}")
}

fn mask_email(email: &str) -> Option<String> {
    let email = email.trim();
    let (local, domain) = email.split_once('@')?;
    if local.is_empty() || domain.is_empty() {
        return None;
    }
    let first = local.chars().next()?;
    Some(format!("{first}***@{domain}"))
}

fn mask_account_id(account_id: &str) -> Option<String> {
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return None;
    }
    let suffix = account_id
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    Some(format!("…{suffix}"))
}

fn sanitize_persisted_error(message: &str) -> String {
    let trimmed = message.trim();
    let mut sanitized = if trimmed.is_empty() {
        "unknown OAuth error".to_string()
    } else {
        trimmed.chars().take(240).collect::<String>()
    };
    for marker in [
        "access_token",
        "refresh_token",
        "id_token",
        "authorization_code",
        "code_verifier",
        "user_code",
    ] {
        if sanitized.to_ascii_lowercase().contains(marker) {
            sanitized = "upstream OAuth request failed".to_string();
            break;
        }
    }
    sanitized
}

fn form_urlencode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode_component(key), encode_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn encode_component(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(char::from(byte));
            }
            b' ' => output.push('+'),
            other => {
                output.push('%');
                output.push(char::from(b"0123456789ABCDEF"[(other >> 4) as usize]));
                output.push(char::from(b"0123456789ABCDEF"[(other & 0x0f) as usize]));
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn sqlite_codex_provider() -> (Database, i64) {
        let db = Database::connect("sqlite::memory:", 1)
            .await
            .expect("connect sqlite");
        db.migrate().await.expect("migrate sqlite");
        let provider_id = db
            .insert_upstream_provider(
                "codex",
                PROVIDER_TYPE,
                true,
                100,
                1,
                true,
                true,
                &["responses-http-to-ws".to_string()],
                &crate::request_overrides::RequestOverrides::default(),
                "round_robin",
                2,
                None,
                true,
                3,
                30_000,
                2,
                1_000,
            )
            .await
            .expect("insert Codex provider");
        (db, provider_id)
    }

    fn pending_session(session_id: &str, provider_id: i64) -> SessionRecord {
        SessionRecord {
            session_id: session_id.to_string(),
            provider_id,
            replace_key_id: None,
            device_auth_id: "device-auth".to_string(),
            user_code: "ABCD-EFGH".to_string(),
            poll_interval_ms: 5_000,
            expires_at_ms: util::now_ms().saturating_add(60_000),
            terminal_at_ms: None,
            status: SessionStatus::Pending,
            cancel_requested: Arc::new(AtomicBool::new(false)),
            save_gate: Arc::new(AsyncMutex::new(())),
            key_id: None,
            operation: None,
            warnings: Vec::new(),
            error_code: None,
            error_message: None,
        }
    }

    fn jwt(payload: Value) -> String {
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"{}");
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).expect("payload"));
        format!("{header}.{payload}.signature")
    }

    #[test]
    fn device_poll_interval_accepts_number_string_and_default() {
        assert_eq!(parse_poll_interval_ms(Some(&Value::from(7))), 7_000);
        assert_eq!(parse_poll_interval_ms(Some(&Value::from("9"))), 9_000);
        assert_eq!(parse_poll_interval_ms(Some(&Value::from(0))), 5_000);
    }

    #[test]
    fn starting_target_reservation_rejects_concurrent_session_and_releases_on_drop() {
        let manager = CodexOAuthManager::new();
        let first = manager
            .reserve_starting_target((7, Some(11)))
            .expect("first reservation");
        let conflict = manager
            .reserve_starting_target((7, Some(11)))
            .expect_err("duplicate target should conflict");
        assert_eq!(conflict.code, "oauth_session_in_progress");

        drop(first);
        manager
            .reserve_starting_target((7, Some(11)))
            .expect("reservation should be released");
    }

    #[tokio::test]
    async fn cancelled_session_cannot_be_marked_completed() {
        let manager = CodexOAuthManager::new();
        manager
            .sessions
            .lock()
            .insert("session-1".to_string(), pending_session("session-1", 7));

        assert!(manager.cancel_session("session-1").await);
        manager.mark_session_completed(
            "session-1",
            SaveCodexLoginResult {
                key_id: 42,
                operation: CodexLoginOperation::Created,
            },
            Vec::new(),
        );

        let view = manager
            .get_session("session-1")
            .await
            .expect("cancelled tombstone");
        assert_eq!(view.status, "cancelled");
        assert_eq!(view.key_id, None);
    }

    #[tokio::test]
    async fn sqlite_login_encrypts_all_tokens_and_cascades_with_provider() {
        let (db, provider_id) = sqlite_codex_provider().await;
        let master_key = "test-master-key";
        let account_hash = crypto::hash_codex_account(master_key, "acct-secure");
        let saved = db
            .save_codex_oauth_login(
                master_key,
                SaveCodexLogin {
                    provider_id,
                    replace_key_id: None,
                    account_hash: &account_hash,
                    access_token: "access-secret",
                    refresh_token: "refresh-secret",
                    id_token: "id-secret",
                    account_id: "acct-secure",
                    email: "operator@example.com",
                    plan_type: Some("plus"),
                    token_expires_at_ms: Some(50_000),
                    now_ms: 2_000,
                },
            )
            .await
            .expect("save Codex login");
        assert_eq!(saved.operation, CodexLoginOperation::Created);

        let Database::Sqlite(pool) = &db else {
            panic!("expected sqlite database");
        };
        let row = sqlx::query(
            "SELECT key.secret_enc, account.credentials_enc FROM upstream_keys key JOIN codex_oauth_accounts account ON account.upstream_key_id = key.id WHERE key.id = ?",
        )
        .bind(saved.key_id)
        .fetch_one(pool)
        .await
        .expect("load encrypted credentials");
        let access_token_enc = row.get::<String, _>("secret_enc");
        let credentials_enc = row.get::<String, _>("credentials_enc");
        assert_ne!(access_token_enc, "access-secret");
        assert_ne!(credentials_enc, "refresh-secret");
        assert_eq!(
            crypto::decrypt_secret(master_key, &access_token_enc).expect("decrypt access token"),
            "access-secret"
        );
        let credentials: CodexOAuthCredentials = serde_json::from_str(
            &crypto::decrypt_secret(master_key, &credentials_enc).expect("decrypt credentials"),
        )
        .expect("decode credentials");
        assert_eq!(credentials.refresh_token, "refresh-secret");
        assert_eq!(credentials.id_token, "id-secret");
        assert_eq!(credentials.account_id, "acct-secure");

        assert!(
            db.delete_upstream_provider(provider_id)
                .await
                .expect("delete provider")
        );
        let remaining = sqlx::query("SELECT COUNT(*) AS count FROM codex_oauth_accounts")
            .fetch_one(pool)
            .await
            .expect("count OAuth accounts")
            .get::<i64, _>("count");
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn sqlite_relogin_deduplicates_account_and_preserves_key_configuration() {
        let (db, provider_id) = sqlite_codex_provider().await;
        let master_key = "test-master-key";
        let account_hash = crypto::hash_codex_account(master_key, "acct-dedupe");
        let first = db
            .save_codex_oauth_login(
                master_key,
                SaveCodexLogin {
                    provider_id,
                    replace_key_id: None,
                    account_hash: &account_hash,
                    access_token: "access-1",
                    refresh_token: "refresh-1",
                    id_token: "id-1",
                    account_id: "acct-dedupe",
                    email: "first@example.com",
                    plan_type: Some("plus"),
                    token_expires_at_ms: Some(50_000),
                    now_ms: 2_000,
                },
            )
            .await
            .expect("save first login");
        let Database::Sqlite(pool) = &db else {
            panic!("expected sqlite database");
        };
        sqlx::query(
            "UPDATE upstream_keys SET name = 'kept-name', enabled = 0, priority = 7, weight = 9 WHERE id = ?",
        )
        .bind(first.key_id)
        .execute(pool)
        .await
        .expect("customize key");

        let second = db
            .save_codex_oauth_login(
                master_key,
                SaveCodexLogin {
                    provider_id,
                    replace_key_id: None,
                    account_hash: &account_hash,
                    access_token: "access-2",
                    refresh_token: "refresh-2",
                    id_token: "id-2",
                    account_id: "acct-dedupe",
                    email: "second@example.com",
                    plan_type: Some("pro"),
                    token_expires_at_ms: Some(80_000),
                    now_ms: 3_000,
                },
            )
            .await
            .expect("save repeated login");
        assert_eq!(second.key_id, first.key_id);
        assert_eq!(second.operation, CodexLoginOperation::Updated);

        let keys = db
            .list_upstream_keys_meta_by_provider(provider_id)
            .await
            .expect("list keys");
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].name, "kept-name");
        assert!(!keys[0].enabled);
        assert_eq!(keys[0].priority, 7);
        assert_eq!(keys[0].weight, 9);
        let account = db
            .find_codex_oauth_account(master_key, first.key_id)
            .await
            .expect("load account")
            .expect("account exists");
        assert_eq!(account.access_token, "access-2");
        assert_eq!(account.credentials.refresh_token, "refresh-2");
        assert_eq!(account.plan_type.as_deref(), Some("pro"));
    }

    #[tokio::test]
    async fn sqlite_token_rotation_preserves_forbidden_until_quota_validation_succeeds() {
        let (db, provider_id) = sqlite_codex_provider().await;
        let master_key = "test-master-key";
        let account_hash = crypto::hash_codex_account(master_key, "acct-forbidden");
        let saved = db
            .save_codex_oauth_login(
                master_key,
                SaveCodexLogin {
                    provider_id,
                    replace_key_id: None,
                    account_hash: &account_hash,
                    access_token: "access-1",
                    refresh_token: "refresh-1",
                    id_token: "id-1",
                    account_id: "acct-forbidden",
                    email: "forbidden@example.com",
                    plan_type: Some("team"),
                    token_expires_at_ms: Some(50_000),
                    now_ms: 2_000,
                },
            )
            .await
            .expect("save login");
        db.update_codex_auth_status(
            saved.key_id,
            AUTH_STATUS_FORBIDDEN,
            Some("workspace deactivated"),
            3_000,
        )
        .await
        .expect("mark forbidden");
        assert!(
            db.try_acquire_codex_refresh_lease(saved.key_id, "owner", 40_000, 4_000)
                .await
                .expect("acquire lease")
        );

        assert!(
            db.persist_codex_token_refresh(
                master_key,
                saved.key_id,
                "owner",
                "access-2",
                &CodexOAuthCredentials {
                    refresh_token: "refresh-2".to_string(),
                    id_token: "id-2".to_string(),
                    account_id: "acct-forbidden".to_string(),
                    email: "forbidden@example.com".to_string(),
                },
                Some("team"),
                Some(80_000),
                AUTH_STATUS_FORBIDDEN,
                Some("workspace deactivated"),
                5_000,
            )
            .await
            .expect("persist token rotation")
        );
        let account = db
            .find_codex_oauth_account(master_key, saved.key_id)
            .await
            .expect("load account")
            .expect("account exists");
        assert_eq!(account.access_token, "access-2");
        assert_eq!(account.auth_status, AUTH_STATUS_FORBIDDEN);
        assert_eq!(account.last_error.as_deref(), Some("workspace deactivated"));
    }

    #[test]
    fn id_token_claims_extract_account_email_and_plan() {
        let token = jwt(serde_json::json!({
            "email": "operator@example.com",
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "account-123",
                "chatgpt_plan_type": "plus"
            }
        }));
        let claims = parse_id_token(&token).expect("claims");
        assert_eq!(claims.account_id, "account-123");
        assert_eq!(claims.email, "operator@example.com");
        assert_eq!(claims.plan_type.as_deref(), Some("plus"));
    }

    #[test]
    fn responses_request_normalization_matches_codex_contract() {
        let input = br#"{
          "model":"alias",
          "input":[{"type":"message","role":"system","content":[]}],
          "instructions":null,
          "tools":[{"type":"web_search_preview"}],
          "temperature":0.2,
          "service_tier":"default",
          "stream":false
        }"#;
        let (body, downstream_stream) =
            normalize_responses_request(input, "gpt-5.1-codex").expect("normalize");
        let value: Value = serde_json::from_slice(&body).expect("json");
        assert!(!downstream_stream);
        assert_eq!(value["model"], "gpt-5.1-codex");
        assert_eq!(value["input"][0]["role"], "developer");
        assert_eq!(value["instructions"], "");
        assert_eq!(value["store"], false);
        assert_eq!(value["stream"], true);
        assert_eq!(value["parallel_tool_calls"], true);
        assert_eq!(value["tools"][0]["type"], "web_search");
        assert!(value.get("temperature").is_none());
        assert!(value.get("service_tier").is_none());
    }

    #[test]
    fn responses_request_removes_parallel_tool_calls_without_tools() {
        let (body, _) = normalize_responses_request(
            br#"{"model":"m","input":"hello","parallel_tool_calls":true}"#,
            "m",
        )
        .expect("normalize");
        let value: Value = serde_json::from_slice(&body).expect("json");
        assert!(value.get("parallel_tool_calls").is_none());
        assert_eq!(value["input"][0]["content"][0]["text"], "hello");
    }

    #[test]
    fn quota_parser_uses_absolute_reset_and_keeps_monthly_window_duration() {
        let snapshot = parse_quota_snapshot(
            br#"{
              "plan_type":"plus",
              "rate_limit":{
                "allowed":true,
                "primary_window":{"used_percent":25,"limit_window_seconds":18000,"reset_at":200},
                "secondary_window":{"used_percent":80,"limit_window_seconds":2592000,"reset_after_seconds":30}
              },
              "credits":{"has_credits":true,"unlimited":false,"balance":12.5}
            }"#,
            100_000,
        )
        .expect("quota");
        assert_eq!(snapshot.plan_type.as_deref(), Some("plus"));
        assert_eq!(
            snapshot
                .primary_window
                .as_ref()
                .and_then(|window| window.reset_at_ms),
            Some(200_000)
        );
        assert_eq!(
            snapshot
                .secondary_window
                .as_ref()
                .and_then(|window| window.window_seconds),
            Some(2_592_000)
        );
        assert_eq!(snapshot.credits.balance, Some(12.5));
    }

    #[test]
    fn quota_error_reset_hint_reads_nested_relative_seconds() {
        assert_eq!(
            quota_reset_hint_from_error(br#"{"error":{"resets_in_seconds":"45"}}"#, 100_000,),
            Some(145_000)
        );
    }

    #[test]
    fn refresh_failure_classifies_reused_tokens_as_reauthentication() {
        let reused = classify_refresh_failure(
            StatusCode::BAD_REQUEST,
            br#"{"error":"refresh_token_reused"}"#,
        );
        let temporary = classify_refresh_failure(StatusCode::BAD_GATEWAY, b"upstream unavailable");
        assert!(reused.reauth_required);
        assert_eq!(reused.code, "refresh_token_reused");
        assert!(!temporary.reauth_required);
        assert_eq!(temporary.code, "token_refresh_failed");
    }

    #[test]
    fn codex_headers_replace_credentials_and_preserve_client_identity() {
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("client-agent"));
        headers.insert("originator", HeaderValue::from_static("client-origin"));
        apply_codex_headers(
            &mut headers,
            &PreparedCodexAuth {
                access_token: "access-token".to_string(),
                account_id: "account-123".to_string(),
            },
        );

        assert_eq!(
            headers
                .get(USER_AGENT)
                .and_then(|value| value.to_str().ok()),
            Some("client-agent")
        );
        assert_eq!(
            headers
                .get("originator")
                .and_then(|value| value.to_str().ok()),
            Some("client-origin")
        );
        assert_eq!(
            headers
                .get("chatgpt-account-id")
                .and_then(|value| value.to_str().ok()),
            Some("account-123")
        );
        assert_eq!(
            headers
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer access-token")
        );
    }

    #[test]
    fn sse_collector_returns_completed_response_json() {
        let body = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\"}}\n\n";
        let collected = collect_completed_response_from_sse(body).expect("completed response");
        let value: Value = serde_json::from_slice(&collected).expect("json");
        assert_eq!(value["id"], "resp_1");
    }

    #[test]
    fn sensitive_errors_are_redacted_before_persistence() {
        assert_eq!(
            sanitize_persisted_error("refresh_token=secret"),
            "upstream OAuth request failed"
        );
    }
}
