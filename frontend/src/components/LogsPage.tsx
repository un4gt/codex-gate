import ChevronRight from "@mui/icons-material/ChevronRightOutlined";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Copy from "@mui/icons-material/ContentCopyOutlined";
import {
default as ChevronDown,
default as ExpandMoreOutlined,
} from "@mui/icons-material/ExpandMoreOutlined";
import Search from "@mui/icons-material/SearchOutlined";
import Columns3 from "@mui/icons-material/ViewColumnOutlined";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import TablePagination from "@mui/material/TablePagination";
import Tooltip from "@mui/material/Tooltip";
import { useEffect,useMemo,useRef,useState } from "react";

import { t,useI18n } from "@/lib/i18n";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
loadConsolePreferences,
loadRequestLogs,
updateConsolePreferences,
} from "../lib/api";
import {
formatCompactInteger,
formatDateTime,
formatModelName,
formatMs,
formatRequestPath,
formatRequestType,
REQUEST_TYPE_OPTIONS,
} from "../lib/format";
import {
calculateRequestPricing,
describeUnpricedReason,
formatUsd,
} from "../lib/pricing";
import type {
ApiKeyWorkspace,
ConnectionSettings,
ProviderWorkspace,
RequestLogRow,
} from "../lib/types";
interface LogsPageProps {
  settings: ConnectionSettings;
  providers: ProviderWorkspace[];
  apiKeys: ApiKeyWorkspace[];
  refreshKey: number;
  onMessage: (message: string) => void;
}
interface LogFilters {
  query: string;
  statusClass: string;
  apiKeyId: string;
  model: string;
  apiFormat: "" | "chat_completions" | "responses";
  providerId: string;
  endpointId: string;
  durationMin: string;
  durationMax: string;
  tokenMin: string;
  tokenMax: string;
  usageObserved: "" | "true" | "false";
  reasoningMin: string;
  reasoningMax: string;
}
const EMPTY_FILTERS: LogFilters = {
  query: "",
  statusClass: "",
  apiKeyId: "",
  model: "",
  apiFormat: "",
  providerId: "",
  endpointId: "",
  durationMin: "",
  durationMax: "",
  tokenMin: "",
  tokenMax: "",
  usageObserved: "",
  reasoningMin: "",
  reasoningMax: "",
};
export const LOG_COLUMN_DEFINITIONS = [
  {
    id: "time",
    label: "时间",
    defaultWidth: 160,
    minWidth: 112,
    maxWidth: 320,
  },
  {
    id: "service_tier",
    label: "服务档位",
    defaultWidth: 140,
    minWidth: 100,
    maxWidth: 280,
  },
  {
    id: "model",
    label: "模型",
    defaultWidth: 180,
    minWidth: 120,
    maxWidth: 480,
  },
  {
    id: "request_path",
    label: "请求路径 / 转换",
    defaultWidth: 240,
    minWidth: 160,
    maxWidth: 480,
  },
  {
    id: "status",
    label: "状态",
    defaultWidth: 88,
    minWidth: 72,
    maxWidth: 180,
  },
  {
    id: "duration",
    label: "耗时",
    defaultWidth: 110,
    minWidth: 80,
    maxWidth: 240,
  },
  {
    id: "total_tokens",
    label: "用量",
    defaultWidth: 360,
    minWidth: 280,
    maxWidth: 640,
  },
  {
    id: "api_key",
    label: "密钥",
    defaultWidth: 130,
    minWidth: 96,
    maxWidth: 360,
  },
  {
    id: "provider",
    label: "上游",
    defaultWidth: 140,
    minWidth: 96,
    maxWidth: 360,
  },
  {
    id: "endpoint",
    label: "目标",
    defaultWidth: 140,
    minWidth: 96,
    maxWidth: 360,
  },
  {
    id: "transport",
    label: "传输",
    defaultWidth: 110,
    minWidth: 88,
    maxWidth: 240,
  },
  {
    id: "first_byte",
    label: "首字节",
    defaultWidth: 100,
    minWidth: 80,
    maxWidth: 240,
  },
  { id: "ttft", label: "TTFT", defaultWidth: 100, minWidth: 80, maxWidth: 240 },
  { id: "cost", label: "成本", defaultWidth: 110, minWidth: 88, maxWidth: 240 },
  {
    id: "request_id",
    label: "请求 ID",
    defaultWidth: 190,
    minWidth: 140,
    maxWidth: 480,
  },
  {
    id: "error_type",
    label: "错误类型",
    defaultWidth: 150,
    minWidth: 112,
    maxWidth: 420,
  },
] as const;
export type LogColumnId = (typeof LOG_COLUMN_DEFINITIONS)[number]["id"];
const LOG_COLUMN_DEFINITION_MAP = new Map(
  LOG_COLUMN_DEFINITIONS.map((column) => [column.id, column]),
);
const LEGACY_LOG_USAGE_COLUMN_IDS = new Set([
  "input_tokens",
  "output_tokens",
  "cache_read",
  "cache_write",
  "reasoning",
]);
export const DEFAULT_LOG_COLUMNS: LogColumnId[] = [
  "time",
  "model",
  "status",
  "duration",
  "total_tokens",
  "api_key",
  "provider",
];
const LOG_COLUMN_IDS = new Set<LogColumnId>(
  LOG_COLUMN_DEFINITIONS.map((column) => column.id),
);

export function sanitizeLogColumns(columns: string[]): LogColumnId[] {
  const seen = new Set<LogColumnId>();
  const filtered: LogColumnId[] = [];
  for (const column of columns) {
    const normalized = LEGACY_LOG_USAGE_COLUMN_IDS.has(column)
      ? "total_tokens"
      : column;
    if (
      !LOG_COLUMN_IDS.has(normalized as LogColumnId) ||
      seen.has(normalized as LogColumnId)
    )
      continue;
    seen.add(normalized as LogColumnId);
    filtered.push(normalized as LogColumnId);
  }
  return filtered.length > 0 ? filtered : [...DEFAULT_LOG_COLUMNS];
}

