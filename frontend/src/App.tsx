import { For, Show, createEffect, createMemo, createSignal, on, onMount } from 'solid-js';
import { A, Navigate, Route, Router, useLocation } from '@solidjs/router';
import { Activity, Coins, Copy, KeyRound, ListFilter, RefreshCw, Server, Settings, SquareTerminal } from 'lucide-solid';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  loadPrices,
  loadModelAliases,
  loadProviderWorkspace,
  loadRuntimeSettings,
  loadStatsDaily,
  loadStatsOverview,
  loadSystemConfig,
  loadUsageBreakdown,
  previewRuntimeEnv,
} from '@/lib/api';
import { formatCompactInteger, formatCost, formatDateTime, formatModelName, formatMs, parseDecimal } from '@/lib/format';
import type {
  ApiKeyWorkspace,
  ConnectionSettings,
  ModelPrice,
  ModelAlias,
  ProviderWorkspace,
  RuntimeEnvPreviewResponse,
  RuntimeSettingsResponse,
  StatsDailyRow,
  StatsOverviewResponse,
  SystemConfigResponse,
  UsageBreakdownResponse,
} from '@/lib/types';

type LoadState = 'idle' | 'loading' | 'ready';
type ConsoleMode = 'connect' | 'console';

interface AppDataContext {
  settings: () => ConnectionSettings;
  providers: () => ProviderWorkspace[];
  modelAliases: () => ModelAlias[];
  apiKeys: () => ApiKeyWorkspace[];
  prices: () => ModelPrice[];
  systemConfig: () => SystemConfigResponse | null;
  runtimeSettings: () => RuntimeSettingsResponse | null;
  runtimeEnvPreview: () => RuntimeEnvPreviewResponse | null;
  status: () => LoadState;
  message: () => string;
  refreshKey: () => number;
  loadProviders: (successMessage?: string) => Promise<void>;
  loadModelAliases: (successMessage?: string) => Promise<void>;
  loadApiKeys: (successMessage?: string) => Promise<void>;
  loadPricesAndConfig: (successMessage?: string) => Promise<void>;
  onApiBaseChange: (value: string) => void;
  onAdminTokenChange: (value: string) => void;
  onRefresh: (successMessage?: string) => Promise<void>;
  onMessage: (message: string) => void;
}

const API_BASE_KEY = 'codex_gate_api_base';
const ADMIN_TOKEN_KEY = 'codex_gate_admin_token';

