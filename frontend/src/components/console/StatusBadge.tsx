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
  return <Badge variant={badgeVariant(props.tone)}>
      <span class={`size-1.5 rounded-full mr-2 ${props.tone === 'normal' ? 'bg-emerald-500' : props.tone === 'warning' ? 'bg-amber-500' : props.tone === 'error' ? 'bg-red-500' : 'bg-muted-foreground/50'}`} />
      {props.children}
    </Badge>;
}
