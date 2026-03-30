import { For, createMemo } from 'solid-js';
import { cn } from '@/lib/utils';
import type { HeatmapDay } from '../lib/types';

interface ActivityHeatmapProps {
  days: HeatmapDay[];
  metricLabel: string;
  formatValue?: (value: number) => string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

const levelClasses = [
  'bg-background',
  'bg-stone-200',
  'bg-stone-300',
  'bg-orange-300',
  'bg-orange-500',
];

export function ActivityHeatmap(props: ActivityHeatmapProps) {
  const weeks = createMemo(() => chunk(props.days, 7));
  const monthLabels = createMemo(() => {
    let previousMonth = '';
    return weeks().map((week) => {
      const firstDay = week.find((day) => !day.isFuture) ?? week[0];
      const month = firstDay ? firstDay.label.slice(5, 7) : '';
      if (!month || month === previousMonth) {
        return '';
      }
      previousMonth = month;
      return `${Number(month)}月`;
    });
  });

  const formatValue = (value: number) => (props.formatValue ? props.formatValue(value) : String(value));

  return (
    <div class="overflow-x-auto pb-2">
      <div class="mb-3 ml-12 grid min-w-[780px] grid-cols-[repeat(54,minmax(12px,1fr))] gap-1.5 text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">
        <For each={monthLabels()}>{(month) => <span>{month}</span>}</For>
      </div>
      <div class="grid min-w-[820px] grid-cols-[36px_1fr] gap-3">
        <div class="grid grid-rows-7 gap-1.5 pt-4 text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">
          <span class="row-start-2">周一</span>
          <span class="row-start-4">周三</span>
          <span class="row-start-6">周五</span>
        </div>
        <div class="grid grid-cols-[repeat(54,minmax(12px,1fr))] gap-1.5">
          <For each={weeks()}>
            {(week) => (
              <div class="grid grid-rows-7 gap-1.5">
                <For each={week}>
                  {(day) => (
                    <div
                      class={cn(
                        'size-3.5 rounded-[4px] border border-border transition-transform duration-200 ease-out hover:-translate-y-px',
                        levelClasses[day.level],
                        day.isFuture && 'opacity-30',
                      )}
                      title={`${day.label} · ${formatValue(day.value)} ${props.metricLabel}`}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
