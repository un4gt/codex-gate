use std::collections::{HashMap, HashSet};

use bytes::Bytes;
use serde_json::{Map, Value, json};

use crate::affinity::AffinityIdentity;
use crate::types::Usage;

const DEFAULT_MAX_TOKENS: i64 = 4096;

#[derive(Clone, Debug, Default)]
pub struct ConversionContext {
    pub warnings: Vec<String>,
}

impl ConversionContext {
    fn warn(&mut self, code: &'static str) {
        if !self.warnings.iter().any(|warning| warning == code) {
            self.warnings.push(code.to_string());
        }
    }
}

#[derive(Clone, Debug)]
pub struct ConvertedRequest {
    pub body: Bytes,
    pub context: ConversionContext,
}

/// Convert an Anthropic Messages request from the client into an OpenAI Chat
/// Completions request for an `openai_compatible` upstream. The output is
/// deterministic so an upstream automatic prefix cache keeps its prefix across
/// turns.
pub fn messages_request_to_chat(
    body: &[u8],
    upstream_model: &str,
    affinity_identity: Option<&AffinityIdentity>,
) -> Result<ConvertedRequest, String> {
    let root = serde_json::from_slice::<Value>(body)
        .map_err(|error| format!("invalid messages request JSON: {error}"))?;
    let Some(object) = root.as_object() else {
        return Err("messages request must be a JSON object".to_string());
    };
    let mut context = ConversionContext::default();
    let mut chat = Map::new();

    chat.insert(
        "model".to_string(),
        Value::String(upstream_model.to_string()),
    );
    let stream = object
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    chat.insert("stream".to_string(), Value::Bool(stream));
    chat.insert(
        "max_tokens".to_string(),
        Value::Number(
            object
                .get("max_tokens")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
                .unwrap_or_else(|| {
                    context.warn("default_max_tokens");
                    DEFAULT_MAX_TOKENS
                })
                .into(),
        ),
    );

    copy_field(object, &mut chat, "temperature");
    copy_field(object, &mut chat, "top_p");
    copy_field(object, &mut chat, "cache_control");
    if let Some(stop) = convert_stop(object.get("stop_sequences"))
        && !stop.is_empty()
    {
        chat.insert("stop".to_string(), Value::Array(stop));
    }
    if let Some(user) = object
        .get("metadata")
        .and_then(|metadata| metadata.get("user_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        chat.insert("user".to_string(), Value::String(user.trim().to_string()));
    }
    if let Some(tier) = object.get("service_tier").and_then(Value::as_str) {
        match tier {
            "auto" => {
                chat.insert("service_tier".to_string(), Value::String("auto".into()));
            }
            "standard_only" | "default" | "flex" => {
                chat.insert("service_tier".to_string(), Value::String("default".into()));
            }
            _ => context.warn("dropped_service_tier"),
        }
    }
    if object.get("top_k").is_some_and(|value| !value.is_null()) {
        context.warn("dropped_top_k");
    }
    if let Some(effort) = reasoning_effort(object, &mut context) {
        chat.insert("reasoning_effort".to_string(), Value::String(effort));
    }

    let mut messages = Vec::new();
    if let Some(system) = object.get("system").filter(|value| !value.is_null())
        && let Some(content) = system_content(system, &mut context)
        && !is_empty_content(&content)
    {
        messages.push(json!({ "role": "system", "content": content }));
    }
    convert_anthropic_messages(
        object.get("messages").unwrap_or(&Value::Null),
        &mut messages,
        &mut context,
    );
    if messages.is_empty() {
        return Err("messages request has no convertible messages".to_string());
    }

    let tools = convert_tools(object.get("tools"), &mut context);
    if !tools.is_empty() {
        chat.insert("tools".to_string(), Value::Array(tools));
        convert_tool_choice(object.get("tool_choice"), &mut chat, &mut context);
    } else if object
        .get("tool_choice")
        .is_some_and(|value| !value.is_null())
    {
        context.warn("dropped_tool_choice_without_tools");
    }

    if !chat.contains_key("prompt_cache_key")
        && let Some(identity) = affinity_identity
    {
        chat.insert(
            "prompt_cache_key".to_string(),
            Value::String(identity.derived_prompt_cache_key()),
        );
    }
    chat.insert("messages".to_string(), Value::Array(messages));

    let encoded = serde_json::to_vec(&Value::Object(chat))
        .map_err(|error| format!("failed to encode chat request: {error}"))?;
    Ok(ConvertedRequest {
        body: Bytes::from(encoded),
        context,
    })
}

fn copy_field(source: &Map<String, Value>, target: &mut Map<String, Value>, field: &str) {
    if let Some(value) = source.get(field).filter(|value| !value.is_null()) {
        target.insert(field.to_string(), value.clone());
    }
}

fn convert_stop(value: Option<&Value>) -> Option<Vec<Value>> {
    match value? {
        Value::String(stop) if !stop.is_empty() => Some(vec![Value::String(stop.clone())]),
        Value::Array(items) => Some(
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|stop| !stop.is_empty())
                .map(|stop| Value::String(stop.to_string()))
                .collect(),
        ),
        _ => None,
    }
}

fn reasoning_effort(
    object: &Map<String, Value>,
    context: &mut ConversionContext,
) -> Option<String> {
    let effort = crate::response_events::anthropic_reasoning_effort(object);
    if effort.is_some() && object.get("thinking").is_some() {
        context.warn("mapped_thinking_to_reasoning_effort");
    }
    effort
}

