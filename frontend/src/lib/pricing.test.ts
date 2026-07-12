import { describe, expect, it } from '@rstest/core';
import type { PriceCardV2, StatsOverviewResponse } from '@/lib/types';
import {
  calculateOverviewPricing,
  calculateRequestPricing,
  calculateUsageCost,
  selectTierIndex,
} from '@/lib/pricing';

const card: PriceCardV2 = {
  schema_version: 2,
  unit: 'usd_per_million_tokens',
  base: { input: '2.5', output: '15', cache_read: '0.25', cache_write: '3.125' },
  tiers: [{
    over_total_input_tokens: 272_000,
    rates: { input: '5', output: '22.5', cache_read: '0.5', cache_write: '6.25' },
  }],
};

describe('context-tier pricing', () => {
  it('keeps the base tier at the exact threshold and selects the tier above it', () => {
    expect(selectTierIndex(card, {
      input_tokens: 272_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })).toBe(0);
    expect(selectTierIndex(card, {
      input_tokens: 272_001,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })).toBe(1);
  });

  it('includes cached input when selecting the tier', () => {
    expect(selectTierIndex(card, {
      input_tokens: 200_000,
      output_tokens: 0,
      cache_read_input_tokens: 72_001,
      cache_creation_input_tokens: 0,
    })).toBe(1);
  });

  it('applies the selected tier rates to the whole request', () => {
    const result = calculateUsageCost({
      input_tokens: 300_000,
      output_tokens: 10_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }, card, 1);
    expect(result.status).toBe('priced');
    if (result.status === 'priced') expect(result.totalUsd.toString()).toBe('1.725');
  });

  it('distinguishes a missing rate from an explicit zero rate', () => {
    const missing = calculateUsageCost({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 0,
    }, { ...card, base: { ...card.base, cache_read: null }, tiers: [] }, 0);
    expect(missing).toEqual({ status: 'unpriced', reason: 'rate_missing' });

    const free = calculateUsageCost({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 0,
    }, { ...card, base: { ...card.base, cache_read: '0' }, tiers: [] }, 0);
    expect(free.status).toBe('priced');
    if (free.status === 'priced') expect(free.totalUsd.toString()).toBe('0');
  });

  it('marks requests without observed usage as unpriced without guessing', () => {
    expect(calculateRequestPricing({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }, false, { price_version_id: 7, tier_index: null, card })).toEqual({
      status: 'unpriced',
      reason: 'usage_missing',
    });
  });

  it('accumulates overview costs exactly and reports partial coverage', () => {
    const overview = {
      kpis: { requests: 3 },
      token_usage: { usage_observed_requests: 2 },
      pricing: {
        versions: [{ id: 7, card }],
        usage_groups: [
          {
            price_version_id: 7,
            tier_index: 0,
            request_count: 1,
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          {
            price_version_id: null,
            tier_index: null,
            request_count: 1,
            input_tokens: 2,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      },
    } as StatsOverviewResponse;
    const result = calculateOverviewPricing(overview);
    expect(result.totalUsd.toString()).toBe('0.0000175');
    expect(result.priceableRequests).toBe(1);
    expect(result.unpricedRequests).toBe(1);
    expect(result.usageMissingRequests).toBe(1);
    expect(result.tokenCoveragePercent.toString()).toBe('50');
  });
});
