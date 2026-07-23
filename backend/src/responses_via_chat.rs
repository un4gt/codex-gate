use std::collections::{HashMap, HashSet};

use bytes::Bytes;
use serde_json::{Map, Value, json};

use crate::affinity::AffinityIdentity;

const MAX_TOOL_NAME_LEN: usize = 64;

#[derive(Clone, Debug)]
enum ToolKind {
    Function { name: String },
    Custom { name: String },
    Namespace { namespace: String, name: String },
}

#[derive(Clone, Debug, Default)]
pub struct ConversionContext {
    tool_by_chat_name: HashMap<String, ToolKind>,
    chat_name_by_response_name: HashMap<String, String>,
    pub warnings: Vec<String>,
}

impl ConversionContext {
    fn warn(&mut self, code: &'static str) {
        if !self.warnings.iter().any(|warning| warning == code) {
            self.warnings.push(code.to_string());
        }
    }

    fn response_tool_name(&self, name: &str) -> String {
        self.chat_name_by_response_name
            .get(name)
            .cloned()
            .unwrap_or_else(|| name.to_string())
    }
}

#[derive(Clone, Debug)]
pub struct ConvertedRequest {
    pub body: Bytes,
    pub context: ConversionContext,
}

pub fn has_previous_response_id(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|root| {
            root.get("previous_response_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(|value| !value.is_empty())
        })
        .unwrap_or(false)
}

pub fn responses_request_to_chat(
    body: &[u8],
    upstream_model: &str,
    affinity_identity: Option<&AffinityIdentity>,
) -> Result<ConvertedRequest, String> {
    let root = serde_json::from_slice::<Value>(body)
        .map_err(|error| format!("invalid responses request JSON: {error}"))?;
    let Some(object) = root.as_object() else {
        return Err("responses request must be a JSON object".to_string());
    };
    if object
        .get("previous_response_id")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err("previous_response_id requires a native Responses upstream".to_string());
    }

    let mut context = ConversionContext::default();
    let mut chat = Map::new();
    chat.insert(
        "model".to_string(),
        Value::String(upstream_model.to_string()),
    );
    chat.insert(
        "stream".to_string(),
        Value::Bool(
            object
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );

    let tools = convert_tools(object, &mut context);
    if !tools.is_empty() {
        chat.insert("tools".to_string(), Value::Array(tools));
    }

    let mut messages = Vec::new();
    if let Some(instructions) = object.get("instructions")
        && !instructions.is_null()
    {
        messages.push(json!({
            "role": "system",
            "content": response_content_to_chat(instructions, &mut context),
        }));
    }
    let mut conversion_warnings = Vec::new();
    convert_input(
        object.get("input").unwrap_or(&Value::Null),
        &context,
        &mut messages,
        &mut conversion_warnings,
    );
    for warning in conversion_warnings {
        push_warning(&mut context.warnings, &warning);
    }
    chat.insert("messages".to_string(), Value::Array(messages));

    copy_field(object, &mut chat, "temperature", "temperature");
    copy_field(object, &mut chat, "top_p", "top_p");
    copy_field(
        object,
        &mut chat,
        "parallel_tool_calls",
        "parallel_tool_calls",
    );
    copy_field(object, &mut chat, "user", "user");
    copy_field(object, &mut chat, "seed", "seed");
    copy_field(object, &mut chat, "service_tier", "service_tier");
    copy_field(object, &mut chat, "prompt_cache_key", "prompt_cache_key");
    copy_field(
        object,
        &mut chat,
        "prompt_cache_retention",
        "prompt_cache_retention",
    );
    copy_field(object, &mut chat, "cache_control", "cache_control");
    copy_field(object, &mut chat, "retention", "retention");

    if !chat.contains_key("prompt_cache_key")
        && let Some(identity) = affinity_identity
    {
        chat.insert(
            "prompt_cache_key".to_string(),
            Value::String(identity.derived_prompt_cache_key()),
        );
    }
    if let Some(max_tokens) = object.get("max_output_tokens") {
        chat.insert("max_tokens".to_string(), max_tokens.clone());
    }
    if let Some(reasoning) = object.get("reasoning").and_then(Value::as_object)
        && let Some(effort) = reasoning.get("effort")
    {
        chat.insert("reasoning_effort".to_string(), effort.clone());
    }
    if let Some(stream_options) = object.get("stream_options") {
        chat.insert("stream_options".to_string(), stream_options.clone());
    }
    convert_text_format(object, &mut chat, &mut context);
    let mut tool_choice_warnings = Vec::new();
    convert_tool_choice(object, &mut chat, &context, &mut tool_choice_warnings);
    for warning in tool_choice_warnings {
        push_warning(&mut context.warnings, &warning);
    }
    record_unsupported_fields(object, &mut context);

    let encoded = serde_json::to_vec(&Value::Object(chat))
        .map_err(|error| format!("failed to encode chat request: {error}"))?;
    Ok(ConvertedRequest {
        body: Bytes::from(encoded),
        context,
    })
}

fn copy_field(source: &Map<String, Value>, target: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = source.get(from) {
        target.insert(to.to_string(), value.clone());
    }
}

fn response_content_to_chat(value: &Value, context: &mut ConversionContext) -> Value {
    if value.is_string() {
        return value.clone();
    }
    let Some(parts) = value.as_array() else {
        return value.clone();
    };
    let converted = parts
        .iter()
        .filter_map(|part| convert_content_part(part, context))
        .collect::<Vec<_>>();
    Value::Array(converted)
}

