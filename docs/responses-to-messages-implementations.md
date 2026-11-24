# Responses → Messages 实现对照

这里的链路从 Claude 客户端的 `POST /v1/messages` 开始，网关把请求转成 Responses，收到上游响应后再转回 Anthropic JSON 或 SSE。对照基于固定提交的生产路径和现有测试。Little Gate 已实测的是本地 Responses mock 和真实 Claude Code 的顺序工具调用。 [协议对照与本地验收](responses-to-messages.md)

## CLIProxyAPI

源码版本为主分支 `85225381d89915595598ed13766cd79890c03a84`。

- **路由。** 注册表为 Claude → Codex 注册请求、流式响应、非流式响应及计数转换器。Codex executor 从账号配置取 base URL，默认 `https://chatgpt.com/backend-api/codex`，向该 base 的 `/responses` 发 POST。执行器收集 `output_item.done`，在非原生 Codex 客户端的终态补齐输出，然后调用下游转换器。 [注册][cli-register] · [上游地址][cli-route] · [出站请求][cli-stream] · [终态处理][cli-terminal]
- **Thinking。** SSE 在 reasoning 的 `output_item.done` 取最终 `encrypted_content`，在关闭 thinking 块前发 `signature_delta`。如果只有密文，也可发仅用于回放的块。下轮拿到 `thinking.signature` 时按目标模型识别签名家族，兼容的值作为原上游 `reasoning.encrypted_content` 回放。执行器另有 reasoning replay cache。这里的签名值承载上游私有状态，跨路由时需要匹配其来源。 [取终态签名][cli-thinking-out] · [输出签名][cli-signature-delta] · [输入回放][cli-thinking-in] · [家族判断][cli-signature-family] · [执行器缓存][cli-terminal]
- **客户端工具与交错 SSE。** 请求侧用 `call_id` 关联 `function_call` 和 `function_call_output`。响应侧为每个调用登记 `output_index`、`item_id`、`call_id` 别名并缓冲参数，给队首调用分配块索引。参数已发送部分只往后追加，后一个块等待前一个块关闭。终态可用最终工具快照补齐。原生 Responses 测试覆盖 A 先结束和 B 先结束，并检查同时只开放一个块、每条 delta 指向打开的索引。 [回放请求][cli-tool-in] · [索引关联][cli-tool-keys] · [参数队列][cli-tool-queue] · [终态补齐][cli-terminal-calls] · [生命周期断言][cli-tool-lifecycle] · [交错测试][cli-tool-test]
- **服务端工具。** 两版 Claude Web Search 工具定义映射为 Responses `web_search`，包含域名过滤与位置转换。Codex 的 `web_search_call` 完成后生成共享 ID 的 `server_tool_use` 和 `web_search_tool_result`，搜寻动作仍由上游执行。 [请求映射][cli-search-in] · [事件转换][cli-search-out]
- **多模态。** 用户消息支持 base64、HTTP(S) URL 和文件 ID 图像。文档可展开为文本和图像，内联 PDF 映射为 `input_file.file_data`，HTTP(S) 文档映射为 `input_file.file_url`。工具结果也走富内容转换。文件 ID 可用性取决于上游文件域。 [用户块][cli-media-req] · [媒体来源][cli-media-source] · [工具输出][cli-media-result]
- **计数与用量。** `count_tokens` 先完成请求转换，再按模型选 tokenizer，计数对象含指令、消息、工具参数和工具定义等。流式客户端的 `message_start` 输入量缺失或为零时，可按原始 Claude 请求用 O200kBase 补估一次。终态 Messages 仍使用数值型 usage 默认值。上游统计解析与下游输出是不同步骤，解析未得到统计时，执行器可用 `EnsurePublished` 写入一条空明细请求记录。 [计数入口][cli-count] · [计数段][cli-count-segments] · [首帧估算][cli-start-estimate] · [估算触发条件][cli-start-estimate-condition] · [终态 usage][cli-usage-wire] · [空明细][cli-usage-fallback]

## Sub2API

源码版本为主分支 `0f6671457132425d1b84f3d80536b53e02942424`。

