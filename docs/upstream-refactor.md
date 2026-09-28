# 上游配置与模型路由精简：过渡版本交付说明

本次改造基于 `LLMGatewayOptimized.md` 和已确认的分阶段方案，保留 Rust / React / Material UI 技术栈。正式控制台以“上游连接 → 模型路由 → 访问授权”组织配置，上游详情使用连接、高级设置、状态 / 调试三个 Tab。旧管理资源保留一个版本的适配层。

这里的数据库验证全部使用临时 SQLite / PostgreSQL 数据库。没有升级工作区中的实际业务数据库；升级程序首次启动时才会对其配置的数据库执行迁移。

## 功能对照与完成状态

| 功能 | 本版本状态 | 实现与边界 |
|---|---|---|
| 上游名称、类型、启用 | 已完成 | 连接页顶部独立保存和取消，状态刷新不覆盖草稿 |
| 原子创建 | 已完成 | 同一事务创建上游、地址、加密凭据；同步在提交后执行，失败保留上游并提供单独重试 |
| 地址列表 | 已完成 | 紧凑主 / 备用行，点击编辑展开，一次编辑一项 |
| 地址顺序与选择 | 已完成 | 拖动和键盘可用的上移 / 下移；后端健康地址按 priority、ID 顺序选择，排序事务提交 |
| 地址测试 | 保留 | 就近显示可达结果，明确不验证 API Key |
| API Key 列表 | 已完成 | 名称、已配置、可用性和编辑入口；详情不返回明文或密文凭据 |
| Key 使用方式 | 已完成 + 存量兼容 | 正式使用轮流、主备；已有 weighted 执行兼容，新建或从其他方式切入 weighted 被拒绝 |
| 随机 Key | 按方案暂缓 | 无入口、无新增执行分支 |
| Key 模型限制 | 已完成 | 对应 Key 编辑区内的高级配置，沿用真实模型名校验 |
| 模型同步与摘要 | 已完成 | 分别记录尝试开始时间、成功完成时间、失败 HTTP 状态摘要；失败不覆盖库存、禁用状态或人工路由 |
| 模型库存、启停、显示与价格 | 保留 | 模型中心继续使用现有能力，上游入口携带 provider_id 跳转 |
| 路由与别名 | 已完成 | 模型中心新增默认 / 逐模型策略编辑；别名保留真实目标与模式；显式策略覆盖同名别名的调度方式及目标上游权重 |
| 上游全局优先级、权重 | 已迁移 | 正式上游接口拒绝，控制台删除；迁入默认模型路由，旧接口写入适配默认路由 |
| Sticky / 跨上游 Failover | 已完成 | 路由高级选项默认开启；绑定按访问密钥、会话、请求模型隔离，原 prompt cache 标识不变 |
| 调度组入口 | 已移除 + 接口兼容 | 正式 UI 无入口；旧关系仅用于兼容授权刷新，组内优先级覆盖不再参与运行时 |
| 访问密钥授权 | 已完成 | 直接多选允许上游；空列表无权限；HTTP、WS 每轮和模型列表共同使用直接授权 |
| 最大重试次数 | 已完成 | 0–2，默认 1；全请求共享至多 3 次发送预算，涵盖 OAuth 重放 |
| 单上游超时 | 已完成 | 可空，继承全局；覆盖 HTTP 发送 / 读取和 WS 每轮等待，同时受请求剩余截止时间约束 |
| 地址故障自动切换 | 已完成 | 默认开启，关闭后不切换同一上游的地址；独立于 Key 和跨上游切换 |
| 熔断阈值编辑 | 已移除 + 存量兼容 | 新建使用原默认值；旧配置及过渡接口仍保留自定义保护参数 |
| 最大并发 | 保留并重组 | 配置在请求策略，当前占用在状态 Tab |
| WebSocket | 保留 | 原生 WS 及相关回归保留 |
| WebSocket 回退 HTTP | 已完成 | 协议兼容区改为准确文案；底层旧 responses-http-to-ws 标记在兼容期保留 |
| HTTP 转上游 WS | 按方案不支持 | 能力声明为 false，无入口 |
| Usage 补充 | 保留并重组 | 协议兼容区说明用于 Chat Completions 流式请求 |
| Header / Body 覆写 | 已完成 | 默认显示数量，点击配置才挂载并加载规则编辑器；独立保存 / 取消 |
| Response Rewrite | 按方案不支持 | 能力声明为 false，无空壳入口 |
| EWMA、并发、亲和数 | 已完成 | 独立 runtime 接口与状态 Tab，10 秒刷新，关闭或切走停止轮询 |
| 地址 / Key 健康、冷却 | 保留并重组 | 连接页简短状态，状态页详细原因与配额等待；重置故障不清除 Retry-After 等待 |
| 最近错误 | 已完成 | 每上游最多 50 条内存记录，包含最终成功前的失败尝试；不存远端响应正文或密钥；重启清空 |
| 删除上游 | 已完成 | 顶部更多菜单，保留确认、级联清理和历史日志 |
| 能力声明 | 已完成 | system/config 声明已闭环能力，UI 据此显示可操作配置 |
| 概览加载 | 已完成 | 一次 /upstreams 获取数量和摘要，打开详情后才获取单个配置，去除 1+2N 网络请求 |
| 全局节点分配 | 已移除 | 设置页不再提供 weighted / latency 地址选择；旧设置仅为弃用兼容字段 |
| Codex OAuth | 保留 | 独立账号登录、刷新、额度、模型同步和 WS 能力；不转换为普通 Key 表单 |
| 草稿与导航 | 已完成 | 分区保存、取消、失败保留、跨 Tab 保留；关闭、站内跳转和浏览器返回保护未保存修改 |
| 下一版本删除兼容层 | 后续版本 | 本次有意保留旧字段、旧组资源和适配代码，不属于本轮删除范围 |

