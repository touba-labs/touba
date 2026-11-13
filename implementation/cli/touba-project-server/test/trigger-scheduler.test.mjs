import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createTriggerScheduler, schedulerStore, readSchedulePlans } from '../src/trigger-scheduler.mjs';
import { parseTriggerRunnerSchedule } from '../../../runtime/touba-runtime/src/trigger-schedule.mjs';
import { initProject, prepareProject } from '../../touba-project/src/project.mjs';
import { createToubaProjectServer, requiredIdentityPermission, checkToubaProjectState, readProjectEventJournal } from '../src/serve.mjs';
import { archiveProjectState } from '../src/state-maintenance.mjs';
import { readStoreFixture } from './store-fixtures.mjs';

test('scheduled tool approval expires across restart without dispatch or losing terminal evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-scheduled-expiry-'));
  let service;
  t.after(async () => { await service?.stop(); rmSync(root, {recursive:true,force:true}); });
  initProject({root}); mkdirSync(join(root,'src/qa'),{recursive:true});
  writeFileSync(join(root,'src/qa/expiry.tb'), `module qa.expiry
tool Pay
    gives Text
    requires filesystem_write
    human.approve
        with timeout_ms as 1500
strategy Work
    gives Text
    uses Pay
    do
        Pay
            into paid
        give paid
trigger Job
    on schedule "every 1s"
    runs strategy Work
    limits
        max_runs_per_day as 1
        timeout_ms as 3000
`);
  const config=JSON.parse(readFileSync(join(root,'touba.project.json')));
  config.entry='trigger:qa.expiry/Job';
  writeFileSync(join(root,'touba.project.json'),JSON.stringify(config));
  writeFileSync(join(root,'pay.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync('payment.log','unexpected');`);
  writeFileSync(join(root,'touba.manifest.json'),JSON.stringify({manifest_version:'touba-manifest-v1',bindings:{
    'tool:qa.expiry/Pay':{handler:{kind:'process',command:process.execPath,args:['pay.mjs'],cwd:root},
      grants:['filesystem_write'],secrets:[],effect_contract:{kind:'external_write',retry_mode:'none'},timeout_ms:1000,max_payload_bytes:65536}
  },triggers:{'trigger:qa.expiry/Job':{enabled:true,source:{kind:'schedule'},limits:{max_runs_per_day:1,timeout_ms:3000}}}}));
  const prepared=await prepareProject({root,mode:'write',manifestPath:'touba.manifest.json'});
  assert.equal(prepared.status,'success',JSON.stringify(prepared.diagnostics));
  const options={projectRoot:root,port:0,quiet:true,scheduleTriggers:true,
    humanWaitRuntime:{setTimer:()=>({}),clearTimer:()=>{}}};
  service=createToubaProjectServer(options); await service.start();
  const base=()=>`http://127.0.0.1:${service.server.address().port}`;
  let pending;
  for(let i=0;i<100;i++) {
    const history=await(await fetch(base()+'/decisions')).json();
    pending=history.pending_requests?.items[0]; if(pending)break; await delay(50);
  }
  assert.ok(pending,'the scheduler creates the real tool approval');
  assert.equal(existsSync(join(root,'payment.log')),false);
  await service.stop(); await delay(Math.max(0, Date.parse(pending.expires_at) - Date.now()) + 50);
  service=createToubaProjectServer({...options,scheduleTriggers:false}); await service.start();
  const history=await(await fetch(base()+'/decisions')).json();
  assert.equal(history.pending_requests.total,0);
  assert.equal(history.terminal_requests.items[0].outcome,'expired');
  const terminalSchedule = (await (await fetch(base() + '/triggers/scheduler')).json()).schedules[0];
  assert.equal(terminalSchedule.status, 'failed');
  assert.equal(terminalSchedule.error, 'HumanApprovalExpired');
  const rows=readStoreFixture(join(root,'.touba/sandbox-checkpoints.sqlite')).records;
  const record=rows.find(row=>row.request_id===pending.request_id);
  assert.equal(record.status,'completed');
  assert.equal(record.human_wait.terminalization.attempt_count,1);
  assert.equal(existsSync(join(root,'payment.log')),false);
  await service.stop(); service=createToubaProjectServer({...options,scheduleTriggers:false}); await service.start();
  assert.equal((await(await fetch(base()+'/decisions')).json()).terminal_requests.total,1);
  assert.equal(existsSync(join(root,'payment.log')),false);
  await service.stop(); service = createToubaProjectServer(options); await service.start();
  await delay(2300);
  const observation = await (await fetch(base()+'/triggers/scheduler')).json();
  assert.equal(observation.schedules[0].error, 'TriggerRateLimited');
  const events = readProjectEventJournal(join(root,'.touba/project-events.jsonl'));
  assert.equal(events.filter(event => event.type === 'trigger.schedule.quota_reached').length,1);
  assert.equal(events.filter(event => event.type === 'trigger.schedule.completed' && event.payload?.error === 'TriggerRateLimited').length,0);
  await service.stop(); service = null;
  const state = checkToubaProjectState({ projectRoot: root });
  assert.deepEqual(state.diagnostics, [], JSON.stringify(state));
  assert.ok(state.stores.every(store => !(store.active_waits || store.active_operations)), JSON.stringify(state));
  const archive = archiveProjectState({ projectRoot: root }, checkToubaProjectState);
  assert.equal(archive.status, 'preview');
  assert.ok(archive.files.some(file => file.path === 'sandbox-checkpoints.sqlite'));
  const source = join(root, 'src/qa/expiry.tb');
  writeFileSync(source, readFileSync(source, 'utf8').replace('every 1s', 'every 7d'));
  assert.equal((await prepareProject({root,mode:'write',manifestPath:'touba.manifest.json'})).status, 'success');
  assert.equal(readSchedulePlans(root)[0].interval_ms, 604800000, 'source, compilation, preparation and native scheduling agree');
});