- **路由。** `ForwardAsAnthropic` 根据账号和模型选择原生 Anthropic、Chat Completions 或 Responses。Responses 分支支持官方 API Key、配置的兼容 base URL 和 ChatGPT/Codex OAuth URL。该分支固定打开上游 SSE，给流式客户端转换事件，给非流式客户端聚合成 Messages JSON。请求转换还按模型过滤采样参数、设置输出预算下限。 [协议分流][sub-dispatch] · [请求规范化][sub-normalization] · [出站地址][sub-upstream] · [上游 SSE][sub-force-stream] · [下游选择][sub-response]
- **Thinking。** 在 reasoning item 的结束事件捕获密文，关块前发 `signature_delta`。请求侧把允许的签名变为 `reasoning.encrypted_content`，共享转换器会过滤 `gAAAA` 形态和 CC Switch 的版本化 envelope。启用会话续接的兼容路由可用 `previous_response_id` 加本轮新增 items。Grok 因切换账号而遇到无法解密的密文时可剥离签名重试一次。 [签名捕获][sub-reasoning-wire] · [关块][sub-thinking-close] · [回放过滤][sub-thinking-replay] · [会话续接][sub-continuation] · [增量请求][sub-latest-turn] · [Grok 重试][sub-retry]
- **并行与交错。** 转换器为工具保存 `output_index → content block index`，但同时用一个当前块跟踪参数和结束状态。普通函数的 `added A → added B → delta A` 序列中，添加 B 会关闭 A，后到的 A 分片仍可由索引表定位 A，形成发往已关闭索引的 delta。核对到的 no-ghost-delta 回归输入是 Chat Completions 桥接产生的事件，断言的范围是目标块曾被打开。生产 Responses 路径把收到的事件直接交给这个转换器。 [开块逻辑][sub-tool-open] · [参数逻辑][sub-tool-delta] · [回归范围][sub-tool-test] · [生产 SSE][sub-raw-sse]
- **服务端工具。** Anthropic Web Search 映射为上游 `web_search`，完成时回写 `server_tool_use` 和结果块。满足条件的账号也可在网关执行搜索模拟。Codex 路由另有基于模型能力启用的原生 `tool_search`，保留 deferred tools 的发现流程。 [工具定义][sub-tool-in] · [搜索结果][sub-web-search] · [搜索模拟][sub-emulation] · [Tool Search 能力判断][sub-force-stream]
- **多模态。** 这条桥接把含 base64 数据的图像编码为 `input_image`。工具输出正文写成字符串，图像单独附到后续 user message。该用户块转换分支只列出文本、图像和工具结果。 [用户块转换][sub-input-media] · [图像与工具结果映射][sub-media-source]
- **计数。** 支持时从同一类 Messages 转换得到计数请求，再向 `/v1/responses/input_tokens` 取值。多协议 API Key 账号本地估算。该路径在识别到 OAuth 不支持时回退本地估算，其他匹配到的上游计数端点不支持错误映射为 404。 [转发分支][sub-count] · [错误与回退][sub-count-status] · [计数请求字段][sub-count-request]
- **缺失 usage。** 服务层独立从 Responses 事件取上游计量，Anthropic 终态照常输出数值字段。成功且未拿到正数计量时，诊断会采样记录 `openai_usage.success_missing_usage`，因此这条诊断同时包含缺失和全零。 [上游采集][sub-usage-read] · [终态输出][sub-usage-wire] · [非流式记录][sub-usage-buffer] · [采样条件][sub-usage-log]

## Switchyard

源码版本为 `v0.4.0`，提交 `5386e20657a9a5e43bf6e4ba1895c1db5b68ea23`。

