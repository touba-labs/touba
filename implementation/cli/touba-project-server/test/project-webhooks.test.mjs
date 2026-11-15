import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {initProject,prepareProject} from '../../touba-project/src/project.mjs';
import {createToubaProjectServer,requiredIdentityPermission,checkToubaProjectState} from '../src/serve.mjs';
import {createProjectWebhooks,readProjectRequestRoutes} from '../src/project-webhooks.mjs';
import {createProjectActivityGate} from '../src/project-activity.mjs';
import {createSqliteTriggerQueue} from '../../touba-trigger-service/src/sqlite-queue.mjs';
import {createServer} from 'node:http';
import {approvalHostTemplate} from '../../../contracts/product-surfaces/approval-host-template.mjs';
import {createHostModuleLoader} from '../../touba-run/src/host-modules.mjs';
import {readPreparedProject} from '../src/prepared-project.mjs';

const secret='synthetic-webhook-secret-for-tests-only-1234';
const trigger='trigger:qa.webhook/Job';
function headers(body,id,path='/_touba/events/pay') {
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256',secret).update(['touba-webhook-v1',timestamp,id,'POST',path,''].join('\n')).update(body).digest('hex');
  return {'content-type':'application/json','x-touba-timestamp':timestamp,'x-touba-event-id':id,'x-touba-signature':`v1=${signature}`};
}
async function fixture(t,{approval=false,quota=5}={}) {
  const root=mkdtempSync(join(tmpdir(),'touba-project-webhook-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  initProject({root});mkdirSync(join(root,'src/qa'),{recursive:true});
  writeFileSync(join(root,'src/qa/webhook.tb'),`module qa.webhook
tool Pay
    takes amount as Int
    gives Int
    requires filesystem_write
${approval?'    human.approve\n        with role as "reviewer"\n        with timeout_ms as 60000\n':''}strategy Work
    takes amount as Int
    gives Int
    uses Pay
    do
        Pay
            with amount as amount
            into paid
        give paid
trigger Job
    on request POST "/pay"
    runs strategy Work
    with amount as payload.amount
    limits
        max_runs_per_day as ${quota}
        timeout_ms as 10000
`);
  const config=JSON.parse(readFileSync(join(root,'touba.project.json')));
  config.entry=trigger;writeFileSync(join(root,'touba.project.json'),JSON.stringify(config));
  writeFileSync(join(root,'pay.mjs'),`import {appendFileSync,readFileSync} from 'node:fs';const req=JSON.parse(readFileSync(0,'utf8'));appendFileSync('payments.txt','paid\\n');process.stdout.write(JSON.stringify({ok:true,value:req.arguments.amount,effect_receipt:{effect_id:req.effect.effect_id,request_digest:req.effect.request_digest,outcome:'applied',receipt_ref:'qa:ledger'}}));`);
  writeFileSync(join(root,'touba.manifest.json'),JSON.stringify({manifest_version:'touba-manifest-v1',bindings:{
    'tool:qa.webhook/Pay':{handler:{kind:'process',command:process.execPath,args:['pay.mjs'],cwd:root},grants:['filesystem_write'],secrets:[],effect_contract:{kind:'external_write',retry_mode:'none'},timeout_ms:3000,max_payload_bytes:65536}
  },triggers:{[trigger]:{enabled:true,source:{kind:'request'},payload:{content_types:['application/json'],max_bytes:65536,map:{amount:'$.amount'}},limits:{max_runs_per_day:quota,timeout_ms:10000}}}}));
  const prepare=async()=>{
    const result=await prepareProject({root,mode:'write',manifestPath:'touba.manifest.json'});
    assert.equal(result.status,'success',JSON.stringify(result.diagnostics));
  };
  await prepare();
  return {root,prepare,queuePath:join(root,'.touba/project-webhooks.sqlite'),statePath:join(root,'.touba/trigger-state.sqlite')};
}
async function waitFor(fn) {
  for(let i=0;i<120;i++){const value=await fn();if(value)return value;await delay(50);}
  assert.fail('condition did not become true');
}
async function server(t,f,extra={}) {
  process.env.TOUBA_QA_WEBHOOK_SECRET=secret;
  const options={projectRoot:f.root,port:0,quiet:true,requestTriggers:true,webhookSignatureSecretEnv:'TOUBA_QA_WEBHOOK_SECRET',...extra};
  let service;
  const start=async()=>{service=createToubaProjectServer(options);await service.start();};
  const stop=async()=>{if(service){const pending=service.stop();service.server.closeAllConnections();await pending;service=null;}};
  t.after(stop);await start();
  const send=(path,body,extraHeaders={})=>fetch(`http://127.0.0.1:${service.server.address().port}${path}`,{
    headers:{'content-type':'application/json',...extraHeaders},...(body!==undefined?{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)}:{})});
  const event=(id='delivery-1',payload={amount:7},path='/_touba/events/pay')=>{const body=JSON.stringify(payload);return send(path,body,headers(body,id,path));};
  const status=async()=>{const res=await send('/triggers/webhooks');assert.equal(res.status,200,await res.clone().text());return res.json();};
  return {send,event,status,start,stop};
}

test('project ingress validates before 202, uses the shared quota and preserves signed event identity',async t=>{
  const f=await fixture(t,{quota:1}),s=await server(t,f);
  assert.equal((await s.event('invalid',{amount:'wrong'})).status,400);
  const body=JSON.stringify({amount:7}),signed=headers(body,'original');signed['x-touba-event-id']='changed';
  assert.equal((await s.send('/_touba/events/pay',body,signed)).status,401);
  const accepted=await s.event();assert.equal(accepted.status,202,await accepted.clone().text());
  const limited = await s.event('second');
  assert.equal(limited.status,429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.ok(Date.parse((await limited.json()).retry_at) > Date.now());
  const done=await waitFor(async()=>{const value=await s.status();return value.counts.succeeded&&value;});
  assert.equal(done.entries[0].attempt_count,1);
  assert.equal(readFileSync(join(f.root,'payments.txt'),'utf8'),'paid\n');
  assert.equal((await s.event()).status,409);
  assert.equal((await s.event('delivery-1',{amount:8})).status,409);
  assert.equal(JSON.stringify(done).includes('"arguments"'),false);
  await s.stop();await s.start();assert.equal((await s.status()).counts.succeeded,1);
  assert.equal((await s.event()).status,409);
});

for(const language of ['javascript','python']) test(`${language} generated host: webhook approval uses the private dossier and resumes once after restart`,{skip:language==='python'&&!process.env.TOUBA_HOST_PYTHON?'select TOUBA_HOST_PYTHON with the SDK':false},async t=>{
  const f=await fixture(t,{approval:true});
  let permissions=['events.read','decisions.read','decisions.act','executions.run','executions.read','governance.apply'];
  const generated=approvalHostTemplate(language,{schema_version:'touba-product-identity-v1',users:[{user_ref:'user:reviewer'}]});
  mkdirSync(join(f.root,'host'));mkdirSync(join(f.root,'config'));
  writeFileSync(join(f.root,generated.host.path),generated.host.content);
  const setRole=role=>writeFileSync(join(f.root,generated.directory.path),JSON.stringify({schema_version:'touba-approval-directory-v1',users:{'user:reviewer':{enabled:true,roles:[role]}}}));
  setRole('reviewer');
  const loader=createHostModuleLoader();t.after(()=>loader.close());
  const host=await loader.approvalHost(join(f.root,generated.host.path),{projectRoot:f.root});
  const identity=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({active:true,user:{id:'reviewer'},permissions,project_root:f.root,session_id:'qa'}));});
  await new Promise(resolve=>identity.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{identity.closeAllConnections();await new Promise(resolve=>identity.close(resolve));});
  const s=await server(t,f,{identityControlPlaneUrl:`http://127.0.0.1:${identity.address().port}`,identityServiceToken:'synthetic-test-only-service-token',...host});
  const send=(path,body)=>s.send(path,body,{'x-touba-identity-token':'synthetic-session'});
  assert.equal((await s.event()).status,202);
  const pending=await waitFor(async()=>{const res=await send('/approvals/pending/current');const data=await res.json();return data.request_id&&data;});
  assert.equal(existsSync(join(f.root,'payments.txt')),false);
  const dossier=`/approvals/dossier/${encodeURIComponent(pending.request_id)}`;
  permissions=['decisions.read'];assert.equal((await send(dossier)).status,403);
  permissions=['decisions.act'];setRole('reader');assert.equal((await send(dossier)).status,403);
  setRole('reviewer');const detail=await send(dossier);assert.equal(detail.status,200,await detail.clone().text());
  assert.match(await detail.text(),/7/);
  permissions=['events.read','decisions.read','decisions.act','executions.run','executions.read','governance.apply'];
  const observed=await(await send('/triggers/webhooks')).json();assert.equal(observed.counts.awaiting_human,1);
  assert.equal(observed.entries[0].run_id,pending.run_id);
  assert.equal(observed.entries[0].request_id,pending.request_id);
  const mutation=await send('/project/prepare',{});assert.equal(mutation.status,409);
  assert.equal((await mutation.json()).code,'ToubaServeProjectOperationsActive');
  permissions=['events.read'];
  assert.equal((await send('/triggers/webhooks/review',{queue_id:observed.entries[0].queue_id,review_digest:observed.entries[0].review_digest,action:'close',reason:'not allowed',reconciled:true})).status,403);
  permissions=['events.read','decisions.read','decisions.act','executions.run','executions.read','governance.apply'];
  await s.stop();await s.start();
  assert.equal((await(await send('/approvals/pending/current')).json()).request_id,pending.request_id);
  const decision={schema_version:'touba-approval-decision-v1',request_id:pending.request_id,run_id:pending.run_id,trace_ref:pending.trace_ref,
    user_ref:'user:reviewer',device_ref:'device:fixture',decision:'approve',decided_by:'user:reviewer',decided_at:new Date().toISOString(),comment:null,client_ref:'test'};
  const admitted=await send('/decisions',decision);assert.equal(admitted.status,202,await admitted.clone().text());
  const resumed=await send('/runs/sandbox/resume',{request_id:pending.request_id});assert.equal(resumed.status,200,await resumed.clone().text());
  assert.equal((await resumed.json()).status,'success');
  await waitFor(async()=> (await(await send('/triggers/webhooks')).json()).counts.succeeded===1);
  assert.equal(readFileSync(join(f.root,'payments.txt'),'utf8'),'paid\n');
  const replay=await send('/runs/sandbox/resume',{request_id:pending.request_id});
  assert.equal(replay.status,200,'completed resume returns its durable result, without executing again');
  assert.equal((await replay.json()).run_id,pending.run_id);
  assert.equal(readFileSync(join(f.root,'payments.txt'),'utf8'),'paid\n');
  assert.equal((await s.event()).status,409);
});

