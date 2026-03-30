import { Badge } from '@/components/ui/badge';

export type StatusTone = 'normal' | 'warning' | 'error' | 'disabled' | 'draft' | 'archived';

interface StatusBadgeProps {
  tone: StatusTone;
  children: string;
}

function badgeVariant(tone: StatusTone) {
  if (tone === 'normal') return 'success';
  if (tone === 'warning') return 'warning';
  if (tone === 'error') return 'destructive';
  if (tone === 'disabled' || tone === 'draft' || tone === 'archived') return 'outline';
  return 'secondary';
}

export function StatusBadge(props: StatusBadgeProps) {
  return <Badge variant={badgeVariant(props.tone)}>{props.children}</Badge>;
}
