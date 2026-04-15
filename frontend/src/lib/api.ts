import { parseDecimal } from './format';
import type {
  ApiKeySummary,
  ApiKeyWorkspace,
  ConnectionSettings,
  CodexOauthRequestView,
  CodexOauthStartResponse,
  CreateApiKeyInput,
  CreateEndpointInput,
  CreatePriceInput,
  CreateProviderInput,
  CreateProviderKeyInput,
  CreatedApiKey,
  DashboardResponseBundle,
  GatewayModelPolicy,
  ModelPrice,
  ModelRoute,
  ProviderModel,
  ProviderSummary,
  ProviderWorkspace,
  RequestLogRow,
  RequestLogSearchParams,
  StatsOverviewResponse,
  StatsDailyRow,
  UsageBreakdownResponse,
  SystemConfigResponse,
  UpdateApiKeyInput,
  UpdateEndpointInput,
  UpdateProviderInput,
  UpdateProviderKeyInput,
  UpstreamEndpointSummary,
  UpstreamKeyMeta,
  UpstreamKeyModel,
} from './types';

function normalizeBase(apiBase: string): string {
  return apiBase.trim().replace(/\/$/, '');
}

function requireConnection(settings: ConnectionSettings) {
  const apiBase = normalizeBase(settings.apiBase);
  const adminToken = settings.adminToken.trim();

  if (!apiBase) {
    throw new Error('服务地址不能为空');
  }
  if (!adminToken) {
    throw new Error('管理员口令不能为空');
  }

  return { apiBase, adminToken };
}

