import type { AppDataContext } from "@/App";
import { loadStatsOverview } from "@/lib/api";
import { formatBytes, formatCompactInteger, formatMs } from "@/lib/format";
import { getIntlLocale, t, useI18n } from "@/lib/i18n";
import { calculateOverviewPricing, formatUsd } from "@/lib/pricing";
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
import { type CssVarsTheme, useColorScheme, useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { BarChart, BarPlot } from "@mui/x-charts/BarChart";
import { ChartsAxisHighlight } from "@mui/x-charts/ChartsAxisHighlight";
import { ChartsContainer } from "@mui/x-charts/ChartsContainer";
import { ChartsGrid } from "@mui/x-charts/ChartsGrid";
import { ChartsTooltip } from "@mui/x-charts/ChartsTooltip";
import { ChartsXAxis } from "@mui/x-charts/ChartsXAxis";
import { ChartsYAxis } from "@mui/x-charts/ChartsYAxis";
import { LineHighlightPlot, LinePlot } from "@mui/x-charts/LineChart";
import { SparkLineChart } from "@mui/x-charts/SparkLineChart";
import { PieChart } from "@mui/x-charts/PieChart";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
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
  ];
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
                      {t(item.label)}
                    </Typography>
                    <Typography
                      component="div"
                      sx={{ mt: 0.5, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2 }}
                    >
                      {loading && !overview ? <Skeleton width={72} /> : item.value}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      title={item.title}
                      sx={{ mt: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {loading && !overview ? <Skeleton width="60%" /> : t(item.hint ?? "")}
                    </Typography>
                  </Box>
                  <Box sx={{ width: 96, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {loading && !overview ? (
                      <Skeleton variant="rounded" width={96} height={44} />
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
              <Box sx={{ height: 280, mt: 1 }}>
                {loading ? (
                  <Skeleton variant="rounded" height={268} sx={{ mt: 1 }} />
                ) : overview?.series && chartData.length > 0 ? (
                  <ChartsContainer
                    skipAnimation
                    key={trendView}
                    height={280}
                    dataset={chartData}
                    margin={{ left: 4, right: 4, top: 12, bottom: 4 }}
                    xAxis={[{ id: "time", dataKey: "time", scaleType: "band", valueFormatter: formatTime, height: 24 }]}
                    yAxis={[
                      { id: "tokens", min: 0, valueFormatter: formatCompactInteger, width: 44, position: showTokens ? "left" : "none" },
                      { id: "req", min: 0, valueFormatter: formatCompactInteger, width: 36, position: showRequests ? "right" : "none" },
                    ]}
                    series={[
                      ...(showTokens
                        ? tokenSeries.map((item) => ({
                            ...item,
                            type: "bar" as const,
                            stack: "tokens",
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
                              curve: "monotoneX" as const,
                              showMark: false,
                            },
                            {
                              type: "line" as const,
                              dataKey: "request_failed",
                              label: t("失败"),
                              color: palette.error.main,
                              yAxisId: "req",
                              curve: "monotoneX" as const,
                              showMark: false,
                            },
                          ]
                        : []),
                    ]}
                  >
                    <ChartsGrid horizontal />
                    <BarPlot borderRadius={2} />
                    <LinePlot />
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
                  <Skeleton variant="circular" width={190} height={190} />
                ) : overview && overview.token_usage.total_tokens > 0 ? (
                  <PieChart
                    skipAnimation
                    height={260}
                    slotProps={{ legend: { direction: "horizontal", position: { vertical: "bottom", horizontal: "center" } } }}
                    series={[
                      {
                        innerRadius: 58,
                        outerRadius: 86,
                        paddingAngle: 2,
                        cornerRadius: 3,
                        highlightScope: { fade: "global", highlight: "item" },
                        data: tokenSeries.map((item) => ({
                          id: item.dataKey,
                          label: item.label,
                          color: item.color,
                          value: overview.token_usage[item.dataKey as keyof typeof overview.token_usage],
                        })),
                      },
                    ]}
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
