import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { Copy, Search } from 'lucide-solid';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DetailDrawer } from '@/components/console/DetailDrawer';
import { EmptyState } from '@/components/console/EmptyState';
import { FilterBar } from '@/components/console/FilterBar';
import { PageHeader } from '@/components/console/PageHeader';
import { StatusBadge } from '@/components/console/StatusBadge';
import { loadRequestLogs } from '../lib/api';
import { createDemoLogs } from '../lib/demo';
import { formatCompactInteger, formatCost, formatDateTime, formatMs, parseDecimal } from '../lib/format';
import type { ApiKeyWorkspace, ConnectionSettings, ProviderWorkspace, RequestLogRow } from '../lib/types';

interface LogsPageProps {
  source: 'live' | 'preview';
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
  costMin: string;
  costMax: string;
}

const EMPTY_FILTERS: LogFilters = {
  query: '',
  statusClass: '4',
  apiKeyId: '',
  model: '',
  apiFormat: '',
  providerId: '',
  endpointId: '',
  durationMin: '',
  durationMax: '',
  tokenMin: '',
  tokenMax: '',
  costMin: '',
  costMax: '',
};

function totalTokens(row: RequestLogRow) {
  return row.input_tokens + row.output_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens;
}

function rowStatus(row: RequestLogRow) {
  if ((row.http_status ?? 0) >= 500) return { tone: 'error' as const, label: String(row.http_status) };
  if ((row.http_status ?? 0) >= 400) return { tone: 'warning' as const, label: String(row.http_status) };
  return { tone: 'normal' as const, label: String(row.http_status ?? 200) };
}

