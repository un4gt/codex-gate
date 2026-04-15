import { getIntlLocale, t } from '@/lib/i18n';

interface FormatterBundle {
  integer: Intl.NumberFormat;
  decimal: Intl.NumberFormat;
  dateTime: Intl.DateTimeFormat;
}

const formatterCache = new Map<string, FormatterBundle>();

function getFormatters() {
  const locale = getIntlLocale();
  const cached = formatterCache.get(locale);
  if (cached) return cached;

  const bundle: FormatterBundle = {
    integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    decimal: new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }),
    dateTime: new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
  };

  formatterCache.set(locale, bundle);
  return bundle;
}

export function formatCompactInteger(value: number): string {
  const { integer, decimal } = getFormatters();
  if (Math.abs(value) >= 1_000_000_000) {
    return `${decimal.format(value / 1_000_000_000)}B`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${decimal.format(value / 1_000_000)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${decimal.format(value / 1_000)}k`;
  }
  return integer.format(value);
}

export function formatCost(value: number): string {
  return `$${getFormatters().decimal.format(value)}`;
}

export function formatMs(value: number): string {
  const { decimal, integer } = getFormatters();
  if (value >= 1000) {
    return `${decimal.format(value / 1000)}s`;
  }
  return `${integer.format(value)}ms`;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}${month}${day}`;
}

export function formatDateTime(timestampMs: number): string {
  return getFormatters().dateTime.format(new Date(timestampMs));
}

export function formatDateTimeLocalInput(timestampMs: number | null | undefined): string {
  if (!timestampMs) return '';
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function parseDateTimeLocalInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const timestamp = new Date(trimmed).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseDecimal(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatModelName(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : t('未识别');
}

export function formatRequestType(value: string | null | undefined): string {
  if (value === 'responses') return t('响应请求');
  if (value === 'chat_completions') return t('对话请求');
  return '—';
}

export function formatRoutingStrategy(value: string | null | undefined): string {
  if (value === 'weighted') return t('加权');
  if (value === 'priority') return t('优先级策略');
  const trimmed = value?.trim();
  return trimmed ? trimmed : '—';
}