const plan = { trigger_ref:'trigger:qa/Job', interval_ms:1000, signature:'a'.repeat(64) };
test('direct failures retain bounded terminal reasons across restart', async t => {
  for (const reason of ['HumanApprovalExpired', 'HumanApprovalRejected', 'HumanApprovalCancelled', 'ToolHandlerNonZeroExit']) {
    const f = fixture(t, { execute: async () => ({ status: 'failure', reason }) });
    const scheduler = createTriggerScheduler(f.options);
    await scheduler.tick(); f.setTime(101000); await scheduler.tick();
    assert.equal(scheduler.status().schedules[0].error, reason);
    assert.equal(scheduler.status().schedules[0].status, 'failed');
    assert.equal(f.events.at(-1)[1].code, reason);
    await scheduler.stop();
    const restarted = createTriggerScheduler(f.options); await restarted.tick();
    assert.equal(restarted.status().schedules[0].error, reason);
    await restarted.stop();
  }
});
test('scheduler reasons exclude arbitrary text and clear after successful execution', async t => {
  let result = { status: 'failure', reason: 'secret value\n/private/path' };
  const f = fixture(t, { execute: async () => result });
  const scheduler = createTriggerScheduler(f.options);
  await scheduler.tick(); f.setTime(101000); await scheduler.tick();
  assert.equal(scheduler.status().schedules[0].error, null);
  assert.equal(Object.hasOwn(f.events.at(-1)[1], 'code'), false);
  result = { status: 'failure', reason: 'HumanApprovalExpired' };
  f.setTime(102000); await scheduler.tick();
  assert.equal(scheduler.status().schedules[0].error, 'HumanApprovalExpired');
  result = { status: 'success', reason: 'HumanApprovalExpired' };
  f.setTime(103000); await scheduler.tick();
  assert.equal(scheduler.status().schedules[0].error, null);
  await scheduler.stop();
});
test('known daily quota skips execution and emits one observation across restart', async t => {
  let exhausted = true;
  const f = fixture(t, {quotaReached: () => exhausted});
  let scheduler = createTriggerScheduler(f.options); await scheduler.tick();
  f.setTime(101000); await scheduler.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.filter(([kind]) => kind === 'trigger.schedule.quota_reached').length, 1);
  await scheduler.stop(); scheduler = createTriggerScheduler(f.options);
  for (const time of [200000, 3600000, 86399000]) { f.setTime(time); await scheduler.tick(); }
  assert.equal(f.calls.length, 0); assert.equal(f.events.length, 1);
  exhausted = false; f.setTime(86400000); await scheduler.tick();
  assert.equal(f.calls.length, 1);
});
test('daily quota pauses repeated scheduling across restart until UTC reset', async t => {
  let calls = 0;
  const f = fixture(t, { execute: async () => { calls++; return { status: 'failure', reason: 'TriggerRateLimited' }; } });
  let scheduler = createTriggerScheduler(f.options);
  await scheduler.tick(); f.setTime(101000); await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(scheduler.status().schedules[0].next_run_at, '1970-01-02T00:00:00.000Z');
  scheduler = createTriggerScheduler(f.options);
  for (let i = 2; i < 20; i++) { f.setTime(100000 + i * 1000); await scheduler.tick(); }
  assert.equal(calls, 1);
  assert.equal(f.events.filter(([kind]) => kind === 'trigger.fire.completed').length, 1);
  f.setTime(86400000); await scheduler.tick(); assert.equal(calls, 2);
  assert.equal(f.events.filter(([kind]) => kind === 'trigger.schedule.skipped').length, 0);
});
function fixture(t, overrides={}) {
  const root = mkdtempSync(join(tmpdir(), 'touba-scheduler-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  let now = 100000; const calls=[], events=[];
  const options = { enabled:true, path:join(root,'scheduler.sqlite'), plans:()=>[plan], pending:()=>false,
    execute: async args => { calls.push(args); return {status:'success'}; }, emit:(...event)=>events.push(event), now:()=>now, ...overrides };
  return { root, options, calls, events, setTime:value=>{ now=value; } };
}

test('only a durable outcome settles a pending schedule, including when scheduling is disabled', async t => {
  let outcome = null, waiting = false;
  const f = fixture(t, { pending: () => waiting, outcome: () => outcome });
  const scheduler = createTriggerScheduler(f.options); await scheduler.tick();
  const store = schedulerStore(f.options.path), rows = store.read();
  rows[0].status = 'pending'; rows[0].run_id = 'schedule_' + 'b'.repeat(40); store.write(rows);
  const stopped = createTriggerScheduler({ ...f.options, enabled: false });
  await stopped.tick(); assert.equal(store.read()[0].status, 'pending', 'absence alone is not completion');
  outcome = 'success'; waiting = true;
  await stopped.tick(); assert.equal(store.read()[0].status, 'pending', 'successor approval remains active');
  waiting = false; await stopped.tick();
  assert.equal(store.read()[0].status, 'success'); assert.equal(f.calls.length, 0);
  assert.equal(store.read()[0].run_id, rows[0].run_id, 'original occurrence remains recorded');
});

test('interval parsing, first tick, UTC slots, outage skipping and restart never replay a claimed occurrence', async t => {
  assert.equal(parseTriggerRunnerSchedule('every 2m').delayMs,120000);
  assert.equal(parseTriggerRunnerSchedule('every 7d').delayMs, 604800000);
  assert.equal(parseTriggerRunnerSchedule('every 30d').ok, false);
  for (const invalid of ['* * * * *','every 0s','every 999999999999999h',null]) assert.equal(parseTriggerRunnerSchedule(invalid).ok,false);
  const f=fixture(t), scheduler=createTriggerScheduler(f.options);
  await scheduler.tick(); assert.equal(f.calls.length,0);
  f.setTime(101000); await Promise.all([scheduler.tick(), scheduler.tick()]); assert.equal(f.calls.length,1);
  await createTriggerScheduler(f.options).tick(); assert.equal(f.calls.length,1);
  f.setTime(99000); await scheduler.tick(); assert.equal(f.calls.length,1);
  f.setTime(105000); await scheduler.tick(); assert.equal(f.calls.length,2);
  assert.equal(scheduler.status().schedules[0].skipped,3);
  assert.equal(f.events.filter(([kind])=>kind==='trigger.schedule.skipped').length,1);
  assert.notEqual(f.calls[0].event_id,f.calls[1].event_id);
});

test('crash claims require exact review; old slots are never executed by acknowledgement', async t => {
  const f=fixture(t), scheduler=createTriggerScheduler(f.options); await scheduler.tick();
  const store=schedulerStore(f.options.path), rows=store.read(); rows[0].status='running'; rows[0].run_id='schedule_'+'b'.repeat(40); store.write(rows);
  f.setTime(110000); const restarted=createTriggerScheduler(f.options); await restarted.tick();
  assert.equal(restarted.status().schedules[0].status,'interrupted'); assert.equal(f.calls.length,0);
  assert.equal(f.events.filter(([kind]) => kind === 'trigger.schedule.interrupted').length, 1);
  assert.throws(()=>restarted.acknowledge({trigger_ref:plan.trigger_ref,run_id:'wrong',reason:'reviewed'}),{code:'ToubaSchedulerReviewConflict'});
  restarted.acknowledge({trigger_ref:plan.trigger_ref,run_id:rows[0].run_id,reason:'External effects reviewed'});
  await restarted.tick(); assert.equal(f.calls.length,0);
  f.setTime(111000); await restarted.tick(); assert.equal(f.calls.length,1);
  assert.equal(requiredIdentityPermission('POST','/triggers/scheduler/acknowledge'),'governance.apply');
});

test('independent schedules retain their claims and a persisted plan change starts at its next interval', async t => {
  let current = [plan, {...plan, trigger_ref:'trigger:qa/Other'}];
  const f=fixture(t,{plans:()=>current}), scheduler=createTriggerScheduler(f.options);
  await scheduler.tick(); f.setTime(101000); await scheduler.tick();
  assert.equal(f.calls.length,2); assert.equal(scheduler.status().schedules.length,2);
  current = [{...plan, signature:'c'.repeat(64)}, current[1]];
  f.setTime(102000); await scheduler.tick(); assert.equal(f.calls.length,3);
  assert.equal(f.calls[2].trigger_ref,'trigger:qa/Other');
  f.setTime(103000); await scheduler.tick(); assert.equal(f.calls.length,5);
  assert.equal(scheduler.status().schedules.length,2);
});

test('pending approval blocks additional occurrences; changed or disabled plans revoke dispatch authority', async t => {
  let waiting=false, current=[plan];
  const f=fixture(t,{pending:()=>waiting, plans:()=>current}), scheduler=createTriggerScheduler(f.options);
  await scheduler.tick(); waiting=true; f.setTime(101000); await scheduler.tick(); assert.equal(f.calls.length,0);
  waiting=false; await scheduler.tick(); assert.equal(f.calls.length,1); assert.equal(f.calls[0].authority(),true);
  current=[]; assert.equal(f.calls[0].authority(),false); assert.equal(scheduler.status().schedules[0].active,false);
  f.setTime(102000); await scheduler.tick(); assert.equal(f.calls.length,1);
  await scheduler.stop(); assert.equal(f.calls[0].cancelled(),true);
});

test('execution exception stops that schedule pending review and failed preparation is visible', async t => {
  let broken=false;
  const f=fixture(t,{ plans:()=>{if(broken)throw Object.assign(new Error('private path'),{code:'ToubaServePreparedProjectInvalid'});return[plan];},
    execute:async()=>{throw new Error('private secret');} });
  const scheduler=createTriggerScheduler(f.options); await scheduler.tick(); f.setTime(101000); await scheduler.tick();
  assert.equal(scheduler.status().schedules[0].status,'interrupted'); assert.ok(!JSON.stringify(scheduler.status()).includes('private secret'));
  broken=true; await scheduler.tick(); assert.equal(scheduler.status().status,'error');
  assert.equal(scheduler.status().error, 'ToubaServePreparedProjectInvalid');
});

test('an invalid interval is named while other schedules continue', async t => {
  const invalid = { trigger_ref: 'trigger:qa/Invalid', interval_ms: null, signature: 'f'.repeat(64), error: 'TriggerScheduleUnsupported' };
  const f = fixture(t, { plans: () => [invalid, plan] }), scheduler = createTriggerScheduler(f.options);
  await scheduler.tick(); f.setTime(101000); await scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].trigger_ref, plan.trigger_ref);
  assert.equal(scheduler.status().status, 'degraded');
  assert.deepEqual(scheduler.status().issues, [{ trigger_ref: invalid.trigger_ref, code: invalid.error }]);
  assert.equal(scheduler.status().schedules.length, 1);
});