test('one project listener reloads multiple module routes after preparation and refuses duplicates',async t=>{
  const f=await fixture(t),s=await server(t,f);
  writeFileSync(join(f.root,'src/qa/other.tb'),`module qa.other
strategy Work
    takes amount as Int
    gives Int
    do
        give amount
trigger Other
    on request POST "/other"
    runs strategy Work
    with amount as payload.amount
    limits
        max_runs_per_day as 5
        timeout_ms as 10000
`);
  writeFileSync(join(f.root,'src/qa/healthy.tb'),readFileSync(join(f.root,'src/qa/other.tb'),'utf8')
    .replace('module qa.other','module qa.healthy').replace('trigger Other','trigger Healthy').replace('"/other"','"/healthy"'));
  const config=JSON.parse(readFileSync(join(f.root,'touba.project.json')));config.entrypoints=[trigger,'trigger:qa.other/Other','trigger:qa.healthy/Healthy'];
  writeFileSync(join(f.root,'touba.project.json'),JSON.stringify(config));
  const manifest=JSON.parse(readFileSync(join(f.root,'touba.manifest.json')));manifest.triggers['trigger:qa.other/Other']={enabled:true,source:{kind:'request'},payload:{content_types:['application/json'],max_bytes:65536,map:{amount:'$.amount'}},limits:{max_runs_per_day:5,timeout_ms:10000}};
  manifest.triggers['trigger:qa.healthy/Healthy']=structuredClone(manifest.triggers['trigger:qa.other/Other']);
  writeFileSync(join(f.root,'touba.manifest.json'),JSON.stringify(manifest));await f.prepare();
  assert.equal((await s.status()).routes.length,3);
  assert.equal((await s.event('other',{amount:8},'/_touba/events/other')).status,202);
  await waitFor(async()=> (await s.status()).counts.succeeded===1);
  writeFileSync(join(f.root,'src/qa/other.tb'),readFileSync(join(f.root,'src/qa/other.tb'),'utf8').replace('"/other"','"/pay"'));
  for (const mode of ['plan', 'write']) {
    const result = await prepareProject({root:f.root,mode,manifestPath:'touba.manifest.json'});
    assert.equal(result.status,'error');
    assert.ok(result.diagnostics.some(item=>item.code==='TriggerRouteConflict'));
  }
  // Model a previously accepted preparation with conflicting routes. This is
  // a synthetic legacy artifact, not a path that bypasses normal preparation.
  const prepared=readPreparedProject(f.root,{verify:false});
  for (const input of prepared.inputs.filter(item=>item.kind==='air')) {
    const path=join(f.root,input.path),document=JSON.parse(readFileSync(path,'utf8'));
    for (const item of document.definitions.triggers??[]) if(item.id==='trigger:qa.other/Other') item.event.value='POST /pay';
    writeFileSync(path,JSON.stringify(document));
  }
  for(const input of prepared.inputs)input.digest_sha256=`sha256:${createHash('sha256').update(readFileSync(join(f.root,input.path))).digest('hex')}`;
  writeFileSync(join(f.root,'.touba/build/dev/touba.effective-project.json'),JSON.stringify(prepared));
  assert.throws(()=>readProjectRequestRoutes(f.root),{code:'TriggerRouteConflict'});
  assert.equal((await s.event()).status,503);
  assert.equal((await s.status()).code,'TriggerRouteConflict');
  assert.equal((await s.event('healthy',{amount:9},'/_touba/events/healthy')).status,202);
  await waitFor(async()=> (await s.status()).counts.succeeded===2);
  await s.stop();
  await assert.rejects(s.start(),{code:'TriggerRouteConflict'});
});

