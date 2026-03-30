import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

export function FieldGroup(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <div class={cn('flex flex-col gap-4', local.class)} {...rest} />;
}

export function Field(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <div class={cn('flex flex-col gap-2', local.class)} {...rest} />;
}

export function FieldLabel(props: JSX.LabelHTMLAttributes<HTMLLabelElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <label class={cn('font-mono text-[0.72rem] uppercase tracking-[0.22em] text-muted-foreground', local.class)} {...rest} />;
}

export function FieldDescription(props: JSX.HTMLAttributes<HTMLParagraphElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <p class={cn('text-xs leading-5 text-muted-foreground', local.class)} {...rest} />;
}

export function FieldSet(props: JSX.FieldsetHTMLAttributes<HTMLFieldSetElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <fieldset class={cn('rounded-2xl border border-border bg-muted/40 p-4', local.class)} {...rest} />;
}

export function FieldLegend(props: JSX.HTMLAttributes<HTMLLegendElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return <legend class={cn('px-2 font-mono text-[0.72rem] uppercase tracking-[0.22em] text-muted-foreground', local.class)} {...rest} />;
}
