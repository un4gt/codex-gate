import { SquareTerminal } from 'lucide-solid';
import { Show, type JSX } from 'solid-js';
import { t } from '@/lib/i18n';

export function EmptyState(props: { title: string; description?: string; action?: JSX.Element }) {
  return (
    <div class="flex flex-col items-center justify-center p-12 border border-dashed border-border/60 bg-transparent text-center">
      <div class="flex size-12 items-center justify-center bg-muted text-muted-foreground opacity-50 mb-6">
        <SquareTerminal class="size-5" />
      </div>
      <h3 class="text-sm font-medium tracking-widest uppercase font-mono text-foreground mb-2">{t(props.title)}</h3>
      <Show when={props.description}>
        <p class="text-[0.65rem] font-mono tracking-widest uppercase text-muted-foreground opacity-60 max-w-md">{t(props.description!)}</p>
      </Show>
      <Show when={props.action}>
        <div class="mt-6">{props.action}</div>
      </Show>
    </div>
  );
}
