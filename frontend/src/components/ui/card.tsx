import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

function createDivComponent(baseClass: string) {
  return function DivComponent(props: JSX.HTMLAttributes<HTMLDivElement>) {
    const [local, rest] = splitProps(props, ['class']);
    return <div class={cn(baseClass, local.class)} {...rest} />;
  };
}

export const Card = createDivComponent('rounded-[1.75rem] border border-border bg-card/92 text-card-foreground shadow-[0_22px_56px_-44px_rgba(29,24,16,0.42)] backdrop-blur-sm');
export const CardHeader = createDivComponent('flex flex-col gap-3 p-6');
export const CardContent = createDivComponent('p-6 pt-0');
export const CardFooter = createDivComponent('flex items-center gap-3 p-6 pt-0');
export const CardTitle = createDivComponent('text-lg font-semibold tracking-[-0.03em]');
export const CardDescription = createDivComponent('text-sm leading-6 text-muted-foreground');
