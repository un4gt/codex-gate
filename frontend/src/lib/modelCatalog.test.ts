import { describe, expect, it } from '@rstest/core';
import { aggregateModels, effectivePrice, summarizeRate } from './modelCatalog';
import type { ModelPrice, ProviderModelInventory } from './types';

const inventory = (id: number, name = 'model-a', alias: string | null = null): ProviderModelInventory => ({
  id, provider_id: id, provider_name: `Provider ${id}`, provider_type: 'openai_compatible', upstream_model: name, alias,
  enabled: true, available: true, responses_via_chat_enabled: false, native_api_formats: ['chat_completions'], created_at_ms: 1, updated_at_ms: 1,
});
const price = (provider: number | null, input: string | null): ModelPrice => ({
  id: provider ?? 0, provider_id: provider, model_name: 'model-a', created_at_ms: 1, updated_at_ms: 1,
  price_data: { schema_version: 2, unit: 'usd_per_million_tokens', base: { input, output: '2', cache_read: '0', cache_write: '0' }, tiers: [] },
});

describe('model catalog and configured prices', () => {
  it('groups exact upstream names without merging aliases or case differences', () => {
    const groups = aggregateModels([inventory(1), inventory(2), inventory(3, 'Model-a'), inventory(4, 'other', 'model-a')]);
    expect(groups).toHaveLength(3);
    expect(groups.find(group => group.name === 'model-a')?.inventories.map(item => item.id)).toEqual([1, 2]);
  });
  it('uses a provider override before the global default', () => {
    const global = price(null, '2');
    const override = price(1, '3');
    expect(effectivePrice([global, override], 1, 'model-a')).toBe(override);
    expect(effectivePrice([global, override], 2, 'model-a')).toBe(global);
    expect(effectivePrice([global, override], 1, 'alias-a')).toBeNull();
  });
  it('compares decimal prices numerically and preserves explicit free rates', () => {
    expect(summarizeRate([inventory(1), inventory(2)], [price(null, '0.00'), price(1, '0')], 'input'))
      .toEqual({ value: '0', multiple: false, missing: 'none' });
    expect(summarizeRate([inventory(1), inventory(2)], [price(null, '0.100000000000000001'), price(1, '0.100000000000000002')], 'input').multiple).toBe(true);
  });
  it('distinguishes varying prices, partial coverage, and no configured rate', () => {
    expect(summarizeRate([inventory(1), inventory(2), inventory(3)], [price(1, '2'), price(2, '3')], 'input'))
      .toEqual({ value: '2', multiple: true, missing: 'some' });
    expect(summarizeRate([inventory(1)], [price(1, null)], 'input'))
      .toEqual({ value: null, multiple: false, missing: 'all' });
  });
});
