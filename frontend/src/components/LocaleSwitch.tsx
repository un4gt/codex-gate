import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { useI18n, type Locale } from '@/lib/i18n';

const LOCALES: Locale[] = ['zh', 'en'];

export function LocaleSwitch(props: { className?: string }) {
  const { t, locale, setLocale, isSwitching } = useI18n();

  return (
    <Box className={`segmented-control ${props.className ?? ''}`} role="group" aria-label={t('切换语言')}>
      {LOCALES.map((item) => (
        <Button
          key={item}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={locale === item}
          className={`h-7 px-2 text-xs ${locale === item ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground'}`}
          onClick={() => setLocale(item)}
          disabled={isSwitching && locale !== item}
          title={item === 'zh' ? t('切换到中文') : t('Switch to English')}
        >
          {item === 'zh' ? 'ZH' : 'EN'}
        </Button>
      ))}
    </Box>
  );
}
