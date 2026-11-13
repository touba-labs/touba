import { createSqliteTriggerQueue } from '../../touba-trigger-service/src/sqlite-queue.mjs';
import { createSqliteTriggerStore } from '../../../runtime/touba-runtime/src/sqlite-trigger-store.mjs';

// Receives only validated, offline snapshots. No runtime, host or decision is invoked.
const refuse = (record = {}, cause = 'requires reconciliation') => { throw Object.assign(new Error(`Operation ${record.operation_id ?? record.run_id ?? record.request_id ?? 'unknown'} (${record.status ?? 'unknown'}): ${cause}`),
  { code: 'ToubaStateRecoveryUnsafe' }); };

export function reviewWaitAbandonment({ checkpointPages, sessions, schedules, decisionFor, abandonOperations = false, quiescentEvidence = false }) {
  if (abandonOperations && !quiescentEvidence) refuse({}, 'effect and custody audits must establish a stopped, unambiguous state');
  const waits = [];
  const addInterrupted = record => {
    if (!record.operation_id || !record.run_id || !record.target_ref) refuse(record, 'missing correlation for closure');
    if (!waits.some(wait => wait.operation_id === record.operation_id && wait.run_id === record.run_id)) waits.push({
      record_kind: 'execution', operation_id: record.operation_id, run_id: record.run_id, target_ref: record.target_ref,
      previous_status: record.status, expires_at: null,
    });
  };
  for (const page of checkpointPages) for (const record of page) {
    if (record.record_kind === 'execution') {
      if (record.status === 'interrupted' && abandonOperations) addInterrupted(record);
      else if (!['completed', 'failed', 'cancelled'].includes(record.status)) refuse(record);
      continue;
    }
    if (!['pending', 'resolution_claimed'].includes(record.status)) continue;
    // An unfinished decision may already have dispatched an effect. Automatic
    // expiration/cancellation terminalization never releases the continuation.
    if (record.status === 'resolution_claimed'
      && !['expired', 'cancelled'].includes(record.human_wait.resolution?.kind) && !abandonOperations) refuse(record, 'decision claimed; use reviewed operation closure after effect reconciliation');
    if (decisionFor(record.request_id).length && !abandonOperations) refuse(record, 'decision recorded; use reviewed operation closure after effect reconciliation');
    waits.push({ request_id: record.request_id, run_id: record.run_id,
      operation_id: record.operation_id, target_ref: record.target_ref,
      previous_status: record.status, expires_at: record.human_wait.deadline_at });
  }
  for (const session of sessions) for (const operation of session.operations) {
    if (!['queued', 'running', 'awaiting_human', 'cancel_requested', 'interrupted'].includes(operation.status)) continue;
    if (operation.status === 'interrupted' && abandonOperations) { addInterrupted(operation); continue; }
    if (operation.status !== 'awaiting_human' || !waits.some(wait => wait.operation_id === operation.operation_id
      && wait.run_id === operation.run_id && wait.target_ref === operation.target_ref)) refuse(operation);
  }
  if (!waits.length) throw Object.assign(new Error('no waiting or interrupted operation to abandon'), { code: 'ToubaStateRecoveryEmpty' });
  for (const row of schedules) {
    if (!['running', 'pending', 'interrupted'].includes(row.status)) continue;
    if (!(row.status === 'pending' || abandonOperations && row.status === 'interrupted')
      || !waits.some(wait => wait.run_id === row.run_id && wait.target_ref === row.trigger_ref)) refuse(row);
  }
  return { waits: waits.sort((a, b) => (a.request_id ?? a.operation_id).localeCompare(b.request_id ?? b.operation_id)),
    disposition: 'abandon_without_execution', business_reconciliation_required: true };
}

export function auditRecoveryTriggerQueue(path, { retainDeadLetters = false } = {}) {
  const queue = createSqliteTriggerQueue({ filename: path, readOnly: true });
  let after = '', count = 0, active = 0, dead = 0;
  try {
    for (;;) {
      const page = queue.page({ after });
      count += page.entries.length;
      dead += page.entries.filter(row => row.status === 'dead_lettered').length;
      active += page.entries.filter(row => !['succeeded', 'failed'].includes(row.status)
        && !(retainDeadLetters && row.status === 'dead_lettered')).length;
      if (page.next === null) break;
      after = page.next;
    }
    return { entry_count: count, active_operations: active, dead_letters: dead };
  } finally { queue.close(); }
}

export function auditRecoveryTriggerState(path, pendingWaits = []) {
  const store = createSqliteTriggerStore({ filename: path, readOnly: true });
  try { return store.audit({ pendingWaits }); } finally { store.close(); }
}
