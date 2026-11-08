import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { compileTestAir } from "../../../tests/helpers/compile.mjs";
import { createTriggerService } from "../src/serve.mjs";
import { createSqliteTriggerQueue } from "../src/sqlite-queue.mjs";

async function fixture(t, { twice = false, timeout = 60000, python = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "touba-trigger-hosts-"));
  let service;
  const ingressEnv = `TOUBA_INGRESS_QA_${root.split("-").at(-1)}`;
  const managementEnv = `${ingressEnv}_ADMIN`;
  process.env[ingressEnv] = "synthetic-ingress";
  process.env[managementEnv] = "synthetic-management";
  t.after(async () => { await stop(); delete process.env[ingressEnv]; delete process.env[managementEnv]; rmSync(root, { recursive: true, force: true }); });
  const source = join(root, "webhook.tb"), airPath = join(root, "webhook.air.json");
  writeFileSync(source, `module qa.webhook
tool Before
    gives Int
tool Pay
    takes amount as Int
    gives Int
    human.approve
        with role as "finance"
        with timeout_ms as ${timeout}
agent Answer
    gives Int
    responsibility "Return the synthetic amount"
    callable_by strategy Work
strategy Work
    gives Int
    uses Answer
    uses Before
    uses Pay
    do
        Before
            into before
        Answer
            into amount
        Pay
            with amount as amount
            into result
${twice ? '        Pay\n            with amount as amount\n            into second\n' : ''}        give result
trigger Job
    on request POST "/webhook"
    runs strategy Work
    limits
        max_runs_per_day as 5
        timeout_ms as 10000
`);
  writeFileSync(airPath, JSON.stringify(compileTestAir(source)));
  const log = join(root, "effects.log"), providerLog = join(root, "provider.log");
  const handler = join(root, "handler.mjs"), provider = join(root, "provider.mjs"), authority = join(root, "authority.mjs");
  writeFileSync(handler, `import {appendFileSync} from 'node:fs';
    let text=''; for await (const part of process.stdin) text+=part;
    const request=JSON.parse(text); appendFileSync(${JSON.stringify(log)},process.argv[2]+'\\n');
    process.stdout.write(JSON.stringify({ok:true,value:request.arguments?.amount??0}));`);
  writeFileSync(provider, `import {appendFileSync} from 'node:fs';
    export function decideAgentCapability(){appendFileSync(${JSON.stringify(providerLog)},'called\\n');
      return {action:'answer_directly',source:'qa',reason:'Synthetic provider',result:7};}`);
  writeFileSync(authority, `export function attestHumanApproval({request,decision,evidenceRef}) {
    return {request_id:request.request_id,run_id:request.run_id,decision,subject_ref:'employee:reviewer',
      roles:evidenceRef==='synthetic-proof'?['finance']:['reader']};}`);
  const pythonHost = join(root,'host.py'), pythonClosed = join(root,'python-closed');
  if(python) writeFileSync(pythonHost,`import atexit
from pathlib import Path
atexit.register(lambda: Path(${JSON.stringify(pythonClosed)}).write_text('closed'))
def decide_agent_capability(request):
    with open(${JSON.stringify(providerLog)},'a') as output: output.write('called\\n')
    return {'action':'answer_directly','source':'qa','reason':'Synthetic Python provider','result':7}
def attest_human_approval(value):
    request=value['request']
    return {'request_id':request['request_id'],'run_id':request['run_id'],'decision':value['decision'],
            'subject_ref':'employee:reviewer','roles':['finance'] if value['evidenceRef']=='synthetic-proof' else ['reader']}
`);
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({manifest_version:"touba-manifest-v1", bindings:Object.fromEntries(["Before","Pay"].map(name=>[
    `tool:qa.webhook/${name}`, {handler:{kind:"process",command:process.execPath,args:[handler,name],cwd:root},grants:[],secrets:[],
      effect_contract:{kind:"none"},timeout_ms:2000,max_payload_bytes:4096}])),
    triggers:{"trigger:qa.webhook/Job":{enabled:true,source:{kind:"request"},limits:{max_runs_per_day:5,timeout_ms:10000}}}}));
  const options = { airPath, manifestPath, queuePath:join(root,"queue.sqlite"), statePath:join(root,"triggers.sqlite"),
    traceStorePath:join(root,"traces.sqlite"), humanCheckpointStorePath:join(root,"approvals.sqlite"), traceDir:join(root,"exports"),
    agentDecisionProviderPath:python?pythonHost:provider,humanApprovalHostPath:python?pythonHost:authority,authTokenEnv:ingressEnv,managementTokenEnv:managementEnv,
    processingTimeoutMs:10,port:0,quiet:true };
  async function stop() { if(service?.server.listening) await new Promise(resolve=>service.server.close(resolve)); await delay(10); }
  async function start() { service=await createTriggerService(options); await service.start(); return service; }
  function entries() { const queue=createSqliteTriggerQueue({filename:options.queuePath,readOnly:true}); try{return queue.page().entries;}finally{queue.close();} }
  async function waitStatus(status) { for(let i=0;i<150;i++){const value=entries()[0];if(value?.status===status)return value;await delay(20);}assert.fail(JSON.stringify(entries())); }
  async function request(path, body, token="synthetic-management") { return fetch(`http://127.0.0.1:${service.server.address().port}${path}`,{
    method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","x-touba-event-id":"event-one"},
    body:body===undefined?undefined:JSON.stringify(body)}); }
  await start();
  return { root, options, start, stop, entries, waitStatus, request, pythonClosed,
    effects:()=>existsSync(log)?readFileSync(log,"utf8").trim().split("\n"):[],
    providerCalls:()=>existsSync(providerLog)?readFileSync(providerLog,"utf8").trim().split("\n").length:0 };
}

