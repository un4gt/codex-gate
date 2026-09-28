// Browser acceptance against API fixtures; no running backend or real credentials required.
// CONSOLE_UI_URL, CONSOLE_UI_ARTIFACTS, PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE_PATH are optional.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = process.env.CONSOLE_UI_URL || 'http://127.0.0.1:4174';
const baseline = process.env.UPSTREAM_UI_BASELINE === '1';
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
provider.endpoint_count = 2; provider.key_count = 3; provider.model_count = 8;
provider.max_retries=1; provider.endpoint_failover=true; provider.model_sync={last_attempt_ms:1790596800000,last_success_ms:1790596800000,error:null};
const endpoints = [71,72].map((id,i)=>({id,provider_id:7,name:i?'备用':'主地址',base_url:`https://api${i ? '-backup' : ''}.example.com/v1`,enabled:true,priority:i*10,weight:1}));
const keys = [81,82,83].map((id,i)=>({id,provider_id:7,name:['Production','Backup','Team'][i],enabled:true,configured:true,priority:i*10,weight:1,routing_availability:{available:true,reason:null}}));
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
  capabilities: {websocket:true,websocket_to_http:true,http_to_websocket:false,response_rewrite:false,request_rewrite:true},
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
      else if (path === '/api/v1/providers/7/endpoints') body = endpoints;
      else if (path === '/api/v1/providers/7/keys') body = keys;
      else if (path === '/api/v1/upstreams') body = [{provider,endpoints:[],keys:[]}];
      else if (path === '/api/v1/upstreams/7/runtime') body = {provider:{...provider,runtime:{in_flight:1,latency_ewma_ms:230},affinity_sessions:4},endpoints,keys,recent_errors:[]};
      else if (path === '/api/v1/upstreams/7') {
        if (route.request().method()==='PATCH') { status=503; body={error:'保存失败（验收模拟）'}; }
        else body = {provider,endpoints,keys};
      }
      else if (/\/api\/v1\/endpoints\/\d+\/test$/.test(path)) body={ok:true,status:200,message:null};
      else if (path === '/api/v1/upstreams/7/endpoints/order') { const ids=route.request().postDataJSON().ids; endpoints.sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id)); body={ok:true}; }
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

    rejectLogin=false;
    await context.addInitScript(() => sessionStorage.setItem('little_gate_admin_token','browser-fixture'));
    const prefix = baseline ? 'before' : 'after';
    for (const theme of ['light']) {
      await context.addInitScript(theme=>localStorage.setItem('little_gate_theme',theme),theme);
      for (const [width,height,name] of [[1920,1080,'desktop'],[390,844,'mobile']]) {
        await page.setViewportSize({width,height});
        await page.goto(base+'/upstreams?provider_id=7');
        await page.getByRole('dialog').waitFor();
        await page.waitForTimeout(600);
        await fitsViewport();
        await capture(`${prefix}-${name}-${theme}`);
        if (!baseline) {
          assert.equal(await page.getByRole('tab').count(),3);
          assert.equal(await page.getByRole('tab',{name:'连接',exact:true}).getAttribute('aria-selected'),'true');
          if (name==='desktop') {
            const box=await page.getByRole('link',{name:'管理模型 →'}).boundingBox();
            assert(box && box.y+box.height<height,'模型入口应在首屏');
          }
          for(const [tab,label] of [['advanced','高级设置'],['runtime','状态 / 调试']]) {
            await page.getByRole('tab',{name:label,exact:true}).click();
            if (tab==='runtime') await page.getByText('最近错误',{exact:true}).waitFor();
            await page.waitForTimeout(350);
            assert(new URL(page.url()).searchParams.get('tab')===tab);
            await capture(`${prefix}-${tab}-${name}-${theme}`);
          }
        }
      }
    }
    if (!baseline) {
      await page.setViewportSize({width:1920,height:1080});
      await page.goto(base+'/upstreams');

      await page.getByRole('button',{name:'管理',exact:true}).click();
      await page.getByLabel(/^名称/).fill('未保存的名称');
      const detailCount=requests.filter(p=>p==='GET /api/v1/upstreams/7').length;
      await page.getByRole('tab',{name:'状态 / 调试'}).click();
      await page.getByRole('button',{name:'刷新状态'}).click();
      await page.getByRole('tab',{name:'连接',exact:true}).click();
      assert.equal(await page.getByLabel(/^名称/).inputValue(),'未保存的名称');
      await page.getByRole('button',{name:'保存基础信息'}).click();
      await page.getByText('保存失败（验收模拟）',{exact:false}).waitFor();
      assert.equal(await page.getByLabel(/^名称/).inputValue(),'未保存的名称');
      assert.equal(requests.filter(p=>p==='GET /api/v1/upstreams/7').length,detailCount);
      await page.getByRole('button',{name:'关闭',exact:true}).click();
      await page.getByText('放弃未保存的修改？',{exact:true}).waitFor();
      await page.getByRole('button',{name:'取消',exact:true}).last().click();
      assert.equal(await page.getByLabel(/^名称/).inputValue(),'未保存的名称');
      // Return through tab history, then back out of the drawer: draft must block navigation.
      await page.goBack(); await page.goBack(); await page.goBack();
      await page.getByText('放弃未保存的修改？',{exact:true}).waitFor();
      await page.getByRole('button',{name:'取消',exact:true}).last().click();
      await page.getByRole('tab',{name:'连接',exact:true}).click();
      await page.getByRole('button',{name:'取消',exact:true}).first().click();
      assert.equal(await page.getByLabel(/^名称/).inputValue(),provider.name);
      await page.getByRole('button',{name:'测试',exact:true}).first().click();
      await page.getByText('地址可达（未验证 Key）',{exact:true}).waitFor();
      await page.getByRole('button',{name:'下移',exact:true}).first().click();
      await page.waitForFunction(() => document.querySelectorAll('[draggable]')[0]?.textContent.includes('api-backup.example.com'));
      await page.getByRole('button',{name:'编辑',exact:true}).first().click();
      await page.getByRole('button',{name:'取消',exact:true}).last().click();
      await page.getByRole('button',{name:'编辑',exact:true}).nth(2).click();
      await page.getByRole('button',{name:'取消',exact:true}).last().click();
      await page.getByRole('button',{name:'更多操作'}).click();
      await page.getByRole('menuitem',{name:'删除整个上游'}).click();
      await page.getByRole('button',{name:'取消',exact:true}).last().click();
      await page.getByRole('tab',{name:'状态 / 调试'}).click();
      await page.getByRole('button',{name:'关闭',exact:true}).click();
      await page.getByRole('dialog').waitFor({state:'hidden'});
      const runtimeCount=requests.filter(p=>p.endsWith('/runtime')).length;
      await page.waitForTimeout(10500);
      assert.equal(requests.filter(p=>p.endsWith('/runtime')).length,runtimeCount);
      assert(!requests.some(p=>/upstreams\/7\/(keys|endpoints)$/.test(p)));
      checks.push('address_reorder','address_test_is_not_authentication','address_and_key_edit_cancel','three_tabs','URL_history','draft_survives_runtime_refresh','failed_save_keeps_draft','close_and_back_guard','cancel_edit','delete_cancel','overview_no_N_plus_one','closed_runtime_stops');
    }
    assert.deepEqual(errors,[]);
    await fs.writeFile(`${artifacts}/${prefix}-acceptance.json`,JSON.stringify({screenshots,errors,checks,requests},null,2));
    console.log(JSON.stringify({screenshots,errors,checks}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
