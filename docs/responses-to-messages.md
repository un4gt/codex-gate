# Responses → Messages 协议映射

`Responses → Messages` 指响应转换方向。Claude Code 向网关发 `POST /v1/messages`，网关把请求转换后发到上游 API base 下的 `POST /responses`，再把上游 JSON 或 SSE 转回 Anthropic Messages。Claude Code 可能带 `?beta=true`，网关按路径匹配。入站的 `anthropic-version`、`anthropic-beta` 和网关凭据在 Messages 侧解释。OpenAI 与 Vercel 的公开 base 分别是 `https://api.openai.com/v1` 和 `https://ai-gateway.vercel.sh/v1`，接收 `application/json` 请求并使用上游各自的 Bearer 凭据。Vercel 的公开接口使用 `provider/model` 模型 ID。 [Claude Code 网关协议][cc-protocol] · [Anthropic Messages][messages] · [OpenAI Responses 概览][openai-overview] · [OpenAI 创建响应][openai-create] · [Vercel OpenResponses][vercel]

OpenAI API 参考描述 OpenAI 自有端点，Open Responses 规范及其 OpenAPI schema 描述互操作契约，Vercel 文档描述 Vercel 公开支持的参数和能力。以下转换规则是网关策略。Claude Code 经网关路由到非 Claude 模型超出 Anthropic 的官方支持范围，具体模型和服务商扩展需按实际路由验证。 [OpenAI 创建响应][openai-create] · [Open Responses 规范][spec] · [OpenAPI schema][schema] · [Vercel 参数][vercel-params] · [Claude Code 第三方网关][cc-gateway]

Anthropic 官方 TypeScript SDK 的 `MessageCreateParams`、`Message`、`RawMessageStreamEvent` 和 `MessageCountTokensParams` 提供了对应的入参、响应和事件类型。 [Anthropic SDK 类型][a-schema]

## 请求字段

| Anthropic Messages 入站 | Responses 上游出站 | 依据 |
| --- | --- | --- |
| `model` | 使用路由配置选定的上游 `model`。 | [OpenAI 创建响应][openai-create] · [Vercel 模型 ID][vercel-params] |
| 顶层 `system` 字符串或文本块数组 | 转成 `instructions`。数组按原顺序拼接文本并采用稳定分隔符。Claude Code 也会发送位于历史中的 `role:"system"` 消息，支持时转换为 `input` 中原位置的 system message。 | [Anthropic 创建消息][messages-create] · [Claude Code 中途系统消息][cc-features] · [OpenAI 创建响应][openai-create] |
| `messages[].content` 字符串或 `text` 块 | 构建有序 `input` items。用户文本用 `message(role:"user")` 的 `input_text`，已生成的 assistant 文本用 `message(role:"assistant")` 的 `output_text`。一条消息混有工具块时，按原顺序拆分文本与工具项。 | [Anthropic 创建消息][messages-create] · [Open Responses 用户消息][or-user] · [Open Responses 助手消息][or-assistant] |
| 用户图片和工具结果里的图片 | 作为可选能力映射到 `input_image.image_url`，URL 原样使用，base64 需要带 `media_type` 的 data URL。文档/PDF 需要按上游文件输入能力转换。各服务的文件 ID 由各自服务解析。 | [Anthropic 创建消息][messages-create] · [OpenAI 图像输入][openai-images] · [OpenAI 文件输入][openai-files] · [Open Responses 图像 schema][or-image] |
| `tools[]` 自定义客户端工具 | 转成扁平的 `{type:"function",name,description,parameters,strict}`，`input_schema` 对应 `parameters`。对于普通的非严格工具，可显式传 `strict:false` 保留原 schema。显式 `strict:true` 需要满足上游 schema 子集，且各对象声明 `additionalProperties:false`、所有属性均列入 `required`。 | [Anthropic 工具定义][a-tools] · [OpenAI strict mode][openai-strict] · [Open Responses FunctionToolParam][or-function] |
| `tool_choice.type` 为 `auto`、`any`、`none`、`tool` | 依次映射到 `"auto"`、`"required"`、`"none"`、`{"type":"function","name":…}`。显式 `disable_parallel_tool_use:true` 对应 `parallel_tool_calls:false`。`any` 与禁并行组合要求恰好一次客户端调用，依赖上游同时执行两项约束。 | [Anthropic 工具选择][a-tool-choice] · [OpenAI 工具选择与并行][openai-tool-choice] · [Open Responses tool_choice][or-tool-choice] |
| 历史中的 assistant `tool_use` | 发送独立 `function_call` item。把关联标识写入 `call_id`，`name` 保持一致，`input` 对象序列化成 `arguments` JSON 字符串。重建时可省略 item `id`。 | [Anthropic 工具结果][a-results] · [Open Responses FunctionCallItemParam][or-call-in] |
| 历史中的 user `tool_result` | 发送独立 `function_call_output` item。`tool_use_id` 还原为同一 `call_id`。`output` 可用原文本字符串，也可按能力转换为 `input_text`、`input_image`、`input_file` 等数组。空结果仍需提供 `output`，例如 `""`。 | [Anthropic 工具结果][a-results] · [OpenAI 工具结果格式][openai-tool-output] · [Open Responses FunctionCallOutputItemParam][or-result] |
| `max_tokens`、`stream` | 分别对应 `max_output_tokens`、`stream`。JSON 和 SSE 两条响应路径使用相同的内容和结束原因映射。 | [Anthropic 创建消息][messages-create] · [OpenAI max_output_tokens][openai-max] · [OpenAI 流式指南][openai-stream] |
| `temperature`、`top_p` | 字段同名，按上游模型支持情况发送。 | [Anthropic 创建消息][messages-create] · [OpenAI 创建响应][openai-create] |