- **路由与测试。** 独立服务器注册了 `/v1/messages`，TOML 目标选 `format = "openai_responses"` 后由 Runner 构造 Responses HTTP 客户端。上游可使用独立的 `api_key_env`。直连 OpenAI 的 Responses 目标启用 `forward_auth` 时，服务器拒绝 Messages 跨家族转发。官方将独立服务器用于演示和本地评估。其集成测试实际向 `/v1/messages` 提交 PDF，mock 在 `/v1/responses` 验证请求中的 `input_file`，分别返回 JSON 和 SSE。 [路由][sy-http] · [目标配置][sy-target] · [上游 URL][sy-url] · [认证判断][sy-auth] · [部署定位][sy-server-role] · [模拟上游][sy-integration-upstream] · [集成测试][sy-integration]
- **转换结构。** Rust 库从来源 codec 解码到协议中立的 IR，再由目标 codec 编码。已知有损转换由 `TranslationPolicy` 控制，默认发出诊断并继续，也可配置为拒绝。 [codec 注册和 IR][sy-engine] · [有损策略][sy-policy]
- **Thinking。** Claude 历史中带签名的 thinking 会从 Responses 输入过滤。Responses 的 reasoning 文本可编码成 Messages thinking，JSON 和 SSE 的签名值为空。HTTP 客户端另有按目标选择保留密文、保留明文或删除 reasoning 的策略。该项目的签名往返测试覆盖 Responses 客户端接 Claude 上游，使用经过封装的 Claude 原文和签名。 [请求侧过滤][sy-thinking-in] · [JSON 输出][sy-thinking-out] · [SSE 输出][sy-thinking-sse] · [目标策略][sy-reasoning-policy] · [反方向往返测试][sy-signed-reverse]
- **工具。** 客户端函数用 `call_id` 回放，并把同一段工具历史中的结果按 ID 对应回各调用。Anthropic 的内建 `web_search_20250305` 在允许有损和严格策略下都被拒绝。Responses 原生的 shell、computer 等调用也有单独的保留或拒绝规则。 [结果配对][sy-tool-pair] · [历史编码][sy-tool-replay] · [Web Search 拒绝测试][sy-server-tool-test] · [原生调用规则][sy-server-output]
- **交错 SSE。** Responses decoder 用终态快照对账各调用的参数。Anthropic encoder 让工具块依次输出，其他工具的参数先暂存。现有多工具不重叠测试以 Chat Completions 为源，Responses 方向有单函数测试。文本和 thinking 的开块分支仍可能与活动工具块重叠。 [终态对账][sy-args-terminal] · [工具暂存][sy-queue] · [并行测试输入][sy-parallel-fixture] · [Responses 单函数测试][sy-single-fixture] · [其他块的开块条件][sy-late-blocks]
- **多模态。** 支持 URL/base64 图像。文档 URL 变成 `file_url`，文本和 base64 文档可用 `file_data`，内联 PDF 补文件名。工具结果复用同一媒体转换。跨上游文件 ID 或无法表示的媒体由有损策略处理。 [图像来源][sy-image] · [文档来源][sy-pdf] · [工具媒体测试][sy-result-media] · [媒体回退][sy-media-fallback]
- **计数与用量。** `/v1/messages/count_tokens` 选择原生 Anthropic 计数目标，仅有 Responses 目标时返回 400 `count_tokens_unsupported`。 `/v1/responses/input_tokens` 是独立入口。IR 保留缺失和显式零，Messages JSON 缺值时补零，SSE 终态完全没有上游 usage 时用文本 delta 次数填充输出计数。该次数是事件数。 [计数入口][sy-count] · [计数操作][sy-count-ops] · [IR usage][sy-usage-ir] · [JSON 缺值][sy-usage-buffer] · [文本事件计数][sy-usage-increment] · [SSE 兜底][sy-usage-stream]

## 与 Little Gate 对照

