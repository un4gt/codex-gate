//! Anthropic Messages clients on a native HTTP Responses upstream.
use std::collections::{BTreeMap, BTreeSet, VecDeque};

use bytes::Bytes;
use serde_json::{Value, json};

use crate::affinity::AffinityIdentity;
use crate::messages_via_chat::{ConversionContext, ConvertedRequest};
use crate::response_events::{SseDecoder, anthropic_reasoning_effort, parse_usage};
use crate::types::Usage;

pub(crate) fn messages_request_to_responses(
    body: &[u8],
    upstream_model: &str,
    affinity: Option<&AffinityIdentity>,
) -> Result<ConvertedRequest, String> {
    convert_request(body, upstream_model, affinity, false)
}

pub(crate) fn messages_count_to_responses(
    body: &[u8],
    upstream_model: &str,
) -> Result<ConvertedRequest, String> {
    convert_request(body, upstream_model, None, true)
}

fn convert_request(
    body: &[u8],
    upstream_model: &str,
    affinity: Option<&AffinityIdentity>,
    count_tokens: bool,
) -> Result<ConvertedRequest, String> {
    let root: Value = serde_json::from_slice(body).map_err(|err| err.to_string())?;
    let object = root
        .as_object()
        .ok_or("Messages request must be an object")?;
    let max_tokens = if count_tokens {
        None
    } else {
        Some(
            root["max_tokens"]
                .as_u64()
                .filter(|count| *count > 0)
                .ok_or("Responses conversion requires positive max_tokens")?,
        )
    };
    let messages = root["messages"]
        .as_array()
        .ok_or("messages must be an array")?;
    let mut context = ConversionContext::default();
    let mut input = Vec::new();
    for message in messages {
        let role = field(message, "role")?;
        if !matches!(role, "user" | "assistant" | "system") {
            return Err(format!("unsupported Messages role: {role}"));
        }
        let mut parts = Vec::new();
        if let Some(text) = message["content"].as_str() {
            parts.push(text_part(role, text));
        } else {
            let blocks = message["content"]
                .as_array()
                .ok_or("invalid message content")?;
            for block in blocks {
                if block.get("cache_control").is_some() {
                    context.warn("dropped_cache_control");
                }
                match (role, field(block, "type")?) {
                    (_, "text") => parts.push(text_part(role, field(block, "text")?)),
                    ("user", "image") => parts.push(input_image(block)?),
                    ("assistant", "tool_use") => {
                        flush_message(&mut input, &mut parts, role);
                        let args = block["input"]
                            .as_object()
                            .ok_or("tool_use.input must be an object")?;
                        input.push(json!({
                            "type": "function_call", "call_id": field(block, "id")?,
                            "name": field(block, "name")?, "arguments": args_to_string(args)?,
                        }));
                    }
                    ("user", "tool_result") => {
                        flush_message(&mut input, &mut parts, role);
                        let output = tool_output(block, &mut context)?;
                        input.push(json!({
                            "type": "function_call_output", "call_id": field(block, "tool_use_id")?,
                            "output": output,
                        }));
                    }
                    (_, kind) => return Err(format!("unsupported {role} content block: {kind}")),
                }
            }
        }
        flush_message(&mut input, &mut parts, role);
    }
    if input.is_empty() {
        return Err("Messages request has no convertible input".into());
    }

    let mut out = json!({"model": upstream_model, "input": input});
    if let Some(max_tokens) = max_tokens {
        out["max_output_tokens"] = json!(max_tokens);
        out["stream"] = json!(root["stream"].as_bool().unwrap_or(false));
        out["store"] = json!(false);
    }
    if let Some(system) = object.get("system").filter(|value| !value.is_null()) {
        let instructions = if let Some(text) = system.as_str() {
            text.to_owned()
        } else {
            let blocks = system
                .as_array()
                .ok_or("system must be text or text blocks")?;
            let mut parts = Vec::with_capacity(blocks.len());
            for block in blocks {
                if field(block, "type")? != "text" {
                    return Err("system only supports text blocks".into());
                }
                if block.get("cache_control").is_some() {
                    context.warn("dropped_cache_control");
                }
                parts.push(field(block, "text")?);
            }
            parts.join("\n\n")
        };
        out["instructions"] = json!(instructions);
    }
    if let Some(tools) = root["tools"].as_array().filter(|tools| !tools.is_empty()) {
        let mut definitions = Vec::with_capacity(tools.len());
        for tool in tools {
            if tool.get("cache_control").is_some() {
                context.warn("dropped_cache_control");
            }
            let schema = tool["input_schema"]
                .as_object()
                .ok_or("only function tools with an input_schema are supported")?;
            let mut definition = json!({
                "type": "function", "name": field(tool, "name")?, "parameters": schema,
                "strict": tool["strict"].as_bool().unwrap_or(false),
            });
            if let Some(description) = tool["description"].as_str() {
                definition["description"] = json!(description);
            }
            definitions.push(definition);
        }
        out["tools"] = json!(definitions);
        if let Some(choice) = object.get("tool_choice").filter(|value| !value.is_null()) {
            out["tool_choice"] = match field(choice, "type")? {
                "auto" => json!("auto"),
                "any" => json!("required"),
                "none" => json!("none"),
                "tool" => json!({"type": "function", "name": field(choice, "name")?}),
                kind => return Err(format!("unsupported tool choice: {kind}")),
            };
            if !count_tokens && choice["disable_parallel_tool_use"] == true {
                out["parallel_tool_calls"] = json!(false);
            }
        }
    }
    if count_tokens {
        return Ok(ConvertedRequest {
            body: Bytes::from(serde_json::to_vec(&out).map_err(|err| err.to_string())?),
            context,
        });
    }
    if let Some(effort) = anthropic_reasoning_effort(object)
        && root.pointer("/thinking/type").and_then(Value::as_str) != Some("disabled")
    {
        let effort = if effort == "max" { "xhigh" } else { &effort };
        out["reasoning"] = json!({"effort": effort});
    }
    for name in ["temperature", "top_p"] {
        if let Some(value) = object.get(name).filter(|value| !value.is_null()) {
            out[name] = value.clone();
        }
    }
    if let Some(format) = root
        .pointer("/output_config/format")
        .filter(|value| !value.is_null())
    {
        if field(format, "type")? != "json_schema" || !format["schema"].is_object() {
            return Err("invalid structured output format".into());
        }
        out["text"] = json!({"format": {
            "type": "json_schema", "name": "response", "schema": format["schema"], "strict": true,
        }});
    }
    if root["stop_sequences"]
        .as_array()
        .is_some_and(|values| !values.is_empty())
    {
        return Err("Responses conversion does not support stop_sequences".into());
    }
    if root.get("top_k").is_some() {
        context.warn("dropped_top_k");
    }
    if root.get("cache_control").is_some() {
        context.warn("dropped_cache_control");
    }
    if let Some(affinity) = affinity {
        out["prompt_cache_key"] = json!(affinity.derived_prompt_cache_key());
    }
    Ok(ConvertedRequest {
        body: Bytes::from(serde_json::to_vec(&out).map_err(|err| err.to_string())?),
        context,
    })
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("missing or invalid {key}"))
}