fn system_content(value: &Value, context: &mut ConversionContext) -> Option<Value> {
    match value {
        Value::String(text) => {
            if text.is_empty() {
                None
            } else {
                Some(Value::String(text.clone()))
            }
        }
        Value::Array(parts) => {
            let mut blocks = Vec::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str).unwrap_or("text") {
                    "text" | "input_text" => {
                        let text = part.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            blocks.push(with_cache_control(
                                json!({ "type": "text", "text": text }),
                                part,
                            ));
                        }
                    }
                    "cache_breakpoint" => blocks.push(with_cache_control(
                        json!({ "type": "text", "text": "" }),
                        part,
                    )),
                    _ => context.warn("dropped_unknown_system_part"),
                }
            }
            content_parts_to_chat(blocks)
        }
        _ => {
            context.warn("dropped_unknown_system_content");
            None
        }
    }
}

fn convert_anthropic_messages(
    input: &Value,
    messages: &mut Vec<Value>,
    context: &mut ConversionContext,
) {
    let Some(input) = input.as_array() else {
        context.warn("missing_messages");
        return;
    };
    for message in input {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        match role {
            "user" => convert_user_message(message, messages, context),
            "assistant" => {
                if let Some(message) = assistant_message(message, context) {
                    messages.push(message);
                }
            }
            "system" | "developer" => {
                if let Some(content) = message
                    .get("content")
                    .and_then(|content| system_content(content, context))
                    && !is_empty_content(&content)
                {
                    messages.push(json!({ "role": "system", "content": content }));
                }
            }
            _ => context.warn("dropped_unknown_message_role"),
        }
    }
}

fn convert_user_message(
    message: &Value,
    messages: &mut Vec<Value>,
    context: &mut ConversionContext,
) {
    let Some(content) = message.get("content") else {
        return;
    };
    match content {
        Value::String(text) => {
            if !text.is_empty() {
                messages.push(json!({ "role": "user", "content": text }));
            }
        }
        Value::Array(blocks) => {
            let mut tool_messages = Vec::new();
            let mut parts = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str).unwrap_or("text") {
                    "tool_result" => {
                        if let Some(message) = tool_result_message(block, context) {
                            tool_messages.push(message);
                        }
                    }
                    "text" | "input_text" => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            parts.push(with_cache_control(
                                json!({ "type": "text", "text": text }),
                                block,
                            ));
                        }
                    }
                    "image" => match image_part(block, context) {
                        Some(part) => parts.push(part),
                        None => context.warn("dropped_invalid_image"),
                    },
                    "cache_breakpoint" => parts.push(with_cache_control(
                        json!({ "type": "text", "text": "" }),
                        block,
                    )),
                    "document" | "file" => context.warn("dropped_file_content"),
                    _ => context.warn("dropped_unknown_content_part"),
                }
            }
            messages.extend(tool_messages);
            if let Some(content) = content_parts_to_chat(parts) {
                messages.push(json!({ "role": "user", "content": content }));
            }
        }
        _ => context.warn("dropped_unknown_user_content"),
    }
}

fn tool_result_message(block: &Value, context: &mut ConversionContext) -> Option<Value> {
    let tool_use_id = block
        .get("tool_use_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if tool_use_id.is_empty() {
        context.warn("dropped_tool_result_without_id");
        return None;
    }
    let cache = cache_control(block);
    let content = match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => {
            let mut text_parts = Vec::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str).unwrap_or("text") {
                    "text" | "input_text" => {
                        let text = part.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            text_parts.push(text.to_string());
                        }
                    }
                    "image" => context.warn("dropped_tool_result_image"),
                    _ => {}
                }
            }
            text_parts.join("\n\n")
        }
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    };
    let content = if let Some(cache) = cache {
        Value::Array(vec![with_cache_control(
            json!({ "type": "text", "text": content }),
            &json!({ "cache_control": cache }),
        )])
    } else {
        Value::String(content)
    };
    Some(json!({
        "role": "tool",
        "tool_call_id": tool_use_id,
        "content": content,
    }))
}

fn assistant_message(message: &Value, context: &mut ConversionContext) -> Option<Value> {
    let mut content_parts = Vec::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    if let Some(content) = message.get("content") {
        match content {
            Value::String(text) => {
                if !text.is_empty() {
                    content_parts.push(json!({ "type": "text", "text": text }));
                }
            }
            Value::Array(blocks) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str).unwrap_or("text") {
                        "text" | "output_text" | "input_text" => {
                            let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                            if !text.is_empty() {
                                content_parts.push(with_cache_control(
                                    json!({ "type": "text", "text": text }),
                                    block,
                                ));
                            }
                        }
                        "thinking" => {
                            if let Some(text) = block.get("thinking").and_then(Value::as_str)
                                && !text.is_empty()
                            {
                                if !reasoning.is_empty() {
                                    reasoning.push_str("\n\n");
                                }
                                reasoning.push_str(text);
                            }
                        }
                        "redacted_thinking" => {
                            if !reasoning.is_empty() {
                                reasoning.push_str("\n\n");
                            }
                            reasoning.push_str("[Reasoning redacted]");
                        }
                        "tool_use" => {
                            if let Some(call) = tool_use_call(block, context) {
                                tool_calls.push(call);
                            }
                        }
                        "image" => context.warn("dropped_assistant_image"),
                        "document" | "file" => context.warn("dropped_file_content"),
                        _ => context.warn("dropped_unknown_assistant_part"),
                    }
                }
            }
            _ => context.warn("dropped_unknown_assistant_content"),
        }
    }
    if content_parts.is_empty() && tool_calls.is_empty() && reasoning.is_empty() {
        return None;
    }
    let content = if content_parts.is_empty() {
        Value::Null
    } else {
        content_parts_to_chat(content_parts).unwrap_or(Value::Null)
    };
    let mut out = Map::new();
    out.insert("role".to_string(), Value::String("assistant".into()));
    out.insert("content".to_string(), content);
    if !reasoning.is_empty() {
        out.insert("reasoning_content".to_string(), Value::String(reasoning));
    }
    if !tool_calls.is_empty() {
        out.insert("tool_calls".to_string(), Value::Array(tool_calls));
    }
    Some(Value::Object(out))
}

