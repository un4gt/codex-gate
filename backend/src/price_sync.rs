//! Cloud catalog ingestion. Routing inventory and manually managed prices are independent.
use crate::{
    http::{self, HttpResponse},
    pricing::{ContextPriceTier, PriceCard, PriceRates},
    state::SharedState,
    util,
};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Method, Request, StatusCode, body::Bytes};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    str::FromStr,
    time::Duration,
};

pub const DEFAULT_SOURCE: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SyncConfig {
    pub enabled: bool,
    pub source_url: String,
    pub interval_minutes: u32,
}
impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            source_url: DEFAULT_SOURCE.into(),
            interval_minutes: 30,
        }
    }
}
impl SyncConfig {
    pub fn from_env() -> Self {
        Self {
            enabled: std::env::var("PRICE_SYNC_ENABLED")
                .map(|v| v != "false" && v != "0")
                .unwrap_or(true),
            source_url: std::env::var("PRICE_SYNC_SOURCE_URL")
                .unwrap_or_else(|_| DEFAULT_SOURCE.into()),
            interval_minutes: std::env::var("PRICE_SYNC_INTERVAL_MINUTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        let url = url::Url::parse(&self.source_url).map_err(|e| e.to_string())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("source_url must be an HTTP(S) URL without credentials".into());
        }
        if !(5..=10080).contains(&self.interval_minutes) {
            return Err("interval_minutes must be between 5 and 10080".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CatalogModel {
    pub model_name: String,
    pub display_name: String,
    pub brand: String,
    pub aliases: Vec<String>,
    pub price_data: Option<Value>,
    pub quote_provider: String,
    pub source_version: String,
    pub adaptation: String,
    pub metadata: Value,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Counts {
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub manual_preserved: usize,
    pub failed: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Conflict {
    pub model_name: String,
    pub local_id: i64,
    pub local_price: Value,
    pub cloud_price: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub status: String,
    pub kind: String,
    pub source_url: String,
    pub source_version: String,
    pub created_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub error: Option<String>,
    pub counts: Counts,
    pub conflicts: Vec<Conflict>,
    pub models: Vec<CatalogModel>,
    pub expected: BTreeMap<String, i64>,
    #[serde(default)]
    pub catalog_generation: i64,
}
impl Job {
    pub fn view(&self) -> Value {
        json!({"id":self.id,"status":self.status,"source_url":self.source_url,"source_version":self.source_version,"created_at_ms":self.created_at_ms,"finished_at_ms":self.finished_at_ms,"error":self.error,"counts":self.counts,"conflicts":self.conflicts})
    }
}
fn decimal(v: &Value) -> Result<Decimal, String> {
    let raw = v
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string());
    let d = Decimal::from_str(&raw)
        .or_else(|_| Decimal::from_scientific(&raw))
        .map_err(|e| e.to_string())?;
    if d.is_sign_negative() {
        return Err("negative price".into());
    }
    Ok(d)
}
const CHARGES: [&str; 4] = ["prompt", "completion", "cache_read", "cache_write"];
fn rates(values: [Option<Decimal>; 4]) -> PriceRates {
    PriceRates {
        input: values[0],
        output: values[1],
        cache_read: values[2],
        cache_write: values[3],
    }
}
fn quote(p: &Value) -> Result<(PriceCard, bool), String> {
    let charges = p["charges"].as_object().ok_or("missing charges")?;
    let mut values = [None; 4];
    let mut partial = charges.keys().any(|k| !CHARGES.contains(&k.as_str()));
    for (i, key) in CHARGES.iter().enumerate() {
        if let Some(c) = charges.get(*key) {
            if c["unit"] == "per_M_tokens" {
                values[i] = Some(decimal(&c["price"])?);
            } else {
                partial = true;
            }
        }
    }
    if values.iter().all(Option::is_none) {
        return Err("no supported token prices".into());
    }
    let mut tiers = BTreeMap::new();
    for track in p["tracks"].as_array().into_iter().flatten() {
        let triggers = track["triggers"]
            .as_array()
            .ok_or("invalid track triggers")?;
        if triggers.is_empty() {
            continue;
        }
        if triggers.len() != 1 || triggers[0]["kind"] != "input_tokens_above" {
            partial = true;
            continue;
        }
        let trigger = &triggers[0];
        let threshold = trigger["threshold"]
            .as_i64()
            .and_then(|value| {
                value.checked_sub(i64::from(trigger["inclusive"].as_bool().unwrap_or(false)))
            })
            .ok_or("invalid context threshold")?;
        if threshold <= 0 {
            return Err("invalid context threshold".into());
        }
        let factor = track
            .get("factor")
            .map(decimal)
            .transpose()?
            .unwrap_or(Decimal::ONE);
        let mut tier_values = values;
        for (i, key) in CHARGES.iter().enumerate() {
            let f = track["charge_factors"]
                .get(*key)
                .map(decimal)
                .transpose()?
                .unwrap_or(factor);
            tier_values[i] = values[i]
                .map(|v| v.checked_mul(f).ok_or("price overflow"))
                .transpose()?;
        }
        if tiers.insert(threshold, rates(tier_values)).is_some() {
            return Err("ambiguous context tiers".into());
        }
    }
    Ok((
        PriceCard {
            base: rates(values),
            tiers: tiers
                .into_iter()
                .map(|(over_total_input_tokens, rates)| ContextPriceTier {
                    over_total_input_tokens,
                    rates,
                })
                .collect(),
        },
        partial,
    ))
}
pub fn parse(bytes: &[u8]) -> Result<(String, Vec<CatalogModel>, usize), String> {
    let hash = blake3::hash(bytes).to_hex().to_string();
    if bytes.iter().find(|b| !b.is_ascii_whitespace()) != Some(&b'{') {
        return parse_toml(bytes, &hash);
    }
    let root: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if root.get("schema").is_none() {
        return parse_litellm(&root, &hash);
    }
    if root["schema"] != "cchp.pricing-table/v1" || root["currency"] != "USD" {
        return Err("unsupported pricing schema or currency".into());
    }
    let version = root["version"].as_str().unwrap_or(&hash).to_string();
    let rows = root["models"].as_array().ok_or("models must be an array")?;
    let mut out = Vec::new();
    let mut failed = 0;
    for row in rows {
        let Some(name) = row["model_name"].as_str().filter(|n| !n.is_empty()) else {
            failed += 1;
            continue;
        };
        let offers = row["pricing"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let selected = [true, false].into_iter().find_map(|official| {
            offers
                .iter()
                .filter(|p| p["official"].as_bool().unwrap_or(false) == official)
                .find_map(|p| quote(p).ok().map(|q| (p, q)))
        });
        let (price_data, quote_provider, adaptation, metadata) = if let Some((p, (card, partial))) =
            selected
        {
            (
                Some(card.to_json()),
                p["provider"].as_str().unwrap_or_default().to_string(),
                if partial { "partial" } else { "supported" },
                json!({"charges":p["charges"],"tracks":p["tracks"],"warnings":p["warnings"],"source":p["source"]}),
            )
        } else {
            failed += 1;
            (
                None,
                String::new(),
                "unsupported",
                json!({"pricing":offers}),
            )
        };
        out.push(CatalogModel {
            model_name: name.into(),
            display_name: row["display_name"].as_str().unwrap_or(name).into(),
            brand: row["vendor"].as_str().unwrap_or_default().into(),
            aliases: row["aliases"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            price_data,
            quote_provider,
            source_version: version.clone(),
            adaptation: adaptation.into(),
            metadata,
        });
    }
    finalize(version, out, failed)
}
const LITELLM_RATES: [&str; 4] = [
    "input_cost_per_token",
    "output_cost_per_token",
    "cache_read_input_token_cost",
    "cache_creation_input_token_cost",
];

fn per_million(value: &Value) -> Result<Decimal, String> {
    decimal(value)?
        .checked_mul(Decimal::from(1_000_000))
        .ok_or_else(|| "price overflow".into())
}

fn litellm_card(row: &Value) -> Result<(PriceCard, bool), String> {
    let fields = row.as_object().ok_or("invalid LiteLLM model")?;
    let mut values = [None; 4];
    for (i, key) in LITELLM_RATES.iter().enumerate() {
        values[i] = fields
            .get(*key)
            .filter(|v| !v.is_null())
            .map(per_million)
            .transpose()?;
    }
    if values.iter().all(Option::is_none) {
        return Err("no supported token prices".into());
    }
    let base = rates(values);
    let mut tiers = BTreeMap::new();
    let mut partial = false;
    for (key, value) in fields {
        if LITELLM_RATES.contains(&key.as_str()) || value.is_null() {
            continue;
        }
        let mut supported = false;
        for (i, base_key) in LITELLM_RATES.iter().enumerate() {
            if let Some(threshold) = key
                .strip_prefix(&format!("{base_key}_above_"))
                .and_then(|suffix| suffix.strip_suffix("_tokens"))
            {
                let (digits, multiplier) = threshold
                    .strip_suffix('k')
                    .map(|n| (n, 1000_i64))
                    .unwrap_or((threshold, 1));
                // Duration-qualified prices are not pure context tiers.
                if !digits.bytes().all(|b| b.is_ascii_digit()) {
                    continue;
                }
                let threshold = digits
                    .parse::<i64>()
                    .ok()
                    .and_then(|n| n.checked_mul(multiplier))
                    .filter(|n| *n > 0)
                    .ok_or("invalid LiteLLM context threshold")?;
                tiers.entry(threshold).or_insert([None; 4])[i] = Some(per_million(value)?);
                supported = true;
                break;
            }
        }
        if !supported && key.contains("cost") {
            partial = true;
        }
    }
    Ok((
        PriceCard {
            base,
            tiers: tiers
                .into_iter()
                .map(|(over_total_input_tokens, updates)| {
                    for (current, update) in values.iter_mut().zip(updates) {
                        if update.is_some() {
                            *current = update;
                        }
                    }
                    ContextPriceTier {
                        over_total_input_tokens,
                        rates: rates(values),
                    }
                })
                .collect(),
        },
        partial,
    ))
}

fn parse_litellm(
    root: &Value,
    version: &str,
) -> Result<(String, Vec<CatalogModel>, usize), String> {
    let rows = root
        .as_object()
        .ok_or("LiteLLM catalog must be an object")?;
    let mut out = Vec::new();
    let mut failed = 0;
    for (name, row) in rows {
        if name == "sample_spec" {
            continue;
        }
        if name.is_empty() || !row.is_object() {
            failed += 1;
            continue;
        }
        let (price_data, adaptation) = match litellm_card(row) {
            Ok((card, partial)) => (
                Some(card.to_json()),
                if partial { "partial" } else { "supported" },
            ),
            Err(_) => {
                failed += 1;
                (None, "unsupported")
            }
        };
        let provider = row["litellm_provider"].as_str().unwrap_or_default();
        out.push(CatalogModel {
            model_name: name.clone(),
            display_name: row["display_name"].as_str().unwrap_or(name).into(),
            // Hosting providers do not necessarily identify the model's manufacturer.
            brand: String::new(),
            aliases: vec![],
            price_data,
            quote_provider: provider.into(),
            source_version: version.into(),
            adaptation: adaptation.into(),
            metadata: row.clone(),
        });
    }
    finalize(version.into(), out, failed)
}

fn finalize(
    version: String,
    models: Vec<CatalogModel>,
    mut failed: usize,
) -> Result<(String, Vec<CatalogModel>, usize), String> {
    let mut grouped: BTreeMap<String, Vec<CatalogModel>> = BTreeMap::new();
    for m in models {
        grouped.entry(m.model_name.clone()).or_default().push(m);
    }
    let canonical: HashSet<_> = grouped.keys().cloned().collect();
    let mut out = Vec::new();
    for (_, mut group) in grouped {
        if group.len() == 1 {
            out.push(group.remove(0));
        } else {
            failed += group.len();
        }
    }
    if out.is_empty() || out.iter().all(|m| m.price_data.is_none()) {
        return Err("catalog contains no valid token prices".into());
    }
    // Only explicit, unique aliases can become price keys; canonical IDs always win.
    let mut aliases: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, m) in out.iter().enumerate() {
        for a in &m.aliases {
            if !a.is_empty() && !canonical.contains(a) {
                aliases.entry(a.clone()).or_default().push(i);
            }
        }
    }
    for (alias, mut indices) in aliases {
        indices.sort_unstable();
        indices.dedup();
        if indices.len() == 1 {
            let mut m = out[indices[0]].clone();
            m.model_name = alias;
            out.push(m);
        }
    }
    Ok((version, out, failed))
}
fn legacy_rate(item: &toml_edit::Item) -> Result<Decimal, String> {
    let mut value = item.as_value().ok_or("invalid TOML price")?.clone();
    value.decor_mut().clear();
    let raw = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string().replace('_', ""));
    decimal(&Value::String(raw))?
        .checked_mul(Decimal::from(1_000_000))
        .ok_or_else(|| "price overflow".into())
}
fn parse_toml(bytes: &[u8], hash: &str) -> Result<(String, Vec<CatalogModel>, usize), String> {
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| e.to_string())?;
    let version = doc
        .get("metadata")
        .and_then(|m| m.get("version"))
        .and_then(toml_edit::Item::as_str)
        .unwrap_or(hash);
    let table = doc
        .get("models")
        .and_then(toml_edit::Item::as_table)
        .unwrap_or(doc.as_table());
    let keys = [
        "input_cost_per_token",
        "output_cost_per_token",
        "cache_read_input_token_cost",
        "cache_creation_input_token_cost",
    ];
    let mut out = Vec::new();
    let mut failed = 0;
    for (name, item) in table {
        if name == "metadata" {
            continue;
        }
        let parsed = (|| -> Result<PriceCard, String> {
            let mut values = [None; 4];
            for (i, key) in keys.iter().enumerate() {
                values[i] = item.get(key).map(legacy_rate).transpose()?;
            }
            if values.iter().all(Option::is_none) {
                return Err("no prices".into());
            }
            let mut tiers = BTreeMap::new();
            for (key, value) in item.as_table_like().ok_or("invalid model table")?.iter() {
                for (i, base_key) in keys.iter().enumerate() {
                    if let Some(suffix) = key.strip_prefix(&format!("{base_key}_above_"))
                        && let Some(threshold) = suffix.strip_suffix("_tokens")
                    {
                        let (digits, multiplier) = threshold
                            .strip_suffix('k')
                            .map(|n| (n, 1000_i64))
                            .unwrap_or((threshold, 1));
                        let threshold = digits
                            .parse::<i64>()
                            .ok()
                            .and_then(|n| n.checked_mul(multiplier))
                            .filter(|n| *n > 0)
                            .ok_or("invalid legacy context threshold")?;
                        tiers.entry(threshold).or_insert([None; 4])[i] = Some(legacy_rate(value)?);
                    }
                }
            }
            Ok(PriceCard {
                base: rates(values),
                tiers: tiers
                    .into_iter()
                    .map(|(over_total_input_tokens, updates)| {
                        for (current, update) in values.iter_mut().zip(updates) {
                            if update.is_some() {
                                *current = update;
                            }
                        }
                        ContextPriceTier {
                            over_total_input_tokens,
                            rates: rates(values),
                        }
                    })
                    .collect(),
            })
        })();
        let price_data = match parsed {
            Ok(card) => Some(card.to_json()),
            Err(_) => {
                failed += 1;
                None
            }
        };
        out.push(CatalogModel {
            model_name: name.into(),
            display_name: item
                .get("display_name")
                .and_then(toml_edit::Item::as_str)
                .unwrap_or(name)
                .into(),
            brand: String::new(),
            aliases: vec![],
            adaptation: if price_data.is_some() {
                "partial"
            } else {
                "unsupported"
            }
            .into(),
            price_data,
            quote_provider: item
                .get("litellm_provider")
                .and_then(toml_edit::Item::as_str)
                .unwrap_or("legacy")
                .into(),
            source_version: version.into(),
            metadata: json!({"legacy_toml":item.to_string()}),
        });
    }
    finalize(version.into(), out, failed)
}

static TASK_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
async fn download(
    client: &crate::upstream::UpstreamClient,
    source: &str,
) -> Result<Vec<u8>, String> {
    download_limited(client, source, Duration::from_secs(60), 64 * 1024 * 1024).await
}
async fn download_limited(
    client: &crate::upstream::UpstreamClient,
    source: &str,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    tokio::time::timeout(timeout, async {
        let req = Request::builder()
            .method(Method::GET)
            .uri(source)
            .header("Accept", "application/json, application/toml, text/plain")
            .body(Full::new(Bytes::new()))
            .map_err(|e| e.to_string())?;
        let response = client.request(req).await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("pricing source returned {}", response.status()));
        }
        if response
            .headers()
            .get(hyper::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|size| size > max_bytes as u64)
        {
            return Err("pricing response exceeds size limit".into());
        }
        let bytes = Limited::new(response.into_body(), max_bytes)
            .collect()
            .await
            .map_err(|e| e.to_string())?
            .to_bytes();
        Ok(bytes.to_vec())
    })
    .await
    .map_err(|_| {
        format!(
            "pricing download timed out after {} seconds",
            timeout.as_secs()
        )
    })?
}
struct LeaseHeartbeat(tokio::task::JoinHandle<()>);
impl Drop for LeaseHeartbeat {
    fn drop(&mut self) {
        self.0.abort();
    }
}
fn heartbeat(state: SharedState, owner: String) -> LeaseHeartbeat {
    LeaseHeartbeat(tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            match state.db.sync_renew(&owner, util::now_ms()).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => {
                    log::warn!("price sync lease renewal failed: {e}");
                    break;
                }
            }
        }
    }))
}
async fn start(state: SharedState, preview: bool) -> Result<String, String> {
    let _guard = TASK_GATE.lock().await;
    let config = state.runtime_settings.snapshot().price_sync;
    config.validate()?;
    let id = ulid::Ulid::new().to_string();
    let now = util::now_ms();
    if !state
        .db
        .sync_lease(&id, &id, now)
        .await
        .map_err(|e| e.to_string())?
    {
        let status = state.db.sync_status().await.map_err(|e| e.to_string())?;
        if let Some(id) = status["last_job_id"].as_str()
            && let Some(job) = state.db.sync_job(id).await.map_err(|e| e.to_string())?
            && job.status == "running"
            && job.kind == if preview { "preview" } else { "automatic" }
            && job.source_url == config.source_url
        {
            return Ok(id.to_owned());
        }
        return Err("a price sync task is already running".into());
    }
    let job = Job {
        id: id.clone(),
        status: "running".into(),
        kind: if preview { "preview" } else { "automatic" }.into(),
        source_url: config.source_url,
        source_version: String::new(),
        created_at_ms: now,
        finished_at_ms: None,
        error: None,
        counts: Counts::default(),
        conflicts: vec![],
        models: vec![],
        expected: BTreeMap::new(),
        catalog_generation: 0,
    };
    if let Err(e) = state.db.save_sync_job(&job).await {
        let _ = state.db.sync_release(&id).await;
        return Err(e.to_string());
    }
    tokio::spawn(async move {
        let _heartbeat = heartbeat(state.clone(), job.id.clone());
        let mut job = job;
        let result = async {
            let bytes = download(&state.upstream, &job.source_url).await?;
            let (version, models, failed) = tokio::task::spawn_blocking(move || parse(&bytes))
                .await
                .map_err(|e| e.to_string())??;
            job.source_version = version;
            job.models = models;
            job.counts.failed = failed;
            state
                .db
                .prepare_sync(&mut job)
                .await
                .map_err(|e| e.to_string())?;
            if preview {
                job.status = "preview".into();
            } else {
                job.counts = state
                    .db
                    .apply_sync(&job, &HashSet::new(), &job.id)
                    .await
                    .map_err(|e| e.to_string())?;
                job.status = "applied".into();
                state.caches.upstream.invalidate();
                if let Err(e) =
                    crate::admin::reconcile_unpriced_usage(&state, i64::MIN, i64::MAX).await
                {
                    job.error = Some(format!("history reconciliation pending: {e}"));
                }
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(e) = result {
            job.status = "failed".into();
            job.error = Some(e);
            job.counts.failed += 1;
        }
        job.finished_at_ms = Some(util::now_ms());
        if job.status != "preview" {
            job.models.clear();
            job.expected.clear();
            job.conflicts.clear();
        }
        if let Err(e) = state.db.save_sync_job(&job).await {
            log::error!("save price sync result: {e}");
        }
        if let Err(e) = state.db.sync_release(&job.id).await {
            log::error!("release price sync lease: {e}");
        }
    });
    Ok(id)
}
pub fn spawn(state: SharedState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        let mut cache_generation = -1;
        let mut first = true;
        loop {
            interval.tick().await;
            // Reload persisted settings so other instances observe administrator changes.
            if let Ok(settings) =
                crate::runtime_settings::RuntimeSettings::load(&state.config, &state.db).await
            {
                state
                    .runtime_settings
                    .replace_price_sync(settings.snapshot().price_sync);
            }
            let config = state.runtime_settings.snapshot().price_sync;
            let Ok(status) = state.db.sync_status().await else {
                continue;
            };
            let generation = status["catalog_generation"].as_i64().unwrap_or(0);
            if generation != cache_generation {
                state.caches.upstream.invalidate();
                cache_generation = generation;
            }
            if !config.enabled {
                continue;
            }
            if status["running"] == true {
                continue;
            }
            let now = util::now_ms();
            let last = status["last_attempt_ms"].as_i64().unwrap_or(0);
            let due = (first && now - last >= 300_000)
                || now - last >= i64::from(config.interval_minutes) * 60_000;
            first = false;
            let version = status["catalog_version"].as_str().unwrap_or_default();
            let missing = !due
                && now - last >= 300_000
                && state.db.sync_has_missing(version).await.unwrap_or(false);
            if (due || missing)
                && let Err(e) = start(state.clone(), false).await
            {
                log::warn!("price sync: {e}");
            }
        }
    });
}
#[derive(Deserialize)]
struct ApplyRequest {
    source_version: String,
    #[serde(default)]
    use_cloud: HashSet<String>,
}
pub async fn handle(req: Request<hyper::body::Incoming>, state: SharedState) -> HttpResponse {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let result: Result<Value, String> = async {
        match (method, path.as_str()) {
            (Method::GET, "/api/v1/price-sync") => {
                let mut status = state.db.sync_status().await.map_err(|e| e.to_string())?;
                let config = state.runtime_settings.snapshot().price_sync;
                status["next_run_ms"] = if config.enabled {
                    json!(
                        status["last_attempt_ms"].as_i64().unwrap_or(util::now_ms())
                            + i64::from(config.interval_minutes) * 60_000
                    )
                } else {
                    Value::Null
                };
                status["config"] = json!(config);
                if let Some(id) = status["last_job_id"].as_str()
                    && let Some(job) = state.db.sync_job(id).await.map_err(|e| e.to_string())?
                {
                    status["last_job"] = job.view();
                }
                Ok(status)
            }
            (Method::PUT, "/api/v1/price-sync/config") => {
                let (_, config, _) = http::read_json_limited::<SyncConfig>(req, 16384)
                    .await
                    .map_err(|_| "invalid sync configuration".to_string())?;
                config.validate()?;
                state
                    .runtime_settings
                    .update(&state.db, "price_sync", json!(config), util::now_ms())
                    .await?;
                Ok(json!(config))
            }
            (Method::POST, "/api/v1/price-sync/preview") => {
                Ok(json!({"id":start(state.clone(),true).await?}))
            }
            (Method::GET, _) if path.starts_with("/api/v1/price-sync/jobs/") => {
                let id = path.trim_start_matches("/api/v1/price-sync/jobs/");
                let mut job = state
                    .db
                    .sync_job(id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("job not found or expired")?;
                if job.status == "running"
                    && util::now_ms() - job.created_at_ms > 300_000
                    && !state.db.sync_status().await.map_err(|e| e.to_string())?["running"]
                        .as_bool()
                        .unwrap_or(false)
                {
                    job.status = "failed".into();
                    job.error = Some("worker lease expired; retry synchronization".into());
                }
                Ok(job.view())
            }
            (Method::POST, _) if path.starts_with("/api/v1/price-sync/apply/") => {
                let (_, body, _) =
                    http::read_json_limited::<ApplyRequest>(req, state.config.max_request_bytes)
                        .await
                        .map_err(|_| "invalid apply request".to_string())?;
                let id = path.trim_start_matches("/api/v1/price-sync/apply/");
                let mut job = state
                    .db
                    .sync_job(id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("preview not found or expired")?;
                if job.status != "preview"
                    || job.source_version != body.source_version
                    || util::now_ms() - job.created_at_ms > 86_400_000
                {
                    return Err("preview version is stale; create a new preview".into());
                }
                if body
                    .use_cloud
                    .iter()
                    .any(|name| !job.conflicts.iter().any(|c| &c.model_name == name))
                {
                    return Err("unknown manual conflict selection".into());
                }
                let owner = ulid::Ulid::new().to_string();
                if !state
                    .db
                    .sync_lease(&owner, &job.id, util::now_ms())
                    .await
                    .map_err(|e| e.to_string())?
                {
                    return Err("a price sync task is already running".into());
                }
                job.status = "running".into();
                job.kind = "apply".into();
                job.finished_at_ms = None;
                if let Err(e) = state.db.save_sync_job(&job).await {
                    let _ = state.db.sync_release(&owner).await;
                    return Err(e.to_string());
                }
                let view = job.view();
                tokio::spawn(async move {
                    let _heartbeat = heartbeat(state.clone(), owner.clone());
                    match state.db.apply_sync(&job, &body.use_cloud, &owner).await {
                        Ok(counts) => {
                            job.counts = counts;
                            job.status = "applied".into();
                            state.caches.upstream.invalidate();
                            if let Err(e) =
                                crate::admin::reconcile_unpriced_usage(&state, i64::MIN, i64::MAX)
                                    .await
                            {
                                job.error = Some(format!("history reconciliation pending: {e}"));
                            }
                        }
                        Err(e) => {
                            job.status = "failed".into();
                            job.error = Some(e.to_string());
                        }
                    }
                    job.finished_at_ms = Some(util::now_ms());
                    job.models.clear();
                    job.expected.clear();
                    job.conflicts.clear();
                    if let Err(e) = state.db.save_sync_job(&job).await {
                        log::error!("save applied sync job: {e}");
                    }
                    if let Err(e) = state.db.sync_release(&owner).await {
                        log::error!("release sync lease: {e}");
                    }
                });
                Ok(view)
            }
            _ => Err("unknown price sync endpoint".into()),
        }
    }
    .await;
    match result {
        Ok(value) => http::json(
            if path.ends_with("/preview") || path.starts_with("/api/v1/price-sync/apply/") {
                StatusCode::ACCEPTED
            } else {
                StatusCode::OK
            },
            &value,
        ),
        Err(e) => http::json_error(StatusCode::CONFLICT, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(models: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"schema":"cchp.pricing-table/v1","currency":"USD","version":"test-v1","models":models})).unwrap()
    }
    fn offer(price: &str, official: bool) -> Value {
        json!({"provider":if official {"maker"} else {"reseller"},"official":official,"charges":{"prompt":{"unit":"per_M_tokens","price":price},"completion":{"unit":"per_M_tokens","price":"2"}}})
    }
    #[test]
    fn parses_published_catalog_fixture() {
        let bytes = std::env::var("PRICE_SYNC_TEST_CATALOG")
            .ok()
            .map(|path| std::fs::read(path).unwrap())
            .unwrap_or_else(|| include_bytes!("../tests/fixtures/litellm-pricing.json").to_vec());
        let (version, models, failed) = parse(&bytes).unwrap();
        assert!(!version.is_empty());
        assert!(!models.is_empty());
        for model in &models {
            if let Some(card) = &model.price_data {
                PriceCard::from_json(card).unwrap();
            }
        }
        println!(
            "parsed {} model IDs including unambiguous aliases; {} unsupported/invalid rows",
            models.len(),
            failed
        );
    }
    #[test]
    fn litellm_prices_preserve_units_tiers_and_provider_ids() {
        let (_, models, failed) = parse(
            br#"{
            "sample_spec": {"input_cost_per_token": 0},
            "provider/model": {
                "litellm_provider": "provider",
                "input_cost_per_token": 0.000000123456789012345678,
                "output_cost_per_token": 2e-6,
                "cache_read_input_token_cost": 0,
                "cache_creation_input_token_cost": null,
                "input_cost_per_token_above_200k_tokens": 2.5e-6,
                "output_cost_per_token_above_400k_tokens": 4e-6,
                "input_cost_per_token_above_200k_tokens_priority": 9e-6,
                "cache_creation_input_token_cost_above_1hr_above_200k_tokens": 9e-6
            },
            "image": {"output_cost_per_image": 0.04},
            "negative": {"input_cost_per_token": -1},
            "malformed": {"input_cost_per_token": "nope"}
        }"#,
        )
        .unwrap();
        assert_eq!(failed, 3);
        assert_eq!(models.len(), 4);
        let model = models
            .iter()
            .find(|m| m.model_name == "provider/model")
            .unwrap();
        assert_eq!(model.quote_provider, "provider");
        assert!(model.aliases.is_empty());
        assert_eq!(model.adaptation, "partial");
        let card = PriceCard::from_json(model.price_data.as_ref().unwrap()).unwrap();
        assert_eq!(
            card.base.input.unwrap().normalize().to_string(),
            "0.123456789012345678"
        );
        assert_eq!(card.base.output, Some(Decimal::from(2)));
        assert_eq!(card.base.cache_read, Some(Decimal::ZERO));
        assert_eq!(card.base.cache_write, None);
        assert_eq!(card.tiers.len(), 2);
        assert_eq!(card.tiers[0].over_total_input_tokens, 200_000);
        assert_eq!(
            card.tiers[0].rates.input.unwrap().normalize().to_string(),
            "2.5"
        );
        assert_eq!(card.tiers[0].rates.output, Some(Decimal::from(2)));
        assert_eq!(card.tiers[1].over_total_input_tokens, 400_000);
        assert_eq!(card.tiers[1].rates.input, card.tiers[0].rates.input);
        assert_eq!(card.tiers[1].rates.output, Some(Decimal::from(4)));
        assert!(
            models
                .iter()
                .filter(|m| m.model_name != "provider/model")
                .all(|m| m.price_data.is_none())
        );
    }

    #[test]
    fn litellm_rejects_catalogs_without_real_token_prices() {
        assert!(parse(br#"{"sample_spec":{"input_cost_per_token":0}}"#).is_err());
        assert!(parse(br#"{"error":"upstream unavailable"}"#).is_err());
    }

    #[test]
    fn legacy_context_tiers_and_comments_are_exact() {
        let (_, models, _) = parse(
            br#"[metadata]
version = "legacy-v1"
[models."test"]
input_cost_per_token = 1e-6 # one dollar per million
output_cost_per_token = 2e-6
input_cost_per_token_above_200k_tokens = 2.5e-6
output_cost_per_token_above_400k_tokens = 4e-6
"#,
        )
        .unwrap();
        let card = PriceCard::from_json(models[0].price_data.as_ref().unwrap()).unwrap();
        assert_eq!(models[0].source_version, "legacy-v1");
        assert_eq!(card.tiers[0].over_total_input_tokens, 200000);
        assert_eq!(
            card.tiers[0].rates.input.unwrap().normalize().to_string(),
            "2.5"
        );
        assert_eq!(
            card.tiers[0].rates.output.unwrap().normalize().to_string(),
            "2"
        );
        assert_eq!(
            card.tiers[1].rates.input.unwrap().normalize().to_string(),
            "2.5"
        );
        assert_eq!(
            card.tiers[1].rates.output.unwrap().normalize().to_string(),
            "4"
        );
    }
    #[test]
    fn numeric_json_prices_keep_decimal_precision() {
        let (_,models,_) = parse(br#"{"schema":"cchp.pricing-table/v1","currency":"USD","models":[{"model_name":"precise","pricing":[{"charges":{"prompt":{"unit":"per_M_tokens","price":0.123456789012345678}}}]}]}"#).unwrap();
        assert_eq!(
            models[0].price_data.as_ref().unwrap()["base"]["input"],
            "0.123456789012345678"
        );
    }
    #[test]
    fn aliases_cannot_replace_ambiguous_canonical_ids() {
        let (_, models, _) = parse(&document(json!([
            {"model_name":"a","aliases":["duplicate"],"pricing":[offer("1",true)]},
            {"model_name":"duplicate","pricing":[offer("1",true)]},
            {"model_name":"duplicate","pricing":[offer("2",true)]}
        ])))
        .unwrap();
        assert!(!models.iter().any(|model| model.model_name == "duplicate"));
    }
    #[tokio::test]
    async fn migration_labels_existing_price_versions_manual() {
        use sqlx::Row;
        let db = crate::db::Database::connect("sqlite::memory:", 1)
            .await
            .unwrap();
        let crate::db::Database::Sqlite(pool) = &db else {
            unreachable!()
        };
        sqlx::raw_sql("CREATE TABLE model_prices (id INTEGER PRIMARY KEY); INSERT INTO model_prices(id) VALUES(1),(2);").execute(pool).await.unwrap();
        db.migrate_price_sync().await.unwrap();
        db.migrate_price_sync().await.unwrap();
        let rows = sqlx::query("SELECT source,source_version FROM model_prices")
            .fetch_all(pool)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .all(|row| row.get::<String, _>("source") == "manual"
                    && row.get::<Option<String>, _>("source_version").is_none())
        );
    }
    #[test]
    fn selects_first_valid_official_quote_and_preserves_unknown_rates() {
        let bytes = document(
            json!([{"model_name":"m","pricing":[offer("9",false),offer("-1",true),offer("0.123456789012345678",true),offer("3",true)]}]),
        );
        let (_, models, _) = parse(&bytes).unwrap();
        assert_eq!(models[0].quote_provider, "maker");
        let card = PriceCard::from_json(models[0].price_data.as_ref().unwrap()).unwrap();
        assert_eq!(card.base.input.unwrap().to_string(), "0.123456789012345678");
        assert_eq!(card.base.cache_read, None);
    }
    #[test]
    fn adapts_only_pure_context_tracks_with_exact_inclusive_boundaries() {
        let mut p = offer("1.25", true);
        p["tracks"] = json!([
            {"factor":"1","charge_factors":{"prompt":"2"},"triggers":[{"kind":"input_tokens_above","threshold":200000,"inclusive":true}]},
            {"factor":"0.5","triggers":[{"kind":"body_matches","field":"service_tier","pattern":"batch"}]}
        ]);
        let (card, partial) = quote(&p).unwrap();
        assert!(partial);
        assert_eq!(card.tiers[0].over_total_input_tokens, 199999);
        assert_eq!(card.tiers[0].rates.input.unwrap().to_string(), "2.50");
        assert_eq!(
            card.tier_index_for_usage(&crate::types::Usage {
                input_tokens: 199999,
                ..Default::default()
            }),
            0
        );
        assert_eq!(
            card.tier_index_for_usage(&crate::types::Usage {
                input_tokens: 200000,
                ..Default::default()
            }),
            1
        );
    }
    #[test]
    fn legacy_toml_converts_per_token_without_float_rounding() {
        let (_, models, _) = parse(
            br#"["test-model"]
input_cost_per_token = 0.000000123456789
output_cost_per_token = 2e-6
"#,
        )
        .unwrap();
        let card = PriceCard::from_json(models[0].price_data.as_ref().unwrap()).unwrap();
        assert_eq!(
            card.base.input.unwrap().normalize().to_string(),
            "0.123456789"
        );
        assert_eq!(card.base.output.unwrap().normalize().to_string(), "2");
    }
    #[test]
    fn invalid_rows_do_not_abort_valid_catalog_and_ambiguous_aliases_are_ignored() {
        let (_,models,failed)=parse(&document(json!([
            {"model_name":"a","aliases":["common","unique","b"],"pricing":[offer("1",true)]},
            {"model_name":"b","aliases":["common"],"pricing":[offer("2",true)]},
            {"model_name":"image","pricing":[{"charges":{"image":{"unit":"per_image","price":"3"}}}]},
            {"pricing":[]}
        ]))).unwrap();
        assert_eq!(failed, 2);
        assert!(!models.iter().any(|m| m.model_name == "common"));
        assert_eq!(models.iter().filter(|m| m.model_name == "b").count(), 1);
        assert!(models.iter().any(|m| m.model_name == "unique"));
        assert!(
            models
                .iter()
                .find(|m| m.model_name == "image")
                .unwrap()
                .price_data
                .is_none()
        );
    }
    #[test]
    fn rejects_empty_and_wrong_currency_documents() {
        assert!(parse(&document(json!([]))).is_err());
        assert!(
            parse(br#"{"schema":"cchp.pricing-table/v1","currency":"CNY","models":[]}"#).is_err()
        );
    }
    #[tokio::test]
    async fn sync_preserves_manual_prices_versions_and_inventory_and_rejects_stale_preview() {
        let dsn = std::env::var("PRICE_SYNC_TEST_DB").unwrap_or_else(|_| "sqlite::memory:".into());
        let db = crate::db::Database::connect(&dsn, 1).await.unwrap();
        db.migrate().await.unwrap();
        db.migrate().await.unwrap();
        let (_,models,_)=parse(&document(json!([{"model_name":"m","pricing":[offer("1",true)]},{"model_name":"n","pricing":[offer("2",true)]}]))).unwrap();
        let manual = db
            .insert_model_price(
                None,
                "m",
                &models[1].price_data.as_ref().unwrap().to_string(),
                1,
            )
            .await
            .unwrap();
        let make_job = || Job {
            id: ulid::Ulid::new().to_string(),
            status: "preview".into(),
            kind: "preview".into(),
            source_url: DEFAULT_SOURCE.into(),
            source_version: "v1".into(),
            created_at_ms: util::now_ms(),
            finished_at_ms: None,
            error: None,
            counts: Counts::default(),
            conflicts: vec![],
            models: models.clone(),
            expected: BTreeMap::new(),
            catalog_generation: 0,
        };
        let mut first = make_job();
        db.prepare_sync(&mut first).await.unwrap();
        assert_eq!(first.conflicts[0].local_id, manual);
        assert!(
            db.sync_lease("worker", "test-job", util::now_ms())
                .await
                .unwrap()
        );
        assert!(
            !db.sync_lease("other", "test-job", util::now_ms())
                .await
                .unwrap()
        );
        let counts = db
            .apply_sync(&first, &HashSet::new(), "worker")
            .await
            .unwrap();
        assert_eq!(counts.manual_preserved, 1);
        assert_eq!(counts.added, 1);
        assert!(db.list_all_provider_models().await.unwrap().is_empty());
        let prices = db.list_latest_model_prices().await.unwrap();
        assert_eq!(
            prices.iter().find(|p| p.model_name == "m").unwrap().id,
            manual
        );
        let cloud_id = prices.iter().find(|p| p.model_name == "n").unwrap().id;
        let mut unchanged = make_job();
        db.prepare_sync(&mut unchanged).await.unwrap();
        assert_eq!(
            db.apply_sync(&unchanged, &HashSet::new(), "worker")
                .await
                .unwrap()
                .unchanged,
            1
        );
        assert_eq!(
            db.list_latest_model_prices()
                .await
                .unwrap()
                .iter()
                .find(|p| p.model_name == "n")
                .unwrap()
                .id,
            cloud_id
        );
        let mut concurrent_edit = make_job();
        db.prepare_sync(&mut concurrent_edit).await.unwrap();
        db.update_model_price(
            manual,
            &models[0].price_data.as_ref().unwrap().to_string(),
            3,
        )
        .await
        .unwrap();
        assert!(
            db.apply_sync(&concurrent_edit, &HashSet::from(["m".into()]), "worker")
                .await
                .is_err()
        );
        assert_eq!(db.list_price_versions(&[manual]).await.unwrap().len(), 1);
        // Explicitly selected manual conflicts become cloud versions; older previews are fenced.
        let mut selected = make_job();
        db.prepare_sync(&mut selected).await.unwrap();
        db.apply_sync(&selected, &HashSet::from(["m".into()]), "worker")
            .await
            .unwrap();
        assert!(
            db.apply_sync(&selected, &HashSet::new(), "worker")
                .await
                .is_err()
        );
        let ids = db
            .list_latest_model_prices()
            .await
            .unwrap()
            .iter()
            .map(|p| p.id)
            .collect::<Vec<_>>();
        let mut metadata_only = make_job();
        metadata_only.models[0].display_name = "Updated display".into();
        db.prepare_sync(&mut metadata_only).await.unwrap();
        assert_eq!(
            db.apply_sync(&metadata_only, &HashSet::new(), "worker")
                .await
                .unwrap()
                .unchanged,
            2
        );
        assert_eq!(
            ids,
            db.list_latest_model_prices()
                .await
                .unwrap()
                .iter()
                .map(|p| p.id)
                .collect::<Vec<_>>()
        );
        let mut missing_source = make_job();
        missing_source.models.retain(|m| m.model_name != "n");
        db.prepare_sync(&mut missing_source).await.unwrap();
        db.apply_sync(&missing_source, &HashSet::new(), "worker")
            .await
            .unwrap();
        assert_eq!(db.cloud_display().await.unwrap()["n"]["present"], false);
        assert_eq!(db.list_latest_model_prices().await.unwrap().len(), 2);
        // Negative results are shared across workers and invalidated by new model IDs.
        let provider = db
            .insert_upstream_provider(
                "negative-cache-test",
                "openai_compatible",
                true,
                100,
                1,
                true,
                false,
                &[],
                &crate::request_overrides::RequestOverrides::default(),
                "round_robin",
                2,
                None,
                true,
                3,
                30000,
                2,
                util::now_ms(),
            )
            .await
            .unwrap();
        db.upsert_provider_models(provider, &["unknown-one".into()], util::now_ms())
            .await
            .unwrap();
        assert!(db.sync_has_missing("v1").await.unwrap());
        let mut negative = make_job();
        db.prepare_sync(&mut negative).await.unwrap();
        db.apply_sync(&negative, &HashSet::new(), "worker")
            .await
            .unwrap();
        assert!(!db.sync_has_missing("v1").await.unwrap());
        assert!(db.sync_has_missing("new-version").await.unwrap());
        db.upsert_provider_models(
            provider,
            &["unknown-one".into(), "unknown-two".into()],
            util::now_ms(),
        )
        .await
        .unwrap();
        assert!(db.sync_has_missing("v1").await.unwrap());
        db.sync_release("worker").await.unwrap();
        assert!(
            db.sync_lease("recovered", "test-job", util::now_ms())
                .await
                .unwrap()
        );
    }
    #[tokio::test]
    async fn download_rejects_http_failures_oversized_bodies_and_timeouts() {
        use std::io::{Read, Write};
        let client =
            crate::upstream::new_upstream_client(Duration::from_secs(1), Duration::from_secs(1), 1)
                .unwrap();
        for (response, delay, expected) in [
            (
                "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n",
                0,
                "503",
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n",
                0,
                "size limit",
            ),
            (
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n20\r\n12345678901234567890123456789012xx\r\n0\r\n\r\n",
                0,
                "length limit",
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
                200,
                "timed out",
            ),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/catalog", listener.local_addr().unwrap());
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = [0; 1024];
                let _ = socket.read(&mut request);
                std::thread::sleep(Duration::from_millis(delay));
                let _ = socket.write_all(response.as_bytes());
            });
            let error = download_limited(&client, &url, Duration::from_millis(100), 16)
                .await
                .unwrap_err();
            assert!(error.contains(expected), "{error}");
            worker.join().unwrap();
        }
    }
    #[tokio::test]
    async fn expired_worker_is_fenced_and_lease_can_be_recovered() {
        let db = crate::db::Database::connect("sqlite::memory:", 1)
            .await
            .unwrap();
        db.migrate().await.unwrap();
        assert!(db.sync_lease("old", "test-job", 1).await.unwrap());
        assert!(db.sync_lease("new", "test-job", 300_002).await.unwrap());
        db.sync_release("old").await.unwrap();
        assert!(!db.sync_lease("third", "test-job", 300_003).await.unwrap());
    }
}
