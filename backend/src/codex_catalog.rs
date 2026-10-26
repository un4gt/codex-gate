//! Codex-native model discovery from a pinned upstream metadata snapshot.
//! Route/credential authorization is resolved by proxy before rendering this catalog.

use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

use hyper::Uri;
use serde::Deserialize;
use serde_json::{Value, json};

pub const MAX_CATALOG_BYTES: usize = 1024 * 1024;
const MODELS_JSON: &str = include_str!("../assets/codex/models.json");
const FALLBACK_INSTRUCTIONS: &str = include_str!("../assets/codex/prompt.md");

#[derive(Debug, PartialEq, Eq)]
pub struct CatalogCandidate {
    pub slug: String,
    // Only set when all authorized routes target the same native Responses model.
    pub metadata_model: Option<String>,
}

pub struct CatalogResponse {
    pub body: Vec<u8>,
    pub included: usize,
    pub total: usize,
}

/// Codex appends client_version even when model_catalog_url has no query string.
pub fn client_version(uri: &Uri) -> Option<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find(|(name, value)| name == "client_version" && !value.trim().is_empty())
        .map(|(_, value)| value.into_owned())
}

fn templates() -> Result<&'static BTreeMap<String, Value>, &'static str> {
    static CATALOG: OnceLock<Result<BTreeMap<String, Value>, &'static str>> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            #[derive(Deserialize)]
            struct Catalog {
                models: Vec<Value>,
            }
            let catalog: Catalog =
                serde_json::from_str(MODELS_JSON).map_err(|_| "invalid bundled Codex catalog")?;
            let mut models = BTreeMap::new();
            for model in catalog.models {
                let slug = model
                    .get("slug")
                    .and_then(Value::as_str)
                    .filter(|slug| !slug.trim().is_empty())
                    .ok_or("bundled Codex catalog has an empty slug")?;
                if models.insert(slug.to_owned(), model).is_some() {
                    return Err("bundled Codex catalog has duplicate slugs");
                }
            }
            Ok(models)
        })
        .as_ref()
        .map_err(|error| *error)
}

pub fn build_catalog(
    mut candidates: Vec<CatalogCandidate>,
    version: &str,
) -> Result<CatalogResponse, &'static str> {
    let templates = templates()?;
    candidates.sort_by(|left, right| {
        let priority = |candidate: &CatalogCandidate| {
            candidate
                .metadata_model
                .as_ref()
                .and_then(|model| templates.get(model))
                .and_then(|model| model.get("priority"))
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX)
        };
        priority(left)
            .cmp(&priority(right))
            .then_with(|| left.slug.cmp(&right.slug))
    });
    let mut seen = HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.slug.clone()));
    let total = candidates.len();
    let models = candidates.iter().enumerate().map(|(index, candidate)| {
        let mut model = candidate
            .metadata_model
            .as_ref()
            .and_then(|name| templates.get(name))
            .cloned()
            .unwrap_or_else(|| fallback_model(&candidate.slug));
        if model["slug"].as_str() != Some(&candidate.slug) {
            model["display_name"] = json!(candidate.slug);
            model["upgrade"] = Value::Null;
            model["availability_nux"] = Value::Null;
        }
        model["slug"] = json!(candidate.slug);
        model["priority"] = json!(index);
        model["visibility"] = json!("list");
        // Every candidate is authorized through this gateway's Responses API.
        // This describes gateway access, not eligibility for a direct OpenAI API key.
        model["supported_in_api"] = json!(true);
        adapt_instructions(&mut model, version);
        model
    });
    let (body, included) = encode_bounded(models, MAX_CATALOG_BYTES)?;
    Ok(CatalogResponse {
        body,
        included,
        total,
    })
}

fn fallback_model(slug: &str) -> Value {
    // Match the required Codex ModelInfo schema without guessing model capabilities.
    json!({
        "slug": slug,
        "display_name": slug,
        "description": null,
        "default_reasoning_level": null,
        "supported_reasoning_levels": [],
        "shell_type": "unified_exec",
        "visibility": "list",
        "supported_in_api": true,
        "priority": 99,
        "model_messages": {"instructions_template": FALLBACK_INSTRUCTIONS},
        "support_verbosity": false,
        "default_verbosity": null,
        "truncation_policy": {"mode": "bytes", "limit": 10000},
        "context_window": null,
        "max_context_window": null,
        "experimental_supported_tools": [],
        "input_modalities": ["text"],
        "use_responses_lite": false,
        "supports_reasoning_effort_updates": false,
        "supports_reasoning_summary_parameter": false,
        "supports_search_tool": false,
        "service_tiers": []
    })
}

fn adapt_instructions(model: &mut Value, version: &str) {
    let modern = version
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .is_ok_and(|parts| parts.len() == 3 && parts.as_slice() >= [0, 159, 2].as_slice());
    let Some(object) = model.as_object_mut() else {
        return;
    };
    if modern {
        // New clients read model_messages. Avoid duplicating large instruction strings.
        object.remove("base_instructions");
    } else if !object.contains_key("base_instructions")
        && let Some(template) = object
            .get("model_messages")
            .and_then(|messages| messages.get("instructions_template"))
            .and_then(Value::as_str)
    {
        object.insert("base_instructions".to_owned(), json!(template));
    }
}

