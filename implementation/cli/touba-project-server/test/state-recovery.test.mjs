import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { initProject, prepareProject } from '../../touba-project/src/project.mjs';
import { createToubaProjectServer, checkToubaProjectState } from '../src/serve.mjs';
import { archiveProjectState, restoreProjectState } from '../src/state-maintenance.mjs';
import { reviewWaitAbandonment, auditRecoveryTriggerQueue, auditRecoveryTriggerState } from '../src/state-recovery.mjs';
import { createSqliteTriggerStore } from '../../../runtime/touba-runtime/src/sqlite-trigger-store.mjs';
import { createSqliteTriggerQueue } from '../../touba-trigger-service/src/sqlite-queue.mjs';
import { createSqliteHumanCheckpointStore } from '../../../runtime/touba-runtime/src/human-checkpoint-store.mjs';
import { createSqliteEffectJournal, auditSqliteEffectJournal } from '../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs';
import { fileURLToPath } from "node:url";


const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const serve = fileURLToPath(new URL('../src/serve.mjs', import.meta.url));

for (const [scheduled, deadLetter] of [[false, false], [true, false], [true, true]]) test(`offline CLI abandons a real ${scheduled ? 'scheduled' : 'direct'} protected wait from another build${deadLetter ? ' retaining failed deliveries' : ''}, preserves evidence and starts fresh without an effect`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-offline-recovery-'));
  let service;
  t.after(async () => { await service?.stop(); rmSync(root, { recursive: true, force: true }); });
  initProject({ root }); mkdirSync(join(root, 'src/qa'), { recursive: true });
  writeFileSync(join(root, 'src/qa/payment.tb'), `module qa.payment
tool Pay
    gives Text
    requires filesystem_write
    human.approve
        with timeout_ms as 8000
strategy Work
    gives Text
    uses Pay
    do
        Pay
            into paid
        give paid
${scheduled ? `trigger Job
    on schedule "every 1s"
    runs strategy Work
    limits
        max_runs_per_day as 1
        timeout_ms as 3000
` : ''}
`);
  const config = JSON.parse(readFileSync(join(root, 'touba.project.json')));
  config.entry = scheduled ? 'trigger:qa.payment/Job' : 'strategy:qa.payment/Work';
  writeFileSync(join(root, 'touba.project.json'), JSON.stringify(config));
  writeFileSync(join(root, 'pay.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('payment.log', 'unexpected');`);
  writeFileSync(join(root, 'touba.manifest.json'), JSON.stringify({ manifest_version: 'touba-manifest-v1', bindings: {
    'tool:qa.payment/Pay': { handler: { kind: 'process', command: process.execPath, args: ['pay.mjs'], cwd: root },
      grants: ['filesystem_write'], secrets: [], effect_contract: { kind: 'external_write', retry_mode: 'none' },
      timeout_ms: 1000, max_payload_bytes: 65536 },
  }, ...(scheduled ? { triggers: { 'trigger:qa.payment/Job': { enabled: true, source: { kind: 'schedule' },
    limits: { max_runs_per_day: 1, timeout_ms: 3000 } } } } : {}) }));
  const prepared = await prepareProject({ root, mode: 'write', manifestPath: 'touba.manifest.json' });
  assert.equal(prepared.status, 'success', JSON.stringify(prepared.diagnostics));
  const settings = { projectRoot: root, quiet: true, port: 0 };
  service = createToubaProjectServer({ ...settings, scheduleTriggers: scheduled }); await service.start();
  const base = () => `http://127.0.0.1:${service.server.address().port}`;
  if (scheduled) {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      if ((await (await fetch(base() + '/decisions')).json()).pending_requests.total) { waiting = true; break; }
      await delay(50);
    }
    assert.ok(waiting, 'the real scheduler pauses its first payment');
  } else {
    const response = await fetch(base() + '/runs/sandbox', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 'touba-sandbox-run-request-v1', execution_kind: 'entrypoint',
        target_ref: config.entry, effect_policy: 'allow_declared_external_effects', inputs: {},
        requested_by: { kind: 'studio', id: 'offline-recovery-test' }, reason: 'Synthetic recovery qualification.' }) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).reason, 'human_approval_pending');
  }
  const pendingResponse = await fetch(base() + '/approvals/pending/current');
  assert.equal(pendingResponse.status, 200, 'capture the pending wait before its deadline');
  const request = await pendingResponse.json();
  assert.ok(Number.isFinite(Date.parse(request.expires_at)), 'the recovery fixture requires an actual pending request, not an already expired HTTP error');
  const options = { projectRoot: root, abandonWaits: true, abandonOperations: deadLetter, stateReason: 'Replace an incompatible stopped test state.' };
  assert.throws(() => archiveProjectState(options, checkToubaProjectState), { code: 'ToubaStateInUse' });
  await service.stop(); service = null;
  if (deadLetter) {
    const queue = createSqliteTriggerQueue({ filename: join(root, '.touba/trigger-queue.sqlite') });
    queue.enqueue({ queue_id: 'failed-delivery', trigger_ref: 'trigger:qa.payment/Job', event_id: 'failed-event',
      status: 'dead_lettered', received_at: '2026-11-12T12:00:00.000Z' });
    queue.close();
    assert.throws(() => archiveProjectState({ ...options, abandonOperations: false }, checkToubaProjectState),
      error => error.code === 'ToubaStateNotQuiescent' && error.message.includes('triggerQueuePath'));
  }
  await delay(Math.max(0, Date.parse(request.expires_at) - Date.now()) + 30);
  const originPath = join(root, '.touba/state-origin.json');
  const origin = JSON.parse(readFileSync(originPath));
  writeFileSync(originPath, JSON.stringify({ ...origin, build_id: 'a'.repeat(64) }));
  assert.throws(() => createToubaProjectServer(settings), { code: 'ToubaServeStateBuildMismatch' });
  assert.throws(() => archiveProjectState({ projectRoot: root }, checkToubaProjectState), { code: 'ToubaStateNotQuiescent' });
  assert.throws(() => archiveProjectState({ ...options, stateReason: '' }, checkToubaProjectState), { code: 'ToubaStateRecoveryReasonRequired' });
  const protectedPaths = ['touba.project.json', 'touba.manifest.json', 'src/qa/payment.tb', 'pay.mjs'];
  const originalProject = protectedPaths.map(name => sha(join(root, name)));
  const preview = archiveProjectState(options, checkToubaProjectState);
  if (deadLetter) assert.equal(preview.recovery.retained_dead_letters, 1);
  assert.equal(preview.recovery.waits.length, 1);
  assert.equal(preview.recovery.waits[0].request_id, request.request_id);
  assert.equal(preview.recovery.original_build_id, 'a'.repeat(64));
  assert.ok(Date.parse(preview.recovery.waits[0].expires_at) < Date.now());
  assert.ok(preview.files.some(file => file.path === 'approval-checkpoints.sqlite'));
  if (scheduled) assert.ok(preview.retained_files.some(file => file.path === 'triggers.sqlite'));
  for (const file of preview.files) assert.equal(sha(join(root, '.touba', file.path)), file.sha256);
  assert.throws(() => archiveProjectState({ ...options, applyState: true }, checkToubaProjectState), { code: 'ToubaStateReviewStale' });
  assert.throws(() => archiveProjectState({ ...options, stateReason: 'Different reason', applyState: true,
    stateReviewDigest: preview.review_digest }, checkToubaProjectState), { code: 'ToubaStateReviewStale' });
  const summary = join(root, '.touba/current-run-summary.json');
  const summaryBytes = readFileSync(summary); writeFileSync(summary, 'changed since review');
  assert.throws(() => archiveProjectState({ ...options, applyState: true, stateReviewDigest: preview.review_digest }, checkToubaProjectState), { code: 'ToubaStateReviewStale' });
  writeFileSync(summary, summaryBytes);
  const args = ['--project-root', root, '--archive-state', deadLetter ? '--abandon-operations' : '--abandon-waits', '--reason', options.stateReason];
  const reviewed = spawnSync(process.execPath, [serve, ...args], { encoding: 'utf8' });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const cliPreview = JSON.parse(reviewed.stdout);
  const applied = spawnSync(process.execPath, [serve, ...args, '--apply', '--review-digest', cliPreview.review_digest], { encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  const archived = JSON.parse(applied.stdout), archiveRoot = join(root, '.touba/state-archives', archived.archive_id);
  assert.equal(archived.recovery.waits[0].status, 'abandoned');
  assert.equal(archived.recovery.reason, options.stateReason);
  assert.deepEqual(protectedPaths.map(name => sha(join(root, name))), originalProject);
  for (const file of preview.files) {
    assert.equal(sha(join(archiveRoot, file.path)), file.sha256, file.path);
    assert.equal(existsSync(join(root, '.touba', file.path)), false, file.path);
  }
  for (const file of preview.retained_files) {
    assert.equal(sha(join(root, '.touba', file.path)), file.sha256);
    assert.equal(sha(join(archiveRoot, 'retained', file.path)), file.sha256);
  }
  assert.equal(existsSync(join(root, 'payment.log')), false);
  assert.throws(() => restoreProjectState({ projectRoot: root, restoreState: archived.archive_id }), { code: 'ToubaStateAbandonedArchive' });
  // Recreate a crash halfway through the renames, before the maintenance marker
  // was cleared. Rollback restores exact bytes and never resumes a decision.
  writeFileSync(join(root, '.touba/state-archive.pending.json'), JSON.stringify({ archive_id: archived.archive_id }));
  renameSync(join(archiveRoot, 'state-origin.json'), originPath);
  assert.throws(() => createToubaProjectServer(settings), { code: 'ToubaStateArchiveInterrupted' });
  assert.equal(restoreProjectState({ projectRoot: root, restoreState: archived.archive_id, applyState: true }).status, 'restored');
  for (const file of preview.files) assert.equal(sha(join(root, '.touba', file.path)), file.sha256);
  assert.equal(existsSync(join(root, 'payment.log')), false);
  const renewed = archiveProjectState(options, checkToubaProjectState);
  archiveProjectState({ ...options, applyState: true, stateReviewDigest: renewed.review_digest }, checkToubaProjectState);
  service = createToubaProjectServer(settings); await service.start();
  const history = await (await fetch(base() + '/decisions')).json();
  assert.equal(history.pending_requests.total, 0);
  const replay = await fetch(base() + '/runs/sandbox/resume', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_id: request.request_id }) });
  assert.equal(replay.status, 404, await replay.clone().text());
  assert.equal(existsSync(join(root, 'payment.log')), false);
  await service.stop(); service = null;
  assert.equal(checkToubaProjectState({ projectRoot: root }).status, 'structurally_valid');
});

