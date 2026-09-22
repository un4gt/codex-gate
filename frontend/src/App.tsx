import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RestrictToVerticalAxis } from '@dnd-kit/abstract/modifiers';
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, DragOverlay, type DragEndEvent } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { Activity, ArrowRight, Bell, Boxes, Check, Copy, Cpu, Database, Eye, EyeOff, Fingerprint, GripVertical, KeyRound, ListFilter, LogOut, Menu, RefreshCw, Server, Settings, ShieldCheck, SquareTerminal, Timer, Wallet, X, Zap, type LucideIcon } from "lucide-react";
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
import { useRemoteResource } from '@/lib/useRemoteResource';
import { ApiRequestError, subscribeAuthenticationFailures, loadApiKeyWorkspace, loadProviderGroups, loadProviderWorkspace, loadRuntimeSettings, loadStatsOverview, loadSystemConfig, previewRuntimeEnv } from '@/lib/api';
import { formatBytes, formatCommitShort, formatCompactInteger, formatMs, formatVersionLabel } from '@/lib/format';
import { calculateOverviewPricing, formatUsd } from '@/lib/pricing';
import type { ApiKeyWorkspace, ConnectionSettings, ProviderGroup, ProviderWorkspace, RuntimeEnvPreviewResponse, RuntimeSettingsResponse, StatsOverviewResponse, StatsPeriod, SystemConfigResponse } from '@/lib/types';
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from '@mui/material/CircularProgress';
import InputBase from "@mui/material/InputBase";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import useMediaQuery from '@mui/material/useMediaQuery';
type LoadState = 'idle' | 'loading' | 'ready';
type ConsoleMode = 'connect' | 'checking' | 'console' | 'error';
type ConnectionIssue = 'apiBase' | 'adminToken' | 'general' | null;
interface ConnectionFailure {
  issue: Exclude<ConnectionIssue, null>;
  message: string;
}
interface AppDataContext {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  providersLoaded: boolean;
  providerGroups: ProviderGroup[];
  apiKeys: ApiKeyWorkspace[];
  systemConfig: SystemConfigResponse | null;
  runtimeSettings: RuntimeSettingsResponse | null;
  runtimeEnvPreview: RuntimeEnvPreviewResponse | null;
  status: LoadState;
  /** 最近一次后台请求是否成功——顶栏连接指示器据此渲染，不能靠硬编码。 */
  linkOk: boolean;
  message: string;
  refreshKey: number;
  loadProviders: (successMessage?: string) => Promise<void>;
  loadApiKeys: (successMessage?: string) => Promise<void>;
  loadSettings: (successMessage?: string) => Promise<void>;
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
    label: '访问密钥',
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
  active: boolean;
  overlay?: boolean;
}) {
  const { t } = useI18n();
  const Icon = props.item.icon;
  return <>
      <Box className={`flex size-8 shrink-0 items-center justify-center ${props.active || props.overlay ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`} aria-hidden="true" component="span">
        <Icon size={18} strokeWidth={1.8} />
      </Box>
      <Box className="min-w-0 flex-1 truncate" component="span">{t(props.item.label)}</Box>
      <Box className={props.overlay ? 'text-primary' : 'nav-grip text-muted-foreground'} aria-hidden="true" component="span">
        <GripVertical size={14} />
      </Box>
    </>;
}
function SortableNavigationItem(props: {
  item: NavigationItemView;
  index: number;
  active: boolean;
  reducedMotion: boolean;
  onNavigate?: () => void;
}) {
  const { ref, isDragSource, isDropTarget, isDropping } = useSortable({
    id: props.item.key,
    index: props.index,
    group: NAVIGATION_SORTABLE_TYPE,
    type: NAVIGATION_SORTABLE_TYPE,
    accept: NAVIGATION_SORTABLE_TYPE,
    transition: props.reducedMotion ? null : NAVIGATION_SORT_TRANSITION
  });
  const stateClass = isDragSource ? 'border-primary/45 bg-primary/10 text-primary opacity-[0.32]' : isDropTarget ? 'border-primary/45 bg-primary/10 text-primary' : props.active ? 'border-primary/10 bg-primary/[0.08] font-semibold text-primary' : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground';
  return <Box ref={ref} component={Link} to={props.item.to} onClick={props.onNavigate} aria-current={props.active ? 'page' : undefined} aria-describedby={NAVIGATION_SORT_INSTRUCTIONS_ID} aria-keyshortcuts="Space ArrowUp ArrowDown" className={`nav-sortable-item group relative flex min-h-11 w-full cursor-grab select-none items-center gap-2 rounded-lg border px-2 py-1.5 text-[0.8125rem] font-medium outline-none transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out active:cursor-grabbing motion-reduce:transition-none ${stateClass} ${isDropping ? 'pointer-events-none' : ''}`} data-nav-key={props.item.key} data-nav-sortable="true" data-nav-dragging={isDragSource ? 'true' : undefined} data-nav-drop-target={isDropTarget ? 'true' : undefined} sx={{
    WebkitTapHighlightColor: 'transparent',
    '&:focus-visible': {
      outline: '2px solid var(--primary)',
      outlineOffset: '-2px'
    }
  }}>
      <NavigationItemContent item={props.item} active={props.active} />
    </Box>;
}
function NavigationDragPreview(props: {
  item: NavigationItemView;
  index: number;
  active: boolean;
}) {
  return <Box className="flex min-h-[2.5rem] w-full items-center gap-2 rounded border border-primary/50 bg-popover px-2 py-1.5 text-[0.8125rem] font-semibold text-primary" aria-hidden="true" sx={{
    boxShadow: '0 12px 28px -20px rgb(0 0 0 / 0.38), 0 6px 14px -12px rgb(0 0 0 / 0.24)',
    transform: 'scale(1.015)'
  }}>
      <NavigationItemContent item={props.item} active={props.active} overlay />
    </Box>;
}
async function copyText(value: string, success: string, onMessage: (message: string) => void) {
  try {
    if (!navigator.clipboard) {
      onMessage(t('当前环境不支持剪贴板。'));
      return false;
    }
    await navigator.clipboard.writeText(value);
    onMessage(t(success));
    return true;
  } catch {
    onMessage(t('复制失败，请重试。'));
    return false;
  }
}
function pageDescription(pathname: string) {
  if (pathname.startsWith('/overview')) return '查看请求、用量与响应表现。';
  if (pathname.startsWith('/keys')) return '创建和管理访问密钥。';
  if (pathname.startsWith('/logs')) return '筛选并排查最近请求。';
  if (pathname.startsWith('/models')) return '管理模型库存、路由别名与价格。';
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
  const { t } = useI18n();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const compact = useMediaQuery('(max-width: 1023.95px)', { noSsr: true });
  const closeNavigation = () => setNavigationOpen(false);
  const [navOrder, setNavOrder] = useState<NavKey[]>(readNavOrder);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', {
    noSsr: true
  });
  const navItems = useMemo<NavigationItemView[]>(() => [...navOrder.filter(key => key !== 'notifications' && key !== 'settings'), ...navOrder.filter(key => key === 'notifications' || key === 'settings')].map(key => ({
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
      const grouped = [...current.filter(key => key !== 'notifications' && key !== 'settings'), ...current.filter(key => key === 'notifications' || key === 'settings')];
      const sameSection = (key: NavKey) => (key === 'notifications' || key === 'settings') === (sourceKey === 'notifications' || sourceKey === 'settings');
      if (!grouped[targetIndex] || !sameSection(grouped[targetIndex])) return current;
      const next = moveNavKey(grouped, sourceKey, targetIndex);
      if (next === current) return current;
      persistNavOrder(next);
      return next;
    });
  }, []);
  const sidebar = <Box className="app-sidebar" component="aside">
    <Box className="mb-8 flex items-center justify-between gap-2 px-2">
      <Box component={Link} to="/overview" onClick={closeNavigation} className="flex min-w-0 items-center gap-3">
        <Box className="brand-mark"><SquareTerminal size={21} /></Box>
        <Box className="min-w-0">
          <Box className="text-[0.9375rem] font-bold tracking-wide text-foreground" component="p">LITTLE GATE</Box>
          <Box className="mt-0.5 text-xs text-muted-foreground" component="p">{t('网关控制台')}</Box>
        </Box>
      </Box>
      {compact ? <IconButton aria-label={t('关闭导航')} onClick={closeNavigation}><X size={18} /></IconButton> : null}
    </Box>
    <DragDropProvider sensors={NAVIGATION_DRAG_SENSORS} modifiers={NAVIGATION_DRAG_MODIFIERS} onDragEnd={reorderNav}>
      <Box className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="Primary" component="nav">
        <Box id={NAVIGATION_SORT_INSTRUCTIONS_ID} className="sr-only">
          {t('拖动任意导航项可调整顺序。键盘操作：按空格开始，使用上下方向键移动，再按空格完成。')}
        </Box>
        <Box className="nav-section-label">{t('工作空间')}</Box>
        {navItems.slice(0, 6).map((item, index) => <SortableNavigationItem key={item.key} item={item} index={index} active={location.pathname.startsWith(item.to)} reducedMotion={reducedMotion} onNavigate={closeNavigation} />)}
        <Box className="nav-section-label mt-6">{t('管理')}</Box>
        {navItems.slice(6).map((item, index) => <SortableNavigationItem key={item.key} item={item} index={index + 6} active={location.pathname.startsWith(item.to)} reducedMotion={reducedMotion} onNavigate={closeNavigation} />)}
      </Box>
      <DragOverlay className="pointer-events-none z-[1500]" dropAnimation={reducedMotion ? null : NAVIGATION_DROP_ANIMATION}>
        {source => {
          const key = String(source.id);
          if (!isNavKey(key)) return null;
          const item = navItems.find(candidate => candidate.key === key);
          return item ? <NavigationDragPreview item={item} index={navOrder.indexOf(key)} active={location.pathname.startsWith(item.to)} /> : null;
        }}
      </DragOverlay>
    </DragDropProvider>
    <Box className="mt-5 flex flex-col gap-3 border-t border-border pt-4">
      <Box className="rounded-lg border border-border bg-background p-3">
        <Box className="flex items-center justify-between gap-2">
          <Box className="text-xs font-medium text-muted-foreground" component="span">{t('SYSTEM STATUS')}</Box>
          <ConnectionIndicator status={props.data.status} linkOk={props.data.linkOk} />
        </Box>
        <Box className="mt-2 truncate font-mono text-[0.6875rem] text-muted-foreground" component="p" title={props.data.settings.apiBase}>{props.data.settings.apiBase}</Box>
        <Box className="mt-1 max-h-20 overflow-y-auto break-words text-xs leading-5 text-muted-foreground" component="p">{props.data.message}</Box>
      </Box>
      <Box className="flex items-center justify-between gap-2 px-1">
        <Box className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground" title={serviceCommitTitle} component="span">
          {serviceVersion}{serviceCommit !== '—' ? ` · ${serviceCommit}` : ''}
        </Box>
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={props.data.onLogout}>
          <LogOut size={14} />{t('退出')}
        </Button>
      </Box>
    </Box>
  </Box>;
  return <Box className="min-h-dvh bg-background">
    <Box component="a" href="#main-content" className="skip-link">{t('跳转到内容')}</Box>
    <Box className="app-shell">
      {compact ? <>
        <Box component="header" className="sticky top-0 z-30 flex h-16 w-full items-center justify-between gap-3 border-b border-border bg-card px-4">
          <Box className="flex items-center gap-2">
            <IconButton aria-label={t('打开导航')} aria-expanded={navigationOpen} aria-controls={navigationOpen ? 'mobile-navigation' : undefined} onClick={() => setNavigationOpen(true)}><Menu size={21} /></IconButton>
            <Box className="text-sm font-bold tracking-wide" component="span">LITTLE GATE</Box>
          </Box>
          <ConnectionIndicator status={props.data.status} linkOk={props.data.linkOk} />
        </Box>
        <Drawer open={navigationOpen} onClose={closeNavigation} slotProps={{ paper: { id: 'mobile-navigation', role: 'dialog', 'aria-modal': true, 'aria-label': t('主导航'), sx: { width: 280, maxWidth: 'calc(100vw - 32px)', '& .app-sidebar': { width: '100%', borderRight: 0 } } } }}>
          {sidebar}
        </Drawer>
      </> : sidebar}
      <Box className="app-main" component="main" id="main-content" tabIndex={-1}>
        <Box className="app-content">
          <Box className="app-pagebar" component="header">
            <Box className="min-w-0">
              <Box className="app-title" component="h1">{t(currentItem.label)}</Box>
              <Box className="app-description" component="p">{t(pageDescription(location.pathname))}</Box>
            </Box>
            <Box className="app-toolbar">
              <LocaleSwitch />
              <Button type="button" variant="outline" onClick={() => void props.data.onRefresh()} disabled={props.data.status === 'loading'}>
                <RefreshCw className={props.data.status === 'loading' ? 'animate-spin motion-reduce:animate-none' : ''} size={15} />
                {t(props.data.status === 'loading' ? '同步中' : 'SYNC')}
              </Button>
            </Box>
          </Box>
          {props.children}
        </Box>
      </Box>
    </Box>
  </Box>;
}
/** 连接指示器必须反映真实状态：绿=后台可达，琥珀=请求进行中，红=最近一次请求失败。 */
function ConnectionIndicator(props: {
  status: LoadState;
  linkOk: boolean;
}) {
  if (props.status === 'loading') return <StatusBadge tone="warning">同步中</StatusBadge>;
  if (!props.linkOk) return <StatusBadge tone="error">连接异常</StatusBadge>;
  return <StatusBadge tone="normal">已连接</StatusBadge>;
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
  const { t } = useI18n();
  const apiBaseInputRef = useRef<HTMLInputElement>(null);
  const adminTokenInputRef = useRef<HTMLInputElement>(null);
  const [showToken, setShowToken] = useState(false);
  const connecting = props.status === 'loading';
  useEffect(() => {
    if (props.issue === 'apiBase') apiBaseInputRef.current?.focus();
    if (props.issue === 'adminToken') adminTokenInputRef.current?.focus();
  }, [props.issue]);
  return <Box className="connection-page">
    <Box component="header" className="flex items-center justify-between gap-4">
      <Box className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><SquareTerminal size={18} /><Box component="span">little-gate</Box></Box>
      <LocaleSwitch />
    </Box>
    <Box className="flex flex-1 flex-col items-center justify-center gap-6 py-10 sm:py-16">
      <Box className="flex flex-col items-center gap-4 text-center">
        <Box className="brand-mark size-12"><SquareTerminal size={25} /></Box>
        <Box>
          <Box className="text-2xl font-bold tracking-wide text-foreground" component="h1">LITTLE GATE</Box>
          <Box className="mt-2 text-sm text-muted-foreground" component="p">{t('模型、流量与连接，尽在掌握。')}</Box>
        </Box>
      </Box>
      <Card className="connection-card">
        <Box className="px-6 pb-5 pt-7 sm:px-8 sm:pt-8">
          <Typography className="text-lg font-semibold text-foreground" component="h2">{t('登录控制台')}</Typography>
          <Typography className="mt-1.5 text-[0.8125rem] leading-6 text-muted-foreground">{t('输入管理员口令以验证身份。')}</Typography>
        </Box>
        <CardContent className="px-6 pb-7 sm:px-8 sm:pb-8">
          <Box className="flex flex-col gap-5" aria-busy={connecting} component="form" onSubmit={event => {
            event.preventDefault();
            if (!connecting) void props.onRefresh();
          }}>
            <Box className="flex flex-col gap-2">
              <Box component="label" htmlFor="connection-api-base" className="text-xs font-semibold text-foreground">{t('服务地址')}</Box>
              <InputBase id="connection-api-base" value={props.settings.apiBase} disabled={connecting} error={props.issue === 'apiBase'} inputRef={apiBaseInputRef}
                inputProps={{ 'aria-describedby': 'connection-status-message', 'aria-invalid': props.issue === 'apiBase' }}
                autoComplete="url" autoCapitalize="none" spellCheck={false}
                onChange={event => props.onApiBaseChange(event.target.value)} placeholder={t('http://127.0.0.1:8080')}
                className="h-11 font-mono text-[0.8125rem]" startAdornment={<Server size={16} className="shrink-0 text-muted-foreground" />} />
            </Box>
            <Box className="flex flex-col gap-2">
              <Box component="label" htmlFor="connection-admin-token" className="text-xs font-semibold text-foreground">{t('管理员口令')}</Box>
              <InputBase id="connection-admin-token" type={showToken ? 'text' : 'password'} value={props.settings.adminToken} disabled={connecting} error={props.issue === 'adminToken'} inputRef={adminTokenInputRef}
                inputProps={{ 'aria-describedby': 'connection-status-message token-storage-hint', 'aria-invalid': props.issue === 'adminToken' }}
                autoComplete="current-password" autoCapitalize="none" spellCheck={false}
                onChange={event => props.onAdminTokenChange(event.target.value)} placeholder={t('输入管理员口令')}
                className="h-11 font-mono text-[0.8125rem]" startAdornment={<KeyRound size={16} className="shrink-0 text-muted-foreground" />}
                endAdornment={<IconButton type="button" aria-label={t(showToken ? '隐藏口令' : '显示口令')} aria-pressed={showToken} disabled={connecting} onClick={() => setShowToken(value => !value)} edge="end">{showToken ? <EyeOff size={16} /> : <Eye size={16} />}</IconButton>} />
              <Typography id="token-storage-hint" className="text-xs text-muted-foreground">{t('只保存在当前标签页。')}</Typography>
            </Box>
            {props.issue ? <Alert severity="error" role="alert">
              <AlertTitle>{t('登录失败')}</AlertTitle>
              <Box id="connection-status-message">{props.message}</Box>
            </Alert> : <Box id="connection-status-message" role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Box component="span" className="size-1.5 rounded-full bg-muted-foreground/60" />{props.message}</Box>}
            <Button type="submit" disabled={connecting} className="h-11 w-full text-sm">
              {connecting ? <RefreshCw size={16} className="animate-spin motion-reduce:animate-none" /> : null}
              {t(connecting ? 'CONNECTING...' : 'ENTER CONSOLE')}
              {!connecting ? <ArrowRight size={16} /> : null}
            </Button>
          </Box>
        </CardContent>
      </Card>
      <Box className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck size={14} aria-hidden="true" />{t('统一接入 · 灵活路由 · 用量可见')}</Box>
    </Box>
  </Box>;
}
function OverviewPage(props: {
  data: AppDataContext;
}) {
  const { t } = useI18n();
  const [period, setPeriod] = useState<StatsPeriod>('today');
  const [copied, setCopied] = useState(false);
  const loadOverview = useCallback(async (settings: ConnectionSettings) => ({
    period,
    overview: await loadStatsOverview(settings, period),
  }), [period]);
  const resource = useRemoteResource(props.data.settings, loadOverview, props.data.refreshKey);
  const overview = resource.data?.period === period ? resource.data.overview : null;
  // A different period must not inherit the previous period's figures while loading.
  const loading = resource.loading || (!overview && !resource.error);
  useEffect(() => {
    void props.data.loadApiKeys();
  }, [props.data.loadApiKeys, props.data.refreshKey]);
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
  const overviewPricing = overview ? calculateOverviewPricing(overview) : null;
  const metrics = (): StatItem[] => {
    const current = overview;
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
        value: overviewPricing && overviewPricing.priceableRequests > 0 ? formatUsd(overviewPricing.totalUsd) : '—',
        hint: overviewPricing ? t('已计价 {{priced}} · 未定价 {{unpriced}} · 缺用量 {{missing}} · token 覆盖 {{coverage}}%', {
          priced: formatCompactInteger(overviewPricing.priceableRequests),
          unpriced: formatCompactInteger(overviewPricing.unpricedRequests),
          missing: formatCompactInteger(overviewPricing.usageMissingRequests),
          coverage: overviewPricing.tokenCoveragePercent.toDecimalPlaces(1).toFixed(1)
        }) : t('当前窗口：{{window}}', {
          window: t(periodLabel())
        }),
        tone: overviewPricing && (overviewPricing.unpricedRequests > 0 || overviewPricing.usageMissingRequests > 0) ? 'warning' : 'success'
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
  const items = metrics();
  const icons = [KeyRound, Activity, Wallet, Zap, Database, Timer];
  const orderedItems = [1, 3, 2, 5, 4, 0].map(index => ({ ...items[index], icon: icons[index] }));
  const health = overview?.service_health;
  return <Box className="flex min-w-0 flex-col gap-5">
    <PageHeader actions={<Box className="flex w-full flex-wrap items-center justify-between gap-3">
      <Box className="segmented-control" role="group" aria-label={t('统计时间范围')}>
        {OVERVIEW_PERIODS.map(item => <Button key={item.value} type="button" size="sm" variant="ghost" aria-pressed={period === item.value}
          className={period === item.value ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground'} onClick={() => setPeriod(item.value)}>{t(item.label)}</Button>)}
      </Box>
      <Box className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={async () => setCopied(await copyText(props.data.settings.apiBase, '地址已复制。', props.data.onMessage))} onBlur={() => setCopied(false)}>
          {copied ? <Check size={15} /> : <Copy size={15} />}{t(copied ? '已复制' : 'COPY URL')}
        </Button>
        <Button component={Link} to="/keys"><KeyRound size={15} />{t('CREATE KEY')}</Button>
      </Box>
    </Box>} />
    {resource.error ? <Alert severity="error" action={<Button variant="ghost" disabled={resource.loading} onClick={() => void resource.reload()}>{t('重试')}</Button>}>
      <AlertTitle>{t('读取总览失败。')}</AlertTitle>
      {resource.error}{overview ? <Box className="mt-1">{t('当前显示上次成功获取的数据。')}</Box> : null}
    </Alert> : null}
    <Box className="relative" aria-busy={loading}>
      {loading && overview ? <LinearProgress aria-label={t('更新总览数据')} className="absolute -top-2 inset-x-0" /> : null}
      <StatsGrid items={orderedItems} loading={loading && !overview} ariaLabel="用量概览" />
    </Box>
    <Box className="grid min-w-0 gap-5 xl:grid-cols-[1.15fr_1fr]">
      <Card className="console-panel">
        <Box className="panel-heading">
          <Box>
            <Typography component="h2" className="text-sm font-semibold text-foreground">{t('服务状态')}</Typography>
            <Typography className="mt-1 text-xs leading-5 text-muted-foreground">{t('健康状态与可用资源。')}</Typography>
          </Box>
          <StatusBadge tone={!health ? 'disabled' : health.error > 0 ? 'error' : health.warning > 0 ? 'warning' : 'normal'}>
            {!health ? '等待数据' : health.error > 0 ? '异常' : health.warning > 0 ? '警告' : '正常'}
          </StatusBadge>
        </Box>
        <CardContent className="px-5">
          <Box className="grid grid-cols-3 gap-2 sm:gap-4">
            <Box className="min-w-0 rounded-lg bg-background p-3 sm:p-3.5">
              <Box className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Server size={14} className="hidden shrink-0 sm:block" />{t('上游健康')}</Box>
              <Box className="text-xl font-semibold tabular-nums">{health ? health.healthy : '—'}</Box>
              <Box className="mt-1.5 text-xs leading-5 text-muted-foreground">{health ? t('{{warning}} 警告 · {{error}} 异常', { warning: health.warning, error: health.error }) : t('等待数据')}</Box>
            </Box>
            <Box className="min-w-0 rounded-lg bg-background p-3 sm:p-3.5">
              <Box className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Zap size={14} className="hidden shrink-0 sm:block" />{t('可用目标')}</Box>
              <Box className="text-xl font-semibold tabular-nums">{health ? health.endpoints_enabled : '—'}</Box>
              <Box className="mt-1.5 text-xs leading-5 text-muted-foreground">{t('已启用的连接目标')}</Box>
            </Box>
            <Box className="min-w-0 rounded-lg bg-background p-3 sm:p-3.5">
              <Box className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><KeyRound size={14} className="hidden shrink-0 sm:block" />{t('活跃密钥')}</Box>
              <Box className="text-xl font-semibold tabular-nums">{health ? formatCompactInteger(health.upstream_keys_enabled) : '—'}</Box>
              <Box className="mt-1.5 text-xs leading-5 text-muted-foreground">{t('当前可用密钥。')}</Box>
            </Box>
          </Box>
          <Button component={Link} to="/upstreams" variant="ghost" className="mt-4 text-primary">{t('查看上游详情')}<ArrowRight size={15} /></Button>
        </CardContent>
      </Card>
      <Card className="console-panel">
        <Box className="panel-heading">
          <Box>
            <Typography component="h2" className="text-sm font-semibold text-foreground">{t('服务器状态')}</Typography>
            <Typography className="mt-1 text-xs leading-5 text-muted-foreground">{formatServerScope(serverStatus()?.scope, serverStatus()?.memory_limited)}</Typography>
          </Box>
          <Box className="flex size-8 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground"><Cpu size={17} /></Box>
        </Box>
        <CardContent className="flex flex-col gap-5 px-5">
          <ResourceMeter label="CPU" value={serverStatus()?.cpu_usage_percent} hint={formatCpuCapacity(serverStatus()?.cpu_capacity_cores)} />
          <ResourceMeter label="内存" value={serverStatus()?.memory_usage_percent} hint={formatServerMemory(serverStatus())} />
        </CardContent>
      </Card>
    </Box>
  </Box>;
}
function ResourceMeter({ label, value, hint }: { label: string; value: number | null | undefined; hint: string }) {
  const { t } = useI18n();
  const known = typeof value === 'number' && Number.isFinite(value);
  return <Box>
    <Box className="mb-2 flex items-baseline justify-between gap-3">
      <Box component="span" className="text-xs font-medium text-muted-foreground">{t(label)}</Box>
      <Box component="span" className="text-sm font-semibold tabular-nums">{formatUsagePercent(value)}</Box>
    </Box>
    {known ? <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, value))} aria-label={t(label)} sx={{ height: 6, '& .MuiLinearProgress-bar': { backgroundColor: value >= 90 ? 'var(--warning)' : 'var(--primary)' } }} />
      : <Box className="h-1.5 rounded-full bg-muted" />}
    <Box className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</Box>
  </Box>;
}
function UpstreamsPage(props: {
  data: AppDataContext;
}) {
  useEffect(() => {
    if (!props.data.providersLoaded) void props.data.loadProviders();
  }, [props.data.loadProviders]);
  return <Box className="section-stack">
      <ProvidersPage loading={!props.data.providersLoaded} settings={props.data.settings} items={props.data.providers} groups={props.data.providerGroups} onRefresh={props.data.loadProviders} onMessage={props.data.onMessage} />
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
function ModelsRoutePage({ data }: { data: AppDataContext }) {
  useEffect(() => { if (!data.providersLoaded) void data.loadProviders(); }, [data.loadProviders]);
  return <ModelsPage settings={data.settings} providers={data.providers} refreshKey={data.refreshKey} onMessage={data.onMessage} />;
}
function SettingsRoutePage({ data }: { data: AppDataContext }) {
  useEffect(() => { void data.loadSettings(); }, [data.loadSettings]);
  return <SettingsPage settings={data.settings} systemConfig={data.systemConfig} runtimeSettings={data.runtimeSettings} runtimeEnvPreview={data.runtimeEnvPreview} onApiBaseChange={data.onApiBaseChange} onAdminTokenChange={data.onAdminTokenChange} onRefresh={data.loadSettings} onMessage={data.onMessage} />;
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
function ConsoleRoot() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<ConnectionSettings>(readSettings);
  const [providers, setProviders] = useState<ProviderWorkspace[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providerGroups, setProviderGroups] = useState<ProviderGroup[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyWorkspace[]>([]);
  const [systemConfig, setSystemConfig] = useState<SystemConfigResponse | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettingsResponse | null>(null);
  const [runtimeEnvPreview, setRuntimeEnvPreview] = useState<RuntimeEnvPreviewResponse | null>(null);
  const [status, setStatus] = useState<LoadState>('idle');
  const [linkOk, setLinkOk] = useState(true);
  const [message, setMessage] = useState(t('未连接后台。'));
  const [notice, setNotice] = useState<{ message: string; key: number } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [consoleMode, setConsoleMode] = useState<ConsoleMode>(() => settings.adminToken.trim() ? 'checking' : 'connect');
  const [connectionIssue, setConnectionIssue] = useState<ConnectionIssue>(null);
  const workspaceVersion = useRef(0);
  const authVersion = useRef(0);
  const authenticationRequest = useRef<{ settings: ConnectionSettings; promise: Promise<SystemConfigResponse> } | null>(null);
  const clearWorkspace = useCallback(() => {
    workspaceVersion.current += 1;
    setProviders([]);
    setProvidersLoaded(false);
    setProviderGroups([]);
    setApiKeys([]);
    setSystemConfig(null);
    setRuntimeSettings(null);
    setRuntimeEnvPreview(null);
  }, []);
  const loadProviders = useCallback(async (successMessage?: string) => {
    const current = settings;
    const generation = workspaceVersion.current;
    if (!current.adminToken.trim()) {
      setProviders([]);
      return;
    }
    setStatus('loading');
    setProvidersLoaded(false);
    try {
      const [providerWorkspace, groups] = await Promise.all([
        loadProviderWorkspace(current),
        loadProviderGroups(current),
      ]);
      if (generation !== workspaceVersion.current) return;
      setProviders(providerWorkspace);
      setProviderGroups(groups);
      setLinkOk(true);
      if (successMessage) setMessage(t(successMessage));
    } catch (error) {
      if (generation !== workspaceVersion.current) return;
      setProviders([]);
      setProviderGroups([]);
      setLinkOk(false);
      setMessage(error instanceof Error ? error.message : '读取上游失败。');
    } finally {
      if (generation === workspaceVersion.current) { setStatus('ready'); setProvidersLoaded(true); }
    }
  }, [settings]);
  const loadApiKeys = useCallback(async (successMessage?: string) => {
    const current = settings;
    const generation = workspaceVersion.current;
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
      if (generation !== workspaceVersion.current) return;
      setApiKeys(apiKeyWorkspace);
      setProviderGroups(groups);
      setLinkOk(true);
      if (successMessage) setMessage(t(successMessage));
    } catch (error) {
      if (generation !== workspaceVersion.current) return;
      setApiKeys([]);
      setProviderGroups([]);
      setLinkOk(false);
      setMessage(error instanceof Error ? error.message : '读取密钥失败。');
    } finally {
      if (generation === workspaceVersion.current) setStatus('ready');
    }
  }, [settings]);
  const loadSettings = useCallback(async (successMessage?: string) => {
    const current = settings;
    const generation = workspaceVersion.current;
    if (!current.adminToken.trim()) {
      setSystemConfig(null);
      setRuntimeSettings(null);
      setRuntimeEnvPreview(null);
      return;
    }
    setStatus('loading');
    try {
      const [config, runtime, envPreview] = await Promise.all([loadSystemConfig(current), loadRuntimeSettings(current), previewRuntimeEnv(current)]);
      if (generation !== workspaceVersion.current) return;
      setSystemConfig(config);
      setRuntimeSettings(runtime);
      setRuntimeEnvPreview(envPreview);
      setLinkOk(true);
      if (successMessage) setMessage(t(successMessage));
    } catch (error) {
      if (generation !== workspaceVersion.current) return;
      setSystemConfig(null);
      setRuntimeSettings(null);
      setRuntimeEnvPreview(null);
      setLinkOk(false);
      setMessage(error instanceof Error ? error.message : '读取设置失败。');
    } finally {
      if (generation === workspaceVersion.current) setStatus('ready');
    }
  }, [settings]);
  const refreshData = useCallback(async (successMessage?: string) => {
    const current = settings;
    const generation = ++authVersion.current;
    if (consoleMode === 'error') setConsoleMode('checking');
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
    const request = authenticationRequest.current?.settings === current
      ? authenticationRequest.current
      : { settings: current, promise: loadSystemConfig(current) };
    authenticationRequest.current = request;
    try {
      const config = await request.promise;
      if (generation !== authVersion.current) return;
      setSystemConfig(config);
      setRefreshKey(value => value + 1);
      setMessage(successMessage ? t(successMessage) : t('已连接。'));
      setConnectionIssue(null);
      setLinkOk(true);
      setConsoleMode('console');
    } catch (error) {
      if (generation !== authVersion.current) return;
      clearWorkspace();
      const failure = describeConnectionFailure(error);
      setMessage(failure.message);
      setConnectionIssue(failure.issue);
      setLinkOk(false);
      setConsoleMode(failure.issue === 'adminToken' ? 'connect' : 'error');
    } finally {
      if (authenticationRequest.current === request) authenticationRequest.current = null;
      if (generation === authVersion.current) setStatus('ready');
    }
  }, [clearWorkspace, consoleMode, settings]);
  const logout = useCallback(() => {
    authVersion.current += 1;
    const nextSettings = {
      ...settings,
      adminToken: ''
    };
    setSettings(nextSettings);
    persistSettings(nextSettings);
    clearWorkspace();
    setNotice(null);
    setMessage(t('已退出。'));
    setStatus('ready');
    setConnectionIssue(null);
    setConsoleMode('connect');
    setRefreshKey(value => value + 1);
  }, [clearWorkspace, settings]);
  const clearConnectionFeedback = useCallback(() => {
    if (consoleMode !== 'connect') return;
    setStatus('ready');
    setConnectionIssue(null);
    setMessage(t('未连接后台。'));
  }, [consoleMode]);
  const onApiBaseChange = useCallback((value: string) => {
    authVersion.current += 1;
    clearWorkspace();
    setSettings(current => ({
      ...current,
      apiBase: value
    }));
    clearConnectionFeedback();
  }, [clearConnectionFeedback, clearWorkspace]);
  const onAdminTokenChange = useCallback((value: string) => {
    authVersion.current += 1;
    clearWorkspace();
    setSettings(current => ({
      ...current,
      adminToken: value
    }));
    clearConnectionFeedback();
  }, [clearConnectionFeedback, clearWorkspace]);
  const onMessage = useCallback((nextMessage: string) => {
    setMessage(t(nextMessage));
    setNotice({ message: t(nextMessage), key: Date.now() });
  }, []);
  useEffect(() => {
    if (consoleMode !== 'console') return;
    let cancelled = false;
    let verifying = false;
    const invalidate = () => {
      authVersion.current += 1;
      clearWorkspace();
      setConsoleMode('connect');
      setConnectionIssue('adminToken');
      setMessage(t('管理员口令不正确，请重新输入。'));
      setLinkOk(false);
      setStatus('ready');
    };
    const unsubscribe = subscribeAuthenticationFailures(failure => {
      if (cancelled || failure.apiBase !== settings.apiBase.trim().replace(/\/$/, '') || failure.adminToken !== settings.adminToken.trim()) return;
      if (failure.path === '/api/v1/system/config') { invalidate(); return; }
      // Upstream probes can return 401 too; verify the admin session before expiring it.
      if (verifying) return;
      verifying = true;
      const generation = authVersion.current;
      void loadSystemConfig(settings).catch(error => {
        if (!cancelled && generation === authVersion.current && error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) invalidate();
      }).finally(() => { verifying = false; });
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [clearWorkspace, consoleMode, settings]);

  useEffect(() => {
    if (settings.adminToken.trim()) void refreshData();
    return () => { authVersion.current += 1; workspaceVersion.current += 1; };
  }, []);
  const data = useMemo<AppDataContext>(() => ({
    settings,
    providers,
    providersLoaded,
    providerGroups,
    apiKeys,
    systemConfig,
    runtimeSettings,
    runtimeEnvPreview,
    status,
    linkOk,
    message,
    refreshKey,
    loadProviders,
    loadApiKeys,
    loadSettings,
    onApiBaseChange,
    onAdminTokenChange,
    onRefresh: refreshData,
    onLogout: logout,
    onMessage
  }), [
    apiKeys,
    linkOk,
    loadApiKeys,
    loadSettings,
    loadProviders,
    logout,
    message,
    providerGroups,
    onAdminTokenChange,
    onApiBaseChange,
    onMessage,
    providers,
    providersLoaded,
    refreshData,
    refreshKey,
    runtimeEnvPreview,
    runtimeSettings,
    settings,
    status,
    systemConfig
  ]);
  if (consoleMode === 'checking' || consoleMode === 'error') return <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 3 }}>
    <Box sx={{ display: 'grid', gap: 2, justifyItems: 'center', maxWidth: 480 }} role="status">
      {consoleMode === 'checking' ? <><CircularProgress size={28} /><Typography>{t('正在恢复连接…')}</Typography></> : <>
        <Alert severity="error">{message}</Alert>
        <Button onClick={() => void refreshData()}>{t('重试')}</Button>
        <Button variant="outline" onClick={() => setConsoleMode('connect')}>{t('修改连接')}</Button>
      </>}
    </Box>
  </Box>;
  return consoleMode === 'console' ? (
      <TopShell data={data}>
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage data={data} />} />
          <Route path="/keys" element={<KeysRoutePage data={data} />} />
          <Route path="/logs" element={<LogsRoutePage data={data} />} />
          <Route path="/upstreams" element={<UpstreamsPage data={data} />} />
          <Route path="/oauth" element={<OAuthRoutePage data={data} />} />
          <Route path="/models/*" element={<ModelsRoutePage data={data} />} />
          <Route path="/notifications" element={<NotificationsRoutePage data={data} />} />
          <Route path="/settings" element={<SettingsRoutePage data={data} />} />
          <Route path="/usage" element={<Navigate to="/overview" replace />} />
          <Route path="/prices" element={<LegacyPricesRedirect />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
        <Snackbar key={notice?.key} open={!!notice} autoHideDuration={6000} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          onClose={(_, reason) => { if (reason !== 'clickaway') setNotice(null); }} message={notice?.message}
          action={<IconButton size="small" aria-label={t('关闭提示')} onClick={() => setNotice(null)} sx={{ color: 'inherit' }}><X size={16} /></IconButton>} />
      </TopShell>
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
function LegacyPricesRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/models/prices${search}`} replace />;
}
export default function Root() {
  return <BrowserRouter><ConsoleRoot /></BrowserRouter>;
}
