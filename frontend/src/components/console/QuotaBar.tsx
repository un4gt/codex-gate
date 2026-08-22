import Box from '@mui/material/Box';
import { t } from '@/lib/i18n';

export type QuotaTone = 'healthy' | 'watch' | 'critical';

/** 剩余量越低越危险：>50% 健康，20–50% 警戒，<20% 危险。 */
export function quotaTone(remainingPercent: number): QuotaTone {
  if (remainingPercent >= 50) return 'healthy';
  if (remainingPercent >= 20) return 'watch';
  return 'critical';
}

const TONE_FILL: Record<QuotaTone, string> = {
  healthy: 'var(--success)',
  watch: 'var(--warning)',
  critical: 'var(--danger)',
};

const TONE_TEXT: Record<QuotaTone, string> = {
  healthy: 'text-foreground',
  watch: 'text-warning',
  critical: 'text-danger',
};

interface QuotaBarProps {
  /** 0–100，调用方无需预先裁剪。 */
  remainingPercent: number;
  label: string;
  /** 紧凑模式用于折叠行，去掉文字只留轨道。 */
  dense?: boolean;
}

/**
 * 额度条。颜色随剩余量变化，且耗尽时保留一段可见残条——
 * 纯宽度表达会让 0% 与「未加载」在视觉上无法区分。
 */
export function QuotaBar(props: QuotaBarProps) {
  const remaining = Math.max(0, Math.min(100, props.remainingPercent));
  const tone = quotaTone(remaining);
  return (
    <Box
      className={`w-full overflow-hidden bg-muted ${props.dense ? 'h-1' : 'h-1.5'}`}
      style={{ borderRadius: 'var(--radius-sm)' }}
      role="progressbar"
      aria-label={props.label}
      aria-valuenow={Math.round(remaining)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={t('剩余 {{percent}}%', { percent: Math.round(remaining) })}
    >
      <Box
        className="h-full transition-[width,background-color] duration-300 ease-out"
        style={{
          width: `${Math.max(remaining, 3)}%`,
          backgroundColor: TONE_FILL[tone],
          borderRadius: 'var(--radius-sm)',
        }}
      />
    </Box>
  );
}

export function quotaTextClass(remainingPercent: number) {
  return TONE_TEXT[quotaTone(Math.max(0, Math.min(100, remainingPercent)))];
}