function snapshot(overrides = {}) {
  const record = { record_kind: 'human', status: 'pending', request_id: 'request-1', run_id: 'run-1', operation_id: 'op-1',
    target_ref: 'trigger:qa/Job', human_wait: { deadline_at: '2026-11-12T12:00:00.000Z', resolution: null } };
  return { checkpointPages: [[record]], sessions: [], schedules: [], decisionFor: () => [], ...overrides };
}

test('explicit stopped operation closure names interruptions and preserves claimed decisions', () => {
  const interrupted = { operation_id: 'op-cut', run_id: 'run-cut', target_ref: 'agent:qa/Worker', status: 'interrupted' };
  const data = snapshot({ checkpointPages: [], sessions: [{ operations: [interrupted] }],
    abandonOperations: true, quiescentEvidence: true });
  const review = reviewWaitAbandonment(data);
  assert.equal(review.waits[0].operation_id, 'op-cut');
  assert.equal(review.disposition, 'abandon_without_execution');
  assert.throws(() => reviewWaitAbandonment({ ...data, quiescentEvidence: false }), /effect and custody audits/);
  assert.throws(() => reviewWaitAbandonment({ ...data, abandonOperations: false }), /op-cut.*interrupted/);
  const claimed = snapshot({ abandonOperations: true, quiescentEvidence: true, decisionFor: () => [{ decision: 'approve' }] });
  claimed.checkpointPages[0][0].status = 'resolution_claimed';
  claimed.checkpointPages[0][0].human_wait.resolution = { kind: 'decision' };
  const before = JSON.stringify(claimed.checkpointPages);
  assert.equal(reviewWaitAbandonment(claimed).waits.length, 1);
  assert.equal(JSON.stringify(claimed.checkpointPages), before);
});

