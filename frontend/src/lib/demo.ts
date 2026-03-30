import type {
  ApiKeyWorkspace,
  DashboardSnapshot,
  HeatmapDay,
  ModelPrice,
  ProviderWorkspace,
  RequestLogRow,
  StatsDailyRow,
} from './types';
import { formatDate, formatDateKey } from './format';

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function createDemoStats(): StatsDailyRow[] {
  const today = new Date();
  const rows: StatsDailyRow[] = [];

  for (let index = 0; index < 180; index += 1) {
    const current = addDays(today, -179 + index);
    const weekday = current.getUTCDay();
    const wave = Math.sin(index / 8) * 120;
    const secondary = Math.cos(index / 13) * 40;
    const requests = Math.max(0, Math.round(160 + wave + secondary + (weekday === 0 || weekday === 6 ? -60 : 25)));
    const success = Math.max(0, requests - Math.round(requests * 0.06));
    const failed = requests - success;
    const input = requests * (50 + (index % 7) * 6);
    const output = requests * (32 + (index % 5) * 4);
    rows.push({
      date: formatDateKey(current),
      api_key_id: 0,
      request_success: success,
      request_failed: failed,
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: Math.round(input * 0.18),
      cache_creation_input_tokens: Math.round(input * 0.07),
      cost_in_usd: (input * 0.0000012).toFixed(6),
      cost_out_usd: (output * 0.000002).toFixed(6),
      cost_total_usd: (input * 0.0000012 + output * 0.000002).toFixed(6),
      wait_time_ms: requests * (230 + (index % 11) * 12),
      updated_at_ms: current.getTime(),
    });
  }

  return rows;
}

export function createDemoLogs(): RequestLogRow[] {
  const now = Date.now();
  const models = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-nano'];
  const statusCodes = [200, 200, 200, 429, 500, 200, 400];
  return Array.from({ length: 36 }, (_, index) => {
    const httpStatus = statusCodes[index % statusCodes.length];
    const providerId = (index % 3) + 1;
    return {
      id: `demo-${index}`,
      time_ms: now - index * 17 * 60 * 1000,
      api_key_id: (index % 3) + 1,
      provider_id: providerId,
      endpoint_id: providerId * 10 + 1,
      upstream_key_id: providerId * 100 + 1,
      api_format: index % 4 === 0 ? 'responses' : 'chat_completions',
      model: models[index % models.length],
      http_status: httpStatus,
      error_type: httpStatus >= 400 ? 'upstream_error' : null,
      error_message: httpStatus >= 400 ? `mock error ${httpStatus}` : null,
      input_tokens: 850 + index * 120,
      output_tokens: 620 + index * 80,
      cache_read_input_tokens: 120 + index * 15,
      cache_creation_input_tokens: 40 + index * 12,
      cost_in_usd: (0.19 + index * 0.03).toFixed(4),
      cost_out_usd: (0.26 + index * 0.04).toFixed(4),
      cost_total_usd: (0.45 + index * 0.07).toFixed(4),
      t_stream_ms: 38 + index * 4,
      t_first_byte_ms: 61 + index * 5,
      t_first_token_ms: 135 + index * 6,
      duration_ms: 690 + index * 38,
      created_at_ms: now - index * 17 * 60 * 1000,
    };
  });
}

function clampLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  const ratio = value / Math.max(max, 1);
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

function createHeatmap(valuesByDate: Map<string, number>): HeatmapDay[] {
  const values = Array.from(valuesByDate.values());
  const max = Math.max(...values, 1);
  const today = new Date();
  const start = addDays(today, -377 + 1 - today.getUTCDay());

  return Array.from({ length: 54 * 7 }, (_, index) => {
    const current = addDays(start, index);
    const key = formatDateKey(current);
    const value = valuesByDate.get(key) ?? 0;
    const isFuture = current.getTime() > today.getTime();
    return {
      date: key,
      label: formatDate(current),
      value,
      level: isFuture ? 0 : clampLevel(value, max),
      isFuture,
    };
  });
}