`tool_result.is_error` 在 Anthropic 表示工具执行失败，公开的 `function_call_output` schema 没有该字段。可约定把失败标记和错误文本序列化进 `output`，仍使用原调用的 `call_id`。上游收到的是工具输出数据。`search_result`、特定服务商的 document 或文件引用需要另行定义可用的转换。 [Anthropic 工具错误][a-results-errors] · [Open Responses FunctionCallOutputItemParam][or-result]

## 响应字段与停止原因

非流式返回一个 `type:"message"`、`role:"assistant"` 的 Anthropic Message，填充 `id`、`model`、`content`、`stop_reason`、`stop_sequence` 和 `usage`。可从 `response.id` 稳定派生消息 ID。fixture 在 `message.model` 使用入站别名。按 `response.output` 顺序展开内容，`message.content[]` 中的 `output_text.text` 转成 `text` 块，完成的 `function_call` 转成 `tool_use` 块。后者要求把 `arguments` 解析为 JSON 对象，再写入 `input`。`call_id` 用作 `tool_use.id` 或经可逆编码后使用。`function_call.id` 标识上游 item，`response.id` 标识整次响应。 [OpenAI 创建响应][openai-create] · [Open Responses FunctionCall][or-call] · [Anthropic Messages][messages]

| Responses 终态 | Anthropic 映射策略 | 依据 |
| --- | --- | --- |
| `completed`，含可执行的客户端 `function_call` | `stop_reason:"tool_use"`。仅交付参数完整且符合 JSON 对象形状的调用。 | [OpenAI 工具调用流程][openai-fn] · [Anthropic 工具结果][a-results] |
| `completed`，常规文本结束 | `stop_reason:"end_turn"`，`stop_sequence:null`。如输出表明拒答，可按拒答处理。 | [OpenAI 创建响应][openai-create] · [Anthropic 停止原因][a-stop] |
| `incomplete`，`incomplete_details.reason:"max_output_tokens"` | `stop_reason:"max_tokens"`，保留已生成的可交付内容。如果 SSE 已发出后来被截断的工具块，则以 `error` 结束该流。 | [OpenAI 推理预算][openai-reasoning] · [Anthropic 停止原因][a-stop] |
| `incomplete` 且原因是 `content_filter`，或 `refusal` 输出内容 | 可映射成 `stop_reason:"refusal"`，保留允许展示的文本。Responses 的拒答文本可作为 Anthropic 文本传递。 | [OpenAI 流式拒答事件][openai-refusal] · [Anthropic 停止原因][a-stop] |
| `failed`、上游 `error`、未识别的 `incomplete` 原因、缺失终态的 EOF | 按错误处理。HTTP 流开始前可返回对应 HTTP 状态和 Anthropic `error` JSON，开始后用 Anthropic `error` 事件。保留可用于诊断的上游错误信息和请求标识。 | [OpenAI error event][openai-error] · [Open Responses Errors][or-errors] · [Anthropic API 错误][a-errors] |

