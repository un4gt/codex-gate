use std::collections::HashMap;

use crate::health::{
    CircuitState, EndpointHealthBook, UpstreamKeyHealthBook, summarize_provider_health,
};
use crate::types::{UpstreamEndpoint, UpstreamKey, UpstreamProvider};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndpointSelectorStrategy {
    Weighted,
    Latency,
}

impl EndpointSelectorStrategy {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "weighted" | "weight" | "random" => Some(Self::Weighted),
            "latency" | "lowest_latency" | "least_latency" => Some(Self::Latency),
            _ => None,
        }
    }
}

pub fn rank_provider_refs_with_health<'a>(
    items: &'a [&'a UpstreamProvider],
    keys_by_provider: &HashMap<i64, Vec<UpstreamKey>>,
    endpoints_by_provider: &HashMap<i64, Vec<UpstreamEndpoint>>,
    key_health: &UpstreamKeyHealthBook,
    endpoint_health: &EndpointHealthBook,
    now_ms: i64,
) -> Vec<&'a UpstreamProvider> {
    rank_by_priority_and_health(items, |provider| {
        let keys = keys_by_provider
            .get(&provider.id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let endpoints = endpoints_by_provider
            .get(&provider.id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let summary =
            summarize_provider_health(endpoints, keys, endpoint_health, key_health, now_ms);
        (
            provider.enabled,
            provider.priority,
            provider.weight,
            summary.state,
            summary.available,
        )
    })
}

pub fn rank_key_refs_with_health<'a>(
    items: &'a [&'a UpstreamKey],
    health: &UpstreamKeyHealthBook,
    now_ms: i64,
) -> Vec<&'a UpstreamKey> {
    rank_by_priority_and_health(items, |key| {
        let snapshot = health.snapshot(key.id, now_ms);
        (
            key.enabled,
            key.priority,
            key.weight,
            snapshot.state,
            snapshot.available,
        )
    })
}

pub fn rank_endpoint_refs_with_health<'a>(
    items: &'a [&'a UpstreamEndpoint],
    health: &EndpointHealthBook,
    strategy: EndpointSelectorStrategy,
    now_ms: i64,
) -> Vec<&'a UpstreamEndpoint> {
    let prioritized = order_by_priority_weight_refs(items, |endpoint| {
        (endpoint.enabled, endpoint.priority, endpoint.weight)
    });
    if prioritized.is_empty() {
        return Vec::new();
    }

    let mut ordered_endpoints = Vec::new();
    let mut start = 0usize;
    while start < prioritized.len() {
        let priority = prioritized[start].priority;
        let mut end = start + 1;
        while end < prioritized.len() && prioritized[end].priority == priority {
            end += 1;
        }

        let mut closed = Vec::new();
        let mut half_open = Vec::new();

        for endpoint in &prioritized[start..end] {
            let snapshot = health.snapshot(endpoint.id, now_ms);
            match snapshot.state {
                CircuitState::Closed => closed.push(*endpoint),
                CircuitState::HalfOpen if snapshot.available => half_open.push(*endpoint),
                _ => {}
            }
        }

        ordered_endpoints.extend(order_endpoints_by_strategy(
            &closed, health, strategy, now_ms,
        ));
        ordered_endpoints.extend(order_endpoints_by_strategy(
            &half_open, health, strategy, now_ms,
        ));
        start = end;
    }

    ordered_endpoints
}

