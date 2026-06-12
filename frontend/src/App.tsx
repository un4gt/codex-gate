import { For, Show, createEffect, createMemo, createSignal, on, onMount } from 'solid-js';
import { A, Navigate, Route, Router, useLocation } from '@solidjs/router';
import { Activity, Copy, GripVertical, KeyRound, ListFilter, LogOut, RefreshCw, Server, Settings, SquareTerminal } from 'lucide-solid';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid, type StatItem } from '@/components/console/StatsGrid';
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
  loadStatsOverview,
  loadSystemConfig,
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
  StatsOverviewResponse,
  StatsPeriod,
  SystemConfigResponse,
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
  onLogout: () => void;
  onMessage: (message: string) => void;
}

const API_BASE_KEY = 'codex_gate_api_base';
const ADMIN_TOKEN_KEY = 'codex_gate_admin_token';
const NAV_ORDER_KEY = 'codex_gate_nav_order';

const NAV_ITEMS_BY_KEY = {
  overview: { to: '/overview', label: '总览', icon: Activity },
  upstreams: { to: '/upstreams', label: '上游', icon: Server },
  logs: { to: '/logs', label: '日志', icon: ListFilter },
  keys: { to: '/keys', label: '密钥', icon: KeyRound },
  settings: { to: '/settings', label: '设置', icon: Settings },
} as const;

type NavKey = keyof typeof NAV_ITEMS_BY_KEY;

const DEFAULT_NAV_ORDER: NavKey[] = ['overview', 'upstreams', 'logs', 'keys', 'settings'];
const OVERVIEW_PERIODS: { value: StatsPeriod; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '7h', label: '最近7小时' },
  { value: '24h', label: '最近24小时' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
];

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

function isNavKey(value: string): value is NavKey {
  return value in NAV_ITEMS_BY_KEY;
}

function normalizeNavOrder(values: string[]): NavKey[] {
  const ordered: NavKey[] = [];
  for (const value of values) {
    if (isNavKey(value) && !ordered.includes(value)) {
      ordered.push(value);
    }
  }
  for (const value of DEFAULT_NAV_ORDER) {
    if (!ordered.includes(value)) {
      ordered.push(value);
    }
  }
  return ordered;
}

function readNavOrder(): NavKey[] {
  if (typeof window === 'undefined') return DEFAULT_NAV_ORDER;
  const raw = window.localStorage.getItem(NAV_ORDER_KEY);
  if (!raw) return DEFAULT_NAV_ORDER;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeNavOrder(parsed.filter((item): item is string => typeof item === 'string'));
    }
  } catch {
    return DEFAULT_NAV_ORDER;
  }
  return DEFAULT_NAV_ORDER;
}

function persistNavOrder(order: NavKey[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order));
}

function moveNavKey(order: NavKey[], from: NavKey, to: NavKey): NavKey[] {
  if (from === to) return order;
  const next = [...order];
  const fromIndex = next.indexOf(from);
  const toIndex = next.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return order;
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
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
  if (pathname.startsWith('/upstreams')) return '查看连接目标与健康状态。';
  if (pathname.startsWith('/settings')) return '维护连接信息与高级设置。';
  return '';
}

