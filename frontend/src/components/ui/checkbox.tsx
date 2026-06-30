import { Checkbox as ArkCheckbox } from '@ark-ui/solid/checkbox';
import { Check } from 'lucide-solid';
import { splitProps, type JSX } from 'solid-js';
import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  defaultChecked?: boolean;
}

export function Checkbox(props: CheckboxProps) {
  const [local, rest] = splitProps(props, [
    'checked',
    'class',
    'defaultChecked',
    'disabled',
    'form',
    'id',
    'name',
    'onChange',
    'readOnly',
    'required',
    'value',
  ]);

  return (
    <ArkCheckbox.Root
      checked={local.checked}
      defaultChecked={local.defaultChecked}
      disabled={local.disabled}
      form={local.form}
      id={local.id}
      name={local.name}
      readOnly={local.readOnly}
      required={local.required}
      value={local.value === undefined ? undefined : String(local.value)}
      asChild={(arkProps) => (
        <span class="inline-flex items-center align-middle" {...arkProps({})}>
          <ArkCheckbox.Control
            class={cn(
              'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-none border border-primary text-primary-foreground transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[focus-visible]:outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-ring data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary',
              local.class,
            )}
          >
            <ArkCheckbox.Indicator class="flex items-center justify-center">
              <Check class="size-3" strokeWidth={3} />
            </ArkCheckbox.Indicator>
          </ArkCheckbox.Control>
          <ArkCheckbox.HiddenInput onChange={local.onChange} {...rest} />
        </span>
      )}
    />
  );
}
