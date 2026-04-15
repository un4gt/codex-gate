import { cva, type VariantProps } from 'class-variance-authority';
import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

const alertVariants = cva('relative w-full border px-5 py-4 shadow-none bg-transparent', {
  variants: {
    variant: {
      default: 'border-border text-foreground',
      destructive: 'border-red-500/50 text-red-600',
      success: 'border-emerald-500/50 text-emerald-600',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

export interface AlertProps extends JSX.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {}

export function Alert(props: AlertProps) {
  const [local, rest] = splitProps(props, ['class', 'variant']);
  return <div role="alert" class={cn(alertVariants({ variant: local.variant }), local.class)} {...rest} />;
}

export function AlertTitle(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <h5 class={cn('mb-2 text-sm font-medium leading-none tracking-tight', local.class)} {...rest} />;
}

export function AlertDescription(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <div class={cn('text-[0.8rem] leading-relaxed text-muted-foreground', local.class)} {...rest} />;
}