export function createDemoProviders(): ProviderWorkspace[] {
  return [
    {
      provider: {
        id: 1,
        name: 'openai-prod',
        provider_type: 'openai',
        enabled: true,
        priority: 100,
        weight: 6,
        supports_include_usage: true,
        health: {
          state: 'closed',
          available: true,
          consecutive_failures: 0,
          success_count: 2368,
          failure_count: 22,
          last_status: 200,
          last_error_type: null,
          last_error_message: null,
          latency_ewma_ms: 86,
          open_until_ms: null,
          last_success_at_ms: Date.now() - 30_000,
          last_failure_at_ms: Date.now() - 5_000,
          updated_at_ms: Date.now() - 30_000,
          endpoint_counts: { total: 2, disabled: 0, closed: 1, half_open: 0, open: 1, available: 1 },
          key_counts: { total: 2, disabled: 0, closed: 2, half_open: 0, open: 0, available: 2 },
        },
      },
      endpoints: [
        {
          id: 11,
          provider_id: 1,
          name: 'us-east-primary',
          base_url: 'https://api.openai.com',
          enabled: true,
          priority: 100,
          weight: 8,
          health: {
            state: 'closed',
            available: true,
            consecutive_failures: 0,
            success_count: 1820,
            failure_count: 4,
            last_status: 200,
            last_error_type: null,
            last_error_message: null,
            latency_ewma_ms: 86,
            open_until_ms: null,
            last_success_at_ms: Date.now() - 30_000,
            last_failure_at_ms: Date.now() - 4 * 60 * 60 * 1000,
            updated_at_ms: Date.now() - 30_000,
          },
        },
        {
          id: 12,
          provider_id: 1,
          name: 'us-west-fallback',
          base_url: 'https://gateway.example.com/openai',
          enabled: true,
          priority: 120,
          weight: 3,
          health: {
            state: 'open',
            available: false,
            consecutive_failures: 3,
            success_count: 214,
            failure_count: 18,
            last_status: 429,
            last_error_type: 'upstream_request_error',
            last_error_message: 'simulated rate limit burst',
            latency_ewma_ms: 242,
            open_until_ms: Date.now() + 18_000,
            last_success_at_ms: Date.now() - 12 * 60 * 1000,
            last_failure_at_ms: Date.now() - 5_000,
            updated_at_ms: Date.now() - 5_000,
          },
        },
      ],
      keys: [
        {
          id: 101,
          provider_id: 1,
          name: 'prod-key-a',
          enabled: true,
          priority: 100,
          weight: 5,
          health: {
            state: 'closed',
            available: true,
            consecutive_failures: 0,
            success_count: 1184,
            failure_count: 3,
            last_status: 200,
            last_error_type: null,
            last_error_message: null,
            latency_ewma_ms: 83,
            open_until_ms: null,
            last_success_at_ms: Date.now() - 20_000,
            last_failure_at_ms: Date.now() - 10 * 60 * 1000,
            updated_at_ms: Date.now() - 20_000,
          },
        },
        {
          id: 102,
          provider_id: 1,
          name: 'prod-key-b',
          enabled: true,
          priority: 110,
          weight: 2,
          health: {
            state: 'closed',
            available: true,
            consecutive_failures: 0,
            success_count: 906,
            failure_count: 1,
            last_status: 200,
            last_error_type: null,
            last_error_message: null,
            latency_ewma_ms: 94,
            open_until_ms: null,
            last_success_at_ms: Date.now() - 90_000,
            last_failure_at_ms: Date.now() - 14 * 60 * 1000,
            updated_at_ms: Date.now() - 90_000,
          },
        },
      ],
    },
    {
      provider: {
        id: 2,
        name: 'openai-shadow',
        provider_type: 'openai',
        enabled: true,
        priority: 180,
        weight: 2,
        supports_include_usage: true,
        health: {
          state: 'half_open',
          available: true,
          consecutive_failures: 3,
          success_count: 192,
          failure_count: 12,
          last_status: 502,
          last_error_type: 'upstream_request_error',
          last_error_message: 'tcp connect timeout',
          latency_ewma_ms: 188,
          open_until_ms: null,
          last_success_at_ms: Date.now() - 26 * 60 * 1000,
          last_failure_at_ms: Date.now() - 45_000,
          updated_at_ms: Date.now() - 45_000,
          endpoint_counts: { total: 1, disabled: 0, closed: 0, half_open: 1, open: 0, available: 1 },
          key_counts: { total: 1, disabled: 0, closed: 1, half_open: 0, open: 0, available: 1 },
        },
      },
      endpoints: [
        {
          id: 21,
          provider_id: 2,
          name: 'shadow-endpoint',
          base_url: 'https://shadow.example.com/v1',
          enabled: true,
          priority: 150,
          weight: 1,
          health: {
            state: 'half_open',
            available: true,
            consecutive_failures: 3,
            success_count: 96,
            failure_count: 11,
            last_status: 502,
            last_error_type: 'upstream_request_error',
            last_error_message: 'tcp connect timeout',
            latency_ewma_ms: 188,
            open_until_ms: null,
            last_success_at_ms: Date.now() - 26 * 60 * 1000,
            last_failure_at_ms: Date.now() - 45_000,
            updated_at_ms: Date.now() - 45_000,
          },
        },
      ],
      keys: [{
        id: 201,
        provider_id: 2,
        name: 'shadow-key',
        enabled: true,
        priority: 150,
        weight: 1,
        health: {
          state: 'closed',
          available: true,
          consecutive_failures: 0,
          success_count: 96,
          failure_count: 0,
          last_status: 200,
          last_error_type: null,
          last_error_message: null,
          latency_ewma_ms: 181,
          open_until_ms: null,
          last_success_at_ms: Date.now() - 26 * 60 * 1000,
          last_failure_at_ms: null,
          updated_at_ms: Date.now() - 26 * 60 * 1000,
        },
      }],
    },
    {
      provider: {
        id: 3,
        name: 'legacy-route',
        provider_type: 'openai',
        enabled: false,
        priority: 260,
        weight: 1,
        supports_include_usage: false,
        health: {
          state: 'open',
          available: false,
          consecutive_failures: 0,
          success_count: 0,
          failure_count: 0,
          last_status: null,
          last_error_type: null,
          last_error_message: null,
          latency_ewma_ms: null,
          open_until_ms: null,
          last_success_at_ms: null,
          last_failure_at_ms: null,
          updated_at_ms: null,
          endpoint_counts: { total: 1, disabled: 1, closed: 0, half_open: 0, open: 0, available: 0 },
          key_counts: { total: 1, disabled: 1, closed: 0, half_open: 0, open: 0, available: 0 },
        },
      },
      endpoints: [
        {
          id: 31,
          provider_id: 3,
          name: 'legacy-edge',
          base_url: 'https://legacy.example.com/v1',
          enabled: false,
          priority: 220,
          weight: 1,
        },
      ],
      keys: [{ id: 301, provider_id: 3, name: 'legacy-key', enabled: false, priority: 220, weight: 1, health: { state: 'open', available: false, consecutive_failures: 0, success_count: 0, failure_count: 0, last_status: null, last_error_type: null, last_error_message: null, latency_ewma_ms: null, open_until_ms: null, last_success_at_ms: null, last_failure_at_ms: null, updated_at_ms: null } }],
    },
  ];
}

