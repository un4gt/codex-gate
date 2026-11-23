import type { AppDataContext } from "@/App";
import { loadStatsOverview } from "@/lib/api";
import { formatBytes, formatCompactInteger, formatMs } from "@/lib/format";
import { getIntlLocale, t, useI18n } from "@/lib/i18n";
import {
  aggregateUsageBreakdown,
  calculateOverviewPricing,
  formatUsd,
  totalUsageTokens,
} from "@/lib/pricing";
import type {
  ConnectionSettings,
  StatItem,
  StatsOverviewResponse,
  StatsPeriod,
} from "@/lib/types";
import { useRemoteResource } from "@/lib/useRemoteResource";
import ArrowRight from "@mui/icons-material/ArrowForwardOutlined";
import Zap from "@mui/icons-material/BoltOutlined";
import Check from "@mui/icons-material/CheckOutlined";
import Copy from "@mui/icons-material/ContentCopyOutlined";
import Server from "@mui/icons-material/DnsOutlined";
import KeyRound from "@mui/icons-material/KeyOutlined";
import Cpu from "@mui/icons-material/MemoryOutlined";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Grid from "@mui/material/Grid";
import LinearProgress from "@mui/material/LinearProgress";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import { type CssVarsTheme, keyframes, useColorScheme, useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import useMediaQuery from "@mui/material/useMediaQuery";
import { BarChart, BarPlot } from "@mui/x-charts/BarChart";
import { ChartsAxisHighlight } from "@mui/x-charts/ChartsAxisHighlight";
import { ChartsContainer } from "@mui/x-charts/ChartsContainer";
import { ChartsGrid } from "@mui/x-charts/ChartsGrid";
import { ChartsTooltip } from "@mui/x-charts/ChartsTooltip";
import { ChartsXAxis } from "@mui/x-charts/ChartsXAxis";
import { ChartsYAxis } from "@mui/x-charts/ChartsYAxis";
import { AnimatedLine, type AnimatedLineProps, LineHighlightPlot, LinePlot, MarkPlot } from "@mui/x-charts/LineChart";
import { useDrawingArea, useLineSeries } from "@mui/x-charts/hooks";
import { SparkLineChart } from "@mui/x-charts/SparkLineChart";
import { pieClasses, PieChart, type PieChartProps } from "@mui/x-charts/PieChart";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { TableSkeleton } from "./console/TableSkeleton";

const TREND_MARGIN = { left: 4, right: 4, top: 12, bottom: 4 };
const TREND_TOKEN_AXIS_WIDTH = 44;
const TREND_REQUEST_AXIS_WIDTH = 36;
const TREND_MAX_BAR_WIDTH = 64;
const TREND_ENTRANCE_MS = 1000;
const TOKEN_COMPOSITION_ENTRANCE_MS = 1000;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const TOKEN_COMPOSITION_SERIES_ID = "token-composition";
const TOKEN_COMPOSITION_OUTER_RADIUS = 86;

const growTrendBars = keyframes({
  from: { transform: "scaleY(0)" },
  to: { transform: "scaleY(1)" },
});
const revealTrendBars = keyframes({
  from: { clipPath: "inset(100% 0 0) fill-box" },
  to: { clipPath: "inset(0) fill-box" },
});
const drawTrendLines = keyframes({
  from: { clipPath: "inset(-2px calc(100% + 2px) -2px -2px) fill-box" },
  to: { clipPath: "inset(-2px) fill-box" },
});

const OVERVIEW_PERIODS: {
  value: StatsPeriod;
  label: string;
}[] = [
  {
    value: "today",
    label: "今天",
  },
  {
    value: "7h",
    label: "最近7小时",
  },
  {
    value: "24h",
    label: "最近24小时",
  },
  {
    value: "week",
    label: "近 7 天",
  },
  {
    value: "month",
    label: "近 30 天",
  },
];
async function copyText(
  value: string,
  success: string,
  onMessage: (message: string) => void,
) {
  try {
    if (!navigator.clipboard) {
      onMessage(t("当前环境不支持剪贴板。"));
      return false;
    }
    await navigator.clipboard.writeText(value);
    onMessage(t(success));
    return true;
  } catch {
    onMessage(t("复制失败，请重试。"));
    return false;
  }
}
function formatUsagePercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return t("采样中");
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}
function formatCpuCapacity(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return t("CPU 采样中");
  return t("{{count}} 核可用", {
    count: value.toFixed(value < 10 ? 1 : 0),
  });
}
function formatServerScope(
  scope: string | null | undefined,
  limited: boolean | undefined,
) {
  if (scope === "container") return limited ? t("容器限额") : t("容器采样");
  if (scope === "cgroup") return limited ? t("进程限额") : t("进程采样");
  return t("主机采样");
}
function formatServerMemory(
  status: StatsOverviewResponse["server_status"] | undefined,
) {
  if (
    typeof status?.memory_used_bytes !== "number" ||
    typeof status.memory_total_bytes !== "number"
  )
    return t("等待数据");
  return `${formatBytes(status.memory_used_bytes)} / ${formatBytes(status.memory_total_bytes)}`;
}

