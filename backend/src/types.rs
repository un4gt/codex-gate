use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct ApiKeyAuth {
    pub id: i64,
    pub enabled: bool,
    pub expires_at_ms: Option<i64>,
    pub log_enabled: bool,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct UpstreamProvider {
    pub id: i64,
    pub name: String,
    pub provider_type: String,
    pub enabled: bool,
    pub priority: i32,
    pub weight: i32,
    pub supports_include_usage: bool,
}

#[derive(Clone, Debug)]
pub struct UpstreamKey {
    pub id: i64,
    pub provider_id: i64,
    pub name: String,
    pub secret: String,
    pub enabled: bool,
    pub priority: i32,
    pub weight: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpstreamKeyMeta {
    pub id: i64,
    pub provider_id: i64,
    pub name: String,
    pub enabled: bool,
    pub priority: i32,
    pub weight: i32,
}

#[derive(Clone, Debug)]
pub struct UpstreamEndpoint {
    pub id: i64,
    pub provider_id: i64,
    pub name: String,
    pub base_url: String,
    pub enabled: bool,
    pub priority: i32,
    pub weight: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelRoute {
    pub id: i64,
    pub model_name: String,
    pub enabled: bool,
    pub provider_ids: Vec<i64>,
}

/// Matches `claude-code-hub`'s `ModelPriceData` *fields* for the ones we need in v1.
/// We store the raw JSON in DB, but extract these numeric fields for fast cost computation.
#[derive(Clone, Debug, Default)]
pub struct ModelPriceData {
    pub input_cost_per_token: Option<Decimal>,
    pub output_cost_per_token: Option<Decimal>,
    pub cache_creation_input_token_cost: Option<Decimal>,
    pub cache_creation_input_token_cost_above_1hr: Option<Decimal>,
    pub cache_read_input_token_cost: Option<Decimal>,
}

#[derive(Clone, Debug)]
pub struct ModelPrice {
    pub id: i64,
    pub provider_id: Option<i64>,
    pub model_name: String,
    pub price_data_json: String,
    pub price: ModelPriceData,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub cache_creation_input_tokens: i64,
}

impl Usage {
    pub fn total_tokens(&self) -> i64 {
        self.input_tokens + self.output_tokens
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ApiFormat {
    ChatCompletions,
    Responses,
}

#[derive(Clone, Debug, Serialize)]
pub struct StatsDailyRow {
    pub date: String,    // YYYYMMDD (UTC)
    pub api_key_id: i64, // 0 = global
    pub request_success: i64,
    pub request_failed: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cost_in_usd: String,    // fixed scale 15
    pub cost_out_usd: String,   // fixed scale 15
    pub cost_total_usd: String, // fixed scale 15
    pub wait_time_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogRow {
    pub id: String, // ULID
    pub time_ms: i64,
    pub api_key_id: i64,
    pub provider_id: Option<i64>,
    pub endpoint_id: Option<i64>,
    pub upstream_key_id: Option<i64>,
    pub api_format: String,
    pub model: Option<String>,
    pub http_status: Option<i32>,
    pub error_type: Option<String>,
    pub error_message: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cost_in_usd: String,    // fixed scale 15
    pub cost_out_usd: String,   // fixed scale 15
    pub cost_total_usd: String, // fixed scale 15
    pub t_stream_ms: Option<i64>,
    pub t_first_byte_ms: Option<i64>,
    pub t_first_token_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub created_at_ms: i64,
}