fn encode_bounded(
    models: impl IntoIterator<Item = Value>,
    limit: usize,
) -> Result<(Vec<u8>, usize), &'static str> {
    let mut body = b"{\"models\":[".to_vec();
    if body.len() + 2 > limit {
        return Err("Codex catalog limit is too small");
    }
    let mut included = 0;
    for model in models {
        let bytes = serde_json::to_vec(&model).map_err(|_| "failed to encode Codex model")?;
        let separator = usize::from(included > 0);
        if body.len().saturating_add(bytes.len()) + separator + 2 > limit {
            break;
        }
        if separator > 0 {
            body.push(b',');
        }
        body.extend_from_slice(&bytes);
        included += 1;
    }
    body.extend_from_slice(b"]}");
    Ok((body, included))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(slug: &str, target: Option<&str>) -> CatalogCandidate {
        CatalogCandidate {
            slug: slug.to_owned(),
            metadata_model: target.map(str::to_owned),
        }
    }

    #[test]
    fn catalog_negotiation_requires_nonempty_client_version() {
        for query in [
            "",
            "?client_version=",
            "?client_version=%20",
            "?version=0.163.0",
        ] {
            let uri = format!("/v1/models{query}").parse().unwrap();
            assert_eq!(client_version(&uri), None);
        }
        let uri = "/v1/models?other=1&client_version=0%2E163%2E0"
            .parse()
            .unwrap();
        assert_eq!(client_version(&uri).as_deref(), Some("0.163.0"));
    }

    #[test]
    fn known_models_retain_full_metadata_and_aliases_use_target_identity() {
        let response = build_catalog(
            vec![
                candidate("gpt-6-astra", Some("gpt-6-astra")),
                candidate("我的别名", Some("gpt-6.1-sol")),
            ],
            "0.163.0",
        )
        .unwrap();
        let payload: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(response.included, 2);
        assert_eq!(payload["models"][0]["slug"], "我的别名");
        assert_eq!(payload["models"][0]["display_name"], "我的别名");
        assert_eq!(payload["models"][0]["upgrade"], Value::Null);
        let actual = &payload["models"][1];
        let original = &templates().unwrap()["gpt-6-astra"];
        for (name, value) in original.as_object().unwrap() {
            if !matches!(
                name.as_str(),
                "priority" | "visibility" | "supported_in_api" | "base_instructions"
            ) {
                assert_eq!(actual.get(name), Some(value), "{name}");
            }
        }
        assert!(actual.get("base_instructions").is_none());
        assert!(
            actual["model_messages"]["instructions_template"]
                .as_str()
                .unwrap()
                .len()
                > 100
        );
    }

    #[test]
    fn unknown_and_ambiguous_models_do_not_claim_known_model_capabilities() {
        let response = build_catalog(
            vec![
                candidate("unknown", Some("unknown")),
                candidate("mixed", None),
            ],
            "0.163.0",
        )
        .unwrap();
        let payload: Value = serde_json::from_slice(&response.body).unwrap();
        for model in payload["models"].as_array().unwrap() {
            assert_eq!(model["supported_in_api"], true);
            assert_eq!(model["visibility"], "list");
            assert_eq!(model["use_responses_lite"], false);
            assert_eq!(model["supported_reasoning_levels"], json!([]));
            assert!(model["context_window"].is_null());
        }
    }

    #[test]
    fn legacy_instructions_and_response_byte_limits_remain_compatible() {
        for version in ["0.159.1", "unknown"] {
            let response = build_catalog(vec![candidate("unknown", None)], version).unwrap();
            let payload: Value = serde_json::from_slice(&response.body).unwrap();
            assert_eq!(
                payload["models"][0]["base_instructions"],
                FALLBACK_INSTRUCTIONS
            );
        }
        let models = vec![json!({"slug": "中文"}), json!({"slug": "second"})];
        let (full, _) = encode_bounded(models.clone(), 1024).unwrap();
        let (bounded, included) = encode_bounded(models, full.len() - 1).unwrap();
        assert_eq!(included, 1);
        assert!(bounded.len() < full.len());
        assert_eq!(
            serde_json::from_slice::<Value>(&bounded).unwrap()["models"],
            json!([{"slug": "中文"}])
        );
        assert_eq!(
            encode_bounded([json!({"large": "model"})], 13).unwrap(),
            (b"{\"models\":[]}".to_vec(), 0)
        );
    }

    #[test]
    fn bundled_catalog_fits_client_limit_and_deduplicates_names() {
        let mut models: Vec<_> = templates()
            .unwrap()
            .keys()
            .map(|name| candidate(name, Some(name)))
            .collect();
        let count = models.len();
        models.push(candidate("gpt-6-astra", Some("gpt-6-astra")));
        let response = build_catalog(models, "0.163.0").unwrap();
        assert_eq!(response.total, count);
        assert_eq!(response.included, count);
        assert!(response.body.len() <= MAX_CATALOG_BYTES);
    }
}
