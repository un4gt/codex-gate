export interface StatsDailyRow {
  date: string;
  api_key_id: number;
  request_success: number;
  request_failed: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  usage_observed_requests: number;
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
  upstream_api_format: string | null;
  model: string | null;
  http_status: number | null;
  error_type: string | null;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  usage_observed: boolean;
  pricing: RequestPricing | null;
  t_stream_ms: number | null;
  t_first_byte_ms: number | null;
  t_first_token_ms: number | null;
  duration_ms: number | null;
  span_kind: 'request' | 'ws_session' | 'ws_session_close' | 'ws_turn' | string;
  transport: 'http' | 'ws' | 'ws_native' | 'ws_http_bridge' | 'ws_setup' | string;
  parent_id: string | null;
  ws_session_id: string | null;
  routing_trace: RoutingTrace | null;
  created_at_ms: number;
}

export interface RoutingTrace {
  authorized_groups: Array<{ id: number; name: string }>;
  affinity: {
    source: string;
    hash: string;
    hit: boolean;
    bound_provider_id: number | null;
    bound_upstream_key_id?: number | null;
    bound_endpoint_id?: number | null;
  } | null;
  candidates: Array<{
    provider_id: number;
    upstream_model?: string;
    priority: number;
    weight: number;
    attempt_budget: number;
    upstream_api_format?: string;
    conversion_mode?: string | null;
  }>;
  rejections?: Array<{
    provider_id: number | null;
    upstream_model: string;
    stage: string;
    code: string;
    message: string;
  }>;
  attempts: Array<{
    provider_id: number;
    endpoint_id: number;
    upstream_key_id: number;
    upstream_api_format?: string;
    conversion_mode?: string | null;
    status: number | null;
    error_type: string | null;
    duration_ms: number;
  }>;
  provider_switches: number;
  conversion?: {
    mode: 'responses_via_chat' | string;
    client_api_format: string;
    upstream_api_format: string;
    warnings: string[];
  } | null;
  terminal: { status: number | null; error_type: string | null; message?: string } | null;
}

export interface ProviderGroupRef {
  id: number;
  name: string;
}

