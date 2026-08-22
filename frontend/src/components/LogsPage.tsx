import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, Columns3, Copy, Search } from "lucide-react";
import { DetailDrawer } from '@/components/console/DetailDrawer';
import { EmptyState } from '@/components/console/EmptyState';
import { FilterBar } from '@/components/console/FilterBar';
import { StatusBadge } from '@/components/console/StatusBadge';
import {
  ColumnResizeHandle,
  useResizableColumns,
} from '@/components/console/ResizableTable';
import { t } from '@/lib/i18n';
import { loadConsolePreferences, loadRequestLogs, updateConsolePreferences } from '../lib/api';
import {
  formatCompactInteger,
  formatDateTime,
  formatModelName,
  formatMs,
  formatRequestType,
  formatRequestPath,
  REQUEST_TYPE_OPTIONS,
} from '../lib/format';
import { calculateRequestPricing, describeUnpricedReason, formatUsd } from '../lib/pricing';
import type { ApiKeyWorkspace, ConnectionSettings, ProviderWorkspace, RequestLogRow } from '../lib/types';
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import InputBase from "@mui/material/InputBase";
import MenuItem from "@mui/material/MenuItem";
import Menu from "@mui/material/Menu";
import Checkbox from "@mui/material/Checkbox";
import ListItemText from "@mui/material/ListItemText";
import Select from "@mui/material/Select";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableContainer from "@mui/material/TableContainer";
import Typography from "@mui/material/Typography";
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
  apiFormat: '' | 'chat_completions' | 'responses';
  providerId: string;
  endpointId: string;
  durationMin: string;
  durationMax: string;
  tokenMin: string;
  tokenMax: string;
  usageObserved: '' | 'true' | 'false';
  reasoningMin: string;
  reasoningMax: string;
}
const EMPTY_FILTERS: LogFilters = {
  query: '',
  statusClass: '',
  apiKeyId: '',
  model: '',
  apiFormat: '',
  providerId: '',
  endpointId: '',
  durationMin: '',
  durationMax: '',
  tokenMin: '',
  tokenMax: '',
  usageObserved: '',
  reasoningMin: '',
  reasoningMax: ''
};
export const LOG_COLUMN_DEFINITIONS = [
  { id: 'time', label: '时间', defaultWidth: 160, minWidth: 112, maxWidth: 320 },
  { id: 'model', label: '模型', defaultWidth: 180, minWidth: 120, maxWidth: 480 },
  { id: 'request_path', label: '请求路径 / 转换', defaultWidth: 240, minWidth: 160, maxWidth: 480 },
  { id: 'status', label: '状态', defaultWidth: 88, minWidth: 72, maxWidth: 180 },
  { id: 'duration', label: '耗时', defaultWidth: 110, minWidth: 80, maxWidth: 240 },
  { id: 'total_tokens', label: '用量', defaultWidth: 360, minWidth: 280, maxWidth: 640 },
  { id: 'api_key', label: '密钥', defaultWidth: 130, minWidth: 96, maxWidth: 360 },
  { id: 'provider', label: '上游', defaultWidth: 140, minWidth: 96, maxWidth: 360 },
  { id: 'endpoint', label: '目标', defaultWidth: 140, minWidth: 96, maxWidth: 360 },
  { id: 'transport', label: '传输', defaultWidth: 110, minWidth: 88, maxWidth: 240 },
  { id: 'first_byte', label: '首字节', defaultWidth: 100, minWidth: 80, maxWidth: 240 },
  { id: 'ttft', label: 'TTFT', defaultWidth: 100, minWidth: 80, maxWidth: 240 },
  { id: 'cost', label: '成本', defaultWidth: 110, minWidth: 88, maxWidth: 240 },
  { id: 'request_id', label: '请求 ID', defaultWidth: 190, minWidth: 140, maxWidth: 480 },
  { id: 'error_type', label: '错误类型', defaultWidth: 150, minWidth: 112, maxWidth: 420 },
] as const;
export type LogColumnId = typeof LOG_COLUMN_DEFINITIONS[number]['id'];
const LOG_COLUMN_DEFINITION_MAP = new Map(LOG_COLUMN_DEFINITIONS.map(column => [column.id, column]));
const LEGACY_LOG_USAGE_COLUMN_IDS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read',
  'cache_write',
  'reasoning',
]);
export const DEFAULT_LOG_COLUMNS: LogColumnId[] = [
  'time',
  'model',
  'request_path',
  'status',
  'duration',
  'total_tokens',
  'api_key',
];
const LOG_COLUMN_IDS = new Set<LogColumnId>(LOG_COLUMN_DEFINITIONS.map(column => column.id));

export function sanitizeLogColumns(columns: string[]): LogColumnId[] {
  const seen = new Set<LogColumnId>();
  const filtered: LogColumnId[] = [];
  for (const column of columns) {
    const normalized = LEGACY_LOG_USAGE_COLUMN_IDS.has(column) ? 'total_tokens' : column;
    if (!LOG_COLUMN_IDS.has(normalized as LogColumnId) || seen.has(normalized as LogColumnId)) continue;
    seen.add(normalized as LogColumnId);
    filtered.push(normalized as LogColumnId);
  }
  return filtered.length > 0 ? filtered : [...DEFAULT_LOG_COLUMNS];
}

