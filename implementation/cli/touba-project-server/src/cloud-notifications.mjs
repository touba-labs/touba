import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSqliteTriggerQueue } from '../../touba-trigger-service/src/sqlite-queue.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const descriptor = (kind, reference, instant) => {
  const occurred_at = new Date(instant).toISOString();
  return { event_key: hash(JSON.stringify([kind, reference, occurred_at])), kind,
    reference: /^[A-Za-z0-9:_.-]{1,128}$/.test(reference ?? '') ? reference : hash(String(reference)), occurred_at };
};

export function notificationForEvent(event) {
  const value = event.payload ?? {};
  if (value.code === 'TriggerRateLimited' && ['trigger.fire.completed','sandbox_run.completed'].includes(event.type)) return null;
  if (['HumanApprovalExpired','HumanApprovalRejected','HumanApprovalCancelled'].includes(value.code)
    && ['trigger.webhook.updated','sandbox_run.resumed'].includes(event.type)) return null;
  // The durable human-wait event carries this terminal outcome. Forwarding
  // the accompanying failed interaction would create a second incident.
  if (event.type === 'interaction.run.failed'
    && ['ToubaSandboxHumanDecisionExpired', 'ToubaSandboxHumanDecisionRejected', 'ToubaSandboxHumanDecisionCancelled'].includes(value.error?.code)) return null;
  const kind = event.type === 'trigger.webhook.updated' && ['failed','interrupted'].includes(value.status) ? 'execution_failed'
    : ['interaction.run.failed','interaction.run.interrupted','trigger.schedule.interrupted'].includes(event.type) ? 'execution_failed'
    : event.type === 'trigger.schedule.skipped' ? 'observation_gap'
    : event.type === 'human_wait.terminalized' && value.resolution_kind === 'expired' ? 'approval_expired'
    : ['sandbox_run.completed','sandbox_run.resumed','trigger.fire.completed'].includes(event.type)
      ? ['error','failed','failure'].includes(value.status) ? 'execution_failed' : null : null;
  return kind ? descriptor(kind, value.request_id ?? value.operation_id ?? value.run_id ?? event.event_id, event.emitted_at) : null;
}

