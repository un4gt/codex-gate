import { For, type JSX } from 'solid-js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { t } from '@/lib/i18n';

interface QuickActionItem {
  title: string;
  description: string;
  action: JSX.Element;
}

interface QuickActionsProps {
  title?: string;
  items: QuickActionItem[];
}

export function QuickActions(props: QuickActionsProps) {
  return (
    <Card class="rounded-none border border-border bg-background shadow-none">
      <CardHeader class="pb-4">
        <CardTitle class="text-xl font-medium tracking-tight">{t(props.title ?? '快捷操作')}</CardTitle>
      </CardHeader>
      <CardContent class="grid gap-0">
        <For each={props.items}>
          {(item) => (
            <div class="flex items-center justify-between gap-4 border-b border-border/40 py-4 last:border-0 last:pb-0 first:pt-0 overflow-hidden">
              <div class="flex min-w-0 flex-col gap-1">
                <strong class="text-sm font-medium text-foreground truncate">{t(item.title)}</strong>
                <span class="font-mono text-xs text-muted-foreground opacity-70 uppercase tracking-wider truncate">{t(item.description)}</span>
              </div>
              <div class="shrink-0">{item.action}</div>
            </div>
          )}
        </For>
      </CardContent>
    </Card>
  );
}
