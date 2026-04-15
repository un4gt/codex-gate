import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

export interface TextareaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function Textarea(props: TextareaProps) {
  const [local, rest] = splitProps(props, ['class']);

  return (
    <textarea
      class={cn(
        'flex min-h-[80px] w-full rounded-none border border-border bg-transparent px-3 py-2 text-sm text-foreground shadow-none transition-colors placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 font-mono',
        local.class,
      )}
      {...rest}
    />
  );
}
