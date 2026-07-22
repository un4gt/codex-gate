import { useState, useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight, Copy, Search } from "lucide-react";
import { DetailDrawer } from '@/components/console/DetailDrawer';
import { EmptyState } from '@/components/console/EmptyState';
import { FilterBar } from '@/components/console/FilterBar';
import { PageHeader } from '@/components/console/PageHeader';
import { StatusBadge } from '@/components/console/StatusBadge';
import { t } from '@/lib/i18n';
import { loadRequestLogs } from '../lib/api';
import { formatCompactInteger, formatDateTime, formatModelName, formatMs, formatRequestType } from '../lib/format';
import { calculateRequestPricing, describeUnpricedReason, formatUsd } from '../lib/pricing';
import type { ApiKeyWorkspace, ConnectionSettings, ProviderWorkspace, RequestLogRow } from '../lib/types';
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import InputBase from "@mui/material/InputBase";
import MenuItem from "@mui/material/MenuItem";
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
  const previousRefreshKey = useRef(props.refreshKey);
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
  return <Box className="flex flex-col gap-6">
      <PageHeader title="请求日志" description="筛选并排查最近请求。" />

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
              <MenuItem value="chat_completions">{t('对话请求')}</MenuItem>
              <MenuItem value="responses">{t('响应请求')}</MenuItem>
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
              {loading ? '查询中' : '查询'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => {
        setFilters(EMPTY_FILTERS);
        void loadLogs(EMPTY_FILTERS);
      }}>{t("重置")}</Button>
          </Box>} />

      <Box className="grid gap-6">
        <Card className="rounded-none border border-border bg-background shadow-none">
          <Box className="flex flex-col gap-3 p-6 pb-6">
            <Box className="flex items-center justify-between gap-3">
              <Box>
                <Typography className="text-xl font-medium tracking-tight text-foreground" component="div">{t("结果")}</Typography>
                <Typography className="mt-1 font-mono text-xs uppercase tracking-wider text-muted-foreground" component="div">{t('默认按最近时间排序。')}</Typography>
              </Box>
              <Box className="flex gap-2">
                <StatusBadge tone={errorCount > 0 ? 'warning' : 'normal'}>{t('{{count}} 条异常', {
                  count: errorCount
                })}</StatusBadge>
                <BadgeSummary label="总数" value={filteredRows.length} />
              </Box>
            </Box>
          </Box>
          <CardContent className="p-0 border-t border-border/40">
            {rows.length > 0 ? <Box className="logs-table">
            <Box className="hidden xl:grid gap-4 px-4 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground bg-muted/20 py-3 mb-2" style={{
              gridTemplateColumns: 'minmax(160px, 1.05fr) minmax(180px, 1fr) minmax(90px, 0.6fr) minmax(210px, 1.2fr) minmax(140px, 0.85fr) minmax(130px, 0.82fr)'
            }}>
              <Box>{t('时间')}</Box>
              <Box>{t('模型')}</Box>
              <Box>{t('状态')}</Box>
              <Box>{t('耗时')}</Box>
              <Box>{t('用量')}</Box>
              <Box>{t('密钥')}</Box>
            </Box>
            {visibleRows.length > 0 ? visibleRows.map((item, _index4) => {
              const row = item.row;
              const status = rowStatus(row);
              const hasChildren = item.children.length > 0;
              return <Box key={row.id} className={`cursor-pointer border-b border-border bg-transparent px-4 py-5 transition-colors duration-200 ease-out hover:bg-muted/50 grid gap-4 xl:grid-cols-[minmax(160px,1.05fr)_minmax(180px,1fr)_minmax(90px,0.6fr)_minmax(210px,1.2fr)_minmax(140px,0.85fr)_minmax(130px,0.82fr)] ${item.depth > 0 ? 'border-l-2 border-l-primary/30 bg-muted/10' : ''}`} onClick={() => setSelected(row)}>
                    <Box className="flex min-w-0 items-center gap-2 font-mono text-xs">
                      {hasChildren ? <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={expandedSessions[row.id] ? t('收起 WS 日志') : t('展开 WS 日志')} onClick={event => {
                    event.stopPropagation();
                    setExpandedSessions(current => ({
                      ...current,
                      [row.id]: !current[row.id]
                    }));
                  }}>
                          {expandedSessions[row.id] ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        </Button> : <Box className="size-6 shrink-0" component="span" />}
                      <Box className="truncate" component="span">{formatDateTime(row.time_ms)}</Box>
                    </Box>
                    <Box className="min-w-0 font-mono text-xs">
                      <Box className="truncate max-w-[150px]" title={formatModelName(row.model)}>{isWsSession(row) ? t('WS 会话') : formatModelName(row.model)}</Box>
                      <Box className="mt-1">
                        <StatusBadge tone={transportTone(row)}>{transportLabel(row)}</StatusBadge>
                      </Box>
                    </Box>
                    <Box>
                      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    </Box>
                    <LatencySummary row={row} />
                    <TokenSummary row={row} />
                    <Box className="font-mono text-xs text-muted-foreground">{apiKeyNameMap.get(row.api_key_id) ?? `#${row.api_key_id}`}</Box>
                  </Box>;
            }) : <EmptyState title="未找到日志" description="尝试放宽筛选条件。" action={<Button type="button" variant="ghost" onClick={() => {
              setFilters(EMPTY_FILTERS);
              void loadLogs(EMPTY_FILTERS);
            }}>{t("清空筛选")}</Button>} />}
          </Box> : <EmptyState title="暂无日志" description="有流量后会显示。" />}
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
        return <Box className="grid gap-6">
                <Box className="flex flex-col gap-6 md:flex-row border-t border-border/40 pt-8 mt-2 pb-6">
                  <MetricCard label="状态" value={status.label} badge={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>} />
                  <MetricCard label="首字节" value={formatMaybeMs(row.t_first_byte_ms)} />
                  <MetricCard label="TTFT" value={formatMaybeMs(row.t_first_token_ms)} />
                  <MetricCard label="总耗时" value={formatMaybeMs(primaryLatency(row))} />
                  <MetricCard label="成本" value={pricingValue} badge={pricing.status === 'unpriced' ? <StatusBadge tone="warning">{t('未定价')}</StatusBadge> : undefined} />
                </Box>

                <Card className="rounded-none border border-border bg-background shadow-none">
                  <Box className="flex flex-col gap-3 p-6 pb-4">
                    <Typography className="text-lg font-medium tracking-tight text-foreground" component="div">{t("请求信息")}</Typography>
                  </Box>
                  <CardContent className="grid gap-0 border-t border-border/40 pt-0">
                    <Box className="grid md:grid-cols-2">
                      <DetailItem label="时间" value={formatDateTime(row.time_ms)} onCopy={() => void copyField(String(row.time_ms), '时间')} />
                      <DetailItem label="模型" value={formatModelName(row.model)} onCopy={() => void copyField(formatModelName(row.model), '模型')} />
                      <DetailItem label="密钥" value={apiKeyNameMap.get(row.api_key_id) ?? `#${row.api_key_id}`} onCopy={() => void copyField(String(row.api_key_id), '密钥')} />
                      <DetailItem label="请求类型" value={formatRequestType(row.api_format)} onCopy={() => void copyField(formatRequestType(row.api_format), '请求类型')} />
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

                {row.routing_trace ? <Card className="rounded-none border border-border bg-background shadow-none">
                    <Box className="flex items-center justify-between gap-4 p-6 pb-4">
                      <Typography className="text-lg font-medium tracking-tight text-foreground" component="div">{t('路由决策')}</Typography>
                      <Box className="font-mono text-xs text-muted-foreground" component="span">
                        {t('{{count}} 次 Provider 切换', { count: row.routing_trace.provider_switches })}
                      </Box>
                    </Box>
                    <CardContent className="border-t border-border/40 p-0">
                      <Box className="grid gap-2 border-b border-border/40 px-6 py-4 text-xs text-muted-foreground md:grid-cols-2">
                        <Box>{t('授权组：{{groups}}', {
                          groups: row.routing_trace.authorized_groups.map(group => group.name).join(', ') || '—'
                        })}</Box>
                        <Box>{row.routing_trace.affinity
                          ? t('亲和：{{state}} · {{hash}}', {
                              state: row.routing_trace.affinity.hit ? '命中' : '新建',
                              hash: row.routing_trace.affinity.hash
                            })
                          : t('亲和：无会话标识')}</Box>
                      </Box>
                      <TableContainer>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell>{t('序号')}</TableCell>
                              <TableCell>{t('上游')}</TableCell>
                              <TableCell>{t('目标 / 密钥')}</TableCell>
                              <TableCell>{t('结果')}</TableCell>
                              <TableCell className="text-right">{t('耗时')}</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {row.routing_trace.attempts.map((attempt, index) => <TableRow key={`${attempt.provider_id}-${attempt.endpoint_id}-${attempt.upstream_key_id}-${index}`}>
                                <TableCell className="font-mono text-xs">{index + 1}</TableCell>
                                <TableCell className="text-xs">{providerNameMap.get(attempt.provider_id) ?? `#${attempt.provider_id}`}</TableCell>
                                <TableCell className="font-mono text-xs">#{attempt.endpoint_id} / #{attempt.upstream_key_id}</TableCell>
                                <TableCell className="font-mono text-xs">{attempt.status ?? '—'} {attempt.error_type ?? ''}</TableCell>
                                <TableCell className="text-right font-mono text-xs">{formatMaybeMs(attempt.duration_ms)}</TableCell>
                              </TableRow>)}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </CardContent>
                  </Card> : null}

                <Card className="rounded-none border border-border bg-background shadow-none">
                  <Box className="flex flex-col gap-3 p-6 pb-4">
                    <Typography className="text-lg font-medium tracking-tight text-foreground" component="div">{t("用量信息")}</Typography>
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
function BadgeSummary(props: {
  label: string;
  value: number;
}) {
  return <Box className="border border-border bg-transparent px-3 py-1 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">
      {t(props.label)} {formatCompactInteger(props.value)}
    </Box>;
}
function TokenSummary(props: {
  row: RequestLogRow;
}) {
  return props.row.usage_observed ? <Box className="min-w-0 font-mono text-xs leading-5">
        <Box className="text-foreground">{formatCompactInteger(totalTokens(props.row))}</Box>
        <Box className="truncate text-[0.65rem] uppercase tracking-wider text-muted-foreground">
          {t('入 {{input}} · 出 {{output}}', {
        input: formatCompactInteger(props.row.input_tokens),
        output: formatCompactInteger(props.row.output_tokens)
      })}
        </Box>
        {props.row.cache_read_input_tokens > 0 || props.row.cache_creation_input_tokens > 0 || props.row.reasoning_output_tokens > 0 ? <Box className="truncate text-[0.65rem] uppercase tracking-wider text-muted-foreground">
            {t('缓存 {{cache}} · 思考 {{reasoning}}', {
        cache: formatCompactInteger(props.row.cache_read_input_tokens + props.row.cache_creation_input_tokens),
        reasoning: formatCompactInteger(props.row.reasoning_output_tokens)
      })}
          </Box> : null}
      </Box> : <Box className="font-mono text-xs text-muted-foreground">{t('未返回用量')}</Box>;
}
function LatencySummary(props: {
  row: RequestLogRow;
}) {
  return <Box className="min-w-0 font-mono text-xs leading-5">
      <Box className="text-foreground">{formatMaybeMs(primaryLatency(props.row))}</Box>
      <Box className="truncate text-[0.65rem] uppercase tracking-wider text-muted-foreground">
        {t('首字节 {{value}}', {
        value: formatMaybeMs(props.row.t_first_byte_ms)
      })}
      </Box>
      <Box className="truncate text-[0.65rem] uppercase tracking-wider text-muted-foreground">
        {t('TTFT {{value}}', {
        value: formatMaybeMs(props.row.t_first_token_ms)
      })}
      </Box>
    </Box>;
}
function MetricCard(props: {
  label: string;
  value: string;
  badge?: any;
}) {
  return <Box className="flex flex-col gap-1 pr-6 border-r border-border/40 last:border-r-0">
      <Box className="flex items-center justify-between">
        <Box className="text-[0.65rem] uppercase tracking-widest font-mono text-muted-foreground" component="span">{t(props.label)}</Box>
      </Box>
      {props.badge ? <Box className="mt-2">{props.badge}</Box> : <Box className="mt-2 text-2xl font-medium tracking-tight text-foreground">{props.value}</Box>}
    </Box>;
}
function DetailItem(props: {
  label: string;
  value: string;
  onCopy?: () => void;
}) {
  return <Box className="flex flex-col gap-2 border-b border-r border-border/40 p-4 relative group hover:bg-muted/10 transition-colors">
      <Box className="flex items-center justify-between gap-2">
        <Box className="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70" component="span">{t(props.label)}</Box>
      </Box>
      <Box className="break-all font-mono text-sm text-foreground pr-8 truncate" title={props.value}>{props.value}</Box>
      {props.onCopy ? <Button type="button" size="icon" variant="ghost" className="absolute right-2 bottom-2 size-6 opacity-0 group-hover:opacity-100 transition-opacity h-auto" onClick={props.onCopy} aria-label={t('复制 {{label}}', {
      label: props.label
    })}>
          <Copy className="size-3" aria-hidden="true" />
        </Button> : null}
    </Box>;
}