const NAV_ITEMS = [
  { to: '/overview', label: '总览', icon: Activity },
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
      <div class="app-shell">
        <aside class="app-sidebar">
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
          <div class="mt-16 flex flex-col gap-4 border-t border-border/40 px-3 pt-8">
            <div class="flex items-center justify-between">
              <span class="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">{t('SYSTEM STATUS')}</span>
              <span class="relative flex h-2 w-2">
                <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75"></span>
                <span class="relative inline-flex h-2 w-2 rounded-full bg-primary"></span>
              </span>
            </div>
            <p class="truncate font-mono text-xs text-muted-foreground">{props.data.message()}</p>
          </div>
        </aside>

        <main class="app-main">
          <div class="app-content">
            <div class="app-pagebar">
              <div class="min-w-0">
                <div class="mb-3 flex items-center gap-3">
                  <span class="size-1.5 rounded-full bg-primary" />
                  <p class="app-kicker">{`${t(currentItem().label)} ${t('MODULE')}`}</p>
                </div>
                <h1 class="app-title">{t(currentItem().label)}</h1>
                <p class="app-description">{t(pageDescription(location.pathname))}</p>
              </div>
              <div class="app-toolbar">
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
                  class="border-border text-foreground hover:bg-muted"
                  onClick={() => void props.data.onRefresh()}
                  disabled={props.data.status() === 'loading'}
                >
                  <RefreshCw class={`mr-2 size-3 ${props.data.status() === 'loading' ? 'animate-spin' : ''}`} />
                  {t('SYNC')}
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
  const live = () => overview();

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

  createEffect(
    on(
      () => props.data.refreshKey(),
      () => {
        void loadOverview();
      },
      { defer: true },
    ),
  );

  const metrics = createMemo<StatItem[]>(() => {
    const current = live();
    if (current) {
      return [
        {
          label: '今日请求',
          value: formatCompactInteger(current.kpis.requests),
          hint: t('失败 {{count}}', { count: formatCompactInteger(current.kpis.failed) }),
        },
        {
          label: '错误率',
          value: `${current.kpis.error_rate.toFixed(1)}%`,
          hint: current.kpis.error_rate > 5 ? '高于阈值' : '处于正常区间',
          tone: current.kpis.error_rate > 5 ? 'warning' : 'success',
        },
        {
          label: 'P95 延迟',
          value: formatMs(current.kpis.p95_latency_ms),
          hint: '最近 24 小时',
        },
        {
          label: '今日成本',
          value: formatCost(parseDecimal(current.kpis.cost_total_usd)),
          hint: '可切到成本页查看拆分',
        },
      ];
    }

    return [
      { label: '今日请求', value: '—', hint: '等待数据' },
      { label: '错误率', value: '—', hint: '等待数据' },
      { label: 'P95 延迟', value: '—', hint: '等待数据' },
      { label: '今日成本', value: '—', hint: '等待数据' },
    ];
  });

  const anomalies = createMemo(() => overview()?.recent_anomalies ?? []);
  const topModels = createMemo(() => overview()?.top_models ?? []);
  const tokenUsage = createMemo(() => overview()?.token_usage);
  const usageCoverage = createMemo(() => {
    const current = overview();
    if (!current || current.kpis.requests <= 0) return 0;
    return (current.token_usage.usage_observed_requests / current.kpis.requests) * 100;
  });
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
              {t('COPY URL')}
            </Button>
            <A href="/keys" class="shrink-0">
              <Button type="button" size="sm" class="rounded-none text-xs tracking-wider">{t('CREATE KEY')}</Button>
            </A>
          </div>
        }
      />

      <StatsGrid items={metrics()} />

      <Card class="rounded-none border border-border bg-background shadow-none">
        <CardHeader class="pb-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <CardTitle class="text-xl font-medium tracking-tight">Token 用量</CardTitle>
              <CardDescription class="font-mono text-xs uppercase tracking-wider mt-1">
                {overview()
                  ? t('覆盖 {{rate}}% 请求', { rate: usageCoverage().toFixed(1) })
                  : t('等待数据')}
              </CardDescription>
            </div>
            <StatusBadge tone={usageCoverage() >= 95 || !overview() ? 'normal' : usageCoverage() >= 50 ? 'warning' : 'error'}>
              {overview() ? `${usageCoverage().toFixed(1)}%` : '—'}
            </StatusBadge>
          </div>
        </CardHeader>
        <CardContent class="grid gap-4 border-t border-border/40 pt-5 md:grid-cols-4">
          <TokenStat label="总用量" value={tokenUsage()?.total_tokens ?? 0} />
          <TokenStat label="输入" value={tokenUsage()?.input_tokens ?? 0} />
          <TokenStat label="输出" value={tokenUsage()?.output_tokens ?? 0} hint={t('可见 {{count}}', { count: formatCompactInteger(tokenUsage()?.visible_output_tokens ?? 0) })} />
          <TokenStat
            label="缓存 / 思考"
            value={(tokenUsage()?.cache_read_input_tokens ?? 0) + (tokenUsage()?.cache_creation_input_tokens ?? 0) + (tokenUsage()?.reasoning_output_tokens ?? 0)}
            hint={t('读 {{read}} · 写 {{write}} · 思考 {{reasoning}}', {
              read: formatCompactInteger(tokenUsage()?.cache_read_input_tokens ?? 0),
              write: formatCompactInteger(tokenUsage()?.cache_creation_input_tokens ?? 0),
              reasoning: formatCompactInteger(tokenUsage()?.reasoning_output_tokens ?? 0),
            })}
          />
        </CardContent>
      </Card>

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <div class="flex items-center justify-between gap-3">
              <div>
                <CardTitle class="text-xl font-medium tracking-tight">服务状态</CardTitle>
                <CardDescription class="font-mono text-xs uppercase tracking-wider mt-1">{t('先看整体，再决定是否进入日志或上游。')}</CardDescription>
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
                  : t('等待数据')}
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
              <div class="mt-2 text-2xl font-medium text-foreground tracking-tight">
                {overview() ? formatCompactInteger(overview()?.service_health.upstream_keys_enabled ?? 0) : '—'}
              </div>
              <p class="mt-1 font-mono text-xs text-muted-foreground opacity-70">{t('当前可用的上游密钥。')}</p>
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
                  {t('[ COPY ]')}
                </Button>
              ),
            },
            {
              title: '访问密钥',
              description: props.data.apiKeys().length > 0
                ? t('共 {{count}} 个', { count: formatCompactInteger(props.data.apiKeys().length) })
                : t('打开密钥页查看。'),
              action: (
                <A href="/keys">
                  <Button type="button" size="sm" variant="ghost" class="font-mono text-xs hover:bg-transparent hover:text-primary px-0 shrink-0">
                    [ CREATE ]
                  </Button>
                </A>
              ),
            },
            {
              title: '请求日志',
              description: '查看最近请求与异常。',
              action: (
                <A href="/logs">
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
                <CardDescription class="font-mono text-xs uppercase tracking-wider mt-1">{t('最近 5 条异常请求。')}</CardDescription>
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
            <CardDescription class="font-mono text-xs uppercase tracking-wider mt-1">{t('按请求量与成本排序。')}</CardDescription>
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

function TokenStat(props: { label: string; value: number; hint?: string }) {
  return (
    <div class="border-l-2 border-primary/20 pl-4 py-1">
      <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">{t(props.label)}</div>
      <div class="mt-2 text-2xl font-medium text-foreground tracking-tight">{formatCompactInteger(props.value)}</div>
      <Show when={props.hint}>
        <p class="mt-1 font-mono text-xs text-muted-foreground opacity-70">{props.hint}</p>
      </Show>
    </div>
  );
}

function UsagePage(props: { data: AppDataContext }) {
  const [period, setPeriod] = createSignal<'today' | '7d' | '30d'>('today');
  const [breakdownByModel, setBreakdownByModel] = createSignal<UsageBreakdownResponse | null>(null);
  const [breakdownByKey, setBreakdownByKey] = createSignal<UsageBreakdownResponse | null>(null);
  const [dailyRows, setDailyRows] = createSignal<StatsDailyRow[]>([]);

  const periodDays = () => {
    switch (period()) {
      case 'today':
        return 1;
      case '7d':
        return 7;
      case '30d':
        return 30;
    }
  };

  const loadUsage = async () => {
    const current = props.data.settings();
    if (!current.adminToken.trim()) {
      setBreakdownByModel(null);
      setBreakdownByKey(null);
      setDailyRows([]);
      return;
    }
    try {
      const [modelRows, keyRows, daily] = await Promise.all([
        loadUsageBreakdown(current, { by: 'model', period: period(), limit: 8 }),
        loadUsageBreakdown(current, { by: 'api_key', period: period(), limit: 8 }),
        loadStatsDaily(current, periodDays()),
      ]);
      setBreakdownByModel(modelRows);
      setBreakdownByKey(keyRows);
      setDailyRows(daily);
    } catch (error) {
      props.data.onMessage(error instanceof Error ? error.message : '读取成本拆分失败。');
    }
  };

  onMount(() => {
    void loadUsage();
  });

  createEffect(
    on(
      () => props.data.refreshKey(),
      () => {
        void loadUsage();
      },
      { defer: true },
    ),
  );

  const modelRows = createMemo(() => breakdownByModel()?.rows ?? []);
  const keyRows = createMemo(() => breakdownByKey()?.rows ?? []);
  const totalCost = createMemo(() => modelRows().reduce((sum, row) => sum + parseDecimal(row.cost_total_usd), 0));
  const totalRequests = createMemo(() => modelRows().reduce((sum, row) => sum + row.requests, 0));
  const totalUsage = createMemo(() => dailyRows().reduce((sum, row) => sum + row.input_tokens + row.output_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens, 0));
  const reasoningUsage = createMemo(() => dailyRows().reduce((sum, row) => sum + row.reasoning_output_tokens, 0));
  const observedRequests = createMemo(() => dailyRows().reduce((sum, row) => sum + row.usage_observed_requests, 0));
  const usageCoverage = createMemo(() => {
    const requests = dailyRows().reduce((sum, row) => sum + row.request_success + row.request_failed, 0);
    if (requests <= 0) return 0;
    return (observedRequests() / requests) * 100;
  });
  const topConsumer = createMemo(() => modelRows()[0]);
  const trendRows = createMemo(() => (
    [...dailyRows()]
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((row) => ({
        label: `${row.date.slice(4, 6)}/${row.date.slice(6, 8)}`,
        value: row.request_success + row.request_failed,
      }))
  ));
  const maxTrendValue = createMemo(() => Math.max(...trendRows().map((item) => item.value), 1));

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
          { label: 'Token 用量', value: formatCompactInteger(totalUsage()), hint: t('覆盖 {{rate}}%', { rate: usageCoverage().toFixed(1) }) },
          {
            label: '思考用量',
            value: formatCompactInteger(reasoningUsage()),
            hint: topConsumer() ? t('最高 {{model}}', { model: topConsumer()!.key }) : '暂无数据',
          },
        ]}
      />

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
                <CardTitle class="text-xl font-medium tracking-tight">成本趋势</CardTitle>
                <CardDescription class="font-mono text-xs uppercase tracking-wider mt-1">{t('粗略趋势预览，详细请以导出的统计为准。')}</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-6">
            <Show
              when={trendRows().length > 0}
              fallback={<EmptyState title="NO USAGE DATA." description="暂无用量数据。" />}
            >
              <div class="grid gap-4">
                <For each={trendRows()}>
                  {(point) => (
                    <div class="grid grid-cols-[72px_minmax(0,1fr)_72px] items-center gap-4">
                      <span class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">{point.label}</span>
                      <div class="h-1.5 overflow-hidden bg-muted">
                        <div
                          class="h-full bg-primary"
                          style={{ width: `${(point.value / maxTrendValue()) * 100}%` }}
                        />
                      </div>
                      <span class="text-right font-mono text-xs text-foreground">{formatCompactInteger(point.value)}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </CardContent>
        </Card>

        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <CardTitle class="text-xl font-medium tracking-tight">异常提示</CardTitle>
            <CardDescription class="font-mono text-xs uppercase tracking-wider mt-1">{t('只显示需要处理的提醒。')}</CardDescription>
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
            <CardDescription class="font-mono text-xs uppercase tracking-wider mt-1">{t('查看模型消耗与错误情况。')}</CardDescription>
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
                        <TableCell class="font-mono text-xs"><UsageBreakdownCell row={row} /></TableCell>
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
            <CardDescription class="font-mono text-xs uppercase tracking-wider mt-1">{t('识别高消耗访问方。')}</CardDescription>
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
                        <TableCell class="font-mono text-xs"><UsageBreakdownCell row={row} /></TableCell>
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

function UsageBreakdownCell(props: { row: UsageBreakdownResponse['rows'][number] }) {
  return (
    <div class="min-w-[132px] font-mono leading-5">
      <div class="text-xs text-foreground">{formatCompactInteger(props.row.tokens)}</div>
      <div class="truncate text-[0.65rem] uppercase tracking-wider text-muted-foreground">
        {t('入 {{input}} · 出 {{output}}', {
          input: formatCompactInteger(props.row.input_tokens),
          output: formatCompactInteger(props.row.output_tokens),
        })}
      </div>
      <div class="truncate text-[0.65rem] uppercase tracking-wider text-muted-foreground">
        {t('缓存 {{cache}} · 思考 {{reasoning}}', {
          cache: formatCompactInteger(props.row.cache_read_input_tokens + props.row.cache_creation_input_tokens),
          reasoning: formatCompactInteger(props.row.reasoning_output_tokens),
        })}
      </div>
    </div>
  );
}

function UpstreamsPage(props: { data: AppDataContext }) {
  onMount(() => {
    if (props.data.providers().length === 0) {
      void props.data.loadProviders();
    }
    if (props.data.modelAliases().length === 0) {
      void props.data.loadModelAliases();
    }
  });

  return (
    <div class="section-stack">
      <PageHeader title="上游" description="查看连接目标与健康状态。" />
      <ProvidersPage
        settings={props.data.settings()}
        items={props.data.providers()}
        aliases={props.data.modelAliases()}
        onRefresh={async (successMessage?: string) => {
          await Promise.all([
            props.data.loadProviders(),
            props.data.loadModelAliases(successMessage),
          ]);
        }}
        onMessage={props.data.onMessage}
      />
    </div>
  );
}

function KeysRoutePage(props: { data: AppDataContext }) {
  onMount(() => {
    if (props.data.apiKeys().length === 0) {
      void props.data.loadApiKeys();
    }
  });

  return (
    <ApiKeysPage
      settings={props.data.settings()}
      items={props.data.apiKeys()}
      onRefresh={props.data.loadApiKeys}
      onMessage={props.data.onMessage}
    />
  );
}

function LogsRoutePage(props: { data: AppDataContext }) {
  onMount(() => {
    if (props.data.providers().length === 0) {
      void props.data.loadProviders();
    }
    if (props.data.apiKeys().length === 0) {
      void props.data.loadApiKeys();
    }
  });

  return (
    <LogsPage
      settings={props.data.settings()}
      providers={props.data.providers()}
      apiKeys={props.data.apiKeys()}
      refreshKey={props.data.refreshKey()}
      onMessage={props.data.onMessage}
    />
  );
}

function SettingsRoutePage(props: { data: AppDataContext }) {
  onMount(() => {
    void props.data.loadPricesAndConfig();
    if (props.data.providers().length === 0) {
      void props.data.loadProviders();
    }
  });

  return (
    <SettingsPage
      settings={props.data.settings()}
      systemConfig={props.data.systemConfig()}
      runtimeSettings={props.data.runtimeSettings()}
      runtimeEnvPreview={props.data.runtimeEnvPreview()}
      prices={props.data.prices()}
      providers={props.data.providers()}
      onApiBaseChange={props.data.onApiBaseChange}
      onAdminTokenChange={props.data.onAdminTokenChange}
      onRefresh={props.data.loadPricesAndConfig}
      onMessage={props.data.onMessage}
    />
  );
}

function Root() {
  installLocaleEffect();
  const [settings, setSettings] = createSignal<ConnectionSettings>(readSettings());
  const [providers, setProviders] = createSignal<ProviderWorkspace[]>([]);
  const [modelAliases, setModelAliases] = createSignal<ModelAlias[]>([]);
  const [apiKeys, setApiKeys] = createSignal<ApiKeyWorkspace[]>([]);
  const [prices, setPrices] = createSignal<ModelPrice[]>([]);
  const [systemConfig, setSystemConfig] = createSignal<SystemConfigResponse | null>(null);
  const [runtimeSettings, setRuntimeSettings] = createSignal<RuntimeSettingsResponse | null>(null);
  const [runtimeEnvPreview, setRuntimeEnvPreview] = createSignal<RuntimeEnvPreviewResponse | null>(null);
  const [status, setStatus] = createSignal<LoadState>('idle');
  const [message, setMessage] = createSignal(t('未连接后台。'));
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [consoleMode, setConsoleMode] = createSignal<ConsoleMode>(
    settings().adminToken.trim() ? 'console' : 'connect',
  );

  const clearWorkspace = () => {
    setProviders([]);
    setModelAliases([]);
    setApiKeys([]);
    setPrices([]);
    setSystemConfig(null);
    setRuntimeSettings(null);
    setRuntimeEnvPreview(null);
  };

  const loadProviders = async (successMessage?: string) => {
    const current = settings();
    if (!current.adminToken.trim()) {
      setProviders([]);
      return;
    }
    setStatus('loading');
    try {
      const providerWorkspace = await loadProviderWorkspace(current);
      setProviders(providerWorkspace);
      if (successMessage) setMessage(t(successMessage));
    } catch (error) {
      setProviders([]);
      setMessage(error instanceof Error ? error.message : '读取上游失败。');
    } finally {
      setStatus('ready');
    }
  };

  const loadModelAliasesForState = async (successMessage?: string) => {
    const current = settings();
    if (!current.adminToken.trim()) {
      setModelAliases([]);
      return;
    }
    setStatus('loading');
    try {
      const aliases = await loadModelAliases(current);
      setModelAliases(aliases);
      if (successMessage) setMessage(t(successMessage));
    } catch (error) {
      setModelAliases([]);
      setMessage(error instanceof Error ? error.message : '读取模型别名失败。');
    } finally {
      setStatus('ready');
    }
  };

  const loadApiKeys = async (successMessage?: string) => {
    const current = settings();
    if (!current.adminToken.trim()) {
      setApiKeys([]);
      return;
    }
    setStatus('loading');
    try {
      const apiKeyWorkspace = await loadApiKeyWorkspace(current);
      setApiKeys(apiKeyWorkspace);
      if (successMessage) setMessage(t(successMessage));
    } catch (error) {
      setApiKeys([]);
      setMessage(error instanceof Error ? error.message : '读取密钥失败。');
    } finally {
      setStatus('ready');
    }
  };

  const loadPricesAndConfig = async (successMessage?: string) => {
    const current = settings();
    if (!current.adminToken.trim()) {
      setPrices([]);
      setSystemConfig(null);
      setRuntimeSettings(null);
      setRuntimeEnvPreview(null);
      return;
    }
    setStatus('loading');
    try {
      const [priceItems, config, runtime, envPreview] = await Promise.all([
        loadPrices(current),
        loadSystemConfig(current).catch(() => null),
        loadRuntimeSettings(current).catch(() => null),
        previewRuntimeEnv(current).catch(() => null),
      ]);
      setPrices(priceItems);
      setSystemConfig(config);
      setRuntimeSettings(runtime);
      setRuntimeEnvPreview(envPreview);
      if (successMessage) setMessage(t(successMessage));
    } catch (error) {
      setPrices([]);
      setSystemConfig(null);
      setRuntimeSettings(null);
      setRuntimeEnvPreview(null);
      setMessage(error instanceof Error ? error.message : '读取设置失败。');
    } finally {
      setStatus('ready');
    }
  };

  const refreshData = async (successMessage?: string) => {
    const current = settings();
    persistSettings(current);
    setStatus('loading');

    if (!current.adminToken.trim()) {
      clearWorkspace();
      setMessage(t('请输入管理员口令。'));
      setConsoleMode('connect');
      setRefreshKey((value) => value + 1);
      setStatus('ready');
      return;
    }

    try {
      const config = await loadSystemConfig(current).catch(() => null);
      setSystemConfig(config);
      setRefreshKey((value) => value + 1);
      setMessage(successMessage ? t(successMessage) : t('已连接。'));
      setConsoleMode('console');
    } catch (error) {
      console.error('Failed to load admin console data', error);
      clearWorkspace();
      setMessage(error instanceof Error ? t('{{message}}；请检查服务地址和管理员口令。', { message: error.message }) : t('连接失败；请检查服务地址和管理员口令。'));
      setConsoleMode('connect');
    } finally {
      setStatus('ready');
    }
  };

  onMount(() => {
    void refreshData();
  });

  const data: AppDataContext = {
    settings,
    providers,
    modelAliases,
    apiKeys,
    prices,
    systemConfig,
    runtimeSettings,
    runtimeEnvPreview,
    status,
    message,
    refreshKey,
    loadProviders,
    loadModelAliases: loadModelAliasesForState,
    loadApiKeys,
    loadPricesAndConfig,
    onApiBaseChange: (value) => setSettings((current) => ({ ...current, apiBase: value })),
    onAdminTokenChange: (value) => setSettings((current) => ({ ...current, adminToken: value })),
    onRefresh: refreshData,
    onMessage: (message) => setMessage(t(message)),
  };

  return (
    <Show
      when={consoleMode() === 'console'}
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
