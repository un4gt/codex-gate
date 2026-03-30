import { For, Match, Show, Switch, createMemo, createSignal, onMount } from 'solid-js';
import { A, Navigate, Route, Router, useLocation } from '@solidjs/router';
import {
  Activity,
  Coins,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  ListFilter,
  RefreshCw,
  Server,
  Settings,
  SquareTerminal,
} from 'lucide-solid';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid, type StatItem } from '@/components/console/StatsGrid';
import { QuickActions } from '@/components/console/QuickActions';
import { StatusBadge } from '@/components/console/StatusBadge';
import { EmptyState } from '@/components/console/EmptyState';
import { ApiKeysPage } from '@/components/ApiKeysPage';
import { LogsPage } from '@/components/LogsPage';
import { ProvidersPage } from '@/components/ProvidersPage';
import { SettingsPage } from '@/components/SettingsPage';
import {
  loadApiKeyWorkspace,
  loadDashboardData,
  loadPrices,
  loadProviderWorkspace,
  loadRequestLogs,
  loadStatsOverview,
  loadSystemConfig,
  loadUsageBreakdown,
} from '@/lib/api';
import { buildDashboardSnapshot, createPreviewSnapshot } from '@/lib/dashboard';
import { createDemoApiKeys, createDemoPrices, createDemoProviders } from '@/lib/demo';
import { formatCompactInteger, formatCost, formatDateTime, formatMs, parseDecimal } from '@/lib/format';
import type {
  ApiKeyWorkspace,
  ConnectionSettings,
  DashboardSnapshot,
  ModelPrice,
  ProviderWorkspace,
  RequestLogRow,
  StatsOverviewResponse,
  SystemConfigResponse,
  UsageBreakdownResponse,
} from '@/lib/types';

type LoadState = 'idle' | 'loading' | 'ready';

interface AppDataContext {
  settings: () => ConnectionSettings;
  snapshot: () => DashboardSnapshot;
  providers: () => ProviderWorkspace[];
  apiKeys: () => ApiKeyWorkspace[];
  prices: () => ModelPrice[];
  systemConfig: () => SystemConfigResponse | null;
  status: () => LoadState;
  message: () => string;
  refreshKey: () => number;
  onApiBaseChange: (value: string) => void;
  onAdminTokenChange: (value: string) => void;
  onRefresh: (successMessage?: string) => Promise<void>;
  onEnterPreview: () => void;
  onMessage: (message: string) => void;
}

const API_BASE_KEY = 'codex_gate_api_base';
const ADMIN_TOKEN_KEY = 'codex_gate_admin_token';

const NAV_ITEMS = [
  { to: '/overview', label: '总览', icon: Activity },
  { to: '/access', label: '接入', icon: Link2 },
  { to: '/keys', label: 'API Keys', icon: KeyRound },
  { to: '/logs', label: '日志', icon: ListFilter },
  { to: '/usage', label: '成本', icon: Coins },
  { to: '/upstreams', label: '上游', icon: Server },
  { to: '/settings', label: '设置', icon: Settings },
] as const;

function defaultApiBase() {
  if (typeof window === 'undefined') return 'http://127.0.0.1:18080';
  return window.location.origin;
}

function readSettings(): ConnectionSettings {
  if (typeof window === 'undefined') {
    return { apiBase: defaultApiBase(), adminToken: '' };
  }
  return {
    apiBase: window.localStorage.getItem(API_BASE_KEY) ?? defaultApiBase(),
    adminToken: window.sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '',
  };
}

function persistSettings(settings: ConnectionSettings) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(API_BASE_KEY, settings.apiBase);
  window.sessionStorage.setItem(ADMIN_TOKEN_KEY, settings.adminToken);
}

async function copyText(value: string, success: string, onMessage: (message: string) => void) {
  if (!navigator?.clipboard) {
    onMessage('当前环境不支持剪贴板。');
    return;
  }
  await navigator.clipboard.writeText(value);
  onMessage(success);
}

function modeLabel(source: DashboardSnapshot['source']) {
  return source === 'live' ? '实时' : '预览';
}

function modeTone(source: DashboardSnapshot['source']) {
  return source === 'live' ? 'normal' : 'warning';
}

