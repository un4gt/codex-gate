import { children, createMemo, splitProps, type JSX } from 'solid-js';
import { translateJsx } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function FieldGroup(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <div class={cn('flex flex-col gap-6', local.class)} {...rest} />;
}

export function Field(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <div class={cn('flex flex-col gap-3', local.class)} {...rest} />;
}

export function FieldLabel(props: JSX.LabelHTMLAttributes<HTMLLabelElement>) {
  const [local, rest] = splitProps(props, ['children', 'class']);
  const resolvedChildren = children(() => local.children);
  const content = createMemo(() => translateJsx(resolvedChildren()));
  return <label class={cn('text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-foreground', local.class)} {...rest}>{content()}</label>;
}

export function FieldDescription(props: JSX.HTMLAttributes<HTMLParagraphElement>) {
  const [local, rest] = splitProps(props, ['children', 'class']);
  const resolvedChildren = children(() => local.children);
  const content = createMemo(() => translateJsx(resolvedChildren()));
  return <p class={cn('text-xs leading-5 text-muted-foreground opacity-80', local.class)} {...rest}>{content()}</p>;
}

export function FieldSet(props: JSX.FieldsetHTMLAttributes<HTMLFieldSetElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <fieldset class={cn('border border-border bg-transparent p-6', local.class)} {...rest} />;
}

export function FieldLegend(props: JSX.HTMLAttributes<HTMLLegendElement>) {
  const [local, rest] = splitProps(props, ['children', 'class']);
  const resolvedChildren = children(() => local.children);
  const content = createMemo(() => translateJsx(resolvedChildren()));
  return <legend class={cn('px-2 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground', local.class)} {...rest}>{content()}</legend>;
}