test('abandonment eligibility refuses decision claims, unmatched operations and uncertain schedules', () => {
  assert.equal(reviewWaitAbandonment(snapshot()).waits.length, 1);
  for (const kind of ['expired', 'cancelled', 'decision']) {
    const data = snapshot(), record = data.checkpointPages[0][0];
    record.status = 'resolution_claimed'; record.human_wait.resolution = { kind };
    if (kind === 'decision') assert.throws(() => reviewWaitAbandonment(data), { code: 'ToubaStateRecoveryUnsafe' });
    else assert.equal(reviewWaitAbandonment(data).waits[0].previous_status, 'resolution_claimed');
  }
  assert.throws(() => reviewWaitAbandonment(snapshot({ decisionFor: () => [{}] })), { code: 'ToubaStateRecoveryUnsafe' });
  for (const status of ['queued', 'running', 'cancel_requested', 'interrupted', 'awaiting_human']) {
    assert.throws(() => reviewWaitAbandonment(snapshot({ sessions: [{ operations: [{ status, operation_id: 'other' }] }] })), { code: 'ToubaStateRecoveryUnsafe' });
  }
  for (const status of ['running', 'interrupted', 'pending']) {
    assert.throws(() => reviewWaitAbandonment(snapshot({ schedules: [{ status, run_id: 'other' }] })), { code: 'ToubaStateRecoveryUnsafe' });
  }
  assert.equal(reviewWaitAbandonment(snapshot({ schedules: [{ status: 'pending', run_id: 'run-1', trigger_ref: 'trigger:qa/Job' }] })).waits.length, 1);
  assert.throws(() => reviewWaitAbandonment(snapshot({ checkpointPages: [[{ record_kind: 'execution', status: 'resume_claimed' }]] })), { code: 'ToubaStateRecoveryUnsafe' });
  assert.throws(() => reviewWaitAbandonment(snapshot({ checkpointPages: [] })), { code: 'ToubaStateRecoveryEmpty' });
});

