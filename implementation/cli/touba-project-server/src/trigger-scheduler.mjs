import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexedStore } from '../../../runtime/touba-runtime/src/sqlite-record-store.mjs';
import { parseTriggerRunnerSchedule } from '../../../runtime/touba-runtime/src/trigger-schedule.mjs';
import { readPreparedProject } from './prepared-project.mjs';
import { readProjectEntrypoints } from '../../touba-project/src/project-entrypoints.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const states = ['waiting','running','pending','success','failed','interrupted'];

/** Plans come only from a verified preparation, explicit entrypoints and enabled bindings. */
export function readSchedulePlans(root) {
  const prepared = readPreparedProject(root);
  if (!prepared) fail('ToubaSchedulerPreparationRequired');
  const manifestInput = prepared.inputs.find(input => input.kind === 'manifest');
  if (!manifestInput) fail('ToubaSchedulerPreparationRequired');
  const manifest = JSON.parse(readFileSync(join(root, manifestInput.path), 'utf8'));
  const entrypoints = new Set(readProjectEntrypoints(root)), plans = new Map();
  for (const input of prepared.inputs.filter(input => input.kind === 'air')) {
    const air = JSON.parse(readFileSync(join(root, input.path), 'utf8'));
    for (const trigger of air.definitions?.triggers ?? []) {
      if (trigger.event?.kind !== 'schedule' || !entrypoints.has(trigger.id) || manifest.triggers?.[trigger.id]?.enabled !== true) continue;
      const interval = parseTriggerRunnerSchedule(trigger.event.value);
      const plan = { trigger_ref: trigger.id, interval_ms: interval.ok ? interval.delayMs : null,
        ...(!interval.ok ? { error: 'TriggerScheduleUnsupported' } : {}),
        signature: digest([trigger, prepared.inputs.map(item => [item.path, item.digest_sha256])]) };
      // Imported copies must describe the same declaration.
      if (plans.has(trigger.id) && plans.get(trigger.id).signature !== plan.signature) fail('ToubaServeTriggerDefinitionConflict');
      plans.set(trigger.id, plan);
      if (plans.size > 100) fail('ToubaSchedulerCapacityExceeded');
    }
  }
  return [...plans.values()].sort((a,b) => a.trigger_ref.localeCompare(b.trigger_ref));
}

export function schedulerStore(path) {
  return indexedStore({ path, schemaVersion: 'touba-scheduler-store-v1', maxBytes: 2*1024*1024, maxRecordBytes: 4096,
    keyOf: row => row.trigger_ref,
    validate(row) {
      if (!row || typeof row.trigger_ref !== 'string' || row.trigger_ref.length > 512 || !row.trigger_ref.startsWith('trigger:')
        || !/^[a-f0-9]{64}$/.test(row.signature ?? '') || !states.includes(row.status)
        || !Number.isSafeInteger(row.slot) || row.slot < 0 || !Number.isSafeInteger(row.interval_ms) || row.interval_ms < 1000
        || row.interval_ms > 2147483647 || !Number.isSafeInteger(row.skipped) || row.skipped < 0
        || row.run_id !== null && !/^schedule_[a-f0-9]{40}$/.test(row.run_id ?? '')
        || row.error !== null && !/^[A-Za-z0-9_]{1,100}$/.test(row.error ?? '')) fail('ToubaSchedulerStateInvalid');
      if (row.retry_at !== undefined && (!Number.isSafeInteger(row.retry_at) || row.retry_at < 0)) fail('ToubaSchedulerStateInvalid');
    },
    checkTransaction(db) { if (db.prepare('SELECT count(*) AS n FROM records').get().n > 100) fail('ToubaSchedulerCapacityExceeded'); },
  });
}