for (const human of [false,true]) test(`project server schedules a real agent, persists approval=${human} and refuses manual replay`, async t => {
  const f=fixture(t); let service; t.after(async()=>{await service?.stop();});
  initProject({root:f.root}); mkdirSync(join(f.root,'src/qa'),{recursive:true});
  writeFileSync(join(f.root,'src/qa/jobs.tb'),`module qa.jobs
agent Answer
    gives Text
    responsibility "Return the synthetic answer"
    callable_by strategy Work
strategy Work
    gives Text
    uses Answer
    do
        Answer
            into answer
${human ? '        human.approve\n            with context as answer\n            into approval\n' : ''}        give answer
trigger Job
    on schedule "every 1s"
    runs strategy Work
    limits
        max_runs_per_day as 2
        timeout_ms as 3000
`);
  const config=JSON.parse(readFileSync(join(f.root,'touba.project.json')));
  config.entry='trigger:qa.jobs/Job'; writeFileSync(join(f.root,'touba.project.json'),JSON.stringify(config));
  writeFileSync(join(f.root,'touba.manifest.json'),JSON.stringify({manifest_version:'touba-manifest-v1',bindings:{},triggers:{
    'trigger:qa.jobs/Job':{enabled:true,source:{kind:'schedule'},limits:{max_runs_per_day:2,timeout_ms:3000}}
  }}));
  const prepared=await prepareProject({root:f.root,mode:'write',manifestPath:'touba.manifest.json'});
  assert.equal(prepared.status,'success',JSON.stringify(prepared)); assert.equal(readSchedulePlans(f.root).length,1);
  if(human) writeFileSync(join(f.root,'.touba/product-identity.json'),readFileSync(new URL('../../../contracts/product-surfaces/fixtures/valid/touba-product-identity-v1.json',import.meta.url)));
  const options={projectRoot:f.root,port:0,quiet:true,scheduleTriggers:true,
    agentDecisionProvider:()=>({action:'answer_directly',source:'qa',reason:'Local qualification',result:'scheduled'})};
  service=createToubaProjectServer(options); await service.start();
  let base=`http://127.0.0.1:${service.server.address().port}`, status;
  for(let i=0;i<120;i++) { status=await(await fetch(base+'/triggers/scheduler')).json(); if(status.schedules?.[0]?.status===(human?'pending':'success')) break; await delay(50); }
  assert.equal(status.schedules?.[0]?.status,human?'pending':'success',JSON.stringify(status));
  const runId=status.schedules[0].run_id;
  if(human) {
    await delay(2100);
    assert.equal((await(await fetch(base+'/triggers')).json()).triggers[0].state.accepted_count,1,'one pending decision prevents scheduled accumulation');
  }
  await service.stop(); service=createToubaProjectServer({...options,scheduleTriggers:false}); await service.start();
  base=`http://127.0.0.1:${service.server.address().port}`;
  const observation=await(await fetch(base+'/triggers')).json(); assert.ok(observation.triggers[0].state.accepted_count>=1);
  if(human) {
    const pending=await(await fetch(base+'/approvals/pending/current')).json();
    const decision={schema_version:'touba-approval-decision-v1',request_id:pending.request_id,run_id:pending.run_id,trace_ref:pending.trace_ref,
      user_ref:'user:khadim',device_ref:'device:review-phone-01',decision:'approve',decided_by:'user:khadim',decided_at:new Date().toISOString(),comment:null,client_ref:'qa-scheduler'};
    const accepted=await fetch(base+'/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(decision)});
    assert.equal(accepted.status,202,await accepted.clone().text());
    const resumed=await fetch(base+'/runs/sandbox/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request_id:pending.request_id})});
    assert.equal(resumed.status,200); assert.equal((await resumed.json()).status,'success');
  }
  const response=await fetch(base+'/triggers/fire',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    schema_version:'touba-sandbox-run-request-v1',execution_kind:'trigger',target_ref:'trigger:qa.jobs/Job',
    event_id:runId,effect_policy:'runtime_only',requested_by:{kind:'cli',id:'qa'},reason:'Replay must refuse'
  })});
  assert.equal(response.status,200); const replay=await response.json(); assert.equal(replay.status,'failure');
  assert.ok(JSON.stringify(replay).includes('event_replay') || JSON.stringify(replay).includes('TriggerReplayRejected'),JSON.stringify(replay));
});