test('cold audits identify live custody and every nonterminal trigger queue entry without changing it', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-recovery-audits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const custody = createSqliteHumanCheckpointStore(join(root, 'custody.sqlite'));
  const protectedState = custody.protect({ kind: 'test', value: 'synthetic' }, null);
  assert.equal(custody.audit().active_operations, 1);
  custody.finish(protectedState.ticket, { pending: true });
  assert.equal(custody.audit().active_operations, 0);
  const queueFile = join(root, 'queue.sqlite'), queue = createSqliteTriggerQueue({ filename: queueFile });
  const states = ['queued', 'processing', 'awaiting_human', 'continuing', 'interrupted', 'dead_lettered', 'succeeded', 'failed'];
  for (const [index, status] of states.entries()) queue.enqueue({ queue_id: String(index), trigger_ref: 'trigger:qa/Job',
    event_id: String(index), status, received_at: '2026-11-12T12:00:00.000Z', started_at: '2026-11-12T12:00:00.000Z' });
  queue.close(); const before = sha(queueFile);
  assert.deepEqual(auditRecoveryTriggerQueue(queueFile), { entry_count: 8, active_operations: 6, dead_letters: 1 });
  assert.deepEqual(auditRecoveryTriggerQueue(queueFile, { retainDeadLetters: true }), { entry_count: 8, active_operations: 5, dead_letters: 1 });
  assert.equal(sha(queueFile), before);
});

test('state CLI rejects recovery modifiers outside the explicit archive operation', () => {
  for (const args of [['--abandon-waits'], ['--reason', 'x'], ['--archive-state', '--review-digest', 'a'.repeat(64)],
    ['--archive-state', '--abandon-waits', '--check-state']]) {
    const result = spawnSync(process.execPath, [serve, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ToubaStateOptionsInvalid/);
  }
});

test('trigger admissions remain uncertain unless they match the exact reviewed pending run', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-recovery-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'triggers.sqlite'), store = createSqliteTriggerStore({ filename: path });
  const event = { triggerRef: 'trigger:qa/Job', eventId: 'event-1', sourceKind: 'schedule', runId: 'run-1', maxRunsPerDay: 2 };
  const wait = { target_ref: event.triggerRef, run_id: event.runId };
  store.admit(event);
  assert.equal(store.audit({ pendingWaits: [wait] }).active_operations, 1, 'active dispatch is never abandoned');
  store.recordResult(event, { status: 'pending', trace: { run: { run_id: event.runId },
    events: [{ kind: 'trigger_event_accepted', payload: { trigger_ref: event.triggerRef } }] } });
  store.close();
  const before = sha(path);
  assert.equal(auditRecoveryTriggerState(path).active_operations, 1);
  assert.equal(auditRecoveryTriggerState(path, [{ ...wait, run_id: 'other' }]).active_operations, 1);
  assert.equal(auditRecoveryTriggerState(path, [wait]).active_operations, 0);
  assert.equal(sha(path), before);
});

test('effect audit blocks prepared, dispatched and unknown outcomes even when no human wait remains', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-recovery-effects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.touba'));
  const path = join(root, '.touba/project.effect-journal.sqlite');
  const journal = createSqliteEffectJournal(path);
  const base = { effect_id: 'effect:sha256:' + 'a'.repeat(64), effect_scope_id: 'operation-test',
    air_digest: 'sha256:' + 'b'.repeat(64), entry_ref: 'strategy:qa/Run', effect_index: 1,
    request_digest: 'sha256:' + 'c'.repeat(64), tool_ref: 'tool:qa/Pay', retry_mode: 'none',
    attempt_count: 1, last_call_id: 'call-1' };
  for (const state of ['prepared', 'dispatched', 'unknown', 'not_applied', 'applied']) {
    journal.writeEntry({ ...base, state, ...(['not_applied', 'applied'].includes(state) ? {
      receipt: { effect_id: base.effect_id, request_digest: base.request_digest, outcome: state },
      ...(state === 'applied' ? { result: 'synthetic payment receipt' } : {}),
    } : {}) });
    const active = !['not_applied', 'applied'].includes(state);
    const before = sha(path);
    assert.equal(auditSqliteEffectJournal(path).active_operations, Number(active));
    if (active) assert.throws(() => archiveProjectState({ projectRoot: root }, checkToubaProjectState), { code: 'ToubaStateNotQuiescent' });
    else assert.equal(archiveProjectState({ projectRoot: root }, checkToubaProjectState).status, 'preview');
    assert.equal(sha(path), before);
  }
});
