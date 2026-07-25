import { describe, expect, it } from '@rstest/core';
import { sanitizeColumnWidths } from '@/components/console/ResizableTable';

const definitions = [
  { id: 'time', defaultWidth: 160, minWidth: 112, maxWidth: 320 },
  { id: 'usage', defaultWidth: 360, minWidth: 280, maxWidth: 640 },
] as const;

describe('resizable table widths', () => {
  it('uses defaults when no saved width exists', () => {
    expect(sanitizeColumnWidths(definitions, {})).toEqual({ time: 160, usage: 360 });
  });

  it('clamps persisted widths to each column bounds', () => {
    expect(sanitizeColumnWidths(definitions, { time: 40, usage: 900 }))
      .toEqual({ time: 112, usage: 640 });
  });

  it('ignores non-finite persisted widths', () => {
    expect(sanitizeColumnWidths(definitions, { time: Number.NaN }))
      .toEqual({ time: 160, usage: 360 });
  });
});
