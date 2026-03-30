import { Portal } from 'solid-js/web';
import { Show, type JSX } from 'solid-js';
import { X } from 'lucide-solid';
import { Button } from '@/components/ui/button';

interface DetailDrawerProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
}

export function DetailDrawer(props: DetailDrawerProps) {
  return (
    <Show when={props.open}>
      <Portal>
        <div class="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[1px]" onClick={props.onClose}>
          <aside
            class="flex h-full w-full max-w-[720px] flex-col border-l border-border bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
              <div class="flex min-w-0 flex-col gap-1">
                <h2 class="text-lg font-semibold tracking-[-0.03em] text-foreground">{props.title}</h2>
                <Show when={props.description}>
                  <p class="text-sm text-muted-foreground">{props.description}</p>
                </Show>
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={props.onClose} aria-label="关闭">
                <X />
              </Button>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">{props.children}</div>
            <Show when={props.footer}>
              <div class="border-t border-border px-6 py-4">{props.footer}</div>
            </Show>
          </aside>
        </div>
      </Portal>
    </Show>
  );
}
