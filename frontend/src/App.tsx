import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers";
import {
KeyboardSensor,
PointerActivationConstraints,
PointerSensor,
} from "@dnd-kit/dom";
import {
DragDropProvider,
DragOverlay,
type DragEndEvent,
} from "@dnd-kit/react";
import { isSortable,useSortable } from "@dnd-kit/react/sortable";
import type { SvgIconComponent } from "@mui/icons-material";
import ArrowRight from "@mui/icons-material/ArrowForwardOutlined";
import X from "@mui/icons-material/CloseOutlined";
import Server from "@mui/icons-material/DnsOutlined";
import GripVertical from "@mui/icons-material/DragIndicatorOutlined";
import ListFilter from "@mui/icons-material/FilterListOutlined";
import Fingerprint from "@mui/icons-material/FingerprintOutlined";
import Activity from "@mui/icons-material/InsightsOutlined";
import KeyRound from "@mui/icons-material/KeyOutlined";
import LogOut from "@mui/icons-material/LogoutOutlined";
import Menu from "@mui/icons-material/MenuOutlined";
import Bell from "@mui/icons-material/NotificationsOutlined";
import RefreshCw from "@mui/icons-material/RefreshOutlined";
import Settings from "@mui/icons-material/SettingsOutlined";
import SquareTerminal from "@mui/icons-material/TerminalOutlined";
import ShieldCheck from "@mui/icons-material/VerifiedUserOutlined";
import Boxes from "@mui/icons-material/ViewInArOutlined";
import EyeOff from "@mui/icons-material/VisibilityOffOutlined";
import Eye from "@mui/icons-material/VisibilityOutlined";
import AppBar from "@mui/material/AppBar";
import Chip from "@mui/material/Chip";
import ListItemButton from "@mui/material/ListItemButton";
import MenuItem from "@mui/material/MenuItem";
import Skeleton from "@mui/material/Skeleton";
import { useColorScheme } from "@mui/material/styles";
import Toolbar from "@mui/material/Toolbar";
import {
lazy,
Suspense,
useCallback,
useEffect,
useMemo,
useRef,
useState,
type ReactNode,
} from "react";
import {
createBrowserRouter,
Link,
Navigate,
Route,
RouterProvider,
Routes,
useLocation,
} from "react-router";

