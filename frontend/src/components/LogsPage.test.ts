import { describe, expect, it } from '@rstest/core';
import {
  DEFAULT_LOG_COLUMNS,
  formatServiceTier,
  formatRoutingProtocol,
  formatUpstreamEndpoint,
  sanitizeLogColumns,
  logFiltersFromSearch,
} from '@/components/LogsPage';

describe('log links from upstream details', () => {
  it('applies linked server filters and rejects invalid IDs', () => {
    expect(logFiltersFromSearch('provider_id=7&endpoint_id=71&api_key_id=3&model=model-a'))
      .toMatchObject({providerId: '7', endpointId: '71', apiKeyId: '3', model: 'model-a'});
    expect(logFiltersFromSearch('provider_id=-1&endpoint_id=NaN&api_key_id=1.5'))
      .toMatchObject({providerId: '', endpointId: '', apiKeyId: ''});
  });
});

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

  it('falls back to the default columns when no valid saved columns remain', () => {
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

describe('actual service tier display', () => {
  it('keeps a downgrade to Standard distinct from requested Fast', () => {
    expect(formatServiceTier('default')).toBe('Standard');
    expect(formatServiceTier('fast')).toBe('Fast');
    expect(formatServiceTier('priority')).toBe('Fast');
    expect(formatServiceTier('flex')).toBe('flex');
  });
  it('does not infer a tier when the upstream omitted it', () => {
    expect(formatServiceTier(null)).toBe('未确认');
    expect(DEFAULT_LOG_COLUMNS).toContain('cost');
  });
});
