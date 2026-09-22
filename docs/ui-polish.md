# 控制台视觉与交互验收

本次面向网关管理员的日常操作：查看请求与用量、管理上游和模型、排查日志、维护访问密钥。保留现有路由、接口、拖拽排序、列表筛选、详情抽屉和编辑流程。

采用项目已有的 Material UI、Lucide 图标和 Tailwind，继续使用现有主题与 CSS tokens，不新增组件库、字体或动效依赖。界面以浅冷灰背景、白色内容面板和蓝色主操作建立层级，表格保留紧凑布局，触摸设备加大输入框和按钮的操作区域。

主要调整包括：

- 统一导航、登录、页面工具栏、统计卡片、表格、表单、状态标签、空状态和弹层样式。
- 窄屏使用导航抽屉，选择页面后关闭；Escape 关闭后恢复焦点。桌面仍可拖动或用键盘调整导航顺序，顺序继续持久化。
- 总览按请求、用量与消费优先呈现，CPU 与内存显示实际使用比例。切换时间范围时不显示上一范围的数据，尚未获取健康信息时显示等待状态；同一范围刷新失败时保留旧数据并提供重试。
- 登录支持显示或隐藏口令；操作消息提供可关闭的提示，复制失败有反馈；高级筛选收起后保留输入。
- 渲染中的翻译通过 `useI18n` 订阅语言变化，翻译函数的引用随语言变化，避免 React Compiler 保留旧语言的文字。事件回调仍读取当前语言，切换语言不重新挂载页面，因此保留表单草稿与筛选条件。

## 验证结果

2026-09-22 完成：

| 检查 | 结果 |
| --- | --- |
| `npm --prefix frontend test` | 10 个测试文件、84 项测试通过，包含时间范围请求乱序回归 |
| `npm --prefix frontend run build` | 邮件模板检查、TypeScript 和 Rsbuild 生产构建通过 |
| `scripts/console-ui-smoke.cjs` | 11 组浏览器验收通过，生成 23 张截图，无意外控制台错误 |
| `scripts/price-sync-ui-smoke.cjs` | 18 项价格同步与表格滚动检查通过 |
| `git diff --check` | 通过 |

浏览器验收覆盖登录错误与重试、复制成功与拒绝授权、总览等待/刷新失败/重试、模型搜索及空状态、详情返回保留筛选、键盘导航排序、移动导航焦点恢复、取消密钥创建、语言切换保留未保存的价格源配置，以及减少动态效果设置。

1440 px 桌面与 390 px 触摸设备检查覆盖总览、上游、OAuth、模型、价格、日志、通知与设置，并检查登录、密钥及详情表单。额外在 320、768、1024 px 检查模型、设置和日志没有全页横向溢出。宽表仍在自身容器内横向滚动。

## 重现浏览器验收

启动前端后，在提供 Playwright 的环境中执行：

```bash
npm --prefix frontend run dev
```

另一个终端运行：

```bash
CONSOLE_UI_URL=http://127.0.0.1:4173 node scripts/console-ui-smoke.cjs
PRICE_SYNC_UI_URL=http://127.0.0.1:4173 node scripts/price-sync-ui-smoke.cjs
```

可以通过 `PLAYWRIGHT_MODULE` 指定现有 Playwright 模块的路径。控制台验收脚本另外支持 `CHROMIUM_EXECUTABLE_PATH`，用于指定已安装的 Chromium。

控制台报告和截图默认输出到 `/tmp/console-ui`，可用 `CONSOLE_UI_ARTIFACTS` 修改。主要截图为 `overview-desktop.png`、`models-desktop.png`、`overview-mobile.png`、`navigation-mobile.png`、`models-mobile-english.png`，完整结果见 `report.json`。价格同步截图默认输出到 `/tmp/price-sync-ui`。

浏览器脚本使用拦截的 API 测试数据，截图中的指标与账号不代表真实服务。真实 OAuth 授权、外部供应商连接和线上价格源的联调不在这次浏览器验收范围内。后端代码与依赖未改动。
