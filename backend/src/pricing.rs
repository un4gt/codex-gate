use std::str::FromStr;

use rust_decimal::Decimal;
use serde_json::{Map, Value};

use crate::types::Usage;

const TOKENS_PER_MILLION: i64 = 1_000_000;
pub const PRICE_SCHEMA_VERSION: u64 = 2;
pub const PRICE_UNIT: &str = "usd_per_million_tokens";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PriceRates {
    pub input: Option<Decimal>,
    pub output: Option<Decimal>,
    pub cache_read: Option<Decimal>,
    pub cache_write: Option<Decimal>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextPriceTier {
    pub over_total_input_tokens: i64,
    pub rates: PriceRates,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PriceCard {
    pub base: PriceRates,
    pub tiers: Vec<ContextPriceTier>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceVersion {
    pub id: i64,
    pub card: PriceCard,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PricedCost {
    pub input_usd: Decimal,
    pub output_usd: Decimal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PricingStatus {
    Priced,
    Unpriced,
    UsageMissing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PricingEvaluation {
    pub tier_index: Option<i32>,
    pub cost: Option<PricedCost>,
    pub status: PricingStatus,
}

impl PricingEvaluation {
    pub const fn usage_missing() -> Self {
        Self {
            tier_index: None,
            cost: None,
            status: PricingStatus::UsageMissing,
        }
    }
}

impl PriceCard {
    pub fn from_json(value: &Value) -> Result<Self, String> {
        if value.get("schema_version").is_some() || value.get("base").is_some() {
            Self::from_v2_json(value)
        } else {
            Self::from_legacy_json(value)
        }
    }

    fn from_v2_json(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "price_data must be an object".to_string())?;
        let schema_version = object
            .get("schema_version")
            .and_then(Value::as_u64)
            .ok_or_else(|| "schema_version must be 2".to_string())?;
        if schema_version != PRICE_SCHEMA_VERSION {
            return Err(format!(
                "unsupported price schema_version: {schema_version}"
            ));
        }
        if object.get("unit").and_then(Value::as_str) != Some(PRICE_UNIT) {
            return Err(format!("unit must be {PRICE_UNIT}"));
        }

        let base = parse_complete_rates(
            object
                .get("base")
                .ok_or_else(|| "base is required".to_string())?,
            "base",
        )?;
        let tier_values = object
            .get("tiers")
            .ok_or_else(|| "tiers is required".to_string())?
            .as_array()
            .ok_or_else(|| "tiers must be an array".to_string())?;

        let mut tiers = Vec::with_capacity(tier_values.len());
        let mut previous_threshold = 0_i64;
        for (index, tier_value) in tier_values.iter().enumerate() {
            let tier = tier_value
                .as_object()
                .ok_or_else(|| format!("tiers[{index}] must be an object"))?;
            let threshold = tier
                .get("over_total_input_tokens")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    format!("tiers[{index}].over_total_input_tokens must be an integer")
                })?;
            if threshold <= 0 {
                return Err(format!(
                    "tiers[{index}].over_total_input_tokens must be greater than 0"
                ));
            }
            if threshold <= previous_threshold {
                return Err("tier thresholds must be unique and strictly increasing".to_string());
            }
            previous_threshold = threshold;
            let rates = parse_complete_rates(
                tier.get("rates")
                    .ok_or_else(|| format!("tiers[{index}].rates is required"))?,
                &format!("tiers[{index}].rates"),
            )?;
            tiers.push(ContextPriceTier {
                over_total_input_tokens: threshold,
                rates,
            });
        }

        Ok(Self { base, tiers })
    }

    fn from_legacy_json(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "price_data must be an object".to_string())?;
        let cache_write = if object.contains_key("cache_creation_input_token_cost") {
            parse_optional_rate(
                object.get("cache_creation_input_token_cost"),
                "cache_creation_input_token_cost",
            )?
        } else {
            parse_optional_rate(
                object.get("cache_creation_input_token_cost_above_1hr"),
                "cache_creation_input_token_cost_above_1hr",
            )?
        };
        let base = PriceRates {
            input: parse_optional_rate(object.get("input_cost_per_token"), "input_cost_per_token")?,
            output: parse_optional_rate(
                object.get("output_cost_per_token"),
                "output_cost_per_token",
            )?,
            cache_read: parse_optional_rate(
                object.get("cache_read_input_token_cost"),
                "cache_read_input_token_cost",
            )?,
            cache_write,
        };
        if base == PriceRates::default() {
            return Err("price_data must contain at least one price rate".to_string());
        }
        Ok(Self {
            base,
            tiers: Vec::new(),
        })
    }

    pub fn to_json(&self) -> Value {
        let tiers = self
            .tiers
            .iter()
            .map(|tier| {
                serde_json::json!({
                    "over_total_input_tokens": tier.over_total_input_tokens,
                    "rates": rates_to_json(tier.rates),
                })
            })
            .collect::<Vec<_>>();
        serde_json::json!({
            "schema_version": PRICE_SCHEMA_VERSION,
            "unit": PRICE_UNIT,
            "base": rates_to_json(self.base),
            "tiers": tiers,
        })
    }

    pub fn tier_index_for_usage(&self, usage: &Usage) -> i32 {
        let total_input_tokens = total_input_tokens(usage);
        self.tiers
            .iter()
            .rposition(|tier| total_input_tokens > tier.over_total_input_tokens)
            .map(|index| index as i32 + 1)
            .unwrap_or(0)
    }

    pub fn rates_for_tier(&self, tier_index: i32) -> Option<PriceRates> {
        match tier_index {
            0 => Some(self.base),
            value if value > 0 => self.tiers.get(value as usize - 1).map(|tier| tier.rates),
            _ => None,
        }
    }

    pub fn cost_for_usage(&self, usage: &Usage, tier_index: i32) -> Option<PricedCost> {
        let rates = self.rates_for_tier(tier_index)?;
        let input_usd = component_cost(usage.input_tokens, rates.input)?
            + component_cost(usage.cache_read_input_tokens, rates.cache_read)?
            + component_cost(usage.cache_creation_input_tokens, rates.cache_write)?;
        let output_usd = component_cost(usage.output_tokens, rates.output)?;
        Some(PricedCost {
            input_usd,
            output_usd,
        })
    }
}

pub fn evaluate_price(
    usage: &Usage,
    usage_observed: bool,
    price: Option<&PriceVersion>,
) -> PricingEvaluation {
    if !usage_observed {
        return PricingEvaluation::usage_missing();
    }
    let Some(price) = price else {
        return PricingEvaluation {
            tier_index: None,
            cost: None,
            status: PricingStatus::Unpriced,
        };
    };
    let tier_index = price.card.tier_index_for_usage(usage);
    let cost = price.card.cost_for_usage(usage, tier_index);
    PricingEvaluation {
        tier_index: Some(tier_index),
        cost,
        status: if cost.is_some() {
            PricingStatus::Priced
        } else {
            PricingStatus::Unpriced
        },
    }
}

pub fn total_input_tokens(usage: &Usage) -> i64 {
    usage
        .input_tokens
        .max(0)
        .saturating_add(usage.cache_read_input_tokens.max(0))
        .saturating_add(usage.cache_creation_input_tokens.max(0))
}

fn component_cost(tokens: i64, rate: Option<Decimal>) -> Option<Decimal> {
    let tokens = tokens.max(0);
    if tokens == 0 {
        return Some(Decimal::ZERO);
    }
    rate.map(|value| Decimal::from(tokens) * value / Decimal::from(TOKENS_PER_MILLION))
}

fn parse_complete_rates(value: &Value, path: &str) -> Result<PriceRates, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{path} must be an object"))?;
    Ok(PriceRates {
        input: parse_required_rate(object, "input", path)?,
        output: parse_required_rate(object, "output", path)?,
        cache_read: parse_required_rate(object, "cache_read", path)?,
        cache_write: parse_required_rate(object, "cache_write", path)?,
    })
}

fn parse_required_rate(
    object: &Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<Option<Decimal>, String> {
    let value = object
        .get(key)
        .ok_or_else(|| format!("{path}.{key} is required"))?;
    parse_optional_rate(Some(value), &format!("{path}.{key}"))
}

fn parse_optional_rate(value: Option<&Value>, path: &str) -> Result<Option<Decimal>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let parsed = match value {
        Value::String(value) => Decimal::from_str(value),
        Value::Number(value) => Decimal::from_str(&value.to_string()),
        _ => return Err(format!("{path} must be a decimal string, number, or null")),
    }
    .map_err(|_| format!("{path} must be a valid decimal"))?;
    if parsed.is_sign_negative() {
        return Err(format!("{path} must be greater than or equal to 0"));
    }
    Ok(Some(parsed))
}

fn rates_to_json(rates: PriceRates) -> Value {
    serde_json::json!({
        "input": rate_to_json(rates.input),
        "output": rate_to_json(rates.output),
        "cache_read": rate_to_json(rates.cache_read),
        "cache_write": rate_to_json(rates.cache_write),
    })
}

fn rate_to_json(rate: Option<Decimal>) -> Value {
    rate.map(|value| Value::String(value.normalize().to_string()))
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use rust_decimal::Decimal;
    use serde_json::json;

    use super::{PriceCard, PricingStatus, evaluate_price};
    use crate::pricing::PriceVersion;
    use crate::types::Usage;

    fn usage(input: i64, output: i64, cache_read: i64, cache_write: i64) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cache_read,
            cache_creation_input_tokens: cache_write,
            reasoning_output_tokens: 0,
        }
    }

    fn tiered_card() -> PriceCard {
        PriceCard::from_json(&json!({
            "schema_version": 2,
            "unit": "usd_per_million_tokens",
            "base": {
                "input": "2.5",
                "output": "15",
                "cache_read": "0.25",
                "cache_write": "3.125"
            },
            "tiers": [{
                "over_total_input_tokens": 272000,
                "rates": {
                    "input": "5",
                    "output": "22.5",
                    "cache_read": "0.5",
                    "cache_write": "6.25"
                }
            }]
        }))
        .expect("tiered price card")
    }

    #[test]
    fn legacy_price_should_normalize_to_v2_card() {
        let card = PriceCard::from_json(&json!({
            "input_cost_per_token": "1",
            "output_cost_per_token": "2",
            "cache_read_input_token_cost": "0.25",
            "cache_creation_input_token_cost": "0.5"
        }))
        .expect("legacy price card");

        assert_eq!(card.to_json()["schema_version"], json!(2));
    }

    #[test]
    fn legacy_cache_write_should_not_fallback_when_primary_rate_is_explicitly_null() {
        let card = PriceCard::from_json(&json!({
            "input_cost_per_token": "1",
            "cache_creation_input_token_cost": null,
            "cache_creation_input_token_cost_above_1hr": "9"
        }))
        .expect("legacy price card");

        assert_eq!(card.base.cache_write, None);
    }

    #[test]
    fn tier_selection_should_keep_base_at_exact_threshold() {
        let card = tiered_card();

        assert_eq!(card.tier_index_for_usage(&usage(200_000, 1, 72_000, 0)), 0);
    }

    #[test]
    fn tier_selection_should_include_cached_input_above_threshold() {
        let card = tiered_card();

        assert_eq!(card.tier_index_for_usage(&usage(200_000, 1, 72_001, 0)), 1);
    }

    #[test]
    fn tier_cost_should_apply_selected_rates_to_full_request() {
        let card = tiered_card();
        let cost = card
            .cost_for_usage(&usage(200_000, 1_000, 73_000, 0), 1)
            .expect("priced cost");

        assert_eq!(cost.input_usd + cost.output_usd, Decimal::new(1_059, 3));
    }

    #[test]
    fn missing_rate_should_mark_nonzero_component_unpriced() {
        let card = PriceCard::from_json(&json!({
            "schema_version": 2,
            "unit": "usd_per_million_tokens",
            "base": {
                "input": "1",
                "output": "2",
                "cache_read": null,
                "cache_write": null
            },
            "tiers": []
        }))
        .expect("partial card");
        let price = PriceVersion { id: 1, card };
        let evaluation = evaluate_price(&usage(10, 2, 1, 0), true, Some(&price));

        assert_eq!(evaluation.status, PricingStatus::Unpriced);
    }

    #[test]
    fn explicit_zero_rate_should_still_be_priceable() {
        let card = PriceCard::from_json(&json!({
            "schema_version": 2,
            "unit": "usd_per_million_tokens",
            "base": {
                "input": "0",
                "output": "0",
                "cache_read": "0",
                "cache_write": "0"
            },
            "tiers": []
        }))
        .expect("free card");
        let price = PriceVersion { id: 1, card };
        let evaluation = evaluate_price(&usage(10, 2, 1, 1), true, Some(&price));

        assert_eq!(evaluation.status, PricingStatus::Priced);
    }

    #[test]
    fn v2_price_should_reject_missing_rate_keys() {
        let result = PriceCard::from_json(&json!({
            "schema_version": 2,
            "unit": "usd_per_million_tokens",
            "base": {
                "input": "1",
                "output": "2",
                "cache_read": null
            },
            "tiers": []
        }));

        assert_eq!(result.unwrap_err(), "base.cache_write is required");
    }

    #[test]
    fn v2_price_should_reject_negative_and_invalid_rates() {
        let negative = PriceCard::from_json(&json!({
            "schema_version": 2,
            "unit": "usd_per_million_tokens",
            "base": {
                "input": "-1",
                "output": "2",
                "cache_read": null,
                "cache_write": null
            },
            "tiers": []
        }));
        let invalid = PriceCard::from_json(&json!({
            "schema_version": 2,
            "unit": "usd_per_million_tokens",
            "base": {
                "input": "not-a-decimal",
                "output": "2",
                "cache_read": null,
                "cache_write": null
            },
            "tiers": []
        }));

        assert!(negative.is_err());
        assert!(invalid.is_err());
    }

    #[test]
    fn v2_price_should_reject_duplicate_or_descending_thresholds() {
        let result = PriceCard::from_json(&json!({
            "schema_version": 2,
            "unit": "usd_per_million_tokens",
            "base": {
                "input": "1",
                "output": "2",
                "cache_read": null,
                "cache_write": null
            },
            "tiers": [
                {
                    "over_total_input_tokens": 272000,
                    "rates": { "input": "2", "output": "3", "cache_read": null, "cache_write": null }
                },
                {
                    "over_total_input_tokens": 272000,
                    "rates": { "input": "4", "output": "5", "cache_read": null, "cache_write": null }
                }
            ]
        }));

        assert_eq!(
            result.unwrap_err(),
            "tier thresholds must be unique and strictly increasing"
        );
    }

    #[test]
    fn tier_selection_should_choose_highest_matching_tier() {
        let card = PriceCard::from_json(&json!({
            "schema_version": 2,
            "unit": "usd_per_million_tokens",
            "base": { "input": "1", "output": "2", "cache_read": null, "cache_write": null },
            "tiers": [
                {
                    "over_total_input_tokens": 100,
                    "rates": { "input": "2", "output": "3", "cache_read": null, "cache_write": null }
                },
                {
                    "over_total_input_tokens": 200,
                    "rates": { "input": "4", "output": "5", "cache_read": null, "cache_write": null }
                }
            ]
        }))
        .expect("multiple pricing tiers");

        assert_eq!(card.tier_index_for_usage(&usage(201, 0, 0, 0)), 2);
    }
}
