import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject, prepareProject } from '../../touba-project/src/project.mjs';
import { createIntegrationImport, planIntegrationImport } from '../src/integration-import.mjs';
import { compileProposedSources } from '../src/source-validation.mjs';
import { createToubaProjectServer, requiredIdentityPermission } from '../src/serve.mjs';
import { assertApplicationRoute } from '../src/application-access.mjs';
import { projectActivityKind } from '../src/project-activity.mjs';
import { validateObject } from '../../../contracts/product-surfaces/validate.mjs';
import previewSchema from '../../../contracts/product-surfaces/schemas/touba-integration-import-preview-v1.schema.json' with { type: 'json' };
import resultSchema from '../../../contracts/product-surfaces/schemas/touba-integration-import-result-v1.schema.json' with { type: 'json' };
const schema = { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } }, required: ['name'] };
const openapi = { openapi: '3.0.0', paths: Object.fromEntries(['lookup', 'create'].map(id => ['/'+id, { post: {
  operationId: id, requestBody: { content: { 'application/json': { schema } } }, responses: { '200': { content: { 'application/json': { schema } } } },
} }])) };
const input = kind => ({kind, name:'demo', document:kind==='mcp'?{tools:[{name:'lookup',inputSchema:schema,outputSchema:schema}]}:openapi,
  selected:kind==='mcp'?['lookup']:['lookup','create'],base_url:kind==='mcp'?'':'https://example.invalid',secret_handles:[],authorize_grants:false});
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'touba-import-review-'))); initProject({root,language:'python'});
  t.after(()=>rmSync(root,{recursive:true,force:true}));return root;
}
for(const kind of ['mcp','openapi']) test(`${kind} import is preview-only, consent-bound, scoped, expiring and single-use`,t=>{
  const root=fixture(t);let now=0,written=0;
  const importer=createIntegrationImport(root,{now:()=>now,validate:files=>compileProposedSources({projectRoot:root,targets:files}).diagnostics,
    apply:args=>{written++;assert.match(args.review_actor,/^sha256:/);return {transaction_id:'synthetic'};}});
  const request=input(kind),first=importer.preview('alice',request);
  assert.deepEqual(validateObject(previewSchema,first),[]);assert.equal(first.can_apply,false);assert.equal(written,0);
  assert.equal(existsSync(join(root,'src/integrations')),false);assert.equal(first.runtime.language,'javascript');assert.equal(first.runtime.sdk,'unavailable');
  const next=importer.preview('alice',{...request,authorize_grants:true});assert.equal(next.can_apply,true);
  assert.throws(()=>importer.apply('bob',{...next,reason:'review'}),{code:'ToubaServeImportInvalid'});
  const apply={id:next.id,review_digest:next.review_digest,reason:'Synthetic review'};
  assert.throws(()=>importer.apply('bob',apply),{code:'ToubaServeImportReviewMissing'});
  const result=importer.apply('alice',apply);assert.deepEqual(validateObject(resultSchema,result),[]);assert.equal(written,1);
  assert.throws(()=>importer.apply('alice',apply),{code:'ToubaServeImportReviewMissing'});
  const expired=importer.preview('alice',{...request,authorize_grants:true});now=300001;
  assert.throws(()=>importer.apply('alice',{id:expired.id,review_digest:expired.review_digest,reason:'review'}),{code:'ToubaServeImportReviewMissing'});
});
test('import review refuses changed project configuration, existing files and symbolic paths',t=>{
  const root=fixture(t),request={...input('openapi'),authorize_grants:true};
  const importer=createIntegrationImport(root,{validate:()=>[],apply:()=>assert.fail('must not write')});
  const preview=importer.preview('alice',request);
  const path=join(root,'touba.project.json'),project=JSON.parse(readFileSync(path));project.name='changed';writeFileSync(path,JSON.stringify(project));
  assert.throws(()=>importer.apply('alice',{id:preview.id,review_digest:preview.review_digest,reason:'review'}),{code:'ToubaServeImportStale'});
  const plan=planIntegrationImport(root,request),first=plan.files[0];mkdirSync(dirname(join(root,first.path)),{recursive:true});writeFileSync(join(root,first.path),first.content);
  assert.throws(()=>planIntegrationImport(root,request),{code:'ToubaServeImportExists'});
});
test('import only accepts bounded data and explicit destinations, never remote discovery commands',t=>{
  const root=fixture(t),request=input('openapi');
  for(const patch of [{name:'../escape'},{command:'sh'},{base_url:'http://127.0.0.1'},{base_url:'https://user:secret@example.com'},{secret_handles:['token=value']},{selected:[]},{selected:Array(25).fill('lookup')},{timeout_ms:0},{max_payload_bytes:2000000}]) {
    assert.throws(()=>planIntegrationImport(root,{...request,...patch}),{code:'ToubaServeImportInvalid'});
  }
  mkdirSync(join(root,'integrations'),{recursive:true});symlinkSync(root,join(root,'integrations/demo'));
  assert.throws(()=>planIntegrationImport(root,request),/symbolic/);
});
test('imports keep governance permissions, execution exclusion and application denial',()=>{
  for(const action of ['preview','apply']) {
    const path='/integrations/import/'+action;
    assert.equal(requiredIdentityPermission('POST',path),action==='apply'?'governance.apply':'governance.propose');
    assert.equal(projectActivityKind('POST',path),action==='apply'?'mutation':null);
    assert.throws(()=>assertApplicationRoute({principal:{kind:'service',id:'synthetic'}},'POST',path,()=>null),{code:'ToubaServeApplicationPermissionDenied'});
  }
  assert.equal(requiredIdentityPermission('GET','/integrations/mcp/targets'),'governance.propose');
  assert.equal(requiredIdentityPermission('POST','/integrations/mcp/discover'),'governance.apply');
  assert.equal(projectActivityKind('POST','/integrations/mcp/discover'),'mutation');
  assert.throws(()=>assertApplicationRoute({principal:{kind:'service',id:'synthetic'}},'POST','/integrations/mcp/discover',()=>null),{code:'ToubaServeApplicationPermissionDenied'});
});
test('HTTP import uses a recoverable transaction, preserves existing configuration and prepares in one write',async t=>{
  const root=fixture(t);process.env.TOUBA_IMPORT_QA='import-synthetic';t.after(()=>delete process.env.TOUBA_IMPORT_QA);
  mkdirSync(join(root,'src/app'),{recursive:true});writeFileSync(join(root,'src/app/main.tb'),'module app.main\nfunction Ready\n    gives Text\n    do\n        give "ready"\n');
  const initial=JSON.parse(readFileSync(join(root,'touba.project.json')));initial.entry='function:app.main/Ready';writeFileSync(join(root,'touba.project.json'),JSON.stringify(initial));
  const service=createToubaProjectServer({projectRoot:root,port:0,quiet:true,authTokenEnv:'TOUBA_IMPORT_QA'});
  await service.start();t.after(()=>service.stop());
  const url=`http://127.0.0.1:${service.server.address().port}`,headers={'content-type':'application/json',authorization:'Bearer import-synthetic'};
  const send=(route,body,auth=true)=>fetch(url+route,{method:'POST',headers:auth?headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(url+'/integrations/mcp/targets')).status,401);
  const targets=await fetch(url+'/integrations/mcp/targets',{headers});
  assert.deepEqual((await targets.json()).items,[]);
  assert.equal((await send('/integrations/mcp/discover',{target:'unknown'})).status,400);
  assert.equal((await send('/integrations/mcp/discover',{target:'unknown',confirm_process:true})).status,404);
  assert.equal((await send('/integrations/import/preview',input('openapi'),false)).status,401);
  const response=await send('/integrations/import/preview',{...input('openapi'),authorize_grants:true});
  const preview=await response.json();assert.equal(response.status,200,JSON.stringify(preview));assert.equal(preview.can_apply,true,JSON.stringify(preview));
  const applied=await send('/integrations/import/apply',{id:preview.id,review_digest:preview.review_digest,reason:'Synthetic import qualification'});
  const result=await applied.json();assert.equal(applied.status,200,JSON.stringify(result));assert.deepEqual(validateObject(resultSchema,result),[]);
  const journal=JSON.parse(readFileSync(join(root,'.touba/change-transactions',result.transaction_id,'journal.json')));
  assert.equal(journal.status,'committed');assert.equal(journal.reason,'Synthetic import qualification');assert.match(journal.review_actor,/^sha256:/);
  await service.stop();
  for(const mode of ['plan','write','check']) {
    const prepared=await prepareProject({root,mode});assert.notEqual(prepared.status,'error',JSON.stringify(prepared.diagnostics));
    if(mode!=='plan')assert.equal(prepared.status,'success',JSON.stringify({mode,diagnostics:prepared.diagnostics,actions:prepared.actions}));
  }
  const config=JSON.parse(readFileSync(join(root,'touba.project.json')));assert.ok(config.configuration.binding_fragments.includes('integrations/demo/touba.manifest.fragment.json'));
  assert.equal(existsSync(join(root,'payment.log')),false);
});
