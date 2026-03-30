import { createDemoSnapshot } from './demo';
import { parseDecimal } from './format';
import type { DashboardResponseBundle, DashboardSnapshot, HeatmapDay, RequestLogRow, StatsDailyRow } from './types';

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}${month}${day}`;
}

function formatDateLabel(dateKey: string): string {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

function getRequestCount(row: StatsDailyRow): number {
  return row.request_success + row.request_failed;
}

function getTokenCount(row: StatsDailyRow): number {
  return row.input_tokens + row.output_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens;
}

function clampLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  const ratio = value / Math.max(max, 1);
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

function buildHeatmap(valuesByDate: Map<string, number>): HeatmapDay[] {
  const values = Array.from(valuesByDate.values());
  const max = Math.max(...values, 1);

  const today = new Date();
  const start = addDays(today, -(54 * 7) + 1 - today.getUTCDay());

  return Array.from({ length: 54 * 7 }, (_, index) => {
    const current = addDays(start, index);
    const dateKey = formatDateKey(current);
    const value = valuesByDate.get(dateKey) ?? 0;
    const isFuture = current.getTime() > today.getTime();
    return {
      date: dateKey,
      label: formatDateLabel(dateKey),
      value,
      level: isFuture ? 0 : clampLevel(value, max),
      isFuture,
    };
  });
}

function buildTopModels(logs: RequestLogRow[]): Array<{ model: string; requests: number; cost: number }> {
  const grouped = new Map<string, { requests: number; cost: number }>();

  for (const row of logs) {
    const model = row.model || 'unknown';
    const current = grouped.get(model) ?? { requests: 0, cost: 0 };
    current.requests += 1;
    current.cost += parseDecimal(row.cost_total_usd);
    grouped.set(model, current);
  }

  return Array.from(grouped.entries())
    .map(([model, value]) => ({ model, requests: value.requests, cost: value.cost }))
    .sort((left, right) => right.requests - left.requests || right.cost - left.cost)
    .slice(0, 5);
}

export function buildDashboardSnapshot(bundle: DashboardResponseBundle): DashboardSnapshot {
  const statsDaily = [...bundle.statsDaily].sort((left, right) => left.date.localeCompare(right.date));
  const totalRequests = statsDaily.reduce((sum, row) => sum + getRequestCount(row), 0);
  const totalSuccess = statsDaily.reduce((sum, row) => sum + row.request_success, 0);
  const totalFailed = statsDaily.reduce((sum, row) => sum + row.request_failed, 0);
  const totalTokens = statsDaily.reduce((sum, row) => sum + getTokenCount(row), 0);
  const totalCost = statsDaily.reduce((sum, row) => sum + parseDecimal(row.cost_total_usd), 0);
  const averageWaitMs = Math.round(statsDaily.reduce((sum, row) => sum + row.wait_time_ms, 0) / Math.max(totalRequests, 1));
  const activeDays = statsDaily.filter((row) => getRequestCount(row) > 0).length;
  const todayKey = formatDateKey(new Date());
  const todayRow = statsDaily.find((row) => row.date === todayKey);
  const trendRows = statsDaily.slice(-14);

  const requestsByDate = new Map(statsDaily.map((row) => [row.date, getRequestCount(row)]));
  const tokensByDate = new Map(statsDaily.map((row) => [row.date, getTokenCount(row)]));
  const costByDate = new Map(statsDaily.map((row) => [row.date, parseDecimal(row.cost_total_usd)]));

  return {
    source: 'live',
    hero: {
      providers: bundle.providers.filter((provider) => provider.enabled).length,
      routes: bundle.routes.filter((route) => route.enabled).length,
      prices: bundle.prices.length,
      logEnabledKeys: bundle.apiKeys.filter((apiKey) => apiKey.enabled && apiKey.log_enabled).length,
    },
    totals: {
      requests: totalRequests,
      success: totalSuccess,
      failed: totalFailed,
      tokens: totalTokens,
      cost: totalCost,
      averageWaitMs,
      activeDays,
      requestsToday: todayRow ? getRequestCount(todayRow) : 0,
    },
    trend: trendRows.map((row) => ({
      label: `${row.date.slice(4, 6)}/${row.date.slice(6, 8)}`,
      value: getRequestCount(row),
    })),
    heatmaps: {
      requests: buildHeatmap(requestsByDate),
      tokens: buildHeatmap(tokensByDate),
      cost: buildHeatmap(costByDate),
    },
    recentLogs: bundle.requestLogs,
    topModels: buildTopModels(bundle.requestLogs),
  };
}

export function createPreviewSnapshot(): DashboardSnapshot {
  return createDemoSnapshot();
}