export interface ProviderGroup {
  id: number;
  name: string;
  normalized_name: string;
  is_default: boolean;
  provider_count: number;
  api_key_count: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ProviderGroupMembership {
  group_id: number;
  group_name: string;
  priority_override: number | null;
}

export interface RequestLogSearchParams {
  page: number;
  page_size: number;
  query?: string;
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
  usage_observed?: boolean;
  reasoning_output_tokens_min?: number;
  reasoning_output_tokens_max?: number;
  cache_read_input_tokens_min?: number;
  cache_read_input_tokens_max?: number;
  cache_creation_input_tokens_min?: number;
  cache_creation_input_tokens_max?: number;
}

export type NotificationLocale = 'zh-CN' | 'en-US';
export type NotificationSmtpSecurity = 'starttls' | 'tls' | 'none';
export type NotificationChannelKind = 'smtp' | 'webhook';
export type NotificationWebhookFormat = 'generic' | 'feishu' | 'wecom' | 'dingtalk' | 'slack' | 'discord';
export type NotificationRuleKind = 'scheduled_report' | 'threshold_alert';
export type NotificationAlertMetric =
  | 'cpu_usage_percent'
  | 'memory_usage_percent'
  | 'unhealthy_provider_count'
  | 'request_count'
  | 'error_rate_percent'
  | 'total_tokens'
  | 'estimated_cost_usd';
export type NotificationAlertScope = 'global' | 'provider' | 'client_key';
export type NotificationAlertOperator = 'gt' | 'gte' | 'lt' | 'lte';

export interface NotificationWebhookHeader {
  name: string;
  value: string;
}

export interface NotificationSmtpPublicConfig {
  host: string;
  port: number;
  security: NotificationSmtpSecurity;
  username: string | null;
  has_password: boolean;
  from_name: string | null;
  from_email: string;
  recipients: string[];
}

export interface NotificationWebhookPublicConfig {
  url_masked: string;
  format: NotificationWebhookFormat;
  has_signing_secret: boolean;
  headers: Array<{ name: string; has_value: boolean }>;
}

interface NotificationChannelBase {
  id: number;
  name: string;
  enabled: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export type NotificationChannel = NotificationChannelBase & (
  | { kind: 'smtp'; config: NotificationSmtpPublicConfig }
  | { kind: 'webhook'; config: NotificationWebhookPublicConfig }
);

export type NotificationChannelInput = {
  name: string;
  enabled: boolean;
} & (
  | {
      kind: 'smtp';
      config: {
        host: string;
        port: number;
        security: NotificationSmtpSecurity;
        username?: string | null;
        password?: string | null;
        from_name?: string | null;
        from_email: string;
        recipients: string[];
      };
    }
  | {
      kind: 'webhook';
      config: {
        url: string;
        format: NotificationWebhookFormat;
        signing_secret?: string;
        headers: NotificationWebhookHeader[];
      };
    }
);

export interface NotificationChannelCreateResponse {
  channel: NotificationChannel;
  generated_signing_secret?: string;
}

export interface ScheduledNotificationConfig {
  cron: string;
  timezone: string;
  locale: NotificationLocale;
  top_n: number;
}

export interface ThresholdNotificationConfig {
  metric: NotificationAlertMetric;
  scope_kind: NotificationAlertScope;
  scope_id: number | null;
  operator: NotificationAlertOperator;
  threshold: number;
  window_minutes: number;
  minimum_requests: number;
  trigger_after: number;
  recover_after: number;
  cooldown_minutes: number;
  send_recovery: boolean;
  locale: NotificationLocale;
}

interface NotificationRuleBase {
  id: number;
  name: string;
  enabled: boolean;
  channel_ids: number[];
  next_run_at_ms: number;
  last_window_end_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  alert_state?: {
    state: 'normal' | 'pending' | 'firing' | string;
    breach_count: number;
    recovery_count: number;
    opened_at_ms: number | null;
    last_notified_at_ms: number | null;
  };
}

export type NotificationRule = NotificationRuleBase & (
  | { kind: 'scheduled_report'; config: ScheduledNotificationConfig }
  | { kind: 'threshold_alert'; config: ThresholdNotificationConfig }
);

export type NotificationRuleInput = {
  name: string;
  enabled: boolean;
  channel_ids: number[];
} & (
  | { kind: 'scheduled_report'; config: ScheduledNotificationConfig }
  | { kind: 'threshold_alert'; config: ThresholdNotificationConfig }
);

export interface NotificationSummary {
  enabled_channels: number;
  enabled_rules: number;
  firing_alerts: number;
  failed_deliveries_24h: number;
}

export interface NotificationDelivery {
  id: string;
  run_id: string;
  rule_id: number | null;
  rule_name: string;
  event_type: string;
  channel_id: number | null;
  channel_name: string;
  channel_kind: NotificationChannelKind;
  status: 'pending' | 'sending' | 'succeeded' | 'failed' | 'skipped' | string;
  attempts: number;
  next_attempt_at_ms: number | null;
  last_attempt_at_ms: number | null;
  delivered_at_ms: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at_ms: number;
  window_from_ms: number | null;
  window_to_ms: number | null;
}

export interface NotificationDeliveryList {
  items: NotificationDelivery[];
  offset: number;
  limit: number;
}

export interface NotificationDeliveryDetail extends NotificationDelivery {
  last_http_status: number | null;
  last_request_body: string | null;
  last_response_body: string | null;
  event_payload: unknown;
}

export interface NotificationSchedulePreview {
  cron: string;
  timezone: string;
  occurrences_ms: number[];
}

export interface ApiKeySummary {
  id: number;
  name: string;
  enabled: boolean;
  expires_at_ms: number | null;
  log_enabled: boolean;
  provider_groups: ProviderGroupRef[];
}

export interface CreateApiKeyInput {
  name: string;
  enabled: boolean;
  expires_at_ms: number | null;
  log_enabled: boolean;
  provider_group_ids: number[];
}

export interface UpdateApiKeyInput {
  name?: string;
  enabled?: boolean;
  expires_at_ms?: number | null;
  log_enabled?: boolean;
  provider_group_ids?: number[];
}

export interface CreatedApiKey {
  id: number;
  api_key: string;
  name: string;
  enabled: boolean;
  expires_at_ms: number | null;
  log_enabled: boolean;
  provider_groups?: ProviderGroupRef[];
}

export interface ApiKeyWorkspace {
  apiKey: ApiKeySummary;
  totals: {
    requests: number;
    success: number;
    failed: number;
    tokens: number;
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
  beta_features: string[];
  key_selection_strategy: 'round_robin' | 'weighted';
  groups: ProviderGroupMembership[];
  max_attempts: number;
  max_concurrency: number | null;
  circuit_breaker_enabled: boolean;
  circuit_breaker_failure_threshold: number;
  circuit_breaker_open_ms: number;
  circuit_breaker_half_open_success_threshold: number;
  runtime?: ProviderRuntimeSummary;
  affinity_sessions?: number;
  health?: ProviderHealthSummary;
}

export interface ProviderRuntimeSummary {
  state: CircuitState;
  available: boolean;
  in_flight: number;
  max_concurrency: number | null;
  consecutive_failures: number;
  success_count: number;
  failure_count: number;
  half_open_successes: number;
  latency_ewma_ms: number | null;
  open_until_ms: number | null;
  last_status: number | null;
  last_error_type: string | null;
  last_error_message: string | null;
  last_success_at_ms: number | null;
  last_failure_at_ms: number | null;
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
  auth_kind?: 'api_key' | 'codex_oauth';
  codex_oauth?: CodexOAuthAccount | null;
  health?: UpstreamKeyHealthSummary;
  quota?: {
    remaining_requests: number | null;
    remaining_tokens: number | null;
    reset_at_ms: number | null;
    cooldown_until_ms: number | null;
    consecutive_rate_limits: number;
    updated_at_ms: number | null;
  };
}

export interface CodexQuotaWindow {
  used_percent: number;
  remaining_percent: number;
  window_seconds: number | null;
  reset_at_ms: number | null;
}

export interface CodexQuotaCredits {
  has_credits: boolean;
  unlimited: boolean;
  balance: number | null;
  reset_credits: number | null;
  subscription_end_at_ms: number | null;
}

export interface CodexQuotaSnapshot {
  plan_type: string | null;
  allowed: boolean | null;
  primary_window: CodexQuotaWindow | null;
  secondary_window: CodexQuotaWindow | null;
  code_review_window: CodexQuotaWindow | null;
  credits: CodexQuotaCredits;
}

export interface CodexOAuthAccount {
  upstream_key_id: number;
  provider_id: number;
  email_masked: string | null;
  account_id_suffix: string | null;
  plan_type: string | null;
  token_expires_at_ms: number | null;
  last_refresh_at_ms: number | null;
  auth_status: 'active' | 'reauth_required' | 'forbidden' | string;
  last_error: string | null;
  quota: CodexQuotaSnapshot | null;
  quota_checked_at_ms: number | null;
}

export interface CodexOAuthSession {
  session_id: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'expired';
  verification_uri: string;
  user_code?: string;
  expires_at_ms: number;
  poll_interval_ms: number;
  key_id?: number;
  operation?: 'created' | 'updated';
  warnings?: string[];
  error_code?: string;
  error_message?: string;
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
  available: boolean;
  responses_via_chat_enabled: boolean;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ProviderModelInventory extends ProviderModel {
  provider_name: string;
  provider_type: string;
  native_api_formats: Array<'chat_completions' | 'responses'>;
}

export interface ConsolePreferences {
  log_visible_columns: string[];
  log_column_widths: Record<string, number>;
  model_column_widths: Record<string, number>;
}

export interface ConsolePreferencesPatch {
  log_visible_columns?: string[];
  log_column_widths?: Record<string, number>;
  model_column_widths?: Record<string, number>;
}

export interface ModelAliasTarget {
  id: number;
  alias_id: number;
  provider_id: number;
  upstream_model: string;
  enabled: boolean;
  priority: number;
  weight: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ModelAlias {
  id: number;
  name: string;
  enabled: boolean;
  mode: 'ordered' | 'weighted';
  created_at_ms: number;
  updated_at_ms: number;
  targets: ModelAliasTarget[];
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
  beta_features: string[];
  key_selection_strategy: 'round_robin' | 'weighted';
  groups?: Array<{ group_id: number; priority_override: number | null }>;
  max_attempts: number;
  max_concurrency: number | null;
  circuit_breaker_enabled: boolean;
  circuit_breaker_failure_threshold: number;
  circuit_breaker_open_ms: number;
  circuit_breaker_half_open_success_threshold: number;
}

export interface UpdateProviderInput {
  name?: string;
  provider_type?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  supports_include_usage?: boolean;
  websocket_enabled?: boolean;
  beta_features?: string[];
  key_selection_strategy?: 'round_robin' | 'weighted';
  groups?: Array<{ group_id: number; priority_override: number | null }>;
  max_attempts?: number;
  max_concurrency?: number | null;
  circuit_breaker_enabled?: boolean;
  circuit_breaker_failure_threshold?: number;
  circuit_breaker_open_ms?: number;
  circuit_breaker_half_open_success_threshold?: number;
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

export interface ModelRoute {
  id: number;
  model_name: string;
  enabled: boolean;
  provider_ids: number[];
}

export interface PriceRates {
  input: string | null;
  output: string | null;
  cache_read: string | null;
  cache_write: string | null;
}

export interface ContextPriceTier {
  over_total_input_tokens: number;
  rates: PriceRates;
}

export interface PriceCardV2 {
  schema_version: 2;
  unit: 'usd_per_million_tokens';
  base: PriceRates;
  tiers: ContextPriceTier[];
}

export interface RequestPricing {
  price_version_id: number;
  tier_index: number | null;
  card: PriceCardV2 | null;
}

export interface ModelPrice {
  id: number;
  provider_id: number | null;
  model_name: string;
  price_data: PriceCardV2;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CreatePriceInput {
  provider_id: number | null;
  model_name: string;
  price_data: PriceCardV2;
}

export interface ConnectionSettings {
  apiBase: string;
  adminToken: string;
}

export interface RuntimeSettingView {
  key: string;
  group: string;
  label: string;
  value: string | number | boolean | null;
  default_value: string | number | boolean | null;
  editable: boolean;
  requires_restart: boolean;
  updated_at_ms: number | null;
}

export interface RuntimeSettingsResponse {
  settings: RuntimeSettingView[];
  updated_at_ms: number;
}

export interface RuntimeEnvPreviewResponse {
  profile: string;
  hot_settings: Array<{
    key: string;
    label: string;
    value: string | number | boolean | null;
  }>;
  restart_settings: Array<{
    key: string;
    label: string;
    current: string | number | boolean | null;
    recommended: string | number | boolean | null;
  }>;
}

export interface SystemConfigResponse {
  build?: {
    version: string;
    commit: string;
  };
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
    usage_capture_bytes: number;
    usage_capture_tail_bytes: number;
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

export type StatsPeriod = 'today' | '7h' | '24h' | 'week' | 'month' | '7d' | '30d';

export interface StatsOverviewResponse {
  period: StatsPeriod;
  window: {
    from_ms: number;
    to_ms: number;
  };
  kpis: {
    requests: number;
    failed: number;
    error_rate: number;
    p95_latency_ms: number;
    avg_latency_ms: number;
  };
  service_health: {
    providers_enabled: number;
    endpoints_enabled: number;
    upstream_keys_enabled: number;
    healthy: number;
    warning: number;
    error: number;
  };
  server_status?: {
    scope: 'container' | 'cgroup' | 'host' | string;
    cpu_usage_percent: number | null;
    cpu_capacity_cores: number;
    cpu_sample_ms: number | null;
    memory_used_bytes: number | null;
    memory_total_bytes: number | null;
    memory_usage_percent: number | null;
    memory_limited: boolean;
  };
  token_usage: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    visible_output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_output_tokens: number;
    usage_observed_requests: number;
  };
  pricing: {
    versions: Array<{
      id: number;
      card: PriceCardV2;
    }>;
    usage_groups: Array<{
      price_version_id: number | null;
      tier_index: number | null;
      request_count: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    }>;
  };
}
