import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'type'> {}

export function Checkbox(props: CheckboxProps) {
  const [local, rest] = splitProps(props, ['class']);

  return (
    <input
      type="checkbox"
      class={cn(
        'size-4 rounded border border-border bg-card accent-primary shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50',
        local.class,
      )}
      {...rest}
    />
  );
}
