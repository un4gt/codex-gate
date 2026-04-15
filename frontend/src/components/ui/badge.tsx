import { cva, type VariantProps } from 'class-variance-authority';
import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 border border-border px-3 py-1 font-mono text-[0.65rem] uppercase tracking-widest font-medium transition-colors bg-transparent text-foreground',
  {
    variants: {
      variant: {
        default: 'border-primary/20 bg-primary/10 text-primary',
        secondary: 'border-border bg-transparent text-muted-foreground',
        outline: 'border-border bg-transparent text-muted-foreground',
        success: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600',
        warning: 'border-amber-500/50 bg-amber-500/10 text-amber-600',
        destructive: 'border-red-500/50 bg-red-500/10 text-red-600',
      },
    },
    defaultVariants: {
      variant: 'secondary',
    },
  },
);

export interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge(props: BadgeProps) {
  const [local, rest] = splitProps(props, ['class', 'variant']);
  return <span class={cn(badgeVariants({ variant: local.variant }), local.class)} {...rest} />;
}