test("a hosted webhook persists its pause, resumes once after restart and separates ingress from attested management", async t => {
  const f=await fixture(t);
  assert.equal((await f.request('/webhook',{},'synthetic-ingress')).status,202);
  let entry=await f.waitStatus('awaiting_human');
  assert.deepEqual(f.effects(),['Before']); assert.equal(f.providerCalls(),1);
  assert.equal((await f.request('/_touba/approvals',undefined,'synthetic-ingress')).status,401);
  const pending=await(await f.request('/_touba/approvals')).json();
  assert.equal(pending.approvals.length,1); assert.ok(!JSON.stringify(pending).includes('arguments'));
  const request={queue_id:entry.queue_id,request_id:pending.approvals[0].request_id,decision:{decision:'approved',evidence_ref:'synthetic-proof'}};
  assert.equal((await f.request('/_touba/approvals',{...request,inputs:{amount:999}})).status,400);
  assert.equal((await f.request('/webhook',{},'synthetic-ingress')).status,202);
  assert.equal((await(await f.request('/status',undefined,'synthetic-ingress')).json()).triggers[0].queue.awaiting_human,1);
  await f.stop(); await f.start(); await delay(50); assert.equal(f.entries()[0].status,'awaiting_human');
  const refused=await(await f.request('/_touba/approvals',{...request,decision:{decision:'approved',evidence_ref:'wrong-role'}})).json();
  assert.equal(refused.status,'awaiting_human',JSON.stringify(refused)); assert.deepEqual(f.effects(),['Before']);
  const responses=await Promise.all([f.request('/_touba/approvals',request),f.request('/_touba/approvals',request)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  entry=await f.waitStatus('succeeded'); assert.equal(entry.attempt_count,1);
  assert.deepEqual(f.effects(),['Before','Pay']); assert.equal(f.providerCalls(),1);
  assert.equal((await f.request('/_touba/approvals',request)).status,409);
  assert.equal((await f.request('/webhook',{},'synthetic-ingress')).status,409);
  const status=await(await f.request('/status',undefined,'synthetic-ingress')).json();
  assert.equal(status.triggers[0].state.accepted_count,1);
  assert.ok(existsSync(entry.trace_path));
});

test("successive protected calls create distinct requests, not automatic retries", async t => {
  const f=await fixture(t,{twice:true}); await f.request('/webhook',{},'synthetic-ingress');
  await f.waitStatus('awaiting_human');
  const first=(await(await f.request('/_touba/approvals')).json()).approvals[0];
  const submit=pending=>f.request('/_touba/approvals',{queue_id:pending.queue_id,request_id:pending.request_id,decision:{decision:'approved',evidence_ref:'synthetic-proof'}});
  const result=await(await submit(first)).json(); assert.equal(result.status,'awaiting_human',JSON.stringify(result));
  assert.notEqual(result.approval.request_id,first.request_id); assert.deepEqual(f.effects(),['Before','Pay']);
  assert.equal((await submit(first)).status,409);
  assert.equal((await(await submit(result.approval)).json()).status,'succeeded');
  assert.deepEqual(f.effects(),['Before','Pay','Pay']); assert.equal(f.providerCalls(),1);
});

test("a rejection ends the queue entry without replaying its earlier effect", async t => {
  const f=await fixture(t); await f.request('/webhook',{},'synthetic-ingress'); await f.waitStatus('awaiting_human');
  const approval=(await(await f.request('/_touba/approvals')).json()).approvals[0];
  const response=await f.request('/_touba/approvals',{queue_id:approval.queue_id,request_id:approval.request_id,
    decision:{decision:'rejected',evidence_ref:'synthetic-proof'}});
  assert.equal((await response.json()).status,'failed');
  await delay(100); assert.deepEqual(f.effects(),['Before']); assert.equal(f.entries()[0].attempt_count,1);
});

test("expiration and altered checkpoint arguments never dispatch the approved tool", async t => {
  for (const scenario of ['expired','tampered']) await t.test(scenario,async t => {
    const f=await fixture(t,{timeout:scenario==='expired'?40:60000});
    await f.request('/webhook',{},'synthetic-ingress'); await f.waitStatus('awaiting_human');
    const pending=(await(await f.request('/_touba/approvals')).json()).approvals[0];
    if(scenario==='expired') await delay(75);
    else {
      const queue=createSqliteTriggerQueue({filename:f.options.queuePath});
      try { const entry=queue.get(pending.queue_id); entry.checkpoint.run_id='altered-run'; queue.finish(entry); }
      finally { queue.close(); }
    }
    const result=await(await f.request('/_touba/approvals',{queue_id:pending.queue_id,request_id:pending.request_id,
      decision:{decision:'approved',evidence_ref:'synthetic-proof'}})).json();
    assert.equal(result.status,'failed',JSON.stringify(result));
    assert.deepEqual(f.effects(),['Before']); assert.equal(f.providerCalls(),1);
  });
});

test("management is explicitly configured and never shares the ingress credential", async t => {
  const f=await fixture(t); await f.stop();
  await assert.rejects(createTriggerService({...f.options,managementTokenEnv:f.options.authTokenEnv}),{code:'TriggerManagementTokenInvalid'});
  delete f.options.managementTokenEnv;
  await f.start();
  assert.equal((await f.request('/_touba/approvals')).status,404);
  const help=spawnSync(process.execPath,[new URL('../src/serve.mjs',import.meta.url).pathname,'--agent-decision-provider','provider.py',
    '--human-approval-host','authority.mjs','--human-checkpoint-store','custody.sqlite','--management-token-env','QA','--help'],{encoding:'utf8'});
  assert.equal(help.status,0,help.stderr);
  for(const flag of ['--agent-decision-provider','--human-approval-host','--human-checkpoint-store','--management-token-env','--effect-journal']) assert.ok(help.stdout.includes(flag));
});

test("one Python host supplies the provider and attestation and closes after the service", {skip:!process.env.TOUBA_HOST_PYTHON}, async t => {
  const f=await fixture(t,{python:true});
  await f.request('/webhook',{},'synthetic-ingress'); await f.waitStatus('awaiting_human');
  const pending=(await(await f.request('/_touba/approvals')).json()).approvals[0];
  const result=await(await f.request('/_touba/approvals',{queue_id:pending.queue_id,request_id:pending.request_id,
    decision:{decision:'approved',evidence_ref:'synthetic-proof'}})).json();
  assert.equal(result.status,'succeeded',JSON.stringify(result)); assert.equal(f.providerCalls(),1);
  assert.deepEqual(f.effects(),['Before','Pay']);
  await f.stop();
  for(let i=0;i<100&&!existsSync(f.pythonClosed);i++) await delay(20);
  assert.equal(existsSync(f.pythonClosed),true,'the Python host exits rather than remaining an orphan');
});
