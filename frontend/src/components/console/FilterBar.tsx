import { Show, type JSX } from 'solid-js';
import { Filter } from 'lucide-solid';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface FilterBarProps {
  primary: JSX.Element;
  advanced?: JSX.Element;
  actions?: JSX.Element;
  advancedOpen?: boolean;
  onToggleAdvanced?: () => void;
}

export function FilterBar(props: FilterBarProps) {
  return (
    <Card class="rounded-none border border-border bg-background shadow-none mb-6">
      <CardContent class="flex flex-col gap-6 p-6">
        <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div class="grid flex-1 gap-4 md:grid-cols-2 xl:grid-cols-5">{props.primary}</div>
          <div class="flex flex-wrap gap-2 items-center">
            {props.actions}
            <Show when={props.advanced}>
              <Button type="button" variant="ghost" size="sm" onClick={props.onToggleAdvanced} class="font-mono text-[0.65rem] tracking-widest px-3 ml-2">
                <Filter class="mr-2 size-3" />
                {props.advancedOpen ? 'HIDE FILTERS' : 'ADVANCED'}
              </Button>
            </Show>
          </div>
        </div>
        <Show when={props.advanced && props.advancedOpen}>
          <div class="grid gap-4 border-t border-border/40 pt-6 md:grid-cols-2 xl:grid-cols-4">{props.advanced}</div>
        </Show>
      </CardContent>
    </Card>
  );
}
