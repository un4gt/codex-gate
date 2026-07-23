import { describe, expect, it } from '@rstest/core';
import { DEFAULT_LOG_COLUMNS, sanitizeLogColumns } from '@/components/LogsPage';

describe('log column preferences', () => {
  it('preserves the exact saved order while filtering unknown and duplicate columns', () => {
    expect(sanitizeLogColumns(['provider', 'time', 'future_column', 'provider']))
      .toEqual(['provider', 'time']);
  });

  it('does not add newly available columns to an existing preference', () => {
    expect(sanitizeLogColumns(['time', 'model'])).toEqual(['time', 'model']);
  });

  it('falls back to the seven defaults when no valid saved columns remain', () => {
    expect(sanitizeLogColumns(['future_column'])).toEqual(DEFAULT_LOG_COLUMNS);
    expect(DEFAULT_LOG_COLUMNS).toHaveLength(7);
  });
});
