import { For, Show } from 'solid-js';
import { Badge } from '@/components/ui/badge';
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
    <div class="grid gap-5 border-t border-border/40 pt-8 mt-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <For each={props.items}>
        {(item) => (
          <div class="flex min-h-[132px] flex-col gap-1 border border-border/60 bg-background p-5">
            <div class="flex items-center justify-between">
              <span class="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t(item.label)}</span>
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
            <div class="mt-2 text-3xl font-medium tracking-normal text-foreground">{item.value}</div>
            <Show when={item.hint}>
              <div class="mt-auto pt-2 text-xs leading-5 text-muted-foreground opacity-80">{t(item.hint!)}</div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
