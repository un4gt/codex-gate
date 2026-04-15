import { cva, type VariantProps } from 'class-variance-authority';
import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none font-bold text-xs uppercase tracking-widest transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-foreground text-background shadow-none hover:bg-foreground/90',
        secondary: 'bg-secondary text-secondary-foreground shadow-none hover:bg-secondary/80',
        outline: 'border border-border bg-background text-foreground shadow-none hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        subtle: 'border border-border bg-muted/70 text-muted-foreground hover:bg-muted/90 hover:text-foreground',
      },
      size: {
        default: 'h-10 px-6 py-2',
        sm: 'h-8 px-4 text-[0.65rem]',
        lg: 'h-12 px-8',
        icon: 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ['class', 'variant', 'size']);

  return <button class={cn(buttonVariants({ variant: local.variant, size: local.size }), local.class)} {...rest} />;
}

export { buttonVariants };
