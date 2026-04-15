import type { Component, JSX } from 'solid-js';
import { Card, CardContent } from '@/components/ui/card';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface StatCardProps {
  title: string;
  value: string;
  unit?: string;
  eyebrow: string;
  meta: string;
  accent?: 'orange' | 'green' | 'slate';
  icon: JSX.Element;
}

const accentClasses: Record<NonNullable<StatCardProps['accent']>, string> = {
  orange: 'border-primary/20 bg-primary/10 text-primary',
  green: 'border-emerald-600/20 bg-emerald-50/90 text-emerald-700',
  slate: 'border-border bg-muted/75 text-foreground',
};

export function StatCard(props: StatCardProps) {
  const accent = () => props.accent ?? 'orange';

  return (
    <Card class="overflow-hidden">
      <CardContent class="p-0">
        <div class="flex min-h-[220px] flex-col justify-between gap-8 p-6">
          <div class="flex items-start justify-between gap-4">
            <div class="flex flex-col gap-3">
              <div class="panel__eyebrow mb-0 flex items-center gap-2">
                <span class="size-2 rounded-full bg-primary" />
                {t(props.eyebrow)}
              </div>
              <p class="text-sm font-medium text-muted-foreground">{t(props.title)}</p>
            </div>
            <div class={cn('flex size-12 items-center justify-center rounded-2xl border', accentClasses[accent()])}>{props.icon}</div>
          </div>
          <div class="flex flex-col gap-4">
            <div class="flex items-end gap-2">
              <span class="text-4xl font-semibold tracking-[-0.05em] text-foreground">{props.value}</span>
              {props.unit && <span class="pb-1 text-sm text-muted-foreground">{props.unit}</span>}
            </div>
            <div class="h-px bg-border" />
            <p class="panel__muted">{t(props.meta)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
