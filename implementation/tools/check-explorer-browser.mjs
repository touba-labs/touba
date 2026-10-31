import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startExplorer } from '../cli/touba-inspect/src/explorer/server.mjs';
import { implementationRoot } from '../cli/touba-inspect/src/explorer/project.mjs';

// The qualification host supplies Playwright; it is not a distributed runtime dependency.
const { chromium } = await import(process.env.TOUBA_PLAYWRIGHT_MODULE || 'playwright');

async function checkDisplayControls(page) {
  await page.locator('#hide-resources').click(); assert.equal(await page.locator('#resources-panel').isVisible(),false);
  await page.locator('#show-resources').click(); assert.equal(await page.locator('#resources-panel').isVisible(),true);
  await page.locator('#hide-detail').click(); assert.equal(await page.locator('#detail-panel').isVisible(),false);
  await page.locator('#show-detail').click(); assert.equal(await page.locator('#detail-panel').isVisible(),true);
  await page.locator('#theme').focus();
  await page.keyboard.press('['); assert.equal(await page.locator('#resources-panel').isVisible(),false);
  await page.keyboard.press('['); assert.equal(await page.locator('#resources-panel').isVisible(),true);
  await page.keyboard.press(']'); assert.equal(await page.locator('#detail-panel').isVisible(),false);
  await page.keyboard.press(']'); assert.equal(await page.locator('#detail-panel').isVisible(),true);
  await page.keyboard.press('\\'); assert.equal(await page.locator('#focus-mode').getAttribute('aria-pressed'),'true');
  await page.keyboard.press('\\'); assert.equal(await page.locator('#focus-mode').getAttribute('aria-pressed'),'false');
  await page.locator('#search').focus(); await page.keyboard.press('[');
  assert.equal(await page.locator('#search').inputValue(),'['); assert.equal(await page.locator('#resources-panel').isVisible(),true);
  await page.locator('#search').fill('');

  await page.locator('[data-view="governance"]').click();
  await page.locator('#display-toggle').click();
  await page.locator('[data-pref="labels"] [data-value="none"]').click();
  assert.equal(await page.locator('#graph').getAttribute('data-labels'),'none');
  assert.ok(await page.locator('.edge-label').count());
  assert.ok(await page.locator('.edge-label').evaluateAll(nodes=>nodes.every(n=>getComputedStyle(n).opacity==='0')));
  await page.locator('[data-pref="labels"] [data-value="auto"]').click();
  await page.locator('[data-pref="orientation"] [data-value="horizontal"]').click();
  await page.locator('[data-pref="density"] [data-value="compact"]').click();
  assert.equal(await page.locator('.node .card').first().getAttribute('width'),'196');
  await page.locator('[data-pref="panels"] [data-value="detail"]').click();
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#display-panel').isVisible(),false);
  assert.equal(await page.locator('#display-toggle').evaluate(n=>n===document.activeElement),true);
  await page.locator('#filters summary').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('touba-explorer-preferences')).filters===false);
  await page.reload(); await page.locator('#status[data-status="ready"]').waitFor();
  assert.equal(await page.locator('#graph').getAttribute('data-labels'),'auto');
  assert.equal(await page.locator('#graph').getAttribute('data-density'),'compact');
  assert.equal(await page.locator('#detail-panel').isVisible(),false);
  assert.equal(await page.locator('#filters').evaluate(n=>n.open),false);
  await page.locator('#filters summary').click();
  await page.locator('#show-detail').click();
  await page.locator('#display-toggle').click();
  assert.equal(await page.locator('[data-pref="orientation"] [data-value="horizontal"]').getAttribute('aria-pressed'),'true');
  for (const [pref,value] of [['labels','all'],['orientation','vertical'],['density','comfortable']]) await page.locator(`[data-pref="${pref}"] [data-value="${value}"]`).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-view="architecture"]').click();
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'touba-explorer-browser-')));
let browser, server;
try {
  await cp(join(implementationRoot,'examples/explorer-project'),root,{recursive:true});
  const reviewFile = join(root,'src/review.tb');
  const reviewSource = await readFile(reviewFile,'utf8');
  await writeFile(reviewFile,reviewSource.replace('module review\n',`module review

limits run
    max_tool_calls as 20
    max_agent_invocations as 1
    max_provider_calls as 3
    max_run_ms as 30000
    max_steps as 100
`)+ '\ntype Diagnosis\n    summary is Text default "ready"\n    severity is Int min 0 max 10 default 0\n    urgent is Boolean default false\n');
  server=await startExplorer({root,openBrowser:false,interval:200}); await server.ready;
  browser=await chromium.launch({headless:true,...(process.env.TOUBA_BROWSER_CHANNEL ? {channel:process.env.TOUBA_BROWSER_CHANNEL} : {})});
  let count=0;
  for (const width of [320,390,1440,1920]) for (const theme of ['light','dark']) for (const language of ['fr','en']) {
    const context=await browser.newContext({viewport:{width,height:width===320 ? 640 : 950},locale:language,colorScheme:theme,reducedMotion:'reduce',acceptDownloads:true});
    const page=await context.newPage(), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.goto(server.url); await page.locator('#status[data-status="ready"]').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'),language);
    await page.locator('#theme').click(); assert.equal(await page.locator('html').getAttribute('data-theme'),theme==='light'?'dark':'light'); await page.locator('#theme').click();
    await page.locator('#language').selectOption(language==='fr'?'en':'fr'); await page.locator('#language').selectOption(language);
    await checkDisplayControls(page);
    assert.equal(await page.locator('.node').count(),1);
    assert.equal(await page.locator('.node .kind').textContent(),`Module · 5 ${language==='fr'?'ressources':'resources'}`);
    await page.locator('#resource-list button').filter({hasText:/^review$/}).click();
    const budgetSection = page.locator('#detail .detail-section').filter({has:page.locator('h3').filter({hasText:language==='fr'?'Budgets du run':'Run budgets'})});
    const facts = await budgetSection.locator('dt').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.textContent,n.nextElementSibling.textContent])));
    assert.deepEqual(facts,language==='fr'
      ? {'Invocations d’agents maximum':'1','Appels fournisseur maximum':'3','Durée maximale du run':'30 s','Étapes maximum':'100','Appels d’outils maximum':'20'}
      : {'Maximum agent invocations':'1','Maximum provider calls':'3','Maximum run duration':'30 s','Maximum steps':'100','Maximum tool calls':'20'});
    assert.doesNotMatch(await budgetSection.innerText(),/source_ref|start_byte|NaN|\{"/);
    await page.locator('#detail button').filter({hasText:language==='fr'?'Ouvrir la source':'Open source'}).click();
    await page.locator('#source-dialog[open]').waitFor();
    assert.match(await page.locator('#source-code').innerText(),/max_tool_calls as 20/);
    await page.locator('#close-source').click();
    // Keeping Group checked while selecting a module used to give every card a spurious 1.
    await page.locator('#module').selectOption('module:review');
    assert.equal(await page.locator('.node').count(),5);
    assert.equal(await page.locator('.node[data-id="module:review"] .kind').textContent(),'Module');
    assert.equal(await page.locator('.node[data-id="type:review/Diagnosis"] .kind').textContent(),'Type');
    await page.locator('#resource-list button').filter({hasText:/^Diagnosis$/}).click();
    const fieldDetails = await page.locator('#detail').innerText();
    assert.match(fieldDetails,/ready/);
    assert.match(fieldDetails,/severity/);
    assert.match(fieldDetails,/10/);
    assert.match(fieldDetails,/\b0\b/);
    assert.match(fieldDetails,/false/);
    assert.doesNotMatch(fieldDetails,/source_ref|start_byte|\[object Object\]/);
    await page.locator('#group').uncheck(); assert.equal(await page.locator('.node').count(),5);
    await page.locator('#module').selectOption('');
    await page.locator('#search').fill('Specialist'); assert.equal(await page.locator('#resource-list button').count(),1);
    await page.locator('#resource-list button').focus(); await page.keyboard.press('Enter');
    assert.match(await page.locator('#detail').innerText(),/Diagnose the supplied incident/);
    assert.equal(await page.locator('#resource-list button').evaluate(node=>document.activeElement===node),true);
    await page.locator('#detail button').filter({hasText:language==='fr'?'Ouvrir la source':'Open source'}).click();
    await page.locator('#source-dialog[open]').waitFor(); assert.match(await page.locator('#source-code').innerText(),/agent Specialist/); await page.locator('#close-source').click();
    // Essential reading folds the signature and the file path into the technical details.
    await page.locator('#display-toggle').click(); await page.locator('[data-pref="level"] [data-value="essential"]').click(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('html').getAttribute('data-level'),'essential');
    assert.doesNotMatch((await page.locator('#detail > .detail-section > h3').allTextContents()).join('\n'),/^(Origine|Origin|Signature)$/mu);
    await page.locator('#detail .technical summary').click(); assert.match(await page.locator('#detail .technical').innerText(),/src\/review\.tb:\d+/);
    await page.locator('#display-toggle').click(); await page.locator('[data-pref="level"] [data-value="complete"]').click(); await page.keyboard.press('Escape');
    assert.match(await page.locator('#detail > .detail-section').allInnerTexts().then(texts=>texts.join('\n')),/src\/review\.tb:\d+/);
    await page.locator('#diagnostic-only').check(); assert.equal(await page.locator('.node').count(),0);
    await page.locator('#reset').click(); assert.equal(await page.locator('#diagnostic-only').isChecked(),false);
    await page.locator('[data-view="governance"]').click();
    await page.locator('#resource-list button').filter({hasText:/^Review$/}).click();
    await page.locator('#detail li button').filter({hasText:/^(Approbation humaine|Human approval)$/}).first().click();
    assert.equal(await page.locator('[data-view="flow"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.node.selected').count(),1);
    await page.locator('[data-view="governance"]').click();
    assert.ok(await page.locator('.node[data-id="secret_handle:INCIDENT_API_KEY"]').count());
    await page.locator('#resource-list button').filter({hasText:/^Specialist$/}).click();
    await page.locator('#depth').selectOption('1'); await page.locator('#direction').selectOption('outgoing'); assert.equal(await page.locator('.node').count(),2);
    await page.locator('#depth').selectOption('2'); assert.equal(await page.locator('.node').count(),5); await page.locator('#direction').selectOption('all');
    await page.locator('#kind').selectOption('agent'); assert.equal(await page.locator('.node').count(),1);
    await page.locator('#kind').selectOption(''); await page.locator('[data-view="flow"]').click();
    assert.ok(await page.locator('.node[aria-label*="parallel"],.node[aria-label*="parallèle"]').count());
    const initial=await page.locator('#graph').getAttribute('viewBox'); await page.locator('#zoom-in').click(); assert.notEqual(await page.locator('#graph').getAttribute('viewBox'),initial);
    await page.locator('#zoom-out').click();
    await page.locator('#fit').click();
    await page.locator('#graph').scrollIntoViewIfNeeded();
    const beforePan=await page.locator('#graph').getAttribute('viewBox'),rect=await page.locator('#graph').boundingBox();
    await page.mouse.move(rect.x+5,rect.y+5); await page.mouse.down(); await page.mouse.move(rect.x+55,rect.y+15); await page.mouse.up();
    assert.notEqual(await page.locator('#graph').getAttribute('viewBox'),beforePan); await page.locator('#fit').click();
    await page.locator('#fullscreen').click(); await page.waitForFunction(()=>Boolean(document.fullscreenElement));
    await page.locator('#fullscreen').click(); await page.waitForFunction(()=>!document.fullscreenElement);
    const pending=page.waitForEvent('download'); await page.locator('#export').click(); const download=await pending; assert.equal(download.suggestedFilename(),'touba-project.svg');
    const exported=await readFile(await download.path(),'utf8'); assert.match(exported,/<svg/); assert.match(exported,/parallel_call/); assert.ok(!exported.includes('<script'));
    const pendingPng=page.waitForEvent('download'); await page.locator('#export-png').click(); const image=await pendingPng; assert.equal(image.suggestedFilename(),'touba-project.png');
    const png=await readFile(await image.path());
    assert.deepEqual([...png.subarray(0,8)],[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    assert.ok(png.readUInt32BE(16)>0 && png.readUInt32BE(16)<=8000 && png.readUInt32BE(20)>0 && png.readUInt32BE(20)<=8000);
    const dimensions=await page.evaluate(async base64=>{
      const url=URL.createObjectURL(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'image/png'}));
      try {const image=new Image();image.src=url;await image.decode();return [image.naturalWidth,image.naturalHeight];}
      finally {URL.revokeObjectURL(url);}
    },png.toString('base64'));
    assert.deepEqual(dimensions,[png.readUInt32BE(16),png.readUInt32BE(20)]);
    await page.locator('#reset').click(); assert.equal(await page.locator('.node.selected').count(),0);
    await page.locator('[data-view="governance"]').click();
    await page.locator('#resource-list button').filter({hasText:/^Specialist$/}).click(); assert.equal(await page.locator('.node.selected').count(),1);
    await page.locator('.node.selected').click(); assert.equal(await page.locator('.node.selected').count(),0); assert.equal(await page.locator('.node.muted').count(),0);
    await page.locator('#resource-list button').filter({hasText:/^Specialist$/}).click(); await page.locator('#reset').click(); assert.equal(await page.locator('.node.selected').count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.reload(); await page.locator('#status[data-status="ready"]').waitFor();
    await page.locator('[data-view="governance"]').click();
    await page.locator('#resource-list button').filter({hasText:'Specialist'}).click();
    const selected=await page.locator('#detail h2').innerText(), viewport=await page.locator('#graph').getAttribute('viewBox');
    const file=join(root,'src/review.tb'), original=await readFile(file,'utf8');
    await writeFile(file,'invalid Touba source'); await page.locator('#status[data-status="stale"]').waitFor();
    assert.equal(await page.locator('#detail h2').innerText(),selected); assert.ok(await page.locator('.node').count()>0);
    await writeFile(file,original+'\n'); await page.locator('#status[data-status="ready"]').waitFor();
    assert.equal(await page.locator('#detail h2').innerText(),selected); assert.equal(await page.locator('#graph').getAttribute('viewBox'),viewport);
    assert.deepEqual(errors,[]);
    await context.close(); count++; console.log(`PASS explorer ${width}px ${theme} ${language}`);
  }
  console.log(`Explorer browser qualification: ${count}/16 configurations passed.`);
  const started=performance.now();
  await writeFile(join(root,'src/catalog.tb'), 'module catalog\n'+Array.from({length:300},(_,i)=>`function Entry${i}\n    takes value as Text\n    gives Text\n    do\n        give value\n`).join('\n'));
  const context=await browser.newContext({viewport:{width:1440,height:950}}), page=await context.newPage();
  await page.goto(server.url);
  await page.waitForFunction(()=>document.querySelector('#module').options.length===3 && document.querySelector('#status').dataset.status==='ready');
  await page.locator('#group').uncheck();
  assert.ok(await page.locator('#resource-list button').count()>300);
  assert.equal(await page.locator('.node').count(),200);
  await page.locator('#resource-list button').filter({hasText:/^Entry299$/}).click();
  assert.ok(await page.locator('.node.selected').count());
  await page.locator('#search').fill('Entry299'); assert.equal(await page.locator('.node').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  console.log(`PASS real 300-function project: capped graph, complete list, last-node selection and search (${Math.round(performance.now()-started)} ms).`);
  await context.close();
} finally { await browser?.close(); await server?.close(); await rm(root,{recursive:true,force:true}); }
