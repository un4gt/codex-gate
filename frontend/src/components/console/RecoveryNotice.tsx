import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import { useI18n } from '@/lib/i18n';

export function RecoveryNotice({ until, message }: { until?: number | null; message?: string | null }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    if (until <= Date.now()) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  if (!until && !message) return null;
  return <Alert severity="warning" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    {until ? <Typography variant="body2">{until > now
      ? t('冷却中，约 {{seconds}} 秒后允许恢复探测。', { seconds: Math.ceil((until - now) / 1000) })
      : t('冷却已结束，下次请求将进行恢复探测。')}</Typography> : null}
    {message ? <Typography variant="body2">{t('最近失败：{{message}}', { message })}</Typography> : null}
  </Alert>;
}