export function LogsPage(props: LogsPageProps) {
  const [filters, setFilters] = createSignal<LogFilters>(EMPTY_FILTERS);
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [rows, setRows] = createSignal<RequestLogRow[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [selected, setSelected] = createSignal<RequestLogRow | null>(null);

  const providerNameMap = createMemo(() => new Map(props.providers.map((item) => [item.provider.id, item.provider.name])));
  const endpointNameMap = createMemo(
    () => new Map(props.providers.flatMap((item) => item.endpoints.map((endpoint) => [endpoint.id, endpoint.name] as const))),
  );
  const apiKeyNameMap = createMemo(() => new Map(props.apiKeys.map((item) => [item.apiKey.id, item.apiKey.name])));

  const endpointOptions = createMemo(() => {
    const providerId = filters().providerId;
    return props.providers.flatMap((item) => {
      if (providerId && String(item.provider.id) !== providerId) return [];
      return item.endpoints.map((endpoint) => ({
        value: String(endpoint.id),
        label: `${item.provider.name} / ${endpoint.name}`,
      }));
    });
  });

  const loadLogs = async () => {
    setLoading(true);
    try {
      if (props.source === 'live' && props.settings.adminToken.trim()) {
        const current = filters();
        const result = await loadRequestLogs(props.settings, {
          page: 1,
          page_size: 50,
          model: current.model || current.query || undefined,
          api_key_id: current.apiKeyId ? Number(current.apiKeyId) : undefined,
          provider_id: current.providerId ? Number(current.providerId) : undefined,
          endpoint_id: current.endpointId ? Number(current.endpointId) : undefined,
          api_format: current.apiFormat || undefined,
          status_class: current.statusClass ? Number(current.statusClass) : undefined,
          duration_ms_min: current.durationMin ? Number(current.durationMin) : undefined,
          duration_ms_max: current.durationMax ? Number(current.durationMax) : undefined,
          total_tokens_min: current.tokenMin ? Number(current.tokenMin) : undefined,
          total_tokens_max: current.tokenMax ? Number(current.tokenMax) : undefined,
          cost_total_min: current.costMin ? Number(current.costMin) : undefined,
          cost_total_max: current.costMax ? Number(current.costMax) : undefined,
        });
        setRows(result);
      } else {
        setRows(createDemoLogs());
      }
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '读取日志失败。');
      setRows(createDemoLogs());
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    void loadLogs();
  });

  const filteredRows = createMemo(() => {
    const draft = filters();
    return rows()
      .filter((row) => {
        const q = draft.query.trim().toLowerCase();
        if (!q) return true;
        return (
          row.id.toLowerCase().includes(q) ||
          (row.model ?? '').toLowerCase().includes(q) ||
          (row.error_type ?? '').toLowerCase().includes(q) ||
          (row.error_message ?? '').toLowerCase().includes(q)
        );
      })
      .sort((left, right) => right.time_ms - left.time_ms);
  });

  const errorCount = createMemo(() => filteredRows().filter((row) => (row.http_status ?? 0) >= 400).length);

  const copyField = async (value: string, label: string) => {
    if (!navigator?.clipboard) {
      props.onMessage('当前环境不支持复制。');
      return;
    }
    await navigator.clipboard.writeText(value);
    props.onMessage(`${label} 已复制。`);
  };

  return (
    <div class="flex flex-col gap-6">
      <PageHeader title="请求日志" description="筛选并排查最近请求。" />

      <FilterBar
        primary={
          <>
            <Input
              value={filters().query}
              placeholder="搜索 request id、模型或错误"
              onInput={(event) => setFilters((current) => ({ ...current, query: event.currentTarget.value }))}
            />
            <Select value={filters().statusClass} onChange={(event) => setFilters((current) => ({ ...current, statusClass: event.currentTarget.value }))}>
              <option value="">全部状态</option>
              <option value="4">4xx</option>
              <option value="5">5xx</option>
              <option value="2">2xx</option>
            </Select>
            <Select value={filters().apiKeyId} onChange={(event) => setFilters((current) => ({ ...current, apiKeyId: event.currentTarget.value }))}>
              <option value="">全部 API Key</option>
              <For each={props.apiKeys}>
                {(item) => <option value={item.apiKey.id}>{item.apiKey.name}</option>}
              </For>
            </Select>
            <Input
              value={filters().model}
              placeholder="模型"
              onInput={(event) => setFilters((current) => ({ ...current, model: event.currentTarget.value }))}
            />
            <Select value={filters().apiFormat} onChange={(event) => setFilters((current) => ({ ...current, apiFormat: event.currentTarget.value as LogFilters['apiFormat'] }))}>
              <option value="">全部请求类型</option>
              <option value="chat_completions">Chat Completions</option>
              <option value="responses">Responses</option>
            </Select>
          </>
        }
        advanced={
          <>
            <Select value={filters().providerId} onChange={(event) => setFilters((current) => ({ ...current, providerId: event.currentTarget.value, endpointId: '' }))}>
              <option value="">全部上游</option>
              <For each={props.providers}>
                {(item) => <option value={item.provider.id}>{item.provider.name}</option>}
              </For>
            </Select>
            <Select value={filters().endpointId} onChange={(event) => setFilters((current) => ({ ...current, endpointId: event.currentTarget.value }))}>
              <option value="">全部目标</option>
              <For each={endpointOptions()}>{(item) => <option value={item.value}>{item.label}</option>}</For>
            </Select>
            <Input value={filters().durationMin} placeholder="延迟下限 ms" onInput={(event) => setFilters((current) => ({ ...current, durationMin: event.currentTarget.value }))} />
            <Input value={filters().durationMax} placeholder="延迟上限 ms" onInput={(event) => setFilters((current) => ({ ...current, durationMax: event.currentTarget.value }))} />
            <Input value={filters().tokenMin} placeholder="Token 下限" onInput={(event) => setFilters((current) => ({ ...current, tokenMin: event.currentTarget.value }))} />
            <Input value={filters().tokenMax} placeholder="Token 上限" onInput={(event) => setFilters((current) => ({ ...current, tokenMax: event.currentTarget.value }))} />
            <Input value={filters().costMin} placeholder="成本下限" onInput={(event) => setFilters((current) => ({ ...current, costMin: event.currentTarget.value }))} />
            <Input value={filters().costMax} placeholder="成本上限" onInput={(event) => setFilters((current) => ({ ...current, costMax: event.currentTarget.value }))} />
          </>
        }
        advancedOpen={advancedOpen()}
        onToggleAdvanced={() => setAdvancedOpen((value) => !value)}
        actions={
          <>
            <Button type="button" size="sm" onClick={() => void loadLogs()} disabled={loading()}>
              <Search />
              {loading() ? '查询中' : '查询'}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => { setFilters(EMPTY_FILTERS); void loadLogs(); }}>
              重置
            </Button>
          </>
        }
      />

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card class="border-border/80 bg-card/95">
          <CardHeader>
            <div class="flex items-center justify-between gap-3">
              <div>
                <CardTitle>结果</CardTitle>
                <CardDescription>默认按最近时间排序，优先暴露错误请求。</CardDescription>
              </div>
              <div class="flex gap-2">
                <StatusBadge tone={errorCount() > 0 ? 'warning' : 'normal'}>{`${errorCount()} 条异常`}</StatusBadge>
                <BadgeSummary label="总数" value={filteredRows().length} />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Show
              when={filteredRows().length > 0}
              fallback={<EmptyState title="没有匹配结果" description="调整筛选条件后重试。" />}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>延迟</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>成本</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <For each={filteredRows()}>
                    {(row) => {
                      const status = rowStatus(row);
                      return (
                        <TableRow class="cursor-pointer" onClick={() => setSelected(row)}>
                          <TableCell>{formatDateTime(row.time_ms)}</TableCell>
                          <TableCell>{row.model ?? 'unknown'}</TableCell>
                          <TableCell>
                            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                          </TableCell>
                          <TableCell>{apiKeyNameMap().get(row.api_key_id) ?? `#${row.api_key_id}`}</TableCell>
                          <TableCell>{formatMs(row.duration_ms ?? row.t_first_token_ms ?? row.t_first_byte_ms ?? 0)}</TableCell>
                          <TableCell>{formatCompactInteger(totalTokens(row))}</TableCell>
                          <TableCell>{formatCost(parseDecimal(row.cost_total_usd))}</TableCell>
                        </TableRow>
                      );
                    }}
                  </For>
                </TableBody>
              </Table>
            </Show>
          </CardContent>
        </Card>

        <Card class="border-border/80 bg-card/95">
          <CardHeader>
            <CardTitle>排障提示</CardTitle>
            <CardDescription>从结果直接进入详情，不再混入概念说明。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <div class="rounded-xl border border-border/70 bg-muted/30 p-4">
              <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">默认视角</div>
              <p class="mt-2 text-sm text-muted-foreground">先看 4xx/5xx，再按模型或 API Key 缩小范围。</p>
            </div>
            <div class="rounded-xl border border-border/70 bg-muted/30 p-4">
              <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">常用筛选</div>
              <p class="mt-2 text-sm text-muted-foreground">状态、模型、API Key、延迟区间、Token 区间、成本区间。</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <DetailDrawer
        open={!!selected()}
        title={selected()?.id ?? '日志详情'}
        description={selected() ? `${formatDateTime(selected()!.time_ms)} · ${selected()!.model ?? 'unknown'}` : undefined}
        onClose={() => setSelected(null)}
      >
        <Show when={selected()}>
          {(rowSignal) => {
            const row = rowSignal();
            const status = rowStatus(row);
            return (
              <div class="grid gap-6">
                <div class="grid gap-3 md:grid-cols-3">
                  <MetricCard label="状态" value={status.label} badge={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>} />
                  <MetricCard label="延迟" value={formatMs(row.duration_ms ?? row.t_first_token_ms ?? row.t_first_byte_ms ?? 0)} />
                  <MetricCard label="成本" value={formatCost(parseDecimal(row.cost_total_usd))} />
                </div>

                <Card class="border-border/70 bg-muted/25">
                  <CardHeader>
                    <CardTitle>请求信息</CardTitle>
                  </CardHeader>
                  <CardContent class="grid gap-4 md:grid-cols-2">
                    <DetailItem label="时间" value={formatDateTime(row.time_ms)} onCopy={() => void copyField(String(row.time_ms), '时间')} />
                    <DetailItem label="模型" value={row.model ?? 'unknown'} onCopy={() => void copyField(row.model ?? 'unknown', '模型')} />
                    <DetailItem label="API Key" value={apiKeyNameMap().get(row.api_key_id) ?? `#${row.api_key_id}`} onCopy={() => void copyField(String(row.api_key_id), 'API Key')} />
                    <DetailItem label="请求类型" value={row.api_format} onCopy={() => void copyField(row.api_format, '请求类型')} />
                    <DetailItem label="Request ID" value={row.id} onCopy={() => void copyField(row.id, 'Request ID')} />
                    <DetailItem
                      label="上游"
                      value={row.provider_id ? providerNameMap().get(row.provider_id) ?? `#${row.provider_id}` : '—'}
                      onCopy={() => void copyField(String(row.provider_id ?? ''), '上游')}
                    />
                    <DetailItem
                      label="目标"
                      value={row.endpoint_id ? endpointNameMap().get(row.endpoint_id) ?? `#${row.endpoint_id}` : '—'}
                      onCopy={() => void copyField(String(row.endpoint_id ?? ''), '目标')}
                    />
                    <DetailItem label="错误类型" value={row.error_type ?? '—'} onCopy={() => void copyField(row.error_type ?? '', '错误类型')} />
                  </CardContent>
                </Card>

                <Card class="border-border/70 bg-muted/25">
                  <CardHeader>
                    <CardTitle>用量信息</CardTitle>
                  </CardHeader>
                  <CardContent class="grid gap-4 md:grid-cols-2">
                    <DetailItem label="输入 Tokens" value={formatCompactInteger(row.input_tokens)} onCopy={() => void copyField(String(row.input_tokens), '输入 Tokens')} />
                    <DetailItem label="输出 Tokens" value={formatCompactInteger(row.output_tokens)} onCopy={() => void copyField(String(row.output_tokens), '输出 Tokens')} />
                    <DetailItem label="Cache Read" value={formatCompactInteger(row.cache_read_input_tokens)} onCopy={() => void copyField(String(row.cache_read_input_tokens), 'Cache Read')} />
                    <DetailItem label="Cache Write" value={formatCompactInteger(row.cache_creation_input_tokens)} onCopy={() => void copyField(String(row.cache_creation_input_tokens), 'Cache Write')} />
                    <DetailItem label="元数据" value={row.error_message ?? '无'} onCopy={() => void copyField(row.error_message ?? '', '错误信息')} />
                  </CardContent>
                </Card>
              </div>
            );
          }}
        </Show>
      </DetailDrawer>
    </div>
  );
}

function BadgeSummary(props: { label: string; value: number }) {
  return (
    <div class="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
      {props.label} {formatCompactInteger(props.value)}
    </div>
  );
}

function MetricCard(props: { label: string; value: string; badge?: any }) {
  return (
    <Card class="border-border/70 bg-muted/25">
      <CardContent class="p-4">
        <div class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">{props.label}</div>
        <Show when={props.badge} fallback={<div class="mt-2 text-xl font-semibold text-foreground">{props.value}</div>}>
          <div class="mt-2">{props.badge}</div>
        </Show>
      </CardContent>
    </Card>
  );
}

function DetailItem(props: { label: string; value: string; onCopy: () => void }) {
  return (
    <div class="rounded-xl border border-border/70 bg-background px-4 py-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">{props.label}</span>
        <Button type="button" size="sm" variant="ghost" onClick={props.onCopy}>
          <Copy />
        </Button>
      </div>
      <div class="break-all text-sm text-foreground">{props.value}</div>
    </div>
  );
}
