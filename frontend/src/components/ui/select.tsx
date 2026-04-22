import { ChevronDown } from 'lucide-solid';
import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

export interface SelectProps extends JSX.SelectHTMLAttributes<HTMLSelectElement> {
  children?: JSX.Element;
}

export function Select(props: SelectProps) {
  const [local, rest] = splitProps(props, ['class', 'children', 'value']);
  const value = local.value as string | number | string[] | undefined;

  return (
    <div class="relative">
      <select
        class={cn(
          'flex h-10 w-full appearance-none rounded-none border border-border bg-transparent px-3 py-2 pr-10 text-sm text-foreground shadow-none transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 font-mono',
          local.class,
        )}
        value={value}
        {...rest}
      >
        {local.children}
      </select>
      <ChevronDown class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground size-4 opacity-50" />
    </div>
  );
}
