import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCloudNotifications, notificationForEvent } from '../src/cloud-notifications.mjs';
import { createSqliteTriggerQueue } from '../../touba-trigger-service/src/sqlite-queue.mjs';

test('human expiry, rejection and cancellation do not also emit execution incidents', () => {
  for (const code of ['ToubaSandboxHumanDecisionExpired', 'ToubaSandboxHumanDecisionRejected', 'ToubaSandboxHumanDecisionCancelled']) {
    assert.equal(notificationForEvent({ type: 'interaction.run.failed', payload: { error: { code } } }), null);
  }
  assert.equal(notificationForEvent({ type: 'interaction.run.failed', emitted_at: new Date().toISOString(), payload: { error: { code: 'HandlerFailed' } } }).kind, 'execution_failed');
});

test('forwarding minimizes data and keeps its cursor until Cloud acknowledgement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-notifications-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), occurred = new Date(now).toISOString(), received = [];
  let offline = true;
  const options = { enabled: true, controlPlaneUrl: 'https://cloud.test/api/v1/studio', serviceToken: 'fixture', cursorPath: join(root, 'cursor.json'), now: () => now,
    readEvents: () => [{ sequence: 1, event_id: 'evt_1', emitted_at: occurred, type: 'interaction.run.failed', payload: { operation_id: 'op1', inputs: { password: 'must-not-forward' } } }],
    readWaits: () => ({ records: [], next: null }), fetchImpl: async (url, request) => {
      assert.equal(url, 'https://cloud.test/api/v1/studio/notifications/events');
      assert.equal(request.redirect, 'error');
      const body = JSON.parse(request.body); received.push(body);
      if (offline) return new Response('{}', { status: 503 });
      return Response.json({ accepted: body.events.map(item => item.event_key) });
    } };
  const notifier = createCloudNotifications(options);
  await notifier.flush(); assert.equal(notifier.status().status, 'error');
  offline = false; await notifier.flush(); assert.equal(notifier.status().status, 'ready');
  assert.equal(received[0].events[0].event_key, received[1].events[0].event_key);
  assert.ok(!JSON.stringify(received).includes('must-not-forward'));
  assert.equal(JSON.parse(readFileSync(options.cursorPath)).sequence, 1);
  await createCloudNotifications(options).flush(); assert.equal(received.length, 2);
});

test('pending decisions and approaching deadlines are deduplicated across restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-notifications-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), received = [];
  const options = { enabled: true, controlPlaneUrl: 'https://cloud.test', cursorPath: join(root, 'cursor.json'), now: () => now,
    readEvents: () => [], readWaits: () => ({ next: null, records: [{ status: 'pending', request_id: 'approval:123', created_at: new Date(now-1000).toISOString(),
      human_wait: { deadline_at: new Date(now+10000).toISOString(), resolution: null, request: { secret: 'not-transmitted' } } }] }),
    fetchImpl: async (_, request) => { const { events } = JSON.parse(request.body); received.push(...events); return Response.json({ accepted: events.map(item => item.event_key) }); } };
  await createCloudNotifications(options).flush(); await createCloudNotifications(options).flush();
  assert.deepEqual(received.map(item => item.kind), ['approval_pending', 'approval_expiring']);
  assert.ok(!JSON.stringify(received).includes('not-transmitted'));
});

test('journal gaps are explicit and malformed cursor or receipt never acknowledges work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-notifications-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'cursor.json'), received = [], emitted_at = new Date().toISOString();
  const options = { enabled: true, controlPlaneUrl: 'https://cloud.test', cursorPath: path, readWaits: () => ({ records: [], next: null }),
    readEvents: () => [{ sequence: 8, emitted_at, type: 'project.changed' }],
    fetchImpl: async (_, request) => { received.push(JSON.parse(request.body)); return Response.json({ accepted: [] }); } };
  const notifier = createCloudNotifications(options); await notifier.flush();
  assert.equal(received[0].events[0].kind, 'observation_gap'); assert.equal(notifier.status().error, 'notification_receipt_invalid');
  writeFileSync(path, '{}', { mode: 0o600 }); await notifier.flush();
  assert.equal(notifier.status().error, 'notification_cursor_invalid'); assert.equal(received.length, 1);
  assert.equal(notificationForEvent({ type: 'human_decision.accepted', payload: { password: 'secret' } }), null);
  assert.equal(notificationForEvent({ type: 'trigger.fire.completed', emitted_at, event_id:'failed-run', payload:{status:'failure'} }).kind, 'execution_failed');
});

