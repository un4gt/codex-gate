const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base=process.env.PRICE_SYNC_UI_URL || 'http://127.0.0.1:4174';
const artifacts=process.env.PRICE_SYNC_UI_ARTIFACTS || '/tmp/price-sync-ui';
const provider={id:7,name:'Provider A',provider_type:'openai_compatible',enabled:true,priority:100,weight:1,supports_include_usage:true,websocket_enabled:false,beta_features:[],request_overrides:{headers:[],body:[]},key_selection_strategy:'round_robin',groups:[],max_attempts:2,max_concurrency:null,circuit_breaker_enabled:true,circuit_breaker_failure_threshold:3,circuit_breaker_open_ms:30000,circuit_breaker_half_open_success_threshold:2,routing_availability:{available:true,reason:'available'}};
const card={schema_version:2,unit:'usd_per_million_tokens',base:{input:'1.25',output:'10',cache_read:'0.125',cache_write:null},tiers:[]};
const display={display_name:'Friendly Gemini',brand:'google',aliases:['google-alias'],quote_provider:'google',adaptation:'partial',present:true};
const models=Array.from({length:45},(_,i)=>({id:i+1,provider_id:7,provider_name:provider.name,provider_type:provider.provider_type,upstream_model:i===0?'gemini-2.5-pro':`model-${i}`,alias:null,enabled:true,available:true,responses_via_chat_enabled:false,native_api_formats:['chat_completions'],created_at_ms:1,updated_at_ms:1,display:i===0?display:null}));
const prices=models.map((m,i)=>({id:i+1,provider_id:null,model_name:m.upstream_model,price_data:card,source:i===0?'manual':'cloud',display:m.display,created_at_ms:1900000000000,updated_at_ms:1900000000000}));
let stage='preview',applied=null;
const job=()=>({id:'preview-test',status:stage,source_version:'test-v1',error:null,counts:{added:20,updated:1,unchanged:5,manual_preserved:1,failed:0},conflicts:stage==='applied'?[]:[{model_name:'gemini-2.5-pro',local_id:1,local_price:card,cloud_price:{...card,base:{...card.base,input:'2.5'}}}]});
(async()=>{await fs.mkdir(artifacts,{recursive:true});const browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--hide-scrollbars'],args:['--no-sandbox']});const errors=[];
try {
 const context=await browser.newContext({viewport:{width:1280,height:800},permissions:['clipboard-read','clipboard-write']});
 await context.addInitScript(({base})=>{localStorage.setItem('little_gate_api_base',base);localStorage.setItem('little_gate_locale','zh');sessionStorage.setItem('little_gate_admin_token','browser-fixture');},{base});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let body=[];
 if(path==='/api/v1/system/config')body={build:{version:'test'}};
 else if(path==='/api/v1/providers')body=[provider];
 else if(path==='/api/v1/provider-models')body=models;
 else if(path==='/api/v1/prices')body=prices;
 else if(path==='/api/v1/console-preferences')body={model_column_widths:{},log_column_widths:{},log_visible_columns:['time']};
 else if(path==='/api/v1/price-sync')body={config:{enabled:true,source_url:'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',interval_minutes:30},running:false,last_success_ms:1900000000000,next_run_ms:1900001800000};
 else if(path==='/api/v1/price-sync/preview')body={id:'preview-test'};
 else if(path==='/api/v1/price-sync/jobs/preview-test')body=job();
 else if(path==='/api/v1/price-sync/apply/preview-test'){applied=route.request().postDataJSON();stage='applied';body=job();}
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(base+'/models?page_size=50');await page.getByText('Friendly Gemini',{exact:true}).waitFor();
 await page.getByRole('button',{name:'复制模型 ID gemini-2.5-pro',exact:true}).click();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'gemini-2.5-pro');
 const search=page.getByRole('textbox',{name:'搜索模型、别名、上游'});
 // Search label may vary with the existing locale; use the inventory's only text input.
 const input=(await search.count())?search:page.locator('input').first();await input.fill('Friendly Gemini');
 await page.waitForFunction(()=>document.querySelectorAll('tbody > tr').length===1);await input.fill('');
 await page.waitForFunction(()=>document.querySelectorAll('tbody > tr').length>10);
 const table=page.getByTestId('model-inventory-table-container');const bar=table.locator('..').locator('[data-table-scrollbar]');
 await table.evaluate(el=>el.scrollTop=250);await page.waitForTimeout(150);assert(await bar.isVisible());
 const before=await table.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft}));
 const dragBox=await bar.boundingBox();const dragRange=await bar.evaluate(el=>({width:el.clientWidth,total:el.scrollWidth}));
 const thumbWidth=dragBox.width*dragRange.width/dragRange.total;
 await page.mouse.move(dragBox.x+thumbWidth/2,dragBox.y+8);await page.mouse.down();await page.mouse.move(dragBox.x+thumbWidth/2+80,dragBox.y+8,{steps:12});await page.mouse.up();await page.waitForTimeout(150);
 assert((await table.evaluate(el=>el.scrollLeft))>0,'native scrollbar thumb drag must move the table');

 await bar.evaluate(el=>{el.scrollLeft=300;el.dispatchEvent(new Event('scroll'));});
 await page.waitForFunction(()=>document.querySelector('[data-testid="model-inventory-table-container"]').scrollLeft>250);
 assert.equal(await table.evaluate(el=>el.scrollTop),before.top);
 const keyBefore=await table.evaluate(el=>el.scrollLeft);await bar.focus();await page.keyboard.press('ArrowLeft');await page.waitForTimeout(200);assert((await table.evaluate(el=>el.scrollLeft))<keyBefore,JSON.stringify({message:'keyboard scrolling must work',keyBefore,table:await table.evaluate(el=>({left:el.scrollLeft,width:el.clientWidth,total:el.scrollWidth})),bar:await bar.evaluate(el=>({left:el.scrollLeft,width:el.clientWidth,total:el.scrollWidth,focused:document.activeElement===el}))}));
 await table.evaluate(el=>{el.scrollLeft=100;el.dispatchEvent(new Event('scroll'));});await page.waitForTimeout(100);assert.equal(await bar.evaluate(el=>el.scrollLeft),100);
 const b=await bar.boundingBox(),r=await table.boundingBox();assert(b.y+b.height<=Math.min(800,r.y+r.height)+1);
 await table.evaluate(el=>{el.style.width='420px'});await page.waitForTimeout(150);assert(Math.abs((await bar.boundingBox()).width-420)<2);
 await table.evaluate(el=>{el.style.width='';el.scrollTop=0;el.scrollLeft=0});await page.waitForTimeout(150);
 await page.screenshot({path:`${artifacts}/inventory.png`,fullPage:false});
 await page.goto(base+'/models/prices?page_size=50');await page.getByRole('button',{name:'立即同步 · 先预览'}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('checkbox',{name:'改用云端价 gemini-2.5-pro'}).waitFor();
 assert.equal(await dialog.getByRole('checkbox',{name:'改用云端价 gemini-2.5-pro'}).isChecked(),false);
 await dialog.getByRole('checkbox',{name:'改用云端价 gemini-2.5-pro'}).check();
 // Nested pricing tables each keep independent offsets and are clipped by the dialog.
 const bars=dialog.locator('[data-table-scrollbar]');let visible=0;
 for(let i=0;i<await bars.count();i++){const x=bars.nth(i);if(await x.isVisible()){visible++;const bx=await x.boundingBox(),dr=await dialog.boundingBox();assert(bx.y+bx.height<=dr.y+dr.height);}}
 assert(visible>=2);
 const visibleBars=[];for(let i=0;i<await bars.count();i++)if(await bars.nth(i).isVisible())visibleBars.push(bars.nth(i));
 const otherBefore=await visibleBars[1].evaluate(el=>el.parentElement.querySelector('.MuiTableContainer-root').scrollLeft);
 await visibleBars[0].evaluate(el=>{el.scrollLeft=60;el.dispatchEvent(new Event('scroll'))});await page.waitForTimeout(100);
 assert.equal(await visibleBars[1].evaluate(el=>el.parentElement.querySelector('.MuiTableContainer-root').scrollLeft),otherBefore,'each nested table keeps its own scroll position');
 await page.screenshot({path:`${artifacts}/preview.png`,fullPage:false});
 await dialog.getByRole('button',{name:'应用预览'}).click();await dialog.waitFor({state:'hidden'});
 assert.deepEqual(applied,{source_version:'test-v1',use_cloud:['gemini-2.5-pro']});
 // Long page table: scrollbar follows visible bottom while scrolling through the middle.
 const priceTable=page.getByRole('table',{name:'当前可用价格项'});const priceContainer=priceTable.locator('..');
 await priceTable.locator('tbody tr').nth(8).scrollIntoViewIfNeeded();await page.waitForTimeout(150);
 const priceBar=priceContainer.locator('..').locator('[data-table-scrollbar]').first();assert(await priceBar.isVisible());
 await priceBar.evaluate(el=>{el.scrollLeft=200;el.dispatchEvent(new Event('scroll'))});await page.waitForTimeout(100);assert((await priceContainer.evaluate(el=>el.scrollLeft))>0);
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);assert(await priceBar.isVisible());
 await page.screenshot({path:`${artifacts}/mobile.png`,fullPage:false});
 // No overflow, hidden table, and multiple table isolation.
 await priceTable.evaluate(el=>{el.style.minWidth='0';el.style.width='100%';for(const c of el.querySelectorAll('th,td')){c.style.width='0';c.style.maxWidth='0';c.style.padding='0';c.style.overflow='hidden'}});await page.waitForTimeout(200);
 assert.equal(await priceContainer.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);assert(!(await priceBar.isVisible()),'no-overflow scrollbar must be hidden');
 await priceContainer.evaluate(el=>el.style.display='none');await page.waitForTimeout(200);assert(!(await priceBar.isVisible()));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['friendly search','actual ID copy','native scrollbar mouse drag','keyboard horizontal scroll','bidirectional horizontal scroll','vertical position preserved','resize','viewport clipping','manual default and explicit selection','preview version binding','nested dialog bars','independent table positions','no overflow hidden','long page scrolling','mobile','hidden table','console errors'],screenshots:[`${artifacts}/inventory.png`,`${artifacts}/preview.png`,`${artifacts}/mobile.png`]}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
