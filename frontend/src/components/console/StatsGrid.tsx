import { useI18n } from '@/lib/i18n';
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import type { ChipProps } from "@mui/material/Chip";
import Skeleton from '@mui/material/Skeleton';
import type { LucideIcon } from 'lucide-react';
export interface StatItem {
  label: string;
  value: string;
  hint?: string;
  trend?: string;
  tone?: 'default' | 'success' | 'warning' | 'destructive';
  icon?: LucideIcon;
}
interface StatsGridProps {
  items: StatItem[];
  variant?: 'cards' | 'compact';
  ariaLabel?: string;
  loading?: boolean;
}
function trendColor(tone?: StatItem['tone']): NonNullable<ChipProps['color']> {
  if (tone === 'success') return 'success';
  if (tone === 'warning') return 'warning';
  if (tone === 'destructive') return 'error';
  return 'default';
}
function ToneDot(props: { tone?: StatItem['tone'] }) {
  const colorClass = props.tone === 'success'
    ? 'bg-success'
    : props.tone === 'warning'
      ? 'bg-warning'
      : props.tone === 'destructive'
        ? 'bg-danger'
        : null;

  if (!colorClass) return null;

  return <Box aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${colorClass}`} component="span" />;
}
export function StatsGrid(props: StatsGridProps) {
  const { t } = useI18n();
  if (props.variant === 'compact') {
    return <Box
      aria-label={props.ariaLabel ? t(props.ariaLabel) : undefined}
      className="grid grid-cols-1 gap-px overflow-hidden rounded border border-border/60 bg-border/60 sm:grid-cols-2 xl:grid-cols-4"
      component="dl"
      data-variant="compact"
      role="list"
    >
      {props.items.map(item => <Box
        key={item.label}
        className="flex min-h-14 min-w-0 items-center gap-2.5 bg-card px-4 py-3"
        component="div"
        role="listitem"
      >
        <Box className="flex min-w-0 shrink-0 items-center gap-1.5" component="dt">
          {!item.trend ? <ToneDot tone={item.tone} /> : null}
          <Box className="truncate text-xs font-medium text-muted-foreground" component="span" title={t(item.label)}>
            {t(item.label)}
          </Box>
        </Box>
        <Box className="flex min-w-0 flex-1 items-baseline gap-2.5" component="dd">
          <Box className="shrink-0 text-lg font-medium leading-none tracking-normal text-foreground tabular-nums" component="span">
            {item.value}
          </Box>
          {item.hint ? <Box className="ml-auto min-w-0 truncate text-right text-xs leading-4 text-muted-foreground" component="span" title={t(item.hint)}>
            {t(item.hint)}
          </Box> : null}
          {item.trend ? <Chip className="ml-auto shrink-0" color={trendColor(item.tone)} variant="outlined" label={item.trend} /> : null}
        </Box>
      </Box>)}
    </Box>;
  }

  return <Box component="dl" aria-label={props.ariaLabel ? t(props.ariaLabel) : undefined} aria-busy={props.loading} className="grid grid-cols-2 gap-3 xl:grid-cols-3">
      {props.items.map(item => {
        const Icon = item.icon;
        return <Box key={item.label} className="console-panel flex min-w-0 flex-col p-4 sm:p-5">
          <Box className="flex items-center justify-between gap-3" component="dt">
            <Box className="flex items-center gap-2 text-[0.8125rem] font-medium text-muted-foreground" component="span">
              {!item.trend ? <ToneDot tone={item.tone} /> : null}{t(item.label)}
            </Box>
            {Icon ? <Box className="hidden size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.06] text-primary sm:flex" component="span"><Icon size={16} aria-hidden="true" /></Box> : null}
            {item.trend ? <Chip color={trendColor(item.tone)} variant="outlined" label={item.trend} /> : null}
          </Box>
          <Box component="dd" className="mt-3 break-words text-2xl font-semibold leading-9 tracking-tight text-foreground tabular-nums sm:text-[1.75rem]">
            {props.loading ? <Skeleton width="45%" animation="pulse" /> : item.value}
          </Box>
          {item.hint ? <Box className="mt-2 text-xs leading-5 text-muted-foreground">{t(item.hint)}</Box> : null}
        </Box>;
      })}
    </Box>;
}