Anthropic 输入总数等于普通输入、缓存读取和缓存创建三项之和。对于采用 OpenAI 计量语义的上游，读取 `usage.input_tokens_details.cached_tokens` 和可选的 `cache_write_tokens`，分别写入 `cache_read_input_tokens`、`cache_creation_input_tokens`，再从上游 `input_tokens` 减去这两项得到下游 `input_tokens`。缓存写入的 TTL 桶归属各自计费合同。`usage.output_tokens` 保留总量，`output_tokens_details.reasoning_tokens` 已包含在其中。若需要暴露这项细分，可把已测量值写入支持它的 `output_tokens_details.thinking_tokens`。全量 usage 缺失时内部保留缺失状态，区分 SSE 初始占位与已测量数值。 [OpenAI 缓存计量][openai-cache] · [OpenAI 创建响应][openai-create] · [Open Responses Usage][or-usage] · [Anthropic 创建消息][messages-create]

## SSE 事件

两侧流式响应使用 `Content-Type: text/event-stream`。按 SSE 帧读取 `event` 和 `data`，JSON `type` 与命名事件一致。上游 `sequence_number` 表示事件顺序。HTTP 读取可能在 UTF-8 字符或帧内部切开。Open Responses 要求终态事件，允许其后附加 `[DONE]`，也允许直接 EOF。Claude Code 需要收到有序的 `message_delta` 和 `message_stop` 才把成功的 Messages 流视为完整。 [Open Responses HTTP 响应][or-http] · [OpenAI 流式事件][openai-events] · [Anthropic SSE 事件][a-events] · [Claude Code 流式要求][cc-stream]

| 上游 Responses 事件 | 下游 Anthropic 事件与转换 |
| --- | --- |
| `response.created` | 发一次 `message_start`。`message.content:[]`，`stop_reason:null`。上游此时的 `usage` 可以是 `null`。 |
| `response.queued`、`response.in_progress` | 更新内部状态，已有 `message_start` 时继续等待内容。 |
| `response.output_item.added` (`message`) 与 `response.content_part.added` (`output_text`) | 根据 item 与 part 建立关联，为每个文本 part 分配一个 Anthropic `index`，发 `content_block_start`，先放空文本。 |
| `response.output_text.delta` | 发对应 `index` 的 `content_block_delta`，其中 `delta` 为 `{"type":"text_delta","text":…}`。 |
| `response.output_item.added` (`function_call`) | 记录 `item.id`、`output_index`、`call_id`、`name`，为该调用分配一个块。开始时发 `content_block_start`，`content_block` 为 `tool_use`，`input:{}`。 |
| `response.function_call_arguments.delta` | 按 `item_id` 和 `output_index` 定位调用，发同一 Anthropic `index` 的 `input_json_delta`，`partial_json` 保存参数分片。分片可以在 JSON 字符串内部断开。 |
| `response.output_text.done`、`response.content_part.done`、`response.function_call_arguments.done`、`response.output_item.done` | 用最终快照校验或补齐缺失内容。`text` 或 `arguments` 是完整值，追加前与已发片段比对。每块只发一次 `content_block_stop`。若需保证工具块在关闭时可解析，可单独暂存工具参数分片，确认是完整对象后再按顺序发出。 |
| `response.completed`、可映射的 `response.incomplete` | 收齐并关闭内容块。以最终快照的 `usage` 发累计 `message_delta`，同时带 `stop_reason` 和 `stop_sequence`，再发一次 `message_stop`。初始占位的输入计数可在这里用累计值更新。 |
| `response.failed`、`error`、断流 | 发一次 Anthropic `error` 事件并结束。Responses 的失败快照用 `response.error`，OpenAI 独立 `error` 事件可含顶层 `code`、`message`，Open Responses schema 的独立 `error` 事件用嵌套 `error` 对象。 |

维护上游 `(output_index, item_id, content_index)` 到下游内容块的关联。工具参数事件没有 `content_index`，也不携带 `call_id`。下游 `index` 是转换后 `content` 的零基索引。一个上游 item 可以含多个文本 part，保留的工具与文本块需要保持顺序。收到交错事件时按各自的 item 和 part 累积。流中允许插入 Anthropic `ping`，可用于无上游内容的长间隔。Vercel 示例展示了按 JSON `type` 提取文本增量的方式。兼容仅有 `data:` 行的上游时，可根据 JSON `type` 分派，仍为下游发送命名事件。 [OpenAI 工具参数增量][openai-args] · [OpenAI 流式事件][openai-events] · [Anthropic SSE 与 JSON 分片][a-json-delta] · [Claude Code 流式要求][cc-stream] · [Vercel 流式示例][vercel-stream]

## Claude Code 多轮工具调用

