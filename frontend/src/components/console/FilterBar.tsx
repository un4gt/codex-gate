import { Show, type JSX } from 'solid-js';
import { ChevronDown } from 'lucide-solid';
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
    <Card class="border-border/80 bg-card/95">
      <CardContent class="flex flex-col gap-4 p-4">
        <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div class="grid flex-1 gap-3 md:grid-cols-2 xl:grid-cols-5">{props.primary}</div>
          <div class="flex flex-wrap gap-2">
            <Show when={props.advanced}>
              <Button type="button" variant="outline" size="sm" onClick={props.onToggleAdvanced}>
                <ChevronDown class={props.advancedOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
                高级筛选
              </Button>
            </Show>
            {props.actions}
          </div>
        </div>
        <Show when={props.advanced && props.advancedOpen}>
          <div class="grid gap-3 border-t border-border pt-4 md:grid-cols-2 xl:grid-cols-4">{props.advanced}</div>
        </Show>
      </CardContent>
    </Card>
  );
}
