import { t } from '@/lib/i18n';
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import type { ChipProps } from "@mui/material/Chip";
export interface StatItem {
  label: string;
  value: string;
  hint?: string;
  trend?: string;
  tone?: 'default' | 'success' | 'warning' | 'destructive';
}
interface StatsGridProps {
  items: StatItem[];
}
function trendColor(tone?: StatItem['tone']): NonNullable<ChipProps['color']> {
  if (tone === 'success') return 'success';
  if (tone === 'warning') return 'warning';
  if (tone === 'destructive') return 'error';
  return 'default';
}
export function StatsGrid(props: StatsGridProps) {
  return <Box className="grid gap-5 border-t border-border/40 pt-8 mt-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      {props.items.map(item => <Box key={item.label} className="flex min-h-[132px] flex-col gap-1 border border-border/60 bg-background p-5">
            <Box className="flex items-center justify-between">
              <Box className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground" component="span">{t(item.label)}</Box>
              {item.trend ? <Chip color={trendColor(item.tone)} variant="outlined" label={item.trend} /> : null}
              {!item.trend && item.tone === 'success' ? <Box className="size-1.5 rounded-full bg-emerald-500" component="span" /> : null}
              {!item.trend && item.tone === 'warning' ? <Box className="size-1.5 rounded-full bg-amber-500" component="span" /> : null}
              {!item.trend && item.tone === 'destructive' ? <Box className="size-1.5 rounded-full bg-red-500" component="span" /> : null}
            </Box>
            <Box className="mt-2 text-3xl font-medium tracking-normal text-foreground">{item.value}</Box>
            {item.hint ? <Box className="mt-auto pt-2 text-xs leading-5 text-muted-foreground opacity-80">{t(item.hint!)}</Box> : null}
          </Box>)}
    </Box>;
}
