import { For, createMemo } from 'solid-js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface TrendPoint {
  label: string;
  value: number;
}

interface TrendChartProps {
  points: TrendPoint[];
}

function buildChart(points: TrendPoint[]) {
  const width = 640;
  const height = 220;
  const paddingX = 18;
  const paddingTop = 18;
  const paddingBottom = 28;
  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const usableWidth = width - paddingX * 2;
  const usableHeight = height - paddingTop - paddingBottom;

  const linePoints = points.map((point, index) => {
    const x = paddingX + (usableWidth * index) / Math.max(points.length - 1, 1);
    const y = paddingTop + usableHeight - (point.value / maxValue) * usableHeight;
    return { x, y, value: point.value, label: point.label };
  });

  const line = linePoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');

  const area = `${line} L ${linePoints[linePoints.length - 1]?.x ?? paddingX} ${height - paddingBottom} L ${linePoints[0]?.x ?? paddingX} ${height - paddingBottom} Z`;

  return {
    width,
    height,
    line,
    area,
    points: linePoints,
  };
}

export function TrendChart(props: TrendChartProps) {
  const chart = createMemo(() => buildChart(props.points));
  const peak = createMemo(() => Math.max(...props.points.map((point) => point.value), 0));
  const latest = createMemo(() => props.points[props.points.length - 1]?.value ?? 0);
  const guideLines = createMemo(() => [0.2, 0.4, 0.6, 0.8].map((ratio) => 18 + (220 - 18 - 28) * ratio));

  return (
    <Card class="overflow-hidden">
      <CardHeader class="gap-4">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p class="panel__eyebrow">趋势</p>
            <CardTitle>最近 14 天请求波形</CardTitle>
            <CardDescription>用单条轨迹快速看出峰值、回落和最近一天的节奏。</CardDescription>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-xl border border-border bg-background/70 px-4 py-3">
              <div class="panel__eyebrow mb-1">峰值</div>
              <div class="text-2xl font-semibold tracking-[-0.04em] text-foreground">{peak()}</div>
            </div>
            <div class="rounded-xl border border-border bg-background/70 px-4 py-3">
              <div class="panel__eyebrow mb-1">最新</div>
              <div class="text-2xl font-semibold tracking-[-0.04em] text-foreground">{latest()}</div>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="rounded-[1.45rem] border border-border bg-background/75 p-4">
          <svg class="h-60 w-full overflow-visible" viewBox={`0 0 ${chart().width} ${chart().height}`} preserveAspectRatio="none">
            <For each={guideLines()}>{(guideY) => <line x1="18" x2={chart().width - 18} y1={guideY} y2={guideY} stroke="rgba(41, 37, 30, 0.1)" stroke-dasharray="4 8" />}</For>
            <line x1="18" x2="18" y1="18" y2={chart().height - 28} stroke="rgba(41, 37, 30, 0.08)" />
            <line x1="18" x2={chart().width - 18} y1={chart().height - 28} y2={chart().height - 28} stroke="rgba(41, 37, 30, 0.08)" />
          <defs>
            <linearGradient id="trendFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="rgba(224, 113, 51, 0.22)" />
              <stop offset="100%" stop-color="rgba(224, 113, 51, 0.02)" />
            </linearGradient>
          </defs>
          <path d={chart().area} fill="url(#trendFill)" />
          <path d={chart().line} fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" />
          <For each={chart().points}>{(point) => <circle cx={point.x} cy={point.y} r="4.5" fill="var(--card)" stroke="var(--primary)" stroke-width="2" />}</For>
          </svg>
        </div>
        <div class="grid grid-cols-7 gap-2 text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground sm:grid-cols-14">
          <For each={props.points}>{(point) => <span class="truncate">{point.label}</span>}</For>
        </div>
      </CardContent>
    </Card>
  );
}
