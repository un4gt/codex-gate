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
  variant?: 'cards' | 'compact';
  ariaLabel?: string;
}
function trendColor(tone?: StatItem['tone']): NonNullable<ChipProps['color']> {
  if (tone === 'success') return 'success';
  if (tone === 'warning') return 'warning';
  if (tone === 'destructive') return 'error';
  return 'default';
}
function ToneDot(props: { tone?: StatItem['tone'] }) {
  const colorClass = props.tone === 'success'
    ? 'bg-emerald-500'
    : props.tone === 'warning'
      ? 'bg-amber-500'
      : props.tone === 'destructive'
        ? 'bg-red-500'
        : null;

  if (!colorClass) return null;

  return <Box aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${colorClass}`} component="span" />;
}
export function StatsGrid(props: StatsGridProps) {
  if (props.variant === 'compact') {
    return <Box
      aria-label={props.ariaLabel ? t(props.ariaLabel) : undefined}
      className="grid grid-cols-1 gap-px overflow-hidden border border-border/60 bg-border/60 sm:grid-cols-2 xl:grid-cols-4"
      component="dl"
      data-variant="compact"
      role="list"
    >
      {props.items.map(item => <Box
        key={item.label}
        className="flex min-h-16 min-w-0 items-center gap-3 bg-background px-4 py-3"
        component="div"
        role="listitem"
      >
        <Box className="flex min-w-0 shrink-0 items-center gap-2" component="dt">
          {!item.trend ? <ToneDot tone={item.tone} /> : null}
          <Box className="truncate text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground" component="span" title={t(item.label)}>
            {t(item.label)}
          </Box>
        </Box>
        <Box className="flex min-w-0 flex-1 items-baseline gap-3" component="dd">
          <Box className="shrink-0 text-2xl font-medium leading-none tracking-normal text-foreground tabular-nums" component="span">
            {item.value}
          </Box>
          {item.hint ? <Box className="ml-auto min-w-0 truncate text-right text-xs leading-5 text-muted-foreground opacity-80" component="span" title={t(item.hint)}>
            {t(item.hint)}
          </Box> : null}
          {item.trend ? <Chip className="ml-auto shrink-0" color={trendColor(item.tone)} variant="outlined" label={item.trend} /> : null}
        </Box>
      </Box>)}
    </Box>;
  }

  return <Box className="grid gap-5 border-t border-border/40 pt-8 mt-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      {props.items.map(item => <Box key={item.label} className="flex min-h-[132px] flex-col gap-1 border border-border/60 bg-background p-5">
            <Box className="flex items-center justify-between">
              <Box className="text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground" component="span">{t(item.label)}</Box>
              {item.trend ? <Chip color={trendColor(item.tone)} variant="outlined" label={item.trend} /> : null}
              {!item.trend ? <ToneDot tone={item.tone} /> : null}
            </Box>
            <Box className="mt-2 text-3xl font-medium tracking-normal text-foreground">{item.value}</Box>
            {item.hint ? <Box className="mt-auto pt-2 text-xs leading-5 text-muted-foreground opacity-80">{t(item.hint!)}</Box> : null}
          </Box>)}
    </Box>;
}
