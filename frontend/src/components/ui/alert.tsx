import { cva, type VariantProps } from 'class-variance-authority';
import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

const alertVariants = cva('relative w-full rounded-[1.35rem] border px-4 py-3 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]', {
  variants: {
    variant: {
      default: 'border-border bg-card/85 text-foreground',
      destructive: 'border-red-600/20 bg-red-50/85 text-red-800',
      success: 'border-emerald-600/20 bg-emerald-50/85 text-emerald-800',
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
  return <h5 class={cn('mb-1 font-medium leading-none tracking-tight', local.class)} {...rest} />;
}

export function AlertDescription(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <div class={cn('text-sm leading-6 text-muted-foreground [&_p]:leading-6', local.class)} {...rest} />;
}