fn tool_use_call(block: &Value, context: &mut ConversionContext) -> Option<Value> {
    let id = block.get("id").and_then(Value::as_str).unwrap_or("");
    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
    if id.is_empty() || name.is_empty() {
        context.warn("dropped_tool_use_without_id_or_name");
        return None;
    }
    let arguments = serde_json::to_string(block.get("input").unwrap_or(&json!({})))
        .unwrap_or_else(|_| "{}".to_string());
    let mut call = Map::new();
    call.insert("id".to_string(), Value::String(id.to_string()));
    call.insert("type".to_string(), Value::String("function".into()));
    call.insert(
        "function".to_string(),
        json!({ "name": name, "arguments": arguments }),
    );
    if let Some(cache) = cache_control(block) {
        call.insert("cache_control".to_string(), cache);
    }
    Some(Value::Object(call))
}

fn convert_tools(tools: Option<&Value>, context: &mut ConversionContext) -> Vec<Value> {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut converted = Vec::new();
    let mut names = HashSet::new();
    for tool in tools {
        let Some(name) = tool
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        else {
            context.warn("dropped_tool_without_name");
            continue;
        };
        if !names.insert(name.to_string()) {
            context.warn("dropped_duplicate_tool_name");
            continue;
        }
        let schema = tool
            .get("input_schema")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        let mut function = Map::new();
        function.insert("name".to_string(), Value::String(name.to_string()));
        if let Some(description) = tool.get("description").and_then(Value::as_str)
            && !description.is_empty()
        {
            function.insert(
                "description".to_string(),
                Value::String(description.to_string()),
            );
        }
        function.insert("parameters".to_string(), schema);
        let mut converted_tool = Map::new();
        converted_tool.insert("type".to_string(), Value::String("function".into()));
        converted_tool.insert("function".to_string(), Value::Object(function));
        if let Some(cache) = cache_control(tool) {
            converted_tool.insert("cache_control".to_string(), cache);
        }
        converted.push(Value::Object(converted_tool));
    }
    converted
}

fn convert_tool_choice(
    value: Option<&Value>,
    chat: &mut Map<String, Value>,
    context: &mut ConversionContext,
) {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return;
    };
    let mut parallel_tool_calls = None;
    let choice = match value {
        Value::String(kind) => match kind.as_str() {
            "auto" => Value::String("auto".into()),
            "any" => Value::String("required".into()),
            "none" => Value::String("none".into()),
            _ => {
                context.warn("dropped_unknown_tool_choice");
                return;
            }
        },
        Value::Object(object) => {
            if object
                .get("disable_parallel_tool_use")
                .and_then(Value::as_bool)
                == Some(true)
            {
                parallel_tool_calls = Some(false);
            }
            match object.get("type").and_then(Value::as_str).unwrap_or("") {
                "auto" => Value::String("auto".into()),
                "any" => Value::String("required".into()),
                "none" => Value::String("none".into()),
                "tool" => {
                    let name = object.get("name").and_then(Value::as_str).unwrap_or("");
                    if name.is_empty() {
                        context.warn("dropped_tool_choice_without_name");
                        return;
                    }
                    json!({ "type": "function", "function": { "name": name } })
                }
                _ => {
                    context.warn("dropped_unknown_tool_choice");
                    return;
                }
            }
        }
        _ => {
            context.warn("dropped_unknown_tool_choice");
            return;
        }
    };
    chat.insert("tool_choice".to_string(), choice);
    if let Some(parallel) = parallel_tool_calls {
        chat.insert("parallel_tool_calls".to_string(), Value::Bool(parallel));
    }
}

fn content_parts_to_chat(parts: Vec<Value>) -> Option<Value> {
    if parts.is_empty() {
        return None;
    }
    let all_text = parts.iter().all(|part| {
        part.get("type").and_then(Value::as_str) == Some("text")
            && part.get("cache_control").is_none()
    });
    if all_text {
        let text = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n");
        return (!text.is_empty()).then_some(Value::String(text));
    }
    Some(Value::Array(parts))
}

fn is_empty_content(value: &Value) -> bool {
    match value {
        Value::String(text) => text.is_empty(),
        Value::Array(parts) => parts.is_empty(),
        Value::Null => true,
        _ => false,
    }
}

