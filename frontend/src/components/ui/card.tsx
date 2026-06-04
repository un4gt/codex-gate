import { children, createMemo, splitProps, type JSX } from 'solid-js';
import { translateJsx } from '@/lib/i18n';
import { cn } from '@/lib/utils';

function createDivComponent(baseClass: string, translateChildren = false) {
  return function DivComponent(props: JSX.HTMLAttributes<HTMLDivElement>) {
    const [local, rest] = splitProps(props, ['children', 'class']);
    const resolvedChildren = children(() => local.children);
    const content = createMemo(() => (translateChildren ? translateJsx(resolvedChildren()) : resolvedChildren()));
    return <div class={cn(baseClass, local.class)} {...rest}>{content()}</div>;
  };
}

export const Card = createDivComponent('rounded-none border border-border bg-card shadow-none');
export const CardHeader = createDivComponent('flex flex-col gap-3 p-6 pb-5');
export const CardContent = createDivComponent('p-6 pt-0');
export const CardFooter = createDivComponent('flex items-center gap-3 p-6 pt-0');
export const CardTitle = createDivComponent('text-xl font-medium tracking-tight text-foreground', true);
export const CardDescription = createDivComponent('mt-1 font-mono text-xs uppercase tracking-wider text-muted-foreground', true);
