import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Qualification-only dependency, supplied by the host, never by the distributed runtime.
const { chromium } = await import(process.env.TOUBA_PLAYWRIGHT_MODULE || 'playwright');
import { executeAirDocument } from '../runtime/touba-runtime/src/index.mjs';
import { createSqliteTraceStore } from '../runtime/touba-runtime/src/sqlite-trace-store.mjs';
import { startTraceExplorer } from '../cli/touba-inspect/src/trace-explorer/server.mjs';
import { startExplorer } from '../cli/touba-inspect/src/explorer/server.mjs';
const root=await realpath(await mkdtemp(join(tmpdir(),'touba-trace-browser-'))), fixture=join(root,'project');
const reportRoot=process.env.TOUBA_TRACE_REPORT_DIR || join(root,'reports');
await mkdir(fixture,{recursive:true});await mkdir(reportRoot,{recursive:true});
const air=JSON.parse(await readFile(new URL('../tests/air/tb-v01-001-linear-skill.air.json',import.meta.url)));
await writeFile(join(fixture,'air.json'),JSON.stringify(air));
await cp(new URL('../grammar/tree-sitter-touba/examples/tb-v01-001-linear-skill.tb',import.meta.url),join(fixture,'tb-v01-001-linear-skill.tb'));
const filename=join(fixture,'traces.sqlite'),store=createSqliteTraceStore({filename});
await executeAirDocument(air,{traceStorage:store,runId:`ui:${Date.now()}`,entryRef:'strategy:examples.linear_skill/RunSourcedNote',inputs:{request:{topic:'PRIVATE_SENTINEL'}},agentDecisions:{'agent:examples.linear_skill/Researcher':{target_ref:'skill:examples.linear_skill/BuildNote',arguments:{request:{topic:'PRIVATE_SENTINEL'}}}},toolHandlers:{'tool:examples.linear_skill/FetchSource':async()=>({content:'PRIVATE_SENTINEL'})}});store.close();
const server=await startTraceExplorer({filename,root:fixture,air:join(fixture,'air.json'),openBrowser:false});
const browser=await chromium.launch({headless:true,...(process.env.TOUBA_BROWSER_CHANNEL?{channel:process.env.TOUBA_BROWSER_CHANNEL}:{})}), results=[];
try {
  for(const language of ['fr','en']) for(const theme of ['light','dark']) {
    const context=await browser.newContext({locale:language,colorScheme:theme,acceptDownloads:true}),page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(request.url()));
    await page.goto(server.url);await page.locator('.event').first().waitFor();
    for(const width of [375,768,1440,1920,2560]) {
      await page.setViewportSize({width,height:1000});
      for(const view of ['timeline','graph','table']) {
        await page.locator(`[data-view="${view}"]`).click();await page.waitForFunction(()=>document.getElementById('events').getAttribute('aria-busy')==='false');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${language}/${theme}/${width}/${view} overflow`);
        if(width===375) {
          await page.locator(view==='timeline'?'.event':view==='graph'?'.graph-node':'.trace-table tbody button').first().click();
          await page.locator('#detail .props').first().waitFor();
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile details overflow');
        }
        if(width===1440||width===375) await page.screenshot({path:join(reportRoot,`${language}-${theme}-${view}${width===375?'-mobile':''}.png`),fullPage:true});
      }
      results.push({language,theme,width,views:3});
    }
    await page.locator('[data-view="timeline"]').click();await page.locator('.event').first().waitFor();
    await page.locator('#search').fill('call_completed');await page.locator('#search').press('Enter');
    await page.waitForFunction(()=>document.getElementById('events').getAttribute('aria-busy')==='false');
    const count=await page.locator('.event').count();assert.ok(count>0);assert.ok(count<50);
    await page.locator('.event').first().click();await page.locator('#detail .props').first().waitFor();
    await page.locator('#detail .detail-actions button').last().click();await page.locator('#source-dialog').waitFor({state:'visible'});
    assert.match(await page.locator('#source-content').textContent(),/module examples.linear_skill/);await page.locator('#close-source').click();
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(server.url).origin});
    await page.locator('#detail .prop').first().hover();await page.locator('#detail .prop .copy').first().click();
    assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/^\d{4}-\d{2}-\d{2}T/);
    const position=await page.locator('#detail .event-nav span').textContent();await page.locator('#detail .event-nav button').last().click();
    await page.waitForFunction(previous=>document.querySelector('#detail .event-nav span')?.textContent!==previous,position);
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);const file=join(reportRoot,`${language}-${theme}-selection.json`);await download.saveAs(file);
    const report=JSON.parse(await readFile(file));assert.equal(report.coverage.selected,count);assert.equal(JSON.stringify(report).includes('PRIVATE_SENTINEL'),false);
    await page.locator('#reset').click();await page.waitForFunction(()=>document.getElementById('events').getAttribute('aria-busy')==='false');
    await page.locator('#events').focus();await page.keyboard.press('ArrowDown');await page.locator('#detail .detail-head').waitFor();
    await page.locator('#category').selectOption('refusal');await page.locator('#events .empty').waitFor();
    await page.locator('#reset').click();await page.locator('.event').first().waitFor();
    await page.locator('#advanced-toggle').click();await page.locator('#advanced input[name=kind]').fill('call_started');await page.locator('#advanced button[type=submit]').click();
    await page.waitForFunction(()=>document.getElementById('events').getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('#advanced').isHidden(),true);assert.equal(await page.locator('#filter-count').textContent(),'1');
    assert.ok(await page.locator('.event').count()>0);assert.equal(await page.locator('.event').count(),await page.locator('.event strong').filter({hasText:language==='fr'?'Appel lancé':'call started'}).count());
    await page.locator('#level [data-value=governance]').click();await page.waitForFunction(()=>document.getElementById('events').getAttribute('aria-busy')==='false');
    await page.locator('#events').focus();await page.keyboard.press(']');assert.equal(await page.locator('#layout').getAttribute('data-detail'),'closed');
    await page.keyboard.press('[');assert.equal(await page.locator('#layout').getAttribute('data-runs'),'closed');
    await page.locator('#focus-mode').click();assert.equal(await page.locator('#layout').getAttribute('data-runs'),'open');assert.equal(await page.locator('#layout').getAttribute('data-detail'),'open');
    await page.locator('#reset').click();await page.locator('.event').first().waitFor();
    await page.locator('#run-filter').fill('run:not-present');await page.locator('#find-run').click();
    await page.waitForFunction(()=>document.getElementById('events').getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('.event').count(),0);assert.equal(await page.locator('#stats .stat').count(),0);
    assert.equal(await page.locator('#export').isDisabled(),true);
    await page.locator('#run-filter').fill('');await page.locator('#find-run').click();await page.locator('.event').first().waitFor();
    // Essential reading hides sequences, run identifiers and digests, and keeps them in the folded technical details.
    await page.locator('#display-toggle').click();await page.locator('[data-pref="level"] [data-value="essential"]').click();await page.keyboard.press('Escape');
    assert.equal(await page.locator('html').getAttribute('data-level'),'essential');
    assert.equal(await page.locator('#coverage').isVisible(),false);assert.equal(await page.locator('.event .sequence').first().isVisible(),false);
    await page.locator('.event').nth(3).click();await page.locator('#detail .detail-head').waitFor();
    assert.equal(await page.locator('#detail .detail-section .identifier').count(),0);
    await page.locator('#detail .technical summary').click();assert.ok(await page.locator('#detail .technical .identifier').count()>0);
    await page.reload();await page.locator('.event').first().waitFor();assert.equal(await page.locator('html').getAttribute('data-level'),'essential');
    await page.locator('#display-toggle').click();await page.locator('[data-pref="level"] [data-value="complete"]').click();await page.keyboard.press('Escape');
    await page.reload();await page.locator('.event').first().waitFor();
    assert.deepEqual(errors,[]);assert.ok(requests.every(url=>url.startsWith(new URL(server.url).origin)));
    await context.close();
  }
  // Both explorers must render the same colors and type: compare what the browser actually computes.
  const projectRoot=join(root,'explore');await cp(new URL('../examples/explorer-project',import.meta.url),projectRoot,{recursive:true});
  const explorer=await startExplorer({root:projectRoot,openBrowser:false});await explorer.ready;
  try {
    const shared=['body','.brand-text strong','.views button[aria-pressed=true]','.views button[aria-pressed=false]','#status','.header-actions .badge','#language','.panel-head h2','.panel','#reset','#display-toggle','#detail h2','#detail .category-badge','#detail .detail-actions button','#detail .detail-section h3','#detail .prop dt','#detail .prop dd'];
    const properties=['font-family','font-size','font-weight','letter-spacing','text-transform','color','background-color','border-top-color','border-radius'];
    for(const theme of ['light','dark']) {
      const context=await browser.newContext({locale:'fr',colorScheme:theme,viewport:{width:1920,height:1000}}),project=await context.newPage(),traces=await context.newPage();
      await project.goto(explorer.url);await project.locator('[data-view="flow"]').click();await project.locator('#resource-list button').filter({hasText:/^Specialist$/}).click();await project.locator('#detail .prop').first().waitFor();
      await traces.goto(server.url);await traces.locator('.event[data-category=agent]').first().click();await traces.locator('#detail .prop').first().waitFor();
      for(const selector of shared) {
        const read=target=>target.locator(selector).first().evaluate((node,names)=>Object.fromEntries(names.map(name=>[name,getComputedStyle(node).getPropertyValue(name)])),properties);
        assert.deepEqual(await read(traces),await read(project),`${theme} ${selector}`);
      }
      await context.close();
    }
  } finally { await explorer.close(); }
  await writeFile(join(reportRoot,'browser-results.json'),JSON.stringify({results,checks:['three views','no overflow','filters','advanced filters','reading level','details','copy','event navigation','matching AIR source','export','keyboard','panels','essential reading','same colors and type as the project explorer','empty state','no external requests','no console errors']},null,2));
  console.log(JSON.stringify({layouts:results.length,views:results.length*3,status:'passed'}));
} finally {await browser.close();await server.close();await rm(root,{recursive:true,force:true});}
