import { describe, expect, it } from '@rstest/core';
import { formatRequestPath, formatRequestType, REQUEST_TYPE_OPTIONS } from '@/lib/format';

describe('request type formatting', () => {
  it('displays API formats as their request endpoints', () => {
    expect(REQUEST_TYPE_OPTIONS).toEqual([
      { value: 'chat_completions', endpoint: 'v1/chat/completions' },
      { value: 'responses', endpoint: 'v1/responses' },
    ]);
    expect(formatRequestType('chat_completions')).toBe('v1/chat/completions');
    expect(formatRequestType('responses')).toBe('v1/responses');
  });

  it('uses a placeholder for missing or unknown API formats', () => {
    expect(formatRequestType(undefined)).toBe('—');
    expect(formatRequestType(null)).toBe('—');
    expect(formatRequestType('unknown')).toBe('—');
  });

  it('formats converted requests from upstream endpoint to client endpoint', () => {
    expect(formatRequestPath('responses', 'chat_completions'))
      .toBe('v1/chat/completions → v1/responses');
    expect(formatRequestPath('responses', 'responses')).toBe('v1/responses');
  });
});