export function formatUpstreamEndpoint(apiFormat: RequestLogRow['upstream_api_format']): string {
  return apiFormat ? formatRequestType(apiFormat) : '—';
}
export function formatRoutingProtocol(apiFormat: string | null | undefined, conversionMode: string | null | undefined): string {
  const endpoint = formatRequestType(apiFormat);
  return conversionMode === 'responses_via_chat'
    ? `${endpoint} · Responses → Chat`
    : endpoint;
}
function totalTokens(row: RequestLogRow) {
  return row.input_tokens + row.output_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens;
}
function visibleOutputTokens(row: RequestLogRow) {
  return Math.max(row.output_tokens - row.reasoning_output_tokens, 0);
}
function rowStatus(row: RequestLogRow) {
  if (row.http_status === null) {
    return row.error_type ? {
      tone: 'error' as const,
      label: '失败'
    } : {
      tone: 'normal' as const,
      label: '—'
    };
  }
  if (row.http_status >= 500) return {
    tone: 'error' as const,
    label: String(row.http_status)
  };
  if (row.http_status >= 400) return {
    tone: 'warning' as const,
    label: String(row.http_status)
  };
  return {
    tone: 'normal' as const,
    label: String(row.http_status)
  };
}
function formatMaybeMs(value: number | null) {
  return value === null ? '—' : formatMs(value);
}
function primaryLatency(row: RequestLogRow) {
  return row.duration_ms ?? row.t_first_token_ms ?? row.t_first_byte_ms ?? null;
}
function isWsSession(row: RequestLogRow) {
  return row.span_kind === 'ws_session';
}
function transportLabel(row: RequestLogRow) {
  if (row.span_kind === 'ws_session') return 'WS';
  if (row.span_kind === 'ws_session_close') return 'WS Close';
  if (row.transport === 'ws_setup') return 'WS Setup';
  if (row.transport === 'ws_http_bridge') return 'HTTP Bridge';
  if (row.transport === 'ws_native') return 'Native WS';
  if (row.transport === 'ws') return 'WS';
  return 'HTTP';
}
function transportTone(row: RequestLogRow): 'normal' | 'warning' | 'error' | 'disabled' {
  if (row.transport === 'ws_http_bridge') return 'warning';
  if (row.transport === 'ws_setup') return 'error';
  if (row.transport === 'ws_native' || row.transport === 'ws') return 'normal';
  return 'disabled';
}
export function LogsPage(props: LogsPageProps) {
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rows, setRows] = useState<RequestLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<RequestLogRow | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});
  const [visibleColumns, setVisibleColumns] = useState<LogColumnId[]>(DEFAULT_LOG_COLUMNS);
  const [columnMenuAnchor, setColumnMenuAnchor] = useState<HTMLElement | null>(null);
  const previousRefreshKey = useRef(props.refreshKey);
  const commitLogColumnWidths = useCallback(async (widths: Record<string, number>) => {
    await updateConsolePreferences(props.settings, { log_column_widths: widths });
  }, [props.settings]);
  const reportColumnWidthError = useCallback((error: unknown) => {
    props.onMessage(error instanceof Error ? error.message : '保存日志列宽失败。');
  }, [props.onMessage]);
  const {
    widths: columnWidths,
    applyPersistedWidths,
    resizeColumn,
    resetColumn,
  } = useResizableColumns(
    LOG_COLUMN_DEFINITIONS,
    commitLogColumnWidths,
    reportColumnWidthError,
  );
  const providerNameMap = useMemo(() => new Map(props.providers.map(item => [item.provider.id, item.provider.name])), [props.providers]);
  const endpointNameMap = useMemo(() => new Map(props.providers.flatMap(item => item.endpoints.map(endpoint => [endpoint.id, endpoint.name] as const))), [props.providers]);
  const apiKeyNameMap = useMemo(() => new Map(props.apiKeys.map(item => [item.apiKey.id, item.apiKey.name])), [props.apiKeys]);
  const endpointOptions = useMemo(() => {
    const providerId = filters.providerId;
    return props.providers.flatMap(item => {
      if (providerId && String(item.provider.id) !== providerId) return [];
      return item.endpoints.map(endpoint => ({
        value: String(endpoint.id),
        label: `${item.provider.name} / ${endpoint.name}`
      }));
    });
  }, [filters.providerId, props.providers]);
  const loadLogs = async (activeFilters = filters) => {
    setLoading(true);
    try {
      if (!props.settings.adminToken.trim()) {
        setRows([]);
        return;
      }
      const current = activeFilters;
      const result = await loadRequestLogs(props.settings, {
        page: 1,
        page_size: 50,
        query: current.query || undefined,
        model: current.model || undefined,
        api_key_id: current.apiKeyId ? Number(current.apiKeyId) : undefined,
        provider_id: current.providerId ? Number(current.providerId) : undefined,
        endpoint_id: current.endpointId ? Number(current.endpointId) : undefined,
        api_format: current.apiFormat || undefined,
        status_class: current.statusClass ? Number(current.statusClass) : undefined,
        duration_ms_min: current.durationMin ? Number(current.durationMin) : undefined,
        duration_ms_max: current.durationMax ? Number(current.durationMax) : undefined,
        total_tokens_min: current.tokenMin ? Number(current.tokenMin) : undefined,
        total_tokens_max: current.tokenMax ? Number(current.tokenMax) : undefined,
        usage_observed: current.usageObserved ? current.usageObserved === 'true' : undefined,
        reasoning_output_tokens_min: current.reasoningMin ? Number(current.reasoningMin) : undefined,
        reasoning_output_tokens_max: current.reasoningMax ? Number(current.reasoningMax) : undefined
      });
      setRows(result);
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '读取日志失败。');
      setRows([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadLogs();
    if (props.settings.adminToken.trim()) {
      void loadConsolePreferences(props.settings)
        .then(preferences => {
          setVisibleColumns(sanitizeLogColumns(preferences.log_visible_columns));
          applyPersistedWidths(preferences.log_column_widths);
        })
        .catch(error => props.onMessage(error instanceof Error ? error.message : '读取日志列偏好失败。'));
    }
  }, []);
  useEffect(() => {
    if (previousRefreshKey.current === props.refreshKey) return;
    previousRefreshKey.current = props.refreshKey;
    void loadLogs();
  }, [props.refreshKey]);
  const filteredRows = useMemo(() => {
    const draft = filters;
    return rows.filter(row => {
      const q = draft.query.trim().toLowerCase();
      if (!q) return true;
      return row.id.toLowerCase().includes(q) || (row.model ?? '').toLowerCase().includes(q) || (row.error_type ?? '').toLowerCase().includes(q) || (row.error_message ?? '').toLowerCase().includes(q);
    }).sort((left, right) => right.time_ms - left.time_ms);
  }, [filters, rows]);
  const visibleRows = useMemo(() => {
    const all = filteredRows;
    const visibleIds = new Set(all.map(row => row.id));
    const children = new Set(all.filter(row => row.parent_id && visibleIds.has(row.parent_id)).map(row => row.id));
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
        children: rowChildren
      });
      if (expandedSessions[row.id]) {
        rowChildren.forEach(child => out.push({
          row: child,
          depth: 1,
          children: []
        }));
      }
    }
    return out;
  }, [expandedSessions, filteredRows]);
  const errorCount = useMemo(() => filteredRows.filter(row => (row.http_status ?? 0) >= 400 || row.error_type).length, [filteredRows]);
  const visibleColumnDefinitions = useMemo(
    () => visibleColumns.map(id => LOG_COLUMN_DEFINITION_MAP.get(id)!),
    [visibleColumns],
  );
  const tableWidth = useMemo(
    () => 56 + visibleColumns.reduce((sum, id) => sum + columnWidths[id], 0),
    [columnWidths, visibleColumns],
  );
  const copyField = async (value: string, label: string) => {
    if (!navigator?.clipboard) {
      props.onMessage(t('当前环境不支持复制。'));
      return;
    }
    await navigator.clipboard.writeText(value);
    props.onMessage(t('{{label}} 已复制。', {
      label: t(label)
    }));
  };
  const saveVisibleColumns = async (next: LogColumnId[], previous: LogColumnId[]) => {
    setVisibleColumns(next);
    try {
      const saved = await updateConsolePreferences(props.settings, { log_visible_columns: next });
      setVisibleColumns(sanitizeLogColumns(saved.log_visible_columns));
    } catch (error) {
      setVisibleColumns(previous);
      props.onMessage(error instanceof Error ? error.message : '保存日志列偏好失败。');
    }
  };
  const toggleColumn = (column: LogColumnId) => {
    const previous = visibleColumns;
    const next = previous.includes(column)
      ? previous.filter(item => item !== column)
      : [...previous, column];
    if (next.length === 0) return;
    void saveVisibleColumns(next, previous);
  };
  return <Box className="flex flex-col gap-4">
      <FilterBar primary={<>
            <InputBase value={filters.query} placeholder={t("搜索请求 ID、模型或错误")} onChange={event => setFilters(current => ({
        ...current,
        query: event.target.value
      }))} />
            <Select displayEmpty value={filters.statusClass} onChange={event => setFilters(current => ({
        ...current,
        statusClass: event.target.value
      }))}>
              <MenuItem value="">{t('全部状态')}</MenuItem>
              <MenuItem value="4">4xx</MenuItem>
              <MenuItem value="5">5xx</MenuItem>
              <MenuItem value="2">2xx</MenuItem>
            </Select>
            <Select displayEmpty value={filters.apiKeyId} onChange={event => setFilters(current => ({
        ...current,
        apiKeyId: event.target.value
      }))}>
              <MenuItem value="">{t('全部密钥')}</MenuItem>
              {props.apiKeys.map(item => <MenuItem key={item.apiKey.id} value={item.apiKey.id}>{item.apiKey.name}</MenuItem>)}
            </Select>
            <InputBase value={filters.model} placeholder={t("模型")} onChange={event => setFilters(current => ({
        ...current,
        model: event.target.value
      }))} />
            <Select displayEmpty value={filters.apiFormat} onChange={event => setFilters(current => ({
        ...current,
        apiFormat: event.target.value as LogFilters['apiFormat']
      }))}>
              <MenuItem value="">{t('全部请求类型')}</MenuItem>
              {REQUEST_TYPE_OPTIONS.map(option => (
                <MenuItem key={option.value} value={option.value}>{option.endpoint}</MenuItem>
              ))}
            </Select>
          </>} advanced={<>
            <Select displayEmpty value={filters.providerId} onChange={event => setFilters(current => ({
        ...current,
        providerId: event.target.value,
        endpointId: ''
      }))}>
              <MenuItem value="">{t('全部上游')}</MenuItem>
              {props.providers.map(item => <MenuItem key={item.provider.id} value={item.provider.id}>{item.provider.name}</MenuItem>)}
            </Select>
            <Select displayEmpty value={filters.endpointId} onChange={event => setFilters(current => ({
        ...current,
        endpointId: event.target.value
      }))}>
              <MenuItem value="">{t('全部目标')}</MenuItem>
              {endpointOptions.map(item => <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>)}
            </Select>
            <InputBase value={filters.durationMin} placeholder={t("延迟下限")} onChange={event => setFilters(current => ({
        ...current,
        durationMin: event.target.value
      }))} />
            <InputBase value={filters.durationMax} placeholder={t("延迟上限")} onChange={event => setFilters(current => ({
        ...current,
        durationMax: event.target.value
      }))} />
            <InputBase value={filters.tokenMin} placeholder={t("用量下限")} onChange={event => setFilters(current => ({
        ...current,
        tokenMin: event.target.value
      }))} />
            <InputBase value={filters.tokenMax} placeholder={t("用量上限")} onChange={event => setFilters(current => ({
        ...current,
        tokenMax: event.target.value
      }))} />
            <Select displayEmpty value={filters.usageObserved} onChange={event => setFilters(current => ({
        ...current,
        usageObserved: event.target.value as LogFilters['usageObserved']
      }))}>
              <MenuItem value="">{t('全部用量')}</MenuItem>
              <MenuItem value="true">{t('已返回用量')}</MenuItem>
              <MenuItem value="false">{t('未返回用量')}</MenuItem>
            </Select>
            <InputBase value={filters.reasoningMin} placeholder={t("思考下限")} onChange={event => setFilters(current => ({
        ...current,
        reasoningMin: event.target.value
      }))} />
            <InputBase value={filters.reasoningMax} placeholder={t("思考上限")} onChange={event => setFilters(current => ({
        ...current,
        reasoningMax: event.target.value
      }))} />
          </>} advancedOpen={advancedOpen} onToggleAdvanced={() => setAdvancedOpen(value => !value)} actions={<Box className="flex gap-2">
            <Button type="button" size="sm" onClick={() => void loadLogs()} disabled={loading}>
              <Search className="mr-2 size-3" />
              {loading ? t('查询中') : t('查询')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => {
        setFilters(EMPTY_FILTERS);
        void loadLogs(EMPTY_FILTERS);
      }}>{t("重置")}</Button>
          </Box>} />

      <Box className="grid gap-4">
        <Card className="border border-border bg-background shadow-none">
          <Box className="flex flex-col gap-2 p-4 pb-4">
            <Box className="flex items-center justify-between gap-2.5">
              <Box>
                <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t("结果")}</Typography>
                <Typography className="mt-0.5 font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground" component="div">{t('默认按最近时间排序。')}</Typography>
              </Box>
              <Box className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-haspopup="menu"
                  aria-expanded={columnMenuAnchor ? 'true' : undefined}
                  onClick={event => setColumnMenuAnchor(event.currentTarget)}
                >
                  <Columns3 className="mr-1.5 size-3" aria-hidden="true" />
                  {t('列')}
                </Button>
                <StatusBadge tone={errorCount > 0 ? 'warning' : 'normal'}>{t('{{count}} 条异常', {
                  count: errorCount
                })}</StatusBadge>
                <BadgeSummary label="总数" value={filteredRows.length} />
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
                    bgcolor: 'background.default',
                    opacity: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    boxShadow: 8,
                  },
                },
              }}
            >
              {LOG_COLUMN_DEFINITIONS.map(column => <MenuItem
                key={column.id}
                dense
                disabled={visibleColumns.length === 1 && visibleColumns.includes(column.id)}
                onClick={() => toggleColumn(column.id)}
              >
                <Checkbox checked={visibleColumns.includes(column.id)} size="small" />
                <ListItemText primary={t(column.label)} />
              </MenuItem>)}
              <MenuItem
                divider
                onClick={() => void saveVisibleColumns([...DEFAULT_LOG_COLUMNS], visibleColumns)}
              >
                <ListItemText primary={t('恢复默认')} />
              </MenuItem>
            </Menu>
          </Box>
          <CardContent className="p-0 border-t border-border/40">
            {rows.length > 0 ? <TableContainer
              className="max-w-full overflow-auto"
              data-testid="request-log-table-container"
              sx={{ maxHeight: { xs: '65dvh', md: 'min(70dvh, 48rem)' } }}
            >
              <Table stickyHeader aria-label={t('请求日志')} size="small" sx={{
                tableLayout: 'fixed',
                width: tableWidth,
                '& .MuiTableCell-root': { boxSizing: 'border-box' },
              }}>
                <colgroup>
                  <col style={{ width: 56 }} />
                  {visibleColumnDefinitions.map(column => <col
                    key={column.id}
                    data-column-id={column.id}
                    style={{ width: columnWidths[column.id] }}
                  />)}
                </colgroup>
                <TableHead sx={{ '& .MuiTableCell-head': { bgcolor: 'background.default' } }}>
                  <TableRow>
                    <TableCell aria-label={t('展开控制')} data-sticky-column="expand" sx={{
                      position: 'sticky',
                      left: { xs: 'auto', md: 0 },
                      zIndex: 5,
                      width: 56,
                      minWidth: 56,
                      maxWidth: 56,
                      bgcolor: 'background.default',
                    }} />
                    {visibleColumnDefinitions.map((column, index) => {
                      const width = columnWidths[column.id];
                      return <TableCell
                        key={column.id}
                        aria-label={t(column.label)}
                        data-column-id={column.id}
                        data-sticky-column={index === 0 ? 'first-visible' : undefined}
                        sx={{
                        maxWidth: width,
                        minWidth: column.minWidth,
                        overflow: 'visible',
                        position: 'relative',
                        width,
                        ...(index === 0 ? {
                          position: 'sticky',
                          left: { xs: 0, md: 56 },
                          zIndex: 4,
                          bgcolor: 'background.default',
                          boxShadow: '4px 0 8px -7px rgb(0 0 0 / 0.65)',
                        } : {}),
                      }}>
                        {t(column.label)}
                        <ColumnResizeHandle
                          column={column}
                          label={t('调整 {{column}} 列宽', { column: t(column.label) })}
                          width={width}
                          onResize={resizeColumn}
                          onReset={resetColumn}
                        />
                      </TableCell>;
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visibleRows.map(item => {
                    const row = item.row;
                    const hasChildren = item.children.length > 0;
                    return <TableRow
                      key={row.id}
                      hover
                      className={`cursor-pointer ${item.depth > 0 ? 'border-l-2 border-l-primary/30 bg-muted/10' : ''}`}
                      onClick={() => setSelected(row)}
                    >
                      <TableCell data-sticky-column="expand" sx={{
                        position: 'sticky',
                        left: { xs: 'auto', md: 0 },
                        zIndex: 2,
                        width: 56,
                        minWidth: 56,
                        maxWidth: 56,
                        pl: item.depth > 0 ? 3 : 1,
                        bgcolor: item.depth > 0 ? 'color-mix(in oklab, var(--muted) 10%, var(--background))' : 'background.default',
                        'tr:hover &': { bgcolor: 'color-mix(in oklab, var(--muted) 50%, var(--background))' },
                      }}>
                        {hasChildren ? <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          aria-label={expandedSessions[row.id] ? t('收起 WS 日志') : t('展开 WS 日志')}
                          onClick={event => {
                            event.stopPropagation();
                            setExpandedSessions(current => ({ ...current, [row.id]: !current[row.id] }));
                          }}
                        >
                          {expandedSessions[row.id]
                            ? <ChevronDown className="size-3" aria-hidden="true" />
                            : <ChevronRight className="size-3" aria-hidden="true" />}
                        </Button> : null}
                      </TableCell>
                      {visibleColumns.map((id, index) => {
                        const column = LOG_COLUMN_DEFINITION_MAP.get(id)!;
                        const width = columnWidths[id];
                        return <TableCell
                          key={id}
                          data-column-id={id}
                          data-sticky-column={index === 0 ? 'first-visible' : undefined}
                          sx={{
                            maxWidth: width,
                            minWidth: column.minWidth,
                            overflow: 'hidden',
                            width,
                            ...(index === 0 ? {
                              position: 'sticky',
                              left: { xs: 0, md: 56 },
                              zIndex: 2,
                              bgcolor: item.depth > 0 ? 'color-mix(in oklab, var(--muted) 10%, var(--background))' : 'background.default',
                              boxShadow: '4px 0 8px -7px rgb(0 0 0 / 0.65)',
                              'tr:hover &': { bgcolor: 'color-mix(in oklab, var(--muted) 50%, var(--background))' },
                            } : {}),
                          }}
                        >
                        <LogColumnValue
                          id={id}
                          row={row}
                          providerNameMap={providerNameMap}
                          endpointNameMap={endpointNameMap}
                          apiKeyNameMap={apiKeyNameMap}
                        />
                      </TableCell>;
                      })}
                    </TableRow>;
                  })}
                </TableBody>
              </Table>
              {visibleRows.length === 0 ? <EmptyState title="未找到日志" description="尝试放宽筛选条件。" action={<Button type="button" variant="ghost" onClick={() => {
                setFilters(EMPTY_FILTERS);
                void loadLogs(EMPTY_FILTERS);
              }}>{t("清空筛选")}</Button>} /> : null}
            </TableContainer> : <EmptyState title="暂无日志" description="有流量后会显示。" />}
          </CardContent>
        </Card>

      </Box>

      <DetailDrawer open={!!selected} title={selected?.id ?? '日志详情'} description={selected ? `${formatDateTime(selected!.time_ms)} · ${formatModelName(selected!.model)}` : undefined} onClose={() => setSelected(null)}>
        {selected ? (rowSignal => {
        const row = rowSignal;
        const status = rowStatus(row);
        const pricing = calculateRequestPricing(row, row.usage_observed, row.pricing);
        const pricingValue = pricing.status === 'priced' ? formatUsd(pricing.totalUsd) : t('未定价');
        const pricingReason = pricing.status === 'unpriced' ? t(describeUnpricedReason(pricing.reason)) : null;
        const routeCandidates = row.routing_trace?.candidates ?? [];
        const routeRejections = row.routing_trace?.rejections ?? [];
        return <Box className="grid gap-4">
                <Box className="flex flex-col gap-4 md:flex-row border-t border-border/40 pt-5 mt-1 pb-4">
                  <MetricCard label="状态" value={status.label} badge={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>} />
                  <MetricCard label="首字节" value={formatMaybeMs(row.t_first_byte_ms)} />
                  <MetricCard label="TTFT" value={formatMaybeMs(row.t_first_token_ms)} />
                  <MetricCard label="总耗时" value={formatMaybeMs(primaryLatency(row))} />
                  <MetricCard label="成本" value={pricingValue} badge={pricing.status === 'unpriced' ? <StatusBadge tone="warning">{t('未定价')}</StatusBadge> : undefined} />
                </Box>

                <Card className="border border-border bg-background shadow-none">
                  <Box className="flex flex-col gap-2 p-4 pb-3">
                    <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t("请求信息")}</Typography>
                  </Box>
                  <CardContent className="grid gap-0 border-t border-border/40 pt-0">
                    <Box className="grid md:grid-cols-2">
                      <DetailItem label="时间" value={formatDateTime(row.time_ms)} onCopy={() => void copyField(String(row.time_ms), '时间')} />
                      <DetailItem label="模型" value={formatModelName(row.model)} onCopy={() => void copyField(formatModelName(row.model), '模型')} />
                      <DetailItem label="密钥" value={apiKeyNameMap.get(row.api_key_id) ?? `#${row.api_key_id}`} onCopy={() => void copyField(String(row.api_key_id), '密钥')} />
                      <DetailItem label="请求路径" value={formatRequestPath(row.api_format, row.upstream_api_format)} onCopy={() => void copyField(formatRequestPath(row.api_format, row.upstream_api_format), '请求路径')} />
                      <DetailItem label="客户端端点" value={formatRequestType(row.api_format)} onCopy={() => void copyField(formatRequestType(row.api_format), '客户端端点')} />
                      <DetailItem label="上游端点" value={formatUpstreamEndpoint(row.upstream_api_format)} onCopy={() => void copyField(formatUpstreamEndpoint(row.upstream_api_format), '上游端点')} />
                      <DetailItem label="传输" value={transportLabel(row)} onCopy={() => void copyField(row.transport, '传输')} />
                      <DetailItem label="日志类型" value={row.span_kind} onCopy={() => void copyField(row.span_kind, '日志类型')} />
                      <DetailItem label="WS 会话" value={row.ws_session_id ?? '—'} onCopy={() => void copyField(row.ws_session_id ?? '', 'WS 会话')} />
                      <DetailItem label="请求 ID" value={row.id} onCopy={() => void copyField(row.id, '请求 ID')} />
                      <DetailItem label="父日志" value={row.parent_id ?? '—'} onCopy={() => void copyField(row.parent_id ?? '', '父日志')} />
                      <DetailItem label="上游" value={row.provider_id ? providerNameMap.get(row.provider_id) ?? `#${row.provider_id}` : '—'} onCopy={() => void copyField(String(row.provider_id ?? ''), '上游')} />
                      <DetailItem label="目标" value={row.endpoint_id ? endpointNameMap.get(row.endpoint_id) ?? `#${row.endpoint_id}` : '—'} onCopy={() => void copyField(String(row.endpoint_id ?? ''), '目标')} />
                      <DetailItem label="错误类型" value={row.error_type ?? '—'} onCopy={() => void copyField(row.error_type ?? '', '错误类型')} />
                    </Box>
                  </CardContent>
                </Card>

                {row.routing_trace ? <Card className="border border-border bg-background shadow-none">
                    <Box className="flex items-center justify-between gap-3 p-4 pb-3">
                      <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t('路由决策')}</Typography>
                      <Box className="font-mono text-[0.6875rem] text-muted-foreground" component="span">
                        {t('{{count}} 次 Provider 切换', { count: row.routing_trace.provider_switches })}
                      </Box>
                    </Box>
                    <CardContent className="border-t border-border/40 p-0">
                      <Box className="grid gap-1.5 border-b border-border/40 px-4 py-3 text-[0.6875rem] text-muted-foreground md:grid-cols-2">
                        <Box>{t('授权组：{{groups}}', {
                          groups: row.routing_trace.authorized_groups.map(group => group.name).join(', ') || '—'
                        })}</Box>
                        <Box>{row.routing_trace.affinity
                          ? t('亲和：{{state}} · {{hash}}', {
                              state: row.routing_trace.affinity.hit ? '命中' : '新建',
                              hash: row.routing_trace.affinity.hash
                            })
                          : t('亲和：无会话标识')}</Box>
                        {row.routing_trace.affinity ? <Box className="md:col-span-2">
                          {t('完整目标：Provider #{{provider}} · Endpoint #{{endpoint}} · Key #{{key}}', {
                            provider: row.routing_trace.affinity.bound_provider_id ?? '—',
                            endpoint: row.routing_trace.affinity.bound_endpoint_id ?? '—',
                            key: row.routing_trace.affinity.bound_upstream_key_id ?? '—'
                          })}
                        </Box> : null}
                        {row.routing_trace.conversion ? <Box className="md:col-span-2">
                          {formatRequestPath(
                            row.routing_trace.conversion.client_api_format,
                            row.routing_trace.conversion.upstream_api_format,
                          )}
                          {row.routing_trace.conversion.warnings.length > 0
                            ? ` · ${t('转换警告')}：${row.routing_trace.conversion.warnings.join(', ')}`
                            : ` · ${t('无转换警告')}`}
                        </Box> : null}
                      </Box>
                      {routeCandidates.length > 0 ? <>
                        <Box className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2.5">
                          <Typography className="text-sm font-medium text-foreground" component="div">{t('候选 Provider')}</Typography>
                          <Typography className="font-mono text-xs text-muted-foreground" component="span">
                            {t('{{count}} 个候选', { count: routeCandidates.length })}
                          </Typography>
                        </Box>
                        <TableContainer className="max-w-full overflow-x-auto">
                          <Table size="small" aria-label={t('候选 Provider')}>
                            <TableHead>
                              <TableRow>
                                <TableCell>{t('上游')}</TableCell>
                                <TableCell>{t('上游模型')}</TableCell>
                                <TableCell>{t('协议计划')}</TableCell>
                                <TableCell>{t('优先级')}</TableCell>
                                <TableCell>{t('权重')}</TableCell>
                                <TableCell className="text-right">{t('尝试预算')}</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {routeCandidates.map((candidate, index) => <TableRow key={`${candidate.provider_id}-${candidate.upstream_model ?? 'model'}-${index}`}>
                                  <TableCell className="text-xs">{providerNameMap.get(candidate.provider_id) ?? `#${candidate.provider_id}`}</TableCell>
                                  <TableCell className="font-mono text-xs">{candidate.upstream_model ?? '—'}</TableCell>
                                  <TableCell className="font-mono text-xs">{formatRoutingProtocol(candidate.upstream_api_format, candidate.conversion_mode)}</TableCell>
                                  <TableCell className="font-mono text-xs">{candidate.priority}</TableCell>
                                  <TableCell className="font-mono text-xs">{candidate.weight}</TableCell>
                                  <TableCell className="text-right font-mono text-xs">{candidate.attempt_budget}</TableCell>
                                </TableRow>)}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      </> : null}

                      {routeRejections.length > 0 ? <>
                        <Box className="flex items-center justify-between gap-3 border-y border-border/40 px-4 py-2.5">
                          <Typography className="text-sm font-medium text-foreground" component="div">{t('排除原因')}</Typography>
                          <Typography className="font-mono text-xs text-muted-foreground" component="span">
                            {t('{{count}} 个排除', { count: routeRejections.length })}
                          </Typography>
                        </Box>
                        <TableContainer className="max-w-full overflow-x-auto">
                          <Table size="small" aria-label={t('排除原因')}>
                            <TableHead>
                              <TableRow>
                                <TableCell>{t('上游')}</TableCell>
                                <TableCell>{t('上游模型')}</TableCell>
                                <TableCell>{t('阶段')}</TableCell>
                                <TableCell>{t('原因码')}</TableCell>
                                <TableCell>{t('说明')}</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {routeRejections.map((rejection, index) => <TableRow key={`${rejection.provider_id ?? 'gateway'}-${rejection.code}-${index}`}>
                                  <TableCell className="text-xs">{rejection.provider_id === null
                                    ? t('网关')
                                    : providerNameMap.get(rejection.provider_id) ?? `#${rejection.provider_id}`}</TableCell>
                                  <TableCell className="font-mono text-xs">{rejection.upstream_model}</TableCell>
                                  <TableCell className="font-mono text-xs">{rejection.stage}</TableCell>
                                  <TableCell className="font-mono text-xs text-foreground">{rejection.code}</TableCell>
                                  <TableCell className="min-w-72 text-xs text-muted-foreground">{rejection.message}</TableCell>
                                </TableRow>)}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      </> : null}

                      <Box className="flex items-center justify-between gap-3 border-y border-border/40 px-4 py-2.5">
                        <Typography className="text-sm font-medium text-foreground" component="div">{t('尝试记录')}</Typography>
                        <Typography className="font-mono text-xs text-muted-foreground" component="span">
                          {t('{{count}} 次尝试', { count: row.routing_trace.attempts.length })}
                        </Typography>
                      </Box>
                      <TableContainer className="max-w-full overflow-x-auto">
                        <Table size="small" aria-label={t('尝试记录')}>
                          <TableHead>
                            <TableRow>
                              <TableCell>{t('序号')}</TableCell>
                              <TableCell>{t('上游')}</TableCell>
                              <TableCell>{t('目标 / 密钥')}</TableCell>
                              <TableCell>{t('协议计划')}</TableCell>
                              <TableCell>{t('结果')}</TableCell>
                              <TableCell className="text-right">{t('耗时')}</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {row.routing_trace.attempts.length > 0
                              ? row.routing_trace.attempts.map((attempt, index) => <TableRow key={`${attempt.provider_id}-${attempt.endpoint_id}-${attempt.upstream_key_id}-${index}`}>
                                  <TableCell className="font-mono text-xs">{index + 1}</TableCell>
                                  <TableCell className="text-xs">{providerNameMap.get(attempt.provider_id) ?? `#${attempt.provider_id}`}</TableCell>
                                  <TableCell className="font-mono text-xs">#{attempt.endpoint_id} / #{attempt.upstream_key_id}</TableCell>
                                  <TableCell className="font-mono text-xs">{formatRoutingProtocol(attempt.upstream_api_format, attempt.conversion_mode)}</TableCell>
                                  <TableCell className="font-mono text-xs">{attempt.status ?? '—'} {attempt.error_type ?? ''}</TableCell>
                                  <TableCell className="text-right font-mono text-xs">{formatMaybeMs(attempt.duration_ms)}</TableCell>
                                </TableRow>)
                              : <TableRow>
                                  <TableCell className="py-4 text-center text-[0.8125rem] text-muted-foreground" colSpan={6}>{t('未发起上游尝试')}</TableCell>
                                </TableRow>}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </CardContent>
                  </Card> : null}

                <Card className="border border-border bg-background shadow-none">
                  <Box className="flex flex-col gap-2 p-4 pb-3">
                    <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t("用量信息")}</Typography>
                  </Box>
                  <CardContent className="grid gap-0 border-t border-border/40 pt-0">
                    <Box className="grid md:grid-cols-2">
                      <DetailItem label="总用量" value={formatCompactInteger(totalTokens(row))} onCopy={() => void copyField(String(totalTokens(row)), '总用量')} />
                      <DetailItem label="输入用量" value={formatCompactInteger(row.input_tokens)} onCopy={() => void copyField(String(row.input_tokens), '输入用量')} />
                      <DetailItem label="输出用量" value={formatCompactInteger(row.output_tokens)} onCopy={() => void copyField(String(row.output_tokens), '输出用量')} />
                      <DetailItem label="可见输出" value={formatCompactInteger(visibleOutputTokens(row))} onCopy={() => void copyField(String(visibleOutputTokens(row)), '可见输出')} />
                      <DetailItem label="思考用量" value={formatCompactInteger(row.reasoning_output_tokens)} onCopy={() => void copyField(String(row.reasoning_output_tokens), '思考用量')} />
                      <DetailItem label="缓存读取" value={formatCompactInteger(row.cache_read_input_tokens)} onCopy={() => void copyField(String(row.cache_read_input_tokens), '缓存读取')} />
                      <DetailItem label="缓存写入" value={formatCompactInteger(row.cache_creation_input_tokens)} onCopy={() => void copyField(String(row.cache_creation_input_tokens), '缓存写入')} />
                      <DetailItem label="用量状态" value={row.usage_observed ? '已返回用量' : '未返回用量'} onCopy={() => void copyField(row.usage_observed ? 'observed' : 'missing', '用量状态')} />
                      <DetailItem label="成本" value={pricingValue} onCopy={pricing.status === 'priced' ? () => void copyField(pricing.totalUsd.toString(), '成本') : undefined} />
                      <DetailItem label="定价状态" value={pricing.status === 'priced' ? t('已定价') : pricingReason ?? t('未定价')} />
                      <DetailItem label="价格版本" value={row.pricing ? `#${row.pricing.price_version_id}` : '—'} />
                      <DetailItem label="价格层级" value={row.pricing?.tier_index === null || row.pricing === null ? '—' : String(row.pricing.tier_index)} />
                      <DetailItem label="错误信息" value={row.error_message ?? '无'} onCopy={() => void copyField(row.error_message ?? '', '错误信息')} />
                    </Box>
                  </CardContent>
                </Card>
              </Box>;
      })(selected) : null}
      </DetailDrawer>
    </Box>;
}
function LogColumnValue(props: {
  id: LogColumnId;
  row: RequestLogRow;
  providerNameMap: Map<number, string>;
  endpointNameMap: Map<number, string>;
  apiKeyNameMap: Map<number, string>;
}) {
  const { id, row } = props;
  const status = rowStatus(row);
  const mono = 'font-mono text-xs';
  switch (id) {
    case 'time':
      return <Box className={`${mono} truncate whitespace-nowrap`} title={formatDateTime(row.time_ms)}>{formatDateTime(row.time_ms)}</Box>;
    case 'model':
      return <Box className={`${mono} max-w-[260px] break-all`} title={formatModelName(row.model)}>
        {isWsSession(row) ? t('WS 会话') : formatModelName(row.model)}
      </Box>;
    case 'request_path':
      return <Box className={`${mono} whitespace-nowrap`}>{formatRequestPath(row.api_format, row.upstream_api_format)}</Box>;
    case 'status':
      return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
    case 'duration':
      return <Box className={mono}>{formatMaybeMs(primaryLatency(row))}</Box>;
    case 'total_tokens':
      return row.usage_observed
        ? <UsageBreakdown row={row} />
        : <Box className={`${mono} text-muted-foreground`}>{t('未返回用量')}</Box>;
    case 'api_key':
      return <Box className={`${mono} break-all text-muted-foreground`}>{props.apiKeyNameMap.get(row.api_key_id) ?? `#${row.api_key_id}`}</Box>;
    case 'provider':
      return <Box className={`${mono} break-all`}>{row.provider_id ? props.providerNameMap.get(row.provider_id) ?? `#${row.provider_id}` : '—'}</Box>;
    case 'endpoint':
      return <Box className={`${mono} break-all`}>{row.endpoint_id ? props.endpointNameMap.get(row.endpoint_id) ?? `#${row.endpoint_id}` : '—'}</Box>;
    case 'transport':
      return <StatusBadge tone={transportTone(row)}>{transportLabel(row)}</StatusBadge>;
    case 'first_byte':
      return <Box className={mono}>{formatMaybeMs(row.t_first_byte_ms)}</Box>;
    case 'ttft':
      return <Box className={mono}>{formatMaybeMs(row.t_first_token_ms)}</Box>;
    case 'cost': {
      const pricing = calculateRequestPricing(row, row.usage_observed, row.pricing);
      return <Box className={mono}>{pricing.status === 'priced' ? formatUsd(pricing.totalUsd) : '—'}</Box>;
    }
    case 'request_id':
      return <Box className={`${mono} max-w-[240px] truncate`} title={row.id}>{row.id}</Box>;
    case 'error_type':
      return <Box className={`${mono} break-all text-muted-foreground`}>{row.error_type ?? '—'}</Box>;
  }
}
function UsageBreakdown(props: { row: RequestLogRow }) {
  const items = [
    { label: t('输入'), value: props.row.input_tokens },
    { label: t('输出'), value: props.row.output_tokens },
    { label: t('缓存读'), value: props.row.cache_read_input_tokens },
    { label: t('缓存写'), value: props.row.cache_creation_input_tokens },
    { label: t('思考'), value: props.row.reasoning_output_tokens },
  ];
  return <Box
    className="grid grid-cols-5 gap-2 overflow-hidden"
    aria-label={items.map(item => `${item.label} ${item.value}`).join('，')}
  >
    {items.map(item => <Box key={item.label} className="min-w-0">
      <Box className="truncate font-mono text-[0.6rem] uppercase tracking-wide text-muted-foreground" title={item.label}>
        {item.label}
      </Box>
      <Box className="mt-0.5 truncate font-mono text-xs" title={String(item.value)}>
        {formatCompactInteger(item.value)}
      </Box>
    </Box>)}
  </Box>;
}
function BadgeSummary(props: {
  label: string;
  value: number;
}) {
  return <Box className="rounded border border-border bg-transparent px-2.5 py-0.5 font-mono text-[0.6875rem] uppercase tracking-widest text-muted-foreground">
      {t(props.label)} {formatCompactInteger(props.value)}
    </Box>;
}
function MetricCard(props: {
  label: string;
  value: string;
  badge?: any;
}) {
  return <Box className="flex flex-col gap-1 pr-4 border-r border-border/40 last:border-r-0">
      <Box className="flex items-center justify-between">
        <Box className="text-[0.6875rem] uppercase tracking-widest font-mono text-muted-foreground" component="span">{t(props.label)}</Box>
      </Box>
      {props.badge ? <Box className="mt-1.5">{props.badge}</Box> : <Box className="mt-1.5 text-lg font-medium tracking-tight text-foreground">{props.value}</Box>}
    </Box>;
}
function DetailItem(props: {
  label: string;
  value: string;
  onCopy?: () => void;
}) {
  return <Box className="flex flex-col gap-1.5 border-b border-r border-border/40 p-3 relative group hover:bg-muted/10 transition-colors">
      <Box className="flex items-center justify-between gap-2">
        <Box className="font-mono text-[0.6875rem] uppercase tracking-widest text-muted-foreground opacity-70" component="span">{t(props.label)}</Box>
      </Box>
      <Box className="break-all font-mono text-[0.8125rem] text-foreground pr-7 truncate" title={props.value}>{props.value}</Box>
      {props.onCopy ? <Button type="button" size="icon" variant="ghost" className="absolute right-1.5 bottom-1.5 size-6 opacity-0 group-hover:opacity-100 transition-opacity h-auto" onClick={props.onCopy} aria-label={t('复制 {{label}}', {
      label: props.label
    })}>
          <Copy className="size-3" aria-hidden="true" />
        </Button> : null}
    </Box>;
}
