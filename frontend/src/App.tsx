import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
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
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid, type StatItem } from '@/components/console/StatsGrid';
import { QuickActions } from '@/components/console/QuickActions';
import { StatusBadge } from '@/components/console/StatusBadge';
import { EmptyState } from '@/components/console/EmptyState';
import { LocaleSwitch } from '@/components/LocaleSwitch';
import { ApiKeysPage } from '@/components/ApiKeysPage';
import { LogsPage } from '@/components/LogsPage';
import { ProvidersPage } from '@/components/ProvidersPage';
import { SettingsPage } from '@/components/SettingsPage';
import { installLocaleEffect, t } from '@/lib/i18n';
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
import { buildDashboardSnapshot, createEmptyDashboardSnapshot } from '@/lib/dashboard';
import { formatCompactInteger, formatCost, formatDateTime, formatModelName, formatMs, parseDecimal } from '@/lib/format';
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
type ConsoleAccessMode = 'connect' | 'console';

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
  onMessage: (message: string) => void;
}

const API_BASE_KEY = 'codex_gate_api_base';
const ADMIN_TOKEN_KEY = 'codex_gate_admin_token';

const NAV_ITEMS = [
  { to: '/overview', label: '总览', icon: Activity },
  { to: '/access', label: '接入', icon: Link2 },
  { to: '/keys', label: '密钥', icon: KeyRound },
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
    onMessage(t('当前环境不支持剪贴板。'));
    return;
  }
  await navigator.clipboard.writeText(value);
  onMessage(t(success));
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
      <div class="mx-auto flex min-h-screen max-w-[1520px] flex-col lg:flex-row">
        <aside class="w-full lg:w-[280px] flex-shrink-0 border-r border-border bg-sidebar px-4 py-8">
          <div class="flex items-center gap-3 px-2 pb-12">
            <div class="flex size-8 items-center justify-center bg-foreground text-background">
              <SquareTerminal class="size-4" />
            </div>
            <div class="min-w-0">
              <p class="text-[0.95rem] font-bold tracking-widest text-foreground uppercase">CODEX GATE</p>
            </div>
          </div>
          <nav class="flex flex-col gap-1" aria-label="Primary">
            <For each={NAV_ITEMS}>
              {(item) => {
                const active = () => location.pathname.startsWith(item.to);
                return (
                  <A
                    href={item.to}
                    class={`group relative flex items-center justify-between px-3 py-3 text-xs uppercase tracking-[0.2em] transition-all border-b border-border/40 ${
                      active() ? 'text-primary font-bold' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span class="relative z-10 flex items-center gap-3">
                      <span>{t(item.label)}</span>
                    </span>
                    <span class="relative z-10 text-[0.6rem] text-muted-foreground opacity-40 font-mono">{String(NAV_ITEMS.indexOf(item) + 1).padStart(2, '0')}</span>
                    {active() && (
                      <span class="absolute inset-y-0 left-0 w-1 bg-primary/20" />
                    )}
                  </A>
                );
              }}
            </For>
          </nav>
          <div class="mt-16 flex flex-col gap-4 pt-8 border-t border-border/40 px-3">
              <div class="flex items-center justify-between">
                <span class="text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground font-mono">{t('SYSTEM STATUS')}</span>
                <span class="flex h-2 w-2 relative">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
              </div>
              <p class="text-xs text-muted-foreground font-mono truncate">{props.data.message()}</p>
          </div>
        </aside>

        <main class="min-w-0 flex-1 bg-background px-6 py-8 lg:px-12 lg:py-12">
          <div class="flex flex-col gap-12 max-w-5xl">
            <div class="flex flex-col gap-6 border-b border-border pb-8 md:flex-row md:items-end md:justify-between">
              <div class="min-w-0">
                <div class="mb-3 flex items-center gap-3">
                  <span class="size-1.5 rounded-full bg-primary" />
                  <p class="text-[0.65rem] uppercase tracking-[0.25em] text-muted-foreground font-mono">{`${t(currentItem().label)} ${t('MODULE')}`}</p>
                </div>
                <h1 class="text-5xl font-bold tracking-tight text-foreground">{t(currentItem().label)}</h1>
                <p class="mt-6 text-[0.95rem] text-muted-foreground max-w-2xl leading-relaxed font-mono">{t(pageDescription(location.pathname))}</p>
              </div>
              <div class="flex items-center gap-4 pb-1">
                <LocaleSwitch />
                <StatusBadge tone="normal">实时</StatusBadge>
                <div class="flex items-center gap-2">
                  <span class="size-1.5 rounded-full bg-primary animate-pulse" />
                  <span class="font-mono text-xs uppercase tracking-widest text-muted-foreground opacity-70">{t('已连接')}</span>
                </div>
                <Button
                type="button"
                variant="ghost"
                size="sm"
                class="font-mono text-xs uppercase tracking-widest border-border text-foreground hover:bg-muted"
                onClick={() => void props.data.onRefresh()}
                disabled={props.data.status() === 'loading'}
              >
                <RefreshCw class={`mr-2 size-3 ${props.data.status() === 'loading' ? 'animate-spin' : ''}`} />
                SYNC
              </Button>
              </div>
            </div>
            {props.children}
          </div>
        </main>
      </div>
    </div>
  );
}

function ConnectionGate(props: {
  settings: () => ConnectionSettings;
  status: () => LoadState;
  message: () => string;
  onApiBaseChange: (value: string) => void;
  onAdminTokenChange: (value: string) => void;
  onRefresh: (successMessage?: string) => Promise<void>;
}) {
  return (
    <div class="min-h-screen bg-background px-4 py-10 sm:px-6 lg:px-8">
      <div class="mx-auto flex max-w-xl flex-col gap-10 mt-12">
        <div class="flex justify-end">
          <LocaleSwitch />
        </div>
        <div class="flex flex-col gap-4 text-center items-center">
          <div class="flex size-12 items-center justify-center bg-foreground text-background">
            <SquareTerminal class="size-6" />
          </div>
          <div>
            <h1 class="text-4xl font-medium tracking-tight text-foreground mt-6">CODEX GATE</h1>
            <p class="mt-2 text-sm text-muted-foreground font-mono tracking-widest uppercase">{t('ADMIN CONSOLE INITIALIZATION')}</p>
          </div>
        </div>

        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <CardTitle class="text-xl font-medium tracking-tight">连接信息</CardTitle>
            <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">连接成功后进入控制台。</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              class="flex flex-col gap-6"
              onSubmit={(event) => {
                event.preventDefault();
                void props.onRefresh('连接信息已刷新。');
              }}
            >
              <div class="grid gap-6">
                <label class="flex flex-col gap-3">
                  <span class="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">{t('服务地址')}</span>
                  <Input
                    value={props.settings().apiBase}
                    onInput={(event) => props.onApiBaseChange(event.currentTarget.value)}
                    placeholder="http://127.0.0.1:8080"
                    class="rounded-none font-mono text-sm"
                  />
                </label>
                <label class="flex flex-col gap-3">
                  <span class="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">{t('管理员口令')}</span>
                  <Input
                    type="password"
                    value={props.settings().adminToken}
                    onInput={(event) => props.onAdminTokenChange(event.currentTarget.value)}
                    placeholder="输入管理员口令"
                    class="rounded-none font-mono text-sm"
                  />
                </label>
              </div>

              <Alert class="rounded-none border-border/40 bg-muted/20">
                <AlertTitle class="font-mono text-[0.65rem] uppercase tracking-widest">连接状态</AlertTitle>
                <AlertDescription class="font-mono text-xs mt-2 opacity-80">{props.message()}</AlertDescription>
              </Alert>

              <div class="flex flex-wrap gap-2 pt-2">
                <Button type="submit" disabled={props.status() === 'loading'} class="w-full sm:w-auto">
                  {props.status() === 'loading' ? t('CONNECTING...') : t('ENTER CONSOLE')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
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
      props.data.onMessage(error instanceof Error ? t('{{message}}；暂时显示当前数据。', { message: error.message }) : '读取总览失败。');
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
          hint: t('失败 {{count}}', { count: formatCompactInteger(live.kpis.failed) }),
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
      { label: '今日请求', value: formatCompactInteger(snapshot.totals.requestsToday), hint: t('累计 {{count}}', { count: formatCompactInteger(snapshot.totals.requests) }) },
      { label: '错误率', value: `${errorRate.toFixed(1)}%`, hint: t('失败 {{count}}', { count: formatCompactInteger(snapshot.totals.failed) }) },
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
          <div class="flex items-center gap-2">
            <div class="flex rounded-none border border-border bg-background p-1 mr-4">
              <Button
                type="button"
                size="sm"
                variant={period() === 'today' ? 'default' : 'ghost'}
                class="rounded-none h-7 px-3 text-[0.65rem] font-mono uppercase tracking-widest"
                onClick={() => {
                  setPeriod('today');
                  void loadOverview();
                }}
              >
                1D
              </Button>
              <Button
                type="button"
                size="sm"
                variant={period() === '7d' ? 'default' : 'ghost'}
                class="rounded-none h-7 px-3 text-[0.65rem] font-mono uppercase tracking-widest"
                onClick={() => {
                  setPeriod('7d');
                  void loadOverview();
                }}
              >
                7D
              </Button>
              <Button
                type="button"
                size="sm"
                variant={period() === '30d' ? 'default' : 'ghost'}
                class="rounded-none h-7 px-3 text-[0.65rem] font-mono uppercase tracking-widest"
                onClick={() => {
                  setPeriod('30d');
                  void loadOverview();
                }}
              >
                30D
              </Button>
            </div>
            <Button type="button" variant="outline" size="sm" class="rounded-none text-xs tracking-wider shrink-0" onClick={() => void copyText(props.data.settings().apiBase, '地址已复制。', props.data.onMessage)}>
              <Copy class="mr-2 size-3" />
              COPY URL
            </Button>
            <A href="/keys" class="shrink-0">
              <Button type="button" size="sm" class="rounded-none text-xs tracking-wider">CREATE KEY</Button>
            </A>
          </div>
        }
      />

      <StatsGrid items={metrics()} />

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <div class="flex items-center justify-between gap-3">
              <div>
                <CardTitle class="text-xl font-medium tracking-tight">服务状态</CardTitle>
                <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">先看整体，再决定是否进入日志或上游。</CardDescription>
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
          <CardContent class="grid gap-4 md:grid-cols-3">
            <div class="border-l-2 border-primary/20 pl-4 py-1">
              <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">上游健康</div>
              <div class="mt-2 text-2xl font-medium text-foreground tracking-tight">
                {overview()
                  ? t('{{count}} 正常', { count: overview()?.service_health.healthy ?? 0 })
                  : t('{{count}} 已启用', { count: props.data.providers().filter((item) => item.provider.enabled).length })}
              </div>
              <p class="mt-1 font-mono text-xs text-muted-foreground opacity-70">
                {overview()
                  ? t('{{warning}} 警告 · {{error}} 异常', {
                      warning: overview()?.service_health.warning ?? 0,
                      error: overview()?.service_health.error ?? 0,
                    })
                  : t('暂无实时数据')}
              </p>
            </div>
            <div class="border-l-2 border-primary/20 pl-4 py-1">
              <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">{t('最近 24h 错误')}</div>
              <div class="mt-2 text-2xl font-medium text-foreground tracking-tight">{formatCompactInteger(anomalies().length)}</div>
              <p class="mt-1 font-mono text-xs text-muted-foreground opacity-70">{t('点击右侧列表可直接进入日志详情。')}</p>
            </div>
            <div class="border-l-2 border-primary/20 pl-4 py-1">
              <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">{t('活跃密钥')}</div>
              <div class="mt-2 text-2xl font-medium text-foreground tracking-tight">{formatCompactInteger(props.data.apiKeys().filter((item) => item.apiKey.enabled).length)}</div>
              <p class="mt-1 font-mono text-xs text-muted-foreground opacity-70">{t('当前已启用的访问密钥。')}</p>
            </div>
            <div class="md:col-span-3 pt-2">
              <A href="/upstreams">
                <Button type="button" variant="ghost" class="w-full justify-start pl-0 hover:bg-transparent hover:text-primary shrink-0">
                  {`[ ${t('查看上游详情')} ]`}
                </Button>
              </A>
            </div>
          </CardContent>
        </Card>

        <QuickActions
          title="快速开始"
          items={[
            {
              title: '服务地址',
              description: props.data.settings().apiBase,
              action: (
                <Button type="button" size="sm" variant="ghost" class="font-mono text-xs hover:bg-transparent hover:text-primary px-0 shrink-0" onClick={() => void copyText(props.data.settings().apiBase, '地址已复制。', props.data.onMessage)}>
                  [ COPY ]
                </Button>
              ),
            },
            {
              title: '访问密钥',
              description: t('共 {{count}} 个 · 最近 {{last}}', {
                count: formatCompactInteger(props.data.apiKeys().length),
                last: latestKey() ? formatDateTime(latestKey()!.id) : t('暂无'),
              }),
              action: (
                <A href="/keys">
                  <Button type="button" size="sm" variant="ghost" class="font-mono text-xs hover:bg-transparent hover:text-primary px-0 shrink-0">
                    [ CREATE ]
                  </Button>
                </A>
              ),
            },
            {
              title: '接入示例',
              description: '提供 cURL、JavaScript 与 Python。',
              action: (
                <A href="/access">
                  <Button type="button" size="sm" variant="ghost" class="font-mono text-xs hover:bg-transparent hover:text-primary px-0 shrink-0">
                    [ OPEN ]
                  </Button>
                </A>
              ),
            },
          ]}
        />
      </div>

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <div class="flex items-center justify-between gap-3">
              <div>
                <CardTitle class="text-xl font-medium tracking-tight">最近异常</CardTitle>
                <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">最近 5 条异常请求。</CardDescription>
              </div>
              <A href="/logs" class="shrink-0">
                <Button type="button" size="sm" variant="ghost" class="font-mono text-xs hover:bg-transparent hover:text-primary px-0 shrink-0">
                  [ VIEW ALL LOGS ]
                </Button>
              </A>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow class="border-b border-border hover:bg-transparent">
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">时间</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">模型</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">状态</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">延迟</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">密钥</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Show
                  when={anomalies().length > 0}
                  fallback={
                    <TableRow class="hover:bg-transparent">
                      <TableCell colspan={5} class="text-center font-mono text-xs text-muted-foreground opacity-50 h-24">
                        {t('ALL SYSTEMS NOMINAL.')}
                      </TableCell>
                    </TableRow>
                  }
                >
                  <For each={anomalies()}>
                    {(row) => (
                      <TableRow class="border-b border-border/40 hover:bg-muted/30 transition-colors">
                        <TableCell class="font-mono text-xs">{formatDateTime(row.time_ms)}</TableCell>
                        <TableCell class="font-mono text-xs truncate max-w-[150px]" title={formatModelName(row.model)}>{formatModelName(row.model)}</TableCell>
                        <TableCell>
                          <StatusBadge tone={(row.http_status ?? 500) >= 500 ? 'error' : 'warning'}>{String(row.http_status ?? '—')}</StatusBadge>
                        </TableCell>
                        <TableCell class="font-mono text-xs">{formatMs(row.duration_ms ?? row.t_first_token_ms ?? row.t_first_byte_ms ?? 0)}</TableCell>
                        <TableCell class="font-mono text-xs text-muted-foreground">#{row.api_key_id}</TableCell>
                      </TableRow>
                    )}
                  </For>
                </Show>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <CardTitle class="text-xl font-medium tracking-tight">热门模型</CardTitle>
            <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">按请求量与成本排序。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-0">
            <Show
              when={topModels().length > 0}
              fallback={<EmptyState title="NO DATA" description="Awaiting telemetry." />}
            >
              <For each={topModels()}>
                {(item) => (
                  <div class="flex items-center justify-between gap-4 border-b border-border/40 py-4 last:border-0 last:pb-0 first:pt-0">
                    <div class="min-w-0">
                      <div class="truncate text-sm font-medium text-foreground">{item.key}</div>
                      <div class="mt-1 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">
                        {t('REQ / ERR {{rate}}', {
                          rate: item.requests > 0 ? `${((item.failed / item.requests) * 100).toFixed(1)}%` : '0%',
                        })}
                      </div>
                    </div>
                    <div class="text-xl font-medium tracking-tight text-foreground">{formatCost(parseDecimal(item.cost_total_usd))}</div>
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
          <div class="flex items-center gap-2">
            <A href="/keys">
              <Button type="button" size="sm" class="rounded-none text-xs tracking-wider">CREATE KEY</Button>
            </A>
          </div>
        }
      />

      <div class="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <CardTitle class="text-xl font-medium tracking-tight">连接信息</CardTitle>
            <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">接入只需要服务地址和访问密钥。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-6">
              <div class="border-l-2 border-primary/20 pl-4 py-1">
                <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">{t('服务地址')}</div>
                <code class="mt-2 block break-all text-sm font-mono text-foreground">{props.data.settings().apiBase}</code>
              </div>
              <div class="border-l-2 border-primary/20 pl-4 py-1">
                <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">{t('管理状态')}</div>
                <div class="mt-2 flex items-center gap-3">
                  <StatusBadge tone={props.data.settings().adminToken.trim() ? 'normal' : 'warning'}>
                    {props.data.settings().adminToken.trim() ? '已连接' : '未连接'}
                </StatusBadge>
                <span class="font-mono text-xs text-muted-foreground opacity-70">{props.data.message()}</span>
              </div>
            </div>
            <div class="flex flex-wrap gap-2 pt-2 border-t border-border/40">
              <Button type="button" variant="ghost" class="font-mono text-xs hover:bg-transparent hover:text-primary px-0 shrink-0" onClick={() => void copyText(props.data.settings().apiBase, '地址已复制。', props.data.onMessage)}>
                [ COPY URL ]
              </Button>
              <A href="/keys" class="shrink-0">
                <Button type="button" variant="ghost" class="font-mono text-xs hover:bg-transparent hover:text-primary px-0 ml-4 shrink-0">
                  [ CREATE KEY ]
                </Button>
              </A>
            </div>
            <Alert class="rounded-none border-border/40 bg-muted/20">
              <AlertTitle class="font-mono text-xs uppercase tracking-widest">常见错误</AlertTitle>
              <AlertDescription class="text-sm mt-2 opacity-80">先确认访问密钥已启用，再检查服务地址和模型名。</AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <div class="grid gap-6">
          <Card class="rounded-none border border-border bg-background shadow-none">
            <CardHeader>
              <CardTitle class="text-xl font-medium tracking-tight">最短接入方式</CardTitle>
              <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">复制即可测试。</CardDescription>
            </CardHeader>
            <CardContent class="grid gap-6 xl:grid-cols-3">
              <For each={[
                { title: 'cURL', value: curlSample() },
                { title: 'JavaScript', value: jsSample() },
                { title: 'Python', value: pySample() },
              ]}>
                {(item) => (
                  <div class="border border-border/40 bg-muted/10 p-5">
                    <div class="mb-4 flex items-center justify-between gap-2">
                      <strong class="font-mono text-xs uppercase tracking-widest text-foreground shrink-0">{item.title}</strong>
                      <Button type="button" size="sm" variant="ghost" class="font-mono text-[0.65rem] hover:bg-transparent hover:text-primary px-0 h-auto shrink-0" onClick={() => void copyText(item.value, `${item.title} 示例已复制。`, props.data.onMessage)}>
                        [ COPY ]
                      </Button>
                    </div>
                    <pre class="overflow-auto bg-transparent p-0 text-[0.7rem] leading-5 text-foreground font-mono opacity-80">{item.value}</pre>
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
          <div class="flex items-center gap-2">
            <div class="flex rounded-none border border-border bg-background p-1">
              <Button type="button" size="sm" variant={period() === 'today' ? 'default' : 'ghost'} class="rounded-none h-7 px-3 text-[0.65rem] font-mono uppercase tracking-widest" onClick={() => { setPeriod('today'); void loadUsage(); }}>
                1D
              </Button>
              <Button type="button" size="sm" variant={period() === '7d' ? 'default' : 'ghost'} class="rounded-none h-7 px-3 text-[0.65rem] font-mono uppercase tracking-widest" onClick={() => { setPeriod('7d'); void loadUsage(); }}>
                7D
              </Button>
              <Button type="button" size="sm" variant={period() === '30d' ? 'default' : 'ghost'} class="rounded-none h-7 px-3 text-[0.65rem] font-mono uppercase tracking-widest" onClick={() => { setPeriod('30d'); void loadUsage(); }}>
                30D
              </Button>
            </div>
          </div>
        }
      />

      <StatsGrid
        items={[
          { label: '总成本', value: formatCost(totalCost()), hint: t('窗口 {{window}}', { window: period() === 'today' ? t('今日') : period() === '7d' ? t('7 天') : t('30 天') }) },
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
        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
                <CardTitle class="text-xl font-medium tracking-tight">成本趋势</CardTitle>
                <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">粗略趋势预览，详细请以导出的统计为准。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-6">
            <div class="grid gap-4">
              <For each={props.data.snapshot().trend}>
                {(point) => (
                  <div class="grid grid-cols-[72px_minmax(0,1fr)_72px] items-center gap-4">
                    <span class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">{point.label}</span>
                    <div class="h-1.5 overflow-hidden bg-muted">
                      <div
                        class="h-full bg-primary"
                        style={{ width: `${(point.value / Math.max(...props.data.snapshot().trend.map((item) => item.value), 1)) * 100}%` }}
                      />
                    </div>
                    <span class="text-right font-mono text-xs text-foreground">{formatCompactInteger(point.value)}</span>
                  </div>
                )}
              </For>
            </div>
          </CardContent>
        </Card>

        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <CardTitle class="text-xl font-medium tracking-tight">异常提示</CardTitle>
            <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">只显示需要处理的提醒。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-4">
            <Alert variant={topConsumer() && parseDecimal(topConsumer()!.cost_total_usd) > totalCost() * 0.45 ? 'destructive' : 'default'} class="rounded-none border-border/40 bg-muted/20">
              <AlertTitle class="font-mono text-[0.65rem] uppercase tracking-widest">高消耗项</AlertTitle>
                <AlertDescription class="font-mono text-xs mt-2 opacity-80">
                  {topConsumer()
                    ? t('{{model}} 占用 {{percent}}% 成本。', {
                        model: topConsumer()!.key,
                        percent: ((parseDecimal(topConsumer()!.cost_total_usd) / Math.max(totalCost(), 0.01)) * 100).toFixed(1),
                      })
                    : t('暂无足够数据。')}
                </AlertDescription>
              </Alert>
            <Alert class="rounded-none border-border/40 bg-muted/20">
              <AlertTitle class="font-mono text-[0.65rem] uppercase tracking-widest">排查路径</AlertTitle>
              <AlertDescription class="font-mono text-xs mt-2 opacity-80">去日志页按模型和密钥筛选。</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>

      <div class="grid gap-6 xl:grid-cols-2">
        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <CardTitle class="text-xl font-medium tracking-tight">按模型</CardTitle>
            <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">查看模型消耗与错误情况。</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow class="border-b border-border hover:bg-transparent">
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">模型</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">请求</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">错误</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">用量</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">成本</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Show
                  when={modelRows().length > 0}
                  fallback={
                    <TableRow class="hover:bg-transparent">
                      <TableCell colspan={5} class="text-center font-mono text-xs text-muted-foreground opacity-50 h-24">
                        {t('NO USAGE DATA.')}
                      </TableCell>
                    </TableRow>
                  }
                >
                  <For each={modelRows()}>
                    {(row) => (
                      <TableRow class="border-b border-border/40 hover:bg-muted/30 transition-colors">
                        <TableCell class="font-mono text-xs truncate max-w-[150px]" title={row.key}>{row.key}</TableCell>
                        <TableCell class="font-mono text-xs">{formatCompactInteger(row.requests)}</TableCell>
                        <TableCell class="font-mono text-xs">{formatCompactInteger(row.failed)}</TableCell>
                        <TableCell class="font-mono text-xs">{formatCompactInteger(row.tokens)}</TableCell>
                        <TableCell class="font-mono text-xs">{formatCost(parseDecimal(row.cost_total_usd))}</TableCell>
                      </TableRow>
                    )}
                  </For>
                </Show>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <CardTitle class="text-xl font-medium tracking-tight">按密钥</CardTitle>
            <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">识别高消耗访问方。</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow class="border-b border-border hover:bg-transparent">
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">密钥</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">请求</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">错误</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">用量</TableHead>
                  <TableHead class="font-mono text-[0.65rem] uppercase tracking-widest h-10">成本</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Show
                  when={keyRows().length > 0}
                  fallback={
                    <TableRow class="hover:bg-transparent">
                      <TableCell colspan={5} class="text-center font-mono text-xs text-muted-foreground opacity-50 h-24">
                        {t('NO KEY USAGE DATA.')}
                      </TableCell>
                    </TableRow>
                  }
                >
                  <For each={keyRows()}>
                    {(row) => (
                      <TableRow class="border-b border-border/40 hover:bg-muted/30 transition-colors">
                        <TableCell class="font-mono text-xs truncate max-w-[150px]">#{row.key}</TableCell>
                        <TableCell class="font-mono text-xs">{formatCompactInteger(row.requests)}</TableCell>
                        <TableCell class="font-mono text-xs">{formatCompactInteger(row.failed)}</TableCell>
                        <TableCell class="font-mono text-xs">{formatCompactInteger(row.tokens)}</TableCell>
                        <TableCell class="font-mono text-xs">{formatCost(parseDecimal(row.cost_total_usd))}</TableCell>
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
      <div class="mt-4">
        <ProvidersPage
          settings={props.data.settings()}
          items={props.data.providers()}
          onRefresh={props.data.onRefresh}
          onMessage={props.data.onMessage}
        />
      </div>
    </div>
  );
}

function KeysRoutePage(props: { data: AppDataContext }) {
  return (
    <div class="mt-4">
      <ApiKeysPage
        settings={props.data.settings()}
        items={props.data.apiKeys()}
        onRefresh={props.data.onRefresh}
        onMessage={props.data.onMessage}
      />
    </div>
  );
}

function LogsRoutePage(props: { data: AppDataContext }) {
  return (
    <div class="mt-4">
      <LogsPage
        settings={props.data.settings()}
        providers={props.data.providers()}
        apiKeys={props.data.apiKeys()}
        refreshKey={props.data.refreshKey()}
        onMessage={props.data.onMessage}
      />
    </div>
  );
}

function SettingsRoutePage(props: { data: AppDataContext }) {
  return (
    <div class="mt-4">
      <SettingsPage
        settings={props.data.settings()}
        systemConfig={props.data.systemConfig()}
        prices={props.data.prices()}
        providers={props.data.providers()}
        onApiBaseChange={props.data.onApiBaseChange}
        onAdminTokenChange={props.data.onAdminTokenChange}
        onRefresh={props.data.onRefresh}
        onMessage={props.data.onMessage}
      />
    </div>
  );
}

function Root() {
  installLocaleEffect();
  const [settings, setSettings] = createSignal<ConnectionSettings>(readSettings());
  const [snapshot, setSnapshot] = createSignal<DashboardSnapshot>(createEmptyDashboardSnapshot());
  const [providers, setProviders] = createSignal<ProviderWorkspace[]>([]);
  const [apiKeys, setApiKeys] = createSignal<ApiKeyWorkspace[]>([]);
  const [prices, setPrices] = createSignal<ModelPrice[]>([]);
  const [systemConfig, setSystemConfig] = createSignal<SystemConfigResponse | null>(null);
  const [status, setStatus] = createSignal<LoadState>('idle');
  const [message, setMessage] = createSignal(t('未连接后台。'));
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [accessMode, setAccessMode] = createSignal<ConsoleAccessMode>(
    settings().adminToken.trim() ? 'console' : 'connect',
  );

  const refreshData = async (successMessage?: string) => {
    const current = settings();
    persistSettings(current);
    setStatus('loading');

    if (!current.adminToken.trim()) {
      setSnapshot(createEmptyDashboardSnapshot());
      setProviders([]);
      setApiKeys([]);
      setPrices([]);
      setSystemConfig(null);
      setMessage(t('请输入管理员口令。'));
      setAccessMode('connect');
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
      setMessage(successMessage ? t(successMessage) : t('已连接。'));
      setAccessMode('console');
    } catch (error) {
      console.error('Failed to load admin console data', error);
      setSnapshot(createEmptyDashboardSnapshot());
      setProviders([]);
      setApiKeys([]);
      setPrices([]);
      setSystemConfig(null);
      setMessage(error instanceof Error ? t('{{message}}；请检查服务地址和管理员口令。', { message: error.message }) : t('连接失败；请检查服务地址和管理员口令。'));
      setAccessMode('connect');
    } finally {
      setRefreshKey((value) => value + 1);
      setStatus('ready');
    }
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
    onMessage: (message) => setMessage(t(message)),
  };

  return (
    <Show
      when={accessMode() === 'console'}
      fallback={
        <ConnectionGate
          settings={settings}
          status={status}
          message={message}
          onApiBaseChange={(value) => setSettings((current) => ({ ...current, apiBase: value }))}
          onAdminTokenChange={(value) => setSettings((current) => ({ ...current, adminToken: value }))}
          onRefresh={refreshData}
        />
      }
    >
      <Router root={(props) => <TopShell data={data}>{props.children}</TopShell>}>
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
      </Router>
    </Show>
  );
}

export default Root;