fn args_to_string(args: &serde_json::Map<String, Value>) -> Result<String, String> {
    serde_json::to_string(args).map_err(|err| err.to_string())
}

fn flush_message(input: &mut Vec<Value>, parts: &mut Vec<Value>, role: &str) {
    if !parts.is_empty() {
        input.push(json!({"type": "message", "role": role, "content": std::mem::take(parts)}));
    }
}

fn text_part(role: &str, text: &str) -> Value {
    if role == "assistant" {
        json!({"type": "output_text", "text": text, "annotations": []})
    } else {
        json!({"type": "input_text", "text": text})
    }
}

fn input_image(block: &Value) -> Result<Value, String> {
    let source = &block["source"];
    let url = match field(source, "type")? {
        "url" => field(source, "url")?.to_owned(),
        "base64" => format!(
            "data:{};base64,{}",
            field(source, "media_type")?,
            field(source, "data")?
        ),
        kind => return Err(format!("unsupported image source: {kind}")),
    };
    Ok(json!({"type": "input_image", "image_url": url, "detail": "auto"}))
}

fn tool_output(block: &Value, context: &mut ConversionContext) -> Result<Value, String> {
    let content = &block["content"];
    let failed = block["is_error"] == true;
    if let Some(text) = content.as_str() {
        return Ok(if failed {
            json!(format!("Tool execution failed:\n{text}"))
        } else {
            json!(text)
        });
    }
    let mut parts = Vec::new();
    if failed {
        parts.push(text_part("user", "Tool execution failed:"));
    }
    if !content.is_null() {
        for part in content.as_array().ok_or("invalid tool_result content")? {
            if part.get("cache_control").is_some() {
                context.warn("dropped_cache_control");
            }
            parts.push(match field(part, "type")? {
                "text" => text_part("user", field(part, "text")?),
                "image" => input_image(part)?,
                kind => return Err(format!("unsupported tool result content: {kind}")),
            });
        }
    }
    if parts.is_empty() {
        Ok(json!(""))
    } else {
        Ok(json!(parts))
    }
}

