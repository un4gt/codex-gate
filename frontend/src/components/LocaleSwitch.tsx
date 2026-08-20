import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { t, useI18n, type Locale } from '@/lib/i18n';

const LOCALES: Locale[] = ['zh', 'en'];

export function LocaleSwitch(props: { className?: string }) {
  const { locale, setLocale, isSwitching } = useI18n();

  return (
    <Box className={`flex items-center rounded border border-border bg-background p-0.5 ${props.className ?? ''}`} role="group" aria-label={t('切换语言')}>
      {LOCALES.map((item) => (
        <Button
          key={item}
          type="button"
          size="sm"
          variant={locale === item ? 'default' : 'ghost'}
          className="h-6 px-2.5 font-mono text-[0.6875rem] tracking-[0.08em]"
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
