import { For, type JSX } from 'solid-js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
    <Card class="border-border/80 bg-card/95">
      <CardHeader class="pb-4">
        <CardTitle>{props.title ?? '快捷操作'}</CardTitle>
      </CardHeader>
      <CardContent class="grid gap-3">
        <For each={props.items}>
          {(item) => (
            <div class="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-muted/30 px-4 py-3">
              <div class="flex min-w-0 flex-col gap-1">
                <strong class="text-sm font-medium text-foreground">{item.title}</strong>
                <span class="text-sm text-muted-foreground">{item.description}</span>
              </div>
              <div class="shrink-0">{item.action}</div>
            </div>
          )}
        </For>
      </CardContent>
    </Card>
  );
}
