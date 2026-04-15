export interface StatsDailyRow {
  date: string;
  api_key_id: number;
  request_success: number;
  request_failed: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_in_usd: string;
  cost_out_usd: string;
  cost_total_usd: string;
  wait_time_ms: number;
  updated_at_ms: number;
}

export interface RequestLogRow {
  id: string;
  time_ms: number;
  api_key_id: number;
  provider_id: number | null;
  endpoint_id: number | null;
  upstream_key_id: number | null;
  api_format: string;
  model: string | null;
  http_status: number | null;
  error_type: string | null;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_in_usd: string;
  cost_out_usd: string;
  cost_total_usd: string;
  t_stream_ms: number | null;
  t_first_byte_ms: number | null;
  t_first_token_ms: number | null;
  duration_ms: number | null;
  created_at_ms: number;
}

export interface RequestLogSearchParams {
  page: number;
  page_size: number;
  model?: string;
  provider_id?: number;
  endpoint_id?: number;
  upstream_key_id?: number;
  api_key_id?: number;
  api_key_log_enabled?: boolean;
  api_format?: 'chat_completions' | 'responses';
  error_type?: string;
  status_class?: number;
  time_from_ms?: number;
  time_to_ms?: number;
  duration_ms_min?: number;
  duration_ms_max?: number;
  total_tokens_min?: number;
  total_tokens_max?: number;
  cost_total_min?: number;
  cost_total_max?: number;
  cache_read_input_tokens_min?: number;
  cache_read_input_tokens_max?: number;
  cache_creation_input_tokens_min?: number;
  cache_creation_input_tokens_max?: number;
}

export interface ApiKeySummary {
  id: number;
  name: string;
  enabled: boolean;
  expires_at_ms: number | null;
  log_enabled: boolean;
}

export interface CreateApiKeyInput {
  name: string;
  enabled: boolean;
  expires_at_ms: number | null;
  log_enabled: boolean;
}

export interface UpdateApiKeyInput {
  name?: string;
  enabled?: boolean;
  expires_at_ms?: number | null;
  log_enabled?: boolean;
}

export interface CreatedApiKey {
  id: number;
  api_key: string;
  name: string;
  enabled: boolean;
  expires_at_ms: number | null;
  log_enabled: boolean;
}

