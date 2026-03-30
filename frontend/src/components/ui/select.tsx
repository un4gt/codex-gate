import { ChevronDown } from 'lucide-solid';
import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

export interface SelectProps extends JSX.SelectHTMLAttributes<HTMLSelectElement> {
  children?: JSX.Element;
}

export function Select(props: SelectProps) {
  const [local, rest] = splitProps(props, ['class', 'children']);

  return (
    <div class="relative">
      <select
        class={cn(
          'flex h-10 w-full appearance-none rounded-lg border border-border bg-card px-3 py-2 pr-10 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50',
          local.class,
        )}
        {...rest}
      >
        {local.children}
      </select>
      <ChevronDown class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
