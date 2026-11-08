import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createProjectValidation, readValidationPlan, validationStore } from '../src/project-validation.mjs';
import { initProject, newModule, prepareProject } from '../../touba-project/src/project.mjs';
import { newPackage } from '../../touba-project/src/package-author.mjs';
import { createToubaProjectServer, requiredIdentityPermission } from '../src/serve.mjs';

const hash = bytes => 'sha256:'+createHash('sha256').update(bytes).digest('hex');
const success = 'import test from "node:test"; import assert from "node:assert/strict"; test("real assertion",()=>assert.equal(2+2,4));';
async function fixture(t, source=success, extra={}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'touba-validation-')));
  let service;
  t.after(async()=>{await service?.stop(); rmSync(root,{recursive:true,force:true});});
  initProject({root});
  newModule('qa.validation',{root});
  writeFileSync(join(root,'src/qa/validation.tb'),'module qa.validation\nfunction Answer\n    gives Int\n    do\n        give 4\n');
  const config=JSON.parse(readFileSync(join(root,'touba.project.json'),'utf8'));
  config.entry='function:qa.validation/Answer'; writeFileSync(join(root,'touba.project.json'),JSON.stringify(config));
  const prepared=await prepareProject({root,mode:'write'});
  assert.equal(prepared.status,'success',JSON.stringify(prepared));
  mkdirSync(join(root,'tests'),{recursive:true});
  const file=extra.engine === 'python' ? 'tests/test_qa.py' : 'tests/qa.test.mjs';
  writeFileSync(join(root,file),source);
  const planPath=join(root,'validation-plan.json');
  const suite={id:'contracts',label:'Handler contracts',kind:'contract',engine:'node',tests:[file],inputs:{[file]:hash(source)},timeout_ms:3000,...extra};
  writeFileSync(planPath,JSON.stringify({schema_version:'touba-validation-plan-v1',suites:[suite]}));
  const events=[];
  service=createProjectValidation({root,planPath,emit:(...args)=>events.push(args)});
  return {root,file,planPath,suite,service,events};
}
async function finish(service,id) {
  for(let i=0;i<1200;i++) { const row=service.receipt(id); if(row.status!=='running')return row; await delay(25); }
  assert.fail('validation did not finish');
}
test('explicit suite review executes real assertions once and survives restart',async t=>{
  const f=await fixture(t), preview=f.service.preview('user:owner','contracts');
  assert.throws(()=>f.service.start('user:other',{id:preview.id,revision:preview.revision}),{code:'ToubaValidationReviewMissing'});
  const body={id:preview.id,revision:preview.revision};
  const row=f.service.start('user:owner',body);
  assert.equal(row.status,'running');
  assert.equal(f.service.start('user:owner',body).id,row.id);
  const result=await finish(f.service,row.id);
  assert.equal(result.status,'passed',JSON.stringify(result)); assert.equal(result.tests,1); assert.equal(result.passed,1);
  assert.equal(f.events.length,1);
  await f.service.stop();
  const restarted=createProjectValidation({root:f.root,planPath:f.planPath});
  t.after(()=>restarted.stop());
  assert.equal(restarted.receipt(row.id).status,'passed');
  assert.equal(restarted.start('user:owner',body).id,row.id);
});
test('configuration, unknown commands, changed reviewed inputs and lost authority fail closed',async t=>{
  const f=await fixture(t), preview=f.service.preview('user:owner','contracts');
  assert.throws(()=>f.service.start('user:owner',{id:preview.id,revision:preview.revision,command:'anything'}),{code:'ToubaValidationRequestInvalid'});
  writeFileSync(join(f.root,f.file),success+'\n// changed');
  assert.throws(()=>f.service.start('user:owner',{id:preview.id,revision:preview.revision}),{code:'ToubaValidationInputChanged'});
  writeFileSync(join(f.root,f.file),success);
  const row=f.service.start('user:owner',{id:preview.id,revision:preview.revision},async()=>false);
  assert.equal((await finish(f.service,row.id)).status,'interrupted');
  writeFileSync(f.planPath,JSON.stringify({schema_version:'touba-validation-plan-v1',suites:[{...f.suite,command:'shell'}]}));
  assert.throws(()=>readValidationPlan(f.root,f.planPath),{code:'ToubaValidationPlanInvalid'});
  assert.throws(()=>f.service.preview('owner','unknown'),{code:'ToubaValidationSuiteMissing'});
});

