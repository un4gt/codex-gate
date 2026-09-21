import { afterEach, describe, expect, it, rs } from '@rstest/core';
import { loadProviderWorkspace, subscribeAuthenticationFailures, syncProviderModels } from './api';

const settings = { apiBase: 'http://gateway.test', adminToken: 'synthetic-token' };
afterEach(() => { rs.unstubAllGlobals(); });

describe('provider API error handling', () => {
  it('keeps provider authentication failures separate from console authentication', async () => {
    const listener = rs.fn();
    const unsubscribe = subscribeAuthenticationFailures(listener);
    try {
      rs.stubGlobal('fetch', rs.fn().mockResolvedValue(new Response('invalid upstream key', {
        status: 401, headers: { 'x-little-gate-upstream-error': '1' },
      })));
      await expect(syncProviderModels(settings, 7)).rejects.toThrow('invalid upstream key');
      expect(listener).not.toHaveBeenCalled();
      rs.stubGlobal('fetch', rs.fn().mockResolvedValue(new Response('invalid token', { status: 401 })));
      await expect(syncProviderModels(settings, 7)).rejects.toThrow('invalid token');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('reports a failed connection read instead of showing an empty configuration', async () => {
    rs.stubGlobal('fetch', rs.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/endpoints')) return new Response('database unavailable', { status: 503 });
      return new Response(JSON.stringify(url.endsWith('/providers') ? [{ id: 7 }] : []), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await expect(loadProviderWorkspace(settings)).rejects.toThrow('database unavailable');
  });
});