## 新接口契约

所有管理接口仍要求管理员 Bearer Token。新前端上游读写使用 `/api/v1/upstreams`；单个地址、Key、模型库存和别名子资源复用既有管理资源。

| 方法和路径 | 请求 / 返回 |
|---|---|
| GET `/api/v1/upstreams` | `[{provider,endpoints:[],keys:[]}]`；provider 含连接摘要、endpoint_count、key_count、model_count、model_sync、routing_availability，不包含所有子资源 |
| POST `/api/v1/upstreams` | 名称、provider_type、endpoints、keys；返回 id、endpoint_ids、key_ids。可选请求策略和协议字段使用默认值 |
| GET `/api/v1/upstreams/{id}` | `{provider,endpoints,keys}`，Key 仅元数据；provider 无全局调度字段、组、熔断编辑参数和详细运行计数 |
| PATCH `/api/v1/upstreams/{id}` | 部分修改连接配置；不接受 priority、weight、groups；支持 max_retries、request_timeout_ms、endpoint_failover |
| DELETE `/api/v1/upstreams/{id}` | 复用既有删除行为 |
| GET `/api/v1/upstreams/{id}/runtime` | provider 的健康、运行计数、亲和数；地址 / Key 健康及额度；recent_errors |
| GET / PUT `/api/v1/model-route-policies` | 读取全部策略 / 保存一个完整策略 |
| DELETE `/api/v1/model-route-policies` | JSON `{ "model_name": "..." }` 恢复该模型的默认路由；禁止删除 `*` |
| GET `/api/v1/upstream-migration` | 当前数据库本次版本化迁移保存的报告 |
| POST / PATCH `/api/v1/api-keys[/{id}]` | `allowed_provider_ids: number[]`；空列表明确无权限 |
| GET `/api/v1/system/config` | 新增 capabilities，见下文 |

新路由示例：

```json
{
  "model_name": "*",
  "mode": "ordered",
  "sticky": true,
  "failover": true,
  "targets": [
    { "provider_id": 1, "priority": 10, "weight": 1 },
    { "provider_id": 2, "priority": 20, "weight": 1 }
  ]
}
```

priority 越小越先选择；ordered 在同优先级内以 provider ID 稳定排序。weighted 在同优先级内按目标 weight 抽样。模型库存、全局 / 单上游启停、协议支持、Key 模型限制、直接授权和健康保护继续筛选目标。新建数据库默认 ordered；已有配置迁移为 weighted，以承接旧上游权重。未配置单独策略的模型使用 `*`，仍保留未同步库存时的候选发现行为。

`max_retries` 是 0–2 的整数，对应总尝试数加一；`request_timeout_ms` 是 null 或 1–3600000；`endpoint_failover` 默认 true。原 `max_attempts` 只在兼容模型中保留，全请求硬上限仍为 3。

能力声明：

```json
{
  "websocket": true,
  "websocket_to_http": true,
  "http_to_websocket": false,
  "response_rewrite": false,
  "request_rewrite": true
}
```

## 迁移与兼容边界

迁移版本为 1，SQLite 与 PostgreSQL 均在事务中创建新关系、复制权限、生成路由、固化别名权重并保存版本报告。再次启动只检查版本，不重复乘权重。SQLite 写事务提前获取写锁；PostgreSQL 修改默认路由目标时锁定对应行，防止并发创建丢失目标。

新增表：`upstream_migrations`、`api_key_authorization`、`api_key_allowed_providers`、`model_route_policies`、`upstream_request_options`、`upstream_sync_state`。无需新增环境变量。旧密钥密文、OAuth 账号、价格、模型启停、额度及历史日志均保留。

