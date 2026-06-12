import { SquareTerminal } from 'lucide-solid';
import { Show, type JSX } from 'solid-js';
import { t } from '@/lib/i18n';

export function EmptyState(props: { title: string; description?: string; action?: JSX.Element }) {
  return (
    <div class="flex flex-col items-center justify-center border border-dashed border-border/60 bg-muted/10 p-10 text-center">
      <div class="mb-6 flex size-12 items-center justify-center border border-border/50 bg-background text-muted-foreground opacity-60">
        <SquareTerminal class="size-5" />
      </div>
      <h3 class="mb-2 text-sm font-semibold uppercase tracking-[0.08em] text-foreground">{t(props.title)}</h3>
      <Show when={props.description}>
        <p class="max-w-md text-xs leading-5 text-muted-foreground opacity-80">{t(props.description!)}</p>
      </Show>
      <Show when={props.action}>
        <div class="mt-6">{props.action}</div>
      </Show>
    </div>
  );
}