#[derive(PartialEq, Eq)]
enum BlockKind {
    Text { refusal: bool },
    Tool { id: String, name: String },
}

impl BlockKind {
    fn tool(item: &Value) -> Result<Self, String> {
        Ok(Self::Tool {
            id: field(item, "call_id")?.into(),
            name: field(item, "name")?.into(),
        })
    }

    fn render(&self, value: &str) -> Result<Value, String> {
        match self {
            Self::Text { .. } => Ok(json!({"type": "text", "text": value})),
            Self::Tool { id, name } => Ok(json!({
                "type": "tool_use", "id": id, "name": name, "input": parse_arguments(value)?,
            })),
        }
    }
}

fn parse_arguments(value: &str) -> Result<Value, String> {
    let input: Value =
        serde_json::from_str(value).map_err(|_| "invalid Responses tool arguments")?;
    if !input.is_object() {
        return Err("Responses tool arguments must be an object".into());
    }
    Ok(input)
}

pub(crate) fn parse_reported_usage(value: &Value) -> Option<Usage> {
    if value["input_tokens"].as_i64()? < 0 || value["output_tokens"].as_i64()? < 0 {
        return None;
    }
    parse_usage(value)
}

pub(crate) fn reported_event_usage(value: &Value) -> Option<Usage> {
    value
        .pointer("/response/usage")
        .and_then(parse_reported_usage)
        .or_else(|| parse_reported_usage(&value["usage"]))
}

fn render_usage(report: Option<Usage>) -> Value {
    let usage = report.unwrap_or_default();
    let mut value = json!({
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_creation_input_tokens": usage.cache_creation_input_tokens,
        "cache_read_input_tokens": usage.cache_read_input_tokens,
    });
    if usage.reasoning_output_tokens > 0 {
        value["output_tokens_details"] = json!({"thinking_tokens": usage.reasoning_output_tokens});
    }
    value
}

fn stop_reason(response: &Value, has_tools: bool, refused: bool) -> Result<&'static str, String> {
    match field(response, "status")? {
        "completed" if has_tools => Ok("tool_use"),
        "completed" if refused => Ok("refusal"),
        "completed" => Ok("end_turn"),
        "incomplete" => match response
            .pointer("/incomplete_details/reason")
            .and_then(Value::as_str)
        {
            Some("max_output_tokens") => Ok("max_tokens"),
            Some("content_filter") => Ok("refusal"),
            _ => Err(
                "Responses upstream reported incomplete output without a supported reason".into(),
            ),
        },
        _ => Err(error_message(response).into()),
    }
}

fn error_message(value: &Value) -> &str {
    value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("Responses upstream did not complete")
}

type BlockKey = (usize, Option<usize>);

fn output_parts(
    item: &Value,
    output_index: usize,
) -> Result<Vec<(BlockKey, BlockKind, &str)>, String> {
    match field(item, "type")? {
        "message" => item["content"]
            .as_array()
            .ok_or("invalid Responses message content")?
            .iter()
            .enumerate()
            .map(|(index, part)| {
                let (kind, value) = output_text(part)?;
                Ok(((output_index, Some(index)), kind, value))
            })
            .collect(),
        "function_call" => Ok(vec![(
            (output_index, None),
            BlockKind::tool(item)?,
            field(item, "arguments")?,
        )]),
        "reasoning" => Ok(Vec::new()),
        kind => Err(format!("unsupported Responses output item: {kind}")),
    }
}

fn output_text(part: &Value) -> Result<(BlockKind, &str), String> {
    match field(part, "type")? {
        "output_text" => Ok((BlockKind::Text { refusal: false }, field(part, "text")?)),
        "refusal" => Ok((BlockKind::Text { refusal: true }, field(part, "refusal")?)),
        kind => Err(format!("unsupported Responses content part: {kind}")),
    }
}

