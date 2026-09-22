// Browser acceptance against API fixtures; no running backend or real credentials required.
// CONSOLE_UI_URL, CONSOLE_UI_ARTIFACTS, PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE_PATH are optional.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = process.env.CONSOLE_UI_URL || 'http://127.0.0.1:4173';
const artifacts = process.env.CONSOLE_UI_ARTIFACTS || '/tmp/console-ui';
const price = { schema_version: 2, unit: 'usd_per_million_tokens', base: { input: '1.25', output: '10', cache_read: '0.125', cache_write: null }, tiers: [] };
const provider = {
  id: 7, name: 'OpenAI Production', provider_type: 'openai_compatible', enabled: true,
  priority: 100, weight: 1, supports_include_usage: true, websocket_enabled: false, beta_features: [],
  request_overrides: { headers: [], body: [] }, key_selection_strategy: 'round_robin', groups: [],
  max_attempts: 2, max_concurrency: null, circuit_breaker_enabled: true, circuit_breaker_failure_threshold: 3,
  circuit_breaker_open_ms: 30000, circuit_breaker_half_open_success_threshold: 2,
  routing_availability: { available: true, reason: 'available' },
};
const models = ['gpt-5.4', 'gpt-5.4-mini', 'claude-sonnet-4-6', 'gemini-3.1-pro', 'deepseek-chat', 'qwen3-coder', 'gpt-4.1', 'gpt-4.1-mini'].map((name, i) => ({
  id: i + 1, provider_id: 7, provider_name: provider.name, provider_type: provider.provider_type,
  upstream_model: name, alias: null, enabled: true, available: true, responses_via_chat_enabled: false,
  native_api_formats: ['chat_completions', 'responses'], created_at_ms: 1, updated_at_ms: 1,
}));
const overview = {
  period: 'today', window: { from_ms: 1900000000000, to_ms: 1900050000000 },
  kpis: { requests: 28416, failed: 23, error_rate: 0.08, p95_latency_ms: 1240, avg_latency_ms: 486 },
  service_health: { providers_enabled: 4, endpoints_enabled: 6, upstream_keys_enabled: 12, healthy: 4, warning: 0, error: 0 },
  server_status: { scope: 'container', cpu_usage_percent: 12.4, cpu_capacity_cores: 4, cpu_sample_ms: 1000, memory_used_bytes: 402653184, memory_total_bytes: 2147483648, memory_usage_percent: 18.75, memory_limited: true },
  token_usage: { total_tokens: 16736000, input_tokens: 9642000, output_tokens: 2844000, visible_output_tokens: 2344000, cache_read_input_tokens: 4250000, cache_creation_input_tokens: 0, reasoning_output_tokens: 500000, usage_observed_requests: 28416 },
  pricing: { versions: [{ id: 1, card: price }], usage_groups: [{ price_version_id: 1, tier_index: 0, request_count: 28416, input_tokens: 9642000, output_tokens: 2844000, cache_read_input_tokens: 4250000, cache_creation_input_tokens: 0 }] },
};
const config = {
  build: { version: '0.8.0', commit: '8f8e0a070719' },
  connection: { api_base: base, healthz_path: '/healthz', readyz_path: '/readyz', metrics_path: '/metrics' },
  basic: { db_dsn: 'sqlite::memory:', static_dir: 'frontend/dist', max_request_bytes: 16777216, usage_capture_bytes: 1048576, usage_capture_tail_bytes: 1024, log_queue_capacity: 1024, stats_flush_interval_ms: 1000 },
  routing: { endpoint_selector_strategy: 'weighted', inject_include_usage: true, upstream_cache_ttl_ms: 3000, upstream_cache_stale_grace_ms: 30000, api_key_cache_ttl_ms: 3000, api_key_cache_max_entries: 1024 },
  stability: { circuit_breaker_failure_threshold: 3, circuit_breaker_open_ms: 30000, upstream_connect_timeout_ms: 10000, upstream_request_timeout_ms: 60000 },
  retention: { request_log_retention_days: 30, stats_daily_retention_days: 365, cleanup_interval_ms: 60000, delete_batch: 1000, archive_enabled: false, archive_dir: 'archive', archive_compress: false },
};

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox'] });
  const errors = [], screenshots = [], requests = [], checks = [];
  let rejectLogin = true, failOverview = false, holdOverview = null, releaseOverview = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    context.setDefaultTimeout(10000);
    await context.addInitScript(({ base }) => { localStorage.setItem('little_gate_locale', 'zh'); localStorage.setItem('little_gate_api_base', base); }, { base });
    let page = await context.newPage();
    const watchErrors = page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        // These HTTP errors belong to the deliberate authentication / retry scenarios below.
        if (message.type() === 'error' && !/Failed to load resource: the server responded with a status of (401|503)\b/.test(message.text())) errors.push(message.text());
      });
    };
    watchErrors(page);
    const respond = async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      requests.push(`${route.request().method()} ${path}${url.search}`);
      let body = [], status = 200;
      if (path === '/api/v1/system/config') { body = rejectLogin ? { error: 'invalid token' } : config; status = rejectLogin ? 401 : 200; }
      else if (path === '/api/v1/stats/overview') {
        if (holdOverview) { const held = holdOverview; await held; }
        body = failOverview ? { error: 'overview temporarily unavailable' } : { ...overview, period: url.searchParams.get('period') };
        status = failOverview ? 503 : 200;
      } else if (path === '/api/v1/providers') body = [provider];
      else if (path === '/api/v1/providers/7/endpoints') body = [{ id: 71, provider_id: 7, base_url: 'https://api.example.com/v1', enabled: true, priority: 100, weight: 1 }];
      else if (path === '/api/v1/providers/7/keys') body = [{ id: 72, provider_id: 7, name: 'Production', enabled: true, priority: 100, weight: 1, routing_availability: { available: true, reason: null } }];
      else if (path === '/api/v1/provider-models') body = models;
      else if (path === '/api/v1/prices') body = models.map((model, i) => ({ id: i + 1, provider_id: null, model_name: model.upstream_model, price_data: price, source: 'cloud', created_at_ms: 1900000000000, updated_at_ms: 1900000000000 }));
      else if (path === '/api/v1/console-preferences') body = { model_column_widths: {}, log_column_widths: {}, log_visible_columns: ['time', 'model', 'status', 'duration'] };
      else if (path === '/api/v1/api-keys') body = [{ id: 1, name: 'Production', enabled: true, log_enabled: true, created_at_ms: 1900000000000, updated_at_ms: 1900000000000, provider_groups: [], expires_at_ms: null }];
      else if (path === '/api/v1/price-sync') body = { config: { enabled: true, interval_minutes: 30, source_url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json' }, running: false, last_success_ms: 1900000000000 };
      else if (path === '/api/v1/runtime-settings') body = { settings: [] };
      else if (path === '/api/v1/runtime-settings/env-preview') body = { profile: 'low-memory', hot_settings: [], restart_settings: [] };
      else if (path === '/api/v1/notifications/summary') body = { enabled_channels: 0, enabled_rules: 0, firing_alerts: 0, failed_deliveries_24h: 0 };
      else if (path.startsWith('/api/v1/notifications/')) body = { items: [], offset: 0, limit: 50 };
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    };
    await page.route('**/api/**', respond);
    const capture = async name => {
      const file = `${artifacts}/${name}.png`;
      await page.screenshot({ path: file, fullPage: !/navigation|detail|form|models.*mobile|keys.*mobile/.test(name), animations: 'disabled' });
      screenshots.push(file);
    };
    const fitsViewport = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflows: ${page.url()}`);
    const openPage = async (path, heading) => {
      await page.goto(base + path);
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      assert.deepEqual(errors, []);
      await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'));
      await fitsViewport();
    };

    await page.goto(base);
    const token = page.getByLabel('管理员口令', { exact: true });
    await token.fill('browser-fixture');
    await page.getByRole('button', { name: '显示口令', exact: true }).click();
    assert.equal(await token.getAttribute('type'), 'text');
    await page.getByRole('button', { name: '隐藏口令', exact: true }).click();
    assert.equal(await token.inputValue(), 'browser-fixture');
    await capture('login-desktop');
    await page.getByRole('button', { name: '进入控制台', exact: true }).click();
    await page.getByText('管理员口令不正确，请重新输入。', { exact: true }).waitFor();
    assert(await token.evaluate(element => document.activeElement === element));
    assert.equal(await token.inputValue(), 'browser-fixture');
    rejectLogin = false;
    await page.getByRole('button', { name: '进入控制台', exact: true }).click();
    await page.getByText('28.42k', { exact: true }).waitFor();
    checks.push('token visibility, rejected login preserves input and focus, successful retry');
    await capture('overview-desktop');

    await page.getByRole('button', { name: '复制地址', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), base);
    await page.locator('.MuiSnackbar-root').getByText('地址已复制。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    checks.push('clipboard value and visible dismissible feedback');
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied')) }); });
    await page.getByRole('button', { name: '复制地址', exact: true }).click();
    await page.locator('.MuiSnackbar-root').getByText('复制失败，请重试。', { exact: true }).waitFor();
    checks.push('clipboard rejection reports failure without an unhandled rejection');

    holdOverview = new Promise(resolve => { releaseOverview = resolve; });
    await page.getByRole('button', { name: '最近7小时', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('dl[aria-busy="true"]'));
    assert.equal(await page.locator('main').getByText('正常', { exact: true }).count(), 0);
    assert.equal(await page.getByText('28.42k', { exact: true }).count(), 0);
    releaseOverview(); holdOverview = null;
    await page.getByText('28.42k', { exact: true }).waitFor();
    failOverview = true;
    await page.getByRole('button', { name: '同步', exact: true }).click();
    await page.getByText('当前显示上次成功获取的数据。', { exact: true }).waitFor();
    failOverview = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('当前显示上次成功获取的数据。', { exact: true }).waitFor({ state: 'hidden' });
    checks.push('period loading uses unknown health, refresh failure preserves data, retry succeeds');

    await openPage('/models', '模型');
    const search = page.getByRole('textbox', { name: '搜索模型、别名或上游', exact: true });
    await page.getByRole('button', { name: 'gpt-5.4', exact: true }).waitFor();
    await search.fill('no-model-matches');
    await page.getByText('未找到模型', { exact: true }).waitFor();
    await search.fill('gpt-5.4');
    await page.waitForFunction(() => document.querySelectorAll('tbody > tr').length === 2);
    await page.getByRole('button', { name: 'gpt-5.4', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await capture('model-detail-desktop');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await search.inputValue(), 'gpt-5.4');
    await search.fill('');
    await page.waitForFunction(() => document.querySelectorAll('tbody > tr').length === 8);
    await capture('models-desktop');
    checks.push('model search, empty state, detail drawer and preserved list filter');
    const navigationItem = page.locator('[data-nav-key="models"]');
    await navigationItem.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('little_gate_nav_order') || '[]')[2] === 'models');
    assert.equal(await navigationItem.getAttribute('href'), '/models');
    checks.push('keyboard navigation reordering and persisted order');

    for (const [path, heading] of [['/upstreams', '上游'], ['/keys', '访问密钥'], ['/oauth', 'OAuth 登录'], ['/notifications', '通知'], ['/settings', '设置'], ['/models/aliases', '模型'], ['/models/prices', '模型']]) {
      await openPage(path, heading);
      await capture(path.replaceAll('/', '-').slice(1) + '-desktop');
    }
    await openPage('/logs', '日志');
    await page.getByRole('button', { name: '高级筛选', exact: true }).click();
    const latency = page.getByPlaceholder('延迟下限', { exact: true });
    await latency.fill('250');
    await page.getByRole('button', { name: '收起筛选', exact: true }).click();
    await latency.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '高级筛选', exact: true }).click();
    assert.equal(await latency.inputValue(), '250');
    await capture('logs-desktop');
    checks.push('all routes mount, advanced filter values survive collapse');

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    mobileContext.setDefaultTimeout(10000);
    await mobileContext.addInitScript(({ base }) => {
      localStorage.setItem('little_gate_locale', 'zh');
      localStorage.setItem('little_gate_api_base', base);
      sessionStorage.setItem('little_gate_admin_token', 'browser-fixture');
    }, { base });
    page = await mobileContext.newPage();
    watchErrors(page);
    await page.route('**/api/**', respond);
    await openPage('/overview', '总览');
    await page.getByText('28.42k', { exact: true }).waitFor();
    await capture('overview-mobile');
    const opener = page.getByRole('button', { name: '打开导航', exact: true });
    await opener.click();
    await capture('navigation-mobile');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '主导航', exact: true }).waitFor({ state: 'hidden' });
    assert(await opener.evaluate(element => document.activeElement === element));
    await opener.click();
    await page.getByRole('navigation', { name: 'Primary' }).locator('[data-nav-key="keys"]').click();
    await page.getByRole('dialog', { name: '主导航', exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: '访问密钥', exact: true }).waitFor();
    await page.getByRole('button', { name: '创建访问密钥', exact: true }).first().click();
    await page.getByRole('dialog').waitFor();
    await capture('key-form-mobile');
    await fitsViewport();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert(!requests.some(request => request === 'POST /api/v1/api-keys'));
    checks.push('mobile navigation, Escape restores focus, navigation closes on selection, key form cancellation');

    for (const [path, heading] of [['/models', '模型'], ['/logs', '日志'], ['/settings', '设置'], ['/notifications', '通知'], ['/upstreams', '上游'], ['/oauth', 'OAuth 登录'], ['/models/prices', '模型']]) {
      await openPage(path, heading);
      await capture(path.replaceAll('/', '-').slice(1) + '-mobile');
    }
    await openPage('/models/prices', '模型');
    const sourceUrl = page.locator('input[type="url"]');
    await sourceUrl.fill('https://example.com/custom-catalog.json');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('heading', { name: 'Model', exact: true }).waitFor();
    await page.getByText('Cloud price sync', { exact: true }).waitFor();
    assert.equal(await sourceUrl.inputValue(), 'https://example.com/custom-catalog.json');
    await page.getByRole('button', { name: 'ZH', exact: true }).click();
    await page.getByRole('heading', { name: '模型', exact: true }).waitFor();
    assert.equal(await sourceUrl.inputValue(), 'https://example.com/custom-catalog.json');
    checks.push('language changes update compiled UI and preserve an unsaved form draft');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPage('/models', '模型');
    assert(await page.evaluate(() => matchMedia('(pointer: coarse)').matches));
    assert((await page.locator('.MuiInputBase-root').first().boundingBox()).height >= 44);
    const mobileSearch = page.getByRole('textbox', { name: '搜索模型、别名或上游', exact: true });
    await mobileSearch.fill('gpt-5.4');
    await page.waitForFunction(() => new URLSearchParams(location.search).get('q') === 'gpt-5.4' && document.querySelectorAll('tbody > tr').length === 2);
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.getByRole('heading', { name: 'Model', exact: true }).waitFor();
    assert.equal(await page.locator('main input').first().inputValue(), 'gpt-5.4');
    await fitsViewport();
    await capture('models-mobile-english');
    const transition = await page.locator('.MuiButton-root').first().evaluate(element => getComputedStyle(element).transitionDuration);
    assert(transition.split(',').every(value => parseFloat(value) <= 0.001));
    checks.push('mobile routes, English layout, reduced motion');
    for (const width of [320, 768, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/models', '/settings', '/logs']) {
        await page.goto(base + path);
        await page.locator('main').waitFor();
        await fitsViewport();
      }
    }
    checks.push('320 / 768 / 1024 px layouts do not overflow');
    assert.deepEqual(errors, []);
    const report = { ok: true, fixtureData: true, checks, screenshots, consoleErrors: errors };
    await fs.writeFile(`${artifacts}/report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { releaseOverview?.(); await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
