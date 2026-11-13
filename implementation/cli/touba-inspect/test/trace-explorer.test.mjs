import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, stat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { executeAirDocument } from '../../../runtime/touba-runtime/src/index.mjs';
import { TraceBuilder } from '../../../runtime/touba-runtime/src/trace-builder.mjs';
import { createAdmissionRefusalTrace } from '../../../runtime/touba-runtime/src/admission-trace.mjs';
import { createSqliteTraceStore } from '../../../runtime/touba-runtime/src/sqlite-trace-store.mjs';
import { TraceReader } from '../src/trace-explorer/reader.mjs';
import { TraceClient } from '../src/trace-explorer/client.mjs';
import { startTraceExplorer, traceHtml } from '../src/trace-explorer/server.mjs';
import { queryOptions, projectEvent, eventCategory } from '../src/trace-explorer/model.mjs';
import { graphLayout, label, originLabel } from '../src/trace-explorer/web/view.mjs';

test('trace origins distinguish the scheduler from applications without trusting a display name', () => {
  const scheduler = { kind: 'service', id: 'touba-project-scheduler', name: 'Scheduler' };
  assert.equal(originLabel(scheduler, 'fr'), 'Planificateur');
  assert.equal(originLabel(scheduler, 'en'), 'Scheduler');
  assert.equal(originLabel({ ...scheduler, id: 'other-service' }, 'fr'), 'Application · Scheduler');
  assert.equal(originLabel({ kind: 'user', id: 'user:42' }, 'en'), 'User · user:42');
});

