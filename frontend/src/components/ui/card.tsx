import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

function createDivComponent(baseClass: string) {
  return function DivComponent(props: JSX.HTMLAttributes<HTMLDivElement>) {
    const [local, rest] = splitProps(props, ['class']);
    return <div class={cn(baseClass, local.class)} {...rest} />;
  };
}

export const Card = createDivComponent('rounded-none border border-border bg-background shadow-none');
export const CardHeader = createDivComponent('flex flex-col gap-3 p-6');
export const CardContent = createDivComponent('p-6 pt-0');
export const CardFooter = createDivComponent('flex items-center gap-3 p-6 pt-0');
export const CardTitle = createDivComponent('text-lg font-medium tracking-tight');
export const CardDescription = createDivComponent('text-xs uppercase tracking-widest font-mono text-muted-foreground');