export function createDemoPrices(): ModelPrice[] {
  return [
    {
      id: 1,
      provider_id: 1,
      model_name: 'gpt-4.1',
      price_data: {
        input_cost_per_token: 0.0000012,
        output_cost_per_token: 0.0000048,
        cache_read_input_token_cost: 0.0000002,
        cache_creation_input_token_cost: 0.0000009,
      },
      created_at_ms: Date.now() - 12 * 60 * 60 * 1000,
      updated_at_ms: Date.now() - 12 * 60 * 60 * 1000,
    },
    {
      id: 2,
      provider_id: 1,
      model_name: 'gpt-4.1-mini',
      price_data: {
        input_cost_per_token: 0.00000025,
        output_cost_per_token: 0.000001,
        cache_read_input_token_cost: 0.00000004,
        cache_creation_input_token_cost: 0.00000018,
      },
      created_at_ms: Date.now() - 10 * 60 * 60 * 1000,
      updated_at_ms: Date.now() - 10 * 60 * 60 * 1000,
    },
    {
      id: 3,
      provider_id: null,
      model_name: 'gpt-5-nano',
      price_data: {
        input_cost_per_token: 0.00000006,
        output_cost_per_token: 0.00000024,
      },
      created_at_ms: Date.now() - 8 * 60 * 60 * 1000,
      updated_at_ms: Date.now() - 8 * 60 * 60 * 1000,
    },
    {
      id: 4,
      provider_id: 2,
      model_name: 'gpt-4o-mini',
      price_data: {
        input_cost_per_token: 0.00000015,
        output_cost_per_token: 0.0000006,
      },
      created_at_ms: Date.now() - 6 * 60 * 60 * 1000,
      updated_at_ms: Date.now() - 6 * 60 * 60 * 1000,
    },
  ];
}

