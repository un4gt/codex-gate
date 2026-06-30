import { Drawer } from '@ark-ui/solid/drawer';
import { Show, type JSX } from 'solid-js';
import { X } from 'lucide-solid';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

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
    <Drawer.Root
      open={props.open}
      lazyMount
      unmountOnExit
      onOpenChange={(details) => {
        if (!details.open) props.onClose();
      }}
    >
      <Drawer.Backdrop class="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
      <Drawer.Positioner class="fixed inset-0 z-50 flex justify-end">
        <Drawer.Content class="flex h-full w-full max-w-3xl flex-col border-l border-border bg-card shadow-none outline-none">
          <div class="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border/40 bg-card/95 px-8 py-6 backdrop-blur-md">
            <div class="flex min-w-0 flex-col gap-2">
              <Drawer.Title class="truncate text-3xl font-semibold tracking-normal text-foreground" title={t(props.title)}>
                {t(props.title)}
              </Drawer.Title>
              <Show when={props.description}>
                <Drawer.Description class="truncate text-sm leading-5 text-muted-foreground opacity-80">
                  {t(props.description!)}
                </Drawer.Description>
              </Show>
            </div>
            <Drawer.CloseTrigger
              asChild={(arkProps) => (
                <Button type="button" variant="ghost" size="icon" aria-label={t('关闭')} class="-mr-2" {...arkProps({})}>
                  <X class="size-5" />
                </Button>
              )}
            />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-8">{props.children}</div>
          <Show when={props.footer}>
            <div class="border-t border-border/40 bg-muted/5 px-8 py-6">{props.footer}</div>
          </Show>
        </Drawer.Content>
      </Drawer.Positioner>
    </Drawer.Root>
  );
}