import { ApiKeysPage } from "@/components/ApiKeysPage";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { LogsPage } from "@/components/LogsPage";
import { ModelsPage } from "@/components/ModelsPage";
import { NotificationsPage } from "@/components/NotificationsPage";
import { OAuthPage } from "@/components/OAuthPage";
import { ProvidersPage } from "@/components/ProvidersPage";
import { SettingsPage } from "@/components/SettingsPage";
import {
ApiRequestError,
loadApiKeyWorkspace,
loadProviderWorkspace,
loadRuntimeSettings,
loadSystemConfig,
previewRuntimeEnv,
subscribeAuthenticationFailures,
} from "@/lib/api";
import { formatCommitShort,formatVersionLabel } from "@/lib/format";
import { t,useI18n } from "@/lib/i18n";
import type {
ApiKeyWorkspace,
ConnectionSettings,
ProviderGroup,
ProviderWorkspace,
RuntimeEnvPreviewResponse,
RuntimeSettingsResponse,
SystemConfigResponse,
} from "@/lib/types";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Snackbar from "@mui/material/Snackbar";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
const OverviewPage = lazy(() => import("@/components/OverviewPage"));
type LoadState = "idle" | "loading" | "ready";
type ConsoleMode = "connect" | "checking" | "console" | "error";
type ConnectionIssue = "apiBase" | "adminToken" | "general" | null;
interface ConnectionFailure {
  issue: Exclude<ConnectionIssue, null>;
  message: string;
}
export interface AppDataContext {
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
const API_BASE_KEY = "little_gate_api_base";
const ADMIN_TOKEN_KEY = "little_gate_admin_token";
const NAV_ORDER_KEY = "little_gate_nav_order";
const NAV_ITEMS_BY_KEY = {
  overview: {
    to: "/overview",
    label: "总览",
    icon: Activity,
  },
  upstreams: {
    to: "/upstreams",
    label: "上游",
    icon: Server,
  },
  oauth: {
    to: "/oauth",
    label: "OAuth 登录",
    icon: Fingerprint,
  },
  models: {
    to: "/models",
    label: "模型",
    icon: Boxes,
  },
  logs: {
    to: "/logs",
    label: "日志",
    icon: ListFilter,
  },
  keys: {
    to: "/keys",
    label: "访问密钥",
    icon: KeyRound,
  },
  notifications: {
    to: "/notifications",
    label: "通知",
    icon: Bell,
  },
  settings: {
    to: "/settings",
    label: "设置",
    icon: Settings,
  },
} as const;
type NavKey = keyof typeof NAV_ITEMS_BY_KEY;
const DEFAULT_NAV_ORDER: NavKey[] = [
  "overview",
  "upstreams",
  "oauth",
  "models",
  "logs",
  "keys",
  "notifications",
  "settings",
];
const NAVIGATION_SORTABLE_TYPE = "primary-navigation";
const NAVIGATION_SORT_INSTRUCTIONS_ID = "primary-nav-sort-instructions";
const NAVIGATION_SORT_TRANSITION = {
  duration: 180,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  idle: true,
};
const NAVIGATION_DROP_ANIMATION = {
  duration: 160,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
};
const NAVIGATION_DRAG_SENSORS = [
  PointerSensor.configure({
    activationConstraints(event) {
      if (event.pointerType === "touch") {
        return [
          new PointerActivationConstraints.Delay({
            value: 180,
            tolerance: 8,
          }),
        ];
      }
      return [
        new PointerActivationConstraints.Distance({
          value: 6,
        }),
      ];
    },
  }),
  KeyboardSensor.configure({
    keyboardCodes: {
      start: ["Space"],
      cancel: ["Escape"],
      end: ["Space", "Enter", "Tab"],
      up: ["ArrowUp"],
      down: ["ArrowDown"],
      left: ["ArrowLeft"],
      right: ["ArrowRight"],
    },
    offset: {
      x: 0,
      y: 52,
    },
  }),
];
const NAVIGATION_DRAG_MODIFIERS = [RestrictToVerticalAxis];
interface NavigationItemView {
  key: NavKey;
  to: string;
  label: string;
  icon: SvgIconComponent;
}
function defaultApiBase() {
  if (typeof window === "undefined") return "http://127.0.0.1:18080";
  return window.location.origin;
}
function readSettings(): ConnectionSettings {
  if (typeof window === "undefined") {
    return {
      apiBase: defaultApiBase(),
      adminToken: "",
    };
  }
  return {
    apiBase: window.localStorage.getItem(API_BASE_KEY) ?? defaultApiBase(),
    adminToken: window.sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "",
  };
}
function persistSettings(settings: ConnectionSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(API_BASE_KEY, settings.apiBase);
  window.sessionStorage.setItem(ADMIN_TOKEN_KEY, settings.adminToken);
}
function describeConnectionFailure(error: unknown): ConnectionFailure {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) {
      return {
        issue: "adminToken",
        message: t("管理员口令不正确，请重新输入。"),
      };
    }
    if (error.status === 404) {
      return {
        issue: "apiBase",
        message: t("未找到管理接口，请检查服务地址。"),
      };
    }
    if (error.status >= 500) {
      return {
        issue: "general",
        message: t("服务暂时不可用，请稍后重试。"),
      };
    }
  }
  if (error instanceof TypeError) {
    return {
      issue: "apiBase",
      message: t("无法连接服务，请检查服务地址和网络后重试。"),
    };
  }
  return {
    issue: "general",
    message: t("登录失败，请检查服务地址后重试。"),
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
  if (!ordered.includes("models")) {
    const upstreamIndex = ordered.indexOf("upstreams");
    const logsIndex = ordered.indexOf("logs");
    const insertAt =
      upstreamIndex >= 0
        ? upstreamIndex + 1
        : logsIndex >= 0
          ? logsIndex
          : ordered.length;
    ordered.splice(insertAt, 0, "models");
  }
  if (!ordered.includes("oauth")) {
    const upstreamIndex = ordered.indexOf("upstreams");
    const modelsIndex = ordered.indexOf("models");
    const insertAt =
      upstreamIndex >= 0
        ? upstreamIndex + 1
        : modelsIndex >= 0
          ? modelsIndex
          : ordered.length;
    ordered.splice(insertAt, 0, "oauth");
  }
  for (const value of DEFAULT_NAV_ORDER) {
    if (!ordered.includes(value)) {
      ordered.push(value);
    }
  }
  return ordered;
}
function readNavOrder(): NavKey[] {
  if (typeof window === "undefined") return DEFAULT_NAV_ORDER;
  const raw = window.localStorage.getItem(NAV_ORDER_KEY);
  if (!raw) return DEFAULT_NAV_ORDER;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeNavOrder(
        parsed.filter((item): item is string => typeof item === "string"),
      );
    }
  } catch {
    return DEFAULT_NAV_ORDER;
  }
  return DEFAULT_NAV_ORDER;
}
function persistNavOrder(order: NavKey[]) {
  if (typeof window === "undefined") return;
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
  return (
    <>
      <Box
        sx={{
          ...{
            display: "flex",
            width: "2rem",
            height: "2rem",
            flexShrink: "0",
            alignItems: "center",
            justifyContent: "center",
          },
          ...(props.active || props.overlay
            ? { color: "var(--mui-palette-primary-main)" }
            : { color: "var(--mui-palette-text-secondary)" }),
          ...{},
        }}
        aria-hidden="true"
        component="span"
      >
        <Icon fontSize="small" />
      </Box>
      <Box
        sx={{
          minWidth: "0",
          flex: "1",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        component="span"
      >
        {t(props.item.label)}
      </Box>
      <Box
        sx={
          props.overlay
            ? { color: "var(--mui-palette-primary-main)" }
            : { color: "var(--mui-palette-text-secondary)" }
        }
        aria-hidden="true"
        component="span"
      >
        <GripVertical fontSize="small" />
      </Box>
    </>
  );
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
    transition: props.reducedMotion ? null : NAVIGATION_SORT_TRANSITION,
  });
  return (
    <ListItemButton
      selected={props.active}
      style={{ flexGrow: 0 }}
      ref={ref}
      component={Link}
      to={props.item.to}
      onClick={props.onNavigate}
      aria-current={props.active ? "page" : undefined}
      aria-describedby={NAVIGATION_SORT_INSTRUCTIONS_ID}
      aria-keyshortcuts="Space ArrowUp ArrowDown"
      data-nav-key={props.item.key}
      data-nav-sortable="true"
      data-nav-dragging={isDragSource ? "true" : undefined}
      data-nav-drop-target={isDropTarget ? "true" : undefined}
      sx={[
        {
          ...{
            position: "relative",
            display: "flex",
            minHeight: "2.75rem",
            width: "100%",
            cursor: "grab",
            WebkitUserSelect: "none",
            userSelect: "none",
            alignItems: "center",
            gap: "0.5rem",
            borderRadius: "8px",
            borderStyle: "solid",
            borderWidth: "1px",
            paddingInline: "0.5rem",
            paddingBlock: "0.375rem",
            fontSize: "0.875rem",
            fontWeight: "500",
            outlineStyle: "none",
            transitionProperty:
              "background-color,border-color,color,box-shadow,opacity",
            transitionTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
            transitionDuration: "150ms",
            "&:active": { cursor: "grabbing" },
            "@media (prefers-reduced-motion: reduce)": {
              transitionProperty: "none",
            },
          },
          ...(isDragSource
            ? {
                borderColor:
                  "color-mix(in oklab, var(--mui-palette-primary-main) 45%, transparent)",
                backgroundColor:
                  "color-mix(in oklab, var(--mui-palette-primary-main) 10%, transparent)",
                color: "var(--mui-palette-primary-main)",
                opacity: "0.32",
              }
            : isDropTarget
              ? {
                  borderColor:
                    "color-mix(in oklab, var(--mui-palette-primary-main) 45%, transparent)",
                  backgroundColor:
                    "color-mix(in oklab, var(--mui-palette-primary-main) 10%, transparent)",
                  color: "var(--mui-palette-primary-main)",
                }
              : props.active
                ? {
                    borderColor:
                      "color-mix(in oklab, var(--mui-palette-primary-main) 10%, transparent)",
                    backgroundColor:
                      "color-mix(in oklab, var(--mui-palette-primary-main) 8%, transparent)",
                    fontWeight: "600",
                    color: "var(--mui-palette-primary-main)",
                  }
                : {
                    borderColor: "transparent",
                    color: "var(--mui-palette-text-secondary)",
                    "&:hover": {
                      "@media (hover: hover)": {
                        backgroundColor:
                          "color-mix(in oklab, var(--mui-palette-action-hover) 60%, transparent)",
                        color: "var(--mui-palette-text-primary)",
                      },
                    },
                  }),
          ...{},
          ...(isDropping ? { pointerEvents: "none" } : {}),
          ...{},
        },
        {
          WebkitTapHighlightColor: "transparent",
          "&:focus-visible": {
            outline: "2px solid var(--mui-palette-primary-main)",
            outlineOffset: "-2px",
          },
        },
      ]}
    >
      <NavigationItemContent item={props.item} active={props.active} />
    </ListItemButton>
  );
}
function NavigationDragPreview(props: {
  item: NavigationItemView;
  index: number;
  active: boolean;
}) {
  return (
    <Box
      aria-hidden="true"
      sx={[
        {
          display: "flex",
          minHeight: "2.5rem",
          width: "100%",
          alignItems: "center",
          gap: "0.5rem",
          borderRadius: "8px",
          borderStyle: "solid",
          borderWidth: "1px",
          borderColor:
            "color-mix(in oklab, var(--mui-palette-primary-main) 50%, transparent)",
          backgroundColor: "var(--mui-palette-background-paper)",
          paddingInline: "0.5rem",
          paddingBlock: "0.375rem",
          fontSize: "0.875rem",
          fontWeight: "600",
          color: "var(--mui-palette-primary-main)",
        },
        {
          boxShadow:
            "0 12px 28px -20px rgb(0 0 0 / 0.38), 0 6px 14px -12px rgb(0 0 0 / 0.24)",
          transform: "scale(1.015)",
        },
      ]}
    >
      <NavigationItemContent item={props.item} active={props.active} overlay />
    </Box>
  );
}
function pageDescription(pathname: string) {
  if (pathname.startsWith("/overview")) return "查看请求、用量与响应表现。";
  if (pathname.startsWith("/keys")) return "创建和管理访问密钥。";
  if (pathname.startsWith("/logs")) return "筛选并排查最近请求。";
  if (pathname.startsWith("/models")) return "管理模型库存、路由别名与价格。";
  if (pathname.startsWith("/upstreams")) return "查看连接目标与健康状态。";
  if (pathname.startsWith("/oauth"))
    return "登录并管理 OpenAI Codex OAuth 账号。";
  if (pathname.startsWith("/notifications"))
    return "配置定时报表、阈值告警与投递通道。";
  if (pathname.startsWith("/settings")) return "维护连接信息与高级设置。";
  return "";
}
function TopShell(props: { data: AppDataContext; children: ReactNode }) {
  const { t } = useI18n();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { mode, setMode } = useColorScheme();
  const compact = useMediaQuery("(max-width: 1199.95px)", { noSsr: true });
  const closeNavigation = () => setNavigationOpen(false);
  const [navOrder, setNavOrder] = useState<NavKey[]>(readNavOrder);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", {
    noSsr: true,
  });
  const navItems = useMemo<NavigationItemView[]>(
    () =>
      [
        ...navOrder.filter(
          (key) => key !== "notifications" && key !== "settings",
        ),
        ...navOrder.filter(
          (key) => key === "notifications" || key === "settings",
        ),
      ].map((key) => ({
        key,
        ...NAV_ITEMS_BY_KEY[key],
      })),
    [navOrder],
  );
  const currentItem =
    navItems.find((item) => location.pathname.startsWith(item.to)) ??
    NAV_ITEMS_BY_KEY.overview;
  const serviceVersion = formatVersionLabel(
    props.data.systemConfig?.build?.version,
  );
  const serviceCommit = formatCommitShort(
    props.data.systemConfig?.build?.commit,
  );
  const serviceCommitTitle = (() => {
    const commit = props.data.systemConfig?.build?.commit?.trim();
    return commit && commit !== "unknown" ? commit : undefined;
  })();
  const reorderNav = useCallback((event: DragEndEvent) => {
    if (event.canceled) return;
    const source = event.operation.source;
    if (!isSortable(source)) return;
    const sourceKey = String(source.id);
    if (!isNavKey(sourceKey)) return;
    const targetIndex = source.index;
    if (source.initialIndex === targetIndex) return;
    setNavOrder((current) => {
      const grouped = [
        ...current.filter(
          (key) => key !== "notifications" && key !== "settings",
        ),
        ...current.filter(
          (key) => key === "notifications" || key === "settings",
        ),
      ];
      const sameSection = (key: NavKey) =>
        (key === "notifications" || key === "settings") ===
        (sourceKey === "notifications" || sourceKey === "settings");
      if (!grouped[targetIndex] || !sameSection(grouped[targetIndex]))
        return current;
      const next = moveNavKey(grouped, sourceKey, targetIndex);
      if (next === current) return current;
      persistNavOrder(next);
      return next;
    });
  }, []);
  const sidebar = (
    <Box
      sx={{
        display: "flex",
        height: "100dvh",
        width: "240px",
        flexShrink: 0,
        flexDirection: "column",
        padding: "24px 16px",
        backgroundColor: "var(--mui-palette-background-paper)",
      }}
      component="aside"
    >
      <Box
        sx={{
          marginBottom: "2rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          paddingInline: "0.5rem",
        }}
      >
        <Box
          component={Link}
          to="/overview"
          onClick={closeNavigation}
          sx={{
            display: "flex",
            minWidth: "0",
            alignItems: "center",
            gap: "0.75rem",
          }}
        >
          <Box
            sx={{
              display: "flex",
              width: "2.5rem",
              height: "2.5rem",
              flexShrink: "0",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "8px",
              backgroundColor: "var(--mui-palette-primary-main)",
              color: "var(--mui-palette-primary-contrastText)",
              boxShadow: "0 3px 8px -3px rgb(54 89 207 / 0.45)",
            }}
          >
            <SquareTerminal fontSize="small" />
          </Box>
          <Box sx={{ minWidth: "0" }}>
            <Box
              sx={{
                fontSize: "0.9375rem",
                fontWeight: "700",
                letterSpacing: "0.025em",
                color: "var(--mui-palette-text-primary)",
              }}
              component="p"
            >
              LITTLE GATE
            </Box>
            <Box
              sx={{
                marginTop: "0.125rem",
                fontSize: "0.75rem",
                lineHeight: "calc(1 / 0.75)",
                color: "var(--mui-palette-text-secondary)",
              }}
              component="p"
            >
              {t("网关控制台")}
            </Box>
          </Box>
        </Box>
        {compact ? (
          <IconButton aria-label={t("关闭导航")} onClick={closeNavigation}>
            <X fontSize="small" />
          </IconButton>
        ) : null}
      </Box>
      <DragDropProvider
        sensors={NAVIGATION_DRAG_SENSORS}
        modifiers={NAVIGATION_DRAG_MODIFIERS}
        onDragEnd={reorderNav}
      >
        <Box
          sx={{
            display: "flex",
            minHeight: "0",
            flex: "1",
            flexDirection: "column",
            gap: "0.25rem",
            overflowY: "auto",
          }}
          aria-label="Primary"
          component="nav"
        >
          <Box
            id={NAVIGATION_SORT_INSTRUCTIONS_ID}
            sx={{
              position: "absolute",
              width: "1px",
              height: "1px",
              padding: "0",
              margin: "-1px",
              overflow: "hidden",
              clipPath: "inset(50%)",
              whiteSpace: "nowrap",
              borderWidth: "0",
            }}
          >
            {t(
              "拖动任意导航项可调整顺序。键盘操作：按空格开始，使用上下方向键移动，再按空格完成。",
            )}
          </Box>
          <Box
            sx={{
              paddingInline: "0.75rem",
              paddingBottom: "0.5rem",
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
              fontWeight: "500",
              color: "var(--mui-palette-text-secondary)",
            }}
          >
            {t("工作空间")}
          </Box>
          {navItems.slice(0, 6).map((item, index) => (
            <SortableNavigationItem
              key={item.key}
              item={item}
              index={index}
              active={location.pathname.startsWith(item.to)}
              reducedMotion={reducedMotion}
              onNavigate={closeNavigation}
            />
          ))}
          <Box
            sx={{
              paddingInline: "0.75rem",
              paddingBottom: "0.5rem",
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
              fontWeight: "500",
              color: "var(--mui-palette-text-secondary)",
              marginTop: "1.5rem",
            }}
          >
            {t("管理")}
          </Box>
          {navItems.slice(6).map((item, index) => (
            <SortableNavigationItem
              key={item.key}
              item={item}
              index={index + 6}
              active={location.pathname.startsWith(item.to)}
              reducedMotion={reducedMotion}
              onNavigate={closeNavigation}
            />
          ))}
        </Box>
        <DragOverlay
          style={{ pointerEvents: "none", zIndex: 1500 }}
          dropAnimation={reducedMotion ? null : NAVIGATION_DROP_ANIMATION}
        >
          {(source) => {
            const key = String(source.id);
            if (!isNavKey(key)) return null;
            const item = navItems.find((candidate) => candidate.key === key);
            return item ? (
              <NavigationDragPreview
                item={item}
                index={navOrder.indexOf(key)}
                active={location.pathname.startsWith(item.to)}
              />
            ) : null;
          }}
        </DragOverlay>
      </DragDropProvider>
      <Box
        sx={{
          marginTop: "1.25rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          borderTopStyle: "solid",
          borderTopWidth: "1px",
          borderColor: "var(--mui-palette-divider)",
          paddingTop: "1rem",
        }}
      >
        <Box
          sx={{
            borderRadius: "8px",
            borderStyle: "solid",
            borderWidth: "1px",
            borderColor: "var(--mui-palette-divider)",
            backgroundColor: "var(--mui-palette-background-default)",
            padding: "0.75rem",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.5rem",
            }}
          >
            <Box
              sx={{
                fontSize: "0.75rem",
                lineHeight: "calc(1 / 0.75)",
                fontWeight: "500",
                color: "var(--mui-palette-text-secondary)",
              }}
              component="span"
            >
              {t("SYSTEM STATUS")}
            </Box>
            <ConnectionIndicator
              status={props.data.status}
              linkOk={props.data.linkOk}
            />
          </Box>
          <Box
            sx={{
              marginTop: "0.5rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "0.75rem",
              color: "var(--mui-palette-text-secondary)",
            }}
            component="p"
            title={props.data.settings.apiBase}
          >
            {props.data.settings.apiBase}
          </Box>
          <Box
            sx={{
              marginTop: "0.25rem",
              maxHeight: "5rem",
              overflowY: "auto",
              overflowWrap: "break-word",
              fontSize: "0.75rem",
              lineHeight: "1.25rem",
              color: "var(--mui-palette-text-secondary)",
            }}
            component="p"
          >
            {props.data.message}
          </Box>
        </Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.5rem",
            paddingInline: "0.25rem",
          }}
        >
          <Box
            sx={{
              minWidth: "0",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "0.75rem",
              color: "var(--mui-palette-text-secondary)",
            }}
            title={serviceCommitTitle}
            component="span"
          >
            {serviceVersion}
            {serviceCommit !== "—" ? ` · ${serviceCommit}` : ""}
          </Box>
          <Button
            type="button"
            variant="text"
            size="small"
            sx={{ color: "var(--mui-palette-text-secondary)" }}
            onClick={props.data.onLogout}
          >
            <LogOut fontSize="small" />
            {t("退出")}
          </Button>
        </Box>
      </Box>
    </Box>
  );
  return (
    <Box
      sx={{
        minHeight: "100dvh",
        backgroundColor: "var(--mui-palette-background-default)",
      }}
    >
      <Box
        component="a"
        href="#main-content"
        sx={{
          position: "fixed",
          left: "1rem",
          top: "1rem",
          zIndex: "1500",
          transform: "translateY(-150%)",
          borderRadius: "8px",
          backgroundColor: "var(--mui-palette-primary-main)",
          paddingInline: "1rem",
          paddingBlock: "0.75rem",
          color: "var(--mui-palette-primary-contrastText)",
          "&:focus": { transform: "translateY(0)" },
        }}
      >
        {t("跳转到内容")}
      </Box>
      <Box
        sx={{
          display: "flex",
          minHeight: "100dvh",
          width: "100%",
          flexDirection: { xs: "column", lg: "row" },
          alignItems: "flex-start",
        }}
      >
        {compact ? (
          <>
            <AppBar
              position="sticky"
              color="inherit"
              elevation={0}
              sx={{
                bgcolor: "background.paper",
                borderBottom: 1,
                borderColor: "divider",
              }}
            >
              <Toolbar
                sx={{ width: "100%", justifyContent: "space-between", gap: 2 }}
              >
                <Box
                  sx={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                >
                  <IconButton
                    aria-label={t("打开导航")}
                    aria-expanded={navigationOpen}
                    aria-controls={
                      navigationOpen ? "mobile-navigation" : undefined
                    }
                    onClick={() => setNavigationOpen(true)}
                  >
                    <Menu fontSize="small" />
                  </IconButton>
                  <Box
                    sx={{
                      fontSize: "0.875rem",
                      lineHeight: "calc(1.25 / 0.875)",
                      fontWeight: "700",
                      letterSpacing: "0.025em",
                    }}
                    component="span"
                  >
                    LITTLE GATE
                  </Box>
                </Box>
                <ConnectionIndicator
                  status={props.data.status}
                  linkOk={props.data.linkOk}
                />
              </Toolbar>
            </AppBar>
            <Drawer
              open={navigationOpen}
              onClose={closeNavigation}
              slotProps={{
                paper: {
                  id: "mobile-navigation",
                  role: "dialog",
                  "aria-modal": true,
                  "aria-label": t("主导航"),
                  sx: {
                    width: 280,
                    maxWidth: "calc(100vw - 32px)",
                    "& > aside": { width: "100%", borderRight: 0 },
                  },
                },
              }}
            >
              {sidebar}
            </Drawer>
          </>
        ) : (
          <Drawer
            variant="permanent"
            sx={{
              width: 240,
              flexShrink: 0,
              "& .MuiDrawer-paper": { width: 240, boxSizing: "border-box" },
            }}
          >
            {sidebar}
          </Drawer>
        )}
        <Box
          sx={{
            minWidth: 0,
            flex: 1,
            width: "100%",
            padding: { xs: "16px", md: "24px" },
          }}
          component="main"
          id="main-content"
          tabIndex={-1}
        >
          <Box
            sx={{
              marginInline: "auto",
              display: "flex",
              width: "100%",
              maxWidth: "1600px",
              flexDirection: "column",
              gap: "1.5rem",
            }}
          >
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: "1rem",
                "@media (width >= 48rem)": {
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                },
              }}
              component="header"
            >
              <Box sx={{ minWidth: "0" }}>
                <Box
                  sx={{
                    fontSize: "1.5rem",
                    lineHeight: "calc(2 / 1.5)",
                    fontWeight: "600",
                    letterSpacing: "-0.025em",
                    color: "var(--mui-palette-text-primary)",
                  }}
                  component="h1"
                >
                  {t(currentItem.label)}
                </Box>
                <Box
                  sx={{
                    marginTop: "0.375rem",
                    maxWidth: "48rem",
                    fontSize: "0.875rem",
                    lineHeight: "1.5rem",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                  component="p"
                >
                  {t(pageDescription(location.pathname))}
                </Box>
              </Box>
              <Box
                sx={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <TextField
                  select
                  label={t("外观")}
                  value={mode ?? "system"}
                  onChange={(event) =>
                    setMode(event.target.value as "system" | "light" | "dark")
                  }
                  sx={{ width: 130 }}
                >
                  <MenuItem value="system">{t("跟随系统")}</MenuItem>
                  <MenuItem value="light">{t("浅色")}</MenuItem>
                  <MenuItem value="dark">{t("深色")}</MenuItem>
                </TextField>
                <LocaleSwitch />
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => void props.data.onRefresh()}
                  disabled={props.data.status === "loading"}
                >
                  <RefreshCw
                    sx={
                      props.data.status === "loading"
                        ? {
                            animation: "none",
                            "@media (prefers-reduced-motion: reduce)": {
                              animation: "none",
                            },
                          }
                        : {}
                    }
                    fontSize="small"
                  />
                  {t(props.data.status === "loading" ? "同步中" : "SYNC")}
                </Button>
              </Box>
            </Box>
            {props.children}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
/** 连接指示器必须反映真实状态：绿=后台可达，琥珀=请求进行中，红=最近一次请求失败。 */
function ConnectionIndicator(props: { status: LoadState; linkOk: boolean }) {
  if (props.status === "loading")
    return (
      <Chip
        color={
          (
            {
              normal: "success",
              warning: "warning",
              error: "error",
              disabled: "default",
              draft: "default",
              archived: "default",
            } as const
          )["warning"]
        }
        label={t("同步中")}
      />
    );
  if (!props.linkOk)
    return (
      <Chip
        color={
          (
            {
              normal: "success",
              warning: "warning",
              error: "error",
              disabled: "default",
              draft: "default",
              archived: "default",
            } as const
          )["error"]
        }
        label={t("连接异常")}
      />
    );
  return (
    <Chip
      color={
        (
          {
            normal: "success",
            warning: "warning",
            error: "error",
            disabled: "default",
            draft: "default",
            archived: "default",
          } as const
        )["normal"]
      }
      label={t("已连接")}
    />
  );
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
  const connecting = props.status === "loading";
  useEffect(() => {
    if (props.issue === "apiBase") apiBaseInputRef.current?.focus();
    if (props.issue === "adminToken") adminTokenInputRef.current?.focus();
  }, [props.issue]);
  return (
    <Box
      sx={{
        display: "flex",
        minHeight: "100dvh",
        flexDirection: "column",
        padding: "24px",
      }}
    >
      <Box
        component="header"
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.875rem",
            lineHeight: "calc(1.25 / 0.875)",
            fontWeight: "500",
            color: "var(--mui-palette-text-secondary)",
          }}
        >
          <SquareTerminal fontSize="small" />
          <Box component="span">little-gate</Box>
        </Box>
        <LocaleSwitch />
      </Box>
      <Box
        sx={{
          display: "flex",
          flex: "1",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
          paddingBlock: "2.5rem",
          "@media (width >= 40rem)": { paddingBlock: "4rem" },
        }}
      >
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1rem",
            textAlign: "center",
          }}
        >
          <Box
            sx={{
              display: "flex",
              width: "3rem",
              height: "3rem",
              flexShrink: "0",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "8px",
              backgroundColor: "var(--mui-palette-primary-main)",
              color: "var(--mui-palette-primary-contrastText)",
              boxShadow: "0 3px 8px -3px rgb(54 89 207 / 0.45)",
            }}
          >
            <SquareTerminal fontSize="small" />
          </Box>
          <Box>
            <Box
              sx={{
                fontSize: "1.5rem",
                lineHeight: "calc(2 / 1.5)",
                fontWeight: "700",
                letterSpacing: "0.025em",
                color: "var(--mui-palette-text-primary)",
              }}
              component="h1"
            >
              LITTLE GATE
            </Box>
            <Box
              sx={{
                marginTop: "0.5rem",
                fontSize: "0.875rem",
                lineHeight: "calc(1.25 / 0.875)",
                color: "var(--mui-palette-text-secondary)",
              }}
              component="p"
            >
              {t("模型、流量与连接，尽在掌握。")}
            </Box>
          </Box>
        </Box>
        <Card
          sx={{
            width: "100%",
            maxWidth: "460px",
            borderRadius: "8px",
            borderStyle: "solid",
            borderWidth: "1px",
            borderColor: "var(--mui-palette-divider)",
            backgroundColor: "var(--mui-palette-background-paper)",
            boxShadow: "0 8px 32px rgb(0 0 0 / 0.2)",
          }}
        >
          <Box
            sx={{
              paddingInline: "1.5rem",
              paddingBottom: "1.25rem",
              paddingTop: "1.75rem",
              "@media (width >= 40rem)": {
                paddingInline: "2rem",
                paddingTop: "2rem",
              },
            }}
          >
            <Typography
              sx={{
                fontSize: "1rem",
                lineHeight: "calc(1.75 / 1.125)",
                fontWeight: "600",
                color: "var(--mui-palette-text-primary)",
              }}
              component="h2"
            >
              {t("登录控制台")}
            </Typography>
            <Typography
              sx={{
                marginTop: "0.375rem",
                fontSize: "0.875rem",
                lineHeight: "1.5rem",
                color: "var(--mui-palette-text-secondary)",
              }}
            >
              {t("输入管理员口令以验证身份。")}
            </Typography>
          </Box>
          <CardContent
            sx={{
              paddingInline: "1.5rem",
              paddingBottom: "1.75rem",
              "@media (width >= 40rem)": {
                paddingInline: "2rem",
                paddingBottom: "2rem",
              },
            }}
          >
            <Box
              sx={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}
              aria-busy={connecting}
              component="form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!connecting) void props.onRefresh();
              }}
            >
              <Box
                sx={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
              >
                <TextField
                  id="connection-api-base"
                  value={props.settings.apiBase}
                  disabled={connecting}
                  error={props.issue === "apiBase"}
                  inputRef={apiBaseInputRef}
                  autoComplete="url"
                  onChange={(event) =>
                    props.onApiBaseChange(event.target.value)
                  }
                  placeholder={t("http://127.0.0.1:8080")}
                  sx={{
                    height: "2.75rem",
                    fontSize: "0.875rem",
                  }}
                  label={t("服务地址")}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <Server
                          fontSize="small"
                          sx={{
                            flexShrink: "0",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        />
                      ),
                    },
                    htmlInput: {
                      ...{
                        "aria-describedby": "connection-status-message",
                        "aria-invalid": props.issue === "apiBase",
                      },
                      autoCapitalize: "none",
                      spellCheck: false,
                    },
                  }}
                />
              </Box>
              <Box
                sx={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
              >
                <TextField
                  id="connection-admin-token"
                  type={showToken ? "text" : "password"}
                  value={props.settings.adminToken}
                  disabled={connecting}
                  error={props.issue === "adminToken"}
                  inputRef={adminTokenInputRef}
                  autoComplete="current-password"
                  onChange={(event) =>
                    props.onAdminTokenChange(event.target.value)
                  }
                  placeholder={t("输入管理员口令")}
                  sx={{
                    height: "2.75rem",
                    fontSize: "0.875rem",
                  }}
                  label={t("管理员口令")}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <KeyRound
                          fontSize="small"
                          sx={{
                            flexShrink: "0",
                            color: "var(--mui-palette-text-secondary)",
                          }}
                        />
                      ),
                      endAdornment: (
                        <IconButton
                          type="button"
                          aria-label={t(showToken ? "隐藏口令" : "显示口令")}
                          aria-pressed={showToken}
                          disabled={connecting}
                          onClick={() => setShowToken((value) => !value)}
                          edge="end"
                        >
                          {showToken ? (
                            <EyeOff fontSize="small" />
                          ) : (
                            <Eye fontSize="small" />
                          )}
                        </IconButton>
                      ),
                    },
                    htmlInput: {
                      ...{
                        "aria-describedby":
                          "connection-status-message token-storage-hint",
                        "aria-invalid": props.issue === "adminToken",
                      },
                      autoCapitalize: "none",
                      spellCheck: false,
                    },
                  }}
                />
                <Typography
                  id="token-storage-hint"
                  sx={{
                    fontSize: "0.75rem",
                    lineHeight: "calc(1 / 0.75)",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                >
                  {t("只保存在当前标签页。")}
                </Typography>
              </Box>
              {props.issue ? (
                <Alert severity="error" role="alert">
                  <AlertTitle>{t("登录失败")}</AlertTitle>
                  <Box id="connection-status-message">{props.message}</Box>
                </Alert>
              ) : (
                <Box
                  id="connection-status-message"
                  role="status"
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    fontSize: "0.75rem",
                    lineHeight: "calc(1 / 0.75)",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                >
                  <Box
                    component="span"
                    sx={{
                      width: "0.375rem",
                      height: "0.375rem",
                      borderRadius: "999px",
                      backgroundColor:
                        "color-mix(in oklab, var(--mui-palette-text-secondary) 60%, transparent)",
                    }}
                  />
                  {props.message}
                </Box>
              )}
              <Button
                loading={Boolean(connecting)}
                type="submit"
                disabled={connecting}
                sx={{
                  height: "2.75rem",
                  width: "100%",
                  fontSize: "0.875rem",
                  lineHeight: "calc(1.25 / 0.875)",
                }}
              >
                {connecting ? (
                  <RefreshCw
                    fontSize="small"
                    sx={{
                      animation: "none",
                      "@media (prefers-reduced-motion: reduce)": {
                        animation: "none",
                      },
                    }}
                  />
                ) : null}
                {t(connecting ? "CONNECTING..." : "ENTER CONSOLE")}
                {!connecting ? <ArrowRight fontSize="small" /> : null}
              </Button>
            </Box>
          </CardContent>
        </Card>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.75rem",
            lineHeight: "calc(1 / 0.75)",
            color: "var(--mui-palette-text-secondary)",
          }}
        >
          <ShieldCheck fontSize="small" aria-hidden="true" />
          {t("统一接入 · 灵活路由 · 用量可见")}
        </Box>
      </Box>
    </Box>
  );
}
function UpstreamsPage(props: { data: AppDataContext }) {
  useEffect(() => {
    if (!props.data.providersLoaded) void props.data.loadProviders();
  }, [props.data.loadProviders]);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <ProvidersPage
        loading={!props.data.providersLoaded}
        settings={props.data.settings}
        items={props.data.providers}
        onRefresh={props.data.loadProviders}
        onMessage={props.data.onMessage}
      />
    </Box>
  );
}
function OAuthRoutePage(props: { data: AppDataContext }) {
  useEffect(() => {
    void props.data.loadProviders();
  }, [props.data.loadProviders]);
  return (
    <OAuthPage
      settings={props.data.settings}
      items={props.data.providers}
      loading={props.data.status === "loading"}
      onRefresh={props.data.loadProviders}
      onMessage={props.data.onMessage}
    />
  );
}
function KeysRoutePage(props: { data: AppDataContext }) {
  useEffect(() => {
    if (props.data.apiKeys.length === 0) {
      void props.data.loadApiKeys();
    }
  }, [props.data.apiKeys.length, props.data.loadApiKeys]);
  return (
    <ApiKeysPage
      settings={props.data.settings}
      items={props.data.apiKeys}
      providers={props.data.providers}
      onRefresh={props.data.loadApiKeys}
      onMessage={props.data.onMessage}
    />
  );
}
function LogsRoutePage(props: { data: AppDataContext }) {
  useEffect(() => {
    if (props.data.providers.length === 0) {
      void props.data.loadProviders();
    }
    if (props.data.apiKeys.length === 0) {
      void props.data.loadApiKeys();
    }
  }, [
    props.data.apiKeys.length,
    props.data.loadApiKeys,
    props.data.loadProviders,
    props.data.providers.length,
  ]);
  return (
    <LogsPage
      settings={props.data.settings}
      providers={props.data.providers}
      apiKeys={props.data.apiKeys}
      refreshKey={props.data.refreshKey}
      onMessage={props.data.onMessage}
    />
  );
}
function ModelsRoutePage({ data }: { data: AppDataContext }) {
  useEffect(() => {
    if (!data.providersLoaded) void data.loadProviders();
  }, [data.loadProviders]);
  return (
    <ModelsPage
      settings={data.settings}
      providers={data.providers}
      refreshKey={data.refreshKey}
      onMessage={data.onMessage}
    />
  );
}
function SettingsRoutePage({ data }: { data: AppDataContext }) {
  useEffect(() => {
    void data.loadSettings();
  }, [data.loadSettings]);
  return (
    <SettingsPage
      settings={data.settings}
      systemConfig={data.systemConfig}
      runtimeSettings={data.runtimeSettings}
      runtimeEnvPreview={data.runtimeEnvPreview}
      onApiBaseChange={data.onApiBaseChange}
      onAdminTokenChange={data.onAdminTokenChange}
      onRefresh={data.loadSettings}
      onMessage={data.onMessage}
    />
  );
}
function NotificationsRoutePage(props: { data: AppDataContext }) {
  useEffect(() => {
    const tasks: Promise<void>[] = [];
    if (props.data.providers.length === 0)
      tasks.push(props.data.loadProviders());
    if (props.data.apiKeys.length === 0) tasks.push(props.data.loadApiKeys());
    if (tasks.length > 0) void Promise.all(tasks);
  }, [
    props.data.apiKeys.length,
    props.data.loadApiKeys,
    props.data.loadProviders,
    props.data.providers.length,
  ]);
  return (
    <NotificationsPage
      settings={props.data.settings}
      providers={props.data.providers}
      apiKeys={props.data.apiKeys}
      onMessage={props.data.onMessage}
    />
  );
}
function ConsoleRoot() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<ConnectionSettings>(readSettings);
  const [providers, setProviders] = useState<ProviderWorkspace[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providerGroups, setProviderGroups] = useState<ProviderGroup[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyWorkspace[]>([]);
  const [systemConfig, setSystemConfig] = useState<SystemConfigResponse | null>(
    null,
  );
  const [runtimeSettings, setRuntimeSettings] =
    useState<RuntimeSettingsResponse | null>(null);
  const [runtimeEnvPreview, setRuntimeEnvPreview] =
    useState<RuntimeEnvPreviewResponse | null>(null);
  const [status, setStatus] = useState<LoadState>("idle");
  const [linkOk, setLinkOk] = useState(true);
  const [message, setMessage] = useState(t("未连接后台。"));
  const [notice, setNotice] = useState<{ message: string; key: number } | null>(
    null,
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [consoleMode, setConsoleMode] = useState<ConsoleMode>(() =>
    settings.adminToken.trim() ? "checking" : "connect",
  );
  const [connectionIssue, setConnectionIssue] = useState<ConnectionIssue>(null);
  const workspaceVersion = useRef(0);
  const authVersion = useRef(0);
  const authenticationRequest = useRef<{
    settings: ConnectionSettings;
    promise: Promise<SystemConfigResponse>;
  } | null>(null);
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
  const loadProviders = useCallback(
    async (successMessage?: string) => {
      const current = settings;
      const generation = workspaceVersion.current;
      if (!current.adminToken.trim()) {
        setProviders([]);
        return;
      }
      setStatus("loading");
      setProvidersLoaded(false);
      try {
        const providerWorkspace = await loadProviderWorkspace(current);
        if (generation !== workspaceVersion.current) return;
        setProviders(providerWorkspace);
        setProviderGroups([]);
        setLinkOk(true);
        if (successMessage) setMessage(t(successMessage));
      } catch (error) {
        if (generation !== workspaceVersion.current) return;
        setProviders([]);
        setProviderGroups([]);
        setLinkOk(false);
        setMessage(error instanceof Error ? error.message : "读取上游失败。");
      } finally {
        if (generation === workspaceVersion.current) {
          setStatus("ready");
          setProvidersLoaded(true);
        }
      }
    },
    [settings],
  );
  const loadApiKeys = useCallback(
    async (successMessage?: string) => {
      const current = settings;
      const generation = workspaceVersion.current;
      if (!current.adminToken.trim()) {
        setApiKeys([]);
        return;
      }
      setStatus("loading");
      try {
        const [apiKeyWorkspace, providerWorkspace] = await Promise.all([
          loadApiKeyWorkspace(current),
          loadProviderWorkspace(current),
        ]);
        setProviders(providerWorkspace);
        setProvidersLoaded(true);
        if (generation !== workspaceVersion.current) return;
        setApiKeys(apiKeyWorkspace);
        setProviderGroups([]);
        setLinkOk(true);
        if (successMessage) setMessage(t(successMessage));
      } catch (error) {
        if (generation !== workspaceVersion.current) return;
        setApiKeys([]);
        setProviderGroups([]);
        setLinkOk(false);
        setMessage(error instanceof Error ? error.message : "读取密钥失败。");
      } finally {
        if (generation === workspaceVersion.current) setStatus("ready");
      }
    },
    [settings],
  );
  const loadSettings = useCallback(
    async (successMessage?: string) => {
      const current = settings;
      const generation = workspaceVersion.current;
      if (!current.adminToken.trim()) {
        setSystemConfig(null);
        setRuntimeSettings(null);
        setRuntimeEnvPreview(null);
        return;
      }
      setStatus("loading");
      try {
        const [config, runtime, envPreview] = await Promise.all([
          loadSystemConfig(current),
          loadRuntimeSettings(current),
          previewRuntimeEnv(current),
        ]);
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
        setMessage(error instanceof Error ? error.message : "读取设置失败。");
      } finally {
        if (generation === workspaceVersion.current) setStatus("ready");
      }
    },
    [settings],
  );
  const refreshData = useCallback(
    async (successMessage?: string) => {
      const current = settings;
      const generation = ++authVersion.current;
      if (consoleMode === "error") setConsoleMode("checking");
      persistSettings(current);
      setStatus("loading");
      if (!current.adminToken.trim()) {
        clearWorkspace();
        setMessage(t("请输入管理员口令。"));
        setConnectionIssue("adminToken");
        setConsoleMode("connect");
        setRefreshKey((value) => value + 1);
        setStatus("ready");
        return;
      }
      setConnectionIssue(null);
      setMessage(t("正在验证管理员口令…"));
      const request =
        authenticationRequest.current?.settings === current
          ? authenticationRequest.current
          : { settings: current, promise: loadSystemConfig(current) };
      authenticationRequest.current = request;
      try {
        const config = await request.promise;
        if (generation !== authVersion.current) return;
        setSystemConfig(config);
        setRefreshKey((value) => value + 1);
        setMessage(successMessage ? t(successMessage) : t("已连接。"));
        setConnectionIssue(null);
        setLinkOk(true);
        setConsoleMode("console");
      } catch (error) {
        if (generation !== authVersion.current) return;
        clearWorkspace();
        const failure = describeConnectionFailure(error);
        setMessage(failure.message);
        setConnectionIssue(failure.issue);
        setLinkOk(false);
        setConsoleMode(failure.issue === "adminToken" ? "connect" : "error");
      } finally {
        if (authenticationRequest.current === request)
          authenticationRequest.current = null;
        if (generation === authVersion.current) setStatus("ready");
      }
    },
    [clearWorkspace, consoleMode, settings],
  );
  const logout = useCallback(() => {
    authVersion.current += 1;
    const nextSettings = {
      ...settings,
      adminToken: "",
    };
    setSettings(nextSettings);
    persistSettings(nextSettings);
    clearWorkspace();
    setNotice(null);
    setMessage(t("已退出。"));
    setStatus("ready");
    setConnectionIssue(null);
    setConsoleMode("connect");
    setRefreshKey((value) => value + 1);
  }, [clearWorkspace, settings]);
  const clearConnectionFeedback = useCallback(() => {
    if (consoleMode !== "connect") return;
    setStatus("ready");
    setConnectionIssue(null);
    setMessage(t("未连接后台。"));
  }, [consoleMode]);
  const onApiBaseChange = useCallback(
    (value: string) => {
      authVersion.current += 1;
      clearWorkspace();
      setSettings((current) => ({
        ...current,
        apiBase: value,
      }));
      clearConnectionFeedback();
    },
    [clearConnectionFeedback, clearWorkspace],
  );
  const onAdminTokenChange = useCallback(
    (value: string) => {
      authVersion.current += 1;
      clearWorkspace();
      setSettings((current) => ({
        ...current,
        adminToken: value,
      }));
      clearConnectionFeedback();
    },
    [clearConnectionFeedback, clearWorkspace],
  );
  const onMessage = useCallback((nextMessage: string) => {
    setMessage(t(nextMessage));
    setNotice({ message: t(nextMessage), key: Date.now() });
  }, []);
  useEffect(() => {
    if (consoleMode !== "console") return;
    let cancelled = false;
    let verifying = false;
    const invalidate = () => {
      authVersion.current += 1;
      clearWorkspace();
      setConsoleMode("connect");
      setConnectionIssue("adminToken");
      setMessage(t("管理员口令不正确，请重新输入。"));
      setLinkOk(false);
      setStatus("ready");
    };
    const unsubscribe = subscribeAuthenticationFailures((failure) => {
      if (
        cancelled ||
        failure.apiBase !== settings.apiBase.trim().replace(/\/$/, "") ||
        failure.adminToken !== settings.adminToken.trim()
      )
        return;
      if (failure.path === "/api/v1/system/config") {
        invalidate();
        return;
      }
      // Upstream probes can return 401 too; verify the admin session before expiring it.
      if (verifying) return;
      verifying = true;
      const generation = authVersion.current;
      void loadSystemConfig(settings)
        .catch((error) => {
          if (
            !cancelled &&
            generation === authVersion.current &&
            error instanceof ApiRequestError &&
            (error.status === 401 || error.status === 403)
          )
            invalidate();
        })
        .finally(() => {
          verifying = false;
        });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [clearWorkspace, consoleMode, settings]);

  useEffect(() => {
    if (settings.adminToken.trim()) void refreshData();
    return () => {
      authVersion.current += 1;
      workspaceVersion.current += 1;
    };
  }, []);
  const data = useMemo<AppDataContext>(
    () => ({
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
      onMessage,
    }),
    [
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
      systemConfig,
    ],
  );
  if (consoleMode === "checking" || consoleMode === "error")
    return (
      <Box
        sx={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          p: 3,
        }}
      >
        <Box
          sx={{
            display: "grid",
            gap: 2,
            justifyItems: "center",
            maxWidth: 480,
          }}
          role="status"
        >
          {consoleMode === "checking" ? (
            <>
              <CircularProgress size={28} />
              <Typography>{t("正在恢复连接…")}</Typography>
            </>
          ) : (
            <>
              <Alert severity="error">{message}</Alert>
              <Button onClick={() => void refreshData()}>{t("重试")}</Button>
              <Button
                variant="outlined"
                onClick={() => setConsoleMode("connect")}
              >
                {t("修改连接")}
              </Button>
            </>
          )}
        </Box>
      </Box>
    );
  return consoleMode === "console" ? (
    <TopShell data={data}>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route
          path="/overview"
          element={
            <Suspense
              fallback={<Skeleton variant="rectangular" height={320} />}
            >
              <OverviewPage data={data} />
            </Suspense>
          }
        />
        <Route path="/keys" element={<KeysRoutePage data={data} />} />
        <Route path="/logs" element={<LogsRoutePage data={data} />} />
        <Route path="/upstreams" element={<UpstreamsPage data={data} />} />
        <Route path="/oauth" element={<OAuthRoutePage data={data} />} />
        <Route path="/models/*" element={<ModelsRoutePage data={data} />} />
        <Route
          path="/notifications"
          element={<NotificationsRoutePage data={data} />}
        />
        <Route path="/settings" element={<SettingsRoutePage data={data} />} />
        <Route path="/usage" element={<Navigate to="/overview" replace />} />
        <Route path="/prices" element={<LegacyPricesRedirect />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
      <Snackbar
        key={notice?.key}
        open={!!notice}
        autoHideDuration={6000}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        onClose={(_, reason) => {
          if (reason !== "clickaway") setNotice(null);
        }}
        message={notice?.message}
        action={
          <IconButton
            size="small"
            aria-label={t("关闭提示")}
            onClick={() => setNotice(null)}
            sx={{ color: "inherit" }}
          >
            <X fontSize="small" />
          </IconButton>
        }
      />
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
  const [router, setRouter] = useState<ReturnType<
    typeof createBrowserRouter
  > | null>(null);
  useEffect(() => {
    const instance = createBrowserRouter([
      { path: "*", element: <ConsoleRoot /> },
    ]);
    setRouter(instance);
    return () => instance.dispose();
  }, []);
  return router ? <RouterProvider router={router} /> : null;
}