1. Claude Code 收到 `stop_reason:"tool_use"`，在客户端执行工具。下一轮在原历史后重放整条 assistant 消息，紧接一条 user 消息，每个调用都有同 ID 的 `tool_result`，失败调用也有结果。user 的结果块排在文字之前。每一轮应处理零个、一个或多个工具调用，工具定义和结果顺序保持稳定。 [Anthropic 工具结果][a-results] · [Anthropic 并行工具][a-parallel] · [OpenAI 工具调用指南][openai-fn]
2. 无状态方式以 `input` 重建历史。按原有位置发送 assistant 文本和每个 `function_call`，随后发送对应的 `function_call_output`，再发送同一 user 消息中的普通文本。关联使用 `call_id`。工具返回内容较大或并行返回时，按调用 ID 校对结果，不能只取第一条。 [OpenAI 对话状态][openai-state] · [Open Responses FunctionCallOutputItemParam][or-result] · [Vercel 工具响应][vercel-tools]
3. 上游支持服务端会话续接时，可另选 `previous_response_id` 加本轮新增 items，上游加载原有 input 和 output。与完整重放同时使用会重复历史。OpenAI 要求按轮重发需要保留的 `instructions`，`conversation` 与 `previous_response_id` 互斥。续接状态依赖保存响应的上游及其有效期，路由切换时需要可重放的历史。 [OpenAI 创建响应][openai-create] · [OpenAI 对话状态][openai-state] · [Open Responses previous_response_id][or-prev]

### 需要单独适配的语义

- **推理连续性。** OpenAI 指南要求在工具回传时把某些推理模型返回的 `reasoning` items 一起传回，可通过上游状态续接或原样保存这些 items。用 `store:false` 重放时，`encrypted_content` 是上游的 opaque 数据。部分模型也需要保留 assistant `phase`。Anthropic 在带工具回合的 thinking 块上要求完整、保留签名地重放。`reasoning.summary` 或 `encrypted_content` 无法充当 Anthropic 的 `thinking.signature`。可按模型把 `output_config.effort` 转成 `reasoning.effort`，这仍不提供 Claude 的固定 `budget_tokens` 或签名语义。 [OpenAI 工具调用指南][openai-fn] · [OpenAI 推理指南][openai-reasoning] · [Open Responses 助手消息][or-assistant] · [Anthropic thinking 与工具][a-thinking] · [Vercel 推理参数][vercel-reason]
- **服务端工具与 beta 扩展。** Anthropic 的 `server_tool_use`、`tool_reference`、`defer_loading`、`context_management` 等有各自依赖。OpenAI 的内建、托管 MCP 和普通 `function_call` 执行主体也不同。只支持客户端函数时，需要识别这些请求或输出的真实类型，按能力提供转换或返回可识别的错误。Claude Code 的部分功能重试依赖具体错误文案。 [Claude Code 能力与重试][cc-features] · [OpenAI 创建响应][openai-create] · [Open Responses Tools][or-tools]
- **缓存与停止控制。** Anthropic `cache_control` 的断点和 TTL、`stop_sequences` 的命中回报、`top_k`、服务档位和 beta `output_config` 不能统一透传。上游的缓存键、留存配置、结构化输出等需有各自的能力映射。启用上游缓存时，稳定保存 system、工具定义和历史顺序有助于复用前缀。 [Anthropic 创建消息][messages-create] · [Anthropic 提示缓存][a-cache] · [OpenAI 创建响应][openai-create] · [OpenAI 提示缓存][openai-cache]

### `POST /v1/messages/count_tokens`

Anthropic 计数接受 `model`、`messages`、`system`、`tools` 等结构化输入并返回 `{"input_tokens":N}`，可以包含图片、文档和工具历史。Claude Code 将该端点视为可选，缺省时用字符估算上下文用量。计数请求不需要 `max_tokens`，也不生成消息。 [Anthropic 计数 API][a-count-api] · [Anthropic 计数指南][a-count] · [Claude Code 可选端点][cc-optional]

OpenAI 官方提供 `POST /responses/input_tokens`，响应含 `object:"response.input_tokens"` 与 `input_tokens`。若路由支持，可复用推理请求的模型路由和 `input`、`instructions`、`tools` 转换，然后按计数端点接受的字段构造请求。对客户端只返回 `input_tokens`。Open Responses 的公开 schema 和 Vercel OpenResponses 文档未定义这个端点。该路由缺少上游计数能力时可使用本地估算，估算输入应覆盖转换后的指令、历史和工具 schema，并说明图片、文件和模型 tokenizer 会影响误差。计数用于上下文管理，推理 usage 用于结算。 [OpenAI 输入 token 计数][openai-count] · [OpenAPI schema][schema] · [Vercel OpenResponses][vercel] · [Anthropic 计数指南][a-count]