async function requestJson<T>(apiBase: string, path: string, adminToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${normalizeBase(apiBase)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${path} 请求失败：${response.status} ${body || response.statusText}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function fetchJson<T>(apiBase: string, path: string, adminToken: string): Promise<T> {
  return requestJson<T>(apiBase, path, adminToken);
}

async function postJson<T>(apiBase: string, path: string, adminToken: string, body: unknown): Promise<T> {
  return requestJson<T>(apiBase, path, adminToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function patchJson<T>(apiBase: string, path: string, adminToken: string, body: unknown): Promise<T> {
  return requestJson<T>(apiBase, path, adminToken, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

async function deleteJson<T>(apiBase: string, path: string, adminToken: string): Promise<T> {
  return requestJson<T>(apiBase, path, adminToken, {
    method: 'DELETE',
  });
}

export async function loadPrices(settings: ConnectionSettings): Promise<ModelPrice[]> {
  const { apiBase, adminToken } = requireConnection(settings);
  return fetchJson<ModelPrice[]>(apiBase, '/api/v1/prices', adminToken);
}

export async function loadSystemConfig(settings: ConnectionSettings): Promise<SystemConfigResponse> {
  const { apiBase, adminToken } = requireConnection(settings);
  return fetchJson<SystemConfigResponse>(apiBase, '/api/v1/system/config', adminToken);
}

export async function loadDashboardData(settings: ConnectionSettings): Promise<DashboardResponseBundle> {
  const { apiBase, adminToken } = requireConnection(settings);

  const [statsDaily, requestLogs, providers, routes, prices, apiKeys] = await Promise.all([
    fetchJson<StatsDailyRow[]>(apiBase, '/api/v1/stats/daily?days=378', adminToken),
    fetchJson<RequestLogRow[]>(apiBase, '/api/v1/logs?page=1&page_size=100', adminToken),
    fetchJson<ProviderSummary[]>(apiBase, '/api/v1/providers', adminToken),
    fetchJson<ModelRoute[]>(apiBase, '/api/v1/routes', adminToken),
    fetchJson<ModelPrice[]>(apiBase, '/api/v1/prices', adminToken),
    fetchJson<ApiKeySummary[]>(apiBase, '/api/v1/api-keys', adminToken),
  ]);

  return {
    statsDaily,
    requestLogs,
    providers,
    routes,
    prices,
    apiKeys,
  };
}

export async function loadRequestLogs(settings: ConnectionSettings, params: RequestLogSearchParams): Promise<RequestLogRow[]> {
  const { apiBase, adminToken } = requireConnection(settings);
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('page_size', String(params.page_size));
  if (params.model?.trim()) {
    search.set('model', params.model.trim());
  }
  if (typeof params.provider_id === 'number') {
    search.set('provider_id', String(params.provider_id));
  }
  if (typeof params.endpoint_id === 'number') {
    search.set('endpoint_id', String(params.endpoint_id));
  }
  if (typeof params.upstream_key_id === 'number') {
    search.set('upstream_key_id', String(params.upstream_key_id));
  }
  if (typeof params.api_key_id === 'number') {
    search.set('api_key_id', String(params.api_key_id));
  }
  if (typeof params.api_key_log_enabled === 'boolean') {
    search.set('api_key_log_enabled', String(params.api_key_log_enabled));
  }
  if (params.api_format) {
    search.set('api_format', params.api_format);
  }
  if (params.error_type?.trim()) {
    search.set('error_type', params.error_type.trim());
  }
  if (typeof params.status_class === 'number') {
    search.set('status_class', String(params.status_class));
  }
  if (typeof params.time_from_ms === 'number') {
    search.set('time_from_ms', String(params.time_from_ms));
  }
  if (typeof params.time_to_ms === 'number') {
    search.set('time_to_ms', String(params.time_to_ms));
  }
  if (typeof params.duration_ms_min === 'number') {
    search.set('duration_ms_min', String(params.duration_ms_min));
  }
  if (typeof params.duration_ms_max === 'number') {
    search.set('duration_ms_max', String(params.duration_ms_max));
  }
  if (typeof params.total_tokens_min === 'number') {
    search.set('total_tokens_min', String(params.total_tokens_min));
  }
  if (typeof params.total_tokens_max === 'number') {
    search.set('total_tokens_max', String(params.total_tokens_max));
  }
  if (typeof params.cost_total_min === 'number') {
    search.set('cost_total_min', String(params.cost_total_min));
  }
  if (typeof params.cost_total_max === 'number') {
    search.set('cost_total_max', String(params.cost_total_max));
  }
  if (typeof params.cache_read_input_tokens_min === 'number') {
    search.set('cache_read_input_tokens_min', String(params.cache_read_input_tokens_min));
  }
  if (typeof params.cache_read_input_tokens_max === 'number') {
    search.set('cache_read_input_tokens_max', String(params.cache_read_input_tokens_max));
  }
  if (typeof params.cache_creation_input_tokens_min === 'number') {
    search.set('cache_creation_input_tokens_min', String(params.cache_creation_input_tokens_min));
  }
  if (typeof params.cache_creation_input_tokens_max === 'number') {
    search.set('cache_creation_input_tokens_max', String(params.cache_creation_input_tokens_max));
  }
  return fetchJson<RequestLogRow[]>(apiBase, `/api/v1/logs?${search.toString()}`, adminToken);
}

export async function loadStatsOverview(
  settings: ConnectionSettings,
  period: 'today' | '7d' | '30d' = 'today',
): Promise<StatsOverviewResponse> {
  const { apiBase, adminToken } = requireConnection(settings);
  return fetchJson<StatsOverviewResponse>(apiBase, `/api/v1/stats/overview?period=${encodeURIComponent(period)}`, adminToken);
}

export async function loadUsageBreakdown(
  settings: ConnectionSettings,
  params: { by?: 'model' | 'api_key'; period?: 'today' | '7d' | '30d'; limit?: number } = {},
): Promise<UsageBreakdownResponse> {
  const { apiBase, adminToken } = requireConnection(settings);
  const search = new URLSearchParams();
  if (params.by) search.set('by', params.by);
  if (params.period) search.set('period', params.period);
  if (typeof params.limit === 'number') search.set('limit', String(params.limit));
  const suffix = search.toString();
  return fetchJson<UsageBreakdownResponse>(apiBase, `/api/v1/stats/usage-breakdown${suffix ? `?${suffix}` : ''}`, adminToken);
}

export async function loadProviderWorkspace(settings: ConnectionSettings): Promise<ProviderWorkspace[]> {
  const { apiBase, adminToken } = requireConnection(settings);
  const providers = await fetchJson<ProviderSummary[]>(apiBase, '/api/v1/providers', adminToken);

  return Promise.all(
    providers.map(async (provider) => {
      const [endpoints, keys] = await Promise.all([
        fetchJson<UpstreamEndpointSummary[]>(apiBase, `/api/v1/providers/${provider.id}/endpoints`, adminToken),
        fetchJson<UpstreamKeyMeta[]>(apiBase, `/api/v1/providers/${provider.id}/keys`, adminToken),
      ]);

      return {
        provider,
        endpoints,
        keys,
      };
    }),
  );
}

export async function loadApiKeyWorkspace(settings: ConnectionSettings): Promise<ApiKeyWorkspace[]> {
  const { apiBase, adminToken } = requireConnection(settings);
  const [apiKeys, requestLogs] = await Promise.all([
    fetchJson<ApiKeySummary[]>(apiBase, '/api/v1/api-keys', adminToken),
    fetchJson<RequestLogRow[]>(apiBase, '/api/v1/logs?page=1&page_size=200', adminToken),
  ]);

  return Promise.all(
    apiKeys.map(async (apiKey) => {
      const statsDaily = await fetchJson<StatsDailyRow[]>(apiBase, `/api/v1/stats/daily?api_key_id=${apiKey.id}&days=90`, adminToken);
      const recentModels = Array.from(
        new Set(
          requestLogs
            .filter((row) => row.api_key_id === apiKey.id && row.model)
            .map((row) => row.model as string),
        ),
      ).slice(0, 4);

      const totals = statsDaily.reduce(
        (acc, row) => {
          acc.requests += row.request_success + row.request_failed;
          acc.success += row.request_success;
          acc.failed += row.request_failed;
          acc.tokens += row.input_tokens + row.output_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens;
          acc.cost += parseDecimal(row.cost_total_usd);
          acc.waitTime += row.wait_time_ms;
          acc.activeDays += row.request_success + row.request_failed > 0 ? 1 : 0;
          return acc;
        },
        { requests: 0, success: 0, failed: 0, tokens: 0, cost: 0, waitTime: 0, activeDays: 0 },
      );

      return {
        apiKey,
        totals: {
          requests: totals.requests,
          success: totals.success,
          failed: totals.failed,
          tokens: totals.tokens,
          cost: totals.cost,
          averageWaitMs: Math.round(totals.waitTime / Math.max(totals.requests, 1)),
          activeDays: totals.activeDays,
        },
        recentModels,
      };
    }),
  );
}

export async function createProvider(settings: ConnectionSettings, payload: CreateProviderInput) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<{ id: number }>(apiBase, '/api/v1/providers', adminToken, payload);
}

export async function updateProvider(settings: ConnectionSettings, providerId: number, payload: UpdateProviderInput) {
  const { apiBase, adminToken } = requireConnection(settings);
  return patchJson<{ ok: boolean }>(apiBase, `/api/v1/providers/${providerId}`, adminToken, payload);
}

export async function createEndpoint(settings: ConnectionSettings, providerId: number, payload: CreateEndpointInput) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<{ id: number }>(apiBase, `/api/v1/providers/${providerId}/endpoints`, adminToken, payload);
}

export async function updateEndpoint(settings: ConnectionSettings, endpointId: number, payload: UpdateEndpointInput) {
  const { apiBase, adminToken } = requireConnection(settings);
  return patchJson<{ ok: boolean }>(apiBase, `/api/v1/endpoints/${endpointId}`, adminToken, payload);
}

export async function createProviderKey(settings: ConnectionSettings, providerId: number, payload: CreateProviderKeyInput) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<{ id: number }>(apiBase, `/api/v1/providers/${providerId}/keys`, adminToken, payload);
}

export async function updateProviderKey(settings: ConnectionSettings, keyId: number, payload: UpdateProviderKeyInput) {
  const { apiBase, adminToken } = requireConnection(settings);
  return patchJson<{ ok: boolean }>(apiBase, `/api/v1/keys/${keyId}`, adminToken, payload);
}

export async function createPrice(settings: ConnectionSettings, payload: CreatePriceInput) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<{ id: number }>(apiBase, '/api/v1/prices', adminToken, payload);
}

export async function createApiKey(settings: ConnectionSettings, payload: CreateApiKeyInput) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<CreatedApiKey>(apiBase, '/api/v1/api-keys', adminToken, payload);
}

export async function updateApiKey(settings: ConnectionSettings, apiKeyId: number, payload: UpdateApiKeyInput) {
  const { apiBase, adminToken } = requireConnection(settings);
  return patchJson<{ ok: boolean }>(apiBase, `/api/v1/api-keys/${apiKeyId}`, adminToken, payload);
}

export async function deleteApiKey(settings: ConnectionSettings, apiKeyId: number) {
  const { apiBase, adminToken } = requireConnection(settings);
  return deleteJson<void>(apiBase, `/api/v1/api-keys/${apiKeyId}`, adminToken);
}

export async function testEndpointConnection(settings: ConnectionSettings, endpointId: number) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<{ ok: boolean; status: number | null; url: string; message: string | null }>(
    apiBase,
    `/api/v1/endpoints/${endpointId}/test`,
    adminToken,
    {},
  );
}