function RequestTrendLine(props: AnimatedLineProps) {
  const series = useLineSeries(props.ownerState.seriesId);
  const clipId = useId();
  const values = series?.data ?? [];
  if (values.every(value => value === 0)) return null;
  if (!values.some((value, i) => value === 0 && values[i - 1] === 0)) {
    return <AnimatedLine {...props} />;
  }

  // Keep the original series for the axis tooltip. Clip only the spans between adjacent zeros.
  const spans = [];
  let start = 0;
  const last = values.length - 1;
  for (let i = 0; i <= last; i++) {
    if (i < last && (values[i] !== 0 || values[i + 1] !== 0)) continue;
    if (i > start) {
      const left = start === 0 ? -1 : start / last;
      const right = i === last ? 2 : i / last;
      spans.push(<Box component="rect" key={start} x={left} y={-1} style={{ width: right - left, height: 3 }} />);
    }
    start = i + 1;
  }
  return (
    <>
      <Box component="clipPath" id={clipId} clipPathUnits="objectBoundingBox">
        {spans}
      </Box>
      <AnimatedLine {...props} clipPath={`url(#${clipId})`} />
    </>
  );
}

function useChartEntrance(
  container: RefObject<HTMLDivElement | null>,
  hasShown: boolean,
  onFirstShow: () => void,
) {
  const [entrance, setEntrance] = useState<"pending" | "animated" | "static">(
    hasShown ? "static" : "pending",
  );

  useEffect(() => {
    if (entrance !== "pending") return;
    const element = container.current;
    let inViewport = !element || typeof IntersectionObserver === "undefined";
    const showWhenVisible = () => {
      if (inViewport && !document.hidden) {
        setEntrance("animated");
        onFirstShow();
      }
    };
    let observer: IntersectionObserver | undefined;
    if (element && !inViewport) {
      const visibleRatio = Math.min(0.5, window.innerHeight / (2 * element.clientHeight));
      observer = new IntersectionObserver(([entry]) => {
        inViewport = entry.isIntersecting && entry.intersectionRatio >= visibleRatio;
        showWhenVisible();
      }, { threshold: visibleRatio });
      observer.observe(element);
    }
    document.addEventListener("visibilitychange", showWhenVisible);
    showWhenVisible();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", showWhenVisible);
    };
  }, [container, entrance, onFirstShow]);
  return entrance;
}

function TrafficTrendPlots({
  container,
  hasShown,
  onFirstShow,
}: {
  container: RefObject<HTMLDivElement | null>;
  hasShown: boolean;
  onFirstShow: () => void;
}) {
  const theme = useTheme();
  const entrance = useChartEntrance(container, hasShown, onFirstShow);

  if (entrance === "pending") return null;
  const animate = entrance === "animated";
  const timing = `${TREND_ENTRANCE_MS}ms ${theme.transitions.easing.easeInOut} backwards`;
  // The reduced-motion theme shortens CSS animations. Keep this stationary data reveal legible.
  const revealDuration = `${TREND_ENTRANCE_MS}ms !important`;
  return (
    <>
      <Box
        component="g"
        sx={animate ? {
          transformBox: "fill-box",
          transformOrigin: "center bottom",
          animation: `${growTrendBars} ${timing}`,
          [`@media ${REDUCED_MOTION_QUERY}`]: {
            animationName: `${revealTrendBars}`,
            animationDuration: revealDuration,
          },
        } : undefined}
      >
        <BarPlot borderRadius={2} />
      </Box>
      <Box
        component="g"
        sx={animate ? {
          animation: `${drawTrendLines} ${timing}`,
          [`@media ${REDUCED_MOTION_QUERY}`]: { animationDuration: revealDuration },
        } : undefined}
      >
        <LinePlot slots={{ line: RequestTrendLine }} />
        <MarkPlot />
      </Box>
    </>
  );
}

function TokenCompositionSweep({ id, onComplete }: { id: string; onComplete: () => void }) {
  const { left, top, width, height } = useDrawingArea();
  const prefersReducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const path = useRef<SVGPathElement>(null);

  useEffect(() => {
    const sweepPath = path.current;
    if (!sweepPath) return;
    if (prefersReducedMotion) {
      onComplete();
      return;
    }

    // Leave room for the stroke around the outer rim.
    const radius = TOKEN_COMPOSITION_OUTER_RADIUS + 1;
    let startedAt: number | undefined;
    const drawFrame = (now: number) => {
      startedAt ??= now;
      const elapsed = now - startedAt;
      if (elapsed >= TOKEN_COMPOSITION_ENTRANCE_MS) {
        onComplete();
        return;
      }

      // Sweep from twelve o'clock without rerendering the pie on each frame.
      const angle = (elapsed / TOKEN_COMPOSITION_ENTRANCE_MS) * 2 * Math.PI;
      const x = radius * Math.sin(angle);
      const y = -radius * Math.cos(angle);
      const largeArc = angle > Math.PI ? 1 : 0;
      sweepPath.setAttribute("d", `M 0 0 V ${-radius} A ${radius} ${radius} 0 ${largeArc} 1 ${x} ${y} Z`);
      frame = requestAnimationFrame(drawFrame);
    };

    let frame = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(frame);
  }, [onComplete, prefersReducedMotion]);

  return (
    <Box component="clipPath" id={id}>
      <Box component="path" ref={path} transform={`translate(${left + width / 2}, ${top + height / 2})`} />
    </Box>
  );
}