## 限额如何影响兼容性

| 文档中的限制 | 对 Claude Code 的影响 |
| --- | --- |
| OpenAI `max_output_tokens` 下限为 16，且同时覆盖可见输出和推理。上下文也受所选模型限制。 | Claude Code 的小预算请求可能遭遇上游校验，较大预算也可能先被推理消耗而没有可见文本。预算兼容策略需要显式处理，截断要回报 `max_tokens`，尤其要覆盖参数生成到一半的情况。 [OpenAI max_output_tokens][openai-max] · [OpenAI 推理预算][openai-reasoning] |
| Claude Code 对未知模型 ID 有默认上下文假设，可用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 等机制声明实际窗口。OpenAI `truncation` 默认是 `disabled`，超限会返回 400。 | 别名假定的窗口过大时，长工具历史可能在 Claude Code 触发压缩前就被拒绝。反过来过小会提前压缩。启用 `truncation:"auto"` 会允许上游丢弃较早的 items，需要验证工具调用与回传的成对关系。 [Claude Code 模型窗口][cc-context] · [OpenAI 创建响应][openai-create] · [Open Responses truncation][or-truncation] |
| Open Responses schema `2026-04-24` 中 `FunctionCallItemParam.call_id` 和 `FunctionCallOutputItemParam.call_id` 长度为 1–64，`FunctionCallOutputItemParam.output` 的字符串分支上限为 10,485,760 字符。Anthropic 一方 Messages 与计数端点当前公开请求体上限为 128 MB。 | ID 转换必须保持唯一和可逆。单字段字符数、整包 UTF-8 字节和模型 token 是独立限额。富媒体的 base64 扩张、工具输出和历史重放都可能加大出站 JSON。Anthropic 的请求体上限不代表网关与 Responses 上游的上限。 [OpenAPI schema][schema] · [Anthropic 请求大小][a-size] |
| OpenAI 建议初始可用函数少于 20 个以改善准确率，这项是软建议。函数定义本身计入上下文，`max_tool_calls` 限制的是内建工具调用数。 | Claude Code 的工具表可随启用的 MCP 工具变大。测试应涵盖较大工具表和真实 schema 形状，区分供应商拒绝、上下文超限、模型选择质量，避免把此数字作为网关的通用硬上限。 [OpenAI 函数定义建议][openai-fn] · [OpenAI 创建响应][openai-create] |

记录部署实测限额时，应附上游和模型 ID、客户端版本、工具个数及定义大小、转码后请求字节数、估算 token、`max_output_tokens` 和失败发生的阶段。HTTP 413、400 参数校验或上下文超限，以及 SSE `response.incomplete` 需要各自断言。本节数值来自官方文档和 schema，下面的 fixture 数值仅用于验证协议转换。

## 离线 mock fixture

模型 ID、ID 映射和用量都是 fixture 选择。用 `instructions` 保存 system 文本，`store:false` 重放，`tool_use.id` 直接复用 `call_id`。以下 JSON 和 SSE 可作固定输入，SSE 帧之间保留空行。上游对象形状按 Open Responses schema 构造。 [OpenAPI schema][schema] · [Anthropic 工具流示例][a-tool-stream]

### 第一轮请求

Claude Code → `POST /v1/messages?beta=true`

```json
{
  "model": "claude-gateway-mock",
  "system": [{"type":"text","text":"使用给定的测试工具。"}],
  "messages": [{"role":"user","content":"读取 main 的版本。"}],
  "tools": [{"name":"read_version","description":"读取版本号","input_schema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}],
  "tool_choice": {"type":"auto","disable_parallel_tool_use":true},
  "max_tokens": 64,
  "stream": true
}
```

网关 → `POST /responses`

```json
{
  "model": "mock-responses",
  "instructions": "使用给定的测试工具。",
  "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"读取 main 的版本。"}]}],
  "tools": [{"type":"function","name":"read_version","description":"读取版本号","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]},"strict":false}],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "max_output_tokens": 64,
  "stream": true,
  "store": false
}
```

### 第一轮 SSE

上游 → 网关

