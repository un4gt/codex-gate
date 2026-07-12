import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { t, useI18n, type Locale } from '@/lib/i18n';

const LOCALES: Locale[] = ['zh', 'en'];

export function LocaleSwitch(props: { className?: string }) {
  const { locale, setLocale, isSwitching } = useI18n();

  return (
    <Box className={`flex items-center rounded-none border border-border bg-background p-1 ${props.className ?? ''}`} role="group" aria-label={t('切换语言')}>
      {LOCALES.map((item) => (
        <Button
          key={item}
          type="button"
          size="sm"
          variant={locale === item ? 'default' : 'ghost'}
          className="h-7 px-3 font-mono text-[0.72rem] tracking-[0.08em]"
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
