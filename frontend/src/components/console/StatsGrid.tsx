import { For, Show } from 'solid-js';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { t } from '@/lib/i18n';

export interface StatItem {
  label: string;
  value: string;
  hint?: string;
  trend?: string;
  tone?: 'default' | 'success' | 'warning' | 'destructive';
}

interface StatsGridProps {
  items: StatItem[];
}

function trendVariant(tone?: StatItem['tone']) {
  if (tone === 'success') return 'success';
  if (tone === 'warning') return 'warning';
  if (tone === 'destructive') return 'destructive';
  return 'outline';
}

export function StatsGrid(props: StatsGridProps) {
  return (
    <div class="grid gap-6 md:grid-cols-2 lg:grid-cols-4 border-t border-border/40 pt-8 mt-2">
      <For each={props.items.slice(0, 4)}>
        {(item) => (
          <div class="flex flex-col gap-1 pr-6 border-r border-border/40 last:border-r-0">
            <div class="flex items-center justify-between">
              <span class="text-[0.65rem] uppercase tracking-widest font-mono text-muted-foreground">{t(item.label)}</span>
              <Show when={item.trend}>
                <Badge variant={trendVariant(item.tone)}>{item.trend}</Badge>
              </Show>
              <Show when={!item.trend && item.tone === 'success'}>
                <span class="size-1.5 rounded-full bg-emerald-500" />
              </Show>
              <Show when={!item.trend && item.tone === 'warning'}>
                <span class="size-1.5 rounded-full bg-amber-500" />
              </Show>
              <Show when={!item.trend && item.tone === 'destructive'}>
                <span class="size-1.5 rounded-full bg-red-500" />
              </Show>
            </div>
            <div class="mt-2 text-4xl font-medium tracking-tight text-foreground">{item.value}</div>
            <Show when={item.hint}>
              <div class="mt-1 font-mono text-[0.65rem] text-muted-foreground opacity-70 uppercase tracking-widest">{t(item.hint!)}</div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