```sse
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_fixture_1","object":"response","created_at":1700000000,"completed_at":null,"status":"in_progress","incomplete_details":null,"model":"mock-responses","previous_response_id":null,"instructions":"使用给定的测试工具。","output":[],"error":null,"tools":[{"type":"function","name":"read_version","description":"读取版本号","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]},"strict":false}],"tool_choice":"auto","truncation":"disabled","parallel_tool_calls":false,"text":{"format":{"type":"text"}},"top_p":1,"presence_penalty":0,"frequency_penalty":0,"top_logprobs":0,"temperature":1,"reasoning":null,"usage":null,"max_output_tokens":64,"max_tool_calls":null,"store":false,"background":false,"service_tier":"default","metadata":{},"safety_identifier":null,"prompt_cache_key":null}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"function_call","id":"fc_fixture_1","call_id":"call_fixture_1","name":"read_version","arguments":"","status":"in_progress"}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":2,"item_id":"fc_fixture_1","output_index":0,"delta":"{\"name\":"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_fixture_1","output_index":0,"delta":"\"main\"}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","sequence_number":4,"item_id":"fc_fixture_1","output_index":0,"arguments":"{\"name\":\"main\"}"}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":5,"output_index":0,"item":{"type":"function_call","id":"fc_fixture_1","call_id":"call_fixture_1","name":"read_version","arguments":"{\"name\":\"main\"}","status":"completed"}}

event: response.completed
data: {"type":"response.completed","sequence_number":6,"response":{"id":"resp_fixture_1","object":"response","created_at":1700000000,"completed_at":1700000001,"status":"completed","incomplete_details":null,"model":"mock-responses","previous_response_id":null,"instructions":"使用给定的测试工具。","output":[{"type":"function_call","id":"fc_fixture_1","call_id":"call_fixture_1","name":"read_version","arguments":"{\"name\":\"main\"}","status":"completed"}],"error":null,"tools":[{"type":"function","name":"read_version","description":"读取版本号","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]},"strict":false}],"tool_choice":"auto","truncation":"disabled","parallel_tool_calls":false,"text":{"format":{"type":"text"}},"top_p":1,"presence_penalty":0,"frequency_penalty":0,"top_logprobs":0,"temperature":1,"reasoning":null,"usage":{"input_tokens":32,"output_tokens":12,"total_tokens":44,"input_tokens_details":{"cached_tokens":8},"output_tokens_details":{"reasoning_tokens":0}},"max_output_tokens":64,"max_tool_calls":null,"store":false,"background":false,"service_tier":"default","metadata":{},"safety_identifier":null,"prompt_cache_key":null}}

```

网关 → Claude Code

```sse
event: message_start
data: {"type":"message_start","message":{"id":"msg_fixture_1","type":"message","role":"assistant","model":"claude-gateway-mock","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_fixture_1","name":"read_version","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"name\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"main\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":24,"output_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":8}}

event: message_stop
data: {"type":"message_stop"}

```

### 第二轮工具回传与断言

保留第一轮的其他字段。客户端将 `messages` 替换为以下数组，工具测试桩返回 `1.2.3`。

```json
[
  {"role":"user","content":"读取 main 的版本。"},
  {"role":"assistant","content":[{"type":"tool_use","id":"call_fixture_1","name":"read_version","input":{"name":"main"}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_fixture_1","content":"1.2.3"},{"type":"text","text":"请直接给版本号。"}]}
]
```

出站 `input` 应为以下数组。

```json
[
  {"type":"message","role":"user","content":[{"type":"input_text","text":"读取 main 的版本。"}]},
  {"type":"function_call","call_id":"call_fixture_1","name":"read_version","arguments":"{\"name\":\"main\"}"},
  {"type":"function_call_output","call_id":"call_fixture_1","output":"1.2.3"},
  {"type":"message","role":"user","content":[{"type":"input_text","text":"请直接给版本号。"}]}
]
```

