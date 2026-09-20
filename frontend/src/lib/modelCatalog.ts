import Decimal from 'decimal.js-light';
import type { ModelPrice, ProviderModelInventory } from './types';

export interface ModelSummary {
  name: string;
  inventories: ProviderModelInventory[];
}

export function aggregateModels(models: ProviderModelInventory[]): ModelSummary[] {
  const groups = new Map<string, ProviderModelInventory[]>();
  for (const model of models) {
    const entries = groups.get(model.upstream_model);
    if (entries) entries.push(model);
    else groups.set(model.upstream_model, [model]);
  }
  return Array.from(groups, ([name, inventories]) => ({ name, inventories }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function effectivePrice(prices: ModelPrice[], providerId: number, model: string): ModelPrice | null {
  return prices.find(price => price.model_name === model && price.provider_id === providerId)
    ?? prices.find(price => price.model_name === model && price.provider_id === null)
    ?? null;
}

export function summarizeRate(models: ProviderModelInventory[], prices: ModelPrice[], kind: 'input' | 'output') {
  const rates = models.map(model => effectivePrice(prices, model.provider_id, model.upstream_model)?.price_data.base[kind] ?? null);
  const known = rates.filter((rate): rate is string => rate !== null);
  if (known.length === 0) return { value: null, multiple: false, missing: 'all' as const };
  const first = new Decimal(known[0]);
  return {
    value: first.toString(),
    multiple: known.some(rate => !first.equals(new Decimal(rate))),
    missing: known.length < rates.length ? 'some' as const : 'none' as const,
  };
}