function pageDescription(pathname: string) {
  if (pathname.startsWith('/overview')) return '查看服务状态、请求趋势与最近异常。';
  if (pathname.startsWith('/access')) return '完成地址配置并发送第一条请求。';
  if (pathname.startsWith('/keys')) return '创建和管理访问密钥。';
  if (pathname.startsWith('/logs')) return '筛选并排查最近请求。';
  if (pathname.startsWith('/usage')) return '查看成本趋势与消耗拆分。';
  if (pathname.startsWith('/upstreams')) return '查看连接目标与健康状态。';
  if (pathname.startsWith('/settings')) return '维护连接信息与高级设置。';
  return '';
}

function TopShell(props: { data: AppDataContext; children: any }) {
  const location = useLocation();
  const currentItem = createMemo(() => NAV_ITEMS.find((item) => location.pathname.startsWith(item.to)) ?? NAV_ITEMS[0]);

  return (
    <div class="min-h-screen bg-background">
      <div class="mx-auto grid min-h-screen max-w-[1520px] grid-cols-1 gap-0 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside class="border-b border-border bg-card/80 px-4 py-4 backdrop-blur-sm lg:border-b-0 lg:border-r lg:px-5 lg:py-6">
          <div class="flex items-center gap-3 px-2 pb-5">
            <div class="flex size-10 items-center justify-center rounded-xl bg-foreground text-background">
              <SquareTerminal />
            </div>
            <div class="min-w-0">
              <p class="text-sm font-semibold tracking-[-0.02em] text-foreground">codex-gate</p>
              <p class="text-xs text-muted-foreground">Admin Console</p>
            </div>
          </div>
          <nav class="flex flex-col gap-1" aria-label="Primary">
            <For each={NAV_ITEMS}>
              {(item) => {
                const Icon = item.icon;
                const active = () => location.pathname.startsWith(item.to);
                return (
                  <A
                    href={item.to}
                    class={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
                      active() ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <Icon />
                    <span class="font-medium">{item.label}</span>
                  </A>
                );
              }}
            </For>
          </nav>
          <div class="mt-6 flex flex-col gap-3 rounded-2xl border border-border bg-muted/35 p-3">
            <div class="flex items-center justify-between gap-3">
              <span class="text-xs uppercase tracking-[0.18em] text-muted-foreground">当前模式</span>
              <StatusBadge tone={modeTone(props.data.snapshot().source)}>{modeLabel(props.data.snapshot().source)}</StatusBadge>
            </div>
            <p class="text-sm text-muted-foreground">{props.data.message()}</p>
            <div class="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void props.data.onRefresh()}
                disabled={props.data.status() === 'loading'}
              >
                <RefreshCw class={props.data.status() === 'loading' ? 'animate-spin' : undefined} />
                刷新
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={props.data.onEnterPreview}>
                预览
              </Button>
            </div>
          </div>
        </aside>

        <main class="min-w-0 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
          <div class="flex flex-col gap-6">
            <div class="flex flex-col gap-4 border-b border-border pb-4 md:flex-row md:items-start md:justify-between">
              <div class="min-w-0">
                <div class="mb-1 flex items-center gap-2">
                  <p class="text-xs uppercase tracking-[0.18em] text-muted-foreground">控制台</p>
                  <Show when={props.data.status() === 'loading'}>
                    <Badge variant="outline">刷新中</Badge>
                  </Show>
                </div>
                <h1 class="text-2xl font-semibold tracking-[-0.03em] text-foreground">{currentItem().label}</h1>
                <p class="mt-1 text-sm text-muted-foreground">{pageDescription(location.pathname)}</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <StatusBadge tone={modeTone(props.data.snapshot().source)}>{modeLabel(props.data.snapshot().source)}</StatusBadge>
                <Show when={props.data.settings().adminToken.trim()}>
                  <Badge variant="outline">已连接</Badge>
                </Show>
                <Show when={!props.data.settings().adminToken.trim()}>
                  <Badge variant="outline">未连接</Badge>
                </Show>
              </div>
            </div>
            {props.children}
          </div>
        </main>
      </div>
    </div>
  );
}

function OverviewPage(props: { data: AppDataContext }) {
  const [overview, setOverview] = createSignal<StatsOverviewResponse | null>(null);
  const [period, setPeriod] = createSignal<'today' | '7d' | '30d'>('today');

  const loadOverview = async () => {
    const current = props.data.settings();
    if (!current.adminToken.trim()) {
      setOverview(null);
      return;
    }
    try {
      const data = await loadStatsOverview(current, period());
      setOverview(data);
    } catch (error) {
      props.data.onMessage(error instanceof Error ? `${error.message}；已回退到本地总览。` : '读取总览失败。');
      setOverview(null);
    }
  };

  onMount(() => {
    void loadOverview();
  });

  const metrics = createMemo<StatItem[]>(() => {
    const live = overview();
    if (live) {
      return [
        {
          label: '今日请求',
          value: formatCompactInteger(live.kpis.requests),
          hint: `失败 ${formatCompactInteger(live.kpis.failed)}`,
        },
        {
          label: '错误率',
          value: `${live.kpis.error_rate.toFixed(1)}%`,
          hint: live.kpis.error_rate > 5 ? '高于阈值' : '处于正常区间',
          tone: live.kpis.error_rate > 5 ? 'warning' : 'success',
        },
        {
          label: 'P95 延迟',
          value: formatMs(live.kpis.p95_latency_ms),
          hint: '最近 24 小时',
        },
        {
          label: '今日成本',
          value: formatCost(parseDecimal(live.kpis.cost_total_usd)),
          hint: '可切到成本页查看拆分',
        },
      ];
    }

    const snapshot = props.data.snapshot();
    const errorRate = snapshot.totals.requests > 0 ? (snapshot.totals.failed / snapshot.totals.requests) * 100 : 0;
    return [
      { label: '今日请求', value: formatCompactInteger(snapshot.totals.requestsToday), hint: `累计 ${formatCompactInteger(snapshot.totals.requests)}` },
      { label: '错误率', value: `${errorRate.toFixed(1)}%`, hint: `失败 ${formatCompactInteger(snapshot.totals.failed)}` },
      { label: 'P95 延迟', value: formatMs(snapshot.totals.averageWaitMs), hint: '使用平均耗时回退' },
      { label: '今日成本', value: formatCost(snapshot.totals.cost), hint: '来自本地汇总' },
    ];
  });

  const anomalies = createMemo(() => overview()?.recent_anomalies ?? props.data.snapshot().recentLogs.filter((row) => (row.http_status ?? 200) >= 400).slice(0, 5));
  const topModels = createMemo(() => overview()?.top_models ?? props.data.snapshot().topModels.map((model) => ({
    key: model.model,
    requests: model.requests,
    failed: 0,
    tokens: 0,
    cost_total_usd: String(model.cost),
  })));
  const latestKey = createMemo(() => props.data.apiKeys()[0]?.apiKey);

  return (
    <div class="flex flex-col gap-6">
      <PageHeader
        title="总览"
        description="查看服务状态、请求趋势与最近异常。"
        actions={
          <>
            <Button
              type="button"
              size="sm"
              variant={period() === 'today' ? 'secondary' : 'outline'}
              onClick={() => {
                setPeriod('today');
                void loadOverview();
              }}
            >
              今日
            </Button>
            <Button
              type="button"
              size="sm"
              variant={period() === '7d' ? 'secondary' : 'outline'}
              onClick={() => {
                setPeriod('7d');
                void loadOverview();
              }}
            >
              7 天
            </Button>
            <Button
              type="button"
              size="sm"
              variant={period() === '30d' ? 'secondary' : 'outline'}
              onClick={() => {
                setPeriod('30d');
                void loadOverview();
              }}
            >
              30 天
            </Button>
            <Button type="button" variant="outline" onClick={() => void copyText(props.data.settings().apiBase, 'Base URL 已复制。', props.data.onMessage)}>
              <Copy />
              复制 Base URL
            </Button>
            <A href="/keys">
              <Button type="button">创建 API Key</Button>
            </A>
            <A href="/logs">
              <Button type="button" variant="outline">
                查看日志
              </Button>
            </A>
          </>
        }
      />

      <StatsGrid items={metrics()} />

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
        <Card class="border-border/80 bg-card/95">
          <CardHeader>
            <div class="flex items-center justify-between gap-3">
              <div>
                <CardTitle>服务状态</CardTitle>
                <CardDescription>先看整体，再决定是否进入日志或上游。</CardDescription>
              </div>
              <StatusBadge
                tone={
                  (overview()?.service_health.error ?? 0) > 0
                    ? 'error'
                    : (overview()?.service_health.warning ?? 0) > 0
                      ? 'warning'
                      : 'normal'
                }
              >
                {(overview()?.service_health.error ?? 0) > 0 ? '异常' : (overview()?.service_health.warning ?? 0) > 0 ? '警告' : '正常'}
              </StatusBadge>
            </div>
          </CardHeader>
          <CardContent class="grid gap-3 md:grid-cols-3">
            <div class="rounded-xl border border-border/70 bg-muted/35 p-4">
              <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">上游健康</div>
              <div class="mt-2 text-xl font-semibold text-foreground">
                {overview() ? `${overview()?.service_health.healthy ?? 0} 正常` : `${props.data.providers().filter((item) => item.provider.enabled).length} 已启用`}
              </div>
              <p class="mt-2 text-sm text-muted-foreground">
                {overview() ? `${overview()?.service_health.warning ?? 0} 警告 · ${overview()?.service_health.error ?? 0} 异常` : '使用预览数据'}
              </p>
            </div>
            <div class="rounded-xl border border-border/70 bg-muted/35 p-4">
              <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">最近 24h 错误</div>
              <div class="mt-2 text-xl font-semibold text-foreground">{formatCompactInteger(anomalies().length)}</div>
              <p class="mt-2 text-sm text-muted-foreground">点击右侧列表可直接进入日志详情。</p>
            </div>
            <div class="rounded-xl border border-border/70 bg-muted/35 p-4">
              <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">活跃 Key</div>
              <div class="mt-2 text-xl font-semibold text-foreground">{formatCompactInteger(props.data.apiKeys().filter((item) => item.apiKey.enabled).length)}</div>
              <p class="mt-2 text-sm text-muted-foreground">当前已启用的访问密钥。</p>
            </div>
            <div class="md:col-span-3">
              <A href="/upstreams">
                <Button type="button" variant="outline">
                  查看上游
                </Button>
              </A>
            </div>
          </CardContent>
        </Card>

        <QuickActions
          title="快速开始"
          items={[
            {
              title: 'Base URL',
              description: props.data.settings().apiBase,
              action: (
                <Button type="button" size="sm" variant="outline" onClick={() => void copyText(props.data.settings().apiBase, 'Base URL 已复制。', props.data.onMessage)}>
                  复制
                </Button>
              ),
            },
            {
              title: 'API Key',
              description: `共 ${formatCompactInteger(props.data.apiKeys().length)} 个 · 最近 ${latestKey() ? formatDateTime(latestKey()!.id) : '暂无'}`,
              action: (
                <A href="/keys">
                  <Button type="button" size="sm">
                    创建 Key
                  </Button>
                </A>
              ),
            },
            {
              title: '接入示例',
              description: '提供 cURL、JavaScript 与 Python。',
              action: (
                <A href="/access">
                  <Button type="button" size="sm" variant="outline">
                    打开接入
                  </Button>
                </A>
              ),
            },
          ]}
        />
      </div>

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <Card class="border-border/80 bg-card/95">
          <CardHeader>
            <div class="flex items-center justify-between gap-3">
              <div>
                <CardTitle>最近异常</CardTitle>
                <CardDescription>默认只保留最近 5 条高价值异常。</CardDescription>
              </div>
              <A href="/logs">
                <Button type="button" size="sm" variant="outline">
                  查看全部日志
                </Button>
              </A>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>延迟</TableHead>
                  <TableHead>Key</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Show
                  when={anomalies().length > 0}
                  fallback={
                    <TableRow>
                      <TableCell colspan={5} class="text-center text-muted-foreground">
                        当前没有异常请求。
                      </TableCell>
                    </TableRow>
                  }
                >
                  <For each={anomalies()}>
                    {(row) => (
                      <TableRow>
                        <TableCell>{formatDateTime(row.time_ms)}</TableCell>
                        <TableCell>{row.model ?? 'unknown'}</TableCell>
                        <TableCell>
                          <StatusBadge tone={(row.http_status ?? 500) >= 500 ? 'error' : 'warning'}>{String(row.http_status ?? '—')}</StatusBadge>
                        </TableCell>
                        <TableCell>{formatMs(row.duration_ms ?? row.t_first_token_ms ?? row.t_first_byte_ms ?? 0)}</TableCell>
                        <TableCell>#{row.api_key_id}</TableCell>
                      </TableRow>
                    )}
                  </For>
                </Show>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card class="border-border/80 bg-card/95">
          <CardHeader>
            <CardTitle>热门模型</CardTitle>
            <CardDescription>按请求量与成本排序。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <Show
              when={topModels().length > 0}
              fallback={<EmptyState title="暂无模型数据" description="有请求后会显示常用模型。" />}
            >
              <For each={topModels()}>
                {(item) => (
                  <div class="flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-muted/30 px-4 py-3">
                    <div class="min-w-0">
                      <div class="truncate text-sm font-medium text-foreground">{item.key}</div>
                      <div class="mt-1 text-sm text-muted-foreground">
                        {formatCompactInteger(item.requests)} 请求 · 错误率{' '}
                        {item.requests > 0 ? `${((item.failed / item.requests) * 100).toFixed(1)}%` : '0%'}
                      </div>
                    </div>
                    <div class="text-sm font-medium text-foreground">{formatCost(parseDecimal(item.cost_total_usd))}</div>
                  </div>
                )}
              </For>
            </Show>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AccessPage(props: { data: AppDataContext }) {
  const curlSample = createMemo(
    () => `curl ${props.data.settings().apiBase}/v1/chat/completions \\
  -H "Authorization: Bearer <YOUR_API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"hello"}]}'`,
  );
  const jsSample = createMemo(
    () => `const res = await fetch("${props.data.settings().apiBase}/v1/responses", {
  method: "POST",
  headers: {
    Authorization: "Bearer <YOUR_API_KEY>",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "gpt-4.1-mini",
    input: "hello"
  })
});`,
  );
  const pySample = createMemo(
    () => `import requests

res = requests.post(
  "${props.data.settings().apiBase}/v1/chat/completions",
  headers={
    "Authorization": "Bearer <YOUR_API_KEY>",
    "Content-Type": "application/json"
  },
  json={
    "model": "gpt-4.1-mini",
    "messages": [{"role": "user", "content": "hello"}]
  }
)`,
  );

  return (
    <div class="flex flex-col gap-6">
      <PageHeader
        title="接入"
        description="完成地址配置并发送第一条请求。"
        actions={
          <A href="/keys">
            <Button type="button">创建 API Key</Button>
          </A>
        }
      />

      <div class="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card class="border-border/80 bg-card/95">
          <CardHeader>
            <CardTitle>连接信息</CardTitle>
            <CardDescription>接入只需要 Base URL 和 API Key。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-4">
            <div class="rounded-xl border border-border/70 bg-muted/30 p-4">
              <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">Base URL</div>
              <code class="mt-2 block break-all text-sm text-foreground">{props.data.settings().apiBase}</code>
            </div>
            <div class="rounded-xl border border-border/70 bg-muted/30 p-4">
              <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">管理状态</div>
              <div class="mt-2 flex items-center gap-2">
                <StatusBadge tone={props.data.settings().adminToken.trim() ? 'normal' : 'warning'}>
                  {props.data.settings().adminToken.trim() ? '已连接' : '未连接'}
                </StatusBadge>
                <span class="text-sm text-muted-foreground">{props.data.message()}</span>
              </div>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void copyText(props.data.settings().apiBase, 'Base URL 已复制。', props.data.onMessage)}>
                <Copy />
                复制 Base URL
              </Button>
              <A href="/keys">
                <Button type="button">创建 API Key</Button>
              </A>
            </div>
            <Alert>
              <AlertTitle>常见错误</AlertTitle>
              <AlertDescription>先确认 API Key 是否启用，再检查 Base URL 与模型名是否正确。</AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <div class="grid gap-6">
          <Card class="border-border/80 bg-card/95">
            <CardHeader>
              <CardTitle>最短接入方式</CardTitle>
              <CardDescription>复制即可测试。</CardDescription>
            </CardHeader>
            <CardContent class="grid gap-4 xl:grid-cols-3">
              <For each={[
                { title: 'cURL', value: curlSample() },
                { title: 'JavaScript', value: jsSample() },
                { title: 'Python', value: pySample() },
              ]}>
                {(item) => (
                  <div class="rounded-xl border border-border/70 bg-muted/25 p-4">
                    <div class="mb-3 flex items-center justify-between gap-2">
                      <strong class="text-sm text-foreground">{item.title}</strong>
                      <Button type="button" size="sm" variant="outline" onClick={() => void copyText(item.value, `${item.title} 示例已复制。`, props.data.onMessage)}>
                        复制
                      </Button>
                    </div>
                    <pre class="overflow-auto rounded-lg bg-background p-3 text-xs leading-5 text-foreground">{item.value}</pre>
                  </div>
                )}
              </For>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function UsagePage(props: { data: AppDataContext }) {
  const [period, setPeriod] = createSignal<'today' | '7d' | '30d'>('today');
  const [breakdownByModel, setBreakdownByModel] = createSignal<UsageBreakdownResponse | null>(null);
  const [breakdownByKey, setBreakdownByKey] = createSignal<UsageBreakdownResponse | null>(null);

  const loadUsage = async () => {
    const current = props.data.settings();
    if (!current.adminToken.trim()) {
      setBreakdownByModel(null);
      setBreakdownByKey(null);
      return;
    }
    try {
      const [modelRows, keyRows] = await Promise.all([
        loadUsageBreakdown(current, { by: 'model', period: period(), limit: 8 }),
        loadUsageBreakdown(current, { by: 'api_key', period: period(), limit: 8 }),
      ]);
      setBreakdownByModel(modelRows);
      setBreakdownByKey(keyRows);
    } catch (error) {
      props.data.onMessage(error instanceof Error ? error.message : '读取成本拆分失败。');
    }
  };

  onMount(() => {
    void loadUsage();
  });

  const modelRows = createMemo(() => breakdownByModel()?.rows ?? []);
  const keyRows = createMemo(() => breakdownByKey()?.rows ?? []);
  const totalCost = createMemo(() => modelRows().reduce((sum, row) => sum + parseDecimal(row.cost_total_usd), 0));
  const totalRequests = createMemo(() => modelRows().reduce((sum, row) => sum + row.requests, 0));
  const topConsumer = createMemo(() => modelRows()[0]);

  return (
    <div class="flex flex-col gap-6">
      <PageHeader
        title="成本"
        description="查看成本趋势与消耗拆分。"
        actions={
          <>
            <Button type="button" size="sm" variant={period() === 'today' ? 'secondary' : 'outline'} onClick={() => { setPeriod('today'); void loadUsage(); }}>
              今日
            </Button>
            <Button type="button" size="sm" variant={period() === '7d' ? 'secondary' : 'outline'} onClick={() => { setPeriod('7d'); void loadUsage(); }}>
              本周
            </Button>
            <Button type="button" size="sm" variant={period() === '30d' ? 'secondary' : 'outline'} onClick={() => { setPeriod('30d'); void loadUsage(); }}>
              本月
            </Button>
          </>
        }
      />

      <StatsGrid
        items={[
          { label: '总成本', value: formatCost(totalCost()), hint: `窗口 ${period() === 'today' ? '今日' : period() === '7d' ? '7 天' : '30 天'}` },
          { label: '总请求', value: formatCompactInteger(totalRequests()), hint: '当前窗口内请求总量' },
          { label: '活跃模型', value: formatCompactInteger(modelRows().length), hint: '按成本或请求排序' },
          {
            label: '最高消耗',
            value: topConsumer() ? topConsumer()!.key : '—',
            hint: topConsumer() ? formatCost(parseDecimal(topConsumer()!.cost_total_usd)) : '暂无数据',
          },
        ]}
      />

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card class="border-border/80 bg-card/95">
          <CardHeader>
                <CardTitle>成本趋势</CardTitle>
                <CardDescription>粗略趋势预览，详细请以导出的统计为准。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-4">
            <div class="grid gap-2">
              <For each={props.data.snapshot().trend}>
                {(point) => (
                  <div class="grid grid-cols-[72px_minmax(0,1fr)_72px] items-center gap-3">
                    <span class="text-xs uppercase tracking-[0.16em] text-muted-foreground">{point.label}</span>
                    <div class="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        class="h-full rounded-full bg-primary"
                        style={{ width: `${(point.value / Math.max(...props.data.snapshot().trend.map((item) => item.value), 1)) * 100}%` }}
                      />
                    </div>
                    <span class="text-right text-sm text-foreground">{formatCompactInteger(point.value)}</span>
                  </div>
                )}
              </For>
            </div>
          </CardContent>
        </Card>

        <Card class="border-border/80 bg-card/95">
          <CardHeader>
            <CardTitle>异常提示</CardTitle>
            <CardDescription>只保留对决策有帮助的提醒。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <Alert variant={topConsumer() && parseDecimal(topConsumer()!.cost_total_usd) > totalCost() * 0.45 ? 'destructive' : 'default'}>
              <AlertTitle>Top consumer</AlertTitle>
              <AlertDescription>
                {topConsumer()
                  ? `${topConsumer()!.key} 占用 ${((parseDecimal(topConsumer()!.cost_total_usd) / Math.max(totalCost(), 0.01)) * 100).toFixed(1)}% 成本。`
                  : '暂无足够数据。'}
              </AlertDescription>
            </Alert>
            <Alert>
              <AlertTitle>排查路径</AlertTitle>
              <AlertDescription>进入日志页按模型与 API Key 交叉筛选。</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>

      <div class="grid gap-6 xl:grid-cols-2">
        <Card class="border-border/80 bg-card/95">
          <CardHeader>
            <CardTitle>按模型</CardTitle>
            <CardDescription>查看模型消耗与错误情况。</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead>请求</TableHead>
                  <TableHead>错误</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>成本</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Show
                  when={modelRows().length > 0}
                  fallback={
                    <TableRow>
                      <TableCell colspan={5} class="text-center text-muted-foreground">
                        暂无成本数据。
                      </TableCell>
                    </TableRow>
                  }
                >
                  <For each={modelRows()}>
                    {(row) => (
                      <TableRow>
                        <TableCell>{row.key}</TableCell>
                        <TableCell>{formatCompactInteger(row.requests)}</TableCell>
                        <TableCell>{formatCompactInteger(row.failed)}</TableCell>
                        <TableCell>{formatCompactInteger(row.tokens)}</TableCell>
                        <TableCell>{formatCost(parseDecimal(row.cost_total_usd))}</TableCell>
                      </TableRow>
                    )}
                  </For>
                </Show>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card class="border-border/80 bg-card/95">
          <CardHeader>
            <CardTitle>按 API Key</CardTitle>
            <CardDescription>识别高消耗访问方。</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>请求</TableHead>
                  <TableHead>错误</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>成本</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Show
                  when={keyRows().length > 0}
                  fallback={
                    <TableRow>
                      <TableCell colspan={5} class="text-center text-muted-foreground">
                        暂无 Key 成本数据。
                      </TableCell>
                    </TableRow>
                  }
                >
                  <For each={keyRows()}>
                    {(row) => (
                      <TableRow>
                        <TableCell>#{row.key}</TableCell>
                        <TableCell>{formatCompactInteger(row.requests)}</TableCell>
                        <TableCell>{formatCompactInteger(row.failed)}</TableCell>
                        <TableCell>{formatCompactInteger(row.tokens)}</TableCell>
                        <TableCell>{formatCost(parseDecimal(row.cost_total_usd))}</TableCell>
                      </TableRow>
                    )}
                  </For>
                </Show>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function UpstreamsPage(props: { data: AppDataContext }) {
  return (
    <div class="flex flex-col gap-6">
      <PageHeader title="上游" description="查看连接目标与健康状态。" />
      <ProvidersPage
        source={props.data.snapshot().source}
        settings={props.data.settings()}
        items={props.data.providers()}
        onRefresh={props.data.onRefresh}
        onMessage={props.data.onMessage}
      />
    </div>
  );
}

function KeysRoutePage(props: { data: AppDataContext }) {
  return (
    <ApiKeysPage
      source={props.data.snapshot().source}
      settings={props.data.settings()}
      items={props.data.apiKeys()}
      onRefresh={props.data.onRefresh}
      onMessage={props.data.onMessage}
    />
  );
}

function LogsRoutePage(props: { data: AppDataContext }) {
  return (
    <LogsPage
      source={props.data.snapshot().source}
      settings={props.data.settings()}
      providers={props.data.providers()}
      apiKeys={props.data.apiKeys()}
      refreshKey={props.data.refreshKey()}
      onMessage={props.data.onMessage}
    />
  );
}

function SettingsRoutePage(props: { data: AppDataContext }) {
  return (
    <SettingsPage
      settings={props.data.settings()}
      snapshot={props.data.snapshot()}
      systemConfig={props.data.systemConfig()}
      prices={props.data.prices()}
      providers={props.data.providers()}
      onApiBaseChange={props.data.onApiBaseChange}
      onAdminTokenChange={props.data.onAdminTokenChange}
      onRefresh={props.data.onRefresh}
      onPreview={props.data.onEnterPreview}
      onMessage={props.data.onMessage}
    />
  );
}

function Root() {
  const [settings, setSettings] = createSignal<ConnectionSettings>(readSettings());
  const [snapshot, setSnapshot] = createSignal<DashboardSnapshot>(createPreviewSnapshot());
  const [providers, setProviders] = createSignal<ProviderWorkspace[]>(createDemoProviders());
  const [apiKeys, setApiKeys] = createSignal<ApiKeyWorkspace[]>(createDemoApiKeys());
  const [prices, setPrices] = createSignal<ModelPrice[]>(createDemoPrices());
  const [systemConfig, setSystemConfig] = createSignal<SystemConfigResponse | null>(null);
  const [status, setStatus] = createSignal<LoadState>('idle');
  const [message, setMessage] = createSignal('未连接 Admin API，当前展示预览数据。');
  const [refreshKey, setRefreshKey] = createSignal(0);

  const refreshData = async (successMessage?: string) => {
    const current = settings();
    persistSettings(current);
    setStatus('loading');

    if (!current.adminToken.trim()) {
      setSnapshot(createPreviewSnapshot());
      setProviders(createDemoProviders());
      setApiKeys(createDemoApiKeys());
      setPrices(createDemoPrices());
      setSystemConfig(null);
      setMessage('未填写 Admin Token，当前展示预览数据。');
      setRefreshKey((value) => value + 1);
      setStatus('ready');
      return;
    }

    try {
      const [dashboardBundle, providerWorkspace, apiKeyWorkspace, priceItems, config] = await Promise.all([
        loadDashboardData(current),
        loadProviderWorkspace(current),
        loadApiKeyWorkspace(current),
        loadPrices(current),
        loadSystemConfig(current).catch(() => null),
      ]);
      setSnapshot(buildDashboardSnapshot(dashboardBundle));
      setProviders(providerWorkspace);
      setApiKeys(apiKeyWorkspace);
      setPrices(priceItems);
      setSystemConfig(config);
      setMessage(successMessage ?? `已连接 ${current.apiBase}。`);
    } catch (error) {
      setSnapshot(createPreviewSnapshot());
      setProviders(createDemoProviders());
      setApiKeys(createDemoApiKeys());
      setPrices(createDemoPrices());
      setSystemConfig(null);
      setMessage(error instanceof Error ? `${error.message}；已回退到预览数据。` : '连接失败，已回退到预览数据。');
    } finally {
      setRefreshKey((value) => value + 1);
      setStatus('ready');
    }
  };

  const enterPreview = () => {
    setSnapshot(createPreviewSnapshot());
    setProviders(createDemoProviders());
    setApiKeys(createDemoApiKeys());
    setPrices(createDemoPrices());
    setSystemConfig(null);
    setMessage('已切换到预览模式。');
    setRefreshKey((value) => value + 1);
    setStatus('ready');
  };

  onMount(() => {
    void refreshData();
  });

  const data: AppDataContext = {
    settings,
    snapshot,
    providers,
    apiKeys,
    prices,
    systemConfig,
    status,
    message,
    refreshKey,
    onApiBaseChange: (value) => setSettings((current) => ({ ...current, apiBase: value })),
    onAdminTokenChange: (value) => setSettings((current) => ({ ...current, adminToken: value })),
    onRefresh: refreshData,
    onEnterPreview: enterPreview,
    onMessage: setMessage,
  };

  return (
    <Router>
      <TopShell data={data}>
        <Route path="/" component={() => <Navigate href="/overview" />} />
        <Route path="/overview" component={() => <OverviewPage data={data} />} />
        <Route path="/access" component={() => <AccessPage data={data} />} />
        <Route path="/keys" component={() => <KeysRoutePage data={data} />} />
        <Route path="/logs" component={() => <LogsRoutePage data={data} />} />
        <Route path="/usage" component={() => <UsagePage data={data} />} />
        <Route path="/upstreams" component={() => <UpstreamsPage data={data} />} />
        <Route path="/settings" component={() => <SettingsRoutePage data={data} />} />
        <Route path="/prices" component={() => <Navigate href="/usage" />} />
        <Route path="*" component={() => <Navigate href="/overview" />} />
      </TopShell>
    </Router>
  );
}

export default Root;