- **第一轮断言。** Claude 侧仅有一个 `tool_use`，合并两段参数得 `{"name":"main"}`，`message_delta` 的 `delta.stop_reason` 为 `tool_use`。`input_tokens + cache_read_input_tokens` 为 `32`，`output_tokens` 为 `12`。同一 SSE 在终态后追加 `data: [DONE]` 仍只结束一次。可把传输分块切在 JSON 字符串或中文 UTF-8 字符内部。
- **第二轮断言。** 工具结果只关联 `call_fixture_1`，且结果 item 位于普通 user 文本之前。让上游返回 `completed`，`output` 是一个 assistant `message` item，其 `content:[{"type":"output_text","text":"1.2.3","annotations":[]}]`。在流式版本中发 `response.output_text.delta` 和重复全文的 `response.output_text.done`，应只得到一个 `text` 块 `1.2.3` 和 `stop_reason:"end_turn"`。把两侧 `stream` 设为 `false` 并返回同一终态 Response JSON，可用相同断言验证内容和 usage。
- **失败变体。** 把工具参数截在第一段，以 `response.incomplete` 结束并设置 `response.incomplete_details.reason:"max_output_tokens"`。JSON 返回 `max_tokens` 并省略未完成的调用。SSE 若已向客户端发出对应工具块，期望 `error` 终止。将成功终态改为 `response.failed` 并附带 `response.error`，或直接中断连接，期望错误。并行变体允许 `parallel_tool_calls`，为两个调用分配不同的 `call_id` 并交错发送参数，应分别重组并回传。
- **计数变体。** 向 `/v1/messages/count_tokens` 发送同一轮的 `model`、`system`、`messages`、`tools`。网关先尝试原生 Messages 计数，再尝试支持 `/responses/input_tokens` 的 Responses 路由。官方 OpenAI API 地址默认启用。兼容端点使用逗号分隔的 `RESPONSES_INPUT_TOKENS_BASE_URLS` 配置。远端明确缺少计数能力时使用本地估算。计数在日志中使用 `count_tokens` 操作，生成和结算各自使用自己的请求与用量。

## 参考实现

- Sub2API 提供 Messages 请求和 Responses 响应的双向转换。它按顺序重放工具输入与结果，并为模型设置采样参数和最小输出预算等策略。它通过协议内部约定携带推理数据，适用性取决于参与回放的上游和客户端。 [Sub2API 请求转换][sub2api-request] · [Sub2API 响应转换][sub2api-response]
- CLIProxyAPI 的 Codex → Claude SSE 转换独立记录各个函数调用的参数和块索引，并排队输出交错的工具事件。它还有 Codex 专用的 thinking 与 commentary 回放约定。 [CLIProxyAPI SSE 转换][cliproxyapi-response]

## Harbor 本地验收

网关的 `openai` 和 `openai_compatible_responses` 模型默认关闭转换。通过管理 API `PATCH /api/v1/provider-models/{id}` 传入 `{"alias":"claude-sonnet-4-6","messages_via_responses_enabled":true}` 为所选模型启用。Harbor fixture 会在独立 SQLite 数据库里自动配置路由和生成凭据。

准备 Docker Compose、Harbor、Linux x86-64 的 Claude Code CLI 二进制。在 Linux 或 WSL 中构建网关，再从可运行 Docker 和 Harbor 的宿主机启动测试。把两个二进制参数指向宿主机可读取的路径。

```sh
cargo build --manifest-path backend/Cargo.toml --locked
python scripts/run_responses_to_messages_harbor.py \
  --backend backend/target/debug/backend --claude /path/to/claude \
  --settings "$HOME/.claude/settings.gpt.json" --tier opus
```

镜像使用 `python:3.12-slim`，容器网络模式为 `none`。宿主机已有基础镜像且需要使用 daemon 缓存时，可传 `--legacy-builder`。`--settings` 从指定的 Claude Code 配置读取模型映射和令牌限额，验收容器使用本地网关地址和临时密钥。省略 `--settings` 可运行默认的 Sonnet 样例。 [运行脚本](../scripts/run_responses_to_messages_harbor.py) · [任务配置](../scripts/harbor/responses-to-messages/task.toml)

真实 Claude Code 在首轮接收两个交错的 `Read` 调用，随后调用 `Edit` 把 `calc.py` 改成加法，通过 `Bash` 检查正数、零和负数，最后输出回复。Mock 会核对工具 schema、调用参数和每条回传的 `call_id`。验收还核对两种工具完成顺序、远端计数路由，以及 JSON 和 SSE 中的缺失用量、实测零、终态替换和断流。Verifier 对照 CLI 的 `end_turn`、Responses 请求的输出预算和 SQLite 记账。结果写入 `data/harbor-jobs/` 或 `--jobs-dir`，通过时 `reward.txt` 为 `1`。 [Mock](../scripts/harbor/responses-to-messages/environment/gateway_lab.py) · [验收器](../scripts/harbor/responses-to-messages/tests/verify.py)

真实上游、交错并行工具和多模态历史需分别验证。签名 thinking 与服务端工具需要独立适配。上游终态缺少 usage 时，当前 Messages 转换用零值填充。

