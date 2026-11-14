import { preflightProcessToolHandler } from '../../../runtime/touba-runtime/src/handler-protocol.mjs';
import { handlerIsolationIdentity, sameHandlerIsolationIdentity, validHandlerIsolationObservation } from '../../../runtime/touba-runtime/src/handler-isolation-evidence.mjs';

// The authoritative journal belongs to the host. Project-authored reports,
// observations from another context and changed selected files cannot supply
// a current badge. This is execution evidence, not remote host attestation.
export function projectHandlerIsolation(binding, toolRef, traceStorage) {
  const result = { state: 'not_observed', preflight: 'unavailable', run_id: null, observed_at: null,
    outcome: null, evidence_ref: null };
  if (!binding) return { ...result, state: 'unavailable' };
  if (!binding.sandbox?.required) return { ...result, state: 'not_required', preflight: 'not_required' };
  try {
    const plan = preflightProcessToolHandler({ binding });
    result.preflight = 'available';
    if (typeof traceStorage?.handlerIsolation !== 'function') return result;
    const record = traceStorage.handlerIsolation(toolRef);
    if (!record) return result;
    if (typeof record.run_id !== 'string' || typeof record.observed_at !== 'string' || typeof record.event_id !== 'string'
      || record.run_id.length > 1024 || record.event_id.length > 2048 || !Number.isFinite(Date.parse(record.observed_at))
      || !validHandlerIsolationObservation(record.observation))
      return { ...result, state: 'unavailable' };
    const current = handlerIsolationIdentity(binding, plan);
    return { ...result, state: !current ? 'unavailable' : !sameHandlerIsolationIdentity(record.observation, current)
      ? 'stale' : record.observation.protocol_observed ? 'observed' : 'incomplete',
    run_id: record.run_id, observed_at: record.observed_at,
    outcome: record.observation.outcome, evidence_ref: record.event_id };
  } catch { return { ...result, state: 'unavailable' }; }
}
