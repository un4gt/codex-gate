import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'type'> {}

export function Checkbox(props: CheckboxProps) {
  const [local, rest] = splitProps(props, ['class']);

  return (
    <input
      type="checkbox"
      class={cn(
        "peer h-4 w-4 shrink-0 rounded-none border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground transition-colors appearance-none checked:bg-primary checked:border-primary relative before:absolute before:inset-0 before:bg-[url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"white\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polyline points=\"20 6 9 17 4 12\"></polyline></svg>')] before:bg-no-repeat before:bg-center before:bg-[length:12px] checked:before:block before:hidden",
        local.class,
      )}
      {...rest}
    />
  );
}