test('observer reads a real dead-letter queue without modifying claims', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-notifications-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const queuePath = join(root, 'queue.sqlite'), queue = createSqliteTriggerQueue({ filename: queuePath });
  const stamp = new Date().toISOString();
  queue.enqueue({ queue_id: 'queue:example', trigger_ref: 'trigger:app/Hook', event_id: 'event:example', status: 'queued', received_at: stamp,
    event: { secret: 'secret-queue-body' }, attempt_count: 0 });
  const entry = queue.claim(300000); entry.status = 'dead_lettered'; entry.completed_at = stamp; queue.finish(entry); queue.close();
  const received = [];
  await createCloudNotifications({ enabled: true, controlPlaneUrl: 'https://cloud.test', cursorPath: join(root, 'cursor.json'), queuePath,
    readWaits: () => ({ records: [], next: null }), readEvents: () => [], fetchImpl: async (_, request) => { const body = JSON.parse(request.body); received.push(...body.events); return Response.json({ accepted: body.events.map(item => item.event_key) }); } }).flush();
  assert.equal(received.length, 1); assert.equal(received[0].kind, 'trigger_dead_letter'); assert.ok(!JSON.stringify(received).includes('secret-queue-body'));
  const check = createSqliteTriggerQueue({ filename: queuePath, readOnly: true });
  try { assert.equal(check.find('trigger:app/Hook', 'event:example').status, 'dead_lettered'); } finally { check.close(); }
});

test('a full page stays within Cloud limits and advances each cursor only after acknowledgement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-notifications-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), stamp = new Date(now).toISOString(), received = [], offsets = [];
  const queuePath = join(root, 'queue.sqlite'), queue = createSqliteTriggerQueue({ filename: queuePath });
  for (let i=0; i<25; i++) {
    queue.enqueue({ queue_id: `queue:${i}`, trigger_ref: 'trigger:app/Hook', event_id: `event:${i}`, status: 'queued', received_at: stamp, event: {}, attempt_count: 0 });
    const entry = queue.claim(300000); entry.status = 'dead_lettered'; entry.completed_at = stamp; queue.finish(entry);
  }
  queue.close();
  const options = { enabled: true, controlPlaneUrl: 'https://cloud.test', cursorPath: join(root, 'cursor.json'), queuePath, now: () => now,
    readEvents: () => Array.from({length: 50}, (_, i) => ({ sequence: i+8, event_id: `evt:${i}`, emitted_at: stamp, type: 'interaction.run.failed' })),
    readWaits: after => { offsets.push(after); return { next: 25, records: Array.from({length:25}, (_, i) => ({status:'pending', request_id:`wait:${i}`, created_at:stamp, human_wait:{resolution:null, deadline_at:new Date(now+1000).toISOString()}})) }; },
    fetchImpl: async (_, request) => { const {events} = JSON.parse(request.body); received.push(events); return Response.json({accepted: events.map(item => item.event_key)}); } };
  await createCloudNotifications(options).flush();
  assert.equal(received[0].length, 100);
  assert.equal(JSON.parse(readFileSync(options.cursorPath)).sequence, 31);
  await createCloudNotifications(options).flush();
  assert.deepEqual(offsets, [undefined, 25]); assert.ok(received[1].length <= 100);
});

test('lost historical observations get a durable current gap and survive a failed send and restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-notifications-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now(), offline = true; const initialNow = now, sent = [];
  const options = { enabled: true, controlPlaneUrl: 'https://cloud.test', cursorPath: join(root, 'cursor.json'), now: () => now,
    readEvents: () => [{ sequence: 1, event_id: 'old', type: 'interaction.run.failed', emitted_at: new Date(initialNow-8*86400000).toISOString() }],
    readWaits: () => ({ records: [], next: null }), fetchImpl: async (_, request) => {
      const {events} = JSON.parse(request.body); sent.push(events);
      return offline ? new Response('{}', {status:503}) : Response.json({accepted:events.map(item=>item.event_key)});
    } };
  await createCloudNotifications(options).flush();
  assert.equal(JSON.parse(readFileSync(options.cursorPath)).sequence, 0);
  now += 60000; offline = false; await createCloudNotifications(options).flush();
  assert.deepEqual(sent[0], sent[1]); assert.equal(sent[0][0].kind, 'observation_gap');
  assert.equal(sent[0][0].occurred_at, new Date(initialNow).toISOString());
  assert.equal(JSON.parse(readFileSync(options.cursorPath)).sequence, 1);
});