function TopShell(props: { data: AppDataContext; children: any }) {
  const location = useLocation();
  const [navOrder, setNavOrder] = createSignal<NavKey[]>(readNavOrder());
  const [draggingKey, setDraggingKey] = createSignal<NavKey | null>(null);
  const navItems = createMemo(() => navOrder().map((key) => ({ key, ...NAV_ITEMS_BY_KEY[key] })));
  const currentItem = createMemo(() => navItems().find((item) => location.pathname.startsWith(item.to)) ?? NAV_ITEMS_BY_KEY.overview);

  const reorderNav = (target: NavKey) => {
    const source = draggingKey();
    if (!source) return;
    const next = moveNavKey(navOrder(), source, target);
    setNavOrder(next);
    persistNavOrder(next);
    setDraggingKey(null);
  };

  return (
    <div class="min-h-screen bg-background">
      <div class="app-shell">
        <aside class="app-sidebar">
          <div class="flex items-center gap-3 px-2 pb-10">
            <div class="flex size-8 items-center justify-center bg-foreground text-background">
              <SquareTerminal class="size-4" />
            </div>
            <div class="min-w-0">
              <p class="text-[0.95rem] font-bold tracking-[0.08em] text-foreground uppercase">CODEX GATE</p>
            </div>
          </div>
          <nav class="flex flex-col gap-1" aria-label="Primary">
            <For each={navItems()}>
              {(item, index) => {
                const active = () => location.pathname.startsWith(item.to);
                const Icon = item.icon;
                return (
                  <div
                    class={`group relative flex items-center border-b border-border/40 ${
                      active() ? 'text-primary font-bold' : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => reorderNav(item.key)}
                  >
                    <A
                      href={item.to}
                      class="relative z-10 flex min-h-12 flex-1 items-center gap-3 px-3 py-3 text-sm font-medium transition-colors"
                    >
                      <Icon class="size-4 opacity-70" />
                      <span>{t(item.label)}</span>
                    </A>
                    <span class="relative z-10 font-mono text-[0.6rem] text-muted-foreground opacity-40">{String(index() + 1).padStart(2, '0')}</span>
                    <button
                      type="button"
                      class="relative z-10 ml-2 flex size-10 cursor-grab items-center justify-center text-muted-foreground opacity-60 transition-colors hover:text-foreground hover:opacity-100 active:cursor-grabbing"
                      aria-label={t('调整导航顺序')}
                      title={t('调整导航顺序')}
                      draggable
                      onDragStart={() => setDraggingKey(item.key)}
                      onDragEnd={() => setDraggingKey(null)}
                    >
                      <GripVertical class="size-4" />
                    </button>
                    {active() && (
                      <span class="absolute inset-y-0 left-0 w-1 bg-primary/20" />
                    )}
                  </div>
                );
              }}
            </For>
          </nav>
          <div class="mt-auto flex flex-col gap-3 border-t border-border/40 px-3 pt-7">
            <div class="flex items-center justify-between">
              <span class="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('SYSTEM STATUS')}</span>
              <span class="size-2 rounded-full bg-primary" />
            </div>
            <p class="truncate text-xs leading-5 text-muted-foreground">{props.data.message()}</p>
            <Button
              type="button"
              variant="ghost"
              class="mt-2 h-10 justify-start border border-border/60 px-3 text-muted-foreground hover:text-foreground"
              onClick={props.data.onLogout}
            >
              <LogOut class="size-4" />
              {t('退出')}
            </Button>
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
                  <span class="size-1.5 rounded-full bg-primary" />
                  <span class="text-xs font-medium text-muted-foreground opacity-80">{t('已连接')}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="border-border text-foreground hover:bg-muted"
                  onClick={() => void props.data.onRefresh()}
                  disabled={props.data.status() === 'loading'}
                >
                  <RefreshCw class="mr-2 size-3" />
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
            <p class="mt-2 text-sm font-medium text-muted-foreground tracking-[0.08em] uppercase">{t('ADMIN CONSOLE INITIALIZATION')}</p>
          </div>
        </div>

        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <CardTitle class="text-xl font-medium tracking-tight">连接信息</CardTitle>
            <CardDescription>连接成功后进入控制台。</CardDescription>
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
                  <span class="text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('服务地址')}</span>
                  <Input
                    value={props.settings().apiBase}
                    onInput={(event) => props.onApiBaseChange(event.currentTarget.value)}
                    placeholder="http://127.0.0.1:8080"
                    class="rounded-none font-mono text-sm"
                  />
                </label>
                <label class="flex flex-col gap-3">
                  <span class="text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('管理员口令')}</span>
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
                <AlertTitle class="text-sm font-semibold">连接状态</AlertTitle>
                <AlertDescription class="mt-2 text-sm opacity-80">{props.message()}</AlertDescription>
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
  const [period, setPeriod] = createSignal<StatsPeriod>('today');
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
    if (props.data.apiKeys().length === 0) {
      void props.data.loadApiKeys();
    }
  });

  createEffect(
    on(
      period,
      () => {
        void loadOverview();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.data.refreshKey(),
      () => {
        void loadOverview();
      },
      { defer: true },
    ),
  );

  const periodLabel = createMemo(() => OVERVIEW_PERIODS.find((item) => item.value === period())?.label ?? '今天');
  const tokenUsage = createMemo(() => overview()?.token_usage);
  const apiKeyCount = createMemo(() => props.data.apiKeys().length);
  const enabledApiKeyCount = createMemo(() => props.data.apiKeys().filter((item) => item.apiKey.enabled).length);
  const cacheTokens = createMemo(() => (tokenUsage()?.cache_read_input_tokens ?? 0) + (tokenUsage()?.cache_creation_input_tokens ?? 0));
  const cacheRate = createMemo(() => {
    const total = tokenUsage()?.total_tokens ?? 0;
    if (total <= 0) return 0;
    return (cacheTokens() / total) * 100;
  });
  const metrics = createMemo<StatItem[]>(() => {
    const current = live();
    if (current) {
      return [
        {
          label: 'API 密钥数量',
          value: formatCompactInteger(apiKeyCount()),
          hint: t('启用 {{count}}', { count: formatCompactInteger(enabledApiKeyCount()) }),
        },
        {
          label: '请求次数',
          value: formatCompactInteger(current.kpis.requests),
          hint: t('失败 {{count}}', { count: formatCompactInteger(current.kpis.failed) }),
          tone: current.kpis.error_rate > 5 ? 'warning' : 'success',
        },
        {
          label: '消费',
          value: formatCost(parseDecimal(current.kpis.cost_total_usd)),
          hint: t('当前窗口：{{window}}', { window: t(periodLabel()) }),
        },
        {
          label: 'Token',
          value: formatCompactInteger(current.token_usage.total_tokens),
          hint: t('输入 {{input}} · 输出 {{output}}', {
            input: formatCompactInteger(current.token_usage.input_tokens),
            output: formatCompactInteger(current.token_usage.output_tokens),
          }),
        },
        {
          label: '缓存率',
          value: `${cacheRate().toFixed(1)}%`,
          hint: t('读 {{read}} · 写 {{write}}', {
            read: formatCompactInteger(current.token_usage.cache_read_input_tokens),
            write: formatCompactInteger(current.token_usage.cache_creation_input_tokens),
          }),
          tone: cacheRate() > 0 ? 'success' : 'default',
        },
        {
          label: '平均响应',
          value: formatMs(current.kpis.avg_latency_ms),
          hint: t('P95 {{value}}', { value: formatMs(current.kpis.p95_latency_ms) }),
        },
      ];
    }

    return [
      { label: 'API 密钥数量', value: '—', hint: '等待数据' },
      { label: '请求次数', value: '—', hint: '等待数据' },
      { label: '消费', value: '—', hint: '等待数据' },
      { label: 'Token', value: '—', hint: '输入 — · 输出 —' },
      { label: '缓存率', value: '—', hint: '读 — · 写 —' },
      { label: '平均响应', value: '—', hint: '等待数据' },
    ];
  });

  const anomalies = createMemo(() => overview()?.recent_anomalies ?? []);
  const topModels = createMemo(() => overview()?.top_models ?? []);
  return (
    <div class="flex flex-col gap-6">
      <PageHeader
        title="总览"
        description="查看请求、Token 与响应表现。"
        actions={
          <div class="flex w-full flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div class="flex w-fit flex-wrap rounded-none border border-border bg-background p-1">
              <For each={OVERVIEW_PERIODS}>
                {(item) => (
                  <Button
                    type="button"
                    size="sm"
                    variant={period() === item.value ? 'default' : 'ghost'}
                    class="h-8 rounded-none px-3 text-[0.72rem]"
                    onClick={() => setPeriod(item.value)}
                  >
                    {t(item.label)}
                  </Button>
                )}
              </For>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" class="rounded-none shrink-0" onClick={() => void copyText(props.data.settings().apiBase, '地址已复制。', props.data.onMessage)}>
                <Copy class="mr-2 size-3" />
                {t('COPY URL')}
              </Button>
              <A href="/keys" class="shrink-0">
                <Button type="button" size="sm" class="rounded-none">{t('CREATE KEY')}</Button>
              </A>
            </div>
          </div>
        }
      />

      <StatsGrid items={metrics()} />

      <div class="grid gap-6 xl:grid-cols-12">
        <Card class="rounded-none border border-border bg-background shadow-none xl:col-span-7 2xl:col-span-8">
          <CardHeader>
            <div class="flex items-center justify-between gap-3">
              <div>
                <CardTitle>服务状态</CardTitle>
                <CardDescription>{t('先看整体，再决定是否进入日志或上游。')}</CardDescription>
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
              <div class="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">上游健康</div>
              <div class="mt-2 text-2xl font-medium text-foreground tracking-tight">
                {overview()
                  ? t('{{count}} 正常', { count: overview()?.service_health.healthy ?? 0 })
                  : t('等待数据')}
              </div>
              <p class="mt-1 text-xs leading-5 text-muted-foreground opacity-80">
                {overview()
                  ? t('{{warning}} 警告 · {{error}} 异常', {
                      warning: overview()?.service_health.warning ?? 0,
                      error: overview()?.service_health.error ?? 0,
                    })
                  : t('暂无实时数据')}
              </p>
            </div>
            <div class="border-l-2 border-primary/20 pl-4 py-1">
              <div class="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('最近 24h 错误')}</div>
              <div class="mt-2 text-2xl font-medium text-foreground tracking-tight">{formatCompactInteger(anomalies().length)}</div>
              <p class="mt-1 text-xs leading-5 text-muted-foreground opacity-80">{t('点击右侧列表可直接进入日志详情。')}</p>
            </div>
            <div class="border-l-2 border-primary/20 pl-4 py-1">
              <div class="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('活跃密钥')}</div>
              <div class="mt-2 text-2xl font-medium text-foreground tracking-tight">
                {overview() ? formatCompactInteger(overview()?.service_health.upstream_keys_enabled ?? 0) : '—'}
              </div>
              <p class="mt-1 text-xs leading-5 text-muted-foreground opacity-80">{t('当前可用的上游密钥。')}</p>
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

        <Card class="rounded-none border border-border bg-background shadow-none xl:col-span-5 2xl:col-span-4">
          <CardHeader>
            <CardTitle>热门模型</CardTitle>
            <CardDescription>{t('按请求量与成本排序。')}</CardDescription>
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
                      <div class="mt-1 font-mono text-[0.72rem] uppercase tracking-[0.08em] text-muted-foreground opacity-75">
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

      <div class="grid gap-6">
        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader>
            <div class="flex items-center justify-between gap-3">
              <div>
                <CardTitle>最近异常</CardTitle>
                <CardDescription>{t('最近 5 条异常请求。')}</CardDescription>
              </div>
              <A href="/logs" class="shrink-0">
                <Button type="button" size="sm" variant="ghost" class="text-xs hover:bg-transparent hover:text-primary px-0 shrink-0">
                  [ VIEW ALL LOGS ]
                </Button>
              </A>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                  <TableRow class="border-b border-border hover:bg-transparent">
                  <TableHead class="h-10">时间</TableHead>
                  <TableHead class="h-10">模型</TableHead>
                  <TableHead class="h-10">状态</TableHead>
                  <TableHead class="h-10">延迟</TableHead>
                  <TableHead class="h-10">密钥</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Show
                  when={anomalies().length > 0}
                  fallback={
                    <TableRow class="hover:bg-transparent">
                      <TableCell colspan={5} class="text-center text-sm text-muted-foreground opacity-70 h-24">
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

  const logout = () => {
    const nextSettings = { ...settings(), adminToken: '' };
    setSettings(nextSettings);
    persistSettings(nextSettings);
    clearWorkspace();
    setMessage(t('已退出。'));
    setConsoleMode('connect');
    setRefreshKey((value) => value + 1);
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
    onLogout: logout,
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
        <Route path="/upstreams" component={() => <UpstreamsPage data={data} />} />
        <Route path="/settings" component={() => <SettingsRoutePage data={data} />} />
        <Route path="/usage" component={() => <Navigate href="/overview" />} />
        <Route path="/prices" component={() => <Navigate href="/overview" />} />
        <Route path="*" component={() => <Navigate href="/overview" />} />
      </Router>
    </Show>
  );
}

export default Root;
