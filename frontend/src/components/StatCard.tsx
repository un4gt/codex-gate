import { type JSX } from "react";
import { t } from '@/lib/i18n';
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
interface StatCardProps {
  title: string;
  value: string;
  unit?: string;
  eyebrow: string;
  meta: string;
  accent?: 'orange' | 'green' | 'slate';
  icon: JSX.Element;
}
const accentClasses: Record<NonNullable<StatCardProps['accent']>, string> = {
  orange: 'border-primary/20 bg-primary/10 text-primary',
  green: 'border-emerald-600/20 bg-emerald-50/90 text-emerald-700',
  slate: 'border-border bg-muted/75 text-foreground'
};
export function StatCard(props: StatCardProps) {
  const accent = props.accent ?? 'orange';
  return <Card className="overflow-hidden">
      <CardContent className="p-0">
        <Box className="flex min-h-[220px] flex-col justify-between gap-8 p-6">
          <Box className="flex items-start justify-between gap-4">
            <Box className="flex flex-col gap-3">
              <Box className="panel__eyebrow mb-0 flex items-center gap-2">
                <Box className="size-2 rounded-full bg-primary" component="span" />
                {t(props.eyebrow)}
              </Box>
              <Box className="text-sm font-medium text-muted-foreground" component="p">{t(props.title)}</Box>
            </Box>
            <Box className={`flex size-12 items-center justify-center border ${accentClasses[accent]}`}>{props.icon}</Box>
          </Box>
          <Box className="flex flex-col gap-4">
            <Box className="flex items-end gap-2">
              <Box className="text-4xl font-semibold tracking-[-0.05em] text-foreground" component="span">{props.value}</Box>
              {props.unit && <Box className="pb-1 text-sm text-muted-foreground" component="span">{props.unit}</Box>}
            </Box>
            <Box className="h-px bg-border" />
            <Box className="panel__muted" component="p">{t(props.meta)}</Box>
          </Box>
        </Box>
      </CardContent>
    </Card>;
}