fn convert_content_part(part: &Value, context: &mut ConversionContext) -> Option<Value> {
    let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "input_text" | "output_text" | "text" => Some(with_cache_control(
            json!({
                "type": "text",
                "text": part.get("text").and_then(Value::as_str).unwrap_or_default(),
            }),
            part,
        )),
        "input_image" | "image_url" => {
            let image_url = part
                .get("image_url")
                .or_else(|| part.get("url"))
                .cloned()
                .unwrap_or(Value::Null);
            let image_url = if image_url.is_string() {
                let mut image = Map::new();
                image.insert("url".to_string(), image_url);
                if let Some(detail) = part.get("detail") {
                    image.insert("detail".to_string(), detail.clone());
                }
                Value::Object(image)
            } else {
                image_url
            };
            Some(with_cache_control(
                json!({ "type": "image_url", "image_url": image_url }),
                part,
            ))
        }
        "cache_breakpoint" => Some(json!({
            "type": "text",
            "text": "",
            "cache_control": part.get("cache_control").cloned().unwrap_or_else(|| json!({ "type": "ephemeral" })),
        })),
        "input_file" | "file" => {
            context.warn("dropped_file_content");
            None
        }
        "input_audio" | "audio" => {
            context.warn("dropped_audio_content");
            None
        }
        _ => {
            context.warn("dropped_unknown_content_part");
            None
        }
    }
}

fn with_cache_control(mut converted: Value, source: &Value) -> Value {
    if let Some(cache_control) = source.get("cache_control")
        && let Some(object) = converted.as_object_mut()
    {
        object.insert("cache_control".to_string(), cache_control.clone());
    }
    converted
}

fn convert_input(
    input: &Value,
    context: &ConversionContext,
    messages: &mut Vec<Value>,
    warnings: &mut Vec<String>,
) {
    if let Some(text) = input.as_str() {
        messages.push(json!({ "role": "user", "content": text }));
        return;
    }
    let Some(items) = input.as_array() else {
        if !input.is_null() {
            push_warning(warnings, "dropped_unknown_input");
        }
        return;
    };

    let mut pending_calls = Vec::new();
    for item in items {
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        if matches!(kind, "function_call" | "custom_tool_call") {
            pending_calls.push(convert_call_input(item, context));
            continue;
        }
        flush_calls(messages, &mut pending_calls);
        match kind {
            "message" => {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                let mut local_context = ConversionContext::default();
                let content = response_content_to_chat(
                    item.get("content").unwrap_or(&Value::Null),
                    &mut local_context,
                );
                for warning in local_context.warnings {
                    push_warning(warnings, &warning);
                }
                messages.push(json!({ "role": role, "content": content }));
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("call_missing");
                let output = item
                    .get("output")
                    .or_else(|| item.get("input"))
                    .cloned()
                    .unwrap_or(Value::String(String::new()));
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": stringify_tool_output(&output),
                }));
            }
            "reasoning" => {
                let text = reasoning_summary_text(item);
                if !text.is_empty() {
                    messages.push(json!({ "role": "assistant", "content": text }));
                }
            }
            "item_reference" => push_warning(warnings, "dropped_item_reference"),
            _ => push_warning(warnings, "dropped_unknown_input_item"),
        }
    }
    flush_calls(messages, &mut pending_calls);
}

fn convert_call_input(item: &Value, context: &ConversionContext) -> Value {
    let call_id = item
        .get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("call_missing");
    let response_name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unknown_tool");
    let name = context.response_tool_name(response_name);
    let arguments = if item.get("type").and_then(Value::as_str) == Some("custom_tool_call") {
        serde_json::to_string(&json!({
            "input": item.get("input").and_then(Value::as_str).unwrap_or_default()
        }))
        .unwrap_or_else(|_| "{\"input\":\"\"}".to_string())
    } else {
        item.get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}")
            .to_string()
    };
    json!({
        "id": call_id,
        "type": "function",
        "function": { "name": name, "arguments": arguments },
    })
}

fn flush_calls(messages: &mut Vec<Value>, pending_calls: &mut Vec<Value>) {
    if pending_calls.is_empty() {
        return;
    }
    messages.push(json!({
        "role": "assistant",
        "content": Value::Null,
        "tool_calls": std::mem::take(pending_calls),
    }));
}

fn stringify_tool_output(value: &Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default())
}

fn reasoning_summary_text(item: &Value) -> String {
    item.get("summary")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn convert_tools(object: &Map<String, Value>, context: &mut ConversionContext) -> Vec<Value> {
    let mut definitions = Vec::new();
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        definitions.extend(tools.iter());
    }
    if let Some(tools) = object.get("additional_tools").and_then(Value::as_array) {
        definitions.extend(tools.iter());
    }

    let reserved_function_names = definitions
        .iter()
        .filter(|tool| tool.get("type").and_then(Value::as_str) == Some("function"))
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .map(normalize_tool_name)
        .collect::<HashSet<_>>();
    let mut used = HashSet::new();
    let mut converted = Vec::new();
    for (index, tool) in definitions.into_iter().enumerate() {
        let kind = tool.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "function" => {
                let name = tool
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown_tool")
                    .to_string();
                let chat_name = unique_tool_name(&name, index, &mut used);
                context
                    .tool_by_chat_name
                    .insert(chat_name.clone(), ToolKind::Function { name: name.clone() });
                context
                    .chat_name_by_response_name
                    .insert(name, chat_name.clone());
                converted.push(chat_function(tool, &chat_name, None));
            }
            "custom" => {
                let name = tool
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("custom_tool")
                    .to_string();
                let chat_name = unique_generated_tool_name(
                    &format!("lg_custom_{name}"),
                    index,
                    &mut used,
                    &reserved_function_names,
                );
                context
                    .tool_by_chat_name
                    .insert(chat_name.clone(), ToolKind::Custom { name: name.clone() });
                context
                    .chat_name_by_response_name
                    .insert(name, chat_name.clone());
                converted.push(chat_function(
                    tool,
                    &chat_name,
                    Some(json!({
                        "type": "object",
                        "properties": { "input": { "type": "string" } },
                        "required": ["input"],
                        "additionalProperties": false,
                    })),
                ));
            }
            "namespace" => convert_namespace(
                tool,
                index,
                &mut used,
                &reserved_function_names,
                context,
                &mut converted,
            ),
            "web_search"
            | "web_search_preview"
            | "file_search"
            | "computer"
            | "computer_use_preview"
            | "code_interpreter"
            | "image_generation"
            | "mcp"
            | "shell"
            | "local_shell" => context.warn("dropped_hosted_tool"),
            _ => context.warn("dropped_unknown_tool"),
        }
    }
    converted
}