test('queue review is explicit, compare-and-swap, cannot retry unknown effects and stays bounded',async t=>{
  const f=await fixture(t);const signature=readProjectRequestRoutes(f.root)[0].signature;
  const q=createSqliteTriggerQueue({filename:f.queuePath});
  for(const [id,status,started] of [['safe','dead_lettered',false],['unknown','interrupted',true]])q.enqueue({queue_id:`queue:${id}`,execution_owner:'project-server-v1',trigger_ref:trigger,event_id:id,status,
    received_at:new Date().toISOString(),effects_started:started,plan_signature:signature,arguments:{amount:17},http:{payload_sha256:'a'.repeat(64)}});
  q.close();
  const s=await server(t,f);
  const original=await s.status(),safe=original.entries.find(row=>row.event_id==='safe'),unknown=original.entries.find(row=>row.event_id==='unknown');
  assert.deepEqual(safe.actions,['retry','discard']);assert.deepEqual(unknown.actions,['close']);
  const request=(row,action,extra={})=>({queue_id:row.queue_id,review_digest:row.review_digest,action,reason:'Synthetic review',...extra});
  assert.ok((await s.send('/triggers/webhooks/review',request(unknown,'retry'))).status>=400);
  assert.ok((await s.send('/triggers/webhooks/review',request(unknown,'close'))).status>=400);
  const closed=await s.send('/triggers/webhooks/review',request(unknown,'close',{reconciled:true}));assert.equal(closed.status,200,await closed.clone().text());
  assert.equal((await closed.json()).counts.closed,1);
  assert.ok((await s.send('/triggers/webhooks/review',request(unknown,'close',{reconciled:true}))).status>=400);
  const retry=await s.send('/triggers/webhooks/review',request(safe,'retry'));assert.equal(retry.status,200,await retry.clone().text());
  assert.equal((await s.status()).counts.queued,1,'retry is delayed rather than executed in the review request');
  await waitFor(async()=> (await s.status()).counts.succeeded===1);
  assert.equal(readFileSync(join(f.root,'payments.txt'),'utf8'),'paid\n');
  const first=await(await s.send('/triggers/webhooks?limit=1')).json();assert.equal(first.entries.length,1);assert.ok(first.next);
  const second=await(await s.send('/triggers/webhooks?limit=1&after='+encodeURIComponent(first.next))).json();assert.equal(second.entries.length,1);assert.equal(second.next,null);
  assert.equal(requiredIdentityPermission('POST','/triggers/webhooks/review'),'governance.apply');
  await s.stop();
  const preflight=checkToubaProjectState({projectRoot:f.root});
  assert.deepEqual(preflight.diagnostics,[]);assert.equal(preflight.stores.find(store=>store.store==='projectWebhooksPath').active_operations,0);
});

