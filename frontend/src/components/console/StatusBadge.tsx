import { t } from "@/lib/i18n";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import type { ChipProps } from "@mui/material/Chip";
export type StatusTone = 'normal' | 'warning' | 'error' | 'disabled' | 'draft' | 'archived';
interface StatusBadgeProps {
  tone: StatusTone;
  children: string;
}
function badgeColor(tone: StatusTone): NonNullable<ChipProps['color']> {
  if (tone === 'normal') return 'success';
  if (tone === 'warning') return 'warning';
  if (tone === 'error') return 'error';
  return 'default';
}
function dotColor(tone: StatusTone): string {
  if (tone === 'normal') return 'bg-success';
  if (tone === 'warning') return 'bg-warning';
  if (tone === 'error') return 'bg-danger';
  return 'bg-muted-foreground/50';
}
export function StatusBadge(props: StatusBadgeProps) {
  return <Chip color={badgeColor(props.tone)} variant="outlined" label={<><Box className={`size-1.5 rounded-full mr-2 ${dotColor(props.tone)}`} component="span" />{t(props.children)}</>} />;
}
