import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { t, useI18n, type Locale } from '@/lib/i18n';

const LOCALES: Locale[] = ['zh', 'en'];

export function LocaleSwitch(props: { class?: string }) {
  const { locale, setLocale, isSwitching } = useI18n();

  return (
    <div class={cn('flex items-center rounded-none border border-border bg-background p-1', props.class)} role="group" aria-label={t('切换语言')}>
      {LOCALES.map((item) => (
        <Button
          type="button"
          size="sm"
          variant={locale() === item ? 'default' : 'ghost'}
          class="h-7 px-3 text-[0.65rem] tracking-widest"
          onClick={() => setLocale(item)}
          disabled={isSwitching() && locale() !== item}
          title={item === 'zh' ? t('切换到中文') : t('Switch to English')}
        >
          {item === 'zh' ? 'ZH' : 'EN'}
        </Button>
      ))}
    </div>
  );
}
