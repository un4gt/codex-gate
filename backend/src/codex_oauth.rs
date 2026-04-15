use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode, Uri};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::http::{self, HttpResponse};
use crate::state::SharedState;
use crate::util;

const AUTH_ISSUER: &str = "https://auth.openai.com";

// Matches openai/codex (codex-rs/login) client_id for auth.openai.com.
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_SCOPE: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";

const CODEX_OAUTH_REQUEST_EXPIRES_MS: i64 = 15 * 60 * 1000;
const CODEX_OAUTH_REQUEST_PRUNE_GRACE_MS: i64 = 5 * 60 * 1000;

#[derive(Clone, Debug, Serialize)]
pub struct CodexOauthStartResponse {
    pub request_id: String,
    pub login_url: String,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state")]
pub enum CodexOauthStatusView {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "completed")]
    Completed { key_id: i64 },
    #[serde(rename = "failed")]
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize)]
pub struct CodexOauthRequestView {
    pub request_id: String,
    pub provider_id: i64,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub login_url: String,
    pub status: CodexOauthStatusView,
}

#[derive(Clone, Debug)]
struct CodexOauthRequestRecord {
    request_id: String,
    provider_id: i64,
    created_at_ms: i64,
    expires_at_ms: i64,
    login_url: String,
    oauth_state: String,
    code_verifier: String,
    redirect_uri: String,
    status: CodexOauthStatusView,
}

#[derive(Clone, Debug)]
struct CallbackSnapshot {
    request_id: String,
    provider_id: i64,
    authorization_code: String,
    code_verifier: String,
    redirect_uri: String,
}

#[derive(Clone)]
pub struct CodexOauthManager {
    inner: Arc<Mutex<HashMap<String, CodexOauthRequestRecord>>>,
}

impl CodexOauthManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn prune_records(records: &mut HashMap<String, CodexOauthRequestRecord>, now_ms: i64) {
        records
            .retain(|_, record| now_ms < record.expires_at_ms + CODEX_OAUTH_REQUEST_PRUNE_GRACE_MS);
    }

    pub async fn start(
        &self,
        provider_id: i64,
        redirect_uri: String,
    ) -> Result<CodexOauthStartResponse, String> {
        let now_ms = util::now_ms();
        let request_id = Ulid::new().to_string();

        let oauth_state = random_urlsafe(24);
        let code_verifier = random_urlsafe(48);
        let code_challenge = build_pkce_code_challenge(&code_verifier);
        let login_url = build_authorize_url(&redirect_uri, &oauth_state, &code_challenge);

        let expires_at_ms = now_ms + CODEX_OAUTH_REQUEST_EXPIRES_MS;
        let record = CodexOauthRequestRecord {
            request_id: request_id.clone(),
            provider_id,
            created_at_ms: now_ms,
            expires_at_ms,
            login_url: login_url.clone(),
            oauth_state,
            code_verifier,
            redirect_uri,
            status: CodexOauthStatusView::Pending,
        };

        {
            let mut guard = self.inner.lock();
            Self::prune_records(&mut guard, now_ms);
            guard.insert(request_id.clone(), record);
        }

        Ok(CodexOauthStartResponse {
            request_id,
            login_url,
            expires_at_ms,
        })
    }

    pub fn get_view(&self, request_id: &str, now_ms: i64) -> Option<CodexOauthRequestView> {
        let mut guard = self.inner.lock();
        Self::prune_records(&mut guard, now_ms);
        let record = guard.get_mut(request_id)?;
        if matches!(record.status, CodexOauthStatusView::Pending) && now_ms >= record.expires_at_ms
        {
            record.status = CodexOauthStatusView::Failed {
                message: "expired".to_string(),
            };
        }

        Some(CodexOauthRequestView {
            request_id: record.request_id.clone(),
            provider_id: record.provider_id,
            created_at_ms: record.created_at_ms,
            expires_at_ms: record.expires_at_ms,
            login_url: record.login_url.clone(),
            status: record.status.clone(),
        })
    }

    pub async fn complete_browser_callback(
        &self,
        state: SharedState,
        oauth_state: &str,
        callback_code: Option<&str>,
        callback_error: Option<&str>,
        callback_error_description: Option<&str>,
    ) -> Result<String, String> {
        let now_ms = util::now_ms();
        let snapshot = {
            let mut guard = self.inner.lock();
            Self::prune_records(&mut guard, now_ms);

            let Some(record) = guard
                .values_mut()
                .find(|record| record.oauth_state == oauth_state)
            else {
                return Err("request not found".to_string());
            };

            if matches!(record.status, CodexOauthStatusView::Completed { .. }) {
                return Ok("Codex OAuth already completed. You can close this page.".to_string());
            }

            if matches!(record.status, CodexOauthStatusView::Failed { .. }) {
                return Err("request already failed".to_string());
            }

            if now_ms >= record.expires_at_ms {
                record.status = CodexOauthStatusView::Failed {
                    message: "expired".to_string(),
                };
                return Err("request expired".to_string());
            }

            if let Some(error_code) = callback_error {
                let message = callback_error_message(error_code, callback_error_description);
                record.status = CodexOauthStatusView::Failed {
                    message: message.clone(),
                };
                return Err(message);
            }

            let Some(code) = callback_code
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                record.status = CodexOauthStatusView::Failed {
                    message: "missing authorization code".to_string(),
                };
                return Err("missing authorization code".to_string());
            };

            CallbackSnapshot {
                request_id: record.request_id.clone(),
                provider_id: record.provider_id,
                authorization_code: code.to_string(),
                code_verifier: record.code_verifier.clone(),
                redirect_uri: record.redirect_uri.clone(),
            }
        };

        let id_token = exchange_authorization_code_for_id_token(
            state.clone(),
            &snapshot.authorization_code,
            &snapshot.code_verifier,
            &snapshot.redirect_uri,
        )
        .await
        .inspect_err(|message| self.mark_failed(&snapshot.request_id, message.clone()))?;

        let api_key = exchange_id_token_for_api_key(state.clone(), &id_token)
            .await
            .inspect_err(|message| self.mark_failed(&snapshot.request_id, message.clone()))?;

        let key_name = format!("codex-oauth-{}", &snapshot.request_id[..8]);
        let key_id = state
            .db
            .insert_upstream_key(
                &state.config.master_key,
                snapshot.provider_id,
                &key_name,
                &api_key,
                true,
                100,
                1,
                util::now_ms(),
            )
            .await
            .map_err(|e| e.to_string())
            .inspect_err(|message| self.mark_failed(&snapshot.request_id, message.clone()))?;

        state.caches.upstream.invalidate();
        self.mark_completed(&snapshot.request_id, key_id);
        Ok(format!(
            "Codex OAuth completed. Key #{key_id} has been created. You can close this page."
        ))
    }

    fn mark_completed(&self, request_id: &str, key_id: i64) {
        let mut guard = self.inner.lock();
        let Some(record) = guard.get_mut(request_id) else {
            return;
        };
        record.status = CodexOauthStatusView::Completed { key_id };
    }

    fn mark_failed(&self, request_id: &str, message: String) {
        let mut guard = self.inner.lock();
        let Some(record) = guard.get_mut(request_id) else {
            return;
        };
        record.status = CodexOauthStatusView::Failed { message };
    }
}

