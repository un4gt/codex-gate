export const integerFormatter = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 0,
});

export const decimalFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatCompactInteger(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) {
    return `${decimalFormatter.format(value / 1_000_000_000)}B`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${decimalFormatter.format(value / 1_000_000)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${decimalFormatter.format(value / 1_000)}k`;
  }
  return integerFormatter.format(value);
}

export function formatCost(value: number): string {
  return `$${decimalFormatter.format(value)}`;
}

export function formatMs(value: number): string {
  if (value >= 1000) {
    return `${decimalFormatter.format(value / 1000)}s`;
  }
  return `${integerFormatter.format(value)}ms`;
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
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestampMs));
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