export function formatUpstreamEndpoint(
  apiFormat: RequestLogRow["upstream_api_format"],
): string {
  return apiFormat ? formatRequestType(apiFormat) : "—";
}
export function formatRoutingProtocol(
  apiFormat: string | null | undefined,
  conversionMode: string | null | undefined,
): string {
  const endpoint = formatRequestType(apiFormat);
  return conversionMode === "responses_via_chat"
    ? `${endpoint} · Responses → Chat`
    : endpoint;
}
function totalTokens(row: RequestLogRow) {
  return (
    row.input_tokens +
    row.output_tokens +
    row.cache_read_input_tokens +
    row.cache_creation_input_tokens
  );
}
function visibleOutputTokens(row: RequestLogRow) {
  return Math.max(row.output_tokens - row.reasoning_output_tokens, 0);
}
function rowStatus(row: RequestLogRow) {
  if (row.http_status === null) {
    return row.error_type
      ? {
          tone: "error" as const,
          label: "失败",
        }
      : {
          tone: "normal" as const,
          label: "—",
        };
  }
  if (row.http_status >= 500)
    return {
      tone: "error" as const,
      label: String(row.http_status),
    };
  if (row.http_status >= 400)
    return {
      tone: "warning" as const,
      label: String(row.http_status),
    };
  return {
    tone: "normal" as const,
    label: String(row.http_status),
  };
}
function formatMaybeMs(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? formatMs(value)
    : "—";
}
function primaryLatency(row: RequestLogRow) {
  return row.duration_ms ?? row.t_first_token_ms ?? row.t_first_byte_ms ?? null;
}
function isWsSession(row: RequestLogRow) {
  return row.span_kind === "ws_session";
}
function transportLabel(row: RequestLogRow) {
  if (row.span_kind === "ws_session") return "WS";
  if (row.span_kind === "ws_session_close") return "WS Close";
  if (row.transport === "ws_setup") return "WS Setup";
  if (row.transport === "ws_http_bridge") return "HTTP Bridge";
  if (row.transport === "ws_native") return "Native WS";
  if (row.transport === "ws") return "WS";
  return "HTTP";
}
function transportTone(
  row: RequestLogRow,
): "normal" | "warning" | "error" | "disabled" {
  if (row.transport === "ws_http_bridge") return "warning";
  if (row.transport === "ws_setup") return "error";
  if (row.transport === "ws_native" || row.transport === "ws") return "normal";
  return "disabled";
}
export function LogsPage(props: LogsPageProps) {
  const { t } = useI18n();
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rows, setRows] = useState<RequestLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<RequestLogRow | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<
    Record<string, boolean>
  >({});
  const [visibleColumns, setVisibleColumns] =
    useState<LogColumnId[]>(DEFAULT_LOG_COLUMNS);
  const [columnMenuAnchor, setColumnMenuAnchor] = useState<HTMLElement | null>(
    null,
  );
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [query, setQuery] = useState({ filters: EMPTY_FILTERS, revision: 0 });
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const preferenceSequence = useRef(0);
  const submitQuery = (next = filters) => {
    setPage(0);
    setQuery((current) => ({ filters: next, revision: current.revision + 1 }));
  };
  const providerNameMap = useMemo(
    () =>
      new Map(
        props.providers.map((item) => [item.provider.id, item.provider.name]),
      ),
    [props.providers],
  );
  const endpointNameMap = useMemo(
    () =>
      new Map(
        props.providers.flatMap((item) =>
          item.endpoints.map(
            (endpoint) => [endpoint.id, endpoint.name] as const,
          ),
        ),
      ),
    [props.providers],
  );
  const apiKeyNameMap = useMemo(
    () =>
      new Map(props.apiKeys.map((item) => [item.apiKey.id, item.apiKey.name])),
    [props.apiKeys],
  );
  const endpointOptions = useMemo(() => {
    const providerId = filters.providerId;
    return props.providers.flatMap((item) => {
      if (providerId && String(item.provider.id) !== providerId) return [];
      return item.endpoints.map((endpoint) => ({
        value: String(endpoint.id),
        label: `${item.provider.name} / ${endpoint.name}`,
      }));
    });
  }, [filters.providerId, props.providers]);
  const loadLogs = async () => {
    const sequence = ++requestSequence.current;
    setLoadError(null);
    setLoading(true);
    try {
      if (!props.settings.adminToken.trim()) {
        setRows([]);
        return;
      }
      const current = query.filters;
      const result = await loadRequestLogs(props.settings, {
        page: page + 1,
        page_size: pageSize,
        query: current.query || undefined,
        model: current.model || undefined,
        api_key_id: current.apiKeyId ? Number(current.apiKeyId) : undefined,
        provider_id: current.providerId
          ? Number(current.providerId)
          : undefined,
        endpoint_id: current.endpointId
          ? Number(current.endpointId)
          : undefined,
        api_format: current.apiFormat || undefined,
        status_class: current.statusClass
          ? Number(current.statusClass)
          : undefined,
        duration_ms_min: current.durationMin
          ? Number(current.durationMin)
          : undefined,
        duration_ms_max: current.durationMax
          ? Number(current.durationMax)
          : undefined,
        total_tokens_min: current.tokenMin
          ? Number(current.tokenMin)
          : undefined,
        total_tokens_max: current.tokenMax
          ? Number(current.tokenMax)
          : undefined,
        usage_observed: current.usageObserved
          ? current.usageObserved === "true"
          : undefined,
        reasoning_output_tokens_min: current.reasoningMin
          ? Number(current.reasoningMin)
          : undefined,
        reasoning_output_tokens_max: current.reasoningMax
          ? Number(current.reasoningMax)
          : undefined,
      });
      if (sequence === requestSequence.current) {
        setRows(result);
        setExpandedSessions({});
      }
    } catch (error) {
      if (sequence === requestSequence.current) {
        setLoadError(
          error instanceof Error ? error.message : t("读取日志失败。"),
        );
        setRows([]);
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (props.settings.adminToken.trim()) {
      void loadConsolePreferences(props.settings)
        .then((preferences) => {
          setVisibleColumns(
            sanitizeLogColumns(preferences.log_visible_columns),
          );
        })
        .catch((error) =>
          props.onMessage(
            error instanceof Error ? error.message : "读取日志列偏好失败。",
          ),
        );
    }
  }, []);
  useEffect(() => {
    void loadLogs();
    return () => {
      requestSequence.current += 1;
    };
  }, [
    query,
    page,
    pageSize,
    props.refreshKey,
    props.settings.apiBase,
    props.settings.adminToken,
  ]);
  const filteredRows = useMemo(
    () => [...rows].sort((left, right) => right.time_ms - left.time_ms),
    [rows],
  );
  const visibleRows = useMemo(() => {
    const all = filteredRows;
    const visibleIds = new Set(all.map((row) => row.id));
    const children = new Set(
      all
        .filter((row) => row.parent_id && visibleIds.has(row.parent_id))
        .map((row) => row.id),
    );
    const byParent = new Map<string, RequestLogRow[]>();
    for (const row of all) {
      if (!row.parent_id) continue;
      const group = byParent.get(row.parent_id) ?? [];
      group.push(row);
      byParent.set(row.parent_id, group);
    }
    for (const group of byParent.values()) {
      group.sort((left, right) => left.time_ms - right.time_ms);
    }
    const out: Array<{
      row: RequestLogRow;
      depth: number;
      children: RequestLogRow[];
    }> = [];
    for (const row of all) {
      if (children.has(row.id)) continue;
      const rowChildren = byParent.get(row.id) ?? [];
      out.push({
        row,
        depth: 0,
        children: rowChildren,
      });
      if (expandedSessions[row.id]) {
        rowChildren.forEach((child) =>
          out.push({
            row: child,
            depth: 1,
            children: [],
          }),
        );
      }
    }
    return out;
  }, [expandedSessions, filteredRows]);
  const errorCount = useMemo(
    () =>
      filteredRows.filter(
        (row) => (row.http_status ?? 0) >= 400 || row.error_type,
      ).length,
    [filteredRows],
  );
  const visibleColumnDefinitions = useMemo(
    () => visibleColumns.map((id) => LOG_COLUMN_DEFINITION_MAP.get(id)!),
    [visibleColumns],
  );
  const copyField = async (value: string, label: string) => {
    if (!navigator?.clipboard) {
      props.onMessage(t("当前环境不支持复制。"));
      return;
    }
    await navigator.clipboard.writeText(value);
    props.onMessage(
      t("{{label}} 已复制。", {
        label: t(label),
      }),
    );
  };
  const saveVisibleColumns = async (
    next: LogColumnId[],
    previous: LogColumnId[],
  ) => {
    const sequence = ++preferenceSequence.current;
    setVisibleColumns(next);
    try {
      const saved = await updateConsolePreferences(props.settings, {
        log_visible_columns: next,
      });
      if (sequence === preferenceSequence.current)
        setVisibleColumns(sanitizeLogColumns(saved.log_visible_columns));
    } catch (error) {
      if (sequence !== preferenceSequence.current) return;
      setVisibleColumns(previous);
      props.onMessage(
        error instanceof Error ? error.message : "保存日志列偏好失败。",
      );
    }
  };
  const toggleColumn = (column: LogColumnId) => {
    const previous = visibleColumns;
    const next = previous.includes(column)
      ? previous.filter((item) => item !== column)
      : [...previous, column];
    if (next.length === 0) return;
    void saveVisibleColumns(next, previous);
  };
  return (
    <Box
      sx={{ display: "flex", flexDirection: "column", gap: "1rem" }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          submitQuery();
        }
      }}
    >
      <Stack spacing={2}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 2,
          }}
        >
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
              gap: 2,
              flex: 1,
              minWidth: 0,
            }}
          >
            {
              <>
                <TextField
                  value={filters.query}
                  placeholder={t("搜索请求 ID、模型或错误")}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      query: event.target.value,
                    }))
                  }
                  label={t("搜索请求 ID、模型或错误")}
                />
                <Select
                  inputProps={{ "aria-label": t("全部状态") }}
                  displayEmpty
                  value={filters.statusClass}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      statusClass: event.target.value,
                    }))
                  }
                >
                  <MenuItem value="">{t("全部状态")}</MenuItem>
                  <MenuItem value="4">4xx</MenuItem>
                  <MenuItem value="5">5xx</MenuItem>
                  <MenuItem value="2">2xx</MenuItem>
                </Select>
                <Select
                  inputProps={{ "aria-label": t("全部密钥") }}
                  displayEmpty
                  value={filters.apiKeyId}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      apiKeyId: event.target.value,
                    }))
                  }
                >
                  <MenuItem value="">{t("全部密钥")}</MenuItem>
                  {props.apiKeys.map((item) => (
                    <MenuItem key={item.apiKey.id} value={item.apiKey.id}>
                      {item.apiKey.name}
                    </MenuItem>
                  ))}
                </Select>
                <TextField
                  value={filters.model}
                  placeholder={t("模型")}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                  label={t("模型")}
                />
                <Select
                  inputProps={{ "aria-label": t("全部请求类型") }}
                  displayEmpty
                  value={filters.apiFormat}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      apiFormat: event.target.value as LogFilters["apiFormat"],
                    }))
                  }
                >
                  <MenuItem value="">{t("全部请求类型")}</MenuItem>
                  {REQUEST_TYPE_OPTIONS.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.endpoint}
                    </MenuItem>
                  ))}
                </Select>
              </>
            }
          </Box>
          <Stack direction="row" spacing={1}>
            {
              <Box sx={{ display: "flex", gap: "0.5rem" }}>
                <Button
                  type="button"
                  size="small"
                  onClick={() => submitQuery()}
                  disabled={loading}
                >
                  <Search
                    sx={{
                      marginRight: "0.5rem",
                      width: "0.75rem",
                      height: "0.75rem",
                    }}
                  />
                  {loading ? t("查询中") : t("查询")}
                </Button>
                <Button
                  type="button"
                  size="small"
                  variant="text"
                  onClick={() => {
                    setFilters(EMPTY_FILTERS);
                    submitQuery(EMPTY_FILTERS);
                  }}
                >
                  {t("重置")}
                </Button>
              </Box>
            }
          </Stack>
        </Box>
        <Accordion
          expanded={advancedOpen}
          onChange={() => setAdvancedOpen((value) => !value)}
          disableGutters
        >
          <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
            {t("高级筛选")}
          </AccordionSummary>
          <AccordionDetails
            sx={{
              display: "grid",
              gap: 2,
              gridTemplateColumns: {
                xs: "1fr",
                md: "repeat(2, 1fr)",
                xl: "repeat(4, 1fr)",
              },
            }}
          >
            {
              <>
                <Select
                  inputProps={{ "aria-label": t("全部上游") }}
                  displayEmpty
                  value={filters.providerId}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      providerId: event.target.value,
                      endpointId: "",
                    }))
                  }
                >
                  <MenuItem value="">{t("全部上游")}</MenuItem>
                  {props.providers.map((item) => (
                    <MenuItem key={item.provider.id} value={item.provider.id}>
                      {item.provider.name}
                    </MenuItem>
                  ))}
                </Select>
                <Select
                  inputProps={{ "aria-label": t("全部目标") }}
                  displayEmpty
                  value={filters.endpointId}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      endpointId: event.target.value,
                    }))
                  }
                >
                  <MenuItem value="">{t("全部目标")}</MenuItem>
                  {endpointOptions.map((item) => (
                    <MenuItem key={item.value} value={item.value}>
                      {item.label}
                    </MenuItem>
                  ))}
                </Select>
                <TextField
                  value={filters.durationMin}
                  placeholder={t("延迟下限")}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      durationMin: event.target.value,
                    }))
                  }
                  label={t("延迟下限")}
                />
                <TextField
                  value={filters.durationMax}
                  placeholder={t("延迟上限")}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      durationMax: event.target.value,
                    }))
                  }
                  label={t("延迟上限")}
                />
                <TextField
                  value={filters.tokenMin}
                  placeholder={t("用量下限")}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      tokenMin: event.target.value,
                    }))
                  }
                  label={t("用量下限")}
                />
                <TextField
                  value={filters.tokenMax}
                  placeholder={t("用量上限")}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      tokenMax: event.target.value,
                    }))
                  }
                  label={t("用量上限")}
                />
                <Select
                  inputProps={{ "aria-label": t("全部用量") }}
                  displayEmpty
                  value={filters.usageObserved}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      usageObserved: event.target
                        .value as LogFilters["usageObserved"],
                    }))
                  }
                >
                  <MenuItem value="">{t("全部用量")}</MenuItem>
                  <MenuItem value="true">{t("已返回用量")}</MenuItem>
                  <MenuItem value="false">{t("未返回用量")}</MenuItem>
                </Select>
                <TextField
                  value={filters.reasoningMin}
                  placeholder={t("思考下限")}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      reasoningMin: event.target.value,
                    }))
                  }
                  label={t("思考下限")}
                />
                <TextField
                  value={filters.reasoningMax}
                  placeholder={t("思考上限")}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      reasoningMax: event.target.value,
                    }))
                  }
                  label={t("思考上限")}
                />
              </>
            }
          </AccordionDetails>
        </Accordion>
      </Stack>

      <Box sx={{ display: "grid", gap: "1rem" }}>
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
              flexDirection: "column",
              gap: "0.5rem",
              padding: "1rem",
              paddingBottom: "1rem",
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.625rem",
              }}
            >
              <Box>
                <Typography
                  sx={{
                    fontSize: "0.875rem",
                    lineHeight: "calc(1.25 / 0.875)",
                    fontWeight: "600",
                    letterSpacing: "0em",
                    color: "var(--mui-palette-text-primary)",
                  }}
                  component="div"
                >
                  {t("结果")}
                </Typography>
                <Typography
                  sx={{
                    marginTop: "0.125rem",
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                  component="div"
                >
                  {t("默认按最近时间排序。")}
                </Typography>
              </Box>
              <Box
                sx={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: "0.5rem",
                }}
              >
                <Button
                  type="button"
                  size="small"
                  variant="outlined"
                  aria-haspopup="menu"
                  aria-expanded={columnMenuAnchor ? "true" : undefined}
                  onClick={(event) => setColumnMenuAnchor(event.currentTarget)}
                >
                  <Columns3
                    sx={{
                      marginRight: "0.375rem",
                      width: "0.75rem",
                      height: "0.75rem",
                    }}
                    aria-hidden="true"
                  />
                  {t("列")}
                </Button>
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
                    )[errorCount > 0 ? "warning" : "normal"]
                  }
                  label={t("{{count}} 条异常", {
                    count: errorCount,
                  })}
                />
                <Box
                  sx={{
                    borderRadius: "8px",
                    borderStyle: "solid",
                    borderWidth: "1px",
                    borderColor: "var(--mui-palette-divider)",
                    backgroundColor: "transparent",
                    paddingInline: "0.625rem",
                    paddingBlock: "0.125rem",
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    color: "var(--mui-palette-text-secondary)",
                  }}
                >
                  {t("本页")} {formatCompactInteger(filteredRows.length)}
                </Box>
              </Box>
            </Box>
            <Menu
              anchorEl={columnMenuAnchor}
              open={!!columnMenuAnchor}
              onClose={() => setColumnMenuAnchor(null)}
              slotProps={{
                paper: {
                  sx: {
                    maxHeight: 480,
                    minWidth: 240,
                    bgcolor: "background.default",
                    opacity: 1,
                    border: "1px solid",
                    borderColor: "divider",
                    boxShadow: 8,
                  },
                },
              }}
            >
              {LOG_COLUMN_DEFINITIONS.map((column) => (
                <MenuItem
                  key={column.id}
                  dense
                  disabled={
                    visibleColumns.length === 1 &&
                    visibleColumns.includes(column.id)
                  }
                  onClick={() => toggleColumn(column.id)}
                >
                  <Checkbox
                    checked={visibleColumns.includes(column.id)}
                    size="small"
                  />
                  <ListItemText primary={t(column.label)} />
                </MenuItem>
              ))}
              <MenuItem
                divider
                onClick={() =>
                  void saveVisibleColumns(
                    [...DEFAULT_LOG_COLUMNS],
                    visibleColumns,
                  )
                }
              >
                <ListItemText primary={t("恢复默认")} />
              </MenuItem>
            </Menu>
          </Box>
          {loading ? <LinearProgress aria-label={t("加载日志")} /> : null}
          {loadError ? (
            <Alert
              severity="error"
              action={
                <Button
                  variant="text"
                  onClick={() => submitQuery(query.filters)}
                >
                  {t("重试")}
                </Button>
              }
            >
              {loadError}
            </Alert>
          ) : null}
          <CardContent
            sx={{
              padding: "0",
              borderTopStyle: "solid",
              borderTopWidth: "1px",
              borderColor:
                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
            }}
          >
            {rows.length > 0 ? (
              <TableContainer
                data-testid="request-log-table-container"
                sx={[
                  { maxWidth: "100%", overflow: "auto" },
                  { maxHeight: { xs: "65dvh", md: "min(70dvh, 48rem)" } },
                ]}
              >
                <Table
                  stickyHeader
                  aria-label={t("请求日志")}
                  size="small"
                  sx={{ minWidth: 900 }}
                >
                  <TableHead>
                    <TableRow>
                      <TableCell aria-label={t("展开控制")} />
                      {visibleColumnDefinitions.map((column) => (
                        <TableCell
                          key={column.id}
                          data-column-id={column.id}
                          sx={{ whiteSpace: "nowrap" }}
                        >
                          {t(column.label)}
                        </TableCell>
                      ))}
                      <TableCell>{t("详情")}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {visibleRows.map((item) => {
                      const row = item.row;
                      const hasChildren = item.children.length > 0;
                      return (
                        <TableRow
                          key={row.id}
                          hover
                          sx={{
                            ...{ cursor: "pointer" },
                            ...(item.depth > 0
                              ? {
                                  borderLeftStyle: "solid",
                                  borderLeftWidth: "2px",
                                  borderLeftColor:
                                    "color-mix(in oklab, var(--mui-palette-primary-main) 30%, transparent)",
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                }
                              : {}),
                            ...{},
                          }}
                          onClick={() => setSelected(row)}
                        >
                          <TableCell sx={{ pl: item.depth > 0 ? 3 : 1 }}>
                            {hasChildren ? (
                              <IconButton
                                type="button"
                                size="small"

                                sx={{ width: "2rem", height: "2rem" }}
                                aria-label={
                                  expandedSessions[row.id]
                                    ? t("收起 WS 日志")
                                    : t("展开 WS 日志")
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setExpandedSessions((current) => ({
                                    ...current,
                                    [row.id]: !current[row.id],
                                  }));
                                }}
                              >
                                {expandedSessions[row.id] ? (
                                  <ChevronDown
                                    sx={{ width: "0.75rem", height: "0.75rem" }}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <ChevronRight
                                    sx={{ width: "0.75rem", height: "0.75rem" }}
                                    aria-hidden="true"
                                  />
                                )}
                              </IconButton>
                            ) : null}
                          </TableCell>
                          {visibleColumns.map((id) => {
                            return (
                              <TableCell
                                key={id}
                                data-column-id={id}
                                sx={{ maxWidth: 320, overflowWrap: "anywhere" }}
                              >
                                <LogColumnValue
                                  id={id}
                                  row={row}
                                  providerNameMap={providerNameMap}
                                  endpointNameMap={endpointNameMap}
                                  apiKeyNameMap={apiKeyNameMap}
                                />
                              </TableCell>
                            );
                          })}
                          <TableCell>
                            <Button
                              variant="text"
                              onClick={() => setSelected(row)}
                              aria-label={t("查看请求 {{id}} 详情", {
                                id: row.id,
                              })}
                            >
                              {t("详情")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {visibleRows.length === 0 ? (
                  <Box sx={{ py: 6, px: 2, textAlign: "center" }}>
                    <Typography variant="subtitle1">
                      {t("未找到日志")}
                    </Typography>
                    <Typography color="text.secondary" sx={{ mt: 1 }}>
                      {t("尝试放宽筛选条件。")}
                    </Typography>
                    <Box sx={{ mt: 2 }}>
                      {
                        <Button
                          type="button"
                          variant="text"
                          onClick={() => {
                            setFilters(EMPTY_FILTERS);
                            submitQuery(EMPTY_FILTERS);
                          }}
                        >
                          {t("清空筛选")}
                        </Button>
                      }
                    </Box>
                  </Box>
                ) : null}
              </TableContainer>
            ) : (
              <Box sx={{ py: 6, px: 2, textAlign: "center" }}>
                <Typography variant="subtitle1">{t("暂无日志")}</Typography>
                <Typography color="text.secondary" sx={{ mt: 1 }}>
                  {t("有流量后会显示。")}
                </Typography>
              </Box>
            )}
          </CardContent>
        </Card>
      </Box>

      <TablePagination
        getItemAriaLabel={(type) =>
          t(
            type === "next"
              ? "下一页"
              : type === "previous"
                ? "上一页"
                : type === "first"
                  ? "首页"
                  : "末页",
          )
        }
        component="div"
        count={-1}
        page={page}
        rowsPerPage={pageSize}
        rowsPerPageOptions={[25, 50, 100]}
        labelRowsPerPage={t("每页")}
        labelDisplayedRows={() =>
          rows.length
            ? `${page * pageSize + 1}–${page * pageSize + rows.length}`
            : t("暂无日志")
        }
        onPageChange={(_, next) => setPage(next)}
        onRowsPerPageChange={(event) => {
          setPageSize(Number(event.target.value));
          setPage(0);
        }}
        slotProps={{
          actions: {
            nextButton: {
              disabled: loading || !!loadError || rows.length < pageSize,
            },
            previousButton: { disabled: loading || page === 0 },
          },
          select: { disabled: loading },
        }}
      />
      <Drawer
        anchor="right"
        open={!!selected}
        onClose={() => setSelected(null)}
        slotProps={{
          paper: {
            role: "dialog",
            "aria-modal": true,
            "aria-label": t(selected?.id ?? "日志详情"),
            sx: { width: { xs: "100%", sm: 720 }, maxWidth: "100%" },
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            gap: 2,
            p: 3,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              component="h2"
              variant="h2"
              sx={{ overflowWrap: "anywhere" }}
            >
              {t(selected?.id ?? "日志详情")}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              {selected
                ? `${formatDateTime(selected!.time_ms)} · ${formatModelName(selected!.model)}`
                : undefined}
            </Typography>
          </Box>
          <IconButton aria-label={t("关闭")} onClick={() => setSelected(null)}>
            <CloseOutlined />
          </IconButton>
        </Box>
        <Box
          sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: { xs: 2, sm: 3 } }}
        >
          {selected
            ? ((rowSignal) => {
                const row = rowSignal;
                const status = rowStatus(row);
                const pricing = calculateRequestPricing(
                  row,
                  row.usage_observed,
                  row.pricing,
                );
                const pricingValue =
                  pricing.status === "priced"
                    ? formatUsd(pricing.totalUsd)
                    : t("未定价");
                const pricingReason =
                  pricing.status === "unpriced"
                    ? t(describeUnpricedReason(pricing.reason))
                    : null;
                const routeCandidates = row.routing_trace?.candidates ?? [];
                const routeRejections = row.routing_trace?.rejections ?? [];
                return (
                  <Box sx={{ display: "grid", gap: "1rem" }}>
                    <Box
                      sx={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "1rem",
                        "@media (width >= 48rem)": { flexDirection: "row" },
                        borderTopStyle: "solid",
                        borderTopWidth: "1px",
                        borderColor:
                          "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                        paddingTop: "1.25rem",
                        marginTop: "0.25rem",
                        paddingBottom: "1rem",
                      }}
                    >
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.25rem",
                          paddingRight: "1rem",
                          borderRightStyle: "solid",
                          borderRightWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                          "&:last-child": {
                            borderRightStyle: "solid",
                            borderRightWidth: "0px",
                          },
                        }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <Box
                            sx={{
                              fontSize: "0.75rem",
                              textTransform: "uppercase",
                              letterSpacing: "0.1em",
                              color: "var(--mui-palette-text-secondary)",
                            }}
                            component="span"
                          >
                            {t("状态")}
                          </Box>
                        </Box>
                        {
                          <Box sx={{ marginTop: "0.375rem" }}>
                            {
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
                                  )[status.tone]
                                }
                                label={t(status.label)}
                              />
                            }
                          </Box>
                        }
                      </Box>
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.25rem",
                          paddingRight: "1rem",
                          borderRightStyle: "solid",
                          borderRightWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                          "&:last-child": {
                            borderRightStyle: "solid",
                            borderRightWidth: "0px",
                          },
                        }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <Box
                            sx={{
                              fontSize: "0.75rem",
                              textTransform: "uppercase",
                              letterSpacing: "0.1em",
                              color: "var(--mui-palette-text-secondary)",
                            }}
                            component="span"
                          >
                            {t("首字节")}
                          </Box>
                        </Box>
                        {
                          <Box
                            sx={{
                              marginTop: "0.375rem",
                              fontSize: "1.125rem",
                              lineHeight: "calc(1.75 / 1.125)",
                              fontWeight: "500",
                              letterSpacing: "-0.025em",
                              color: "var(--mui-palette-text-primary)",
                            }}
                          >
                            {formatMaybeMs(row.t_first_byte_ms)}
                          </Box>
                        }
                      </Box>
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.25rem",
                          paddingRight: "1rem",
                          borderRightStyle: "solid",
                          borderRightWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                          "&:last-child": {
                            borderRightStyle: "solid",
                            borderRightWidth: "0px",
                          },
                        }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <Box
                            sx={{
                              fontSize: "0.75rem",
                              textTransform: "uppercase",
                              letterSpacing: "0.1em",
                              color: "var(--mui-palette-text-secondary)",
                            }}
                            component="span"
                          >
                            {t("TTFT")}
                          </Box>
                        </Box>
                        {
                          <Box
                            sx={{
                              marginTop: "0.375rem",
                              fontSize: "1.125rem",
                              lineHeight: "calc(1.75 / 1.125)",
                              fontWeight: "500",
                              letterSpacing: "-0.025em",
                              color: "var(--mui-palette-text-primary)",
                            }}
                          >
                            {formatMaybeMs(row.t_first_token_ms)}
                          </Box>
                        }
                      </Box>
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.25rem",
                          paddingRight: "1rem",
                          borderRightStyle: "solid",
                          borderRightWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                          "&:last-child": {
                            borderRightStyle: "solid",
                            borderRightWidth: "0px",
                          },
                        }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <Box
                            sx={{
                              fontSize: "0.75rem",
                              textTransform: "uppercase",
                              letterSpacing: "0.1em",
                              color: "var(--mui-palette-text-secondary)",
                            }}
                            component="span"
                          >
                            {t("总耗时")}
                          </Box>
                        </Box>
                        {
                          <Box
                            sx={{
                              marginTop: "0.375rem",
                              fontSize: "1.125rem",
                              lineHeight: "calc(1.75 / 1.125)",
                              fontWeight: "500",
                              letterSpacing: "-0.025em",
                              color: "var(--mui-palette-text-primary)",
                            }}
                          >
                            {formatMaybeMs(primaryLatency(row))}
                          </Box>
                        }
                      </Box>
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.25rem",
                          paddingRight: "1rem",
                          borderRightStyle: "solid",
                          borderRightWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                          "&:last-child": {
                            borderRightStyle: "solid",
                            borderRightWidth: "0px",
                          },
                        }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <Box
                            sx={{
                              fontSize: "0.75rem",
                              textTransform: "uppercase",
                              letterSpacing: "0.1em",
                              color: "var(--mui-palette-text-secondary)",
                            }}
                            component="span"
                          >
                            {t("成本")}
                          </Box>
                        </Box>
                        {(
                          pricing.status === "unpriced" ? (
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
                              label={t("未定价")}
                            />
                          ) : undefined
                        ) ? (
                          <Box sx={{ marginTop: "0.375rem" }}>
                            {pricing.status === "unpriced" ? (
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
                                label={t("未定价")}
                              />
                            ) : undefined}
                          </Box>
                        ) : (
                          <Box
                            sx={{
                              marginTop: "0.375rem",
                              fontSize: "1.125rem",
                              lineHeight: "calc(1.75 / 1.125)",
                              fontWeight: "500",
                              letterSpacing: "-0.025em",
                              color: "var(--mui-palette-text-primary)",
                            }}
                          >
                            {pricingValue}
                          </Box>
                        )}
                      </Box>
                    </Box>

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
                          flexDirection: "column",
                          gap: "0.5rem",
                          padding: "1rem",
                          paddingBottom: "0.75rem",
                        }}
                      >
                        <Typography
                          sx={{
                            fontSize: "0.875rem",
                            lineHeight: "calc(1.25 / 0.875)",
                            fontWeight: "600",
                            letterSpacing: "0em",
                            color: "var(--mui-palette-text-primary)",
                          }}
                          component="div"
                        >
                          {t("请求信息")}
                        </Typography>
                      </Box>
                      <CardContent
                        sx={{
                          display: "grid",
                          gap: "0",
                          borderTopStyle: "solid",
                          borderTopWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                          paddingTop: "0",
                        }}
                      >
                        <Box
                          sx={{
                            display: "grid",
                            "@media (width >= 48rem)": {
                              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                            },
                          }}
                        >
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("时间")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatDateTime(row.time_ms)}
                            >
                              {formatDateTime(row.time_ms)}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(String(row.time_ms), "时间")
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "时间",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("模型")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatModelName(row.model)}
                            >
                              {formatModelName(row.model)}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    formatModelName(row.model),
                                    "模型",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "模型",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("服务档位")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatServiceTier(row.service_tier)}
                            >
                              {formatServiceTier(row.service_tier)}
                            </Box>
                            {null}
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("客户端请求档位")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.requested_service_tier ?? "—"}
                            >
                              {row.requested_service_tier ?? "—"}
                            </Box>
                            {null}
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("上游请求档位")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.upstream_service_tier ?? "—"}
                            >
                              {row.upstream_service_tier ?? "—"}
                            </Box>
                            {null}
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("上游返回档位")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.service_tier ?? t("未确认")}
                            >
                              {row.service_tier ?? t("未确认")}
                            </Box>
                            {null}
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("密钥")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={
                                apiKeyNameMap.get(row.api_key_id) ??
                                `#${row.api_key_id}`
                              }
                            >
                              {apiKeyNameMap.get(row.api_key_id) ??
                                `#${row.api_key_id}`}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(String(row.api_key_id), "密钥")
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "密钥",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("请求路径")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatRequestPath(
                                row.api_format,
                                row.upstream_api_format,
                              )}
                            >
                              {formatRequestPath(
                                row.api_format,
                                row.upstream_api_format,
                              )}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    formatRequestPath(
                                      row.api_format,
                                      row.upstream_api_format,
                                    ),
                                    "请求路径",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "请求路径",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("客户端端点")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatRequestType(row.api_format)}
                            >
                              {formatRequestType(row.api_format)}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    formatRequestType(row.api_format),
                                    "客户端端点",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "客户端端点",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("上游端点")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatUpstreamEndpoint(
                                row.upstream_api_format,
                              )}
                            >
                              {formatUpstreamEndpoint(row.upstream_api_format)}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    formatUpstreamEndpoint(
                                      row.upstream_api_format,
                                    ),
                                    "上游端点",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "上游端点",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("传输")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={transportLabel(row)}
                            >
                              {transportLabel(row)}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(row.transport, "传输")
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "传输",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("日志类型")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.span_kind}
                            >
                              {row.span_kind}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(row.span_kind, "日志类型")
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "日志类型",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("WS 会话")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.ws_session_id ?? "—"}
                            >
                              {row.ws_session_id ?? "—"}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    row.ws_session_id ?? "",
                                    "WS 会话",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "WS 会话",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("请求 ID")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.id}
                            >
                              {row.id}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(row.id, "请求 ID")
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "请求 ID",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("父日志")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.parent_id ?? "—"}
                            >
                              {row.parent_id ?? "—"}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(row.parent_id ?? "", "父日志")
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "父日志",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("上游")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={
                                row.provider_id
                                  ? (providerNameMap.get(row.provider_id) ??
                                    `#${row.provider_id}`)
                                  : "—"
                              }
                            >
                              {row.provider_id
                                ? (providerNameMap.get(row.provider_id) ??
                                  `#${row.provider_id}`)
                                : "—"}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    String(row.provider_id ?? ""),
                                    "上游",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "上游",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("目标")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={
                                row.endpoint_id
                                  ? (endpointNameMap.get(row.endpoint_id) ??
                                    `#${row.endpoint_id}`)
                                  : "—"
                              }
                            >
                              {row.endpoint_id
                                ? (endpointNameMap.get(row.endpoint_id) ??
                                  `#${row.endpoint_id}`)
                                : "—"}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    String(row.endpoint_id ?? ""),
                                    "目标",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "目标",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("错误类型")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.error_type ?? "—"}
                            >
                              {row.error_type ?? "—"}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    row.error_type ?? "",
                                    "错误类型",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "错误类型",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                        </Box>
                      </CardContent>
                    </Card>

                    {row.routing_trace ? (
                      <Accordion disableGutters>
                        <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
                          {t(
                            "尝试 {{count}} 次 · 上限 {{limit}} 次 · 重试等待 {{delay}}",
                            {
                              count:
                                row.routing_trace.attempts_sent ??
                                row.routing_trace.attempts.length,
                              limit: row.routing_trace.attempt_limit ?? "—",
                              delay: formatMaybeMs(
                                row.routing_trace.backoff_ms ?? null,
                              ),
                            },
                          )}
                        </AccordionSummary>
                        <AccordionDetails>
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "0.75rem",
                              padding: "1rem",
                              paddingBottom: "0.75rem",
                            }}
                          >
                            <Typography
                              sx={{
                                fontSize: "0.875rem",
                                lineHeight: "calc(1.25 / 0.875)",
                                fontWeight: "600",
                                letterSpacing: "0em",
                                color: "var(--mui-palette-text-primary)",
                              }}
                              component="div"
                            >
                              {t("路由决策")}
                            </Typography>
                            <Box
                              sx={{
                                fontSize: "0.75rem",
                                color: "var(--mui-palette-text-secondary)",
                              }}
                              component="span"
                            >
                              {t("{{count}} 次 Provider 切换", {
                                count: row.routing_trace.provider_switches,
                              })}
                            </Box>
                          </Box>
                          <CardContent
                            sx={{
                              borderTopStyle: "solid",
                              borderTopWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0",
                            }}
                          >
                            <Box
                              sx={{
                                display: "grid",
                                gap: "0.375rem",
                                borderBottomStyle: "solid",
                                borderBottomWidth: "1px",
                                borderColor:
                                  "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                                paddingInline: "1rem",
                                paddingBlock: "0.75rem",
                                fontSize: "0.75rem",
                                color: "var(--mui-palette-text-secondary)",
                                "@media (width >= 48rem)": {
                                  gridTemplateColumns:
                                    "repeat(2, minmax(0, 1fr))",
                                },
                              }}
                            >
                              <Box>
                                {row.routing_trace.authorized_provider_ids
                                  ? t("允许使用的上游：{{upstreams}}", {
                                      upstreams:
                                        row.routing_trace.authorized_provider_ids
                                          .map(
                                            (id) =>
                                              providerNameMap.get(id) ??
                                              `#${id}`,
                                          )
                                          .join(", ") || "—",
                                    })
                                  : t("授权组：{{groups}}", {
                                      groups:
                                        row.routing_trace.authorized_groups
                                          .map((group) => group.name)
                                          .join(", ") || "—",
                                    })}
                              </Box>
                              {row.routing_trace.model_route ? (
                                <Box>
                                  {t("模型路由")}：
                                  {row.routing_trace.model_route.model_name ===
                                  "*"
                                    ? t("默认路由")
                                    : row.routing_trace.model_route
                                        .model_name}{" "}
                                  ·{" "}
                                  {t(
                                    row.routing_trace.model_route.mode ===
                                      "weighted"
                                      ? "同优先级内加权"
                                      : "按顺序",
                                  )}
                                </Box>
                              ) : null}
                              <Box>
                                {row.routing_trace.affinity
                                  ? t("亲和：{{state}} · {{hash}}", {
                                      state: row.routing_trace.affinity.hit
                                        ? "命中"
                                        : "新建",
                                      hash: row.routing_trace.affinity.hash,
                                    })
                                  : t("亲和：无会话标识")}
                              </Box>
                              {row.routing_trace.affinity ? (
                                <Box
                                  sx={{
                                    "@media (width >= 48rem)": {
                                      gridColumn: "span 2 / span 2",
                                    },
                                  }}
                                >
                                  {t(
                                    "完整目标：Provider #{{provider}} · Endpoint #{{endpoint}} · Key #{{key}}",
                                    {
                                      provider:
                                        row.routing_trace.affinity
                                          .bound_provider_id ?? "—",
                                      endpoint:
                                        row.routing_trace.affinity
                                          .bound_endpoint_id ?? "—",
                                      key:
                                        row.routing_trace.affinity
                                          .bound_upstream_key_id ?? "—",
                                    },
                                  )}
                                </Box>
                              ) : null}
                              {row.routing_trace.encrypted_content_recovery &&
                              (row.routing_trace.encrypted_content_recovery
                                .retries > 0 ||
                                row.routing_trace.encrypted_content_recovery
                                  .filtered_items > 0) ? (
                                <Box
                                  sx={{
                                    "@media (width >= 48rem)": {
                                      gridColumn: "span 2 / span 2",
                                    },
                                  }}
                                >
                                  {t(
                                    "加密内容恢复：重试 {{retries}} 次 · 清理 {{stripped}} 项 · 过滤旧密文 {{filtered}} 项",
                                    {
                                      retries:
                                        row.routing_trace
                                          .encrypted_content_recovery.retries,
                                      stripped:
                                        row.routing_trace
                                          .encrypted_content_recovery
                                          .stripped_items,
                                      filtered:
                                        row.routing_trace
                                          .encrypted_content_recovery
                                          .filtered_items,
                                    },
                                  )}
                                </Box>
                              ) : null}
                              {row.routing_trace.conversion ? (
                                <Box
                                  sx={{
                                    "@media (width >= 48rem)": {
                                      gridColumn: "span 2 / span 2",
                                    },
                                  }}
                                >
                                  {formatRequestPath(
                                    row.routing_trace.conversion
                                      .client_api_format,
                                    row.routing_trace.conversion
                                      .upstream_api_format,
                                  )}
                                  {row.routing_trace.conversion.warnings
                                    .length > 0
                                    ? ` · ${t("转换警告")}：${row.routing_trace.conversion.warnings.join(", ")}`
                                    : ` · ${t("无转换警告")}`}
                                </Box>
                              ) : null}
                            </Box>
                            {routeCandidates.length > 0 ? (
                              <>
                                <Box
                                  sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: "0.75rem",
                                    borderBottomStyle: "solid",
                                    borderBottomWidth: "1px",
                                    borderColor:
                                      "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                                    paddingInline: "1rem",
                                    paddingBlock: "0.625rem",
                                  }}
                                >
                                  <Typography
                                    sx={{
                                      fontSize: "0.875rem",
                                      lineHeight: "calc(1.25 / 0.875)",
                                      fontWeight: "500",
                                      color: "var(--mui-palette-text-primary)",
                                    }}
                                    component="div"
                                  >
                                    {t("候选 Provider")}
                                  </Typography>
                                  <Typography
                                    sx={{
                                      fontSize: "0.75rem",
                                      lineHeight: "calc(1 / 0.75)",
                                      color:
                                        "var(--mui-palette-text-secondary)",
                                    }}
                                    component="span"
                                  >
                                    {t("{{count}} 个候选", {
                                      count: routeCandidates.length,
                                    })}
                                  </Typography>
                                </Box>
                                <TableContainer
                                  sx={{ maxWidth: "100%", overflowX: "auto" }}
                                >
                                  <Table
                                    size="small"
                                    aria-label={t("候选 Provider")}
                                  >
                                    <TableHead>
                                      <TableRow>
                                        <TableCell>{t("上游")}</TableCell>
                                        <TableCell>{t("上游模型")}</TableCell>
                                        <TableCell>{t("协议计划")}</TableCell>
                                        <TableCell>{t("优先级")}</TableCell>
                                        <TableCell>{t("权重")}</TableCell>
                                        <TableCell sx={{ textAlign: "right" }}>
                                          {t("尝试预算")}
                                        </TableCell>
                                      </TableRow>
                                    </TableHead>
                                    <TableBody>
                                      {routeCandidates.map(
                                        (candidate, index) => (
                                          <TableRow
                                            key={`${candidate.provider_id}-${candidate.upstream_model ?? "model"}-${index}`}
                                          >
                                            <TableCell
                                              sx={{
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                              }}
                                            >
                                              {providerNameMap.get(
                                                candidate.provider_id,
                                              ) ?? `#${candidate.provider_id}`}
                                            </TableCell>
                                            <TableCell
                                              sx={{
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                              }}
                                            >
                                              {candidate.upstream_model ?? "—"}
                                            </TableCell>
                                            <TableCell
                                              sx={{
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                              }}
                                            >
                                              {formatRoutingProtocol(
                                                candidate.upstream_api_format,
                                                candidate.conversion_mode,
                                              )}
                                            </TableCell>
                                            <TableCell
                                              sx={{
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                              }}
                                            >
                                              {candidate.priority}
                                            </TableCell>
                                            <TableCell
                                              sx={{
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                              }}
                                            >
                                              {candidate.weight}
                                            </TableCell>
                                            <TableCell
                                              sx={{
                                                textAlign: "right",
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                              }}
                                            >
                                              {candidate.attempt_budget}
                                            </TableCell>
                                          </TableRow>
                                        ),
                                      )}
                                    </TableBody>
                                  </Table>
                                </TableContainer>
                              </>
                            ) : null}

                            {routeRejections.length > 0 ? (
                              <>
                                <Box
                                  sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: "0.75rem",
                                    borderBlockStyle: "solid",
                                    borderBlockWidth: "1px",
                                    borderColor:
                                      "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                                    paddingInline: "1rem",
                                    paddingBlock: "0.625rem",
                                  }}
                                >
                                  <Typography
                                    sx={{
                                      fontSize: "0.875rem",
                                      lineHeight: "calc(1.25 / 0.875)",
                                      fontWeight: "500",
                                      color: "var(--mui-palette-text-primary)",
                                    }}
                                    component="div"
                                  >
                                    {t("排除原因")}
                                  </Typography>
                                  <Typography
                                    sx={{
                                      fontSize: "0.75rem",
                                      lineHeight: "calc(1 / 0.75)",
                                      color:
                                        "var(--mui-palette-text-secondary)",
                                    }}
                                    component="span"
                                  >
                                    {t("{{count}} 个排除", {
                                      count: routeRejections.length,
                                    })}
                                  </Typography>
                                </Box>
                                <TableContainer
                                  sx={{ maxWidth: "100%", overflowX: "auto" }}
                                >
                                  <Table
                                    size="small"
                                    aria-label={t("排除原因")}
                                  >
                                    <TableHead>
                                      <TableRow>
                                        <TableCell>{t("上游")}</TableCell>
                                        <TableCell>{t("上游模型")}</TableCell>
                                        <TableCell>{t("阶段")}</TableCell>
                                        <TableCell>{t("原因码")}</TableCell>
                                        <TableCell>{t("说明")}</TableCell>
                                      </TableRow>
                                    </TableHead>
                                    <TableBody>
                                      {routeRejections.map(
                                        (rejection, index) => (
                                          <TableRow
                                            key={`${rejection.provider_id ?? "gateway"}-${rejection.code}-${index}`}
                                          >
                                            <TableCell
                                              sx={{
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                              }}
                                            >
                                              {rejection.provider_id === null
                                                ? t("网关")
                                                : (providerNameMap.get(
                                                    rejection.provider_id,
                                                  ) ??
                                                  `#${rejection.provider_id}`)}
                                            </TableCell>
                                            <TableCell
                                              sx={{
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                              }}
                                            >
                                              {rejection.upstream_model}
                                            </TableCell>
                                            <TableCell
                                              sx={{
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                              }}
                                            >
                                              {rejection.stage}
                                            </TableCell>
                                            <TableCell
                                              sx={{
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                                color:
                                                  "var(--mui-palette-text-primary)",
                                              }}
                                            >
                                              {rejection.code}
                                            </TableCell>
                                            <TableCell
                                              sx={{
                                                minWidth: "18rem",
                                                fontSize: "0.75rem",
                                                lineHeight: "calc(1 / 0.75)",
                                                color:
                                                  "var(--mui-palette-text-secondary)",
                                              }}
                                            >
                                              {rejection.message}
                                            </TableCell>
                                          </TableRow>
                                        ),
                                      )}
                                    </TableBody>
                                  </Table>
                                </TableContainer>
                              </>
                            ) : null}

                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "0.75rem",
                                borderBlockStyle: "solid",
                                borderBlockWidth: "1px",
                                borderColor:
                                  "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                                paddingInline: "1rem",
                                paddingBlock: "0.625rem",
                              }}
                            >
                              <Typography
                                sx={{
                                  fontSize: "0.875rem",
                                  lineHeight: "calc(1.25 / 0.875)",
                                  fontWeight: "500",
                                  color: "var(--mui-palette-text-primary)",
                                }}
                                component="div"
                              >
                                {t("尝试记录")}
                              </Typography>
                              <Typography
                                sx={{
                                  fontSize: "0.75rem",
                                  lineHeight: "calc(1 / 0.75)",
                                  color: "var(--mui-palette-text-secondary)",
                                }}
                                component="span"
                              >
                                {t("{{count}} 次尝试", {
                                  count:
                                    row.routing_trace.attempts_sent ??
                                    row.routing_trace.attempts.length,
                                })}
                              </Typography>
                            </Box>
                            <TableContainer
                              sx={{ maxWidth: "100%", overflowX: "auto" }}
                            >
                              <Table size="small" aria-label={t("尝试记录")}>
                                <TableHead>
                                  <TableRow>
                                    <TableCell>{t("序号")}</TableCell>
                                    <TableCell>{t("上游")}</TableCell>
                                    <TableCell>{t("目标 / 密钥")}</TableCell>
                                    <TableCell>{t("协议计划")}</TableCell>
                                    <TableCell>{t("结果")}</TableCell>
                                    <TableCell sx={{ textAlign: "right" }}>
                                      {t("耗时")}
                                    </TableCell>
                                  </TableRow>
                                </TableHead>
                                <TableBody>
                                  {row.routing_trace.attempts.length > 0 ? (
                                    row.routing_trace.attempts.map(
                                      (attempt, index) => (
                                        <TableRow
                                          key={`${attempt.provider_id}-${attempt.endpoint_id}-${attempt.upstream_key_id}-${index}`}
                                        >
                                          <TableCell
                                            sx={{
                                              fontSize: "0.75rem",
                                              lineHeight: "calc(1 / 0.75)",
                                            }}
                                          >
                                            {index + 1}
                                          </TableCell>
                                          <TableCell
                                            sx={{
                                              fontSize: "0.75rem",
                                              lineHeight: "calc(1 / 0.75)",
                                            }}
                                          >
                                            {providerNameMap.get(
                                              attempt.provider_id,
                                            ) ?? `#${attempt.provider_id}`}
                                          </TableCell>
                                          <TableCell
                                            sx={{
                                              fontSize: "0.75rem",
                                              lineHeight: "calc(1 / 0.75)",
                                            }}
                                          >
                                            #{attempt.endpoint_id} / #
                                            {attempt.upstream_key_id}
                                          </TableCell>
                                          <TableCell
                                            sx={{
                                              fontSize: "0.75rem",
                                              lineHeight: "calc(1 / 0.75)",
                                            }}
                                          >
                                            {formatRoutingProtocol(
                                              attempt.upstream_api_format,
                                              attempt.conversion_mode,
                                            )}
                                          </TableCell>
                                          <TableCell
                                            sx={{
                                              fontSize: "0.75rem",
                                              lineHeight: "calc(1 / 0.75)",
                                            }}
                                          >
                                            {attempt.status ?? "—"}{" "}
                                            {attempt.error_type ?? ""}
                                          </TableCell>
                                          <TableCell
                                            sx={{
                                              textAlign: "right",
                                              fontSize: "0.75rem",
                                              lineHeight: "calc(1 / 0.75)",
                                            }}
                                          >
                                            {formatMaybeMs(attempt.duration_ms)}
                                          </TableCell>
                                        </TableRow>
                                      ),
                                    )
                                  ) : (
                                    <TableRow>
                                      <TableCell
                                        sx={{
                                          paddingBlock: "1rem",
                                          textAlign: "center",
                                          fontSize: "0.875rem",
                                          color:
                                            "var(--mui-palette-text-secondary)",
                                        }}
                                        colSpan={6}
                                      >
                                        {t("未发起上游尝试")}
                                      </TableCell>
                                    </TableRow>
                                  )}
                                </TableBody>
                              </Table>
                            </TableContainer>
                          </CardContent>
                        </AccordionDetails>
                      </Accordion>
                    ) : null}

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
                          flexDirection: "column",
                          gap: "0.5rem",
                          padding: "1rem",
                          paddingBottom: "0.75rem",
                        }}
                      >
                        <Typography
                          sx={{
                            fontSize: "0.875rem",
                            lineHeight: "calc(1.25 / 0.875)",
                            fontWeight: "600",
                            letterSpacing: "0em",
                            color: "var(--mui-palette-text-primary)",
                          }}
                          component="div"
                        >
                          {t("用量信息")}
                        </Typography>
                      </Box>
                      <CardContent
                        sx={{
                          display: "grid",
                          gap: "0",
                          borderTopStyle: "solid",
                          borderTopWidth: "1px",
                          borderColor:
                            "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                          paddingTop: "0",
                        }}
                      >
                        <Box
                          sx={{
                            display: "grid",
                            "@media (width >= 48rem)": {
                              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                            },
                          }}
                        >
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("总用量")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatCompactInteger(totalTokens(row))}
                            >
                              {formatCompactInteger(totalTokens(row))}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    String(totalTokens(row)),
                                    "总用量",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "总用量",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("输入用量")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatCompactInteger(row.input_tokens)}
                            >
                              {formatCompactInteger(row.input_tokens)}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    String(row.input_tokens),
                                    "输入用量",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "输入用量",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("输出用量")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatCompactInteger(row.output_tokens)}
                            >
                              {formatCompactInteger(row.output_tokens)}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    String(row.output_tokens),
                                    "输出用量",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "输出用量",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("可见输出")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatCompactInteger(
                                visibleOutputTokens(row),
                              )}
                            >
                              {formatCompactInteger(visibleOutputTokens(row))}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    String(visibleOutputTokens(row)),
                                    "可见输出",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "可见输出",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("思考用量")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatCompactInteger(
                                row.reasoning_output_tokens,
                              )}
                            >
                              {formatCompactInteger(
                                row.reasoning_output_tokens,
                              )}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    String(row.reasoning_output_tokens),
                                    "思考用量",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "思考用量",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("缓存读取")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatCompactInteger(
                                row.cache_read_input_tokens,
                              )}
                            >
                              {formatCompactInteger(
                                row.cache_read_input_tokens,
                              )}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    String(row.cache_read_input_tokens),
                                    "缓存读取",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "缓存读取",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("缓存写入")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={formatCompactInteger(
                                row.cache_creation_input_tokens,
                              )}
                            >
                              {formatCompactInteger(
                                row.cache_creation_input_tokens,
                              )}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    String(row.cache_creation_input_tokens),
                                    "缓存写入",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "缓存写入",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("用量状态")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={
                                row.usage_observed ? "已返回用量" : "未返回用量"
                              }
                            >
                              {row.usage_observed ? "已返回用量" : "未返回用量"}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    row.usage_observed ? "observed" : "missing",
                                    "用量状态",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "用量状态",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("成本")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={pricingValue}
                            >
                              {pricingValue}
                            </Box>
                            {(
                              pricing.status === "priced"
                                ? () =>
                                    void copyField(
                                      pricing.totalUsd.toString(),
                                      "成本",
                                    )
                                : undefined
                            ) ? (
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={
                                  pricing.status === "priced"
                                    ? () =>
                                        void copyField(
                                          pricing.totalUsd.toString(),
                                          "成本",
                                        )
                                    : undefined
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "成本",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            ) : null}
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("定价状态")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={
                                pricing.status === "priced"
                                  ? t("已定价")
                                  : (pricingReason ?? t("未定价"))
                              }
                            >
                              {pricing.status === "priced"
                                ? t("已定价")
                                : (pricingReason ?? t("未定价"))}
                            </Box>
                            {null}
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("价格版本")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={
                                row.pricing
                                  ? `#${row.pricing.price_version_id}`
                                  : "—"
                              }
                            >
                              {row.pricing
                                ? `#${row.pricing.price_version_id}`
                                : "—"}
                            </Box>
                            {null}
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("价格层级")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={
                                row.pricing?.tier_index === null ||
                                row.pricing == null
                                  ? "—"
                                  : String(row.pricing.tier_index)
                              }
                            >
                              {row.pricing?.tier_index === null ||
                              row.pricing == null
                                ? "—"
                                : String(row.pricing.tier_index)}
                            </Box>
                            {null}
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.375rem",
                              borderBottomStyle: "solid",
                              borderBottomWidth: "1px",
                              borderRightStyle: "solid",
                              borderRightWidth: "1px",
                              borderColor:
                                "color-mix(in oklab, var(--mui-palette-divider) 40%, transparent)",
                              padding: "0.75rem",
                              position: "relative",
                              "&:hover": {
                                "@media (hover: hover)": {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--mui-palette-action-hover) 10%, transparent)",
                                },
                              },
                              transitionProperty:
                                "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
                              transitionTimingFunction: "ease",
                              transitionDuration: "150ms",
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
                                  textTransform: "uppercase",
                                  letterSpacing: "0.1em",
                                  color: "var(--mui-palette-text-secondary)",
                                  opacity: "70%",
                                }}
                                component="span"
                              >
                                {t("错误信息")}
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                wordBreak: "break-all",
                                fontSize: "0.875rem",
                                color: "var(--mui-palette-text-primary)",
                                paddingRight: "1.75rem",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={row.error_message ?? "无"}
                            >
                              {row.error_message ?? "无"}
                            </Box>
                            {
                              <IconButton
                                type="button"
                                size="small"
                                sx={{
                                  position: "absolute",
                                  right: "0.375rem",
                                  bottom: "0.375rem",
                                  width: "1.5rem",
                                  height: "auto",
                                  opacity: 1,
                                  transitionProperty: "opacity",
                                  transitionTimingFunction: "ease",
                                  transitionDuration: "150ms",
                                }}
                                onClick={() =>
                                  void copyField(
                                    row.error_message ?? "",
                                    "错误信息",
                                  )
                                }
                                aria-label={t("复制 {{label}}", {
                                  label: "错误信息",
                                })}
                              >
                                <Copy
                                  sx={{ width: "0.75rem", height: "0.75rem" }}
                                  aria-hidden="true"
                                />
                              </IconButton>
                            }
                          </Box>
                        </Box>
                      </CardContent>
                    </Card>
                  </Box>
                );
              })(selected)
            : null}
        </Box>
      </Drawer>
    </Box>
  );
}
function LogColumnValue(props: {
  id: LogColumnId;
  row: RequestLogRow;
  providerNameMap: Map<number, string>;
  endpointNameMap: Map<number, string>;
  apiKeyNameMap: Map<number, string>;
}) {
  const { t } = useI18n();
  const { id, row } = props;
  const status = rowStatus(row);
  switch (id) {
    case "time":
      return (
        <Box
          sx={{
            ...{},
            ...{
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
          }}
          title={formatDateTime(row.time_ms)}
        >
          {formatDateTime(row.time_ms)}
        </Box>
      );
    case "service_tier":
      return (
        <Box
          sx={{
            fontSize: "0.75rem",
            lineHeight: "calc(1 / 0.75)",
          }}
        >
          {formatServiceTier(row.service_tier)}
        </Box>
      );
    case "model":
      return (
        <Box
          sx={{
            ...{},
            ...{
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...{ maxWidth: "260px", wordBreak: "break-all" },
          }}
          title={formatModelName(row.model)}
        >
          {isWsSession(row) ? t("WS 会话") : formatModelName(row.model)}
        </Box>
      );
    case "request_path":
      return (
        <Box
          sx={{
            ...{},
            ...{
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...{ whiteSpace: "nowrap" },
          }}
        >
          {formatRequestPath(row.api_format, row.upstream_api_format)}
        </Box>
      );
    case "status":
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
            )[status.tone]
          }
          label={t(status.label)}
        />
      );
    case "duration":
      return (
        <Box
          sx={{
            fontSize: "0.75rem",
            lineHeight: "calc(1 / 0.75)",
          }}
        >
          {formatMaybeMs(primaryLatency(row))}
        </Box>
      );
    case "total_tokens":
      return row.usage_observed ? (
        <UsageBreakdown row={row} />
      ) : (
        <Box
          sx={{
            ...{},
            ...{
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...{ color: "var(--mui-palette-text-secondary)" },
          }}
        >
          {t("未返回用量")}
        </Box>
      );
    case "api_key":
      return (
        <Box
          sx={{
            ...{},
            ...{
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...{
              wordBreak: "break-all",
              color: "var(--mui-palette-text-secondary)",
            },
          }}
        >
          {props.apiKeyNameMap.get(row.api_key_id) ?? `#${row.api_key_id}`}
        </Box>
      );
    case "provider":
      return (
        <Box
          sx={{
            ...{},
            ...{
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...{ wordBreak: "break-all" },
          }}
        >
          {row.provider_id
            ? (props.providerNameMap.get(row.provider_id) ??
              `#${row.provider_id}`)
            : "—"}
        </Box>
      );
    case "endpoint":
      return (
        <Box
          sx={{
            ...{},
            ...{
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...{ wordBreak: "break-all" },
          }}
        >
          {row.endpoint_id
            ? (props.endpointNameMap.get(row.endpoint_id) ??
              `#${row.endpoint_id}`)
            : "—"}
        </Box>
      );
    case "transport":
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
            )[transportTone(row)]
          }
          label={t(transportLabel(row))}
        />
      );
    case "first_byte":
      return (
        <Box
          sx={{
            fontSize: "0.75rem",
            lineHeight: "calc(1 / 0.75)",
          }}
        >
          {formatMaybeMs(row.t_first_byte_ms)}
        </Box>
      );
    case "ttft":
      return (
        <Box
          sx={{
            fontSize: "0.75rem",
            lineHeight: "calc(1 / 0.75)",
          }}
        >
          {formatMaybeMs(row.t_first_token_ms)}
        </Box>
      );
    case "cost": {
      const pricing = calculateRequestPricing(
        row,
        row.usage_observed,
        row.pricing,
      );
      return (
        <Box
          sx={{
            fontSize: "0.75rem",
            lineHeight: "calc(1 / 0.75)",
          }}
        >
          {pricing.status === "priced" ? formatUsd(pricing.totalUsd) : "—"}
        </Box>
      );
    }
    case "request_id":
      return (
        <Box
          sx={{
            ...{},
            ...{
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...{
              maxWidth: "240px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
          }}
          title={row.id}
        >
          {row.id}
        </Box>
      );
    case "error_type":
      return (
        <Box
          sx={{
            ...{},
            ...{
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...{
              wordBreak: "break-all",
              color: "var(--mui-palette-text-secondary)",
            },
          }}
        >
          {row.error_type ?? "—"}
        </Box>
      );
  }
}
function UsageBreakdown({ row }: { row: RequestLogRow }) {
  const { t } = useI18n();
  const description = [
    [t("输入"), row.input_tokens],
    [t("输出"), row.output_tokens],
    [t("缓存读"), row.cache_read_input_tokens],
    [t("缓存写"), row.cache_creation_input_tokens],
    [t("思考（包含在输出中）"), row.reasoning_output_tokens],
  ]
    .map(([label, value]) => `${label}: ${value}`)
    .join(" · ");
  return (
    <Tooltip title={description}>
      <Typography
        component="span"
        tabIndex={0}
        aria-label={description}
        sx={{ fontVariantNumeric: "tabular-nums" }}
      >
        {formatCompactInteger(totalTokens(row))}
      </Typography>
    </Tooltip>
  );
}

export function formatServiceTier(value: string | null | undefined): string {
  if (!value) return t("未确认");
  if (value === "fast" || value === "priority") return "Fast";
  if (value === "default") return "Standard";
  return value;
}
