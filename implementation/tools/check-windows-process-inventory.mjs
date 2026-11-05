import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {activeProcesses} from '../cli/touba-project/src/update/platform.mjs';

// Read-only native diagnostic. Never log process command lines, paths or env.
assert.equal(process.platform,'win32');
assert.equal(process.env.GITHUB_ACTIONS,'true');
const samples=[];
for(const timeout of [10000,30000]) {
  let sample={timeout_ms:timeout};
  try {
    const active=activeProcesses(process.cwd(),(command,args,options)=>{
      const start=performance.now();
      const result=spawnSync(command,args,{...options,timeout});
      sample={...sample,elapsed_ms:Math.round(performance.now()-start),status:result.status,
        signal:result.signal,error_code:result.error?.code??null,
        stdout_bytes:Buffer.byteLength(result.stdout??''),stderr_bytes:Buffer.byteLength(result.stderr??'')};
      return result;
    });
    sample.accepted=true;sample.matching_processes=active.length;
  } catch(error) {sample.accepted=false;sample.refusal_code=error.code??error.name;}
  samples.push(sample);
}
console.log(JSON.stringify({diagnostic:'windows-process-inventory',samples},null,2));
assert.ok(samples.some(sample=>sample.accepted),'Neither bounded inventory succeeded');