fn image_part(block: &Value, context: &mut ConversionContext) -> Option<Value> {
    let source = block.get("source")?;
    let url = match source.get("type").and_then(Value::as_str).unwrap_or("") {
        "base64" => {
            let media_type = source
                .get("media_type")
                .and_then(Value::as_str)
                .unwrap_or("image/png");
            let data = source.get("data").and_then(Value::as_str).unwrap_or("");
            if data.is_empty() {
                context.warn("dropped_invalid_image");
                return None;
            }
            format!("data:{media_type};base64,{data}")
        }
        "url" => source.get("url").and_then(Value::as_str)?.to_string(),
        _ => {
            context.warn("dropped_invalid_image");
            return None;
        }
    };
    Some(with_cache_control(
        json!({ "type": "image_url", "image_url": { "url": url } }),
        block,
    ))
}

fn cache_control(value: &Value) -> Option<Value> {
    value
        .get("cache_control")
        .filter(|cache| cache.is_object())
        .cloned()
}

fn with_cache_control(mut converted: Value, source: &Value) -> Value {
    if let Some(cache) = cache_control(source)
        && let Some(object) = converted.as_object_mut()
    {
        object.insert("cache_control".to_string(), cache);
    }
    converted
}

fn usage_to_anthropic(usage: &Value) -> Value {
    let prompt = usage
        .get("prompt_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let completion = usage
        .get("completion_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cached = usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(Value::as_i64)
        .or_else(|| usage.get("cached_tokens").and_then(Value::as_i64))
        .unwrap_or(0)
        .max(0);
    let created = usage
        .pointer("/prompt_tokens_details/cache_creation_tokens")
        .and_then(Value::as_i64)
        .or_else(|| usage.get("cache_creation_tokens").and_then(Value::as_i64))
        .unwrap_or(0)
        .max(0);
    let reasoning = usage
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(Value::as_i64)
        .or_else(|| usage.get("reasoning_tokens").and_then(Value::as_i64))
        .unwrap_or(0)
        .max(0);
    let mut out = json!({
        "input_tokens": prompt.saturating_sub(cached).saturating_sub(created).max(0),
        "output_tokens": completion,
        "cache_read_input_tokens": cached,
        "cache_creation_input_tokens": created,
    });
    if reasoning > 0 {
        out["output_tokens_details"] = json!({ "thinking_tokens": reasoning });
    }
    out
}

fn usage_from_chat(value: &Value) -> Option<Usage> {
    let prompt = value.get("prompt_tokens").and_then(Value::as_i64)?;
    let completion = value.get("completion_tokens").and_then(Value::as_i64)?;
    let cached = value
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let created = value
        .pointer("/prompt_tokens_details/cache_creation_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let reasoning = value
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Some(Usage {
        input_tokens: prompt.saturating_sub(cached).saturating_sub(created).max(0),
        output_tokens: completion,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: created,
        reasoning_output_tokens: reasoning,
    })
}

fn usage_value(usage: Usage, observed: bool) -> Value {
    if !observed {
        return json!({
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        });
    }
    let mut out = json!({
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_read_input_tokens": usage.cache_read_input_tokens,
        "cache_creation_input_tokens": usage.cache_creation_input_tokens,
    });
    if usage.reasoning_output_tokens > 0 {
        out["output_tokens_details"] = json!({ "thinking_tokens": usage.reasoning_output_tokens });
    }
    out
}

fn usage_value_with_tier(usage: Usage, observed: bool, tier: Option<&str>) -> Value {
    let mut value = usage_value(usage, observed);
    if let Some(tier) = tier {
        value["service_tier"] = Value::String(tier.to_string());
    }
    value
}

fn map_stop_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("max_tokens" | "length") => "max_tokens",
        Some("tool_use" | "tool_calls" | "function_call") => "tool_use",
        Some("refusal" | "content_filter") => "refusal",
        Some("end_turn" | "stop" | "stop_sequence" | "pause_turn") | None => "end_turn",
        Some(_) => "end_turn",
    }
}

fn short_hash(value: &[u8]) -> String {
    let hash = blake3::hash(value);
    hex::encode(&hash.as_bytes()[..12])
}

fn thinking_block(text: &str) -> Value {
    json!({
        "type": "thinking",
        "thinking": text,
        "signature": format!("lg_{}", short_hash(text.as_bytes())),
    })
}

/// Rough local token count for Chat->Messages models. Claude Code asks
/// `/v1/messages/count_tokens` while estimating context; a chat-only upstream
/// has no Anthropic token-count endpoint, so return a deterministic estimate
/// instead of failing the request.
pub fn estimate_messages_input_tokens(body: &[u8]) -> Option<i64> {
    let root = serde_json::from_slice::<Value>(body).ok()?;
    let mut weight = 0usize;
    let mut message_count = 0usize;
    let mut tool_count = 0usize;
    if let Some(system) = root.get("system") {
        weight = weight.saturating_add(content_weight(system));
    }
    if let Some(messages) = root.get("messages").and_then(Value::as_array) {
        message_count = messages.len();
        for message in messages {
            if let Some(content) = message.get("content") {
                weight = weight.saturating_add(content_weight(content));
            }
        }
    }
    if let Some(tools) = root.get("tools").and_then(Value::as_array) {
        tool_count = tools.len();
        for tool in tools {
            weight = weight.saturating_add(tool_weight(tool));
        }
    }
    if weight == 0 {
        weight = body.len();
    }
    let tokens = weight / 4 + message_count.saturating_mul(4) + tool_count.saturating_mul(8);
    Some(i64::try_from(tokens.max(1)).unwrap_or(i64::MAX))
}

fn text_weight(text: &str) -> usize {
    text.chars()
        .map(|ch| if ch.is_ascii() { 1 } else { 6 })
        .sum()
}

fn json_weight(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|text| text_weight(&text))
        .unwrap_or_default()
}