export function createDemoApiKeys(): ApiKeyWorkspace[] {
  return [
    {
      apiKey: {
        id: 1,
        name: 'team-default',
        enabled: true,
        expires_at_ms: null,
        log_enabled: true,
      },
      totals: {
        requests: 1864,
        success: 1812,
        failed: 52,
        tokens: 2_840_000,
        cost: 248.6,
        averageWaitMs: 742,
        activeDays: 61,
      },
      recentModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini'],
    },
    {
      apiKey: {
        id: 2,
        name: 'cli-runners',
        enabled: true,
        expires_at_ms: Date.now() + 14 * 24 * 60 * 60 * 1000,
        log_enabled: false,
      },
      totals: {
        requests: 942,
        success: 928,
        failed: 14,
        tokens: 1_360_000,
        cost: 104.2,
        averageWaitMs: 611,
        activeDays: 28,
      },
      recentModels: ['gpt-4.1-mini', 'gpt-5-nano'],
    },
    {
      apiKey: {
        id: 3,
        name: 'temp-audit',
        enabled: false,
        expires_at_ms: Date.now() + 4 * 24 * 60 * 60 * 1000,
        log_enabled: true,
      },
      totals: {
        requests: 118,
        success: 110,
        failed: 8,
        tokens: 166_000,
        cost: 12.8,
        averageWaitMs: 894,
        activeDays: 9,
      },
      recentModels: ['gpt-4.1'],
    },
  ];
}

export function createDemoSnapshot(): DashboardSnapshot {
  const stats = createDemoStats();
  const logs = createDemoLogs();
  const prices = createDemoPrices();
  const totalRequests = stats.reduce((sum, row) => sum + row.request_success + row.request_failed, 0);
  const totalTokens = stats.reduce(
    (sum, row) => sum + row.input_tokens + row.output_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens,
    0,
  );
  const totalCost = stats.reduce((sum, row) => sum + Number.parseFloat(row.cost_total_usd), 0);
  const last14 = stats.slice(-14);
  const requestsByDate = new Map(stats.map((row) => [row.date, row.request_success + row.request_failed]));
  const tokensByDate = new Map(
    stats.map((row) => [row.date, row.input_tokens + row.output_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens]),
  );
  const costByDate = new Map(stats.map((row) => [row.date, Number.parseFloat(row.cost_total_usd)]));

  return {
    source: 'preview',
    hero: {
      providers: 3,
      routes: 12,
      prices: prices.length,
      logEnabledKeys: 7,
    },
    totals: {
      requests: totalRequests,
      success: stats.reduce((sum, row) => sum + row.request_success, 0),
      failed: stats.reduce((sum, row) => sum + row.request_failed, 0),
      tokens: totalTokens,
      cost: totalCost,
      averageWaitMs: Math.round(stats.reduce((sum, row) => sum + row.wait_time_ms, 0) / Math.max(totalRequests, 1)),
      activeDays: stats.filter((row) => row.request_success + row.request_failed > 0).length,
      requestsToday: last14[last14.length - 1]?.request_success ?? 0,
    },
    trend: last14.map((row) => ({
      label: row.date.slice(4, 6) + '/' + row.date.slice(6, 8),
      value: row.request_success + row.request_failed,
    })),
    heatmaps: {
      requests: createHeatmap(requestsByDate),
      tokens: createHeatmap(tokensByDate),
      cost: createHeatmap(costByDate),
    },
    recentLogs: logs.slice(0, 8),
    topModels: [
      { model: 'gpt-4.1', requests: 1822, cost: 218.4 },
      { model: 'gpt-4.1-mini', requests: 1533, cost: 102.3 },
      { model: 'gpt-4o-mini', requests: 1266, cost: 78.6 },
      { model: 'gpt-5-nano', requests: 941, cost: 36.2 },
    ],
  };
}