fn indexed_parts(response: &Value) -> Result<Vec<(BlockKey, BlockKind, &str)>, String> {
    let mut parts = Vec::new();
    for (index, item) in response["output"]
        .as_array()
        .ok_or("missing Responses output array")?
        .iter()
        .enumerate()
    {
        if item["type"] == "function_call" {
            let unfinished = matches!(item["status"].as_str(), Some("in_progress" | "incomplete"));
            if response["status"] == "incomplete"
                && (unfinished
                    || item["arguments"]
                        .as_str()
                        .is_none_or(|arguments| parse_arguments(arguments).is_err()))
            {
                continue;
            }
            if unfinished {
                return Err("Responses tool call did not complete".into());
            }
        }
        parts.extend(output_parts(item, index)?);
    }
    Ok(parts)
}

pub(crate) fn responses_response_to_messages(
    response: &Value,
    model: &str,
) -> Result<Bytes, String> {
    let parts = indexed_parts(response)?;
    let has_tools = parts
        .iter()
        .any(|(_, kind, _)| matches!(kind, BlockKind::Tool { .. }));
    let refused = parts
        .iter()
        .any(|(_, kind, _)| matches!(kind, BlockKind::Text { refusal: true }));
    let reason = stop_reason(response, has_tools, refused)?;
    let content = parts
        .into_iter()
        .map(|(_, kind, value)| kind.render(value))
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::to_vec(&json!({
        "id": field(response, "id")?, "type": "message", "role": "assistant", "model": model,
        "content": content, "stop_reason": reason, "stop_sequence": null,
        "usage": render_usage(parse_reported_usage(&response["usage"])),
    }))
    .map(Bytes::from)
    .map_err(|err| err.to_string())
}

#[derive(PartialEq, Eq)]
enum BlockState {
    Streaming,
    Complete,
    Incomplete,
}

struct Block {
    index: Option<usize>,
    kind: BlockKind,
    value: String,
    sent: usize,
    state: BlockState,
}

pub(crate) struct ResponsesSseToMessages {
    decoder: SseDecoder,
    model: String,
    started: bool,
    terminal: bool,
    blocks: BTreeMap<BlockKey, Block>,
    pending: VecDeque<BlockKey>,
    item_ids: BTreeMap<usize, String>,
    next_index: usize,
    reported_usage: Option<Usage>,
    retained_bytes: usize,
    max_bytes: usize,
}

impl ResponsesSseToMessages {
    pub(crate) fn new(model: &str, max_bytes: usize) -> Self {
        Self {
            decoder: SseDecoder::default(),
            model: model.into(),
            started: false,
            terminal: false,
            blocks: BTreeMap::new(),
            pending: VecDeque::new(),
            item_ids: BTreeMap::new(),
            next_index: 0,
            reported_usage: None,
            retained_bytes: 0,
            max_bytes,
        }
    }

    pub(crate) fn is_terminal(&self) -> bool {
        self.terminal
    }

    pub(crate) fn reported_usage(&self) -> Option<Usage> {
        self.reported_usage
    }

