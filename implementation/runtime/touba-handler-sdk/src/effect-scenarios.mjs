import assert from 'node:assert/strict';
import { createEffectReceipt } from './index.mjs';

const cases = new Set(['duplicate', 'lost_reply', 'reconciliation_required']);
const interruptionCodes = new Set(['ToolHandlerTimeout', 'ToolHandlerReportedError', 'ToolHandlerNonZeroExit', 'EffectReceiptInvalid']);
const digest = /^sha256:[a-f0-9]{64}$/;

function fields(value, required, optional = []) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'expected a scenario object');
  assert.ok(required.every(key => Object.hasOwn(value, key)), 'missing scenario field');
  assert.ok(Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'unexpected scenario field');
}

/** Assert one explicitly declared, synthetic-service experiment.
 * The author collects observations from the service and the reopened runtime
 * journal. This helper executes no handler, grants no authority and retries
 * nothing. A passing assertion is author-test evidence, not certification of
 * the observation source or of any production provider.
 */
export function assertEffectScenario(scenario, observations) {
  fields(scenario, ['schema_version', 'id', 'tool_ref', 'case']);
  assert.equal(scenario.schema_version, 'touba-effect-scenario-v1');
  assert.ok(typeof scenario.id === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(scenario.id), 'invalid scenario id');
  assert.ok(typeof scenario.tool_ref === 'string' && /^tool:[a-z_][a-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(scenario.tool_ref), 'invalid tool reference');
  assert.ok(cases.has(scenario.case), 'unsupported effect scenario');
  fields(observations, ['before', 'runs']);
  serviceCounts(observations.before, 0, 0);
  assert.ok(Array.isArray(observations.runs) && observations.runs.length === 3, 'observe initial execution, reopen/resume, then reopen/replay');
  let identity;
  const evidence = observations.runs.map((run, index) => {
    fields(run, ['status', 'reason', 'effect', 'service']);
    fields(run.effect, ['tool_ref', 'effect_id', 'request_digest', 'state', 'attempt_count'], ['receipt']);
    const effect = run.effect;
    assert.equal(effect.tool_ref, scenario.tool_ref, 'effect belongs to another tool');
    assert.ok(typeof effect.effect_id === 'string' && /^effect:sha256:[a-f0-9]{64}$/.test(effect.effect_id));
    assert.ok(typeof effect.request_digest === 'string' && digest.test(effect.request_digest));
    identity ??= [effect.effect_id, effect.request_digest];
    assert.deepEqual([effect.effect_id, effect.request_digest], identity, 'replay must retain exact effect identity and arguments');
    const interrupted = scenario.case !== 'duplicate' && index === 0;
    const pending = scenario.case === 'reconciliation_required';
    const applied = !interrupted && !pending;
    const calls = scenario.case === 'lost_reply' && index > 0 ? 2 : 1;
    assert.equal(effect.attempt_count, calls, 'unexpected handler dispatch count');
    serviceCounts(run.service, calls, 1);
    assert.equal(run.status, applied ? 'success' : 'failure', 'unexpected scenario run status');
    assert.equal(effect.state, applied ? 'applied' : 'unknown');
    if (interrupted) assert.ok(interruptionCodes.has(run.reason), 'expected a post-dispatch interruption, not a compile or admission error');
    else assert.equal(run.reason, applied ? 'completed' : 'EffectReconciliationRequired');
    if (applied) {
      const receipt = effect.receipt;
      assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'missing applied receipt');
      assert.equal(receipt.outcome, 'applied');
      const { effect_id, request_digest, ...options } = receipt;
      assert.deepEqual(receipt, createEffectReceipt({ effect_id: effect.effect_id, request_digest: effect.request_digest,
        attempt_index: effect.attempt_count }, options), 'receipt must match the observed effect');
    } else assert.equal(effect.receipt, undefined, 'an interrupted scenario must retain uncertainty without an applied receipt');
    // Do not include result values, arguments, provider identifiers or receipts.
    return { status: run.status, reason: run.reason, state: effect.state, calls, writes: 1 };
  });
  return { schema_version: 'touba-effect-scenario-result-v1', scenario: { ...scenario },
    scope: 'author_test_synthetic_service', status: 'passed', observations: evidence };
}

function serviceCounts(value, calls, writes) {
  fields(value, ['calls', 'writes']);
  assert.ok(Number.isSafeInteger(value.calls) && Number.isSafeInteger(value.writes), 'service counters must be integers');
  assert.equal(value.calls, calls, 'unexpected requests observed by the test service');
  assert.equal(value.writes, writes, 'unexpected committed writes observed by the test service');
}
