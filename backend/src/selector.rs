use crate::health::{CircuitState, EndpointHealthBook, UpstreamKeyHealthBook};
use crate::types::{UpstreamEndpoint, UpstreamKey};

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
    _strategy: EndpointSelectorStrategy,
    now_ms: i64,
) -> Vec<&'a UpstreamEndpoint> {
    let mut endpoints = items
        .iter()
        .copied()
        .filter(|e| e.enabled && health.snapshot(e.id, now_ms).available)
        .collect::<Vec<_>>();
    endpoints.sort_by_key(|e| (e.priority, e.id));
    endpoints
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
