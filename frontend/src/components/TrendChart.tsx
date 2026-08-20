import { useMemo } from 'react';
import { t } from '@/lib/i18n';
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";
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
  const maxValue = Math.max(...points.map(point => point.value), 1);
  const usableWidth = width - paddingX * 2;
  const usableHeight = height - paddingTop - paddingBottom;
  const linePoints = points.map((point, index) => {
    const x = paddingX + usableWidth * index / Math.max(points.length - 1, 1);
    const y = paddingTop + usableHeight - point.value / maxValue * usableHeight;
    return {
      x,
      y,
      value: point.value,
      label: point.label
    };
  });
  const line = linePoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const area = `${line} L ${linePoints[linePoints.length - 1]?.x ?? paddingX} ${height - paddingBottom} L ${linePoints[0]?.x ?? paddingX} ${height - paddingBottom} Z`;
  return {
    width,
    height,
    line,
    area,
    points: linePoints
  };
}
export function TrendChart(props: TrendChartProps) {
  const chart = useMemo(() => buildChart(props.points), [props.points]);
  const peak = Math.max(...props.points.map(point => point.value), 0);
  const latest = props.points[props.points.length - 1]?.value ?? 0;
  const guideLines = [0.2, 0.4, 0.6, 0.8].map(ratio => 18 + (220 - 18 - 28) * ratio);
  return <Card className="overflow-hidden">
      <Box className="flex flex-col gap-3 p-4 pb-3">
        <Box className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <Box>
            <Box className="panel__eyebrow" component="p">{t('趋势')}</Box>
            <Typography className="text-sm font-semibold tracking-normal text-foreground" component="div">{t("最近 14 天请求波形")}</Typography>
            <Typography className="mt-0.5 text-[0.8125rem] leading-5 text-muted-foreground" component="div">{t('查看最近请求变化。')}</Typography>
          </Box>
          <Box className="grid gap-2 sm:grid-cols-2">
            <Box className="surface-tile px-3 py-2">
              <Box className="panel__eyebrow mb-0.5">{t('峰值')}</Box>
              <Box className="text-lg font-semibold tracking-tight text-foreground">{peak}</Box>
            </Box>
            <Box className="surface-tile px-3 py-2">
              <Box className="panel__eyebrow mb-0.5">{t('最新')}</Box>
              <Box className="text-lg font-semibold tracking-tight text-foreground">{latest}</Box>
            </Box>
          </Box>
        </Box>
      </Box>
      <CardContent className="flex flex-col gap-3">
        <Box className="rounded border border-border bg-background/75 p-3">
          <svg className="h-44 w-full overflow-visible" viewBox={`0 0 ${chart.width} ${chart.height}`} preserveAspectRatio="none">
            {guideLines.map(guideY => <line key={guideY} x1="18" x2={chart.width - 18} y1={guideY} y2={guideY} stroke="rgba(41, 37, 30, 0.1)" strokeDasharray="4 8" />)}
            <line x1="18" x2="18" y1="18" y2={chart.height - 28} stroke="rgba(41, 37, 30, 0.08)" />
            <line x1="18" x2={chart.width - 18} y1={chart.height - 28} y2={chart.height - 28} stroke="rgba(41, 37, 30, 0.08)" />
          <defs>
            <linearGradient id="trendFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(224, 113, 51, 0.22)" />
              <stop offset="100%" stopColor="rgba(224, 113, 51, 0.02)" />
            </linearGradient>
          </defs>
          <path d={chart.area} fill="url(#trendFill)" />
          <path d={chart.line} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" />
          {chart.points.map(point => <circle key={`${point.label}:${point.x}`} cx={point.x} cy={point.y} r="3" fill="var(--card)" stroke="var(--primary)" strokeWidth="1.5" />)}
          </svg>
        </Box>
        <Box className="grid grid-cols-7 gap-2 text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground sm:grid-cols-14">
          {props.points.map((point, index) => <Box key={`${point.label}:${index}`} className="truncate" component="span">{point.label}</Box>)}
        </Box>
      </CardContent>
    </Card>;
}
