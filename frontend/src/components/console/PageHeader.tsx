import { Show, type JSX } from 'solid-js';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: JSX.Element;
}

export function PageHeader(props: PageHeaderProps) {
  return (
    <Show when={props.actions}>
      <header class="flex flex-col gap-4 pb-2 md:flex-row md:items-end md:justify-end">
        <div class="flex flex-wrap gap-2">{props.actions}</div>
      </header>
    </Show>
  );
}
