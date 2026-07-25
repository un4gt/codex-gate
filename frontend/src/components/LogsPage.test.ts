import { describe, expect, it } from '@rstest/core';
import {
  DEFAULT_LOG_COLUMNS,
  formatRoutingProtocol,
  formatUpstreamEndpoint,
  sanitizeLogColumns,
} from '@/components/LogsPage';

describe('log column preferences', () => {
  it('preserves the exact saved order while filtering unknown and duplicate columns', () => {
    expect(sanitizeLogColumns(['provider', 'time', 'future_column', 'provider']))
      .toEqual(['provider', 'time']);
  });

  it('does not add newly available columns to an existing preference', () => {
    expect(sanitizeLogColumns(['time', 'model'])).toEqual(['time', 'model']);
  });

  it('merges legacy usage columns into one usage cell', () => {
    expect(sanitizeLogColumns(['time', 'input_tokens', 'cache_read', 'reasoning', 'model']))
      .toEqual(['time', 'total_tokens', 'model']);
  });

  it('falls back to the seven defaults when no valid saved columns remain', () => {
    expect(sanitizeLogColumns(['future_column'])).toEqual(DEFAULT_LOG_COLUMNS);
    expect(DEFAULT_LOG_COLUMNS).toHaveLength(7);
  });
});

describe('log endpoint formatting', () => {
  it('does not pretend an unresolved request reached the client endpoint upstream', () => {
    expect(formatUpstreamEndpoint(null)).toBe('—');
  });

  it('shows the resolved Chat Completions endpoint for protocol conversion', () => {
    expect(formatUpstreamEndpoint('chat_completions')).toBe('v1/chat/completions');
  });

  it('shows the concrete upstream endpoint and conversion mode in routing diagnostics', () => {
    expect(formatRoutingProtocol('chat_completions', 'responses_via_chat'))
      .toBe('v1/chat/completions · Responses → Chat');
  });
});