fn convert_namespace(
    tool: &Value,
    namespace_index: usize,
    used: &mut HashSet<String>,
    reserved_function_names: &HashSet<String>,
    context: &mut ConversionContext,
    converted: &mut Vec<Value>,
) {
    let namespace = tool
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("namespace")
        .to_string();
    let Some(tools) = tool.get("tools").and_then(Value::as_array) else {
        context.warn("dropped_empty_namespace");
        return;
    };
    for (tool_index, nested) in tools.iter().enumerate() {
        let name = nested
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let response_name = format!("{namespace}.{name}");
        let chat_name = unique_generated_tool_name(
            &format!("lg_ns_{namespace}_{name}"),
            namespace_index
                .saturating_mul(1000)
                .saturating_add(tool_index),
            used,
            reserved_function_names,
        );
        context.tool_by_chat_name.insert(
            chat_name.clone(),
            ToolKind::Namespace {
                namespace: namespace.clone(),
                name: name.clone(),
            },
        );
        context
            .chat_name_by_response_name
            .insert(response_name, chat_name.clone());
        converted.push(chat_function(nested, &chat_name, None));
    }
}

fn chat_function(tool: &Value, name: &str, forced_parameters: Option<Value>) -> Value {
    let mut function = Map::new();
    function.insert("name".to_string(), Value::String(name.to_string()));
    if let Some(description) = tool.get("description") {
        function.insert("description".to_string(), description.clone());
    }
    function.insert(
        "parameters".to_string(),
        forced_parameters
            .or_else(|| tool.get("parameters").cloned())
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
    );
    if let Some(strict) = tool.get("strict") {
        function.insert("strict".to_string(), strict.clone());
    }
    json!({ "type": "function", "function": function })
}