/** Replay the canonical event journal; one bounded cursor, never a browser timer. */
export function createCloudNotifications({ enabled, controlPlaneUrl, serviceToken, cursorPath, readEvents, readWaits, queuePath,
  fetchImpl = fetch, now = Date.now }) {
  let timer, task, stopped = true;
  let health = { enabled: Boolean(enabled), status: enabled ? 'starting' : 'disabled', last_success_at: null, error: null };
  const initial = () => ({ version: 1, sequence: 0, waitOffset: 0, queueAfter: '', seen: [] });
  function state() {
    if (!existsSync(cursorPath)) return initial();
    const stat = lstatSync(cursorPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 131072 || process.platform !== 'win32' && stat.mode & 0o077) throw new Error('notification_cursor_invalid');
    const value = JSON.parse(readFileSync(cursorPath, 'utf8'));
    if (value.version !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || !Number.isSafeInteger(value.waitOffset) || value.waitOffset < 0 || typeof value.queueAfter !== 'string'
      || value.queueAfter.length > 128 || !Array.isArray(value.seen) || value.seen.length > 1024
      || value.seen.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error('notification_cursor_invalid');
    if (value.pendingGap != null && (value.pendingGap.kind !== 'observation_gap'
      || !/^[a-f0-9]{64}$/.test(value.pendingGap.event_key ?? '')
      || !/^[A-Za-z0-9:_.-]{1,128}$/.test(value.pendingGap.reference ?? '')
      || !Number.isFinite(Date.parse(value.pendingGap.occurred_at)))) throw new Error('notification_cursor_invalid');
    return value;
  }
  function persist(value) {
    mkdirSync(dirname(cursorPath), { recursive: true });
    const temporary = cursorPath + `.tmp-${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, cursorPath);
  }
  async function flush() {
    if (!enabled) return;
    const previous = state(), next = { ...previous }, seen = new Set(previous.seen);
    const events = readEvents(), outgoing = [];
    let gapReason = null;
    const add = value => {
      if (!value || seen.has(value.event_key) || outgoing.some(item => item.event_key === value.event_key)) return;
      if (Date.parse(value.occurred_at) < now() - 7*86400000) return;
      outgoing.push(value);
    };
    if (events.length && (events[0].sequence > previous.sequence + 1 || events.at(-1).sequence < previous.sequence)) {
      gapReason = `sequence:${previous.sequence}:${events[0].sequence}`;
      next.sequence = events[0].sequence - 1;
    }
    // At most 24 journal events + one gap + 50 wait events + 25 queue events.
    for (const event of events.filter(item => item.sequence > next.sequence).slice(0, 24)) {
      const value = notificationForEvent(event);
      if (value && Date.parse(value.occurred_at) < now() - 7*86400000) {
        // Historical events outside Cloud admission remain in local audit; mark the gap once.
        gapReason ??= `expired-history:${previous.sequence}`;
      } else add(value);
      next.sequence = event.sequence;
    }
    if (previous.pendingGap == null && gapReason) {
      // Persist its observation time before HTTP: retries, including after restart,
      // must retain the same descriptor even when the lost history is very old.
      previous.pendingGap = descriptor('observation_gap', gapReason, now());
      persist(previous);
    }
    if (previous.pendingGap) {
      if (Date.parse(previous.pendingGap.occurred_at) < now() - 7*86400000) throw new Error('notification_gap_expired');
      add(previous.pendingGap);
    }
    next.pendingGap = null;
    const page = readWaits(previous.waitOffset || undefined);
    if (!Array.isArray(page.records) || page.records.length > 25) throw new Error('notification_wait_page_invalid');
    for (const wait of page.records) {
      const deadline = Date.parse(wait.human_wait.deadline_at);
      if (wait.status === 'pending' && wait.human_wait.resolution === null && deadline > now()) {
        add(descriptor('approval_pending', wait.request_id, wait.created_at));
        if (deadline - now() <= 3600000) add(descriptor('approval_expiring', wait.request_id, Math.max(Date.parse(wait.created_at), deadline - 3600000)));
      }
    }
    next.waitOffset = page.next ?? 0;
    if (queuePath && existsSync(queuePath)) {
      const queue = createSqliteTriggerQueue({ filename: queuePath, readOnly: true });
      try {
        const page = queue.page({ after: previous.queueAfter, limit: 25 });
        for (const entry of page.entries) if (entry.status === 'dead_lettered') {
          add(descriptor('trigger_dead_letter', entry.queue_id, entry.completed_at ?? entry.received_at));
        }
        next.queueAfter = page.entries.length === 25 ? page.next : '';
      } finally { queue.close(); }
    }
    if (outgoing.length) {
      const response = await fetchImpl(controlPlaneUrl.replace(/\/$/, '') + '/notifications/events', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'x-touba-service-token': typeof serviceToken === 'function' ? await serviceToken() : serviceToken },
        body: JSON.stringify({ events: outgoing }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('notification_cloud_unavailable'); }
      let text = '';
      for await (const chunk of response.body) {
        text += Buffer.from(chunk).toString('utf8');
        if (Buffer.byteLength(text) > 16384) throw new Error('notification_receipt_invalid');
      }
      const receipt = JSON.parse(text);
      if (!Array.isArray(receipt.accepted) || JSON.stringify(receipt.accepted) !== JSON.stringify(outgoing.map(item => item.event_key))) throw new Error('notification_receipt_invalid');
      for (const item of outgoing) { seen.delete(item.event_key); seen.add(item.event_key); }
    }
    next.seen = [...seen].slice(-1024);
    persist(next);
    health = { enabled: true, status: 'ready', last_success_at: new Date(now()).toISOString(), error: null };
  }
  const run = () => task ??= flush().catch(error => {
    health = { ...health, status: 'error', error: ['notification_cursor_invalid','notification_cloud_unavailable','notification_receipt_invalid','notification_gap_expired'].includes(error.message) ? error.message : 'notification_observation_failed' };
  }).finally(() => { task = null; });
  return { status: () => ({ ...health }), flush: run,
    start() { if (!enabled || !stopped) return; stopped = false; void run(); timer = setInterval(() => { if (!stopped) void run(); }, 30000); timer.unref?.(); },
    async stop() { stopped = true; clearInterval(timer); await task; },
  };
}