export async function startCodexOauth(settings: ConnectionSettings, providerId: number) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<CodexOauthStartResponse>(apiBase, `/api/v1/providers/${providerId}/codex-oauth/start`, adminToken, {});
}

export async function getCodexOauthRequest(settings: ConnectionSettings, requestId: string) {
  const { apiBase, adminToken } = requireConnection(settings);
  const encoded = encodeURIComponent(requestId.trim());
  return fetchJson<CodexOauthRequestView>(apiBase, `/api/v1/codex-oauth/${encoded}`, adminToken);
}

export async function loadUpstreamKeyModels(settings: ConnectionSettings, upstreamKeyId: number) {
  const { apiBase, adminToken } = requireConnection(settings);
  return fetchJson<UpstreamKeyModel[]>(apiBase, `/api/v1/keys/${upstreamKeyId}/models`, adminToken);
}

export async function syncUpstreamKeyModels(settings: ConnectionSettings, upstreamKeyId: number) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<UpstreamKeyModel[]>(apiBase, `/api/v1/keys/${upstreamKeyId}/models/sync`, adminToken, {});
}

export async function addUpstreamKeyModels(settings: ConnectionSettings, upstreamKeyId: number, models: string[]) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<UpstreamKeyModel[]>(apiBase, `/api/v1/keys/${upstreamKeyId}/models`, adminToken, { models });
}