fn unique_tool_name(base: &str, index: usize, used: &mut HashSet<String>) -> String {
    let sanitized = normalize_tool_name(base);
    let mut candidate = sanitized.clone();
    if candidate.is_empty() {
        candidate = format!("lg_tool_{index}");
    }
    if used.insert(candidate.clone()) {
        return candidate;
    }
    for suffix in 1..=10_000usize {
        let tail = format!("_{index}_{suffix}");
        let keep = MAX_TOOL_NAME_LEN.saturating_sub(tail.len());
        let prefix = sanitized.chars().take(keep).collect::<String>();
        let candidate = format!("{prefix}{tail}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    format!("lg_tool_{index}")
}

fn unique_generated_tool_name(
    base: &str,
    index: usize,
    used: &mut HashSet<String>,
    reserved: &HashSet<String>,
) -> String {
    let mut blocked = used.clone();
    blocked.extend(reserved.iter().cloned());
    let generated = unique_tool_name(base, index, &mut blocked);
    used.insert(generated.clone());
    generated
}

fn normalize_tool_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    truncate_tool_name(&sanitized)
}

fn truncate_tool_name(name: &str) -> String {
    name.chars().take(MAX_TOOL_NAME_LEN).collect()
}

fn convert_text_format(
    object: &Map<String, Value>,
    chat: &mut Map<String, Value>,
    context: &mut ConversionContext,
) {
    let Some(format) = object
        .get("text")
        .and_then(|text| text.get("format"))
        .and_then(Value::as_object)
    else {
        return;
    };
    match format.get("type").and_then(Value::as_str) {
        Some("json_object") => {
            chat.insert(
                "response_format".to_string(),
                json!({ "type": "json_object" }),
            );
        }
        Some("json_schema") => {
            let mut schema = format.clone();
            schema.remove("type");
            chat.insert(
                "response_format".to_string(),
                json!({ "type": "json_schema", "json_schema": schema }),
            );
        }
        Some("text") | None => {}
        Some(_) => context.warn("dropped_unknown_text_format"),
    }
}

fn convert_tool_choice(
    object: &Map<String, Value>,
    chat: &mut Map<String, Value>,
    context: &ConversionContext,
    warnings: &mut Vec<String>,
) {
    let Some(choice) = object.get("tool_choice") else {
        return;
    };
    if choice.is_string() {
        chat.insert("tool_choice".to_string(), choice.clone());
        return;
    }
    let Some(choice_object) = choice.as_object() else {
        push_warning(warnings, "dropped_unknown_tool_choice");
        return;
    };
    if choice_object.get("type").and_then(Value::as_str) == Some("allowed_tools") {
        push_warning(warnings, "dropped_allowed_tools_choice");
        chat.insert(
            "tool_choice".to_string(),
            Value::String("required".to_string()),
        );
        return;
    }
    let Some(name) = choice_object.get("name").and_then(Value::as_str) else {
        push_warning(warnings, "dropped_unknown_tool_choice");
        return;
    };
    chat.insert(
        "tool_choice".to_string(),
        json!({
            "type": "function",
            "function": { "name": context.response_tool_name(name) },
        }),
    );
}

fn record_unsupported_fields(object: &Map<String, Value>, context: &mut ConversionContext) {
    for (field, code) in [
        ("store", "dropped_store"),
        ("background", "dropped_background"),
        ("conversation", "dropped_conversation"),
        ("include", "dropped_include"),
        ("truncation", "dropped_truncation"),
    ] {
        if object.get(field).is_some_and(|value| match value {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Array(values) => !values.is_empty(),
            Value::String(value) => !value.is_empty(),
            _ => true,
        }) {
            context.warn(code);
        }
    }
}

fn push_warning(warnings: &mut Vec<String>, code: &str) {
    if !warnings.iter().any(|warning| warning == code) {
        warnings.push(code.to_string());
    }
}

pub fn chat_response_to_responses(
    body: &[u8],
    context: &ConversionContext,
) -> Result<Bytes, String> {
    let chat = serde_json::from_slice::<Value>(body)
        .map_err(|error| format!("invalid Chat Completions response: {error}"))?;
    if let Some(error) = chat.get("error") {
        return Err(format!("upstream Chat Completions error: {error}"));
    }
    let choice = chat
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "Chat Completions response has no choice".to_string())?;
    let message = choice
        .get("message")
        .ok_or_else(|| "Chat Completions response has no message".to_string())?;
    let response_id = response_id(chat.get("id").and_then(Value::as_str));
    let mut output = Vec::new();
    if message
        .get("content")
        .is_some_and(|content| !content.is_null())
    {
        output.push(response_message_item(message, &response_id));
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for (index, tool_call) in tool_calls.iter().enumerate() {
            output.push(response_tool_item(tool_call, index, context));
        }
    }
    let finish_reason = choice.get("finish_reason").and_then(Value::as_str);
    let incomplete_details = match finish_reason {
        Some("length") => Some(json!({ "reason": "max_output_tokens" })),
        Some("content_filter") => Some(json!({ "reason": "content_filter" })),
        _ => None,
    };
    let response = json!({
        "id": response_id,
        "object": "response",
        "created_at": chat.get("created").and_then(Value::as_i64).unwrap_or(0),
        "status": if incomplete_details.is_some() { "incomplete" } else { "completed" },
        "completed_at": chat.get("created").and_then(Value::as_i64),
        "error": Value::Null,
        "incomplete_details": incomplete_details,
        "instructions": Value::Null,
        "max_output_tokens": Value::Null,
        "model": chat.get("model").cloned().unwrap_or(Value::Null),
        "output": output,
        "parallel_tool_calls": true,
        "previous_response_id": Value::Null,
        "reasoning": { "effort": Value::Null, "summary": Value::Null },
        "store": false,
        "temperature": Value::Null,
        "text": { "format": { "type": "text" } },
        "tool_choice": "auto",
        "tools": [],
        "top_p": Value::Null,
        "truncation": "disabled",
        "usage": chat.get("usage").map(chat_usage_to_responses).unwrap_or(Value::Null),
        "user": Value::Null,
        "metadata": {},
    });
    serde_json::to_vec(&response)
        .map(Bytes::from)
        .map_err(|error| format!("failed to encode Responses response: {error}"))
}

fn response_message_item(message: &Value, response_id: &str) -> Value {
    let content = match message.get("content") {
        Some(Value::String(text)) => vec![json!({
            "type": "output_text", "text": text, "annotations": [], "logprobs": [],
        })],
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let text = part
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())?;
                Some(json!({
                    "type": "output_text", "text": text, "annotations": [], "logprobs": [],
                }))
            })
            .collect(),
        _ => Vec::new(),
    };
    json!({
        "id": format!("msg_{}", short_hash(response_id.as_bytes())),
        "type": "message",
        "status": "completed",
        "role": "assistant",
        "content": content,
    })
}

fn response_tool_item(tool_call: &Value, index: usize, context: &ConversionContext) -> Value {
    let call_id = tool_call
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("call_{}", short_hash(index.to_string().as_bytes())));
    let name = tool_call
        .pointer("/function/name")
        .and_then(Value::as_str)
        .unwrap_or("unknown_tool");
    let arguments = tool_call
        .pointer("/function/arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    match context.tool_by_chat_name.get(name) {
        Some(ToolKind::Custom { name }) => json!({
            "id": format!("ctc_{}", short_hash(call_id.as_bytes())),
            "type": "custom_tool_call",
            "status": "completed",
            "call_id": call_id,
            "name": name,
            "input": custom_input(arguments),
        }),
        Some(ToolKind::Namespace { namespace, name }) => json!({
            "id": format!("fc_{}", short_hash(call_id.as_bytes())),
            "type": "function_call",
            "status": "completed",
            "call_id": call_id,
            "name": format!("{namespace}.{name}"),
            "arguments": arguments,
        }),
        Some(ToolKind::Function { name }) => function_call_item(&call_id, name, arguments),
        None => function_call_item(&call_id, name, arguments),
    }
}

fn function_call_item(call_id: &str, name: &str, arguments: &str) -> Value {
    json!({
        "id": format!("fc_{}", short_hash(call_id.as_bytes())),
        "type": "function_call",
        "status": "completed",
        "call_id": call_id,
        "name": name,
        "arguments": arguments,
    })
}

fn custom_input(arguments: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("input")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| arguments.to_string())
}