test('a changed plan cannot consume an already queued delivery and the refused event remains reviewable',async t=>{
  const f=await fixture(t),route=readProjectRequestRoutes(f.root)[0];
  const q=createSqliteTriggerQueue({filename:f.queuePath});
  q.enqueue({queue_id:'queue:old-plan',execution_owner:'project-server-v1',trigger_ref:trigger,event_id:'old-plan',status:'queued',received_at:new Date().toISOString(),effects_started:false,
    arguments:{amount:3},plan_signature:route.signature,http:{payload_sha256:'a'.repeat(64)}});q.close();
  const before=checkToubaProjectState({projectRoot:f.root});assert.equal(before.stores.find(store=>store.store==='projectWebhooksPath').active_operations,1);
  const source=join(f.root,'src/qa/webhook.tb');writeFileSync(source,readFileSync(source,'utf8').replace('give paid','give paid + 0'));
  await f.prepare();const s=await server(t,f);
  const status=await waitFor(async()=>{const value=await s.status();return value.counts.dead_lettered&&value;});
  assert.equal(status.entries[0].code,'TriggerPlanChanged');assert.equal(existsSync(join(f.root,'payments.txt')),false);
  const row=status.entries[0];
  const review=action=>s.send('/triggers/webhooks/review',{queue_id:row.queue_id,review_digest:row.review_digest,action,reason:'Review changed project'});
  const retry=await review('retry');assert.equal(retry.status,409);assert.equal((await retry.json()).code,'TriggerPlanChanged');
  assert.equal((await review('discard')).status,200);assert.equal((await s.status()).counts.closed,1);
});