fn content_weight(value: &Value) -> usize {
    match value {
        Value::String(text) => text_weight(text),
        Value::Array(parts) => parts.iter().map(block_weight).sum(),
        Value::Null => 0,
        other => json_weight(other),
    }
}

fn block_weight(block: &Value) -> usize {
    match block.get("type").and_then(Value::as_str).unwrap_or("text") {
        "text" => text_weight(block.get("text").and_then(Value::as_str).unwrap_or("")),
        "thinking" => text_weight(block.get("thinking").and_then(Value::as_str).unwrap_or("")),
        "image" | "document" | "file" => 6_400,
        "tool_use" => {
            let name = block.get("name").and_then(Value::as_str).unwrap_or("");
            text_weight(name)
                .saturating_add(json_weight(block.get("input").unwrap_or(&Value::Null)))
        }
        "tool_result" => block
            .get("content")
            .map(content_weight)
            .unwrap_or_default()
            .saturating_add(8),
        _ => json_weight(block),
    }
}

fn tool_weight(tool: &Value) -> usize {
    let mut weight = text_weight(tool.get("name").and_then(Value::as_str).unwrap_or(""));
    weight = weight.saturating_add(text_weight(
        tool.get("description")
            .and_then(Value::as_str)
            .unwrap_or(""),
    ));
    weight.saturating_add(json_weight(
        tool.get("input_schema").unwrap_or(&Value::Null),
    ))
}

pub fn chat_response_to_messages(body: &[u8], requested_model: &str) -> Result<Bytes, String> {
    let root = serde_json::from_slice::<Value>(body)
        .map_err(|error| format!("invalid chat response JSON: {error}"))?;
    if root.get("error").is_some_and(|error| !error.is_null()) {
        let message = root
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("chat upstream returned an error");
        return Err(message.to_string());
    }
    let choice = root
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "chat response has no choices".to_string())?;
    let message = choice
        .get("message")
        .ok_or_else(|| "chat response choice has no message".to_string())?;

    let mut content = Vec::new();
    if let Some(reasoning) = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        content.push(thinking_block(reasoning));
    }
    content.extend(chat_message_content_blocks(message.get("content")));
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in tool_calls {
            if let Some(block) = chat_tool_call_to_messages(call) {
                content.push(block);
            }
        }
    }

    let id = root.get("id").and_then(Value::as_str).unwrap_or("chatcmpl");
    let response_id = format!("msg_{}", short_hash(id.as_bytes()));
    let model = root
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(requested_model);
    let mut usage = root
        .get("usage")
        .map(usage_to_anthropic)
        .unwrap_or_else(|| usage_value(Usage::default(), false));
    if let Some(tier) = crate::response_events::service_tier(&root) {
        usage["service_tier"] = Value::String(tier);
    }
    let stop_reason = map_stop_reason(
        choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .or_else(|| root.get("stop_reason").and_then(Value::as_str)),
    );
    let response = json!({
        "id": response_id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": Value::Null,
        "usage": usage,
    });
    serde_json::to_vec(&response)
        .map(Bytes::from)
        .map_err(|error| format!("failed to encode messages response: {error}"))
}

fn chat_message_content_blocks(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::String(text)) if !text.is_empty() => vec![with_cache_control(
            json!({ "type": "text", "text": text }),
            &Value::Null,
        )],
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(
                |part| match part.get("type").and_then(Value::as_str).unwrap_or("text") {
                    "text" | "output_text" => {
                        let text = part.get("text").and_then(Value::as_str).unwrap_or("");
                        (!text.is_empty()).then(|| {
                            with_cache_control(json!({ "type": "text", "text": text }), part)
                        })
                    }
                    _ => None,
                },
            )
            .collect(),
        _ => Vec::new(),
    }
}

fn chat_tool_call_to_messages(call: &Value) -> Option<Value> {
    let id = call.get("id").and_then(Value::as_str).unwrap_or("");
    let function = call.get("function")?;
    let name = function.get("name").and_then(Value::as_str).unwrap_or("");
    if id.is_empty() || name.is_empty() {
        return None;
    }
    let arguments = function
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let input = serde_json::from_str::<Value>(arguments)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    Some(json!({
        "type": "tool_use",
        "id": id,
        "name": name,
        "input": input,
    }))
}

#[derive(Default)]
struct StreamToolBlock {
    block_index: usize,
    id: String,
    name: String,
    arguments: String,
    emitted_arguments_len: usize,
    started: bool,
}

/// OpenAI Chat Completions SSE -> Anthropic Messages SSE converter.
pub struct ChatSseToMessages {
    decoder: crate::response_events::SseDecoder,
    max_bytes: usize,
    total_seen: usize,
    id: String,
    model: String,
    started: bool,
    terminal: bool,
    next_block_index: usize,
    text_block: Option<usize>,
    thinking_block: Option<usize>,
    tool_blocks: HashMap<usize, StreamToolBlock>,
    tool_order: Vec<usize>,
    usage: Usage,
    usage_observed: bool,
    service_tier: Option<String>,
    finish_reason: Option<String>,
}