    pub(crate) fn push(&mut self, body: &[u8]) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        let events = self.decoder.push_bytes_until_error(body);
        self.process(events)
    }

    pub(crate) fn finish(&mut self) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        let events = self.decoder.finish();
        let mut out = self.process(events);
        out.extend(self.fail_stream("Responses stream ended before a terminal event"));
        out
    }

    pub(crate) fn fail_stream(&mut self, message: &str) -> Vec<Bytes> {
        if self.terminal {
            return Vec::new();
        }
        self.terminal = true;
        vec![event(
            "error",
            json!({"error": {"type": "api_error", "message": message}}),
        )]
    }

    fn process(&mut self, events: Vec<Value>) -> Vec<Bytes> {
        let mut out = Vec::new();
        for value in events {
            if self.terminal {
                break;
            }
            if let Some(usage) = reported_event_usage(&value) {
                self.reported_usage = Some(usage);
            }
            if let Err(error) = self.convert(&value, &mut out) {
                out.extend(self.fail_stream(&error));
            }
        }
        if let Some(error) = self.decoder.error.take() {
            out.extend(self.fail_stream(&error));
        }
        out
    }

    fn convert(&mut self, value: &Value, out: &mut Vec<Bytes>) -> Result<(), String> {
        if value.get("output_index").is_some()
            && let Some(id) = value["item_id"]
                .as_str()
                .or_else(|| value.pointer("/item/id").and_then(Value::as_str))
        {
            self.observe_item_id(index(value, "output_index")?, id)?;
        }

        match field(value, "type")? {
            "response.created" | "response.in_progress" => self.start(&value["response"], out)?,
            "response.output_item.added" if value["item"]["type"] == "function_call" => {
                self.begin(
                    (index(value, "output_index")?, None),
                    BlockKind::tool(&value["item"])?,
                )?;
            }
            "response.content_part.added" | "response.content_part.done" => {
                let key = text_key(value)?;
                let (kind, text) = output_text(&value["part"])?;
                self.begin(key, kind)?;
                if value["type"] == "response.content_part.done" {
                    self.settle(key, text)?;
                } else {
                    self.append(key, text)?;
                }
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                let key = text_key(value)?;
                self.begin(
                    key,
                    BlockKind::Text {
                        refusal: value["type"] == "response.refusal.delta",
                    },
                )?;
                self.append(key, field(value, "delta")?)?;
            }
            "response.function_call_arguments.delta" => {
                self.append(
                    (index(value, "output_index")?, None),
                    field(value, "delta")?,
                )?;
            }
            "response.output_text.done" | "response.refusal.done" => {
                let key = text_key(value)?;
                let refusal = value["type"] == "response.refusal.done";
                self.begin(key, BlockKind::Text { refusal })?;
                self.settle(key, field(value, if refusal { "refusal" } else { "text" })?)?;
            }
            "response.function_call_arguments.done" => {
                self.reconcile(
                    (index(value, "output_index")?, None),
                    field(value, "arguments")?,
                )?;
            }
            "response.output_item.done" => {
                let item = &value["item"];
                let output_index = index(value, "output_index")?;
                if item["type"] == "function_call"
                    && matches!(item["status"].as_str(), Some("in_progress" | "incomplete"))
                {
                    if let Some(block) = self.blocks.get_mut(&(output_index, None)) {
                        if block.index.is_some() {
                            return Err("Responses truncated an emitted tool call".into());
                        }
                        block.state = BlockState::Incomplete;
                    }
                } else {
                    for (key, kind, value) in output_parts(item, output_index)? {
                        self.begin(key, kind)?;
                        self.settle(key, value)?;
                    }
                }
            }
            "response.completed" | "response.incomplete" | "response.done" => {
                return self.complete(&value["response"], out);
            }
            "error" => return Err(error_message(value).into()),
            "response.failed" | "response.cancelled" | "response.canceled" => {
                return Err(error_message(&value["response"]).into());
            }
            _ => {}
        }
        self.flush_blocks(out)
    }

    fn start(&mut self, response: &Value, out: &mut Vec<Bytes>) -> Result<(), String> {
        if !self.started {
            out.push(event("message_start", json!({"message": {
                "id": field(response, "id")?, "type": "message", "role": "assistant", "model": self.model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": render_usage(self.reported_usage),
            }})));
            self.started = true;
        }
        Ok(())
    }

    fn observe_item_id(&mut self, output_index: usize, id: &str) -> Result<(), String> {
        if let Some(existing) = self.item_ids.get(&output_index) {
            if existing != id {
                return Err("Responses output item changed ID".into());
            }
        } else {
            if self.item_ids.len() >= 4096 {
                return Err("Responses output contains too many items".into());
            }
            self.retain_bytes(id.len())?;
            self.item_ids.insert(output_index, id.to_owned());
        }
        Ok(())
    }

    fn retain_bytes(&mut self, bytes: usize) -> Result<(), String> {
        self.retained_bytes = self.retained_bytes.saturating_add(bytes);
        if self.retained_bytes > self.max_bytes {
            return Err("Responses output exceeded conversion buffer".into());
        }
        Ok(())
    }

    fn begin(&mut self, key: BlockKey, kind: BlockKind) -> Result<(), String> {
        if !self.started {
            return Err("Responses stream emitted content before response.created".into());
        }
        if let Some(block) = self.blocks.get(&key) {
            return if block.kind == kind {
                Ok(())
            } else {
                Err("Responses content block changed type or ID".into())
            };
        }
        if self.blocks.len() >= 4096 {
            return Err("Responses output contains too many blocks".into());
        }
        if let BlockKind::Tool { id, name } = &kind {
            self.retain_bytes(id.len().saturating_add(name.len()))?;
        }
        self.pending.push_back(key);
        self.blocks.insert(
            key,
            Block {
                index: None,
                kind,
                value: String::new(),
                sent: 0,
                state: BlockState::Streaming,
            },
        );
        Ok(())
    }

    fn append(&mut self, key: BlockKey, delta: &str) -> Result<(), String> {
        if delta.is_empty() {
            return Ok(());
        }
        self.retain_bytes(delta.len())?;
        let block = self
            .blocks
            .get_mut(&key)
            .ok_or("Responses delta without content block")?;
        if block.state != BlockState::Streaming {
            return Err("Responses delta after content block ended".into());
        }
        block.value.push_str(delta);
        Ok(())
    }

    fn reconcile(&mut self, key: BlockKey, value: &str) -> Result<(), String> {
        let block = self
            .blocks
            .get(&key)
            .ok_or("Responses completion without content block")?;
        let suffix = value
            .strip_prefix(&block.value)
            .ok_or("Responses final content differs from its deltas")?;
        self.append(key, suffix)
    }

    fn settle(&mut self, key: BlockKey, value: &str) -> Result<(), String> {
        let block = self
            .blocks
            .get(&key)
            .ok_or("Responses completion without content block")?;
        if block.state == BlockState::Incomplete {
            return Err("Responses marked an incomplete block complete".into());
        }
        if block.state == BlockState::Streaming && matches!(block.kind, BlockKind::Tool { .. }) {
            parse_arguments(value)?;
        }
        self.reconcile(key, value)?;
        self.blocks
            .get_mut(&key)
            .ok_or("missing Responses content block")?
            .state = BlockState::Complete;
        Ok(())
    }

    fn flush_blocks(&mut self, out: &mut Vec<Bytes>) -> Result<(), String> {
        while let Some(key) = self.pending.front() {
            let block = self
                .blocks
                .get_mut(key)
                .ok_or("missing queued Responses block")?;
            if block.state == BlockState::Incomplete {
                break;
            }
            let index = if let Some(index) = block.index {
                index
            } else {
                let index = self.next_index;
                self.next_index += 1;
                block.index = Some(index);
                let content =
                    block
                        .kind
                        .render(if matches!(block.kind, BlockKind::Tool { .. }) {
                            "{}"
                        } else {
                            ""
                        })?;
                out.push(event(
                    "content_block_start",
                    json!({"index": index, "content_block": content}),
                ));
                index
            };
            if block.sent < block.value.len() {
                let suffix = &block.value[block.sent..];
                let delta = match block.kind {
                    BlockKind::Text { .. } => json!({"type": "text_delta", "text": suffix}),
                    BlockKind::Tool { .. } => {
                        json!({"type": "input_json_delta", "partial_json": suffix})
                    }
                };
                out.push(event(
                    "content_block_delta",
                    json!({"index": index, "delta": delta}),
                ));
                block.sent = block.value.len();
            }
            if block.state != BlockState::Complete {
                break;
            }
            out.push(event("content_block_stop", json!({"index": index})));
            self.pending.pop_front();
        }
        Ok(())
    }

    fn complete(&mut self, response: &Value, out: &mut Vec<Bytes>) -> Result<(), String> {
        let parts = indexed_parts(response)?;
        let has_tools = parts
            .iter()
            .any(|(_, kind, _)| matches!(kind, BlockKind::Tool { .. }));
        let refused = parts
            .iter()
            .any(|(_, kind, _)| matches!(kind, BlockKind::Text { refusal: true }));
        let reason = stop_reason(response, has_tools, refused)?;
        self.start(response, out)?;
        if let Some(items) = response["output"].as_array() {
            for (output_index, item) in items.iter().enumerate() {
                if let Some(id) = item["id"].as_str() {
                    self.observe_item_id(output_index, id)?;
                }
            }
        }
        let listed: BTreeSet<_> = parts.iter().map(|(key, _, _)| *key).collect();
        if self.blocks.iter().any(|(key, block)| {
            let truncated_pending_tool = reason == "max_tokens"
                && block.index.is_none()
                && block.state != BlockState::Complete
                && matches!(block.kind, BlockKind::Tool { .. });
            !(listed.contains(key) || truncated_pending_tool)
        }) {
            return Err(
                "Responses terminal output omitted an emitted or complete content block".into(),
            );
        }
        self.blocks.retain(|key, _| listed.contains(key));
        self.pending.retain(|key| listed.contains(key));
        for (key, kind, value) in parts {
            self.begin(key, kind)?;
            self.settle(key, value)?;
        }
        self.flush_blocks(out)?;
        out.push(event(
            "message_delta",
            json!({
                "delta": {"stop_reason": reason, "stop_sequence": null},
                "usage": render_usage(self.reported_usage),
            }),
        ));
        out.push(event("message_stop", json!({})));
        self.terminal = true;
        Ok(())
    }
}