test('tool execution phases remain readable and classify refusals separately from output errors', () => {
  const event = (phase, status) => ({ event_id:'event:test:1', run_id:'test', sequence_index:0,
    kind:'tool_execution_status', payload:{ phase, status, effect_status:'unknown', result_origin:'handler' } });
  const admission = projectEvent(event('admission', 'refused'));
  const output = projectEvent(event('post_validation', 'refused'));
  assert.equal(eventCategory(admission.kind, admission.payload), 'refusal'); assert.equal(eventCategory(output.kind, output.payload), 'error');
  assert.equal(output.payload.effect_status, 'unknown');
  assert.equal(label('post_validation', 'fr'), 'Validation du résultat');
  assert.equal(label('journal_restore', 'en'), 'Journal restoration');
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'touba-trace-view-test-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const air = JSON.parse(await readFile(new URL('../../../tests/air/tb-v01-001-linear-skill.air.json', import.meta.url)));
  const filename = join(root, 'traces.sqlite'), store = createSqliteTraceStore({ filename });
  const result = await executeAirDocument(air, { traceStorage:store, runId:'run:viewer',
    entryRef:'strategy:examples.linear_skill/RunSourcedNote', inputs:{request:{topic:'PRIVATE_SENTINEL'}},
    agentDecisions:{ 'agent:examples.linear_skill/Researcher':{target_ref:'skill:examples.linear_skill/BuildNote', arguments:{request:{topic:'PRIVATE_SENTINEL'}}} },
    toolHandlers:{ 'tool:examples.linear_skill/FetchSource':async()=>({content:'PRIVATE_SENTINEL'}) },
  });
  assert.equal(result.status,'success');
  const id = [...store.segments()][0].id;
  const document = store.snapshot(id).document();
  await writeFile(join(root,'trace.json'),JSON.stringify(document));
  await writeFile(join(root,'air.json'),JSON.stringify(air));
  store.close();
  return { root, filename, air, document, id };
}
test('real runtime SQLite: read-only, whole-segment filters, graph and bounded minimal export', async t => {
  const {root,filename,id,document} = await fixture(t), before = await readFile(filename);
  const reader = new TraceReader({filename,root,air:join(root,'air.json')}); t.after(()=>reader.close());
  assert.equal(reader.list().segments.length,1); const state = reader.select({id});
  assert.equal(state.sourceAvailable,true); assert.equal(state.status,'success'); assert.equal(state.total,document.events.length);
  const page = reader.query({limit:2}); assert.equal(page.events.length,2); assert.equal(page.total,state.total);
  assert.equal(reader.query({search:'call_completed',limit:1}).total,document.events.filter(e=>e.kind==='call_completed').length);
  const graph = reader.graph(); assert.ok(graph.edges.length>0); assert.ok(graph.nodes.length<state.total);
  const report = reader.export({category:'call'}); assert.equal(report.coverage.selected,reader.query({category:'call'}).total);
  assert.ok(report.segment.reference.trace_digest); assert.equal(JSON.stringify(report).includes('PRIVATE_SENTINEL'),false);
  assert.ok(report.events.every(e=>e.originalEventDigest.startsWith('sha256:')));
  assert.deepEqual(await readFile(filename),before);
  assert.throws(()=>reader.query({path:'/private'}),/TraceQueryInvalid/);
  assert.throws(()=>reader.detail({sequence:-1}),/TraceEventNotFound/);
});
test('legacy JSON retains events without inferred causal edges; malformed and hostile fields', async t => {
  const {root,document} = await fixture(t);
  for (const event of document.events) { delete event.payload.trace_context; delete event.payload.call_started_event_id; }
  document.events[1].payload.message = '<script>PRIVATE_SENTINEL</script>';
  document.events[1].air_ref = { owner_ref:'skill:example', private:'PRIVATE_SENTINEL' };
  const filename = join(root,'legacy.json'); await writeFile(filename,JSON.stringify(document));
  const reader = new TraceReader({filename,root}); t.after(()=>reader.close()); reader.select({id:'document'});
  assert.equal(reader.graph().edges.length,0); assert.equal(JSON.stringify(reader.export()).includes('PRIVATE_SENTINEL'),false);
  assert.equal(reader.query().events.length,document.events.length);
  document.events[1].sequence_index = 999; await writeFile(join(root,'invalid.json'),JSON.stringify(document));
  assert.throws(()=>new TraceReader({filename:join(root,'invalid.json')}),/contiguous/);
  await symlink(filename,join(root,'link.json')); assert.throws(()=>new TraceReader({filename:join(root,'link.json')}));
});
test('open segments remain incomplete; refresh freezes a new prefix', async t => {
  const {root,air} = await fixture(t), filename = join(root,'open.sqlite'), store = createSqliteTraceStore({filename});
  const builder = new TraceBuilder(air,'skill:examples.linear_skill/BuildNote','run:open',null,0,'full',store);
  builder.push('run_started'); const id=[...store.segments()][0].id;
  const reader = new TraceReader({filename,root}); t.after(()=>{reader.close();store.close();});
  assert.equal(reader.select({id}).closed,false); assert.equal(reader.state.status,'incomplete');
  builder.push('scope_entered'); assert.equal(reader.query().total,1);
  assert.equal(reader.select({id}).total,2); assert.equal(reader.state.reference,null);
});
test('stored corruption is rejected before displaying an altered detail',async t=>{
  const {filename,root,id}=await fixture(t),reader=new TraceReader({filename,root});t.after(()=>reader.close());reader.select({id});
  const writer=new DatabaseSync(filename);
  writer.prepare('UPDATE touba_trace_events SET body=? WHERE segment_id=? AND sequence_index=1').run('{"altered":true}',id);writer.close();
  assert.throws(()=>reader.detail({sequence:1}),{code:'TraceStorageCorrupt'});
  assert.throws(()=>reader.select({id}),{code:'TraceStorageCorrupt'});
});
test('10,002 events: pagination, all-page search and export limit, worker cancellation cleans index', async t => {
  const {root,air} = await fixture(t), filename=join(root,'large.sqlite'), store=createSqliteTraceStore({filename});
  const builder=new TraceBuilder(air,'skill:examples.linear_skill/BuildNote','run:large');
  builder.push('run_started');
  for(let i=0;i<10000;i++) builder.push('call_started',{payload:{target_ref:i===9999?'tool:test/Last':'tool:test/Poll',message:'PRIVATE_SENTINEL'}});
  builder.push('run_completed',{payload:{status:'success',reason:'completed'}});
  const {events,...header}=builder.document(),id=store.openSegment(header,0);
  for(let offset=0;offset<events.length;offset+=64) store.appendBatch(id,events.slice(offset,offset+64));
  store.close();
  const client=new TraceClient({filename,root}); t.after(()=>client.close()); await client.ready;
  const temporary=client.temporary; const state=await client.request('select',{id}); assert.equal(state.total,10002);
  assert.equal((await client.request('query',{search:'Last',limit:1})).events[0].sequence,10000);
  await assert.rejects(client.request('export'),/TraceExportLimit/);
  await assert.rejects(client.request('query',{limit:201}),/TraceQueryInvalid/);
  await client.close(); await assert.rejects(stat(temporary),{code:'ENOENT'});
  const cancelled=new TraceClient({filename,root}); await cancelled.ready;
  const rejection=assert.rejects(cancelled.request('select',{id}),/TraceReaderClosed/);
  await cancelled.close(); await rejection;
  await assert.rejects(stat(cancelled.temporary),{code:'ENOENT'});
});
test('a failed worker startup releases its private directory',async t=>{
  const {root}=await fixture(t),client=new TraceClient({filename:join(root,'absent.json'),root});
  await assert.rejects(client.ready,/ENOENT/);await client.close();
  await assert.rejects(stat(client.temporary),{code:'ENOENT'});
});
test('early cancellation and a terminated reader leave the host alive and remove private indices', async t => {
  const { root, filename } = await fixture(t);
  for (let index = 0; index < 24; index++) {
    const client = new TraceClient({ root, filename });
    const rejected = assert.rejects(client.request('list'), /TraceReaderClosed/);
    await new Promise(resolve => setTimeout(resolve, index % 12));
    await Promise.all([client.close(), client.close(), rejected]);
    await assert.rejects(stat(client.temporary), { code: 'ENOENT' });
    assert.ok(client.worker.exitCode !== null || client.worker.signalCode !== null);
  }
  const client = new TraceClient({ root, filename });
  t.after(() => client.close());
  await client.ready;
  assert.notEqual(client.worker.pid, process.pid);
  client.worker.kill('SIGKILL');
  await client.exited;
  await assert.rejects(client.request('list'), /TraceReaderClosed/);
  await client.close();
  await assert.rejects(stat(client.temporary), { code: 'ENOENT' });
  const replacement = new TraceClient({ root, filename });
  t.after(() => replacement.close());
  assert.equal((await replacement.request('list')).segments.length, 1);
});
test('admission refusals show the refusal without inventing an execution',async t=>{
  const {root}=await fixture(t),filename=join(root,'admission.json');
  await writeFile(filename,JSON.stringify(createAdmissionRefusalTrace('AirInvalid','air')));
  const reader=new TraceReader({filename,root});t.after(()=>reader.close());
  const state=reader.select({id:'document'});
  assert.equal(state.status,'refused');assert.equal(state.total,1);assert.equal(state.sourceAvailable,false);
  assert.equal(reader.query({category:'refusal'}).total,1);assert.equal(reader.graph().edges.length,0);
  assert.equal(reader.detail({sequence:0}).event.payload.code,'AirInvalid');
});
test('source requires matching AIR and stays inside explicit project root', async t => {
  const {root,document,air}=await fixture(t);
  const reader=new TraceReader({filename:join(root,'trace.json'),root}); t.after(()=>reader.close()); reader.select({id:'document'});
  await assert.rejects(reader.source({sequence:document.events[1].sequence_index}),/TraceSourceAirRequired/);
  const bad=structuredClone(air);bad.module.name='changed';await writeFile(join(root,'other.json'),JSON.stringify(bad));
  const other=new TraceReader({filename:join(root,'trace.json'),root,air:join(root,'other.json')});t.after(()=>other.close());
  assert.equal(other.select({id:'document'}).sourceAvailable,false);
});
test('query validation, graph cycles and projection remain bounded',()=>{
  for(const query of [{limit:0},{offset:1000001},{start:3,end:1},{from:'bad'},{level:'unknown'},{search:'x'.repeat(4097)}]) assert.throws(()=>queryOptions(query));
  const nodes=graphLayout([{id:'a'},{id:'b'}],[{from:'a',to:'b'},{from:'b',to:'a'}]); assert.ok(nodes.every(n=>n.x<=3392));
  const event=projectEvent({payload:{message:'secret',trace_context:{span_id:'span:a',password:'secret'}}});assert.equal(JSON.stringify(event).includes('secret'),false);
});
test('the published tutorial compiles, runs and resolves its actual source', async t => {
  const {root}=await fixture(t), guide=await readFile(new URL('../../../../docs/tutoriels/explorer-une-trace.md',import.meta.url),'utf8');
  const source=guide.match(/```touba\n([\s\S]*?)```/u)[1];
  await writeFile(join(root,'lecture.tb'),source);
  const air=JSON.parse(execFileSync('cargo',['run','--quiet','--manifest-path',new URL('../../../Cargo.toml',import.meta.url).pathname,'-p','touba-cli','--bin','touba-compile','--',join(root,'lecture.tb')],{encoding:'utf8'}));
  await writeFile(join(root,'tutorial.air.json'),JSON.stringify(air));
  const result=await executeAirDocument(air,{entryRef:'strategy:lecture/Run'});assert.equal(result.status,'success');
  await writeFile(join(root,'tutorial.trace.json'),JSON.stringify(result.trace));
  const reader=new TraceReader({filename:join(root,'tutorial.trace.json'),root,air:join(root,'tutorial.air.json')});t.after(()=>reader.close());reader.select({id:'document'});
  const calls=reader.query({kind:'call_started'});assert.equal(calls.total,2);
  const resolved=await reader.source({sequence:calls.events[0].sequence});assert.equal(resolved.text,source);assert.equal(resolved.path,'lecture.tb');
  await writeFile(join(root,'lecture.tb'),source+'\n');assert.equal((await reader.source({sequence:calls.events[0].sequence})).verification,'matching_air_current_source');
  await rm(join(root,'lecture.tb'));await symlink('/etc/hosts',join(root,'lecture.tb'));
  await assert.rejects(reader.source({sequence:calls.events[0].sequence}),/TraceSourceOutsideProject/);
});
test('refusals and human resume segments retain status and exact selection',async t=>{
  const {root,air}=await fixture(t),filename=join(root,'controls.sqlite'),store=createSqliteTraceStore({filename});t.after(()=>store.close());
  const limited=await executeAirDocument(air,{traceStorage:store,entryRef:'strategy:examples.linear_skill/RunSourcedNote',inputs:{request:{topic:'x'}},runLimits:{max_steps:1}});
  assert.equal(limited.status,'failure');
  await writeFile(join(root,'review.tb'),'module review\nstrategy Run\n    gives Text\n    do\n        human.approve\n            with context as "Review"\n            into approval\n        give "done"\n');
  const review=JSON.parse(execFileSync('cargo',['run','--quiet','--manifest-path',new URL('../../../Cargo.toml',import.meta.url).pathname,'-p','touba-cli','--bin','touba-compile','--',join(root,'review.tb')],{encoding:'utf8'}));
  const paused=await executeAirDocument(review,{traceStorage:store,durableHumanApprovals:true});assert.equal(paused.reason,'human_approval_pending');
  const resumed=await executeAirDocument(review,{traceStorage:store,durableHumanApprovals:true,humanApprovalResumeCheckpoint:paused.checkpoint,humanApprovalDecisions:{[paused.checkpoint.approval_ref]:'approved'}});assert.equal(resumed.status,'success');
  const reader=new TraceReader({filename,root});t.after(()=>reader.close());
  const states=reader.list().segments.map(segment=>reader.select({id:segment.id}));
  assert.deepEqual(states.map(s=>s.status).sort(),['failure','stopped','success']);
  const groups = reader.list({ groupRuns: true });
  assert.equal(groups.segments.length, 2);
  const resumedGroup = groups.segments.find(item => item.segmentCount === 2);
  assert.equal(resumedGroup.status, 'success', 'a prior pause must not label the completed execution as pending');
  assert.equal(resumedGroup.segments.length, 2, 'all original evidence remains individually selectable');
  assert.equal(reader.list({ groupRuns: true, search: resumedGroup.runId }).segments.length, 1);
  assert.equal(reader.list({ groupRuns: true, search: 'NO_SUCH_RUN' }).segments.length, 0);
  assert.equal(reader.list({ groupRuns: true, search: '%' }).segments.length, 0);
  assert.equal(reader.list({ groupRuns: true, category: 'error' }).segments.length, 1);
  assert.ok(states.find(s=>s.status==='failure').counts.budget>0);
  const completed=states.find(s=>s.status==='success');reader.select({id:completed.id});assert.ok(reader.query({category:'human'}).total>0);
});
test('HTTP loopback authorization, cross-origin denial, CSP, assets and cancellation', async t => {
  const {root,filename}=await fixture(t), server=await startTraceExplorer({root,filename,openBrowser:false});t.after(()=>server.close());
  const url=new URL(server.url),token=url.hash.slice(1),headers={Authorization:`Bearer ${token}`};
  const request=(path,options={})=>fetch(`${url.origin}${path}`,options);
  assert.equal((await request('/api/list')).status,401);
  assert.equal((await request('/api/list',{headers})).status,200);
  assert.equal((await request('/api/list',{headers:{...headers,Origin:'https://evil.test'}})).status,403);
  assert.equal((await request('/api/list',{method:'POST',headers})).status,405);
  assert.equal((await request('/api/unknown',{headers})).status,404);
  assert.equal((await request('/__proto__')).status,404);
  assert.match(await (await request('/')).text(),/default-src 'none'/);
  for(const asset of ['app.mjs','view.mjs','style.css','tokens.css']) assert.equal((await request(`/${asset}`)).status,200);
  assert.equal((await request('/api/cancel',{headers})).status,200);
  assert.equal((await request('/api/list',{headers})).status,200);
  assert.match(await traceHtml(name=>`resource://${name}`,'resource:'),/resource:\/\/app.mjs/);
});