impl ChatSseToMessages {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            decoder: crate::response_events::SseDecoder::default(),
            max_bytes: max_bytes.max(1024),
            total_seen: 0,
            id: format!("msg_{}", short_hash(b"stream")),
            model: String::new(),
            started: false,
            terminal: false,
            next_block_index: 0,
            text_block: None,
            thinking_block: None,
            tool_blocks: HashMap::new(),
            tool_order: Vec::new(),
            usage: Usage::default(),
            usage_observed: false,
            service_tier: None,
            finish_reason: None,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        self.total_seen = self.total_seen.saturating_add(bytes.len());
        if self.total_seen > self.max_bytes {
            return self.fail(&format!(
                "SSE conversion state exceeded {} bytes",
                self.max_bytes
            ));
        }
        let events = self.decoder.push_bytes(bytes);
        let mut out = Vec::new();
        for event in events {
            out.extend(self.process_chunk(&event));
        }
        out
    }

    pub fn finish(&mut self) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        let events = self.decoder.finish();
        let mut out = Vec::new();
        for event in events {
            out.extend(self.process_chunk(&event));
        }
        if !self.terminal {
            out.extend(self.finalize());
        }
        out
    }

    pub fn fail_stream(&mut self, message: &str) -> Vec<Bytes> {
        self.fail(message)
    }

    fn process_chunk(&mut self, value: &Value) -> Vec<Bytes> {
        if value.get("error").is_some_and(|error| !error.is_null()) {
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("chat upstream stream returned an error");
            return self.fail(message);
        }
        if let Some(id) = value.get("id").and_then(Value::as_str)
            && !id.is_empty()
        {
            self.id = format!("msg_{}", short_hash(id.as_bytes()));
        }
        if let Some(model) = value.get("model").and_then(Value::as_str)
            && !model.is_empty()
        {
            self.model = model.to_string();
        }
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null())
            && let Some(usage) = usage_from_chat(usage)
        {
            self.usage = usage;
            self.usage_observed = true;
        }
        if let Some(tier) = crate::response_events::service_tier(value) {
            self.service_tier = Some(tier);
        }
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return Vec::new();
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
            return Vec::new();
        };
        let mut out = self.ensure_started();
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            out.extend(self.append_thinking(reasoning));
        }
        if let Some(text) = delta.get("content").and_then(Value::as_str)
            && !text.is_empty()
        {
            out.extend(self.append_text(text));
        }
        if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in tool_calls {
                out.extend(self.append_tool_call(call));
            }
        }
        out
    }

    fn ensure_started(&mut self) -> Vec<Bytes> {
        if self.started {
            return Vec::new();
        }
        self.started = true;
        vec![event(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": self.id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": Value::Null,
                    "stop_sequence": Value::Null,
                    "usage": usage_value_with_tier(self.usage, self.usage_observed, self.service_tier.as_deref()),
                }
            }),
        )]
    }

    fn close_thinking(&mut self) -> Option<Bytes> {
        let index = self.thinking_block.take()?;
        Some(event(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": index }),
        ))
    }

    fn close_text(&mut self) -> Option<Bytes> {
        let index = self.text_block.take()?;
        Some(event(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": index }),
        ))
    }

    fn append_thinking(&mut self, text: &str) -> Vec<Bytes> {
        let mut out = Vec::new();
        if self.thinking_block.is_none() {
            if let Some(closed) = self.close_text() {
                out.push(closed);
            }
            let index = self.next_block_index;
            self.next_block_index += 1;
            self.thinking_block = Some(index);
            out.push(event(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "thinking", "thinking": "" },
                }),
            ));
        }
        if let Some(index) = self.thinking_block {
            out.push(event(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": "thinking_delta", "thinking": text },
                }),
            ));
        }
        out
    }

    fn append_text(&mut self, text: &str) -> Vec<Bytes> {
        let mut out = Vec::new();
        if let Some(closed) = self.close_thinking() {
            out.push(closed);
        }
        if self.text_block.is_none() {
            let index = self.next_block_index;
            self.next_block_index += 1;
            self.text_block = Some(index);
            out.push(event(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "text", "text": "" },
                }),
            ));
        }
        if let Some(index) = self.text_block {
            out.push(event(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": "text_delta", "text": text },
                }),
            ));
        }
        out
    }

    fn append_tool_call(&mut self, call: &Value) -> Vec<Bytes> {
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let id_delta = call.get("id").and_then(Value::as_str).unwrap_or("");
        let name_delta = call
            .pointer("/function/name")
            .and_then(Value::as_str)
            .unwrap_or("");
        let arguments_delta = call
            .pointer("/function/arguments")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !self.tool_blocks.contains_key(&index) {
            self.tool_order.push(index);
            self.tool_blocks.insert(index, StreamToolBlock::default());
        }
        let mut tool = self.tool_blocks.remove(&index).unwrap_or_default();
        if !id_delta.is_empty() {
            tool.id.push_str(id_delta);
        }
        if !name_delta.is_empty() {
            tool.name.push_str(name_delta);
        }
        tool.arguments.push_str(arguments_delta);
        let mut out = Vec::new();
        if !tool.started && (tool.id.is_empty() || tool.name.is_empty()) {
            self.tool_blocks.insert(index, tool);
            return out;
        }
        if !tool.started {
            if let Some(closed) = self.close_thinking() {
                out.push(closed);
            }
            if let Some(closed) = self.close_text() {
                out.push(closed);
            }
            let block_index = self.next_block_index;
            self.next_block_index += 1;
            tool.block_index = block_index;
            tool.started = true;
            out.push(event(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": block_index,
                    "content_block": {
                        "type": "tool_use",
                        "id": tool.id,
                        "name": tool.name,
                        "input": {},
                    },
                }),
            ));
        }
        if tool.arguments.len() > tool.emitted_arguments_len {
            let partial = tool.arguments[tool.emitted_arguments_len..].to_string();
            tool.emitted_arguments_len = tool.arguments.len();
            out.push(event(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "index": tool.block_index,
                    "delta": { "type": "input_json_delta", "partial_json": partial },
                }),
            ));
        }
        self.tool_blocks.insert(index, tool);
        out
    }

    fn finalize(&mut self) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        self.terminal = true;
        let mut out = self.ensure_started();
        if let Some(closed) = self.close_thinking() {
            out.push(closed);
        }
        if let Some(closed) = self.close_text() {
            out.push(closed);
        }
        for index in self.tool_order.clone() {
            let Some(tool) = self.tool_blocks.get_mut(&index) else {
                continue;
            };
            if !tool.started {
                if tool.id.is_empty() {
                    tool.id = format!("tool_{index}");
                }
                if tool.name.is_empty() {
                    tool.name = "unknown_tool".to_string();
                }
                let block_index = self.next_block_index;
                self.next_block_index += 1;
                tool.block_index = block_index;
                tool.started = true;
                out.push(event(
                    "content_block_start",
                    json!({
                        "type": "content_block_start",
                        "index": block_index,
                        "content_block": {
                            "type": "tool_use",
                            "id": tool.id,
                            "name": tool.name,
                            "input": {},
                        },
                    }),
                ));
            }
            if tool.arguments.is_empty() {
                tool.arguments = "{}".to_string();
                if tool.emitted_arguments_len == 0 {
                    out.push(event(
                        "content_block_delta",
                        json!({
                            "type": "content_block_delta",
                            "index": tool.block_index,
                            "delta": { "type": "input_json_delta", "partial_json": "{}" },
                        }),
                    ));
                    tool.emitted_arguments_len = 2;
                }
            } else if tool.arguments.len() > tool.emitted_arguments_len {
                let partial = tool.arguments[tool.emitted_arguments_len..].to_string();
                tool.emitted_arguments_len = tool.arguments.len();
                out.push(event(
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": tool.block_index,
                        "delta": { "type": "input_json_delta", "partial_json": partial },
                    }),
                ));
            }
            out.push(event(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": tool.block_index }),
            ));
        }
        let stop_reason = map_stop_reason(self.finish_reason.as_deref());
        out.push(event(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": stop_reason, "stop_sequence": Value::Null },
                "usage": usage_value_with_tier(self.usage, self.usage_observed, self.service_tier.as_deref()),
            }),
        ));
        out.push(event("message_stop", json!({ "type": "message_stop" })));
        out
    }

    fn fail(&mut self, message: &str) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        self.terminal = true;
        vec![event(
            "error",
            json!({
                "type": "error",
                "error": { "type": "api_error", "message": message },
            }),
        )]
    }
}