/** One worker. A persisted claim always precedes execution; uncertain claims require review. */
export function createTriggerScheduler({ enabled, path, plans, execute, pending, quotaReached = () => false, outcome = () => null, emit, now = Date.now }) {
  const store = schedulerStore(path);
  let timer, task, stopping = false, started = false;
  let health = { enabled: Boolean(enabled), status: enabled ? 'starting' : 'disabled', error: null, last_poll_at: null };
  function reconcile() {
    const rows = store.read();
    let changed = false;
    for (const row of rows) {
      if (row.status !== 'pending' || pending(row.trigger_ref)) continue;
      const result = outcome(row);
      const status = typeof result === 'string' ? result : result?.status;
      if (!['success', 'failed'].includes(status)) continue;
      row.status = status;
      row.error = status === 'failed' && /^[A-Za-z0-9_]{1,100}$/.test(result?.error ?? '') ? result.error : null;
      changed = true;
    }
    if (changed) store.write(rows);
  }
  function currentPlans() {
    const all = plans();
    if (all.length > 100) fail('ToubaSchedulerCapacityExceeded');
    return {
      valid: all.filter(plan => !plan.error),
      issues: all.filter(plan => plan.error).map(plan => ({ trigger_ref: plan.trigger_ref, code: plan.error })),
    };
  }
  function recover() {
    const rows = store.read();
    const recovered = [];
    for (const row of rows) if (row.status === 'running') {
      row.status = 'interrupted'; row.error = 'ToubaSchedulerInterrupted';
      recovered.push(row);
    }
    if (rows.length) store.write(rows);
    for (const row of recovered) emit('trigger.schedule.interrupted', {
      trigger_ref: row.trigger_ref, run_id: row.run_id, code: row.error,
    });
  }
  async function poll() {
    if (stopping) return;
    if (!started) { recover(); started = true; }
    reconcile();
    if (!enabled) return;
    const { valid: current, issues } = currentPlans();
    for (const plan of current) {
      if (stopping) break;
      const slot = Math.floor(now()/plan.interval_ms), rows = store.read([{ id: plan.trigger_ref }]);
      let row = rows[0];
      if (row?.status === 'interrupted') continue;
      // Atomic runtime admission remains authoritative. A proven daily-quota
      // refusal schedules the next observation at the next UTC day, durably.
      if (row?.retry_at > now()) continue;
      if (pending(plan.trigger_ref)) continue;
      if (!row || row.signature !== plan.signature) {
        // A new/revised schedule starts at its next UTC-aligned interval.
        row = { ...plan, slot, status: 'waiting', run_id: null, error: null, skipped: row?.skipped ?? 0 };
        rows.splice(0, rows.length, row); store.write(rows); continue;
      }
      if (slot <= row.slot) continue; // Includes backwards wall-clock changes.
      if (quotaReached(plan.trigger_ref)) {
        row.slot = slot; row.status = 'waiting'; row.error = 'TriggerRateLimited';
        row.retry_at = (Math.floor(now() / 86400000) + 1) * 86400000;
        store.write(rows);
        emit('trigger.schedule.quota_reached', {trigger_ref: plan.trigger_ref, retry_at: new Date(row.retry_at).toISOString()});
        continue;
      }
      const skipped = slot-row.slot-1;
      const quotaCooldown = row.error === 'TriggerRateLimited';
      row.slot = slot; row.skipped += skipped; row.error = null;
      delete row.retry_at;
      row.run_id = 'schedule_'+digest([plan.trigger_ref, plan.signature, slot]).slice(0,40);
      row.status = 'running'; store.write(rows);
      if (skipped && !quotaCooldown) emit('trigger.schedule.skipped', { trigger_ref: plan.trigger_ref, count: skipped, run_id: row.run_id });
      const authority = () => !stopping && currentPlans().valid.some(item => item.trigger_ref === plan.trigger_ref && item.signature === plan.signature);
      try {
        if (!authority()) fail('ToubaSchedulerPlanChanged');
        const result = await execute({ ...plan, run_id: row.run_id, event_id: row.run_id, authority, cancelled: () => stopping });
        row.status = pending(plan.trigger_ref) ? 'pending' : result.status === 'success' ? 'success' : 'failed';
        row.error = row.status === 'failed' && /^[A-Za-z0-9_]{1,100}$/.test(result.reason ?? '') ? result.reason : null;
        if (result.reason === 'TriggerRateLimited' && row.status === 'failed') {
          row.status = 'waiting'; row.error = 'TriggerRateLimited';
          row.retry_at = (Math.floor(now() / 86400000) + 1) * 86400000;
        }
        emit('trigger.fire.completed', { trigger_ref: plan.trigger_ref, run_id: row.run_id, status: result.status,
          ...(row.error ? { code: row.error } : {}) });
      } catch (error) {
        // No retry of an ambiguous occurrence, including storage/transport errors.
        row.status = 'interrupted'; row.error = /^[A-Za-z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'ToubaSchedulerExecutionInterrupted';
        emit('trigger.schedule.interrupted', { trigger_ref: plan.trigger_ref, run_id: row.run_id, code: row.error });
      }
      store.write(rows);
    }
    health = { ...health, status: issues.length ? 'degraded' : 'ready', error: null, last_poll_at: new Date(now()).toISOString() };
  }
  const tick = () => task ??= poll().catch(error => {
    health = { ...health, status: 'error', error: /^[A-Za-z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'ToubaSchedulerObservationFailed' };
  }).finally(() => { task = null; });
  return {
    tick,
    reconcile,
    status() {
      let active = [], issues = [];
      try { if (enabled) ({ valid: active, issues } = currentPlans()); }
      catch (error) { return { schema_version: 'touba-trigger-scheduler-v1', ...health, status:'error',
        error: /^[A-Za-z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'ToubaSchedulerObservationFailed',
        schedules: store.read().map(row => ({...row, active:false, next_run_at:null})) }; }
      return { schema_version: 'touba-trigger-scheduler-v1', ...health,
        ...(issues.length ? { status: 'degraded' } : {}), issues, schedules: store.read().map(row => {
        const current = active.some(plan => plan.trigger_ref === row.trigger_ref && plan.signature === row.signature);
        const waiting = pending(row.trigger_ref);
        return { ...row, status: waiting ? 'pending' : row.status === 'pending' ? 'waiting' : row.status, active: current,
          next_run_at: !current || waiting || row.status === 'interrupted' ? null : new Date(Math.max((row.slot+1)*row.interval_ms, row.retry_at ?? 0)).toISOString() };
      }) };
    },
    acknowledge({ trigger_ref, run_id, reason }) {
      if (!enabled || typeof reason !== 'string' || !reason.trim() || reason.length > 500) fail('ToubaSchedulerReviewInvalid');
      const rows = store.read([{id:trigger_ref}]), row = rows[0];
      if (!row || row.status !== 'interrupted' || row.run_id !== run_id) fail('ToubaSchedulerReviewConflict');
      row.status = 'waiting'; row.error = null; row.slot = Math.max(row.slot, Math.floor(now()/row.interval_ms));
      store.write(rows); return { trigger_ref, run_id, status: 'acknowledged' };
    },
    start() { if (timer) return; stopping = false; void tick(); if (enabled) { timer = setInterval(() => void tick(), 1000); timer.unref?.(); } },
    async stop() { stopping = true; clearInterval(timer); timer = null; await task; },
  };
}