pub async fn handle_callback(req: Request<Incoming>, state: SharedState) -> HttpResponse {
    if req.method() != Method::GET {
        return http::json_error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }

    let oauth_state = query_string(req.uri().query(), "state");
    let callback_code = query_string(req.uri().query(), "code");
    let callback_error = query_string(req.uri().query(), "error");
    let callback_error_description = query_string(req.uri().query(), "error_description");

    let Some(oauth_state) = oauth_state else {
        return callback_page(
            StatusCode::BAD_REQUEST,
            "Codex OAuth failed: missing state. You can close this page.",
        );
    };

    match state
        .codex_oauth
        .complete_browser_callback(
            state.clone(),
            &oauth_state,
            callback_code.as_deref(),
            callback_error.as_deref(),
            callback_error_description.as_deref(),
        )
        .await
    {
        Ok(message) => callback_page(StatusCode::OK, &message),
        Err(message) => callback_page(
            StatusCode::BAD_REQUEST,
            &format!("Codex OAuth failed: {message}. You can close this page."),
        ),
    }
}

fn callback_page(status: StatusCode, message: &str) -> HttpResponse {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Codex OAuth</title></head><body><pre>{}</pre></body></html>",
        html_escape(message),
    );
    Response::builder()
        .status(status)
        .header("Content-Type", "text/html; charset=utf-8")
        .body(http::full(Bytes::from(body), None))
        .expect("codex oauth callback response builder")
}

fn callback_error_message(error_code: &str, error_description: Option<&str>) -> String {
    if error_code == "access_denied"
        && error_description.is_some_and(|description| {
            description
                .to_ascii_lowercase()
                .contains("missing_codex_entitlement")
        })
    {
        return "Codex is not enabled for this workspace".to_string();
    }

    match error_description
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(description) => format!("{error_code}: {description}"),
        None => error_code.to_string(),
    }
}

async fn exchange_authorization_code_for_id_token(
    state: SharedState,
    authorization_code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let uri: Uri = format!("{AUTH_ISSUER}/oauth/token")
        .parse::<Uri>()
        .map_err(|e| e.to_string())?;

    let form = form_urlencode(&[
        ("grant_type", "authorization_code"),
        ("code", authorization_code),
        ("redirect_uri", redirect_uri),
        ("client_id", CODEX_OAUTH_CLIENT_ID),
        ("code_verifier", code_verifier),
    ]);

    let (status, bytes) = request_form(state, Method::POST, uri, form).await?;
    if status != StatusCode::OK {
        return Err(format!(
            "oauth token exchange failed: {} {}",
            status.as_u16(),
            String::from_utf8_lossy(&bytes).trim()
        ));
    }

    let value: Value = serde_json::from_slice(&bytes).map_err(|e| format!("invalid json: {e}"))?;
    let id_token = value
        .get("id_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing id_token".to_string())?
        .trim()
        .to_string();
    Ok(id_token)
}