fn event(name: &str, value: Value) -> Bytes {
    let encoded = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
    Bytes::from(format!("event: {name}\ndata: {encoded}\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(value: Value) -> Bytes {
        Bytes::from(serde_json::to_vec(&value).unwrap())
    }

    fn parse_sse(bytes: &[u8]) -> Vec<Value> {
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        text.replace("\r\n", "\n")
            .split("\n\n")
            .filter_map(|frame| {
                frame
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .and_then(|data| serde_json::from_str::<Value>(data).ok())
            })
            .collect()
    }

    #[test]
    fn request_converts_system_tools_and_cache_control() {
        let request = json!({
            "model": "claude-sonnet-4",
            "max_tokens": 256,
            "stream": true,
            "system": [{"type": "text", "text": "rules", "cache_control": {"type": "ephemeral"}}],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hello", "cache_control": {"type": "ephemeral"}}]},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "plan"},
                    {"type": "text", "text": "hi"},
                    {"type": "tool_use", "id": "tool_1", "name": "Read", "input": {"path": "a"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "tool_1", "content": "file body"},
                    {"type": "text", "text": "continue"}
                ]}
            ],
            "tools": [{
                "name": "Read",
                "description": "read",
                "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
                "cache_control": {"type": "ephemeral"}
            }],
            "tool_choice": {"type": "tool", "name": "Read", "disable_parallel_tool_use": true}
        });
        let converted =
            messages_request_to_chat(&body(request), "deepseek-v4-flash", None).unwrap();
        let value: Value = serde_json::from_slice(&converted.body).unwrap();
        assert_eq!(
            value.get("model").and_then(Value::as_str),
            Some("deepseek-v4-flash")
        );
        assert_eq!(value.get("max_tokens").and_then(Value::as_i64), Some(256));
        assert_eq!(
            value
                .pointer("/messages/0/content/0/cache_control/type")
                .and_then(Value::as_str),
            Some("ephemeral")
        );
        assert_eq!(
            value
                .pointer("/messages/2/reasoning_content")
                .and_then(Value::as_str),
            Some("plan")
        );
        assert_eq!(
            value
                .pointer("/messages/2/tool_calls/0/function/name")
                .and_then(Value::as_str),
            Some("Read")
        );
        assert_eq!(
            value.pointer("/messages/3/role").and_then(Value::as_str),
            Some("tool")
        );
        assert_eq!(
            value.pointer("/messages/4/content").and_then(Value::as_str),
            Some("continue")
        );
        assert_eq!(
            value
                .pointer("/tools/0/cache_control/type")
                .and_then(Value::as_str),
            Some("ephemeral")
        );
        assert_eq!(
            value
                .pointer("/tool_choice/function/name")
                .and_then(Value::as_str),
            Some("Read")
        );
        assert_eq!(
            value.get("parallel_tool_calls").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn estimate_messages_input_tokens_is_deterministic_and_counts_tools() {
        let request = json!({
            "model": "deepseek-v4-flash",
            "system": "You are a coding agent.",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "hello 世界"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
                ]},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "Read", "input": {"path": "a"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "file body"}
                ]}
            ],
            "tools": [{"name": "Read", "description": "read", "input_schema": {"type": "object"}}]
        });
        let encoded = serde_json::to_vec(&request).unwrap();
        let first = estimate_messages_input_tokens(&encoded).unwrap();
        let second = estimate_messages_input_tokens(&encoded).unwrap();
        assert_eq!(first, second);
        assert!(first >= 1600, "{first}");
    }

    #[test]
    fn response_converts_text_tools_and_cache_usage() {
        let response = json!({
            "id": "chatcmpl-1",
            "model": "deepseek-v4-flash",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "hello",
                    "reasoning_content": "plan",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "Read", "arguments": "{\"path\":\"a\"}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 5,
                "prompt_tokens_details": {"cached_tokens": 90, "cache_creation_tokens": 3},
                "completion_tokens_details": {"reasoning_tokens": 2}
            },
            "service_tier": "default"
        });
        let converted = chat_response_to_messages(&body(response), "deepseek-v4-flash").unwrap();
        let value: Value = serde_json::from_slice(&converted).unwrap();
        assert_eq!(value.get("type").and_then(Value::as_str), Some("message"));
        assert_eq!(
            value.get("stop_reason").and_then(Value::as_str),
            Some("tool_use")
        );
        assert_eq!(
            value.pointer("/content/0/type").and_then(Value::as_str),
            Some("thinking")
        );
        assert_eq!(
            value.pointer("/content/1/text").and_then(Value::as_str),
            Some("hello")
        );
        assert_eq!(
            value.pointer("/content/2/name").and_then(Value::as_str),
            Some("Read")
        );
        assert_eq!(
            value.pointer("/usage/input_tokens").and_then(Value::as_i64),
            Some(7)
        );
        assert_eq!(
            value
                .pointer("/usage/cache_read_input_tokens")
                .and_then(Value::as_i64),
            Some(90)
        );
        assert_eq!(
            value
                .pointer("/usage/output_tokens_details/thinking_tokens")
                .and_then(Value::as_i64),
            Some(2)
        );
    }

    #[test]
    fn stream_converts_text_tool_and_usage() {
        let mut converter = ChatSseToMessages::new(1024 * 1024);
        let chunks = [
            json!({"id":"chatcmpl-1","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}),
            json!({"id":"chatcmpl-1","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"reasoning_content":"plan"},"finish_reason":null}]}),
            json!({"id":"chatcmpl-1","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}),
            json!({"id":"chatcmpl-1","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\"path\":"}}]},"finish_reason":null}]}),
            json!({"id":"chatcmpl-1","model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a\"}"}}]},"finish_reason":"tool_calls"}]}),
            json!({"id":"chatcmpl-1","model":"deepseek-v4-flash","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":90},"service_tier":"default"}}),
        ];
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(converter.push(format!("data: {chunk}\n\n").as_bytes()));
        }
        out.extend(converter.push(b"data: [DONE]\n\n"));
        out.extend(converter.finish());
        let events = parse_sse(&out.concat());
        assert!(
            events
                .iter()
                .any(|event| event.get("type").and_then(Value::as_str) == Some("message_start"))
        );
        assert!(
            events
                .iter()
                .any(|event| event.get("type").and_then(Value::as_str) == Some("message_stop"))
        );
        let stop = events
            .iter()
            .rev()
            .find(|event| event.get("type").and_then(Value::as_str) == Some("message_delta"))
            .unwrap();
        assert_eq!(
            stop.pointer("/delta/stop_reason").and_then(Value::as_str),
            Some("tool_use")
        );
        assert_eq!(
            stop.pointer("/usage/input_tokens").and_then(Value::as_i64),
            Some(10)
        );
        assert_eq!(
            stop.pointer("/usage/cache_read_input_tokens")
                .and_then(Value::as_i64),
            Some(90)
        );
    }

    #[test]
    fn stream_error_is_terminal_and_emits_anthropic_error() {
        let mut converter = ChatSseToMessages::new(1024);
        let out = converter.push(b"data: {\"error\":{\"message\":\"busy\"}}\n\n");
        let events = parse_sse(&out.concat());
        assert_eq!(events[0].get("type").and_then(Value::as_str), Some("error"));
        assert!(converter.finish().is_empty());
    }
}