fn rank_by_priority_and_health<'a, T, F>(items: &'a [&'a T], describe: F) -> Vec<&'a T>
where
    F: Fn(&T) -> (bool, i32, i32, CircuitState, bool),
{
    let prioritized = order_by_priority_weight_refs(items, |item| {
        let (enabled, priority, weight, _, _) = describe(item);
        (enabled, priority, weight)
    });
    if prioritized.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut start = 0usize;
    while start < prioritized.len() {
        let (_, priority, _, _, _) = describe(prioritized[start]);
        let mut end = start + 1;
        while end < prioritized.len() {
            let (_, next_priority, _, _, _) = describe(prioritized[end]);
            if next_priority != priority {
                break;
            }
            end += 1;
        }

        let mut closed = Vec::new();
        let mut half_open = Vec::new();
        for item in &prioritized[start..end] {
            let (_, _, weight, state, available) = describe(item);
            if !available {
                continue;
            }
            match state {
                CircuitState::Closed => closed.push((*item, weight)),
                CircuitState::HalfOpen => half_open.push((*item, weight)),
                CircuitState::Open => {}
            }
        }

        out.extend(weighted_order_pairs(closed));
        out.extend(weighted_order_pairs(half_open));
        start = end;
    }

    out
}

fn order_endpoints_by_strategy<'a>(
    items: &[&'a UpstreamEndpoint],
    health: &EndpointHealthBook,
    strategy: EndpointSelectorStrategy,
    now_ms: i64,
) -> Vec<&'a UpstreamEndpoint> {
    match strategy {
        EndpointSelectorStrategy::Weighted => {
            weighted_order_refs(items, |endpoint| endpoint.weight)
        }
        EndpointSelectorStrategy::Latency => latency_order_refs(items, health, now_ms),
    }
}

fn latency_order_refs<'a>(
    items: &[&'a UpstreamEndpoint],
    health: &EndpointHealthBook,
    now_ms: i64,
) -> Vec<&'a UpstreamEndpoint> {
    let mut ordered = items.to_vec();
    ordered.sort_by(|left, right| {
        let left_snapshot = health.snapshot(left.id, now_ms);
        let right_snapshot = health.snapshot(right.id, now_ms);

        left_snapshot
            .latency_ewma_ms
            .unwrap_or(i64::MAX)
            .cmp(&right_snapshot.latency_ewma_ms.unwrap_or(i64::MAX))
            .then_with(|| right.weight.cmp(&left.weight))
            .then_with(|| left.id.cmp(&right.id))
    });
    ordered
}

fn order_by_priority_weight_refs<'a, T, F>(items: &'a [&'a T], f: F) -> Vec<&'a T>
where
    F: Fn(&T) -> (bool, i32, i32) + Copy,
{
    let mut enabled: Vec<(&'a T, i32, i32)> = items
        .iter()
        .filter_map(|item| {
            let (is_enabled, priority, weight) = f(item);
            if is_enabled {
                Some((*item, priority, weight))
            } else {
                None
            }
        })
        .collect();

    let mut out = Vec::with_capacity(enabled.len());
    while !enabled.is_empty() {
        let best_priority = enabled
            .iter()
            .map(|(_, priority, _)| *priority)
            .min()
            .expect("non-empty");
        let mut group = Vec::new();
        let mut next = Vec::new();

        for (item, priority, weight) in enabled.drain(..) {
            if priority == best_priority {
                group.push((item, weight));
            } else {
                next.push((item, priority, weight));
            }
        }

        out.extend(weighted_order_pairs(group));
        enabled = next;
    }

    out
}

fn weighted_order_refs<'a, T, F>(items: &[&'a T], weight: F) -> Vec<&'a T>
where
    F: Fn(&T) -> i32 + Copy,
{
    let pairs = items
        .iter()
        .map(|item| (*item, weight(item)))
        .collect::<Vec<_>>();
    weighted_order_pairs(pairs)
}

fn weighted_order_pairs<T>(mut items: Vec<(&T, i32)>) -> Vec<&T> {
    let mut out = Vec::with_capacity(items.len());

    while !items.is_empty() {
        let total_weight: i32 = items.iter().map(|(_, weight)| (*weight).max(0)).sum();
        let index = if total_weight <= 0 {
            fastrand::usize(..items.len())
        } else {
            let mut offset = fastrand::i32(0..total_weight);
            let mut picked = 0usize;
            for (index, (_, weight)) in items.iter().enumerate() {
                let weight = (*weight).max(0);
                if offset < weight {
                    picked = index;
                    break;
                }
                offset -= weight;
            }
            picked
        };

        let (item, _) = items.swap_remove(index);
        out.push(item);
    }

    out
}