async fn exchange_id_token_for_api_key(
    state: SharedState,
    id_token: &str,
) -> Result<String, String> {
    let uri: Uri = format!("{AUTH_ISSUER}/oauth/token")
        .parse::<Uri>()
        .map_err(|e| e.to_string())?;

    let form = form_urlencode(&[
        (
            "grant_type",
            "urn:ietf:params:oauth:grant-type:token-exchange",
        ),
        ("client_id", CODEX_OAUTH_CLIENT_ID),
        ("requested_token", "openai-api-key"),
        ("subject_token", id_token),
        (
            "subject_token_type",
            "urn:ietf:params:oauth:token-type:id_token",
        ),
    ]);

    let (status, bytes) = request_form(state, Method::POST, uri, form).await?;
    if status != StatusCode::OK {
        return Err(format!(
            "oauth api-key exchange failed: {} {}",
            status.as_u16(),
            String::from_utf8_lossy(&bytes).trim()
        ));
    }

    let value: Value = serde_json::from_slice(&bytes).map_err(|e| format!("invalid json: {e}"))?;
    let api_key = value
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing access_token".to_string())?
        .trim()
        .to_string();
    Ok(api_key)
}

async fn request_form(
    state: SharedState,
    method: Method,
    uri: Uri,
    form: String,
) -> Result<(StatusCode, Bytes), String> {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(Full::new(Bytes::from(form)))
        .map_err(|e| e.to_string())?;

    let resp = tokio::time::timeout(
        state.config.upstream_request_timeout,
        state.upstream.request(req),
    )
    .await
    .map_err(|_| format!("timeout after {:?}", state.config.upstream_request_timeout))?
    .map_err(|e| e.to_string())?;
    let status = resp.status();
    let collected = resp
        .into_body()
        .collect()
        .await
        .map_err(|e| e.to_string())?;
    Ok((status, collected.to_bytes()))
}

fn build_authorize_url(redirect_uri: &str, oauth_state: &str, code_challenge: &str) -> String {
    let query = form_urlencode(&[
        ("response_type", "code"),
        ("client_id", CODEX_OAUTH_CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("scope", CODEX_OAUTH_SCOPE),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("state", oauth_state),
    ]);
    format!("{AUTH_ISSUER}/oauth/authorize?{query}")
}

fn random_urlsafe(bytes_len: usize) -> String {
    let mut bytes = vec![0_u8; bytes_len];
    fastrand::fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn build_pkce_code_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn query_string(q: Option<&str>, key: &str) -> Option<String> {
    fn decode_query_value(raw: &str) -> String {
        fn from_hex(byte: u8) -> Option<u8> {
            match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            }
        }

        let bytes = raw.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                b'%' if i + 2 < bytes.len() => {
                    let hi = from_hex(bytes[i + 1]);
                    let lo = from_hex(bytes[i + 2]);
                    if let (Some(hi), Some(lo)) = (hi, lo) {
                        out.push((hi << 4) | lo);
                        i += 3;
                    } else {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
                byte => {
                    out.push(byte);
                    i += 1;
                }
            }
        }

        String::from_utf8(out)
            .unwrap_or_else(|e| String::from_utf8_lossy(&e.into_bytes()).into_owned())
    }

    let q = q?;
    for part in q.split('&') {
        let mut it = part.splitn(2, '=');
        let k = it.next()?.trim();
        let v = it.next().unwrap_or("").trim();
        if k == key && !v.is_empty() {
            return Some(decode_query_value(v));
        }
    }
    None
}

fn form_urlencode(pairs: &[(&str, &str)]) -> String {
    fn encode_component(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        for b in input.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(b as char);
                }
                b' ' => out.push('+'),
                other => {
                    out.push('%');
                    out.push(nibble_to_hex((other >> 4) & 0xF));
                    out.push(nibble_to_hex(other & 0xF));
                }
            }
        }
        out
    }

    fn nibble_to_hex(n: u8) -> char {
        match n {
            0..=9 => (b'0' + n) as char,
            10..=15 => (b'A' + (n - 10)) as char,
            _ => '0',
        }
    }

    let mut out = String::new();
    for (idx, (k, v)) in pairs.iter().enumerate() {
        if idx > 0 {
            out.push('&');
        }
        out.push_str(&encode_component(k));
        out.push('=');
        out.push_str(&encode_component(v));
    }
    out
}

fn html_escape(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}
