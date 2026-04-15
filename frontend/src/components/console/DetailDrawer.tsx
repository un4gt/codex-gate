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
        <div class="fixed inset-0 z-50 flex justify-end bg-background/80 backdrop-blur-sm transition-opacity" onClick={props.onClose}>
          <aside
            class="flex h-full w-full max-w-3xl flex-col border-l border-border bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border/40 bg-background/95 px-8 py-6 backdrop-blur-md">
              <div class="flex min-w-0 flex-col gap-2">
                <h2 class="text-3xl font-medium tracking-tight text-foreground truncate" title={props.title}>{props.title}</h2>
                <Show when={props.description}>
                  <p class="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground opacity-70 truncate">{props.description}</p>
                </Show>
              </div>
              <Button type="button" variant="ghost" size="icon" onClick={props.onClose} aria-label="关闭" class="-mr-2">
                <X class="size-5" />
              </Button>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto p-8">{props.children}</div>
            <Show when={props.footer}>
              <div class="border-t border-border/40 bg-muted/5 px-8 py-6">{props.footer}</div>
            </Show>
          </aside>
        </div>
      </Portal>
    </Show>
  );
}
