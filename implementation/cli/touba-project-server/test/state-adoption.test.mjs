import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { adoptProjectState, recoverStateAdoption } from '../src/state-adoption.mjs';
import { checkToubaProjectState } from '../src/serve.mjs';
import { acquireStateLease } from '../src/state-maintenance.mjs';
import { currentStateBuild, inspectStateOrigin, validateStateOrigin } from '../src/state-origin.mjs';
import { createInteractionSession, enqueueInteractionOperation } from '../src/interactions.mjs';
import { withNativeTrace, readNativeTraceExport } from '../src/native-traces.mjs';
import { indexedStore } from '../../../runtime/touba-runtime/src/sqlite-record-store.mjs';
import { createSqliteEffectJournal } from '../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs';
import { stateCommand } from '../../touba-project/src/state-command.mjs';
import { ToubaEngine } from '../../../runtime/touba-handler-sdk/src/index.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateObject } from '../../../contracts/product-surfaces/validate.mjs';
import adoptionSchema from '../../../contracts/product-surfaces/schemas/touba-state-adoption-v1.schema.json' with { type: 'json' };

function fixture(t) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'touba-state-adopt-test-'))), root = join(projectRoot, '.touba');
  t.after(() => rmSync(projectRoot, { recursive: true, force: true })); mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, 'state-origin.json'), JSON.stringify({ schema_version: 'touba-serve-state-origin-v1', project_root: projectRoot, build_id: 'a'.repeat(64) }));
  const sessionsPath = join(root, 'interaction-sessions.sqlite');
  const session = createInteractionSession({ sessionsPath, request: { target_ref: 'skill:demo/Run', target_kind: 'skill',
    presentation: 'conversation', effect_policy: 'runtime_only', requested_by: { kind: 'cli', id: 'isolated-test' } } });
  return { projectRoot, root, sessionsPath, session, options: { projectRoot, reason: 'Reviewed compatible update' } };
}
const adopt = options => adoptProjectState(options, checkToubaProjectState);
test('adoption previews without relabelling, copies exact state and records a separate origin transition', async t => {
  const f = fixture(t), trace = JSON.parse(readFileSync(new URL('../../../tests/traces/tb-v01-003-branch.trace.json', import.meta.url)));
  await withNativeTrace({ projectRoot: f.projectRoot, runId: trace.run.run_id, phase: 'initial' }, async () => ({ status: 'success', trace }));
  const originalTrace = readNativeTraceExport(f.projectRoot, trace.run.run_id);
  const before = new Map(['interaction-sessions.sqlite', 'traces.sqlite', 'native-traces.sqlite', 'state-origin.json'].map(name => [name, readFileSync(join(f.root, name))]));
  const preview = adopt(f.options);
  assert.deepEqual(validateObject(adoptionSchema, preview), []);
  assert.equal(preview.status, 'preview'); assert.equal(inspectStateOrigin(f.projectRoot).status, 'different_build');
  assert.equal(existsSync(join(f.root, 'state-adoptions')), false);
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(f.root, name)), bytes);
  assert.throws(() => adopt({ ...f.options, accept: 'b'.repeat(64) }), { code: 'ToubaStateReviewStale' });
  const result = adopt({ ...f.options, accept: preview.review_digest });
  assert.deepEqual(validateObject(adoptionSchema, result), []);
  assert.equal(result.status, 'adopted'); assert.equal(inspectStateOrigin(f.projectRoot).status, 'matching');
  const origin = JSON.parse(readFileSync(join(f.root, 'state-origin.json')));
  assert.equal(origin.initial_build_id, 'a'.repeat(64)); assert.equal(origin.build_id, currentStateBuild());
  assert.equal(origin.transitions.length, 1); assert.equal(origin.transitions[0].review_digest, preview.review_digest);
  for (const [name, bytes] of before) {
    assert.deepEqual(readFileSync(join(f.root, 'state-adoptions', result.backup_id, 'files', name)), bytes);
    if (name !== 'state-origin.json') assert.deepEqual(readFileSync(join(f.root, name)), bytes);
  }
  assert.deepEqual(readNativeTraceExport(f.projectRoot, trace.run.run_id), originalTrace);
  assert.equal(checkToubaProjectState({ projectRoot: f.projectRoot }).status, 'structurally_valid');
  assert.throws(() => adopt(f.options), { code: 'ToubaStateAdoptionOriginRequired' });
  origin.transitions[0].from_build_id = 'b'.repeat(64);
  assert.throws(() => validateStateOrigin(origin, f.projectRoot), { code: 'ToubaServeStateOriginInvalid' });
});
test('review binds bytes, source and target builds, reason, and capacity', t => {
  const f = fixture(t), preview = adopt(f.options);
  assert.throws(() => adopt({ ...f.options, reason: 'Another reason', accept: preview.review_digest }), { code: 'ToubaStateReviewStale' });
  writeFileSync(join(f.root, 'project-events.jsonl'), '\n');
  assert.throws(() => adopt({ ...f.options, accept: preview.review_digest }), { code: 'ToubaStateReviewStale' });
  assert.throws(() => adopt({ ...f.options, maxBackupBytes: 1 }), { code: 'ToubaStateAdoptionCapacityExceeded' });
  assert.throws(() => adopt({ ...f.options, reason: 'two\nlines' }), { code: 'ToubaStateRecoveryReasonRequired' });
  assert.throws(() => adopt({ ...f.options, effectJournalPath: '/elsewhere' }), { code: 'ToubaStateOptionsInvalid' });
  rmSync(join(f.root, 'state-origin.json'));
  assert.throws(() => adopt(f.options), { code: 'ToubaStateAdoptionOriginRequired' });
});
test('project evidence is backed up byte-for-byte and remains bound to the review', t => {
  const f = fixture(t), path = join(f.root, 'evidence', 'review', 'record.json');
  mkdirSync(join(f.root, 'state'));
  const secrets = Buffer.from('{"fixture":"synthetic-not-a-real-secret"}\n');
  writeFileSync(join(f.root, 'state', 'secrets.local.json'), secrets);
  mkdirSync(join(f.root, 'evidence', 'review'), { recursive: true });
  writeFileSync(path, '{"review":"preserved"}\n');
  const before = readFileSync(path), preview = adopt(f.options);
  assert.ok(preview.files.some(row => row.path === 'evidence/review/record.json'));
  assert.equal(JSON.stringify(preview).includes('synthetic-not-a-real-secret'), false);
  writeFileSync(path, '{"review":"changed"}\n');
  assert.throws(() => adopt({ ...f.options, accept: preview.review_digest }), { code: 'ToubaStateReviewStale' });
  writeFileSync(path, before);
  const result = adopt({ ...f.options, accept: preview.review_digest });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readFileSync(join(f.root, 'state-adoptions', result.backup_id, 'files/evidence/review/record.json')), before);
  const secretBackup = join(f.root, 'state-adoptions', result.backup_id, 'files/state/secrets.local.json');
  assert.deepEqual(readFileSync(secretBackup), secrets);
  if (process.platform !== 'win32') assert.equal(fs.statSync(secretBackup).mode & 0o777, 0o600);
  const other = fixture(t);
  mkdirSync(join(other.root, 'evidence'));
  symlinkSync(path, join(other.root, 'evidence', 'linked.json'));
  assert.throws(() => adopt(other.options), { code: 'ToubaStatePathInvalid' });
  const custom = fixture(t);
  mkdirSync(join(custom.root, 'state'));
  writeFileSync(join(custom.root, 'state', 'unknown.json'), '{}');
  assert.throws(() => adopt(custom.options), { code: 'ToubaStateAdoptionStoreUnsupported' });
});
test('adoption refuses live server ownership, database writers, unknown stores and links', t => {
  const f = fixture(t), release = acquireStateLease(f.projectRoot);
  assert.throws(() => adopt(f.options), { code: 'ToubaStateInUse' }); release();
  const db = new DatabaseSync(f.sessionsPath); db.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => adopt(f.options), { code: 'ToubaStateInUse' }); } finally { db.exec('ROLLBACK'); db.close(); }
  writeFileSync(join(f.root, 'unknown.sqlite'), 'unknown');
  assert.throws(() => adopt(f.options), { code: 'ToubaStateAdoptionStoreUnsupported', store: 'unknown.sqlite' }); rmSync(join(f.root, 'unknown.sqlite'));
  symlinkSync(f.sessionsPath, join(f.root, 'traces.sqlite'));
  assert.throws(() => adopt(f.options), { code: 'ToubaStatePathInvalid' }); rmSync(join(f.root, 'traces.sqlite'));
  const mutate = new DatabaseSync(f.sessionsPath); mutate.exec('CREATE TABLE future_format (id INTEGER)'); mutate.close();
  assert.throws(() => adopt(f.options), { code: 'ToubaStateAdoptionStoreUnsupported' });
});
test('queued operations and outstanding custody refuse adoption even without a live process', t => {
  const f = fixture(t);
  enqueueInteractionOperation({ sessionsPath: f.sessionsPath, sessionId: f.session.session_id, runId: 'pending',
    message: { message_id: 'message', display_text: 'go', attachments: [], requested_by: { kind: 'cli', id: 'test' } } });
  assert.throws(() => adopt(f.options), { code: 'ToubaStateNotQuiescent' });
  const other = fixture(t), path = join(other.root, 'approval-checkpoints.sqlite');
  const custody = indexedStore({ path, schemaVersion: 'touba-human-checkpoint-custody-v1', keyOf: row => row.id, validate() {} });
  const rows = custody.read(); rows.push({ id: 'waiting', generation: 1, state: 'ready', owner: 'test', digest: 'sha256:' + 'a'.repeat(64), owner_pid: process.pid, owner_host: 'fixture', recoverable: false }); custody.write(rows);
  assert.throws(() => adopt(other.options), { code: 'ToubaStateNotQuiescent' });
});
test('uncertain effects and retained trigger work refuse adoption without changing their records', t => {
  for (const state of ['prepared', 'dispatched', 'unknown']) {
    const f = fixture(t), path = join(f.root, 'project.effect-journal.sqlite');
    createSqliteEffectJournal(path).writeEntry({ effect_id: 'effect:sha256:' + 'a'.repeat(64),
      effect_scope_id: 'queue:one', air_digest: 'sha256:' + 'b'.repeat(64), entry_ref: 'trigger:test/Pay', effect_index: 1,
      request_digest: 'sha256:' + 'c'.repeat(64), tool_ref: 'tool:test/Pay', retry_mode: 'idempotency_key', state,
      attempt_count: state === 'prepared' ? 0 : 1, ...(state === 'prepared' ? {} : { last_call_id: 'call:one' }) });
    const before = readFileSync(path);
    assert.throws(() => adopt(f.options), { code: 'ToubaStateNotQuiescent' });
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(join(f.root, 'state-adoptions')), false);
  }
  const f = fixture(t);
  for (const field of ['pending', 'processing', 'dead_letter']) {
    writeFileSync(join(f.root, 'trigger-status.json'), JSON.stringify({ triggers: [{ queue: { pending: 0, processing: 0, dead_letter: 0, [field]: 1 } }] }));
    assert.throws(() => adopt(f.options), { code: 'ToubaStateNotQuiescent' });
  }
});
test('incomplete native runs and damaged traces refuse adoption', async t => {
  const f = fixture(t);
  await assert.rejects(withNativeTrace({ projectRoot: f.projectRoot, runId: 'interrupted', phase: 'initial' }, async () => { throw new Error('synthetic interruption'); }));
  assert.throws(() => adopt(f.options), { code: 'ToubaStateNotQuiescent' });
  const other = fixture(t), trace = JSON.parse(readFileSync(new URL('../../../tests/traces/tb-v01-003-branch.trace.json', import.meta.url)));
  await withNativeTrace({ projectRoot: other.projectRoot, runId: trace.run.run_id, phase: 'initial' }, async () => ({ status: 'success', trace }));
  const db = new DatabaseSync(join(other.root, 'native-traces.sqlite'));
  db.exec("UPDATE records SET body=json_set(body,'$.complete',0)"); db.close();
  assert.throws(() => adopt(other.options), { code: 'ToubaServeNativeTraceStoreInvalid' });
});
for (const stage of ['before_origin', 'after_origin']) test(`interruption ${stage} blocks startup and recovery never restores or executes stores`, t => {
  const f = fixture(t), preview = adopt(f.options), before = readFileSync(f.sessionsPath);
  const rename = fs.renameSync, unlink = fs.unlinkSync;
  fs.renameSync = (from, to) => { if (stage === 'before_origin' && to === join(f.root, 'state-origin.json')) throw new Error('synthetic interruption'); return rename(from, to); };
  fs.unlinkSync = path => { if (stage === 'after_origin' && path === join(f.root, 'state-adoption.pending.json')) throw new Error('synthetic interruption'); return unlink(path); };
  syncBuiltinESMExports();
  try { assert.throws(() => adopt({ ...f.options, accept: preview.review_digest }), /synthetic interruption/); }
  finally { fs.renameSync = rename; fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  assert.throws(() => acquireStateLease(f.projectRoot), { code: 'ToubaStateAdoptionInterrupted' });
  const result = recoverStateAdoption({ projectRoot: f.projectRoot });
  assert.equal(result.status, stage === 'before_origin' ? 'not_adopted' : 'adopted');
  assert.equal(result.restored_stores, 0); assert.deepEqual(readFileSync(f.sessionsPath), before);
  assert.equal(existsSync(join(f.root, 'state-adoption.pending.json')), false);
});
for (const tampered of ['backup', 'live']) test(`interrupted adoption refuses recovery when ${tampered} bytes diverge`, t => {
  const f = fixture(t), preview = adopt(f.options), unlink = fs.unlinkSync;
  fs.unlinkSync = path => { if (path === join(f.root, 'state-adoption.pending.json')) throw new Error('synthetic interruption'); return unlink(path); };
  syncBuiltinESMExports();
  try { assert.throws(() => adopt({ ...f.options, accept: preview.review_digest }), /synthetic interruption/); }
  finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  const pending = JSON.parse(readFileSync(join(f.root, 'state-adoption.pending.json')));
  if (tampered === 'backup') writeFileSync(join(f.root, 'state-adoptions', pending.backup_id, 'files/state-origin.json'), '{}');
  else writeFileSync(join(f.root, 'project-events.jsonl'), 'new work\n');
  assert.throws(() => recoverStateAdoption({ projectRoot: f.projectRoot }), { code: tampered === 'backup' ? 'ToubaStateArchiveIntegrityMismatch' : 'ToubaStateReviewStale' });
  assert.equal(existsSync(join(f.root, 'state-adoption.pending.json')), true);
  assert.throws(() => acquireStateLease(f.projectRoot), { code: 'ToubaStateAdoptionInterrupted' });
});
test('CLI adoption preview and exact acceptance share the offline contract', async t => {
  const f = fixture(t), args = ['adopt', '--project', f.projectRoot, '--reason', 'Local compatibility test'];
  const preview = JSON.parse((await stateCommand(args)).text);
  assert.equal(preview.status, 'preview');
  const result = JSON.parse((await stateCommand([...args, '--accept', preview.review_digest])).text);
  assert.equal(result.status, 'adopted');
  await assert.rejects(stateCommand(['adopt', '--recover', '--accept', 'abc']), /cannot be combined/);
});

test('JavaScript and Python SDKs consume the same offline preview, exact acceptance and refusal codes', async t => {
  const f = fixture(t), main = fileURLToPath(new URL('../../touba-project/src/main.mjs', import.meta.url));
  const engine = new ToubaEngine({ projectRoot: f.projectRoot, command: process.execPath, commandArgs: [main] });
  t.after(() => engine.close());
  const preview = await engine.adoptState({ reason: f.options.reason });
  assert.equal(preview.status, 'preview');
  await assert.rejects(engine.adoptState({ reason: f.options.reason, accept: 'b'.repeat(64) }), { code: 'ToubaStateReviewStale' });
  const sdk = fileURLToPath(new URL('../../../runtime/touba-python-sdk/src', import.meta.url));
  const script = `import sys,json\nsys.path.insert(0,${JSON.stringify(sdk)})\nfrom touba_sdk import ToubaEngine,ToubaEngineError\ne=ToubaEngine(${JSON.stringify(f.projectRoot)},command=${JSON.stringify(process.execPath)},command_args=[${JSON.stringify(main)}])\np=e.adopt_state(reason=${JSON.stringify(f.options.reason)})\nr=e.adopt_state(reason=${JSON.stringify(f.options.reason)},accept=p['review_digest'])\ntry:\n e.adopt_state(reason='again')\nexcept ToubaEngineError as error:\n print(json.dumps({'preview':p,'status':r['status'],'code':error.code}))\n`;
  const result = JSON.parse(execFileSync('python3', ['-I', '-c', script], { encoding: 'utf8' }));
  assert.equal(result.preview.review_digest, preview.review_digest);
  assert.equal(result.status, 'adopted'); assert.equal(result.code, 'ToubaStateAdoptionOriginRequired');
  const second = fixture(t), secondEngine = new ToubaEngine({ projectRoot: second.projectRoot, command: process.execPath, commandArgs: [main] });
  t.after(() => secondEngine.close());
  const plan = await secondEngine.adoptState({ reason: second.options.reason });
  assert.equal((await secondEngine.adoptState({ reason: second.options.reason, accept: plan.review_digest })).status, 'adopted');
});