[messages]: https://platform.claude.com/docs/en/api/messages
[messages-create]: https://platform.claude.com/docs/en/api/messages/create
[a-schema]: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
[a-count-api]: https://platform.claude.com/docs/en/api/messages/count_tokens
[a-count]: https://platform.claude.com/docs/en/build-with-claude/token-counting
[a-tools]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#specifying-client-tools
[a-tool-choice]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use
[a-results]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls#handling-results-from-client-tools
[a-results-errors]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls#handling-errors-with-is-error
[a-parallel]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
[a-stop]: https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
[a-errors]: https://platform.claude.com/docs/en/api/errors#error-shapes
[a-size]: https://platform.claude.com/docs/en/api/overview#request-size-limits
[a-thinking]: https://platform.claude.com/docs/en/build-with-claude/thinking#preserving-thinking-blocks
[a-cache]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[a-events]: https://platform.claude.com/docs/en/build-with-claude/streaming#event-types
[a-json-delta]: https://platform.claude.com/docs/en/build-with-claude/streaming#input-json-delta
[a-tool-stream]: https://platform.claude.com/docs/en/build-with-claude/streaming#streaming-request-with-tool-use
[cc-gateway]: https://code.claude.com/docs/en/llm-gateway
[cc-protocol]: https://code.claude.com/docs/en/llm-gateway-protocol#api-formats
[cc-optional]: https://code.claude.com/docs/en/llm-gateway-protocol#optional-endpoints-and-startup-traffic
[cc-stream]: https://code.claude.com/docs/en/llm-gateway-protocol#streaming
[cc-features]: https://code.claude.com/docs/en/llm-gateway-protocol#feature-pass-through
[cc-context]: https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id
[openai-overview]: https://developers.openai.com/api/reference/responses/overview/
[openai-create]: https://developers.openai.com/api/reference/resources/responses/methods/create
[openai-max]: https://developers.openai.com/api/reference/resources/responses/methods/create#responses-create-max_output_tokens
[openai-count]: https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count
[openai-fn]: https://developers.openai.com/api/docs/guides/function-calling
[openai-strict]: https://developers.openai.com/api/docs/guides/function-calling#strict-mode
[openai-tool-choice]: https://developers.openai.com/api/docs/guides/function-calling#tool-choice
[openai-tool-output]: https://developers.openai.com/api/docs/guides/function-calling#formatting-results
[openai-state]: https://developers.openai.com/api/docs/guides/conversation-state
[openai-reasoning]: https://developers.openai.com/api/docs/guides/reasoning
[openai-images]: https://developers.openai.com/api/docs/guides/images-vision
[openai-files]: https://developers.openai.com/api/docs/guides/file-inputs
[openai-cache]: https://developers.openai.com/api/docs/guides/prompt-caching
[openai-stream]: https://developers.openai.com/api/docs/guides/streaming-responses
[openai-events]: https://developers.openai.com/api/reference/resources/responses/streaming-events
[openai-refusal]: https://developers.openai.com/api/reference/resources/responses/streaming-events#response.refusal.delta
[openai-error]: https://developers.openai.com/api/reference/resources/responses/streaming-events#error
[openai-args]: https://developers.openai.com/api/reference/resources/responses/streaming-events#response.function_call_arguments.delta
[vercel]: https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses
[vercel-params]: https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses#parameters
[vercel-stream]: https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses/streaming#streaming-events
[vercel-tools]: https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses/tool-calling#tool-call-response
[vercel-reason]: https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses/reasoning
[spec]: https://www.openresponses.org/specification
[schema]: https://www.openresponses.org/openapi/openapi.json
[or-http]: https://www.openresponses.org/specification#http-responses
[or-errors]: https://www.openresponses.org/specification#errors
[or-tools]: https://www.openresponses.org/specification#tools
[or-tool-choice]: https://www.openresponses.org/specification#tool_choice
[or-prev]: https://www.openresponses.org/specification#previous_response_id
[or-truncation]: https://www.openresponses.org/specification#truncation
[or-user]: https://www.openresponses.org/reference#object-UserMessageItemParam
[or-assistant]: https://www.openresponses.org/reference#object-AssistantMessageItemParam
[or-image]: https://www.openresponses.org/reference#object-InputImageContentParamAutoParam
[or-function]: https://www.openresponses.org/reference#object-FunctionToolParam
[or-call]: https://www.openresponses.org/reference#object-FunctionCall
[or-call-in]: https://www.openresponses.org/reference#object-FunctionCallItemParam
[or-result]: https://www.openresponses.org/reference#object-FunctionCallOutputItemParam
[or-usage]: https://www.openresponses.org/reference#object-Usage
[sub2api-request]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/anthropic_to_responses.go
[sub2api-response]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/responses_to_anthropic.go
[cliproxyapi-response]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_response.go
