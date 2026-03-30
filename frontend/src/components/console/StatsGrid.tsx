import { For, Show } from 'solid-js';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

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
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <For each={props.items.slice(0, 4)}>
        {(item) => (
          <Card class="border-border/80 bg-card/95">
            <CardContent class="flex flex-col gap-3 p-5">
              <div class="flex items-center justify-between gap-3">
                <span class="text-[0.72rem] uppercase tracking-[0.18em] text-muted-foreground">{item.label}</span>
                <Show when={item.trend}>
                  <Badge variant={trendVariant(item.tone)}>{item.trend}</Badge>
                </Show>
              </div>
              <div class="text-3xl font-semibold tracking-[-0.05em] text-foreground">{item.value}</div>
              <Show when={item.hint}>
                <p class="text-sm text-muted-foreground">{item.hint}</p>
              </Show>
            </CardContent>
          </Card>
        )}
      </For>
    </div>
  );
}
