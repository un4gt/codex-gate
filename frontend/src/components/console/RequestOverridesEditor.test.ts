import { describe, expect, it } from '@rstest/core';

import {
  createRequestOverridesDraft,
  parseRequestOverridesDraft,
} from '@/components/console/RequestOverridesEditor';

describe('request override drafts', () => {
  it('round-trips header and JSON body rules', () => {
    const draft = createRequestOverridesDraft({
      headers: [{
        scope: 'all',
        operation: 'set',
        name: 'x-codex-window-id',
        value: '{{request_id}}',
      }],
      body: [{
        scope: 'responses',
        operation: 'set',
        path: 'client_metadata.x-codex-window-id',
        value: '{{request_id}}',
      }],
    });

    const parsed = parseRequestOverridesDraft(draft);

    expect(parsed).toEqual({
      ok: true,
      value: {
        headers: [{
          scope: 'all',
          operation: 'set',
          name: 'x-codex-window-id',
          value: '{{request_id}}',
        }],
        body: [{
          scope: 'responses',
          operation: 'set',
          path: 'client_metadata.x-codex-window-id',
          value: '{{request_id}}',
        }],
      },
    });
  });

  it('rejects gateway-managed authentication, forwarding, and connection headers', () => {
    for (const name of ['Authorization', 'X-Forwarded-For', 'Sec-WebSocket-Key']) {
      const draft = createRequestOverridesDraft({
        headers: [{
          scope: 'all',
          operation: 'set',
          name,
          value: 'blocked',
        }],
        body: [],
      });

      const parsed = parseRequestOverridesDraft(draft);

      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(name);
    }
  });

  it('rejects routing-owned body roots and invalid JSON values', () => {
    const routingDraft = createRequestOverridesDraft({
      headers: [],
      body: [{
        scope: 'responses',
        operation: 'set',
        path: 'model',
        value: 'gpt-overridden',
      }],
    });
    expect(parseRequestOverridesDraft(routingDraft).ok).toBe(false);

    const invalidJsonDraft = createRequestOverridesDraft();
    invalidJsonDraft.body.push({
      id: 'invalid-json',
      scope: 'responses',
      operation: 'set',
      path: 'client_metadata.window',
      valueText: '{',
    });
    expect(parseRequestOverridesDraft(invalidJsonDraft).ok).toBe(false);
  });
});
