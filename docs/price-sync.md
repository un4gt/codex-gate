# 云端价格同步

模型中心的「价格管理」默认从 `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` 同步 [LiteLLM](https://www.litellm.ai/) 官方仓库的价格目录。目录独立于渠道模型库存：不会创建路由模型、修改模型 ID 或切换启用状态。

## 配置与运行

首次启动后台异步同步一次，之后默认每 30 分钟执行；若共享数据库在最近 5 分钟内已有同步尝试，重启或新副本会复用其状态，避免重复下载。环境变量初始值：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PRICE_SYNC_ENABLED` | `true` | 自动同步开关 |
| `PRICE_SYNC_SOURCE_URL` | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | LiteLLM JSON 价格源（兼容旧 JSON/TOML），不接受 URL 内嵌认证信息 |
| `PRICE_SYNC_INTERVAL_MINUTES` | `30` | 5 至 10080 分钟 |

管理员在价格页修改后，配置写入现有 `runtime_settings` 的 `price_sync` 项，优先于环境变量，无需重启。若实例此前已保存旧数据源，更新默认值不会覆盖该配置；需在价格页将数据源改为上面的 LiteLLM 地址。本地 `.env` 中的显式地址也需同步更新。多实例每 30 秒读取一次最新配置。新缺价模型由后台库存扫描发现，最多每 5 分钟触发一次补齐，同一目录版本中已检查的缺失模型记录在数据库中，不因副本切换而重复触发。定时任务仍会按配置刷新目录。

下载总超时为 60 秒，响应最多 64 MiB。解析在阻塞任务池执行，不阻塞启动或请求处理。进程入口互斥及数据库租约合并并发任务；租约为 5 分钟，活动任务每分钟续租，应用事务使用所有者校验防止过期任务写入。失败保留上次有效目录和报价。源不支持认证重定向；填写最终公开下载地址。

## 价格选择与历史

旧价格迁移为 `manual`。优先级为渠道专属价格、全局手工价格、全局云端价格。自动任务只维护全局云端价格；编辑云端价格会创建新的手工版本。相同标准化价格不创建新版本，名称、品牌等变化只更新目录。源删除模型时保留历史有效价，并显示源中缺失。

默认解析 LiteLLM 的模型 ID → 元数据 JSON，跳过 `sample_spec`。模型 ID 精确匹配，保留渠道前缀，不推导别名或混用不同渠道报价。输入、输出、缓存读取、缓存写入的每 token 美元单价乘以一百万，使用精确十进制；缺失或 null 字段为未知，零价格仍表示免费。目录内容哈希用于源版本标识。

`*_above_<数量>_tokens` 字段转换为严格大于输入 token 阈值的价格层级，支持 `k` 后缀。音频、图像、按次、缓存时长、批量、服务档位及其他费用字段保留在元数据中并标记部分适配，不纳入当前 token 费用。无可用 token 单价的模型标记未适配。LiteLLM 的 `litellm_provider` 记录为报价渠道，不直接当作模型制造商品牌。

兼容已有自定义 CCH JSON 和旧 TOML 格式，但默认不会请求私人平台，也不会在 LiteLLM 下载失败时回退到其他平台。兼容 JSON 仍选第一个有效官方报价，并仅扩展明确且无冲突的别名。

同步后使用现有历史对账补算可确定费用的未计价请求；已能按原价格版本计价的请求保持原版本。对账失败记录任务提示，可通过后续价格同步或现有统计查询重试。

## 手动同步与接口

先点击「立即同步 · 先预览」。预览展示新增、更新、未变化、保留手工和失败/未适配计数，以及每项手工价格冲突的两份报价。默认保留所有手工价，勾选后才改用云端。应用绑定目录版本及所有相关本地价格版本；发生并发编辑或更晚的同步时整个事务回滚，必须重新预览。预览保留最多 24 小时。

所有接口沿用管理员认证：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/price-sync` | 配置、租约状态、最近任务和执行时间 |
| PUT | `/api/v1/price-sync/config` | `{enabled, source_url, interval_minutes}` |
| POST | `/api/v1/price-sync/preview` | 202 返回任务 `id` |
| GET | `/api/v1/price-sync/jobs/{id}` | 轮询任务与冲突结果 |
| POST | `/api/v1/price-sync/apply/{id}` | `{source_version, use_cloud: [model_id]}`，202 返回应用任务，继续轮询 |

价格和模型库存接口增加 `display` 元数据；价格接口增加 `source`、`source_version`。不会把完整云端源文件发到浏览器。SQLite/PostgreSQL 启动迁移添加 `model_prices.source/source_version`、独立 `cloud_model_catalog`、`price_sync_jobs`、`price_sync_control` 和 `price_sync_missing`；保留现有单范围单生效价格约束。

## 本地品牌资源和表格

模型图标按制造商映射，未识别品牌显示通用模型图标，复制按钮始终复制请求 ID。本地图标来自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)，MIT 许可证随资源保存在 `frontend/public/brands/LICENSE`。

所有管理表格使用共享 MUI 容器。辅助横向滚动条属于各自表格，在视窗及滚动祖先的可见范围内定位，表格不可见或没有横向溢出时隐藏。原有粘性表头、固定列及原生触控板横向滚动继续生效。

本次不执行生产部署。部署时先备份数据库，正常启动即可自动运行两种数据库的幂等迁移。

## 回归验证

```bash
cargo test --manifest-path backend/Cargo.toml --locked
cargo build --manifest-path backend/Cargo.toml --locked
python3 scripts/price_sync_regression.py
python3 scripts/run_regression.py --archive-compress
npm --prefix frontend test -- --pool=threads --pool.maxWorkers=1 --testTimeout=15000
npm --prefix frontend run build
```

`price_sync_regression.py` 使用临时目录、临时 SQLite 数据库和本地 HTTP 源，不访问真实上游。运行浏览器回归时先启动 `npm --prefix frontend run dev -- --port 4174`，然后运行 `node scripts/price-sync-ui-smoke.cjs`；需要可用的 Playwright Chromium。可用 `PLAYWRIGHT_MODULE` 指定 Playwright 模块路径，用 `PRICE_SYNC_UI_URL` 指定页面地址，截图默认写入 `/tmp/price-sync-ui`。

Rust 的 `parses_published_catalog_fixture` 默认使用仓库内精简源样本；设置 `PRICE_SYNC_TEST_CATALOG=/path/to/models.json` 或 TOML 可验证下载的完整目录。`sync_preserves_manual_prices_versions_and_inventory_and_rejects_stale_preview` 默认使用内存 SQLite，可通过 `PRICE_SYNC_TEST_DB` 指向**专用空 PostgreSQL 测试数据库**运行同一套事务和幂等迁移检查。
