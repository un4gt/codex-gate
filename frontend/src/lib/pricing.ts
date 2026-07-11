import Decimal from 'decimal.js-light';
import type { PriceCardV2, PriceRates, RequestPricing, StatsOverviewResponse } from '@/lib/types';

const TOKENS_PER_MILLION = new Decimal(1_000_000);

export interface PricingUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export type UnpricedReason =
  | 'usage_missing'
  | 'price_version_missing'
  | 'price_card_missing'
  | 'tier_missing'
  | 'rate_missing';

export type RequestPricingResult =
  | {
      status: 'priced';
      tierIndex: number;
      inputUsd: Decimal;
      outputUsd: Decimal;
      totalUsd: Decimal;
    }
  | {
      status: 'unpriced';
      reason: UnpricedReason;
    };

export interface OverviewPricingResult {
  totalUsd: Decimal;
  priceableRequests: number;
  unpricedRequests: number;
  usageMissingRequests: number;
  priceableTokens: number;
  unpricedTokens: number;
  observedTokens: number;
  tokenCoveragePercent: Decimal;
}

export function totalInputTokens(usage: PricingUsage): number {
  return Math.max(usage.input_tokens, 0)
    + Math.max(usage.cache_read_input_tokens, 0)
    + Math.max(usage.cache_creation_input_tokens, 0);
}

export function selectTierIndex(card: PriceCardV2, usage: PricingUsage): number {
  const totalInput = totalInputTokens(usage);
  let selected = 0;
  card.tiers.forEach((tier, index) => {
    if (totalInput > tier.over_total_input_tokens) selected = index + 1;
  });
  return selected;
}

export function ratesForTier(card: PriceCardV2, tierIndex: number): PriceRates | null {
  if (tierIndex === 0) return card.base;
  return card.tiers[tierIndex - 1]?.rates ?? null;
}

function componentCost(tokens: number, rate: string | null): Decimal | null {
  const safeTokens = Math.max(tokens, 0);
  if (safeTokens === 0) return new Decimal(0);
  if (rate === null) return null;
  try {
    return new Decimal(safeTokens).times(new Decimal(rate)).div(TOKENS_PER_MILLION);
  } catch {
    return null;
  }
}

export function calculateUsageCost(
  usage: PricingUsage,
  card: PriceCardV2,
  tierIndex: number,
): RequestPricingResult {
  const rates = ratesForTier(card, tierIndex);
  if (!rates) return { status: 'unpriced', reason: 'tier_missing' };

  const input = componentCost(usage.input_tokens, rates.input);
  const cacheRead = componentCost(usage.cache_read_input_tokens, rates.cache_read);
  const cacheWrite = componentCost(usage.cache_creation_input_tokens, rates.cache_write);
  const output = componentCost(usage.output_tokens, rates.output);
  if (input === null || cacheRead === null || cacheWrite === null || output === null) {
    return { status: 'unpriced', reason: 'rate_missing' };
  }
  const inputUsd = input.plus(cacheRead).plus(cacheWrite);
  return {
    status: 'priced',
    tierIndex,
    inputUsd,
    outputUsd: output,
    totalUsd: inputUsd.plus(output),
  };
}

export function calculateRequestPricing(
  usage: PricingUsage,
  usageObserved: boolean,
  pricing: RequestPricing | null,
): RequestPricingResult {
  if (!usageObserved) return { status: 'unpriced', reason: 'usage_missing' };
  if (!pricing) return { status: 'unpriced', reason: 'price_version_missing' };
  if (!pricing.card) return { status: 'unpriced', reason: 'price_card_missing' };
  if (pricing.tier_index === null) return { status: 'unpriced', reason: 'tier_missing' };
  return calculateUsageCost(usage, pricing.card, pricing.tier_index);
}

export function calculateOverviewPricing(overview: StatsOverviewResponse): OverviewPricingResult {
  const cards = new Map(overview.pricing.versions.map((version) => [version.id, version.card]));
  let totalUsd = new Decimal(0);
  let priceableRequests = 0;
  let unpricedRequests = 0;
  let priceableTokens = 0;
  let unpricedTokens = 0;

  overview.pricing.usage_groups.forEach((group) => {
    const usage: PricingUsage = group;
    const tokens = totalUsageTokens(usage);
    const card = group.price_version_id === null ? null : cards.get(group.price_version_id) ?? null;
    const result = card === null || group.tier_index === null
      ? { status: 'unpriced' as const }
      : calculateUsageCost(usage, card, group.tier_index);
    if (result.status === 'priced') {
      totalUsd = totalUsd.plus(result.totalUsd);
      priceableRequests += group.request_count;
      priceableTokens += tokens;
    } else {
      unpricedRequests += group.request_count;
      unpricedTokens += tokens;
    }
  });

  const observedTokens = priceableTokens + unpricedTokens;
  const tokenCoveragePercent = observedTokens > 0
    ? new Decimal(priceableTokens).times(100).div(observedTokens)
    : new Decimal(0);
  return {
    totalUsd,
    priceableRequests,
    unpricedRequests,
    usageMissingRequests: Math.max(
      overview.kpis.requests - overview.token_usage.usage_observed_requests,
      0,
    ),
    priceableTokens,
    unpricedTokens,
    observedTokens,
    tokenCoveragePercent,
  };
}

export function totalUsageTokens(usage: PricingUsage): number {
  return Math.max(usage.input_tokens, 0)
    + Math.max(usage.output_tokens, 0)
    + Math.max(usage.cache_read_input_tokens, 0)
    + Math.max(usage.cache_creation_input_tokens, 0);
}

export function formatUsd(value: Decimal): string {
  const absolute = value.abs();
  const decimals = absolute.greaterThanOrEqualTo(1)
    ? 2
    : absolute.greaterThanOrEqualTo('0.01')
      ? 4
      : 6;
  return `$${value.toDecimalPlaces(decimals).toFixed(decimals)}`;
}

export function describeUnpricedReason(reason: UnpricedReason): string {
  switch (reason) {
    case 'usage_missing':
      return '未采集到用量';
    case 'price_version_missing':
      return '请求未绑定价格版本';
    case 'price_card_missing':
      return '价格版本不可用';
    case 'tier_missing':
      return '请求未记录价格层级';
    case 'rate_missing':
      return '非零用量缺少对应单价';
  }
}