test('package suite uses canonical package test and a real compiled contract',async t=>{
  const f=await fixture(t);await f.service.stop();
  newPackage('qa.echo',{root:f.root});
  const inputs={};
  for(const file of ['echo/touba.package.json','echo/src/qa/echo.tb','echo/tests/echo.test.mjs','echo/README.md','echo/.gitignore']) inputs[file]=hash(readFileSync(join(f.root,file)));
  writeFileSync(f.planPath,JSON.stringify({schema_version:'touba-validation-plan-v1',suites:[{id:'package',label:'Echo package',kind:'package',engine:'package',tests:['echo/touba.package.json'],inputs,timeout_ms:30000}]}));
  const service=createProjectValidation({root:f.root,planPath:f.planPath});t.after(()=>service.stop());
  const preview=service.preview('owner','package');
  const result=await finish(service,service.start('owner',{id:preview.id,revision:preview.revision}).id);
  assert.equal(result.status,'passed',JSON.stringify(result));assert.ok(result.tests>0);
});

test('expired reviews, output flooding and stop never fabricate a pass',async t=>{
  const f=await fixture(t,success);await f.service.stop();let now=Date.now();
  const service=createProjectValidation({root:f.root,planPath:f.planPath,now:()=>now});t.after(()=>service.stop());
  const p=service.preview('owner','contracts');now+=300001;
  assert.throws(()=>service.start('owner',{id:p.id,revision:p.revision}),{code:'ToubaValidationReviewMissing'});
  const flooding=await fixture(t,'setInterval(()=>process.stdout.write("x".repeat(4096)),1)',{timeout_ms:3000});
  const fp=flooding.service.preview('owner','contracts');
  const flooded=await finish(flooding.service,flooding.service.start('owner',{id:fp.id,revision:fp.revision}).id);
  assert.notEqual(flooded.status,'passed');assert.ok(flooded.output.length<=4096);
  const waiting=await fixture(t,'setInterval(()=>{},1000)',{timeout_ms:3000});
  const wp=waiting.service.preview('owner','contracts'), run=waiting.service.start('owner',{id:wp.id,revision:wp.revision});
  await delay(100);await waiting.service.stop();assert.equal(waiting.service.receipt(run.id).status,'interrupted');
});

test('changing reviewed inputs during a test invalidates the result',async t=>{
  const f=await fixture(t,'import test from "node:test";import {setTimeout} from "node:timers/promises";test("wait",()=>setTimeout(500));');
  const p=f.service.preview('owner','contracts'),run=f.service.start('owner',{id:p.id,revision:p.revision});
  await delay(200);writeFileSync(join(f.root,f.file),'// changed');
  assert.equal((await finish(f.service,run.id)).status,'stale');
});

test('handler evidence needs explicit coverage, pinned source and a current successful revision',async t=>{
  const f=await fixture(t);await f.service.stop();
  const source=join(f.root,'src/qa/validation.tb');
  writeFileSync(source,readFileSync(source,'utf8')+'\ntool Read\n    gives Text\n');
  mkdirSync(join(f.root,'handlers'),{recursive:true});
  const handler='export function read() {return "ok";}';
  writeFileSync(join(f.root,'handlers/read.mjs'),handler);
  const testSource='import test from "node:test";import assert from "node:assert/strict";import {read} from "../handlers/read.mjs";test("read contract",()=>assert.equal(read(),"ok"));';
  writeFileSync(join(f.root,f.file),testSource);
  writeFileSync(join(f.root,'touba.manifest.json'),JSON.stringify({manifest_version:'touba-manifest-v1',bindings:{'tool:qa.validation/Read':{grants:[],effect_contract:{kind:'none'},handler:{kind:'process',command:'node',args:['handlers/read.mjs'],cwd:'.'}}}}));
  const prepared=await prepareProject({root:f.root,mode:'write',manifestPath:'touba.manifest.json'});assert.equal(prepared.status,'success',JSON.stringify(prepared));
  writeFileSync(f.planPath,JSON.stringify({schema_version:'touba-validation-plan-v1',suites:[{...f.suite,tool_refs:['tool:qa.validation/Read'],inputs:{[f.file]:hash(testSource),'handlers/read.mjs':hash(handler)}}]}));
  const service=createProjectValidation({root:f.root,planPath:f.planPath});t.after(()=>service.stop());
  assert.equal(service.handlerEvidence().get('tool:qa.validation/Read')?.status,'missing');
  const p=service.preview('owner','contracts');await finish(service,service.start('owner',{id:p.id,revision:p.revision}).id);
  assert.equal(service.handlerEvidence().get('tool:qa.validation/Read')?.status,'passed');
  writeFileSync(join(f.root,'handlers/read.mjs'),handler+'\n// changed');
  assert.equal(service.handlerEvidence().get('tool:qa.validation/Read')?.status,'missing');
});

