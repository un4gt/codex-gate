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
import { t } from '@/lib/i18n';
import { loadRequestLogs } from '../lib/api';
import { formatCompactInteger, formatCost, formatDateTime, formatModelName, formatMs, formatRequestType, parseDecimal } from '../lib/format';
import type { ApiKeyWorkspace, ConnectionSettings, ProviderWorkspace, RequestLogRow } from '../lib/types';

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
      if (!props.settings.adminToken.trim()) {
        setRows([]);
        return;
      }

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
    } catch (error) {
      props.onMessage(error instanceof Error ? error.message : '读取日志失败。');
      setRows([]);
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
      props.onMessage(t('当前环境不支持复制。'));
      return;
    }
    await navigator.clipboard.writeText(value);
    props.onMessage(t('{{label}} 已复制。', { label: t(label) }));
  };

  return (
    <div class="flex flex-col gap-6">
      <PageHeader title="请求日志" description="筛选并排查最近请求。" />

      <FilterBar
        primary={
          <>
            <Input
              value={filters().query}
              placeholder="搜索请求 ID、模型或错误"
              onInput={(event) => setFilters((current) => ({ ...current, query: event.currentTarget.value }))}
            />
            <Select value={filters().statusClass} onChange={(event) => setFilters((current) => ({ ...current, statusClass: event.currentTarget.value }))}>
              <option value="">{t('全部状态')}</option>
              <option value="4">4xx</option>
              <option value="5">5xx</option>
              <option value="2">2xx</option>
            </Select>
            <Select value={filters().apiKeyId} onChange={(event) => setFilters((current) => ({ ...current, apiKeyId: event.currentTarget.value }))}>
              <option value="">{t('全部密钥')}</option>
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
              <option value="">{t('全部请求类型')}</option>
              <option value="chat_completions">{t('对话请求')}</option>
              <option value="responses">{t('响应请求')}</option>
            </Select>
          </>
        }
        advanced={
          <>
            <Select value={filters().providerId} onChange={(event) => setFilters((current) => ({ ...current, providerId: event.currentTarget.value, endpointId: '' }))}>
              <option value="">{t('全部上游')}</option>
              <For each={props.providers}>
                {(item) => <option value={item.provider.id}>{item.provider.name}</option>}
              </For>
            </Select>
            <Select value={filters().endpointId} onChange={(event) => setFilters((current) => ({ ...current, endpointId: event.currentTarget.value }))}>
              <option value="">{t('全部目标')}</option>
              <For each={endpointOptions()}>{(item) => <option value={item.value}>{item.label}</option>}</For>
            </Select>
            <Input value={filters().durationMin} placeholder="延迟下限 ms" onInput={(event) => setFilters((current) => ({ ...current, durationMin: event.currentTarget.value }))} />
            <Input value={filters().durationMax} placeholder="延迟上限 ms" onInput={(event) => setFilters((current) => ({ ...current, durationMax: event.currentTarget.value }))} />
            <Input value={filters().tokenMin} placeholder="用量下限" onInput={(event) => setFilters((current) => ({ ...current, tokenMin: event.currentTarget.value }))} />
            <Input value={filters().tokenMax} placeholder="用量上限" onInput={(event) => setFilters((current) => ({ ...current, tokenMax: event.currentTarget.value }))} />
            <Input value={filters().costMin} placeholder="成本下限" onInput={(event) => setFilters((current) => ({ ...current, costMin: event.currentTarget.value }))} />
            <Input value={filters().costMax} placeholder="成本上限" onInput={(event) => setFilters((current) => ({ ...current, costMax: event.currentTarget.value }))} />
          </>
        }
        advancedOpen={advancedOpen()}
        onToggleAdvanced={() => setAdvancedOpen((value) => !value)}
        actions={
          <div class="flex gap-2">
            <Button type="button" size="sm" onClick={() => void loadLogs()} disabled={loading()}>
              <Search class="mr-2 size-3" />
              {loading() ? 'SEARCHING' : 'SEARCH'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setFilters(EMPTY_FILTERS); void loadLogs(); }}>
              RESET
            </Button>
          </div>
        }
      />

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader class="pb-6">
            <div class="flex items-center justify-between gap-3">
              <div>
                <CardTitle class="text-xl font-medium tracking-tight">结果</CardTitle>
                <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">默认按最近时间排序，优先暴露错误请求。</CardDescription>
              </div>
              <div class="flex gap-2">
                <StatusBadge tone={errorCount() > 0 ? 'warning' : 'normal'}>{t('{{count}} 条异常', { count: errorCount() })}</StatusBadge>
                <BadgeSummary label="总数" value={filteredRows().length} />
              </div>
            </div>
          </CardHeader>
          <CardContent class="p-0 border-t border-border/40">
            <Show
              when={filteredRows().length > 0}
              fallback={<EmptyState title="NO LOGS" description="Awaiting telemetry." />}
            >
          <div class="logs-table">
            <div class="hidden xl:grid gap-4 px-4 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground bg-muted/20 py-3 mb-2" style={{ 'grid-template-columns': 'minmax(160px, 1.15fr) minmax(180px, 1.1fr) minmax(120px, 0.8fr) minmax(160px, 1fr) minmax(140px, 0.85fr) minmax(130px, 0.82fr)' }}>
              <div>{t('时间')}</div>
              <div>{t('模型')}</div>
              <div>{t('状态')}</div>
              <div>{t('耗时')}</div>
              <div>{t('用量')}</div>
              <div>{t('密钥')}</div>
            </div>
            <Show
              when={filteredRows().length > 0}
              fallback={
                <EmptyState
                  title="NO LOGS FOUND"
                  description="尝试放宽筛选条件。"
                  action={
                    <Button type="button" variant="ghost" onClick={() => { setFilters(EMPTY_FILTERS); void loadLogs(); }}>
                      CLEAR FILTERS
                    </Button>
                  }
                />
              }
            >
              <For each={filteredRows()}>
                {(row) => {
                  const status = rowStatus(row);
                  return (
                  <div
                    class="cursor-pointer border-b border-border bg-transparent px-4 py-5 transition-colors duration-200 ease-out hover:bg-muted/50 grid gap-4 xl:grid-cols-[minmax(160px,1.15fr)_minmax(180px,1.1fr)_minmax(120px,0.8fr)_minmax(160px,1fr)_minmax(140px,0.85fr)_minmax(130px,0.82fr)]"
                    onClick={() => setSelected(row)}
                  >
                    <div class="font-mono text-xs truncate">{formatDateTime(row.time_ms)}</div>
                    <div class="font-mono text-xs truncate max-w-[150px]" title={formatModelName(row.model)}>{formatModelName(row.model)}</div>
                    <div>
                      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    </div>
                    <div class="font-mono text-xs">{formatMs(row.duration_ms ?? row.t_first_token_ms ?? row.t_first_byte_ms ?? 0)}</div>
                    <div class="font-mono text-xs">{formatCompactInteger(totalTokens(row))}</div>
                    <div class="font-mono text-xs text-muted-foreground">{apiKeyNameMap().get(row.api_key_id) ?? `#${row.api_key_id}`}</div>
                  </div>
                  );
                }}
              </For>
            </Show>
          </div>
            </Show>
          </CardContent>
        </Card>

        <Card class="rounded-none border border-border bg-background shadow-none">
          <CardHeader class="pb-6">
            <CardTitle class="text-xl font-medium tracking-tight">排障提示</CardTitle>
            <CardDescription class="font-mono text-xs uppercase tracking-widest mt-1">从结果直接进入详情，不再混入概念说明。</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-6 border-t border-border/40 pt-6">
            <div class="border-l-2 border-primary/20 pl-4 py-1">
              <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">{t('默认视角')}</div>
              <p class="mt-2 text-sm text-foreground opacity-90">{t('先看 4xx/5xx，再按模型或密钥缩小范围。')}</p>
            </div>
            <div class="border-l-2 border-primary/20 pl-4 py-1">
              <div class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">{t('常用筛选')}</div>
              <p class="mt-2 text-sm text-foreground opacity-90">{t('状态、模型、密钥、延迟区间、用量区间、成本区间。')}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <DetailDrawer
        open={!!selected()}
        title={selected()?.id ?? '日志详情'}
        description={selected() ? `${formatDateTime(selected()!.time_ms)} · ${formatModelName(selected()!.model)}` : undefined}
        onClose={() => setSelected(null)}
      >
        <Show when={selected()}>
          {(rowSignal) => {
            const row = rowSignal();
            const status = rowStatus(row);
            return (
              <div class="grid gap-6">
                <div class="flex flex-col gap-6 md:flex-row border-t border-border/40 pt-8 mt-2 pb-6">
                  <MetricCard label="状态" value={status.label} badge={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>} />
                  <MetricCard label="延迟" value={formatMs(row.duration_ms ?? row.t_first_token_ms ?? row.t_first_byte_ms ?? 0)} />
                  <MetricCard label="成本" value={formatCost(parseDecimal(row.cost_total_usd))} />
                </div>

                <Card class="rounded-none border border-border bg-background shadow-none">
                  <CardHeader class="pb-4">
                    <CardTitle class="text-lg font-medium tracking-tight">请求信息</CardTitle>
                  </CardHeader>
                  <CardContent class="grid gap-0 border-t border-border/40 pt-0">
                    <div class="grid md:grid-cols-2">
                      <DetailItem label="时间" value={formatDateTime(row.time_ms)} onCopy={() => void copyField(String(row.time_ms), '时间')} />
                      <DetailItem label="模型" value={formatModelName(row.model)} onCopy={() => void copyField(formatModelName(row.model), '模型')} />
                      <DetailItem label="密钥" value={apiKeyNameMap().get(row.api_key_id) ?? `#${row.api_key_id}`} onCopy={() => void copyField(String(row.api_key_id), '密钥')} />
                      <DetailItem label="请求类型" value={formatRequestType(row.api_format)} onCopy={() => void copyField(formatRequestType(row.api_format), '请求类型')} />
                      <DetailItem label="请求 ID" value={row.id} onCopy={() => void copyField(row.id, '请求 ID')} />
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
                    </div>
                  </CardContent>
                </Card>

                <Card class="rounded-none border border-border bg-background shadow-none">
                  <CardHeader class="pb-4">
                    <CardTitle class="text-lg font-medium tracking-tight">用量信息</CardTitle>
                  </CardHeader>
                  <CardContent class="grid gap-0 border-t border-border/40 pt-0">
                    <div class="grid md:grid-cols-2">
                      <DetailItem label="输入用量" value={formatCompactInteger(row.input_tokens)} onCopy={() => void copyField(String(row.input_tokens), '输入用量')} />
                      <DetailItem label="输出用量" value={formatCompactInteger(row.output_tokens)} onCopy={() => void copyField(String(row.output_tokens), '输出用量')} />
                      <DetailItem label="缓存读取" value={formatCompactInteger(row.cache_read_input_tokens)} onCopy={() => void copyField(String(row.cache_read_input_tokens), '缓存读取')} />
                      <DetailItem label="缓存写入" value={formatCompactInteger(row.cache_creation_input_tokens)} onCopy={() => void copyField(String(row.cache_creation_input_tokens), '缓存写入')} />
                      <DetailItem label="元数据" value={row.error_message ?? '无'} onCopy={() => void copyField(row.error_message ?? '', '错误信息')} />
                    </div>
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
    <div class="border border-border bg-transparent px-3 py-1 font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground">
      {t(props.label)} {formatCompactInteger(props.value)}
    </div>
  );
}

function MetricCard(props: { label: string; value: string; badge?: any }) {
  return (
    <div class="flex flex-col gap-1 pr-6 border-r border-border/40 last:border-r-0">
      <div class="flex items-center justify-between">
        <span class="text-[0.65rem] uppercase tracking-widest font-mono text-muted-foreground">{t(props.label)}</span>
      </div>
      <Show when={props.badge} fallback={<div class="mt-2 text-2xl font-medium tracking-tight text-foreground">{props.value}</div>}>
        <div class="mt-2">{props.badge}</div>
      </Show>
    </div>
  );
}

function DetailItem(props: { label: string; value: string; onCopy: () => void }) {
  return (
    <div class="flex flex-col gap-2 border-b border-r border-border/40 p-4 relative group hover:bg-muted/10 transition-colors">
      <div class="flex items-center justify-between gap-2">
        <span class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70">{t(props.label)}</span>
      </div>
      <div class="break-all font-mono text-sm text-foreground pr-8 truncate" title={props.value}>{props.value}</div>
      <Button type="button" size="icon" variant="ghost" class="absolute right-2 bottom-2 size-6 opacity-0 group-hover:opacity-100 transition-opacity h-auto" onClick={props.onCopy}>
        <Copy class="size-3" />
      </Button>
    </div>
  );
}