function TokenCompositionChart({
  data,
  total,
  hasShown,
  onFirstShow,
}: {
  data: { id: string; label: string; color: string; value: number }[];
  total: number;
  hasShown: boolean;
  onFirstShow: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const entrance = useChartEntrance(container, hasShown, onFirstShow);
  const sweepId = useId();
  const [sweepComplete, setSweepComplete] = useState(false);
  const completeSweep = useCallback(() => setSweepComplete(true), []);
  const isDrawing = entrance === "animated" && !sweepComplete;
  const [highlightedItem, setHighlightedItem] = useState<PieChartProps["highlightedItem"]>(null);
  const locale = getIntlLocale();
  const countFormat = new Intl.NumberFormat(locale);
  const percentFormat = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const formatValue = (value: number) => {
    const share = value / total;
    const percent = share > 0 && share < 0.001
      ? `<${percentFormat.format(0.001)}`
      : percentFormat.format(share);
    return `${countFormat.format(value)} (${percent})`;
  };
  const clearHighlight = () => setHighlightedItem(null);

  return (
    <Stack ref={container} sx={{ width: "100%", gap: 1 }}>
      <PieChart
        skipAnimation
        hideLegend
        height={260}
        highlightedItem={highlightedItem}
        onHighlightChange={setHighlightedItem}
        sx={(theme) => ({
          [`& .${pieClasses.root}`]: {
            visibility: entrance === "pending" ? "hidden" : undefined,
            clipPath: isDrawing ? `url(#${sweepId})` : undefined,
            [`@media ${REDUCED_MOTION_QUERY}`]: { clipPath: "none", visibility: "visible" },
          },
          [`& .${pieClasses.arc}`]: {
            transition: theme.transitions.create(["opacity", "filter"], { duration: theme.transitions.duration.short }),
          },
        })}
        series={[
          {
            id: TOKEN_COMPOSITION_SERIES_ID,
            innerRadius: 58,
            outerRadius: TOKEN_COMPOSITION_OUTER_RADIUS,
            startAngle: 0,
            paddingAngle: 2,
            cornerRadius: 3,
            highlightScope: { fade: "global", highlight: "item" },
            faded: { additionalRadius: 0 },
            data,
            valueFormatter: ({ value }) => formatValue(value),
          },
        ]}
      >
        {isDrawing ? <TokenCompositionSweep id={sweepId} onComplete={completeSweep} /> : null}
      </PieChart>
      <Stack component="ul" direction="row" sx={{ m: 0, p: 0, listStyle: "none", flexWrap: "wrap", justifyContent: "center", columnGap: 2 }}>
        {data.map((item, dataIndex) => {
          const highlight = () => setHighlightedItem(item.value > 0
            ? { seriesId: TOKEN_COMPOSITION_SERIES_ID, dataIndex }
            : null);
          return (
            <Box component="li" key={item.id}>
              <Tooltip title={formatValue(item.value)} describeChild>
                <Box
                  component="span"
                  tabIndex={0}
                  onMouseEnter={highlight}
                  onMouseLeave={clearHighlight}
                  onFocus={highlight}
                  onBlur={clearHighlight}
                  sx={{ typography: "caption", display: "inline-flex", gap: 1, alignItems: "center", minHeight: 24 }}
                >
                  <Box component="span" aria-hidden sx={{ width: "1.3em", height: "1.3em", borderRadius: "50%", bgcolor: item.color }} />
                  {item.label}
                </Box>
              </Tooltip>
            </Box>
          );
        })}
      </Stack>
    </Stack>
  );
}

export default function OverviewPage(props: { data: AppDataContext }) {
  const { t } = useI18n();
  const theme = useTheme<CssVarsTheme>();
  const { mode, systemMode } = useColorScheme();
  const chartColorScheme = (mode === "system" ? systemMode : mode) ?? "light";
  // Concrete colors let chart internals recompute styles when the scheme changes.
  const palette = theme.colorSchemes?.[chartColorScheme]?.palette ?? theme.palette;
  const [period, setPeriod] = useState<StatsPeriod>("today");
  const [copied, setCopied] = useState(false);
  const [trendView, setTrendView] = useState<"all" | "requests" | "tokens">("all");
  const [hasShownTrend, setHasShownTrend] = useState(false);
  const markTrendShown = useCallback(() => setHasShownTrend(true), []);
  const [hasShownTokenComposition, setHasShownTokenComposition] = useState(false);
  const markTokenCompositionShown = useCallback(() => setHasShownTokenComposition(true), []);
  const trendContainer = useRef<HTMLDivElement>(null);
  const [trendWidth, setTrendWidth] = useState(0);
  const [breakdownView, setBreakdownView] = useState<"model" | "provider">("model");
  useLayoutEffect(() => {
    const container = trendContainer.current;
    if (!container) return;
    const measure = () => setTrendWidth(container.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const loadOverview = useCallback(
    async (settings: ConnectionSettings) => ({
      period,
      overview: await loadStatsOverview(settings, period),
    }),
    [period],
  );
  const resource = useRemoteResource(
    props.data.settings,
    loadOverview,
    props.data.refreshKey,
  );
  const overview =
    resource.data?.period === period ? resource.data.overview : null;
  // A different period must not inherit the previous period's figures while loading.
  const loading = resource.loading || (!overview && !resource.error);
  useEffect(() => {
    void props.data.loadApiKeys();
  }, [props.data.loadApiKeys, props.data.refreshKey]);
  const periodLabel = () =>
    OVERVIEW_PERIODS.find((item) => item.value === period)?.label ?? "今天";
  const tokenUsage = () => overview?.token_usage;
  const serverStatus = () => overview?.server_status;
  const apiKeyCount = () => props.data.apiKeys.length;
  const enabledApiKeyCount = () =>
    props.data.apiKeys.filter((item) => item.apiKey.enabled).length;
  const cacheTokens = () =>
    (tokenUsage()?.cache_read_input_tokens ?? 0) +
    (tokenUsage()?.cache_creation_input_tokens ?? 0);
  const cacheRate = () => {
    if (!tokenUsage()?.usage_observed_requests) return null;
    const total = tokenUsage()?.total_tokens ?? 0;
    if (total <= 0) return 0;
    return (cacheTokens() / total) * 100;
  };
  const overviewPricing = overview ? calculateOverviewPricing(overview) : null;
  const breakdownRows = useMemo(
    () =>
      aggregateUsageBreakdown(
        breakdownView === "model"
          ? overview?.breakdown?.by_model
          : overview?.breakdown?.by_provider,
        overview?.pricing.versions ?? [],
        breakdownView,
      ),
    [breakdownView, overview],
  );
  const metrics = (): StatItem[] => {
    const current = overview;
    if (current) {
      return [
        {
          label: "访问密钥",
          value: formatCompactInteger(apiKeyCount()),
          hint: t("启用 {{count}}", {
            count: formatCompactInteger(enabledApiKeyCount()),
          }),
        },
        {
          label: "请求次数",
          value: formatCompactInteger(current.kpis.requests),
          hint: t("失败 {{count}}", {
            count: formatCompactInteger(current.kpis.failed),
          }),
          tone: current.kpis.error_rate > 5 ? "warning" : "success",
        },
        {
          label: "消费",
          value:
            overviewPricing && overviewPricing.priceableRequests > 0
              ? formatUsd(overviewPricing.totalUsd)
              : "—",
          hint: overviewPricing
            ? t("已计价 {{priced}} · 未定价 {{unpriced}}", {
                priced: formatCompactInteger(overviewPricing.priceableRequests),
                unpriced: formatCompactInteger(overviewPricing.unpricedRequests),
              })
            : t("当前窗口：{{window}}", { window: t(periodLabel()) }),
          title: overviewPricing
            ? t(
                "已计价 {{priced}} · 未定价 {{unpriced}} · 缺用量 {{missing}} · token 覆盖 {{coverage}}%",
                {
                  priced: formatCompactInteger(
                    overviewPricing.priceableRequests,
                  ),
                  unpriced: formatCompactInteger(
                    overviewPricing.unpricedRequests,
                  ),
                  missing: formatCompactInteger(
                    overviewPricing.usageMissingRequests,
                  ),
                  coverage: overviewPricing.tokenCoveragePercent
                    .toDecimalPlaces(1)
                    .toFixed(1),
                },
              )
            : undefined,
          tone:
            overviewPricing &&
            (overviewPricing.unpricedRequests > 0 ||
              overviewPricing.usageMissingRequests > 0)
              ? "warning"
              : "success",
        },
        {
          label: "用量",
          value: current.kpis.requests > 0 && current.token_usage.usage_observed_requests === 0
            ? "—"
            : formatCompactInteger(current.token_usage.total_tokens),
          hint: t("输入 {{input}} · 输出 {{output}}", {
            input: formatCompactInteger(current.token_usage.input_tokens),
            output: formatCompactInteger(current.token_usage.output_tokens),
          }),
        },
        {
          label: "缓存率",
          value: cacheRate() === null ? "—" : `${cacheRate()!.toFixed(1)}%`,
          hint: t("读 {{read}} · 写 {{write}}", {
            read: formatCompactInteger(
              current.token_usage.cache_read_input_tokens,
            ),
            write: formatCompactInteger(
              current.token_usage.cache_creation_input_tokens,
            ),
          }),
          tone: (cacheRate() ?? 0) > 0 ? "success" : "default",
        },
        {
          label: "平均响应",
          value: current.kpis.requests
            ? formatMs(current.kpis.avg_latency_ms)
            : "—",
          hint: t("P95 {{value}}", {
            value:
              current.kpis.p95_latency_ms === null
                ? "—"
                : formatMs(current.kpis.p95_latency_ms),
          }),
        },
      ];
    }
    return [
      {
        label: "访问密钥",
        value: "—",
        hint: "等待数据",
      },
      {
        label: "请求次数",
        value: "—",
        hint: "等待数据",
      },
      {
        label: "消费",
        value: "—",
        hint: "等待数据",
      },
      {
        label: "用量",
        value: "—",
        hint: "输入 — · 输出 —",
      },
      {
        label: "缓存率",
        value: "—",
        hint: "读 — · 写 —",
      },
      {
        label: "平均响应",
        value: "—",
        hint: "等待数据",
      },
    ];
  };
  const items = metrics();
  const orderedItems = [1, 3, 2, 5].map((index) => items[index]);
  const health = overview?.service_health;
  const points = overview?.series?.points ?? [];
  const chartData = points.map((point) => ({
    ...point,
    time: new Date(point.bucket_start_ms),
    // A request with no usage observation is unknown, not a measured zero.
    ...(point.request_success + point.request_failed > 0 &&
    point.usage_observed_requests === 0
      ? {
          input_tokens: null,
          output_tokens: null,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        }
      : {}),
  }));
  const tokenSeries = [
    {
      dataKey: "input_tokens",
      label: t("输入"),
      color: palette.primary.main,
    },
    {
      dataKey: "output_tokens",
      label: t("输出"),
      color: palette.success.main,
    },
    {
      dataKey: "cache_read_input_tokens",
      label: t("缓存读"),
      color: palette.warning.main,
    },
    {
      dataKey: "cache_creation_input_tokens",
      label: t("缓存写"),
      color: palette.info.main,
    },
  ] as const;
  const tokenComposition = tokenSeries.map(({ dataKey, label, color }) => ({
    id: dataKey,
    label,
    color,
    value: overview?.token_usage[dataKey] ?? 0,
  }));
  const tokenCompositionTotal = tokenComposition.reduce((sum, item) => sum + item.value, 0);
  const missingUsage = overview
    ? overview.kpis.requests - overview.token_usage.usage_observed_requests
    : 0;
  const formatTime = (date: Date, context?: { location?: string }) => {
    const daily = overview?.series?.interval_ms === 86400000;
    return new Intl.DateTimeFormat(getIntlLocale(), {
      timeZone: "Asia/Shanghai",
      ...(daily || context?.location !== "tick"
        ? { month: "2-digit" as const, day: "2-digit" as const }
        : {}),
      ...(!daily
        ? {
            hour: "2-digit" as const,
            minute: "2-digit" as const,
            hour12: false,
          }
        : {}),
    }).format(date);
  };
  const sparkRequests = points.map((point) => point.request_success + point.request_failed);
  const sparkTokens = points.map(
    (point) =>
      point.request_success + point.request_failed > 0 && point.usage_observed_requests === 0
        ? null
        : point.input_tokens + point.output_tokens + point.cache_read_input_tokens + point.cache_creation_input_tokens,
  );
  const successRate = overview && overview.kpis.requests > 0 ? 100 - overview.kpis.error_rate : null;
  const showTokens = trendView !== "requests";
  const showRequests = trendView !== "tokens";
  // Monotone interpolation falls back to a straight segment with only two points.
  const requestCurve: "bumpX" | "monotoneX" =
    chartData.length === 2 ? "bumpX" : "monotoneX";
  const trendDrawingWidth =
    trendWidth - TREND_MARGIN.left - TREND_MARGIN.right -
    (showTokens ? TREND_TOKEN_AXIS_WIDTH : 0) -
    (showRequests ? TREND_REQUEST_AXIS_WIDTH : 0);
  // Keep the category centers fixed while reserving enough gap to cap each stack.
  const categoryGapRatio =
    showTokens && trendDrawingWidth > 0
      ? Math.max(0.2, 1 - (TREND_MAX_BAR_WIDTH * chartData.length) / trendDrawingWidth)
      : undefined;
  const legendItems = [
    ...(showTokens ? tokenSeries.map((item) => ({ label: item.label, color: item.color, line: false })) : []),
    ...(showRequests
      ? [
          { label: t("成功"), color: palette.primary.main, line: true },
          { label: t("失败"), color: palette.error.main, line: true },
        ]
      : []),
  ];
  const healthTone = !health ? "default" : health.error > 0 ? "error" : health.warning > 0 ? "warning" : "success";
  const healthColor = healthTone === "default" ? palette.text.disabled : palette[healthTone].main;
  const healthLabel = t(
    !health ? "等待数据" : health.error > 0 ? "异常" : health.warning > 0 ? "警告" : "正常",
  );
  return (
    <Box
      sx={{
        display: "flex",
        minWidth: "0",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <Stack
        component="header"
        direction="row"
        sx={{ justifyContent: "flex-end", flexWrap: "wrap", gap: 1.5 }}
      >
        {
          <Box
            sx={{
              display: "flex",
              width: "100%",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.75rem",
            }}
          >
            <Box
              sx={{
                display: "inline-flex",
                maxWidth: "100%",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "0.25rem",
                borderRadius: "8px",
                borderStyle: "solid",
                borderWidth: "1px",
                borderColor: "var(--mui-palette-divider)",
                backgroundColor:
                  "color-mix(in oklab, var(--mui-palette-action-hover) 50%, transparent)",
                padding: "0.25rem",
              }}
              role="group"
              aria-label={t("统计时间范围")}
            >
              {OVERVIEW_PERIODS.map((item) => (
                <Button
                  key={item.value}
                  type="button"
                  size="small"
                  variant="text"
                  aria-pressed={period === item.value}
                  sx={
                    period === item.value
                      ? {
                          backgroundColor:
                            "var(--mui-palette-background-paper)",
                          color: "var(--mui-palette-primary-main)",
                          boxShadow: "none",
                        }
                      : { color: "var(--mui-palette-text-secondary)" }
                  }
                  onClick={() => setPeriod(item.value)}
                >
                  {t(item.label)}
                </Button>
              ))}
            </Box>
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Button
                type="button"
                variant="outlined"
                onClick={async () =>
                  setCopied(
                    await copyText(
                      props.data.settings.apiBase,
                      "地址已复制。",
                      props.data.onMessage,
                    ),
                  )
                }
                onBlur={() => setCopied(false)}
              >
                {copied ? (
                  <Check fontSize="small" />
                ) : (
                  <Copy fontSize="small" />
                )}
                {t(copied ? "已复制" : "COPY URL")}
              </Button>
              <Button component={Link} to="/keys">
                <KeyRound fontSize="small" />
                {t("CREATE KEY")}
              </Button>
            </Box>
          </Box>
        }
      </Stack>
      {resource.error ? (
        <Alert
          severity="error"
          action={
            <Button
              variant="text"
              disabled={resource.loading}
              onClick={() => void resource.reload()}
            >
              {t("重试")}
            </Button>
          }
        >
          <AlertTitle>{t("读取总览失败。")}</AlertTitle>
          {resource.error}
          {overview ? (
            <Box sx={{ marginTop: "0.25rem" }}>
              {t("当前显示上次成功获取的数据。")}
            </Box>
          ) : null}
        </Alert>
      ) : null}
      <Box sx={{ position: "relative" }} aria-busy={loading}>
        {loading && overview ? (
          <LinearProgress
            aria-label={t("更新总览数据")}
            sx={{ position: "absolute", top: -6, insetInline: 0, height: 2 }}
          />
        ) : null}
        <Grid container spacing={1.5} aria-label={t("用量概览")}>
          {orderedItems.map((item, index) => (
            <Grid key={item.label} size={{ xs: 12, sm: 6, xl: 3 }}>
              <Card sx={{ height: 112 }}>
                <Box
                  sx={{
                    display: "flex",
                    height: "100%",
                    alignItems: "stretch",
                    gap: 1.5,
                    px: 2,
                    py: 1.5,
                  }}
                >
                  <Box sx={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column" }}>
                    <Typography color="text.secondary" sx={{ fontSize: 12 }}>
                      {loading && !overview ? (
                        <Skeleton animation="wave" width={56} />
                      ) : (
                        t(item.label)
                      )}
                    </Typography>
                    <Typography
                      component="div"
                      sx={{ mt: 0.5, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2 }}
                    >
                      {loading && !overview ? <Skeleton animation="wave" width={72} /> : item.value}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      title={item.title}
                      sx={{ mt: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {loading && !overview ? <Skeleton animation="wave" width="60%" /> : t(item.hint ?? "")}
                    </Typography>
                  </Box>
                  <Box sx={{ width: 96, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {loading && !overview ? (
                      <Skeleton animation="wave" variant="rounded" width={96} height={44} />
                    ) : index === 0 ? (
                      <SparkLineChart
                        data={sparkRequests}
                        height={48}
                        width={96}
                        area
                        curve="natural"
                        color={palette.primary.main}
                      />
                    ) : index === 1 ? (
                      <BarChart
                        skipAnimation
                        series={[{ data: sparkTokens, color: palette.success.main }]}
                        xAxis={[{ scaleType: "band", data: points.map((point) => point.bucket_start_ms), position: "none" }]}
                        yAxis={[{ position: "none" }]}
                        margin={5}
                        hideLegend
                        height={48}
                        width={96}
                      />
                    ) : index === 2 ? (
                      <Ring value={cacheRate()} label={t("缓存")} color={palette.warning.main} />
                    ) : (
                      <Ring value={successRate} label={t("成功率")} color={palette.success.main} />
                    )}
                  </Box>
                </Box>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Box>
      {overview && !overview.series ? (
        <Alert severity="info">{t("当前后端未提供趋势数据，仍显示汇总指标。")}</Alert>
      ) : null}
      {missingUsage > 0 ? (
        <Alert severity="warning">
          {t("{{count}} 个请求未返回用量，图表仅显示已观测用量。", { count: missingUsage })}
        </Alert>
      ) : null}
      <Grid container spacing={1.5}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <Card sx={{ height: "100%" }}>
            <CardContent sx={{ p: 2, "&:last-child": { pb: 1.5 } }}>
              <Stack direction="row" sx={{ alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
                <Typography component="h2" variant="h2">
                  {t("流量趋势")}
                </Typography>
                <Stack direction="row" sx={{ gap: 1.5, flexWrap: "wrap", ml: 0.5 }}>
                  {legendItems.map((item) => (
                    <Stack key={item.label} direction="row" sx={{ alignItems: "center", gap: 0.5 }}>
                      <Box
                        sx={{
                          width: item.line ? 10 : 8,
                          height: item.line ? 2 : 8,
                          borderRadius: item.line ? 1 : "2px",
                          bgcolor: item.color,
                        }}
                      />
                      <Typography variant="caption" color="text.secondary">
                        {item.label}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
                <ToggleButtonGroup
                  aria-label={t("流量趋势")}
                  exclusive
                  size="small"
                  value={trendView}
                  onChange={(_, value) => value && setTrendView(value)}
                  sx={{
                    ml: "auto",
                    "& .MuiToggleButton-root": { py: 0.25, px: 1, fontSize: 12, textTransform: "none", lineHeight: 1.6 },
                  }}
                >
                  <ToggleButton value="all">{t("全部")}</ToggleButton>
                  <ToggleButton value="requests">{t("请求")}</ToggleButton>
                  <ToggleButton value="tokens">{t("用量")}</ToggleButton>
                </ToggleButtonGroup>
              </Stack>
              <Box ref={trendContainer} sx={{ height: 280, mt: 1 }}>
                {loading ? (
                  <Skeleton animation="wave" variant="rounded" height={268} sx={{ mt: 1 }} />
                ) : overview?.series && chartData.length > 0 ? (
                  <ChartsContainer
                    skipAnimation
                    key={trendView}
                    height={280}
                    dataset={chartData}
                    margin={TREND_MARGIN}
                    sx={{
                      [`@media ${REDUCED_MOTION_QUERY}`]: {
                        // The theme sets a tiny animation duration even for skipped line masks.
                        "& clipPath > rect": { animationName: "none" },
                      },
                    }}
                    xAxis={[{
                      id: "time",
                      dataKey: "time",
                      scaleType: "band",
                      categoryGapRatio,
                      valueFormatter: formatTime,
                      height: 24,
                    }]}
                    yAxis={[
                      { id: "tokens", min: 0, valueFormatter: formatCompactInteger, width: TREND_TOKEN_AXIS_WIDTH, position: showTokens ? "left" : "none" },
                      { id: "req", min: 0, valueFormatter: formatCompactInteger, width: TREND_REQUEST_AXIS_WIDTH, position: showRequests ? "right" : "none" },
                    ]}
                    series={[
                      ...(showTokens
                        ? tokenSeries.map((item) => ({
                            ...item,
                            type: "bar" as const,
                            stack: "tokens",
                            minBarSize: 0,
                            yAxisId: "tokens",
                          }))
                        : []),
                      ...(showRequests
                        ? [
                            {
                              type: "line" as const,
                              dataKey: "request_success",
                              label: t("成功"),
                              color: palette.primary.main,
                              yAxisId: "req",
                              curve: requestCurve,
                              showMark: chartData.length === 1 && chartData[0].request_success > 0,
                            },
                            {
                              type: "line" as const,
                              dataKey: "request_failed",
                              label: t("失败"),
                              color: palette.error.main,
                              yAxisId: "req",
                              curve: requestCurve,
                              showMark: chartData.length === 1 && chartData[0].request_failed > 0,
                            },
                          ]
                        : []),
                    ]}
                  >
                    <ChartsGrid horizontal />
                    <TrafficTrendPlots
                      container={trendContainer}
                      hasShown={hasShownTrend}
                      onFirstShow={markTrendShown}
                    />
                    <ChartsAxisHighlight x="band" />
                    <LineHighlightPlot />
                    <ChartsXAxis axisId="time" tickLabelStyle={{ fontSize: 11 }} disableTicks />
                    {showTokens ? <ChartsYAxis axisId="tokens" tickLabelStyle={{ fontSize: 11 }} disableLine disableTicks /> : null}
                    {showRequests ? <ChartsYAxis axisId="req" tickLabelStyle={{ fontSize: 11 }} disableLine disableTicks /> : null}
                    <ChartsTooltip trigger="axis" />
                  </ChartsContainer>
                ) : (
                  <Box sx={{ display: "grid", height: "100%", placeItems: "center" }}>
                    <Typography variant="caption" color="text.secondary">{t("趋势数据不可用")}</Typography>
                  </Box>
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 12, lg: 4 }}>
          <Card sx={{ height: "100%" }}>
            <CardContent sx={{ p: 2, "&:last-child": { pb: 1.5 } }}>
              <Typography component="h2" variant="h2">
                {t("Token 构成")}
              </Typography>
              <Box sx={{ height: 280, mt: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {loading ? (
                  <Skeleton animation="wave" variant="circular" width={190} height={190} />
                ) : tokenCompositionTotal > 0 ? (
                  <TokenCompositionChart
                    data={tokenComposition}
                    total={tokenCompositionTotal}
                    hasShown={hasShownTokenComposition}
                    onFirstShow={markTokenCompositionShown}
                  />
                ) : (
                  <Typography variant="caption" color="text.secondary">{t("暂无已观测用量")}</Typography>
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
      <Card>
        <CardContent sx={{ p: 2, "&:last-child": { pb: 1.5 } }}>
          <Stack
            direction="row"
            sx={{ alignItems: "center", gap: 1.5, flexWrap: "wrap" }}
          >
            <Typography component="h2" variant="h2">
              {t("模型与渠道用量")}
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={breakdownView}
              onChange={(_, value) => value && setBreakdownView(value)}
              aria-label={t("模型与渠道用量")}
              sx={{
                ml: "auto",
                "& .MuiToggleButton-root": {
                  py: 0.25,
                  px: 1,
                  fontSize: 12,
                  textTransform: "none",
                  lineHeight: 1.6,
                },
              }}
            >
              <ToggleButton value="model">{t("按模型")}</ToggleButton>
              <ToggleButton value="provider">{t("按渠道")}</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
          {loading && !overview ? (
            <TableSkeleton
              ariaLabel={t("模型与渠道用量")}
              rows={6}
              minWidth={560}
              containerSx={{ maxHeight: 320, mt: 1 }}
              columns={[
                { label: t(breakdownView === "model" ? "模型" : "渠道") },
                { label: t("请求"), align: "right", skeletonWidth: 36 },
                { label: t("Token 用量"), align: "right", skeletonWidth: 64 },
                { label: t("花费"), align: "right", skeletonWidth: 52 },
              ]}
            />
          ) : breakdownRows.length > 0 ? (
            <TableContainer sx={{ maxHeight: 320, mt: 1 }}>
              <Table size="small" stickyHeader aria-label={t("模型与渠道用量")}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t(breakdownView === "model" ? "模型" : "渠道")}</TableCell>
                    <TableCell align="right">{t("请求")}</TableCell>
                    <TableCell align="right">{t("Token 用量")}</TableCell>
                    <TableCell align="right">{t("花费")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {breakdownRows.map((row) => {
                    const tokens = totalUsageTokens(row.usage);
                    return (
                      <TableRow key={row.key} hover>
                        <TableCell sx={{ maxWidth: 360, overflowWrap: "anywhere" }}>
                          {row.label}
                        </TableCell>
                        <TableCell align="right">
                          {formatCompactInteger(row.requestCount)}
                        </TableCell>
                        <TableCell
                          align="right"
                          title={`${t("输入")}: ${formatCompactInteger(row.usage.input_tokens)} · ${t("输出")}: ${formatCompactInteger(row.usage.output_tokens)} · ${t("缓存读")}: ${formatCompactInteger(row.usage.cache_read_input_tokens)} · ${t("缓存写")}: ${formatCompactInteger(row.usage.cache_creation_input_tokens)}`}
                        >
                          {formatCompactInteger(tokens)}
                        </TableCell>
                        <TableCell
                          align="right"
                          title={
                            row.unpricedRequests > 0
                              ? `${row.unpricedRequests} × ${t("未定价")}`
                              : undefined
                          }
                        >
                          {row.costUsd.isZero() && row.unpricedRequests > 0
                            ? t("未定价")
                            : formatUsd(row.costUsd)}
                          {!row.costUsd.isZero() && row.unpricedRequests > 0 ? " *" : ""}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Typography color="text.secondary" sx={{ mt: 1.5, fontSize: 13 }}>
              {t("暂无用量明细")}
            </Typography>
          )}
        </CardContent>
      </Card>
      <Card>
        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            columnGap: 3,
            rowGap: 1.5,
            px: 2,
            py: 1.25,
          }}
        >
          <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                bgcolor: healthColor,
                boxShadow: `0 0 0 3px color-mix(in oklab, ${healthColor} 22%, transparent)`,
              }}
            />
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{t("服务状态")}</Typography>
            <Typography sx={{ fontSize: 12, color: healthColor, fontWeight: 500 }}>{healthLabel}</Typography>
          </Stack>
          <StatusStat icon={<Server sx={{ fontSize: 15 }} />} label={t("上游健康")} value={health ? health.healthy : "—"}
            extra={health && (health.warning > 0 || health.error > 0) ? t("{{warning}} 警告 · {{error}} 异常", { warning: health.warning, error: health.error }) : undefined} />
          <StatusStat icon={<Zap sx={{ fontSize: 15 }} />} label={t("可用目标")} value={health?.endpoints_available ?? "—"} />
          <StatusStat icon={<KeyRound sx={{ fontSize: 15 }} />} label={t("活跃密钥")} value={health?.upstream_keys_available === undefined ? "—" : formatCompactInteger(health.upstream_keys_available)} />
          <Box sx={{ width: "1px", alignSelf: "stretch", bgcolor: "divider", display: { xs: "none", md: "block" } }} />
          <Stack direction="row" sx={{ alignItems: "center", gap: 0.75 }} title={formatServerScope(serverStatus()?.scope, serverStatus()?.memory_limited)}>
            <Cpu sx={{ fontSize: 15, color: "text.secondary" }} />
          </Stack>
          <MiniMeter label="CPU" value={serverStatus()?.cpu_usage_percent} hint={formatCpuCapacity(serverStatus()?.cpu_capacity_cores)} />
          <MiniMeter label={t("内存")} value={serverStatus()?.memory_usage_percent} hint={formatServerMemory(serverStatus())} />
          <Button component={Link} to="/upstreams" variant="text" size="small" sx={{ ml: "auto", fontSize: 12 }}>
            {t("查看上游详情")}
            <ArrowRight sx={{ fontSize: 14 }} />
          </Button>
        </Box>
      </Card>
    </Box>
  );
}

function Ring(props: { value: number | null; label: string; color: string }) {
  const size = 52;
  const clamped = props.value === null ? null : Math.max(0, Math.min(100, props.value));
  const label = clamped === null ? "—" : `${Math.round(clamped)}%`;
  return (
    <Box sx={{ position: "relative", width: size, height: size }} title={`${props.label} ${clamped === null ? "—" : `${clamped.toFixed(1)}%`}`}>
      <CircularProgress variant="determinate" value={100} size={size} thickness={4} aria-hidden="true" sx={{ color: "action.hover", position: "absolute" }} />
      {clamped !== null ? (
        <CircularProgress variant="determinate" value={clamped} size={size} thickness={4} aria-label={props.label} sx={{ color: props.color, "& .MuiCircularProgress-circle": { strokeLinecap: "round", transition: "none" } }} />
      ) : null}
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
        }}
      >
        <Box component="span" sx={{ fontSize: 11, fontWeight: 600 }}>
          {label}
        </Box>
        <Box component="span" sx={{ fontSize: 9, color: "text.secondary", mt: "2px" }}>
          {props.label}
        </Box>
      </Box>
    </Box>
  );
}

function StatusStat(props: { icon: ReactNode; label: string; value: ReactNode; extra?: string }) {
  return (
    <Stack direction="row" sx={{ alignItems: "center", gap: 0.75, color: "text.secondary" }} title={props.extra}>
      {props.icon}
      <Typography sx={{ fontSize: 12 }}>{props.label}</Typography>
      <Typography sx={{ fontSize: 13, fontWeight: 600, color: "text.primary", fontVariantNumeric: "tabular-nums" }}>
        {props.value}
      </Typography>
    </Stack>
  );
}

function MiniMeter(props: { label: string; value: number | null | undefined; hint: string }) {
  const valid = typeof props.value === "number" && Number.isFinite(props.value);
  const value = valid ? Math.max(0, Math.min(100, props.value as number)) : 0;
  return (
    <Stack direction="row" sx={{ alignItems: "center", gap: 1 }} title={props.hint}>
      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{props.label}</Typography>
      <Box sx={{ width: 88 }}>
        {valid ? <LinearProgress
          variant="determinate"
          value={value}
          color={value >= 90 ? "error" : value >= 70 ? "warning" : "primary"}
          aria-label={props.label}
          sx={{ height: 4 }}
        /> : <Box sx={{ height: 4, borderRadius: 1, bgcolor: "action.hover" }} />}
      </Box>
      <Typography sx={{ fontSize: 12, fontWeight: 600, minWidth: 36, fontVariantNumeric: "tabular-nums" }}>
        {formatUsagePercent(props.value)}
      </Typography>
    </Stack>
  );
}