- **生产路由。** 现分支的 `messages_via_responses_enabled` 对 `openai` 和 `openai_compatible_responses` 模型按需开启。Codex OAuth 在该路由表中只有原生 Responses 入口。Sub2API 的普通 API Key 分支和 Switchyard 的 `openai_responses` 目标适合对照直连 Responses。CLIProxyAPI 的 Codex 转换另外依赖自己的上游约定。 [Little Gate 路由](../backend/src/proxy.rs#L2449)
- **并行工具。** 现有转换以 `output_index` 路由参数，见到调用就发 `content_block_start`。对照 CLIProxyAPI，可让每个上游调用独立积累参数、按出现顺序交付，并回归 A 和 B 交错、B 先完成、终态补齐和参数截断。验收同时检查块生命周期和下一轮的 `call_id`。 [增量定位](../backend/src/messages_via_responses.rs#L516) · [下游开块](../backend/src/messages_via_responses.rs#L573) · [交错用例][cli-tool-test] · [Switchyard 工具暂存][sy-queue]
- **Thinking 和服务端工具。** 当前请求侧接收文本、图像和客户端函数工具历史。两套 Go 实现将供应商的推理密文限在可回放的路由内，并为 Web Search 定义专用的请求和结果块。由此可分别验证密文来源匹配、切换路由时的处理，以及搜索工具的 ID 和结果关联。 [Little Gate 入站处理](../backend/src/messages_via_responses.rs#L45) · [签名家族][cli-signature-family] · [服务端搜索][sub-web-search]
- **多模态。** 现分支已能转用户和工具结果中的 URL/base64 图像。CLIProxyAPI 的文档分支提供文本展开、内联 PDF 和 URL 文件映射的对照。Switchyard 的 PDF 用例覆盖 HTTP 两端及 JSON 和 SSE。复现时分别观察出站媒体形状和下一轮工具回传保留的内容。 [现有图像与结果映射](../backend/src/messages_via_responses.rs#L200) · [文档来源][cli-media-source] · [PDF 集成测试][sy-integration]
- **上下文计数。** Little Gate 优先使用原生 Messages 计数，其次查询具备计数能力的 Responses 端点。Sub2API 展示了显式支持端点的账号如何做远端计数，CLIProxyAPI 展示了将转换后的有效输入送给模型 tokenizer 的本地方式。 [远端计数][sub-count-request] · [本地 tokenizer][cli-count]
- **缺失 usage。** Little Gate 的原始用量解析已经返回 `Option<Usage>`，转换器在编码消息时补入数值零，随后流式日志又从转换后的事件识别统计。保留原始计量的存在状态即可单独表示缺失和实测为零，Anthropic 输出可继续使用协议需要的数值字段。 [原始解析](../backend/src/response_events.rs#L281) · [转换默认值](../backend/src/messages_via_responses.rs#L280) · [日志观察](../backend/src/response_events.rs#L438) · [Switchyard 内部表示][sy-usage-ir]

[cli-register]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/init.go#L12-L27
[cli-route]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/runtime/executor/codex_executor_stream.go#L46-L70
[cli-stream]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/runtime/executor/codex_executor_stream.go#L123-L153
[cli-terminal]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/runtime/executor/codex_executor_stream.go#L521-L549
[cli-thinking-out]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_response.go#L325-L345
[cli-signature-delta]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_response.go#L1103-L1128
[cli-thinking-in]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_request.go#L289-L321
[cli-signature-family]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/common/codex_replay_signature.go#L30-L63
[cli-tool-in]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_request.go#L386-L445
[cli-search-in]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_request.go#L719-L792
[cli-search-out]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_response_web_search.go#L12-L88
[cli-tool-keys]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_response.go#L625-L642
[cli-tool-queue]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_response.go#L717-L810
[cli-terminal-calls]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_response.go#L826-L858
[cli-tool-lifecycle]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_parallel_function_calls_test.go#L32-L107
[cli-tool-test]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_parallel_function_calls_test.go#L134-L175
[cli-media-req]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_request.go#L343-L385
[cli-media-source]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_request.go#L1342-L1413
[cli-media-result]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_request.go#L440-L469
[cli-count]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/runtime/executor/codex_executor_tokens.go#L19-L89
[cli-count-segments]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/runtime/executor/codex_executor_tokens.go#L91-L202
[cli-usage-wire]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/translator/codex/claude/codex_claude_response.go#L195-L219
[cli-start-estimate]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/runtime/executor/helps/claude_input_tokens.go#L25-L102
[cli-usage-fallback]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/runtime/executor/helps/usage_helpers.go#L670-L681
[sub-dispatch]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L73-L96
[sub-normalization]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/anthropic_to_responses.go#L48-L91
[sub-upstream]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_forward.go#L1399-L1436
[sub-force-stream]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L155-L183
[sub-response]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L537-L545
[sub-reasoning-wire]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/responses_to_anthropic.go#L666-L688
[sub-thinking-close]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/responses_to_anthropic.go#L835-L855
[sub-thinking-replay]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/anthropic_to_responses.go#L314-L338
[sub-continuation]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L138-L152
[sub-latest-turn]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L185-L191
[sub-retry]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L508-L519
[sub-tool-in]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/anthropic_to_responses.go#L486-L505
[sub-web-search]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/responses_to_anthropic.go#L693-L739
[sub-emulation]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L36-L57
[sub-tool-open]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/responses_to_anthropic.go#L389-L425
[sub-tool-delta]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/responses_to_anthropic.go#L546-L637
[sub-tool-test]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/responses_to_anthropic_parallel_tool_test.go#L13-L26
[sub-raw-sse]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L1235-L1262
[sub-input-media]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/anthropic_to_responses.go#L247-L289
[sub-media-source]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/anthropic_to_responses.go#L391-L449
[sub-count]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_count_tokens.go#L253-L326
[sub-count-status]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_count_tokens.go#L341-L389
[sub-count-request]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_count_tokens.go#L393-L449
[sub-usage-wire]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/pkg/apicompat/responses_to_anthropic.go#L777-L831
[sub-usage-read]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L1131-L1168
[sub-usage-log]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_response_handling.go#L1363-L1428
[sub-usage-buffer]: https://github.com/Wei-Shaw/sub2api/blob/0f6671457132425d1b84f3d80536b53e02942424/backend/internal/service/openai_gateway_messages.go#L690-L711
[cli-start-estimate-condition]: https://github.com/router-for-me/CLIProxyAPI/blob/85225381d89915595598ed13766cd79890c03a84/internal/runtime/executor/helps/claude_input_tokens.go#L350-L399

[sy-http]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-server/src/lib.rs#L576-L603
[sy-auth]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-server/src/lib.rs#L1062-L1110
[sy-target]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-runner/src/config.rs#L1620-L1647
[sy-url]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/libsy-llm-client/src/backend.rs#L217-L227
[sy-server-role]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/README.md#L139-L149
[sy-integration-upstream]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-server/tests/server.rs#L6812-L6835
[sy-integration]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-server/tests/server.rs#L6845-L6903
[sy-engine]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/engine.rs#L70-L157
[sy-policy]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/README.md#L99-L120
[sy-pdf]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/openai_media.rs#L110-L157
[sy-image]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/openai_media.rs#L35-L71
[sy-result-media]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/tests/request_translation.rs#L5064-L5109
[sy-media-fallback]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/responses/buffered.rs#L1601-L1636
[sy-thinking-in]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/responses/buffered.rs#L1321-L1338
[sy-thinking-out]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/anthropic/buffered.rs#L1126-L1140
[sy-thinking-sse]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/anthropic/stream.rs#L543-L559
[sy-reasoning-policy]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/libsy-llm-client/src/responses_reasoning.rs#L36-L113
[sy-signed-reverse]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/tests/stream_translation.rs#L1969-L2053
[sy-tool-pair]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/responses/buffered.rs#L1419-L1458
[sy-tool-replay]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/responses/buffered.rs#L1487-L1530
[sy-server-tool-test]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/tests/request_translation.rs#L197-L221
[sy-server-output]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/responses/mod.rs#L16-L59
[sy-queue]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/anthropic/stream.rs#L569-L633
[sy-late-blocks]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/anthropic/stream.rs#L499-L541
[sy-args-terminal]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/responses/stream.rs#L840-L872
[sy-parallel-fixture]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/tests/anthropic_parallel_tools.rs#L29-L79
[sy-single-fixture]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/tests/stream_translation.rs#L2073-L2099
[sy-count]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-server/src/lib.rs#L866-L905
[sy-count-ops]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/libsy-llm-client/src/client.rs#L101-L130
[sy-usage-ir]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/docs/protocols/llm.md#L59-L62
[sy-usage-buffer]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/anthropic/buffered.rs#L1406-L1421
[sy-usage-increment]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/anthropic/stream.rs#L197-L225
[sy-usage-stream]: https://github.com/NVIDIA-NeMo/Switchyard/blob/5386e20657a9a5e43bf6e4ba1895c1db5b68ea23/crates/switchyard-translation/src/codecs/anthropic/stream.rs#L697-L723