- 每个旧访问密钥按所属组的上游并集初始化授权，重复成员去重，停用上游的授权关系仍保留，但停用状态仍阻止路由。
- 迁移后的旧密钥先由兼容组关系管理。直接写入 allowed_provider_ids 后永久转为直接授权，后续旧组变化不再改变它；新上游也不会自动加入。
- 对直接授权密钥提交旧组授权字段返回 409；同时提交直接与组授权字段也返回 409。旧组内优先级覆盖写入返回 409 及迁移提示。
- 原上游 priority / weight 迁为默认路由目标。旧显式模型路由迁为逐模型策略。加权别名目标将原上游权重乘入一次，溢出以 i32 最大值封顶。
- 旧上游接口的优先级 / 权重修改适配默认路由；旧 routes 写入适配新策略。新策略成为运行时唯一的调度来源。
- 地址不再 weighted / latency 抽样，改为健康地址按 priority、ID 排序。旧全局选择器配置不再影响执行。
- 组内优先级覆盖无法等价保留。报告包含受影响密钥、目标上游、旧 / 新优先级顺序、模型库存快照和旧别名目标快照。顺序对照是配置优先级对照，不预测加权随机结果或请求时的健康状态。
- `/v1/models` 现在按调用密钥实际授权过滤。过去不同组可能看到相同的全局模型注册表；新行为有意收紧到可路由模型。
- 新日志增加 authorized_provider_ids 和 model_route；日志页面优先显示直接授权，同时继续兼容读取历史 authorized_groups。

迁移报告示例来自合成 PostgreSQL 验收库：[migration-fixture.json](evidence/upstream-refactor/migration-fixture.json)。实际升级后应从 `/api/v1/upstream-migration` 导出并保留本库报告。报告含配置 ID 与模型名称，不包含凭据。

升级前应备份实际数据库。迁移失败会回滚本次迁移；回退到旧程序必须恢复升级前备份，不承诺旧程序能理解新路由配置。兼容层预计在下一版本移除，本版本不删除旧表或旧字段。

## 验证与证据

专项回归使用本地模拟上游和临时数据库，无真实服务账号。路由、韧性和 OAuth 计量测试关闭自动云端价格下载，使执行不受外部目录更新和长写事务干扰；云端价格同步另有既有专项测试。

最终 pre-push 三项门禁通过：前端构建、85 项前端测试、262 项 Rust 测试；默认跳过的两个 PostgreSQL 测试已在独立数据库分别通过。格式、Clippy（警告视为错误）、SQLite / PostgreSQL HTTP 与 WS 专项、路由 / 归档、resilience、OAuth 计量及浏览器验收均通过。

工程验证结果和回归结果见 [validation.json](evidence/upstream-refactor/validation.json)。可复跑：

```bash
bash scripts/run-prek-checks.sh pre-push
cargo fmt --manifest-path backend/Cargo.toml --all -- --check
cargo clippy --manifest-path backend/Cargo.toml --all-targets --all-features --locked -- -D warnings
python3 scripts/run_upstream_config_regression.py
# 使用另一个空 PostgreSQL 验收数据库运行相同 HTTP / WS 专项：
UPSTREAM_TEST_DSN=postgres://... python3 scripts/run_upstream_config_regression.py
python3 scripts/run_regression.py --archive-compress
python3 scripts/run_resilience_regression.py
python3 scripts/run_oauth_metering_regression.py
# 必须使用空的、独立 PostgreSQL 验收数据库：
TEST_POSTGRES_DSN=postgres://... cargo test --manifest-path backend/Cargo.toml --locked postgres_permission_migration_is_atomic_and_idempotent -- --ignored
```

浏览器用相同的 2 地址、3 Key fixture 对照基线提交 `4be1df7` 与工作区。1920×1080、100% 缩放下连接页主操作与模型摘要均在首屏；390×844 无横向溢出。基线在独立 worktree 运行。当前仓库主题为固定浅色，不把设置一个无效的 localStorage 项当作暗色验收。

| 页面 | 桌面 | 窄屏 |
|---|---|---|
| 改造前 | [截图](evidence/upstream-refactor/before-desktop-light.png) | [截图](evidence/upstream-refactor/before-mobile-light.png) |
| 连接 | [截图](evidence/upstream-refactor/after-desktop-light.png) | [截图](evidence/upstream-refactor/after-mobile-light.png) |
| 高级设置 | [截图](evidence/upstream-refactor/after-advanced-desktop-light.png) | [截图](evidence/upstream-refactor/after-advanced-mobile-light.png) |
| 状态 / 调试 | [截图](evidence/upstream-refactor/after-runtime-desktop-light.png) | [截图](evidence/upstream-refactor/after-runtime-mobile-light.png) |

交互断言记录：[after-acceptance.json](evidence/upstream-refactor/after-acceptance.json)。脚本 `scripts/upstream-ui-smoke.cjs` 支持 CONSOLE_UI_URL、CONSOLE_UI_ARTIFACTS、PLAYWRIGHT_MODULE、CHROMIUM_EXECUTABLE_PATH；设置 UPSTREAM_UI_BASELINE=1 可在基线服务重建改造前证据。浏览器 fixture 验证界面与网络调用模式，真实后端行为由 Python 和 Rust 验证。
