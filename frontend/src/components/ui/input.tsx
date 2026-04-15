import { splitProps, type JSX } from 'solid-js';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {}

export function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ['class', 'type', 'placeholder']);

  return (
    <input
      type={local.type ?? 'text'}
      placeholder={typeof local.placeholder === 'string' ? t(local.placeholder) : local.placeholder}
      class={cn(
        'flex h-10 w-full rounded-none border border-border bg-transparent px-3 py-2 text-sm text-foreground shadow-none transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 font-mono',
        local.class,
      )}
      {...rest}
    />
  );
}
