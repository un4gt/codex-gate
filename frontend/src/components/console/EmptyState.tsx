import { Show, type JSX } from 'solid-js';
import { Card, CardContent } from '@/components/ui/card';

interface EmptyStateProps {
  title: string;
  description: string;
  action?: JSX.Element;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <Card class="border-dashed bg-muted/35">
      <CardContent class="flex flex-col items-start gap-3 p-6">
        <div class="flex flex-col gap-1">
          <h3 class="text-base font-semibold text-foreground">{props.title}</h3>
          <p class="text-sm text-muted-foreground">{props.description}</p>
        </div>
        <Show when={props.action}>
          <div class="flex flex-wrap gap-2">{props.action}</div>
        </Show>
      </CardContent>
    </Card>
  );
}
