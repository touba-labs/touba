import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,symlinkSync } from 'node:fs';
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