export interface ApiKeyWorkspace {
  apiKey: ApiKeySummary;
  totals: {
    requests: number;
    success: number;
    failed: number;
    tokens: number;
    cost: number;
    averageWaitMs: number;
    activeDays: number;
  };
  recentModels: string[];
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface RuntimeHealthSummary {
  state: CircuitState;
  available: boolean;
  consecutive_failures: number;
  success_count: number;
  failure_count: number;
  last_status: number | null;
  last_error_type: string | null;
  last_error_message: string | null;
  latency_ewma_ms: number | null;
  open_until_ms: number | null;
  last_success_at_ms: number | null;
  last_failure_at_ms: number | null;
  updated_at_ms: number | null;
}

export interface HealthCounts {
  total: number;
  disabled: number;
  closed: number;
  half_open: number;
  open: number;
  available: number;
}

export interface ProviderHealthSummary extends RuntimeHealthSummary {
  endpoint_counts: HealthCounts;
  key_counts: HealthCounts;
}

export interface ProviderSummary {
  id: number;
  name: string;
  provider_type: string;
  enabled: boolean;
  priority: number;
  weight: number;
  supports_include_usage: boolean;
  websocket_enabled: boolean;
  health?: ProviderHealthSummary;
}

export type EndpointHealthSummary = RuntimeHealthSummary;
export type UpstreamKeyHealthSummary = RuntimeHealthSummary;

export interface UpstreamEndpointSummary {
  id: number;
  provider_id: number;
  name: string;
  base_url: string;
  enabled: boolean;
  priority: number;
  weight: number;
  health?: EndpointHealthSummary;
}

export interface UpstreamKeyMeta {
  id: number;
  provider_id: number;
  name: string;
  enabled: boolean;
  priority: number;
  weight: number;
  health?: UpstreamKeyHealthSummary;
}

export interface UpstreamKeyModel {
  id: number;
  upstream_key_id: number;
  model_name: string;
  enabled: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ProviderModel {
  id: number;
  provider_id: number;
  upstream_model: string;
  alias: string | null;
  enabled: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface GatewayModelPolicy {
  model_name: string;
  enabled: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ProviderWorkspace {
  provider: ProviderSummary;
  endpoints: UpstreamEndpointSummary[];
  keys: UpstreamKeyMeta[];
}

export interface CreateProviderInput {
  name: string;
  provider_type: string;
  enabled: boolean;
  priority: number;
  weight: number;
  supports_include_usage: boolean;
  websocket_enabled: boolean;
}

export interface UpdateProviderInput {
  name?: string;
  provider_type?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  supports_include_usage?: boolean;
  websocket_enabled?: boolean;
}

export interface CreateEndpointInput {
  name: string;
  base_url: string;
  enabled: boolean;
  priority: number;
  weight: number;
}

export interface UpdateEndpointInput {
  name?: string;
  base_url?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
}

export interface CreateProviderKeyInput {
  name: string;
  secret: string;
  enabled: boolean;
  priority: number;
  weight: number;
}

export interface UpdateProviderKeyInput {
  name?: string;
  secret?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
}

export interface CodexOauthStartResponse {
  request_id: string;
  login_url: string;
  expires_at_ms: number;
}

export type CodexOauthStatusView =
  | { state: 'pending' }
  | { state: 'completed'; key_id: number }
  | { state: 'failed'; message: string };

export interface CodexOauthRequestView {
  request_id: string;
  provider_id: number;
  created_at_ms: number;
  expires_at_ms: number;
  login_url: string;
  status: CodexOauthStatusView;
}

export interface ModelRoute {
  id: number;
  model_name: string;
  enabled: boolean;
  provider_ids: number[];
}

export interface ModelPrice {
  id: number;
  provider_id: number | null;
  model_name: string;
  price_data: Record<string, string | number | boolean | null>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CreatePriceInput {
  provider_id: number | null;
  model_name: string;
  price_data: Record<string, string | number | boolean | null>;
}

export interface ConnectionSettings {
  apiBase: string;
  adminToken: string;
}

export interface SystemConfigResponse {
  connection: {
    api_base: string;
    healthz_path: string;
    readyz_path: string;
    metrics_path: string;
  };
  basic: {
    db_dsn: string;
    static_dir: string;
    max_request_bytes: number;
    max_response_bytes: number;
    log_queue_capacity: number;
    stats_flush_interval_ms: number;
  };
  routing: {
    endpoint_selector_strategy: string;
    inject_include_usage: boolean;
    upstream_cache_ttl_ms: number;
    upstream_cache_stale_grace_ms: number;
    api_key_cache_ttl_ms: number;
    api_key_cache_max_entries: number;
  };
  stability: {
    circuit_breaker_failure_threshold: number;
    circuit_breaker_open_ms: number;
    upstream_connect_timeout_ms: number;
    upstream_request_timeout_ms: number;
  };
  retention: {
    request_log_retention_days: number;
    stats_daily_retention_days: number;
    cleanup_interval_ms: number;
    delete_batch: number;
    archive_enabled: boolean;
    archive_dir: string;
    archive_compress: boolean;
  };
}

export interface HeatmapDay {
  date: string;
  label: string;
  value: number;
  level: 0 | 1 | 2 | 3 | 4;
  isFuture: boolean;
}

export type HeatmapMetric = 'requests' | 'tokens' | 'cost';

export interface DashboardSnapshot {
  hero: {
    providers: number;
    routes: number;
    prices: number;
    logEnabledKeys: number;
  };
  totals: {
    requests: number;
    success: number;
    failed: number;
    tokens: number;
    cost: number;
    averageWaitMs: number;
    activeDays: number;
    requestsToday: number;
  };
  trend: Array<{ label: string; value: number }>;
  heatmaps: Record<HeatmapMetric, HeatmapDay[]>;
  recentLogs: RequestLogRow[];
  topModels: Array<{ model: string; requests: number; cost: number }>;
}

export interface DashboardResponseBundle {
  statsDaily: StatsDailyRow[];
  requestLogs: RequestLogRow[];
  providers: ProviderSummary[];
  routes: ModelRoute[];
  prices: ModelPrice[];
  apiKeys: ApiKeySummary[];
}

export interface UsageBreakdownRow {
  key: string;
  requests: number;
  failed: number;
  tokens: number;
  cost_total_usd: string;
}

export interface UsageBreakdownResponse {
  by: 'model' | 'api_key';
  period: 'today' | '7d' | '30d';
  window: {
    from_ms: number;
    to_ms: number;
  };
  rows: UsageBreakdownRow[];
}

export interface StatsOverviewResponse {
  period: 'today' | '7d' | '30d';
  window: {
    from_ms: number;
    to_ms: number;
  };
  kpis: {
    requests: number;
    failed: number;
    error_rate: number;
    p95_latency_ms: number;
    cost_total_usd: string;
  };
  service_health: {
    providers_enabled: number;
    endpoints_enabled: number;
    upstream_keys_enabled: number;
    healthy: number;
    warning: number;
    error: number;
  };
  recent_anomalies: RequestLogRow[];
  top_models: UsageBreakdownRow[];
  top_keys: UsageBreakdownRow[];
}
