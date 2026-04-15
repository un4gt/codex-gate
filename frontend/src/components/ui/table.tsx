import { children, createMemo, splitProps, type JSX } from 'solid-js';
import { translateJsx } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function Table(props: JSX.HTMLAttributes<HTMLTableElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return (
    <div class="relative w-full overflow-x-auto border border-border bg-background">
      <table class={cn('w-full caption-bottom text-sm font-mono', local.class)} {...rest} />
    </div>
  );
}

export function TableHeader(props: JSX.HTMLAttributes<HTMLTableSectionElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <thead class={cn('[&_tr]:border-b [&_tr]:border-border', local.class)} {...rest} />;
}

export function TableBody(props: JSX.HTMLAttributes<HTMLTableSectionElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <tbody class={cn('[&_tr:last-child]:border-0', local.class)} {...rest} />;
}

export function TableFooter(props: JSX.HTMLAttributes<HTMLTableSectionElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <tfoot class={cn('border-t border-border bg-muted/50 font-medium [&>tr]:last:border-b-0', local.class)} {...rest} />;
}

export function TableRow(props: JSX.HTMLAttributes<HTMLTableRowElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <tr class={cn('border-b border-border/50 transition-colors hover:bg-muted/50', local.class)} {...rest} />;
}

export function TableHead(props: JSX.ThHTMLAttributes<HTMLTableCellElement>) {
  const [local, rest] = splitProps(props, ['children', 'class']);
  const resolvedChildren = children(() => local.children);
  const content = createMemo(() => translateJsx(resolvedChildren()));
  return <th class={cn('h-12 px-5 text-left align-middle font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground bg-muted/20', local.class)} {...rest}>{content()}</th>;
}

export function TableCell(props: JSX.TdHTMLAttributes<HTMLTableCellElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <td class={cn('px-5 py-4 align-middle text-sm opacity-90', local.class)} {...rest} />;
}

export function TableCaption(props: JSX.HTMLAttributes<HTMLTableCaptionElement>) {
  const [local, rest] = splitProps(props, ['children', 'class']);
  const resolvedChildren = children(() => local.children);
  const content = createMemo(() => translateJsx(resolvedChildren()));
  return <caption class={cn('mt-4 text-sm text-muted-foreground', local.class)} {...rest}>{content()}</caption>;
}
