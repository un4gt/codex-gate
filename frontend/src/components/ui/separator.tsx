import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

interface SeparatorProps extends JSX.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
}

export function Separator(props: SeparatorProps) {
  const [local, rest] = splitProps(props, ['class', 'orientation']);
  const vertical = local.orientation === 'vertical';

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      class={cn(vertical ? 'h-full w-px shrink-0 bg-border/40' : 'h-px w-full shrink-0 bg-border/40', local.class)}
      {...rest}
    />
  );
}