export async function updateUpstreamKeyModel(settings: ConnectionSettings, modelId: number, payload: { enabled: boolean }) {
  const { apiBase, adminToken } = requireConnection(settings);
  return patchJson<{ ok: boolean }>(apiBase, `/api/v1/key-models/${modelId}`, adminToken, payload);
}

export async function deleteUpstreamKeyModel(settings: ConnectionSettings, modelId: number) {
  const { apiBase, adminToken } = requireConnection(settings);
  return deleteJson<void>(apiBase, `/api/v1/key-models/${modelId}`, adminToken);
}

export async function loadProviderModels(settings: ConnectionSettings, providerId: number) {
  const { apiBase, adminToken } = requireConnection(settings);
  return fetchJson<ProviderModel[]>(apiBase, `/api/v1/providers/${providerId}/models`, adminToken);
}

export async function syncProviderModels(settings: ConnectionSettings, providerId: number) {
  const { apiBase, adminToken } = requireConnection(settings);
  return postJson<ProviderModel[]>(apiBase, `/api/v1/providers/${providerId}/models/sync`, adminToken, {});
}

export async function updateProviderModel(
  settings: ConnectionSettings,
  modelId: number,
  payload: { alias?: string | null; enabled?: boolean },
) {
  const { apiBase, adminToken } = requireConnection(settings);
  return patchJson<{ ok: boolean }>(apiBase, `/api/v1/provider-models/${modelId}`, adminToken, payload);
}

export async function deleteProviderModel(settings: ConnectionSettings, modelId: number) {
  const { apiBase, adminToken } = requireConnection(settings);
  return deleteJson<void>(apiBase, `/api/v1/provider-models/${modelId}`, adminToken);
}

export async function loadGatewayModelPolicies(settings: ConnectionSettings) {
  const { apiBase, adminToken } = requireConnection(settings);
  return fetchJson<GatewayModelPolicy[]>(apiBase, '/api/v1/gateway-models', adminToken);
}

export async function updateGatewayModelPolicy(
  settings: ConnectionSettings,
  payload: { model_name: string; enabled: boolean },
) {
  const { apiBase, adminToken } = requireConnection(settings);
  return patchJson<{ ok: boolean }>(apiBase, '/api/v1/gateway-models', adminToken, payload);
}
