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
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import LinearProgress from "@mui/material/LinearProgress";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import { BarChart } from "@mui/x-charts/BarChart";
import { LineChart } from "@mui/x-charts/LineChart";
import { PieChart } from "@mui/x-charts/PieChart";
import { useCallback, useEffect, useState } from "react";
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
  const theme = useTheme();
  const palette = theme.vars?.palette ?? theme.palette;
  const [period, setPeriod] = useState<StatsPeriod>("today");
  const [copied, setCopied] = useState(false);
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
            : t("当前窗口：{{window}}", {
                window: t(periodLabel()),
              }),
          tone:
            overviewPricing &&
            (overviewPricing.unpricedRequests > 0 ||
              overviewPricing.usageMissingRequests > 0)
              ? "warning"
              : "success",
        },
        {
          label: "用量",
          value: formatCompactInteger(current.token_usage.total_tokens),
          hint: t("输入 {{input}} · 输出 {{output}}", {
            input: formatCompactInteger(current.token_usage.input_tokens),
            output: formatCompactInteger(current.token_usage.output_tokens),
          }),
        },
        {
          label: "缓存率",
          value: `${cacheRate().toFixed(1)}%`,
          hint: t("读 {{read}} · 写 {{write}}", {
            read: formatCompactInteger(
              current.token_usage.cache_read_input_tokens,
            ),
            write: formatCompactInteger(
              current.token_usage.cache_creation_input_tokens,
            ),
          }),
          tone: cacheRate() > 0 ? "success" : "default",
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
  return (
    <Box
      sx={{
        display: "flex",
        minWidth: "0",
        flexDirection: "column",
        gap: "1.25rem",
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
            sx={{
              position: "absolute",
              top: "calc(0.25rem * -2)",
              insetInline: "0",
            }}
          />
        ) : null}
        <Grid
          container
          spacing={2}
          aria-label={"用量概览"}
          aria-busy={loading && !overview}
        >
          {orderedItems.map((item) => (
            <Grid key={item.label} size={{ xs: 12, sm: 6, xl: 3 }}>
              <Card sx={{ height: "100%" }}>
                <CardContent>
                  <Typography color="text.secondary" variant="body2">
                    {t(item.label)}
                  </Typography>
                  <Typography component="div" variant="h1" sx={{ my: 1 }}>
                    {loading && !overview ? (
                      <Skeleton width="45%" />
                    ) : (
                      item.value
                    )}
                  </Typography>
                  {item.hint ? (
                    <Typography variant="caption" color="text.secondary">
                      {t(item.hint)}
                    </Typography>
                  ) : null}
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Box>
      {overview && !overview.series ? (
        <Alert severity="info">
          {t("当前后端未提供趋势数据，仍显示汇总指标。")}
        </Alert>
      ) : null}
      {missingUsage > 0 ? (
        <Alert severity="warning">
          {t("{{count}} 个请求未返回用量，图表仅显示已观测用量。", {
            count: missingUsage,
          })}
        </Alert>
      ) : null}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <Card>
            <CardContent>
              <Typography component="h2" variant="h2">
                {t("请求趋势")}
              </Typography>
              {loading ? (
                <Skeleton height={300} variant="rectangular" sx={{ mt: 2 }} />
              ) : overview?.series ? (
                <LineChart
                  skipAnimation
                  height={300}
                  dataset={chartData}
                  xAxis={[
                    {
                      dataKey: "time",
                      scaleType: "time",
                      valueFormatter: formatTime,
                    },
                  ]}
                  yAxis={[
                    { min: 0, valueFormatter: formatCompactInteger, width: 55 },
                  ]}
                  series={[
                    {
                      dataKey: "request_success",
                      label: t("成功"),
                      color: palette.primary.main,
                      showMark: false,
                    },
                    {
                      dataKey: "request_failed",
                      label: t("失败"),
                      color: palette.error.main,
                      showMark: false,
                    },
                  ]}
                />
              ) : (
                <Typography sx={{ py: 6 }} color="text.secondary">
                  {t("趋势数据不可用")}
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 12, lg: 4 }}>
          <Card sx={{ height: "100%" }}>
            <CardContent>
              <Typography component="h2" variant="h2">
                {t("Token 构成")}
              </Typography>
              {loading ? (
                <Skeleton height={260} variant="circular" />
              ) : overview && overview.token_usage.total_tokens > 0 ? (
                <PieChart
                  skipAnimation
                  height={260}
                  series={[
                    {
                      innerRadius: 65,
                      outerRadius: 95,
                      data: tokenSeries.map((item) => ({
                        id: item.dataKey,
                        label: item.label,
                        color: item.color,
                        value:
                          overview.token_usage[
                            item.dataKey as keyof typeof overview.token_usage
                          ],
                      })),
                    },
                  ]}
                />
              ) : (
                <Typography sx={{ py: 6 }} color="text.secondary">
                  {t("暂无已观测用量")}
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary">
                {t("思考 Token {{count}}，已包含在输出中。", {
                  count: formatCompactInteger(
                    overview?.token_usage.reasoning_output_tokens ?? 0,
                  ),
                })}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={12}>
          <Card>
            <CardContent>
              <Typography component="h2" variant="h2">
                {t("用量趋势")}
              </Typography>
              {loading ? (
                <Skeleton height={300} variant="rectangular" sx={{ mt: 2 }} />
              ) : overview?.series ? (
                <BarChart
                  skipAnimation
                  height={300}
                  dataset={chartData}
                  xAxis={[
                    {
                      dataKey: "time",
                      scaleType: "band",
                      valueFormatter: formatTime,
                    },
                  ]}
                  yAxis={[
                    { min: 0, valueFormatter: formatCompactInteger, width: 55 },
                  ]}
                  series={tokenSeries.map((item) => ({
                    ...item,
                    stack: "tokens",
                  }))}
                />
              ) : (
                <Typography sx={{ py: 6 }} color="text.secondary">
                  {t("趋势数据不可用")}
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
      <Box
        sx={{
          display: "grid",
          minWidth: "0",
          gap: "1.25rem",
          "@media (width >= 80rem)": { gridTemplateColumns: "1.15fr 1fr" },
        }}
      >
        <Card
          sx={{
            overflow: "hidden",
            borderRadius: "8px",
            borderStyle: "solid",
            borderWidth: "1px",
            borderColor: "var(--mui-palette-divider)",
            backgroundColor: "var(--mui-palette-background-paper)",
            boxShadow: "none",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "0.75rem",
              paddingInline: "1.25rem",
              paddingBottom: "1rem",
              paddingTop: "1.25rem",
            }}
          >
            <Box>
              <Typography
                component="h2"
                sx={{
                  fontSize: "1rem",
                  lineHeight: "calc(1.25 / 0.875)",
                  fontWeight: "600",
                  color: "var(--mui-palette-text-primary)",
                }}
              >
                {t("服务状态")}
              </Typography>
              <Typography
                sx={{
                  marginTop: "0.25rem",
                  fontSize: "0.75rem",
                  lineHeight: "1.25rem",
                  color: "var(--mui-palette-text-secondary)",
                }}
              >
                {t("健康状态与可用资源。")}
              </Typography>
            </Box>
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
                )[
                  !health
                    ? "disabled"
                    : health.error > 0
                      ? "error"
                      : health.warning > 0
                        ? "warning"
                        : "normal"
                ]
              }
              label={t(
                !health
                  ? "等待数据"
                  : health.error > 0
                    ? "异常"
                    : health.warning > 0
                      ? "警告"
                      : "正常",
              )}
            />
          </Box>
          <CardContent sx={{ paddingInline: "1.25rem" }}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: "0.5rem",
                "@media (width >= 40rem)": { gap: "1rem" },
              }}
            >
              <Box
                sx={{
                  minWidth: "0",
                  borderRadius: "8px",
                  backgroundColor: "var(--mui-palette-background-default)",
                  padding: "0.75rem",
                  "@media (width >= 40rem)": { padding: "0.875rem" },
                }}
              >
                <Box
                  sx={{
                    marginBottom: "0.75rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    fontSize: "0.75rem",
                    lineHeight: "calc(1 / 0.75)",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                >
                  <Server
                    fontSize="small"
                    sx={{
                      display: "none",
                      flexShrink: "0",
                      "@media (width >= 40rem)": { display: "block" },
                    }}
                  />
                  {t("上游健康")}
                </Box>
                <Box
                  sx={{
                    fontSize: "1.25rem",
                    lineHeight: "calc(1.75 / 1.25)",
                    fontWeight: "600",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {health ? health.healthy : "—"}
                </Box>
                <Box
                  sx={{
                    marginTop: "0.375rem",
                    fontSize: "0.75rem",
                    lineHeight: "1.25rem",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                >
                  {health
                    ? t("{{warning}} 警告 · {{error}} 异常", {
                        warning: health.warning,
                        error: health.error,
                      })
                    : t("等待数据")}
                </Box>
              </Box>
              <Box
                sx={{
                  minWidth: "0",
                  borderRadius: "8px",
                  backgroundColor: "var(--mui-palette-background-default)",
                  padding: "0.75rem",
                  "@media (width >= 40rem)": { padding: "0.875rem" },
                }}
              >
                <Box
                  sx={{
                    marginBottom: "0.75rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    fontSize: "0.75rem",
                    lineHeight: "calc(1 / 0.75)",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                >
                  <Zap
                    fontSize="small"
                    sx={{
                      display: "none",
                      flexShrink: "0",
                      "@media (width >= 40rem)": { display: "block" },
                    }}
                  />
                  {t("可用目标")}
                </Box>
                <Box
                  sx={{
                    fontSize: "1.25rem",
                    lineHeight: "calc(1.75 / 1.25)",
                    fontWeight: "600",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {health ? health.endpoints_enabled : "—"}
                </Box>
                <Box
                  sx={{
                    marginTop: "0.375rem",
                    fontSize: "0.75rem",
                    lineHeight: "1.25rem",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                >
                  {t("已启用的连接目标")}
                </Box>
              </Box>
              <Box
                sx={{
                  minWidth: "0",
                  borderRadius: "8px",
                  backgroundColor: "var(--mui-palette-background-default)",
                  padding: "0.75rem",
                  "@media (width >= 40rem)": { padding: "0.875rem" },
                }}
              >
                <Box
                  sx={{
                    marginBottom: "0.75rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    fontSize: "0.75rem",
                    lineHeight: "calc(1 / 0.75)",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                >
                  <KeyRound
                    fontSize="small"
                    sx={{
                      display: "none",
                      flexShrink: "0",
                      "@media (width >= 40rem)": { display: "block" },
                    }}
                  />
                  {t("活跃密钥")}
                </Box>
                <Box
                  sx={{
                    fontSize: "1.25rem",
                    lineHeight: "calc(1.75 / 1.25)",
                    fontWeight: "600",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {health
                    ? formatCompactInteger(health.upstream_keys_enabled)
                    : "—"}
                </Box>
                <Box
                  sx={{
                    marginTop: "0.375rem",
                    fontSize: "0.75rem",
                    lineHeight: "1.25rem",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                >
                  {t("当前可用密钥。")}
                </Box>
              </Box>
            </Box>
            <Button
              component={Link}
              to="/upstreams"
              variant="text"
              sx={{
                marginTop: "1rem",
                color: "var(--mui-palette-primary-main)",
              }}
            >
              {t("查看上游详情")}
              <ArrowRight fontSize="small" />
            </Button>
          </CardContent>
        </Card>
        <Card
          sx={{
            overflow: "hidden",
            borderRadius: "8px",
            borderStyle: "solid",
            borderWidth: "1px",
            borderColor: "var(--mui-palette-divider)",
            backgroundColor: "var(--mui-palette-background-paper)",
            boxShadow: "none",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "0.75rem",
              paddingInline: "1.25rem",
              paddingBottom: "1rem",
              paddingTop: "1.25rem",
            }}
          >
            <Box>
              <Typography
                component="h2"
                sx={{
                  fontSize: "1rem",
                  lineHeight: "calc(1.25 / 0.875)",
                  fontWeight: "600",
                  color: "var(--mui-palette-text-primary)",
                }}
              >
                {t("服务器状态")}
              </Typography>
              <Typography
                sx={{
                  marginTop: "0.25rem",
                  fontSize: "0.75rem",
                  lineHeight: "1.25rem",
                  color: "var(--mui-palette-text-secondary)",
                }}
              >
                {formatServerScope(
                  serverStatus()?.scope,
                  serverStatus()?.memory_limited,
                )}
              </Typography>
            </Box>
            <Box
              sx={{
                display: "flex",
                width: "2rem",
                height: "2rem",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "8px",
                backgroundColor:
                  "color-mix(in oklab, var(--mui-palette-action-hover) 60%, transparent)",
                color: "var(--mui-palette-text-secondary)",
              }}
            >
              <Cpu fontSize="small" />
            </Box>
          </Box>
          <CardContent
            sx={{
              display: "flex",
              flexDirection: "column",
              gap: "1.25rem",
              paddingInline: "1.25rem",
            }}
          >
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
              <Chip label={t("访问密钥 {{count}}", { count: apiKeyCount() })} />
              <Chip
                label={t("已启用 {{count}}", { count: enabledApiKeyCount() })}
              />
              <Chip
                label={t("缓存率 {{rate}}%", { rate: cacheRate().toFixed(1) })}
              />
            </Box>
            {[
              {
                label: "CPU",
                value: serverStatus()?.cpu_usage_percent,
                hint: formatCpuCapacity(serverStatus()?.cpu_capacity_cores),
              },
              {
                label: t("内存"),
                value: serverStatus()?.memory_usage_percent,
                hint: formatServerMemory(serverStatus()),
              },
            ].map(({ label, value, hint }) => (
              <Box key={label}>
                <Stack
                  direction="row"
                  sx={{ mb: 1, justifyContent: "space-between" }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {label}
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {formatUsagePercent(value)}
                  </Typography>
                </Stack>
                {typeof value === "number" && Number.isFinite(value) ? (
                  <LinearProgress
                    variant="determinate"
                    value={Math.max(0, Math.min(100, value))}
                    color={value >= 90 ? "warning" : "primary"}
                    aria-label={label}
                  />
                ) : (
                  <Skeleton variant="rounded" height={6} animation={false} />
                )}
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 1, display: "block" }}
                >
                  {hint}
                </Typography>
              </Box>
            ))}
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
