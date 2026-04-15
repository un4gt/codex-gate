import { For, Show } from 'solid-js';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCompactInteger, formatCost } from '../lib/format';

interface TopModelsProps {
  items: Array<{ model: string; requests: number; cost: number }>;
}

export function TopModels(props: TopModelsProps) {
  const maxRequests = () => props.items[0]?.requests ?? 1;

  return (
    <Card class="overflow-hidden">
      <CardHeader class="gap-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="panel__eyebrow">模型分布</p>
            <CardTitle>模型热度排行</CardTitle>
          </div>
          <Badge variant="outline">前 5</Badge>
        </div>
        <CardDescription>先按请求数排序，再按成本打破并列；进度条仅表示相对热度。</CardDescription>
      </CardHeader>
      <CardContent>
        <Show when={props.items.length > 0} fallback={<div class="empty-state">还没有模型分布数据，等日志写入后这里会显示最热模型。</div>}>
          <div class="flex flex-col gap-3">
            <For each={props.items.slice(0, 5)}>
              {(item, index) => (
                <article class="grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-[1.35rem] border border-border bg-background/70 p-4">
                  <div class="flex size-10 items-center justify-center rounded-2xl border border-border bg-muted/70 text-sm font-semibold text-muted-foreground">
                    {String(index() + 1).padStart(2, '0')}
                  </div>
                  <div class="min-w-0">
                    <div class="truncate text-sm font-semibold text-foreground">{item.model}</div>
                    <div class="mt-3 h-2 rounded-full bg-stone-200">
                      <div class="h-full rounded-full bg-primary" style={{ width: `${Math.max(16, (item.requests / maxRequests()) * 100)}%` }} />
                    </div>
                  </div>
                  <div class="text-right text-sm">
                    <div class="font-medium text-foreground">{formatCompactInteger(item.requests)}</div>
                    <div class="text-muted-foreground">{formatCost(item.cost)}</div>
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