fn chat_usage_to_responses(usage: &Value) -> Value {
    let input_tokens = usage
        .get("prompt_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("completion_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cached_tokens = usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(Value::as_i64)
        .or_else(|| usage.get("cached_tokens").and_then(Value::as_i64))
        .unwrap_or(0);
    let cache_creation_tokens = usage
        .pointer("/prompt_tokens_details/cache_creation_tokens")
        .and_then(Value::as_i64)
        .or_else(|| usage.get("cache_creation_tokens").and_then(Value::as_i64))
        .or_else(|| usage.get("cached_creation_tokens").and_then(Value::as_i64))
        .unwrap_or(0);
    let reasoning_tokens = usage
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    json!({
        "input_tokens": input_tokens,
        "input_tokens_details": {
            "cached_tokens": cached_tokens,
            "cache_creation_tokens": cache_creation_tokens,
        },
        "output_tokens": output_tokens,
        "output_tokens_details": { "reasoning_tokens": reasoning_tokens },
        "total_tokens": usage
            .get("total_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(input_tokens.saturating_add(output_tokens)),
    })
}

fn response_id(chat_id: Option<&str>) -> String {
    match chat_id {
        Some(id) if id.starts_with("resp_") => id.to_string(),
        Some(id) => format!("resp_{}", short_hash(id.as_bytes())),
        None => format!("resp_{}", short_hash(b"missing-response-id")),
    }
}

fn short_hash(value: &[u8]) -> String {
    let hash = blake3::hash(value);
    hex::encode(&hash.as_bytes()[..12])
}

#[derive(Default)]
struct SseDecoder {
    buffer: Vec<u8>,
    event_name: Option<String>,
    data_lines: Vec<String>,
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8], max_bytes: usize) -> Result<Vec<SseEvent>, String> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > max_bytes {
            return Err(format!("SSE conversion buffer exceeded {max_bytes} bytes"));
        }
        let mut events = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.process_line(&line, &mut events);
        }
        Ok(events)
    }

    fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            self.process_line(&line, &mut events);
        }
        self.dispatch(&mut events);
        events
    }

    fn process_line(&mut self, line: &[u8], events: &mut Vec<SseEvent>) {
        if line.is_empty() {
            self.dispatch(events);
            return;
        }
        if line.first() == Some(&b':') {
            return;
        }
        let (field, value) =
            line.iter()
                .position(|byte| *byte == b':')
                .map_or((line, &[][..]), |position| {
                    let field = &line[..position];
                    let value = &line[position + 1..];
                    (field, value.strip_prefix(b" ").unwrap_or(value))
                });
        match field {
            b"event" => self.event_name = Some(String::from_utf8_lossy(value).into_owned()),
            b"data" => self
                .data_lines
                .push(String::from_utf8_lossy(value).into_owned()),
            _ => {}
        }
    }

    fn dispatch(&mut self, events: &mut Vec<SseEvent>) {
        if self.data_lines.is_empty() && self.event_name.is_none() {
            return;
        }
        events.push(SseEvent {
            event_name: self.event_name.take(),
            data: self.data_lines.join("\n"),
        });
        self.data_lines.clear();
    }
}

struct SseEvent {
    event_name: Option<String>,
    data: String,
}

#[derive(Clone, Debug)]
struct StreamToolCall {
    call_id: String,
    name: String,
    arguments: String,
    output_index: usize,
    emitted: bool,
    emitted_arguments_len: usize,
}

pub struct ChatSseToResponses {
    decoder: SseDecoder,
    context: ConversionContext,
    max_bytes: usize,
    response_id: String,
    model: Value,
    created_at: i64,
    created: bool,
    sequence: i64,
    output: Vec<Value>,
    message_index: Option<usize>,
    message_id: String,
    text: String,
    text_started: bool,
    tools: HashMap<usize, StreamToolCall>,
    tool_order: Vec<usize>,
    usage: Value,
    finish_reason: Option<String>,
    saw_done: bool,
    terminal: bool,
    total_seen: usize,
}

impl ChatSseToResponses {
    pub fn new(context: ConversionContext, max_bytes: usize) -> Self {
        Self {
            decoder: SseDecoder::default(),
            context,
            max_bytes: max_bytes.max(1024),
            response_id: response_id(None),
            model: Value::Null,
            created_at: 0,
            created: false,
            sequence: 0,
            output: Vec::new(),
            message_index: None,
            message_id: format!("msg_{}", short_hash(b"stream-message")),
            text: String::new(),
            text_started: false,
            tools: HashMap::new(),
            tool_order: Vec::new(),
            usage: Value::Null,
            finish_reason: None,
            saw_done: false,
            terminal: false,
            total_seen: 0,
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
        let events = match self.decoder.push(bytes, self.max_bytes) {
            Ok(events) => events,
            Err(error) => return self.fail(&error),
        };
        self.process_events(events)
    }

    pub fn finish(&mut self) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        let events = self.decoder.finish();
        let mut output = self.process_events(events);
        if !self.terminal {
            if self.saw_done {
                output.extend(self.complete());
            } else {
                output.extend(self.fail("upstream Chat Completions stream ended before [DONE]"));
            }
        }
        output
    }

    pub fn fail_stream(&mut self, message: &str) -> Vec<Bytes> {
        self.fail(message)
    }