fn index(value: &Value, name: &str) -> Result<usize, String> {
    value[name]
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
        .ok_or_else(|| format!("Responses event missing {name}"))
}

fn text_key(value: &Value) -> Result<BlockKey, String> {
    Ok((
        index(value, "output_index")?,
        Some(index(value, "content_index")?),
    ))
}

fn event(kind: &str, mut value: Value) -> Bytes {
    value["type"] = json!(kind);
    Bytes::from(format!("event: {kind}\ndata: {value}\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_arguments_are_reconciled_without_repeating_deltas() {
        let mut bridge = ResponsesSseToMessages::new("alias", 4096);
        let call = json!({"type": "function_call", "id": "fc_read", "call_id": "call_read", "name": "Read", "arguments": "{\"file\":\"x\"}"});
        let mut upstream = Vec::new();
        for frame in [
            event("response.created", json!({"response": {"id": "resp_read"}})),
            event(
                "response.output_item.added",
                json!({"output_index": 0, "item": call}),
            ),
            event(
                "response.function_call_arguments.delta",
                json!({"output_index": 0, "delta": "{\"file\":"}),
            ),
            event(
                "response.function_call_arguments.done",
                json!({"output_index": 0, "arguments": call["arguments"]}),
            ),
            event(
                "response.output_item.done",
                json!({"output_index": 0, "item": call}),
            ),
            event(
                "response.completed",
                json!({"response": {"id": "resp_read", "status": "completed", "output": [call], "usage": {"input_tokens": 12, "output_tokens": 3, "input_tokens_details": {"cached_tokens": 4}}}}),
            ),
        ] {
            upstream.extend_from_slice(&frame);
        }
        let mut out = Vec::new();
        for chunk in upstream.chunks(29) {
            out.extend(bridge.push(chunk));
        }
        let mut downstream = SseDecoder::default();
        let events: Vec<_> = out
            .iter()
            .flat_map(|bytes| downstream.push_bytes(bytes))
            .collect();
        let names: Vec<_> = events
            .iter()
            .filter_map(|value| value["type"].as_str())
            .collect();
        assert_eq!(
            names,
            [
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop"
            ]
        );
        assert_eq!(events[1]["content_block"]["id"], "call_read");
        assert_eq!(events[3]["delta"]["partial_json"], "\"x\"}");
        assert_eq!(events[5]["delta"]["stop_reason"], "tool_use");
        assert_eq!(events[5]["usage"]["input_tokens"], 8);
        assert!(bridge.finish().is_empty());
    }

    #[test]
    fn truncated_stream_emits_an_error_instead_of_message_stop() {
        let mut bridge = ResponsesSseToMessages::new("alias", 1024);
        bridge.push(&event(
            "response.created",
            json!({"response": {"id": "resp_truncated"}}),
        ));
        let finish = bridge.finish();
        let frames = SseDecoder::default().push_bytes(&finish[0]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "error");
        assert!(bridge.is_terminal());
    }

    #[test]
    fn reported_usage_survives_malformed_event_in_the_same_chunk() {
        let mut bridge = ResponsesSseToMessages::new("alias", 4096);
        let mut chunk = event(
            "response.created",
            json!({"response": {
                "id": "resp_usage", "usage": {"input_tokens": 23, "output_tokens": 7}
            }}),
        )
        .to_vec();
        chunk.extend_from_slice(b"event: response.in_progress\ndata: {\n\n");
        chunk.extend_from_slice(&event(
            "response.completed",
            json!({"response": {
                "id": "resp_usage", "status": "completed", "output": [],
                "usage": {"input_tokens": 40, "output_tokens": 15}
            }}),
        ));
        let frames = bridge.push(&chunk);
        assert_eq!(frames.len(), 2);
        assert_eq!(
            SseDecoder::default().push_bytes(&frames[1])[0]["type"],
            "error"
        );
        let usage = bridge.reported_usage().unwrap();
        assert_eq!((usage.input_tokens, usage.output_tokens), (23, 7));
    }

    #[test]
    fn head_tool_emits_arguments_before_completion_and_rejects_conflicting_snapshot() {
        let mut bridge = ResponsesSseToMessages::new("alias", 4096);
        bridge.push(&event(
            "response.created",
            json!({"response": {"id": "resp_tools"}}),
        ));
        for (index, item_id, call_id) in [(0, "fc_a", "call_a"), (1, "fc_b", "call_b")] {
            let start = bridge.push(&event("response.output_item.added", json!({
                "output_index": index, "item": {"type": "function_call", "id": item_id, "call_id": call_id, "name": "Read"},
            })));
            assert_eq!(start.len(), usize::from(index == 0));
        }
        let frames = bridge.push(&event(
            "response.function_call_arguments.delta",
            json!({
                "output_index": 0, "item_id": "fc_a", "delta": "{\"file\":"
            }),
        ));
        let frame = &SseDecoder::default().push_bytes(&frames[0])[0];
        assert_eq!(frame["delta"]["partial_json"], "{\"file\":");
        let conflict = bridge.push(&event(
            "response.function_call_arguments.done",
            json!({
                "output_index": 0, "item_id": "fc_a", "arguments": "{\"path\":\"x\"}"
            }),
        ));
        assert_eq!(conflict.len(), 1);
        assert_eq!(
            SseDecoder::default().push_bytes(&conflict[0])[0]["type"],
            "error"
        );
        assert!(bridge.finish().is_empty());
    }

    #[test]
    fn unopened_truncated_tool_is_skipped_on_max_tokens() {
        let mut bridge = ResponsesSseToMessages::new("alias", 4096);
        let text = json!({"type": "output_text", "text": "x", "annotations": []});
        let tool = json!({"type": "function_call", "id": "fc_queued", "call_id": "call_queued", "name": "Read", "status": "incomplete", "arguments": "{"});
        bridge.push(&event(
            "response.created",
            json!({"response": {"id": "resp_queued"}}),
        ));
        bridge.push(&event(
            "response.content_part.added",
            json!({"output_index": 0, "item_id": "msg_head", "content_index": 0, "part": text}),
        ));
        assert!(
            bridge
                .push(&event(
                    "response.output_item.added",
                    json!({"output_index": 1, "item": tool})
                ))
                .is_empty()
        );
        let frames = bridge.push(&event("response.incomplete", json!({"response": {
            "id": "resp_queued", "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"},
            "output": [{"type": "message", "id": "msg_head", "content": [text]}, tool]
        }})));
        let events: Vec<_> = frames
            .iter()
            .flat_map(|frame| SseDecoder::default().push_bytes(frame))
            .collect();
        assert_eq!(
            events
                .iter()
                .map(|value| value["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["content_block_stop", "message_delta", "message_stop"]
        );
        assert_eq!(events[1]["delta"]["stop_reason"], "max_tokens");
    }

    #[test]
    fn truncated_tool_arguments_cannot_end_an_emitted_tool_block_successfully() {
        let call = json!({
            "type": "function_call", "id": "fc_read", "call_id": "call_read", "name": "Read",
            "status": "incomplete", "arguments": "{\"file\":",
        });
        let response = json!({
            "id": "resp_partial", "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"}, "output": [call],
        });
        let mut bridge = ResponsesSseToMessages::new("alias", 4096);
        for frame in [
            event(
                "response.created",
                json!({"response": {"id": "resp_partial"}}),
            ),
            event(
                "response.output_item.added",
                json!({"output_index": 0, "item": call}),
            ),
            event(
                "response.function_call_arguments.delta",
                json!({
                    "output_index": 0, "delta": call["arguments"],
                }),
            ),
        ] {
            bridge.push(&frame);
        }
        let frames = bridge.push(&event("response.incomplete", json!({"response": response})));
        assert_eq!(frames.len(), 1);
        let events = SseDecoder::default().push_bytes(&frames[0]);
        assert_eq!(events[0]["type"], "error");
        assert!(bridge.is_terminal());

        let body = responses_response_to_messages(&response, "alias").unwrap();
        let message: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(message["stop_reason"], "max_tokens");
        assert_eq!(message["content"], json!([]));
    }
}
