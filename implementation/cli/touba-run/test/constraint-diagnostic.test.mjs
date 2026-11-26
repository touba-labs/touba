import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileTestAir} from '../../../tests/helpers/compile.mjs';
import {executeRunCommand} from '../src/command.mjs';

test('CLI names value constraints without presenting string representation as a type mismatch', async t => {
  const root=mkdtempSync(join(tmpdir(),'touba-constraint-diagnostic-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source.tb');writeFileSync(source,'module diagnostic\ntype Request\n    code is Text format "digits"\nfunction Read\n    takes request as Request\n    gives Text\n    do\n        give request.code\n');
  const air=join(root,'program.air.json');writeFileSync(air,JSON.stringify(compileTestAir(source)));
  for(const [value,constraint] of [['private-value',true],[123,false]]){
    let stderr='';const sink=new Writable({write(chunk,encoding,done){stderr+=chunk.toString();done();}});
    const code=await executeRunCommand([air,'--entry','function:diagnostic/Read','--inputs-json',JSON.stringify({request:{code:value}})],{stderr:sink,stdout:new Writable({write(chunk,encoding,done){done();}})});
    assert.notEqual(code,0);
    assert.doesNotMatch(stderr,/private-value/);
    if(constraint){assert.match(stderr,/field constraint format requires "digits"/);assert.doesNotMatch(stderr,/expected type:|actual type:/);}
    else {assert.match(stderr,/expected type: builtin:Text/);assert.match(stderr,/actual type: integer/);}
  }
});
