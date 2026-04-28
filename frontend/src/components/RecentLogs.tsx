import { For, Show } from 'solid-js';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { t } from '@/lib/i18n';
import { formatCompactInteger, formatCost, formatDateTime, formatModelName, formatMs, formatRequestType, parseDecimal } from '../lib/format';
import type { RequestLogRow } from '../lib/types';

interface RecentLogsProps {
  rows: RequestLogRow[];
}

function totalTokens(row: RequestLogRow) {
  return row.input_tokens + row.output_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens;
}

export function RecentLogs(props: RecentLogsProps) {
  return (
    <Card class="h-full overflow-hidden">
      <CardHeader class="gap-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="panel__eyebrow">{t('最近请求')}</p>
            <CardTitle>最新请求摘要</CardTitle>
          </div>
          <Badge variant="outline">仅摘要</Badge>
        </div>
        <CardDescription>快速查看状态、模型、时延和成本。</CardDescription>
      </CardHeader>
      <CardContent>
        <Show when={props.rows.length > 0} fallback={<div class="empty-state">{t('还没有可展示的日志，等第一批流量进来后这里会自动出现。')}</div>}>
          <div class="flex flex-col gap-3">
            <For each={props.rows.slice(0, 8)}>
              {(row) => (
                <article class="grid gap-4 rounded-[1.35rem] border border-border bg-background/70 p-4 md:grid-cols-[1fr_auto]">
                  <div>
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <strong class="text-sm font-semibold tracking-[-0.02em] text-foreground">{formatModelName(row.model)}</strong>
                      <Badge variant={(row.http_status ?? 500) >= 400 ? 'destructive' : 'success'}>{row.http_status ?? '—'}</Badge>
                    </div>
                    <div class="log-row__meta mt-3 flex flex-wrap gap-3 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                      <span>{formatRequestType(row.api_format)}</span>
                      <span>{formatDateTime(row.time_ms)}</span>
                      <span>{`${formatCompactInteger(totalTokens(row))} ${t('用量')}`}</span>
                    </div>
                  </div>
                  <div class="flex flex-col items-start gap-2 text-sm md:items-end">
                    <span class="text-lg font-semibold tracking-[-0.03em] text-foreground">{formatMs(row.duration_ms ?? row.t_first_token_ms ?? row.t_first_byte_ms ?? 0)}</span>
                    <span class="text-muted-foreground">{formatCost(parseDecimal(row.cost_total_usd))}</span>
                  </div>
                </article>
              )}
            </For>
          </div>
        </Show>
      </CardContent>
    </Card>
  );
}
