// Child of an explicitly authorized validation operation. No shell involved.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const suite=JSON.parse(Buffer.concat(chunks).toString('utf8'));
let result, tests=0, passed=0;
if (suite.engine === 'package') {
  const { testPackage } = await import('../../touba-project/src/package-author.mjs');
  result=await testPackage(dirname(resolve(suite.tests[0])), {env:suite.env,timeout:suite.timeout_ms});
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  tests=result.tests ?? 0; passed=result.status === 'success' ? tests : 0;
  process.exitCode=result.exitCode;
} else if (suite.engine === 'node') {
  result=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-timeout='+Math.min(30000,suite.timeout_ms),...suite.tests],
    {env:process.env,encoding:'utf8',timeout:suite.timeout_ms,maxBuffer:65536,killSignal:'SIGKILL'});
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  const explicit=[...(result.stdout ?? '').matchAll(/^# Subtest: (.+)$/gm)].some(match => !suite.tests.some(path => resolve(path) === resolve(match[1])));
  tests=explicit ? Number(/^# tests (\d+)$/m.exec(result.stdout ?? '')?.[1] ?? 0) : 0;
  passed=explicit ? Number(/^# pass (\d+)$/m.exec(result.stdout ?? '')?.[1] ?? 0) : 0;
  process.exitCode=result.error || result.signal || result.status !== 0 ? 1 : 0;
} else {
  result=spawnSync(suite.python.command,['-I','-B',fileURLToPath(new URL('./project-validation-python.py',import.meta.url)),...suite.tests],
    {env:process.env,encoding:'utf8',timeout:suite.timeout_ms,maxBuffer:65536,killSignal:'SIGKILL'});
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  const summary=[...String(result.stdout ?? '').matchAll(/^# TOUBA_VALIDATION tests=(\d+) passed=(\d+)$/gm)].at(-1);
  tests=Number(summary?.[1] ?? 0); passed=Number(summary?.[2] ?? 0);
  process.exitCode=result.error || result.signal || result.status !== 0 ? 1 : 0;
}
process.stdout.write(`\n# TOUBA_VALIDATION tests=${tests} passed=${passed}\n`);
