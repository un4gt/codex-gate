import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RestrictToVerticalAxis } from '@dnd-kit/abstract/modifiers';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, DragOverlay, type DragEndEvent } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { Activity, Bell, Boxes, Copy, Fingerprint, GripVertical, KeyRound, ListFilter, LogOut, RefreshCw, Server, Settings, SquareTerminal, type LucideIcon } from "lucide-react";
import { PageHeader } from '@/components/console/PageHeader';
import { StatsGrid, type StatItem } from '@/components/console/StatsGrid';
import { StatusBadge } from '@/components/console/StatusBadge';
import { LocaleSwitch } from '@/components/LocaleSwitch';
import { ApiKeysPage } from '@/components/ApiKeysPage';
import { LogsPage } from '@/components/LogsPage';
import { ModelsPage } from '@/components/ModelsPage';
import { NotificationsPage } from '@/components/NotificationsPage';
import { OAuthPage } from '@/components/OAuthPage';
import { ProvidersPage } from '@/components/ProvidersPage';
import { SettingsPage } from '@/components/SettingsPage';
import { t, useI18n } from '@/lib/i18n';
import { ApiRequestError, loadApiKeyWorkspace, loadPrices, loadModelAliases, loadProviderGroups, loadProviderWorkspace, loadRuntimeSettings, loadStatsOverview, loadSystemConfig, previewRuntimeEnv } from '@/lib/api';
import { formatBytes, formatCommitShort, formatCompactInteger, formatMs, formatVersionLabel } from '@/lib/format';
import { calculateOverviewPricing, formatUsd } from '@/lib/pricing';
import type { ApiKeyWorkspace, ConnectionSettings, ModelPrice, ModelAlias, ProviderGroup, ProviderWorkspace, RuntimeEnvPreviewResponse, RuntimeSettingsResponse, StatsOverviewResponse, StatsPeriod, SystemConfigResponse } from '@/lib/types';
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import InputBase from "@mui/material/InputBase";
import Typography from "@mui/material/Typography";
import useMediaQuery from '@mui/material/useMediaQuery';
type LoadState = 'idle' | 'loading' | 'ready';
type ConsoleMode = 'connect' | 'console';
type ConnectionIssue = 'apiBase' | 'adminToken' | 'general' | null;
interface ConnectionFailure {
  issue: Exclude<ConnectionIssue, null>;
  message: string;
}
interface AppDataContext {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  modelAliases: ModelAlias[];
  providerGroups: ProviderGroup[];
  apiKeys: ApiKeyWorkspace[];
  prices: ModelPrice[];
  systemConfig: SystemConfigResponse | null;
  runtimeSettings: RuntimeSettingsResponse | null;
  runtimeEnvPreview: RuntimeEnvPreviewResponse | null;
  status: LoadState;
  message: string;
  refreshKey: number;
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
const API_BASE_KEY = 'little_gate_api_base';
const ADMIN_TOKEN_KEY = 'little_gate_admin_token';
const NAV_ORDER_KEY = 'little_gate_nav_order';
const NAV_ITEMS_BY_KEY = {
  overview: {
    to: '/overview',
    label: '总览',
    icon: Activity
  },
  upstreams: {
    to: '/upstreams',
    label: '上游',
    icon: Server
  },
  oauth: {
    to: '/oauth',
    label: 'OAuth 登录',
    icon: Fingerprint
  },
  models: {
    to: '/models',
    label: '模型',
    icon: Boxes
  },
  logs: {
    to: '/logs',
    label: '日志',
    icon: ListFilter
  },
  keys: {
    to: '/keys',
    label: '密钥',
    icon: KeyRound
  },
  notifications: {
    to: '/notifications',
    label: '通知',
    icon: Bell
  },
  settings: {
    to: '/settings',
    label: '设置',
    icon: Settings
  }
} as const;
type NavKey = keyof typeof NAV_ITEMS_BY_KEY;
const DEFAULT_NAV_ORDER: NavKey[] = ['overview', 'upstreams', 'oauth', 'models', 'logs', 'keys', 'notifications', 'settings'];
const NAVIGATION_SORTABLE_TYPE = 'primary-navigation';
const NAVIGATION_SORT_INSTRUCTIONS_ID = 'primary-nav-sort-instructions';
const NAVIGATION_SORT_TRANSITION = {
  duration: 180,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  idle: true
};
const NAVIGATION_DROP_ANIMATION = {
  duration: 160,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
};
const NAVIGATION_DRAG_SENSORS = [PointerSensor.configure({
  activationConstraints(event) {
    if (event.pointerType === 'touch') {
      return [new PointerActivationConstraints.Delay({
        value: 180,
        tolerance: 8
      })];
    }
    return [new PointerActivationConstraints.Distance({
      value: 6
    })];
  }
}), KeyboardSensor.configure({
  keyboardCodes: {
    start: ['Space'],
    cancel: ['Escape'],
    end: ['Space', 'Enter', 'Tab'],
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    left: ['ArrowLeft'],
    right: ['ArrowRight']
  },
  offset: {
    x: 0,
    y: 52
  }
})];
const NAVIGATION_DRAG_MODIFIERS = [RestrictToVerticalAxis];
interface NavigationItemView {
  key: NavKey;
  to: string;
  label: string;
  icon: LucideIcon;
}
const OVERVIEW_PERIODS: {
  value: StatsPeriod;
  label: string;
}[] = [{
  value: 'today',
  label: '今天'
}, {
  value: '7h',
  label: '最近7小时'
}, {
  value: '24h',
  label: '最近24小时'
}, {
  value: 'week',
  label: '周'
}, {
  value: 'month',
  label: '月'
}];
function defaultApiBase() {
  if (typeof window === 'undefined') return 'http://127.0.0.1:18080';
  return window.location.origin;
}
function readSettings(): ConnectionSettings {
  if (typeof window === 'undefined') {
    return {
      apiBase: defaultApiBase(),
      adminToken: ''
    };
  }
  return {
    apiBase: window.localStorage.getItem(API_BASE_KEY) ?? defaultApiBase(),
    adminToken: window.sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? ''
  };
}
function persistSettings(settings: ConnectionSettings) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(API_BASE_KEY, settings.apiBase);
  window.sessionStorage.setItem(ADMIN_TOKEN_KEY, settings.adminToken);
}
function describeConnectionFailure(error: unknown): ConnectionFailure {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) {
      return {
        issue: 'adminToken',
        message: t('管理员口令不正确，请重新输入。')
      };
    }
    if (error.status === 404) {
      return {
        issue: 'apiBase',
        message: t('未找到管理接口，请检查服务地址。')
      };
    }
    if (error.status >= 500) {
      return {
        issue: 'general',
        message: t('服务暂时不可用，请稍后重试。')
      };
    }
  }
  if (error instanceof TypeError) {
    return {
      issue: 'apiBase',
      message: t('无法连接服务，请检查服务地址和网络后重试。')
    };
  }
  return {
    issue: 'general',
    message: t('登录失败，请检查服务地址后重试。')
  };
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
  if (!ordered.includes('models')) {
    const upstreamIndex = ordered.indexOf('upstreams');
    const logsIndex = ordered.indexOf('logs');
    const insertAt = upstreamIndex >= 0 ? upstreamIndex + 1 : logsIndex >= 0 ? logsIndex : ordered.length;
    ordered.splice(insertAt, 0, 'models');
  }
  if (!ordered.includes('oauth')) {
    const upstreamIndex = ordered.indexOf('upstreams');
    const modelsIndex = ordered.indexOf('models');
    const insertAt = upstreamIndex >= 0 ? upstreamIndex + 1 : modelsIndex >= 0 ? modelsIndex : ordered.length;
    ordered.splice(insertAt, 0, 'oauth');
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
function moveNavKey(order: NavKey[], from: NavKey, toIndex: number): NavKey[] {
  const next = [...order];
  const fromIndex = next.indexOf(from);
  const boundedIndex = Math.max(0, Math.min(toIndex, next.length - 1));
  if (fromIndex < 0 || fromIndex === boundedIndex) return order;
  const [item] = next.splice(fromIndex, 1);
  next.splice(boundedIndex, 0, item);
  return next;
}
function NavigationItemContent(props: {
  item: NavigationItemView;
  index: number;
  active: boolean;
  overlay?: boolean;
}) {
  const Icon = props.item.icon;
  return <>
      {props.active ? <Box className="absolute inset-y-2 left-0 w-0.5 bg-primary" aria-hidden="true" component="span" /> : null}
      <Box className={`relative z-10 flex size-8 shrink-0 items-center justify-center ${props.active || props.overlay ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`} aria-hidden="true" component="span">
        <Icon className="size-4" />
      </Box>
      <Box className="relative z-10 min-w-0 flex-1 truncate" component="span">{t(props.item.label)}</Box>
      <Box className="relative z-10 font-mono text-[0.6rem] text-muted-foreground opacity-45" aria-hidden="true" component="span">{String(props.index + 1).padStart(2, '0')}</Box>
      <Box className={`relative z-10 flex size-8 shrink-0 items-center justify-center transition-[color,opacity] duration-150 motion-reduce:transition-none ${props.overlay ? 'text-primary opacity-100' : 'text-muted-foreground opacity-45 group-hover:opacity-90'}`} aria-hidden="true" component="span">
        <GripVertical className="size-4" />
      </Box>
    </>;
}
function SortableNavigationItem(props: {
  item: NavigationItemView;
  index: number;
  active: boolean;
  reducedMotion: boolean;
}) {
  const { ref, isDragSource, isDropTarget, isDropping } = useSortable({
    id: props.item.key,
    index: props.index,
    group: NAVIGATION_SORTABLE_TYPE,
    type: NAVIGATION_SORTABLE_TYPE,
    accept: NAVIGATION_SORTABLE_TYPE,
    transition: props.reducedMotion ? null : NAVIGATION_SORT_TRANSITION
  });
  const stateClass = isDragSource ? 'border-primary/45 bg-primary/10 text-primary opacity-[0.32]' : isDropTarget ? 'border-primary/45 bg-primary/10 text-primary' : props.active ? 'border-primary/20 bg-primary/[0.06] font-semibold text-primary' : 'border-transparent border-b-border/40 text-muted-foreground hover:border-border/70 hover:bg-muted/35 hover:text-foreground';
  return <Box ref={ref} component={Link} to={props.item.to} aria-current={props.active ? 'page' : undefined} aria-describedby={NAVIGATION_SORT_INSTRUCTIONS_ID} aria-keyshortcuts="Space ArrowUp ArrowDown" className={`nav-sortable-item group relative flex min-h-[3.25rem] w-full cursor-grab select-none items-center gap-2 border px-2 py-2 text-sm font-medium outline-none transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out active:cursor-grabbing motion-reduce:transition-none ${stateClass} ${isDropping ? 'pointer-events-none' : ''}`} data-nav-key={props.item.key} data-nav-sortable="true" data-nav-dragging={isDragSource ? 'true' : undefined} data-nav-drop-target={isDropTarget ? 'true' : undefined} sx={{
    WebkitTapHighlightColor: 'transparent',
    '&:focus-visible': {
      outline: '2px solid var(--primary)',
      outlineOffset: '-2px'
    }
  }}>
      <NavigationItemContent item={props.item} index={props.index} active={props.active} />
    </Box>;
}
function NavigationDragPreview(props: {
  item: NavigationItemView;
  index: number;
  active: boolean;
}) {
  return <Box className="flex min-h-[3.25rem] w-full items-center gap-2 border border-primary/50 bg-popover px-2 py-2 text-sm font-semibold text-primary" aria-hidden="true" sx={{
    boxShadow: '0 18px 38px -24px rgb(0 0 0 / 0.42), 0 8px 18px -14px rgb(0 0 0 / 0.28)',
    transform: 'scale(1.015)'
  }}>
      <NavigationItemContent item={props.item} index={props.index} active={props.active} overlay />
    </Box>;
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
  if (pathname.startsWith('/overview')) return '查看请求、用量与响应表现。';
  if (pathname.startsWith('/keys')) return '创建和管理访问密钥。';
  if (pathname.startsWith('/logs')) return '筛选并排查最近请求。';
  if (pathname.startsWith('/models')) return '管理模型库存、别名与协议能力。';
  if (pathname.startsWith('/upstreams')) return '查看连接目标与健康状态。';
  if (pathname.startsWith('/oauth')) return '登录并管理 OpenAI Codex OAuth 账号。';
  if (pathname.startsWith('/notifications')) return '配置定时报表、阈值告警与投递通道。';
  if (pathname.startsWith('/settings')) return '维护连接信息与高级设置。';
  return '';
}
function formatUsagePercent(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return t('采样中');
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}
function formatCpuCapacity(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return t('CPU 采样中');
  return t('{{count}} 核可用', {
    count: value.toFixed(value < 10 ? 1 : 0)
  });
}
function formatServerScope(scope: string | null | undefined, limited: boolean | undefined) {
  if (scope === 'container') return limited ? t('容器限额') : t('容器采样');
  if (scope === 'cgroup') return limited ? t('进程限额') : t('进程采样');
  return t('主机采样');
}
function formatServerMemory(status: StatsOverviewResponse['server_status'] | undefined) {
  if (typeof status?.memory_used_bytes !== 'number' || typeof status.memory_total_bytes !== 'number') return t('等待数据');
  return `${formatBytes(status.memory_used_bytes)} / ${formatBytes(status.memory_total_bytes)}`;
}
function TopShell(props: {
  data: AppDataContext;
  children: ReactNode;
}) {
  const location = useLocation();
  const [navOrder, setNavOrder] = useState<NavKey[]>(readNavOrder());
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', {
    noSsr: true
  });
  const navItems = useMemo<NavigationItemView[]>(() => navOrder.map(key => ({
    key,
    ...NAV_ITEMS_BY_KEY[key]
  })), [navOrder]);
  const currentItem = navItems.find(item => location.pathname.startsWith(item.to)) ?? NAV_ITEMS_BY_KEY.overview;
  const serviceVersion = formatVersionLabel(props.data.systemConfig?.build?.version);
  const serviceCommit = formatCommitShort(props.data.systemConfig?.build?.commit);
  const serviceCommitTitle = (() => {
    const commit = props.data.systemConfig?.build?.commit?.trim();
    return commit && commit !== 'unknown' ? commit : undefined;
  })();
  const reorderNav = useCallback((event: DragEndEvent) => {
    if (event.canceled) return;
    const source = event.operation.source;
    if (!isSortable(source)) return;
    const sourceKey = String(source.id);
    if (!isNavKey(sourceKey)) return;
    const targetIndex = source.index;
    if (source.initialIndex === targetIndex) return;
    setNavOrder(current => {
      const next = moveNavKey(current, sourceKey, targetIndex);
      if (next === current) return current;
      persistNavOrder(next);
      return next;
    });
  }, []);
  return <Box className="min-h-screen bg-background">
      <Box className="app-shell">
        <Box className="app-sidebar" component="aside">
          <Box className="flex items-center gap-3 px-2 pb-10">
            <Box className="flex size-8 items-center justify-center bg-foreground text-background">
              <SquareTerminal className="size-4" />
            </Box>
            <Box className="min-w-0">
              <Box className="text-[0.95rem] font-bold tracking-[0.08em] text-foreground uppercase" component="p">LITTLE GATE</Box>
            </Box>
          </Box>
          <DragDropProvider sensors={NAVIGATION_DRAG_SENSORS} modifiers={NAVIGATION_DRAG_MODIFIERS} onDragEnd={reorderNav}>
            <Box className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1" aria-label="Primary" component="nav">
              <Box id={NAVIGATION_SORT_INSTRUCTIONS_ID} className="sr-only">
                {t('拖动任意导航项可调整顺序。键盘操作：按空格开始，使用上下方向键移动，再按空格完成。')}
              </Box>
              {navItems.map((item, index) => <SortableNavigationItem key={item.key} item={item} index={index} active={location.pathname.startsWith(item.to)} reducedMotion={reducedMotion} />)}
            </Box>
            <DragOverlay className="pointer-events-none z-[120]" dropAnimation={reducedMotion ? null : NAVIGATION_DROP_ANIMATION}>
              {source => {
              const key = String(source.id);
              if (!isNavKey(key)) return null;
              const item = navItems.find(candidate => candidate.key === key);
              if (!item) return null;
              return <NavigationDragPreview item={item} index={navOrder.indexOf(key)} active={location.pathname.startsWith(item.to)} />;
            }}
            </DragOverlay>
          </DragDropProvider>
          <Box className="mt-auto flex flex-col gap-3 border-t border-border/40 px-3 pt-7">
            <Box className="flex items-center justify-between">
              <Box className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground" component="span">{t('SYSTEM STATUS')}</Box>
              <Box className="size-2 rounded-full bg-primary" component="span" />
            </Box>
            <Box className="truncate text-xs leading-5 text-muted-foreground" component="p">{props.data.message}</Box>
            <Box className="flex items-center justify-between gap-3 border border-border/50 px-3 py-2">
              <Box className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground" component="span">{t('版本')}</Box>
              <Box className="truncate font-mono text-xs text-foreground" title={serviceCommitTitle} component="span">
                {serviceVersion}
                {serviceCommit !== '—' ? <Box className="ml-2 text-muted-foreground" component="span">{serviceCommit}</Box> : null}
              </Box>
            </Box>
            <Button type="button" variant="ghost" className="mt-2 h-10 justify-start border border-border/60 px-3 text-muted-foreground hover:text-foreground" onClick={props.data.onLogout}>
              <LogOut className="size-4" />
              {t('退出')}
            </Button>
          </Box>
        </Box>

        <Box className="app-main" component="main">
          <Box className="app-content">
            <Box className="app-pagebar">
              <Box className="min-w-0">
                <Box className="mb-3 flex items-center gap-3">
                  <Box className="size-1.5 rounded-full bg-primary" component="span" />
                  <Box className="app-kicker" component="p">{`${t(currentItem.label)} ${t('MODULE')}`}</Box>
                </Box>
                <Box className="app-title" component="h1">{t(currentItem.label)}</Box>
                <Box className="app-description" component="p">{t(pageDescription(location.pathname))}</Box>
              </Box>
              <Box className="app-toolbar">
                <LocaleSwitch />
                <StatusBadge tone="normal">实时</StatusBadge>
                <Box className="flex items-center gap-2">
                  <Box className="size-1.5 rounded-full bg-primary" component="span" />
                  <Box className="text-xs font-medium text-muted-foreground opacity-80" component="span">{t('已连接')}</Box>
                </Box>
                <Button type="button" variant="ghost" size="sm" className="border-border text-foreground hover:bg-muted" onClick={() => void props.data.onRefresh()} disabled={props.data.status === 'loading'}>
                  <RefreshCw className="mr-2 size-3" />
                  {t('SYNC')}
                </Button>
              </Box>
            </Box>
            {props.children}
          </Box>
        </Box>
      </Box>
    </Box>;
}
function ConnectionGate(props: {
  settings: ConnectionSettings;
  status: LoadState;
  message: string;
  issue: ConnectionIssue;
  onApiBaseChange: (value: string) => void;
  onAdminTokenChange: (value: string) => void;
  onRefresh: (successMessage?: string) => Promise<void>;
}) {
  const apiBaseInputRef = useRef<HTMLInputElement>(null);
  const adminTokenInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.issue === 'apiBase') apiBaseInputRef.current?.focus();
    if (props.issue === 'adminToken') adminTokenInputRef.current?.focus();
  }, [props.issue]);
  return <Box className="min-h-screen bg-background px-4 py-10 sm:px-6 lg:px-8">
      <Box className="mx-auto flex max-w-xl flex-col gap-10 mt-12">
        <Box className="flex justify-end">
          <LocaleSwitch />
        </Box>
        <Box className="flex flex-col gap-4 text-center items-center">
          <Box className="flex size-12 items-center justify-center bg-foreground text-background">
            <SquareTerminal className="size-6" />
          </Box>
          <Box>
            <Box className="text-4xl font-medium tracking-tight text-foreground mt-6" component="h1">LITTLE GATE</Box>
            <Box className="mt-2 text-sm font-medium text-muted-foreground tracking-[0.08em] uppercase" component="p">{t('ADMIN CONSOLE INITIALIZATION')}</Box>
          </Box>
        </Box>

        <Card className="rounded-none border border-border bg-background shadow-none">
          <Box className="flex flex-col gap-3 p-6 pb-5">
            <Typography className="text-xl font-medium tracking-tight text-foreground" component="div">{t("登录控制台")}</Typography>
            <Typography className="mt-1 text-sm leading-5 text-muted-foreground" component="div">{t("输入管理员口令以验证身份。")}</Typography>
          </Box>
          <CardContent>
            <Box className="flex flex-col gap-6" aria-busy={props.status === 'loading'} onSubmit={event => {
            event.preventDefault();
            void props.onRefresh();
          }} component="form">
              <Box className="grid gap-6">
                <Box className="flex flex-col gap-3" component="label">
                  <Box className="text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground" component="span">{t('服务地址')}</Box>
                  <InputBase
                    value={props.settings.apiBase}
                    error={props.issue === 'apiBase'}
                    inputRef={apiBaseInputRef}
                    inputProps={{
                      'aria-describedby': 'connection-status-message',
                      'aria-invalid': props.issue === 'apiBase'
                    }}
                    autoComplete="url"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={event => props.onApiBaseChange(event.target.value)}
                    placeholder={t("http://127.0.0.1:8080")}
                    className="rounded-none font-mono text-sm"
                  />
                </Box>
                <Box className="flex flex-col gap-3" component="label">
                  <Box className="text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground" component="span">{t('管理员口令')}</Box>
                  <InputBase
                    type="password"
                    value={props.settings.adminToken}
                    error={props.issue === 'adminToken'}
                    inputRef={adminTokenInputRef}
                    inputProps={{
                      'aria-describedby': 'connection-status-message',
                      'aria-invalid': props.issue === 'adminToken'
                    }}
                    autoComplete="current-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={event => props.onAdminTokenChange(event.target.value)}
                    placeholder={t("输入管理员口令")}
                    className="rounded-none font-mono text-sm"
                  />
                </Box>
              </Box>

              <Alert
                severity={props.issue ? 'error' : 'info'}
                role={props.issue ? 'alert' : 'status'}
                className="rounded-none border-border/40 bg-muted/20"
                sx={props.issue ? {
                  backgroundColor: 'color-mix(in oklab, var(--destructive) 5%, transparent)',
                  borderColor: 'color-mix(in oklab, var(--destructive) 45%, var(--border))',
                  '& .MuiAlertTitle-root': {
                    color: 'var(--destructive)'
                  }
                } : undefined}
              >
                <AlertTitle className="text-sm font-semibold">{t(props.issue ? '登录失败' : '登录状态')}</AlertTitle>
                <Typography id="connection-status-message" className="mt-2 text-sm leading-5 text-muted-foreground opacity-80" component="div">{props.message}</Typography>
              </Alert>

              <Box className="flex flex-wrap gap-2 pt-2">
                <Button type="submit" disabled={props.status === 'loading'} className="w-full sm:w-auto">
                  {props.status === 'loading' ? t('CONNECTING...') : t('ENTER CONSOLE')}
                </Button>
              </Box>
            </Box>
          </CardContent>
        </Card>
      </Box>
    </Box>;
}
function OverviewPage(props: {
  data: AppDataContext;
}) {
  const [overview, setOverview] = useState<StatsOverviewResponse | null>(null);
  const [period, setPeriod] = useState<StatsPeriod>('today');
  const live = () => overview;
  const loadOverview = useCallback(async () => {
    const current = props.data.settings;
    if (!current.adminToken.trim()) {
      setOverview(null);
      return;
    }
    try {
      const data = await loadStatsOverview(current, period);
      setOverview(data);
    } catch (error) {
      props.data.onMessage(error instanceof Error ? t('{{message}}；暂时显示当前数据。', {
        message: error.message
      }) : '读取总览失败。');
      setOverview(null);
    }
  }, [period, props.data.onMessage, props.data.settings]);
  useEffect(() => {
    void loadOverview();
  }, [loadOverview, props.data.refreshKey]);
  useEffect(() => {
    if (props.data.apiKeys.length === 0) {
      void props.data.loadApiKeys();
    }
  }, [props.data.apiKeys.length, props.data.loadApiKeys]);
  const periodLabel = () => OVERVIEW_PERIODS.find(item => item.value === period)?.label ?? '今天';
  const tokenUsage = () => overview?.token_usage;
  const serverStatus = () => overview?.server_status;
  const apiKeyCount = () => props.data.apiKeys.length;
  const enabledApiKeyCount = () => props.data.apiKeys.filter(item => item.apiKey.enabled).length;
  const cacheTokens = () => (tokenUsage()?.cache_read_input_tokens ?? 0) + (tokenUsage()?.cache_creation_input_tokens ?? 0);
  const cacheRate = () => {
    const total = tokenUsage()?.total_tokens ?? 0;
    if (total <= 0) return 0;
    return cacheTokens() / total * 100;
  };
  const overviewPricing = () => {
    const current = overview;
    return current ? calculateOverviewPricing(current) : null;
  };
  const metrics = (): StatItem[] => {
    const current = live();
    if (current) {
      return [{
        label: '访问密钥',
        value: formatCompactInteger(apiKeyCount()),
        hint: t('启用 {{count}}', {
          count: formatCompactInteger(enabledApiKeyCount())
        })
      }, {
        label: '请求次数',
        value: formatCompactInteger(current.kpis.requests),
        hint: t('失败 {{count}}', {
          count: formatCompactInteger(current.kpis.failed)
        }),
        tone: current.kpis.error_rate > 5 ? 'warning' : 'success'
      }, {
        label: '消费',
        value: overviewPricing() && overviewPricing()!.priceableRequests > 0 ? formatUsd(overviewPricing()!.totalUsd) : '—',
        hint: overviewPricing() ? t('已计价 {{priced}} · 未定价 {{unpriced}} · 缺用量 {{missing}} · token 覆盖 {{coverage}}%', {
          priced: formatCompactInteger(overviewPricing()!.priceableRequests),
          unpriced: formatCompactInteger(overviewPricing()!.unpricedRequests),
          missing: formatCompactInteger(overviewPricing()!.usageMissingRequests),
          coverage: overviewPricing()!.tokenCoveragePercent.toDecimalPlaces(1).toFixed(1)
        }) : t('当前窗口：{{window}}', {
          window: t(periodLabel())
        }),
        tone: overviewPricing() && (overviewPricing()!.unpricedRequests > 0 || overviewPricing()!.usageMissingRequests > 0) ? 'warning' : 'success'
      }, {
        label: '用量',
        value: formatCompactInteger(current.token_usage.total_tokens),
        hint: t('输入 {{input}} · 输出 {{output}}', {
          input: formatCompactInteger(current.token_usage.input_tokens),
          output: formatCompactInteger(current.token_usage.output_tokens)
        })
      }, {
        label: '缓存率',
        value: `${cacheRate().toFixed(1)}%`,
        hint: t('读 {{read}} · 写 {{write}}', {
          read: formatCompactInteger(current.token_usage.cache_read_input_tokens),
          write: formatCompactInteger(current.token_usage.cache_creation_input_tokens)
        }),
        tone: cacheRate() > 0 ? 'success' : 'default'
      }, {
        label: '平均响应',
        value: formatMs(current.kpis.avg_latency_ms),
        hint: t('P95 {{value}}', {
          value: formatMs(current.kpis.p95_latency_ms)
        })
      }];
    }
    return [{
      label: '访问密钥',
      value: '—',
      hint: '等待数据'
    }, {
      label: '请求次数',
      value: '—',
      hint: '等待数据'
    }, {
      label: '消费',
      value: '—',
      hint: '等待数据'
    }, {
      label: '用量',
      value: '—',
      hint: '输入 — · 输出 —'
    }, {
      label: '缓存率',
      value: '—',
      hint: '读 — · 写 —'
    }, {
      label: '平均响应',
      value: '—',
      hint: '等待数据'
    }];
  };
  return <Box className="flex flex-col gap-6">
      <PageHeader title="总览" description="查看请求、用量与响应表现。" actions={<Box className="flex w-full flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Box className="flex w-fit flex-wrap rounded-none border border-border bg-background p-1">
              {OVERVIEW_PERIODS.map(item => <Button key={item.value} type="button" size="sm" variant={period === item.value ? 'default' : 'ghost'} className="h-8 rounded-none px-3 text-[0.72rem]" onClick={() => setPeriod(item.value)}>
                    {t(item.label)}
                  </Button>)}
            </Box>
            <Box className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="rounded-none shrink-0" onClick={() => void copyText(props.data.settings.apiBase, '地址已复制。', props.data.onMessage)}>
                <Copy className="mr-2 size-3" />
                {t('COPY URL')}
              </Button>
              <Button component={Link} to="/keys" type="button" size="sm" className="rounded-none shrink-0">{t('CREATE KEY')}</Button>
            </Box>
          </Box>} />

      <StatsGrid items={metrics()} />

      <Box className="grid gap-6">
        <Card className="rounded-none border border-border bg-background shadow-none">
          <Box className="flex flex-col gap-3 p-6 pb-5">
            <Box className="flex items-center justify-between gap-3">
              <Box>
                <Typography className="text-xl font-semibold tracking-normal text-foreground" component="div">{t("服务状态")}</Typography>
                <Typography className="mt-1 text-sm leading-5 text-muted-foreground" component="div">{t('健康状态与可用资源。')}</Typography>
              </Box>
              <StatusBadge tone={(overview?.service_health.error ?? 0) > 0 ? 'error' : (overview?.service_health.warning ?? 0) > 0 ? 'warning' : 'normal'}>
                {(overview?.service_health.error ?? 0) > 0 ? '异常' : (overview?.service_health.warning ?? 0) > 0 ? '警告' : '正常'}
              </StatusBadge>
            </Box>
          </Box>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <Box className="border-l-2 border-primary/20 pl-4 py-1">
              <Box className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">上游健康</Box>
              <Box className="mt-2 text-2xl font-medium text-foreground tracking-tight">
                {overview ? t('{{count}} 正常', {
                count: overview?.service_health.healthy ?? 0
              }) : t('等待数据')}
              </Box>
              <Box className="mt-1 text-xs leading-5 text-muted-foreground opacity-80" component="p">
                {overview ? t('{{warning}} 警告 · {{error}} 异常', {
                warning: overview?.service_health.warning ?? 0,
                error: overview?.service_health.error ?? 0
              }) : t('暂无实时数据')}
              </Box>
            </Box>
            <Box className="border-l-2 border-primary/20 pl-4 py-1">
              <Box className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('活跃密钥')}</Box>
              <Box className="mt-2 text-2xl font-medium text-foreground tracking-tight">
                {overview ? formatCompactInteger(overview?.service_health.upstream_keys_enabled ?? 0) : '—'}
              </Box>
              <Box className="mt-1 text-xs leading-5 text-muted-foreground opacity-80" component="p">{t('当前可用密钥。')}</Box>
            </Box>
            <Box className="border-l-2 border-primary/20 pl-4 py-1">
              <Box className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t('服务器状态')}</Box>
              <Box className="mt-2 grid grid-cols-2 gap-3">
                <Box>
                  <Box className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground opacity-70">CPU</Box>
                  <Box className="mt-1 text-xl font-medium text-foreground tracking-tight">{formatUsagePercent(serverStatus()?.cpu_usage_percent)}</Box>
                </Box>
                <Box>
                  <Box className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground opacity-70">{t('内存')}</Box>
                  <Box className="mt-1 text-xl font-medium text-foreground tracking-tight">{formatUsagePercent(serverStatus()?.memory_usage_percent)}</Box>
                </Box>
              </Box>
              <Box className="mt-2 text-xs leading-5 text-muted-foreground opacity-80" component="p">
                {`${formatServerMemory(serverStatus())} · ${formatServerScope(serverStatus()?.scope, serverStatus()?.memory_limited)}`}
              </Box>
              <Box className="mt-1 text-xs leading-5 text-muted-foreground opacity-70" component="p">{formatCpuCapacity(serverStatus()?.cpu_capacity_cores)}</Box>
            </Box>
            <Box className="md:col-span-3 pt-2">
              <Button component={Link} to="/upstreams" type="button" variant="ghost" className="w-full justify-start pl-0 hover:bg-transparent hover:text-primary shrink-0">
                {`[ ${t('查看上游详情')} ]`}
              </Button>
            </Box>
          </CardContent>
        </Card>
      </Box>
    </Box>;
}
function UpstreamsPage(props: {
  data: AppDataContext;
}) {
  useEffect(() => {
    if (props.data.providers.length === 0) {
      void props.data.loadProviders();
    }
  }, [props.data.loadProviders, props.data.providers.length]);
  return <Box className="section-stack">
      <PageHeader title="上游" description="查看连接目标与健康状态。" />
      <ProvidersPage settings={props.data.settings} items={props.data.providers} groups={props.data.providerGroups} onRefresh={props.data.loadProviders} onMessage={props.data.onMessage} />
    </Box>;
}
function OAuthRoutePage(props: {
  data: AppDataContext;
}) {
  useEffect(() => {
    void props.data.loadProviders();
  }, [props.data.loadProviders]);
  return <OAuthPage
    settings={props.data.settings}
    items={props.data.providers}
    loading={props.data.status === 'loading'}
    onRefresh={props.data.loadProviders}
    onMessage={props.data.onMessage}
  />;
}
function KeysRoutePage(props: {
  data: AppDataContext;
}) {
  useEffect(() => {
    if (props.data.apiKeys.length === 0) {
      void props.data.loadApiKeys();
    }
  }, [props.data.apiKeys.length, props.data.loadApiKeys]);
  return <ApiKeysPage settings={props.data.settings} items={props.data.apiKeys} groups={props.data.providerGroups} onRefresh={props.data.loadApiKeys} onMessage={props.data.onMessage} />;
}
function LogsRoutePage(props: {
  data: AppDataContext;
}) {
  useEffect(() => {
    if (props.data.providers.length === 0) {
      void props.data.loadProviders();
    }
    if (props.data.apiKeys.length === 0) {
      void props.data.loadApiKeys();
    }
  }, [props.data.apiKeys.length, props.data.loadApiKeys, props.data.loadProviders, props.data.providers.length]);
  return <LogsPage settings={props.data.settings} providers={props.data.providers} apiKeys={props.data.apiKeys} refreshKey={props.data.refreshKey} onMessage={props.data.onMessage} />;
}
function ModelsRoutePage(props: {
  data: AppDataContext;
}) {
  useEffect(() => {
    const tasks: Promise<void>[] = [];
    if (props.data.providers.length === 0) tasks.push(props.data.loadProviders());
    if (props.data.modelAliases.length === 0) tasks.push(props.data.loadModelAliases());
    if (tasks.length > 0) void Promise.all(tasks);
  }, [props.data.loadModelAliases, props.data.loadProviders, props.data.modelAliases.length, props.data.providers.length]);
  return <ModelsPage
    settings={props.data.settings}
    providers={props.data.providers}
    aliases={props.data.modelAliases}
    onAliasesRefresh={props.data.loadModelAliases}
    onMessage={props.data.onMessage}
  />;
}
function SettingsRoutePage(props: {
  data: AppDataContext;
}) {
  useEffect(() => {
    void props.data.loadPricesAndConfig();
    if (props.data.providers.length === 0) {
      void props.data.loadProviders();
    }
  }, [props.data.loadPricesAndConfig, props.data.loadProviders, props.data.providers.length]);
  return <SettingsPage settings={props.data.settings} systemConfig={props.data.systemConfig} runtimeSettings={props.data.runtimeSettings} runtimeEnvPreview={props.data.runtimeEnvPreview} prices={props.data.prices} providers={props.data.providers} onApiBaseChange={props.data.onApiBaseChange} onAdminTokenChange={props.data.onAdminTokenChange} onRefresh={props.data.loadPricesAndConfig} onMessage={props.data.onMessage} />;
}
function NotificationsRoutePage(props: {
  data: AppDataContext;
}) {
  useEffect(() => {
    const tasks: Promise<void>[] = [];
    if (props.data.providers.length === 0) tasks.push(props.data.loadProviders());
    if (props.data.apiKeys.length === 0) tasks.push(props.data.loadApiKeys());
    if (tasks.length > 0) void Promise.all(tasks);
  }, [props.data.apiKeys.length, props.data.loadApiKeys, props.data.loadProviders, props.data.providers.length]);
  return <NotificationsPage settings={props.data.settings} providers={props.data.providers} apiKeys={props.data.apiKeys} onMessage={props.data.onMessage} />;
}
function Root() {
  useI18n();
  const [settings, setSettings] = useState<ConnectionSettings>(readSettings);
  const [providers, setProviders] = useState<ProviderWorkspace[]>([]);
  const [modelAliases, setModelAliases] = useState<ModelAlias[]>([]);
  const [providerGroups, setProviderGroups] = useState<ProviderGroup[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyWorkspace[]>([]);
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [systemConfig, setSystemConfig] = useState<SystemConfigResponse | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettingsResponse | null>(null);
  const [runtimeEnvPreview, setRuntimeEnvPreview] = useState<RuntimeEnvPreviewResponse | null>(null);
  const [status, setStatus] = useState<LoadState>('idle');
  const [message, setMessage] = useState(t('未连接后台。'));
  const [refreshKey, setRefreshKey] = useState(0);
  const [consoleMode, setConsoleMode] = useState<ConsoleMode>('connect');
  const [connectionIssue, setConnectionIssue] = useState<ConnectionIssue>(null);
  const clearWorkspace = useCallback(() => {
    setProviders([]);
    setModelAliases([]);
    setProviderGroups([]);
    setApiKeys([]);
    setPrices([]);
    setSystemConfig(null);
    setRuntimeSettings(null);
    setRuntimeEnvPreview(null);
  }, []);
  const loadProviders = useCallback(async (successMessage?: string) => {
    const current = settings;
    if (!current.adminToken.trim()) {
      setProviders([]);
      return;
    }
    setStatus('loading');
    try {
      const [providerWorkspace, groups] = await Promise.all([
        loadProviderWorkspace(current),
        loadProviderGroups(current),
      ]);
      setProviders(providerWorkspace);
      setProviderGroups(groups);
      if (successMessage) setMessage(t(successMessage));
    } catch (error) {
      setProviders([]);
      setProviderGroups([]);
      setMessage(error instanceof Error ? error.message : '读取上游失败。');
    } finally {
      setStatus('ready');
    }
  }, [settings]);
  const loadModelAliasesForState = useCallback(async (successMessage?: string) => {
    const current = settings;
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
  }, [settings]);
  const loadApiKeys = useCallback(async (successMessage?: string) => {
    const current = settings;
    if (!current.adminToken.trim()) {
      setApiKeys([]);
      return;
    }
    setStatus('loading');
    try {
      const [apiKeyWorkspace, groups] = await Promise.all([
        loadApiKeyWorkspace(current),
        loadProviderGroups(current),
      ]);
      setApiKeys(apiKeyWorkspace);
      setProviderGroups(groups);
      if (successMessage) setMessage(t(successMessage));
    } catch (error) {
      setApiKeys([]);
      setProviderGroups([]);
      setMessage(error instanceof Error ? error.message : '读取密钥失败。');
    } finally {
      setStatus('ready');
    }
  }, [settings]);
  const loadPricesAndConfig = useCallback(async (successMessage?: string) => {
    const current = settings;
    if (!current.adminToken.trim()) {
      setPrices([]);
      setSystemConfig(null);
      setRuntimeSettings(null);
      setRuntimeEnvPreview(null);
      return;
    }
    setStatus('loading');
    try {
      const [priceItems, config, runtime, envPreview] = await Promise.all([loadPrices(current), loadSystemConfig(current).catch(() => null), loadRuntimeSettings(current).catch(() => null), previewRuntimeEnv(current).catch(() => null)]);
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
  }, [settings]);
  const refreshData = useCallback(async (successMessage?: string) => {
    const current = settings;
    persistSettings(current);
    setStatus('loading');
    if (!current.adminToken.trim()) {
      clearWorkspace();
      setMessage(t('请输入管理员口令。'));
      setConnectionIssue('adminToken');
      setConsoleMode('connect');
      setRefreshKey(value => value + 1);
      setStatus('ready');
      return;
    }
    setConnectionIssue(null);
    setMessage(t('正在验证管理员口令…'));
    try {
      const config = await loadSystemConfig(current);
      setSystemConfig(config);
      setRefreshKey(value => value + 1);
      setMessage(successMessage ? t(successMessage) : t('已连接。'));
      setConnectionIssue(null);
      setConsoleMode('console');
    } catch (error) {
      console.error('Failed to load admin console data', error);
      clearWorkspace();
      const failure = describeConnectionFailure(error);
      setMessage(failure.message);
      setConnectionIssue(failure.issue);
      setConsoleMode('connect');
    } finally {
      setStatus('ready');
    }
  }, [clearWorkspace, settings]);
  const logout = useCallback(() => {
    const nextSettings = {
      ...settings,
      adminToken: ''
    };
    setSettings(nextSettings);
    persistSettings(nextSettings);
    clearWorkspace();
    setMessage(t('已退出。'));
    setConnectionIssue(null);
    setConsoleMode('connect');
    setRefreshKey(value => value + 1);
  }, [clearWorkspace, settings]);
  const clearConnectionFeedback = useCallback(() => {
    if (consoleMode !== 'connect') return;
    setConnectionIssue(null);
    setMessage(t('未连接后台。'));
  }, [consoleMode]);
  const onApiBaseChange = useCallback((value: string) => {
    setSettings(current => ({
      ...current,
      apiBase: value
    }));
    clearConnectionFeedback();
  }, [clearConnectionFeedback]);
  const onAdminTokenChange = useCallback((value: string) => {
    setSettings(current => ({
      ...current,
      adminToken: value
    }));
    clearConnectionFeedback();
  }, [clearConnectionFeedback]);
  const onMessage = useCallback((nextMessage: string) => setMessage(t(nextMessage)), []);
  useEffect(() => {
    if (settings.adminToken.trim()) void refreshData();
  }, []);
  const data = useMemo<AppDataContext>(() => ({
    settings,
    providers,
    modelAliases,
    providerGroups,
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
    onApiBaseChange,
    onAdminTokenChange,
    onRefresh: refreshData,
    onLogout: logout,
    onMessage
  }), [
    apiKeys,
    loadApiKeys,
    loadModelAliasesForState,
    loadPricesAndConfig,
    loadProviders,
    logout,
    message,
    modelAliases,
    providerGroups,
    onAdminTokenChange,
    onApiBaseChange,
    onMessage,
    prices,
    providers,
    refreshData,
    refreshKey,
    runtimeEnvPreview,
    runtimeSettings,
    settings,
    status,
    systemConfig
  ]);
  return consoleMode === 'console' ? (
    <BrowserRouter>
      <TopShell data={data}>
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage data={data} />} />
          <Route path="/keys" element={<KeysRoutePage data={data} />} />
          <Route path="/logs" element={<LogsRoutePage data={data} />} />
          <Route path="/upstreams" element={<UpstreamsPage data={data} />} />
          <Route path="/oauth" element={<OAuthRoutePage data={data} />} />
          <Route path="/models" element={<ModelsRoutePage data={data} />} />
          <Route path="/notifications" element={<NotificationsRoutePage data={data} />} />
          <Route path="/settings" element={<SettingsRoutePage data={data} />} />
          <Route path="/usage" element={<Navigate to="/overview" replace />} />
          <Route path="/prices" element={<Navigate to="/overview" replace />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </TopShell>
    </BrowserRouter>
  ) : (
    <ConnectionGate
      settings={settings}
      status={status}
      message={message}
      issue={connectionIssue}
      onApiBaseChange={onApiBaseChange}
      onAdminTokenChange={onAdminTokenChange}
      onRefresh={refreshData}
    />
  );
}
export default Root;