    fn process_events(&mut self, events: Vec<SseEvent>) -> Vec<Bytes> {
        let mut output = Vec::new();
        for event in events {
            if event.data.trim() == "[DONE]" {
                self.saw_done = true;
                output.extend(self.complete());
                continue;
            }
            if event
                .event_name
                .as_deref()
                .is_some_and(|name| name == "error" || name.ends_with(".error"))
            {
                output.extend(self.fail(&event.data));
                continue;
            }
            let value = match serde_json::from_str::<Value>(&event.data) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
                output.extend(self.fail(&error.to_string()));
                continue;
            }
            output.extend(self.process_chunk(&value));
        }
        output
    }

    fn process_chunk(&mut self, chunk: &Value) -> Vec<Bytes> {
        let mut events = Vec::new();
        if !self.created {
            if let Some(id) = chunk.get("id").and_then(Value::as_str) {
                self.response_id = response_id(Some(id));
                self.message_id = format!("msg_{}", short_hash(self.response_id.as_bytes()));
            }
            self.model = chunk.get("model").cloned().unwrap_or(Value::Null);
            self.created_at = chunk.get("created").and_then(Value::as_i64).unwrap_or(0);
            events.extend(self.start_events());
        }
        if let Some(usage) = chunk.get("usage").filter(|usage| !usage.is_null()) {
            self.usage = chat_usage_to_responses(usage);
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return events;
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta").and_then(Value::as_object) else {
            return events;
        };
        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            events.extend(self.append_text(content));
        }
        if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for tool_call in tool_calls {
                events.extend(self.append_tool_delta(tool_call));
            }
        }
        events
    }

    fn start_events(&mut self) -> Vec<Bytes> {
        self.created = true;
        let response = self.response_snapshot("in_progress");
        vec![
            self.event("response.created", json!({
                "type": "response.created", "response": response,
            })),
            self.event("response.in_progress", json!({
                "type": "response.in_progress", "response": self.response_snapshot("in_progress"),
            })),
        ]
    }

    fn ensure_message(&mut self) -> Vec<Bytes> {
        if self.message_index.is_some() {
            return Vec::new();
        }
        let output_index = self.output.len();
        self.message_index = Some(output_index);
        let item = json!({
            "id": self.message_id,
            "type": "message",
            "status": "in_progress",
            "role": "assistant",
            "content": [],
        });
        self.output.push(item.clone());
        vec![self.event(
            "response.output_item.added",
            json!({
                "type": "response.output_item.added",
                "output_index": output_index,
                "item": item,
            }),
        )]
    }

    fn append_text(&mut self, delta: &str) -> Vec<Bytes> {
        let mut events = self.ensure_message();
        let output_index = self.message_index.unwrap_or(0);
        if !self.text_started {
            self.text_started = true;
            events.push(self.event("response.content_part.added", json!({
                "type": "response.content_part.added",
                "item_id": self.message_id,
                "output_index": output_index,
                "content_index": 0,
                "part": { "type": "output_text", "text": "", "annotations": [], "logprobs": [] },
            })));
        }
        self.text.push_str(delta);
        events.push(self.event(
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "item_id": self.message_id,
                "output_index": output_index,
                "content_index": 0,
                "delta": delta,
                "logprobs": [],
            }),
        ));
        events
    }

    fn append_tool_delta(&mut self, delta: &Value) -> Vec<Bytes> {
        let index = delta.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let call_id_delta = delta.get("id").and_then(Value::as_str).unwrap_or("");
        let name_delta = delta
            .pointer("/function/name")
            .and_then(Value::as_str)
            .unwrap_or("");
        let arguments_delta = delta
            .pointer("/function/arguments")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !self.tools.contains_key(&index) {
            self.tool_order.push(index);
            let output_index = self.output.len();
            self.output.push(Value::Null);
            self.tools.insert(
                index,
                StreamToolCall {
                    call_id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                    output_index,
                    emitted: false,
                    emitted_arguments_len: 0,
                },
            );
        }
        let Some(tool) = self.tools.get_mut(&index) else {
            return Vec::new();
        };
        if !call_id_delta.is_empty() {
            tool.call_id.push_str(call_id_delta);
        }
        if !name_delta.is_empty() {
            tool.name.push_str(name_delta);
        }
        tool.arguments.push_str(arguments_delta);
        self.emit_tool(index, false)
    }

    fn emit_tool(&mut self, index: usize, force: bool) -> Vec<Bytes> {
        let Some(mut tool) = self.tools.remove(&index) else {
            return Vec::new();
        };
        if force {
            if tool.call_id.is_empty() {
                tool.call_id = format!(
                    "call_{}",
                    short_hash(format!("{}:{index}", self.response_id).as_bytes())
                );
            }
            if tool.name.is_empty() {
                tool.name = format!("unknown_tool_{index}");
            }
        }
        if tool.name.is_empty() || tool.call_id.is_empty() {
            self.tools.insert(index, tool);
            return Vec::new();
        }
        let mut events = Vec::new();
        if !tool.emitted {
            tool.emitted = true;
            let mut item = response_tool_item(
                &json!({
                    "id": tool.call_id,
                    "function": { "name": tool.name, "arguments": "" },
                }),
                index,
                &self.context,
            );
            if let Some(item) = item.as_object_mut() {
                item.insert(
                    "status".to_string(),
                    Value::String("in_progress".to_string()),
                );
            }
            if let Some(slot) = self.output.get_mut(tool.output_index) {
                *slot = item.clone();
            }
            events.push(self.event(
                "response.output_item.added",
                json!({
                    "type": "response.output_item.added",
                    "output_index": tool.output_index,
                    "item": item,
                }),
            ));
        }
        if tool.arguments.len() > tool.emitted_arguments_len {
            let delta = tool.arguments[tool.emitted_arguments_len..].to_string();
            tool.emitted_arguments_len = tool.arguments.len();
            let event_name = if matches!(
                self.context.tool_by_chat_name.get(&tool.name),
                Some(ToolKind::Custom { .. })
            ) {
                "response.custom_tool_call_input.delta"
            } else {
                "response.function_call_arguments.delta"
            };
            events.push(self.event(
                event_name,
                json!({
                    "type": event_name,
                    "item_id": stream_tool_item_id(&tool, index, &self.context),
                    "output_index": tool.output_index,
                    "delta": delta,
                }),
            ));
        }
        self.tools.insert(index, tool);
        events
    }

    fn complete(&mut self) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        let mut events = Vec::new();
        let tool_order = self.tool_order.clone();
        for index in tool_order {
            events.extend(self.emit_tool(index, true));
        }
        if let Some(output_index) = self.message_index {
            if self.text_started {
                events.push(self.event(
                    "response.output_text.done",
                    json!({
                        "type": "response.output_text.done",
                        "item_id": self.message_id,
                        "output_index": output_index,
                        "content_index": 0,
                        "text": self.text,
                        "logprobs": [],
                    }),
                ));
                events.push(self.event("response.content_part.done", json!({
                    "type": "response.content_part.done",
                    "item_id": self.message_id,
                    "output_index": output_index,
                    "content_index": 0,
                    "part": { "type": "output_text", "text": self.text, "annotations": [], "logprobs": [] },
                })));
            }
            let item = json!({
                "id": self.message_id,
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": if self.text_started {
                    vec![json!({ "type": "output_text", "text": self.text, "annotations": [], "logprobs": [] })]
                } else { Vec::<Value>::new() },
            });
            if let Some(slot) = self.output.get_mut(output_index) {
                *slot = item.clone();
            }
            events.push(self.event(
                "response.output_item.done",
                json!({
                    "type": "response.output_item.done", "output_index": output_index, "item": item,
                }),
            ));
        }
        for index in self.tool_order.clone() {
            let Some(tool) = self.tools.get(&index).cloned() else {
                continue;
            };
            let item = response_tool_item(
                &json!({
                    "id": tool.call_id,
                    "function": { "name": tool.name, "arguments": tool.arguments },
                }),
                index,
                &self.context,
            );
            if let Some(slot) = self.output.get_mut(tool.output_index) {
                *slot = item.clone();
            }
            let is_custom = item.get("type").and_then(Value::as_str) == Some("custom_tool_call");
            let done_type = if is_custom {
                "response.custom_tool_call_input.done"
            } else {
                "response.function_call_arguments.done"
            };
            events.push(self.event(
                done_type,
                json!({
                    "type": done_type,
                    "item_id": item.get("id"),
                    "output_index": tool.output_index,
                    if is_custom { "input" } else { "arguments" }:
                        if is_custom { item.get("input") } else { item.get("arguments") },
                }),
            ));
            events.push(self.event("response.output_item.done", json!({
                "type": "response.output_item.done", "output_index": tool.output_index, "item": item,
            })));
        }
        self.terminal = true;
        let status = if matches!(
            self.finish_reason.as_deref(),
            Some("length" | "content_filter")
        ) {
            "incomplete"
        } else {
            "completed"
        };
        events.push(self.event(
            "response.completed",
            json!({
                "type": "response.completed", "response": self.response_snapshot(status),
            }),
        ));
        events
    }

    fn fail(&mut self, message: &str) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        let mut events = if self.created {
            Vec::new()
        } else {
            self.start_events()
        };
        let error = json!({
            "type": "server_error", "code": "responses_via_chat_conversion_failed", "message": message,
        });
        events.push(self.event(
            "error",
            json!({
                "type": "error", "code": "responses_via_chat_conversion_failed", "message": message,
            }),
        ));
        self.terminal = true;
        events.push(self.event(
            "response.failed",
            json!({
                "type": "response.failed",
                "response": {
                    "id": self.response_id,
                    "object": "response",
                    "created_at": self.created_at,
                    "status": "failed",
                    "error": error,
                    "output": self.output,
                    "model": self.model,
                    "usage": self.usage,
                },
            }),
        ));
        events
    }

    fn response_snapshot(&self, status: &str) -> Value {
        json!({
            "id": self.response_id,
            "object": "response",
            "created_at": self.created_at,
            "status": status,
            "error": Value::Null,
            "incomplete_details": match self.finish_reason.as_deref() {
                Some("length") => json!({ "reason": "max_output_tokens" }),
                Some("content_filter") => json!({ "reason": "content_filter" }),
                _ => Value::Null,
            },
            "model": self.model,
            "output": self.output,
            "parallel_tool_calls": true,
            "usage": self.usage,
            "metadata": {},
        })
    }

    fn event(&mut self, event_name: &str, mut value: Value) -> Bytes {
        if let Some(object) = value.as_object_mut() {
            object.insert("sequence_number".to_string(), Value::from(self.sequence));
        }
        self.sequence = self.sequence.saturating_add(1);
        let data = serde_json::to_string(&value).unwrap_or_else(|_| {
            "{\"type\":\"error\",\"code\":\"conversion_encode_failed\"}".to_string()
        });
        Bytes::from(format!("event: {event_name}\ndata: {data}\n\n"))
    }
}