test('HTTP exposes reviewed fixed suites only and checks authenticated permission mappings',async t=>{
  const f=await fixture(t);await f.service.stop();
  process.env.TOUBA_QA_VALIDATION_AUTH='isolated-validation-token';t.after(()=>delete process.env.TOUBA_QA_VALIDATION_AUTH);
  const server=createToubaProjectServer({projectRoot:f.root,validationPlanPath:f.planPath,authTokenEnv:'TOUBA_QA_VALIDATION_AUTH',port:0,quiet:true});
  await server.start();t.after(()=>server.stop());const base=`http://127.0.0.1:${server.server.address().port}`;
  assert.equal(requiredIdentityPermission('GET','/validation'),'executions.read');
  assert.equal(requiredIdentityPermission('POST','/validation/preview'),'governance.apply');
  assert.equal(requiredIdentityPermission('POST','/validation/runs'),'governance.apply');
  assert.equal((await fetch(base+'/validation')).status,401);
  const headers={authorization:'Bearer isolated-validation-token','content-type':'application/json'};
  const initial=await(await fetch(base+'/validation',{headers})).json();assert.equal(initial.enabled,true);
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post('/validation/preview',{suite_id:'contracts',command:'anything'})).status,400);
  const response=await post('/validation/preview',{suite_id:'contracts'});assert.equal(response.status,200,await response.clone().text());
  const preview=await response.json(),started=await post('/validation/runs',{id:preview.id,revision:preview.revision});
  assert.equal(started.status,200,await started.clone().text());
  let status;
  for(let i=0;i<100;i++){status=await(await fetch(base+'/validation',{headers})).json();if(status.runs[0]?.status!=='running')break;await delay(50);}
  assert.equal(status.runs[0].status,'passed',JSON.stringify(status));
});
test('empty files cannot be reported as passed; failures and timeouts are distinct',async t=>{
  for(const [source,expected] of [['','no_tests'],[success.replace('2+2,4','2+2,5'),'failed'],['setInterval(()=>{},1000);','interrupted']]) {
    const f=await fixture(t,source,{timeout_ms:expected==='interrupted'?1000:3000}), p=f.service.preview('user:owner','contracts');
    const row=f.service.start('user:owner',{id:p.id,revision:p.revision});
    assert.equal((await finish(f.service,row.id)).status,expected);
  }
});
test('environment is minimal, explicit values are redacted, and changed project invalidates results',async t=>{
  process.env.TOUBA_VALIDATION_PRIVATE_TEST='private-fixture-value';
  process.env.TOUBA_VALIDATION_ALLOWED_TEST='allowed-fixture-value';
  t.after(()=>{delete process.env.TOUBA_VALIDATION_PRIVATE_TEST; delete process.env.TOUBA_VALIDATION_ALLOWED_TEST;});
  const source='import test from "node:test"; import assert from "node:assert/strict"; test("environment",()=>{assert.equal(process.env.TOUBA_VALIDATION_PRIVATE_TEST,undefined); console.log(process.env.TOUBA_VALIDATION_ALLOWED_TEST);});';
  const f=await fixture(t,source,{env:['TOUBA_VALIDATION_ALLOWED_TEST']}), p=f.service.preview('user:owner','contracts');
  const row=f.service.start('user:owner',{id:p.id,revision:p.revision});
  const result=await finish(f.service,row.id); assert.equal(result.status,'passed');
  assert.ok(result.output.includes('[REDACTED]')); assert.ok(!result.output.includes('allowed-fixture-value'));
});
test('Python unittest uses its actual assertions and an explicitly pinned interpreter',async t=>{
  const command=execFileSync('python3',['-I','-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
  const source='import unittest\nclass Contracts(unittest.TestCase):\n    def test_sum(self):\n        self.assertEqual(2+2,4)\n';
  const f=await fixture(t,source,{engine:'python',python:{command,digest:hash(readFileSync(command))}});
  const p=f.service.preview('user:owner','contracts'), row=f.service.start('user:owner',{id:p.id,revision:p.revision});
  const result=await finish(f.service,row.id); assert.equal(result.status,'passed',JSON.stringify(result)); assert.equal(result.tests,1);
});
test('abandoned running receipts become interrupted without replay',async t=>{
  const f=await fixture(t), p=f.service.preview('user:owner','contracts');
  const row=f.service.start('user:owner',{id:p.id,revision:p.revision});
  await finish(f.service,row.id); await f.service.stop();
  const store=validationStore(join(f.root,'.touba/project-validation.sqlite'));
  const saved=store.read([{id:row.id}]); saved[0].status='running'; store.write(saved);
  const restarted=createProjectValidation({root:f.root,planPath:f.planPath});
  t.after(()=>restarted.stop());
  assert.equal(restarted.receipt(row.id).status,'interrupted');
  assert.equal(restarted.receipt(row.id).reason,'server_restarted');
});
