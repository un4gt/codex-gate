import { cva, type VariantProps } from 'class-variance-authority';
import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.7rem] font-medium uppercase tracking-[0.2em] transition-colors duration-200 ease-out',
  {
    variants: {
      variant: {
        default: 'border-primary/20 bg-primary/10 text-primary',
        secondary: 'border-border bg-secondary/80 text-secondary-foreground',
        outline: 'border-border bg-card/80 text-muted-foreground',
        success: 'border-emerald-600/20 bg-emerald-50/85 text-emerald-700',
        warning: 'border-amber-600/20 bg-amber-50/90 text-amber-700',
        destructive: 'border-red-600/20 bg-red-50/85 text-red-700',
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