fn stream_tool_item_id(tool: &StreamToolCall, index: usize, context: &ConversionContext) -> String {
    response_tool_item(
        &json!({
            "id": tool.call_id,
            "function": { "name": tool.name, "arguments": tool.arguments },
        }),
        index,
        context,
    )
    .get("id")
    .and_then(Value::as_str)
    .unwrap_or("fc_missing")
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_conversion_preserves_order_and_adjacency() {
        let converted = responses_request_to_chat(
            br#"{
                "model":"codex",
                "instructions":"be precise",
                "input":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},
                    {"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\"q\":1}"},
                    {"type":"custom_tool_call","call_id":"call_2","name":"shell","input":"pwd"},
                    {"type":"function_call_output","call_id":"call_1","output":"ok"},
                    {"type":"custom_tool_call_output","call_id":"call_2","output":"/tmp"}
                ],
                "tools":[
                    {"type":"function","name":"lookup","parameters":{"type":"object"}},
                    {"type":"custom","name":"shell"}
                ]
            }"#,
            "upstream-codex",
            None,
        )
        .expect("convert request");
        let chat: Value = serde_json::from_slice(&converted.body).expect("chat JSON");
        let messages = chat["messages"].as_array().expect("messages");
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[2]["tool_calls"].as_array().map(Vec::len), Some(2));
        assert_eq!(messages[3]["tool_call_id"], "call_1");
        assert_eq!(messages[4]["tool_call_id"], "call_2");
    }

    #[test]
    fn request_conversion_maps_images_and_warns_for_files() {
        let converted = responses_request_to_chat(
            br#"{
                "model":"vision",
                "input":[{"type":"message","role":"user","content":[
                    {"type":"input_text","text":"inspect"},
                    {"type":"input_image","image_url":"https://example.test/a.png","detail":"high"},
                    {"type":"input_file","file_id":"file_1"}
                ]}]
            }"#,
            "vision",
            None,
        )
        .expect("convert request");
        let chat: Value = serde_json::from_slice(&converted.body).expect("chat JSON");
        assert_eq!(chat["messages"][0]["content"][1]["type"], "image_url");
        assert!(
            converted
                .context
                .warnings
                .contains(&"dropped_file_content".to_string())
        );
    }

    #[test]
    fn function_tool_name_remains_stable_without_collision() {
        let converted = responses_request_to_chat(
            br#"{
                "model":"codex",
                "input":"hello",
                "tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}]
            }"#,
            "codex",
            None,
        )
        .expect("convert request");
        let chat: Value = serde_json::from_slice(&converted.body).expect("chat JSON");

        assert_eq!(chat["tools"][0]["function"]["name"], "lookup");
    }

    #[test]
    fn generated_tool_name_avoids_later_reserved_function_name() {
        let converted = responses_request_to_chat(
            br#"{
                "model":"codex",
                "input":"hello",
                "tools":[
                    {"type":"custom","name":"shell"},
                    {"type":"function","name":"lg_custom_shell","parameters":{"type":"object"}}
                ]
            }"#,
            "codex",
            None,
        )
        .expect("convert request");
        let chat: Value = serde_json::from_slice(&converted.body).expect("chat JSON");
        let names = chat["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|tool| tool["function"]["name"].as_str().expect("tool name"))
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["lg_custom_shell_0_1", "lg_custom_shell"]);
    }

    #[test]
    fn previous_response_id_is_rejected() {
        let error = responses_request_to_chat(
            br#"{"model":"x","previous_response_id":"resp_1","input":"hi"}"#,
            "x",
            None,
        )
        .expect_err("previous response must fail");
        assert!(error.contains("native Responses"));
    }

    #[test]
    fn non_stream_response_restores_custom_tool() {
        let converted = responses_request_to_chat(
            br#"{"model":"x","input":"hi","tools":[{"type":"custom","name":"shell"}]}"#,
            "x",
            None,
        )
        .expect("request");
        let chat_name = converted
            .context
            .chat_name_by_response_name
            .get("shell")
            .expect("mapped name");
        let body = serde_json::to_vec(&json!({
            "id":"chatcmpl_1",
            "created":1,
            "model":"x",
            "choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{
                "id":"call_1","type":"function","function":{"name":chat_name,"arguments":"{\"input\":\"pwd\"}"}
            }]}}],
            "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}
        }))
        .expect("chat response");
        let response = chat_response_to_responses(&body, &converted.context).expect("response");
        let response: Value = serde_json::from_slice(&response).expect("response JSON");
        assert_eq!(response["output"][0]["type"], "custom_tool_call");
        assert_eq!(response["output"][0]["name"], "shell");
        assert_eq!(response["output"][0]["input"], "pwd");
    }

    #[test]
    fn stream_decoder_handles_crlf_multiline_and_parallel_tools() {
        let context = ConversionContext::default();
        let mut stream = ChatSseToResponses::new(context, 64 * 1024);
        let first = b": keepalive\r\ndata: {\"id\":\"chatcmpl_1\",\"created\":1,\"model\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"one\",\"arguments\":\"{\"}},{\"index\":1,\"function\":{\"arguments\":\"{\\\"x\\\":\"}}]},\"finish_reason\":null}]}\r\n\r\n";
        let split = first.len() / 2;
        assert!(stream.push(&first[..split]).is_empty());
        let mut output = stream.push(&first[split..]);
        output.extend(stream.push(b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"two\",\"arguments\":\"1}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\r\n\r\ndata: [DONE]\r\n\r\n"));
        let joined = output
            .iter()
            .map(|chunk| String::from_utf8_lossy(chunk))
            .collect::<String>();
        assert!(joined.contains("response.created"));
        assert!(joined.contains("response.function_call_arguments.delta"));
        assert!(joined.contains("response.completed"));
        assert!(joined.contains("call_b"));
    }

    #[test]
    fn interrupted_stream_fails_without_completed() {
        let mut stream = ChatSseToResponses::new(ConversionContext::default(), 4096);
        let mut output = stream.push(
            b"data: {\"id\":\"chatcmpl_1\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n",
        );
        output.extend(stream.finish());
        let joined = output
            .iter()
            .map(|chunk| String::from_utf8_lossy(chunk))
            .collect::<String>();
        assert!(joined.contains("response.failed"));
        assert!(!joined.contains("event: response.completed"));
    }
}
