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
export function StatusBadge(props: StatusBadgeProps) {
  return <Chip color={badgeColor(props.tone)} variant="outlined" label={<><Box className={`size-1.5 rounded-full mr-2 ${props.tone === 'normal' ? 'bg-emerald-500' : props.tone === 'warning' ? 'bg-amber-500' : props.tone === 'error' ? 'bg-red-500' : 'bg-muted-foreground/50'}`} component="span" />{t(props.children)}</>} />;
}
