import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildHandlerSandboxPlan, runProcessToolHandler } from '../src/handler-protocol.mjs';
import { handlerIsolationIdentity, sameHandlerIsolationIdentity, validHandlerIsolationObservation } from '../src/handler-isolation-evidence.mjs';
import { createSqliteTraceStore } from '../src/sqlite-trace-store.mjs';
import { TraceBuilder } from '../src/trace-builder.mjs';
import { projectHandlerIsolation } from '../../../cli/touba-project-server/src/handler-isolation-status.mjs';

const air = { module: { id: 'module:probe' } };
const toolRef = 'tool:probe/Read';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-isolation-evidence-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'handler.mjs');
  writeFileSync(file, 'process.stdout.write(JSON.stringify({ok:true,value:7}));');
  const binding = { handler: { command: process.execPath, args: [file], cwd: root },
    sandbox: { required: true }, grants: [], secrets: [], limits: { timeout_ms: 5000, max_payload_bytes: 65536 } };
  return { root, file, binding };
}

test('selected code, policy, host and binding identities invalidate historical observations', { skip: process.platform !== 'darwin' }, t => {
  const { binding, file } = fixture(t);
  const identity = () => handlerIsolationIdentity(binding, buildHandlerSandboxPlan({ binding }));
  const original = identity(); assert.ok(original);
  const observation = { ...original, protocol_observed: true, outcome: 'completed' };
  assert.equal(validHandlerIsolationObservation(observation), true);
  assert.ok(sameHandlerIsolationIdentity(observation, identity()));
  assert.equal(JSON.stringify(observation).includes(file), false);
  assert.equal(validHandlerIsolationObservation({ ...observation, secret: 'value' }), false);
  const before = statSync(file);
  writeFileSync(file, 'process.stdout.write(JSON.stringify({ok:true,value:9}));');
  utimesSync(file, before.atime, before.mtime);
  assert.equal(sameHandlerIsolationIdentity(observation, identity()), false, 'restoring mtime must not reuse cached contents');
  writeFileSync(file, 'process.stdout.write(JSON.stringify({ok:true,value:7}));');
  assert.ok(sameHandlerIsolationIdentity(observation, identity()));
  binding.grants = ['network'];
  assert.equal(sameHandlerIsolationIdentity(observation, identity()), false);
  binding.grants = []; binding.limits.timeout_ms++;
  assert.equal(sameHandlerIsolationIdentity(observation, identity()), false);
  assert.equal(sameHandlerIsolationIdentity({ ...observation, host_digest: '0'.repeat(64) }, original), false);
  assert.equal(handlerIsolationIdentity(binding, { ...buildHandlerSandboxPlan({ binding }), command: process.execPath }), null,
    'a configurable replacement for the OS launcher is not evidence');
  binding.sandbox.required = false;
  assert.equal(handlerIsolationIdentity(binding, buildHandlerSandboxPlan({ binding })), null);
});

test('real confined execution persists across restart, distinguishes failed results and expires with code changes', { skip: process.platform !== 'darwin' }, async t => {
  const { root, file, binding } = fixture(t);
  const filename = join(root, 'trace.sqlite');
  let store = createSqliteTraceStore({ filename });
  t.after(() => store.close());
  let counter = 0;
  const run = async () => {
    const trace = new TraceBuilder(air, toolRef, `run-${++counter}`, null, 0, 'full', store);
    let observation;
    try {
      return await runProcessToolHandler({ toolRef, binding, secretHandles: [], request: { arguments: {} },
        onIsolationObservation: value => { observation = value; } });
    } finally {
      trace.push('tool_execution_status', { payload: { tool_ref: toolRef, handler_isolation: observation } });
      trace.push('run_completed', { payload: { status: 'success', reason: 'completed' } });
    }
  };
  assert.equal(projectHandlerIsolation(binding, toolRef, store).state, 'not_observed');
  assert.equal((await run()).value, 7);
  const record = store.handlerIsolation(toolRef);
  assert.ok(validHandlerIsolationObservation(record.observation));
  store.close(); store = createSqliteTraceStore({ filename });
  assert.equal(projectHandlerIsolation(binding, toolRef, store).state, 'observed');
  assert.equal(projectHandlerIsolation(binding, toolRef, store).outcome, 'completed');
  writeFileSync(file, 'process.stdout.write(JSON.stringify({ok:false,error:{code:"SyntheticRefusal",message:"refused"}}));');
  assert.equal(projectHandlerIsolation(binding, toolRef, store).state, 'stale');
  await assert.rejects(run());
  assert.equal(projectHandlerIsolation(binding, toolRef, store).state, 'observed', 'confinement and business outcome are distinct');
  assert.equal(projectHandlerIsolation(binding, toolRef, store).outcome, 'failed');
  writeFileSync(file, 'process.exit(3);');
  await assert.rejects(run(), { code: 'ToolHandlerNonZeroExit' });
  assert.equal(projectHandlerIsolation(binding, toolRef, store).state, 'incomplete');
  assert.equal(projectHandlerIsolation(binding, toolRef, store).outcome, 'failed');
  assert.equal(projectHandlerIsolation(binding, toolRef, { handlerIsolation: () => ({ ...record, observation: {} }) }).state, 'unavailable');
  const archive = join(root, 'archive.sqlite');
  assert.equal(store.archive({ destination: archive, apply: true }).segments, 3);
  assert.equal(projectHandlerIsolation(binding, toolRef, store).state, 'not_observed');
  const archived = createSqliteTraceStore({ filename: archive, readOnly: true });
  try { assert.equal(archived.handlerIsolation(toolRef).observation.outcome, 'failed'); }
  finally { archived.close(); }
});

test('an observation callback failure never changes a successful handler result', { skip: process.platform !== 'darwin' }, async t => {
  const { binding } = fixture(t);
  const result = await runProcessToolHandler({ toolRef, binding, secretHandles: [], request: { arguments: {} },
    onIsolationObservation: () => { throw new Error('synthetic observer failure'); } });
  assert.equal(result.value, 7);
});
