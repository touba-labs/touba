import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectHandlerImplementation } from '../src/handler-implementation.mjs';
import { generateHandlerStubFromAirTool } from '../../touba-manifest/src/stub.mjs';
test('only exact canonical templates are stubs; presence is not a successful test',t=>{
  const root=mkdtempSync(join(tmpdir(),'touba-handler-presence-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const [language,file] of [['javascript','handler.mjs'],['python','handler.py']]) {
    const handler={kind:'process',command:language==='python'?'python3':'node',args:[file]};
    writeFileSync(join(root,file),generateHandlerStubFromAirTool({id:'tool:qa/Read',required_capabilities:[],required_secrets:[],signature:{inputs:[],output_type:'Text'}},{language}));
    assert.equal(inspectHandlerImplementation(root,handler).implementation_status,'stub');
    writeFileSync(join(root,file),language==='python'?'print("present")':'throw new Error("never execute for inspection");');
    assert.equal(inspectHandlerImplementation(root,handler).implementation_status,'present');
    assert.equal(inspectHandlerImplementation(root,handler).candidate_path,file);
  }
  assert.equal(inspectHandlerImplementation(root,{kind:'process',command:'node',args:['-e','anything']}).implementation_status,'unknown');
  symlinkSync('/etc/passwd',join(root,'outside.py'));
  assert.equal(inspectHandlerImplementation(root,{kind:'process',command:'python3',args:['outside.py']}).implementation_status,'unknown');
});

test('Python module handlers resolve local source without executing it', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-module-presence-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  mkdirSync(join(root,'app/handlers'), {recursive:true});
  writeFileSync(join(root,'app/handlers/pay.py'), 'raise RuntimeError("inspection must never execute this")');
  const handler = {kind:'process',command:'python3',cwd:'app',args:['-B','-m','handlers.pay']};
  assert.deepEqual(inspectHandlerImplementation(root,handler), {implementation_status:'present',candidate_path:'app/handlers/pay.py'});
  for (const args of [['-m','missing'], ['-c','anything','-m','handlers.pay'], ['-m','../escape']]) {
    assert.equal(inspectHandlerImplementation(root,{...handler,args}).implementation_status,'unknown');
  }
  assert.equal(inspectHandlerImplementation(root,{...handler,command:'node'}).implementation_status,'unknown');
  symlinkSync('/etc/passwd',join(root,'app/handlers/outside.py'));
  assert.equal(inspectHandlerImplementation(root,{...handler,args:['-m','handlers.outside']}).implementation_status,'unknown');
});

test('prepared manifest cwd is relative to the manifest for files and Python modules', t => {
  const root=mkdtempSync(join(tmpdir(),'touba-prepared-presence-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'.touba/build/dev'),{recursive:true});
  mkdirSync(join(root,'handlers'),{recursive:true});
  const manifestPath=join(root,'.touba/build/dev/touba.manifest.json');
  const tool={id:'tool:qa/Read',required_capabilities:[],required_secrets:[],signature:{inputs:[],output_type:'Text'}};
  for(const [language,file,command] of [['python','read.py','python3'],['javascript','read.mjs','node']]) {
    writeFileSync(join(root,'handlers',file),generateHandlerStubFromAirTool(tool,{language}));
    const handler={kind:'process',command,args:['handlers/'+file],cwd:'../../..'};
    assert.equal(inspectHandlerImplementation(root,handler,{manifestPath}).implementation_status,'stub');
    if(language==='python') {
      handler.args=['-B','-m','handlers.read'];
      assert.equal(inspectHandlerImplementation(root,handler,{manifestPath}).implementation_status,'stub');
      writeFileSync(join(root,'handlers',file),'raise RuntimeError("never execute during inspection")');
      assert.deepEqual(inspectHandlerImplementation(root,handler,{manifestPath}),{implementation_status:'present',candidate_path:'handlers/read.py'});
    }
  }
  symlinkSync('/etc/passwd',join(root,'handlers/outside.py'));
  assert.equal(inspectHandlerImplementation(root,{kind:'process',command:'python3',args:['-m','handlers.outside'],cwd:'../../..'},{manifestPath}).implementation_status,'unknown');
});
