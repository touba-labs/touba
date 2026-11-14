import assert from "node:assert/strict";
import { ToubaEngineError, createEffectReceipt } from "./index.mjs";

/** Check protocol evidence for one test case, not the truth of a provider side effect. */
export function assertEffectReceipt(response, effect, outcome) {
  assert.ok(response && typeof response.ok === 'boolean', 'expected a handler response');
  const receipt = response.effect_receipt;
  assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'expected an effect receipt');
  const { effect_id, request_digest, ...options } = receipt;
  assert.equal(options.outcome, outcome, 'unexpected effect outcome');
  assert.deepEqual(receipt, createEffectReceipt(effect, options), 'receipt must match the exact effect request');
  return receipt;
}

/** Script model proposals only. Authority, schemas and effects remain runtime work.
 * Each step is { expect: { mode?, agent_ref?, step_index? }, decision: object|function }.
 * Exhaustion/mismatch fails; no authorized capability or result is invented.
 */
export function createScriptedDecisionProvider(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError("decision steps must be a non-empty array");
  const script = steps.map(step => {
    if (!step || typeof step !== "object" || Array.isArray(step)
      || Object.keys(step).some(key => !["expect", "decision"].includes(key))
      || !step.expect || typeof step.expect !== "object" || Array.isArray(step.expect)
      || Object.keys(step.expect).some(key => !["mode", "agent_ref", "step_index"].includes(key))
      || !(typeof step.decision === "function" || (step.decision && typeof step.decision === "object" && !Array.isArray(step.decision)))) {
      throw new TypeError("each step requires explicit expectations and a decision object or function");
    }
    return { expect: structuredClone(step.expect), decision: typeof step.decision === "function" ? step.decision : structuredClone(step.decision) };
  });
  let cursor = 0;
  const calls = [];
  const provider = async request => {
    assert.ok(cursor < script.length, "scripted decision provider exhausted");
    const step = script[cursor];
    for (const [key, value] of Object.entries(step.expect)) assert.deepEqual(request[key], value, `unexpected decision request ${key} at step ${cursor}`);
    cursor += 1;
    // Retain routing metadata only; prompts, inputs and observations are not logged.
    calls.push({ mode: request.mode, agent_ref: request.agent_ref, step_index: request.step_index });
    const decision = typeof step.decision === "function" ? await step.decision(request) : step.decision;
    return structuredClone(decision);
  };
  provider.assertConsumed = () => assert.equal(cursor, script.length, "unused scripted decision steps");
  Object.defineProperty(provider, "calls", { get: () => structuredClone(calls) });
  return provider;
}

export function assertRunSucceeded(result, expectedValue) {
  assert.equal(result?.status, "success", "expected a successful Touba run");
  assert.equal(result.reason, "completed", "expected runtime completion");
  assert.deepEqual(result.result, expectedValue);
  return result;
}

/** Accept only an actual runtime refusal, never compilation/launch failures. */
export async function assertRunRefused(run, expectedCode) {
  assert.equal(typeof run, "function", "provide a function invoking ToubaEngine.run");
  assert.ok(typeof expectedCode === "string" && expectedCode.length > 0, "provide the exact refusal code");
  let error;
  try { await run(); } catch (caught) { error = caught; }
  assert.ok(error instanceof ToubaEngineError && error.phase === "run", "expected a ToubaEngine runtime error");
  assert.equal(error.details.status, "failure", "expected runtime failure, not a launch error");
  assert.equal(error.details.reason, expectedCode);
  return { status: error.details.status, reason: error.details.reason, trace: error.details.trace };
}

/** Event counts are evidence about the trace, not proof of an external effect. */
export function assertTraceEvents(trace, { kind, count, where = () => true }) {
  assert.ok(Array.isArray(trace?.events), "expected native trace events");
  assert.ok(typeof kind === "string" && kind.length > 0, "provide an event kind");
  assert.ok(Number.isSafeInteger(count) && count >= 0, "provide an exact non-negative event count");
  assert.equal(typeof where, "function", "event filter must be a function");
  const events = trace.events.filter(event => {
    if (event.kind !== kind) return false;
    const matches = where(event);
    assert.equal(typeof matches, "boolean", "event filter must return a synchronous boolean");
    return matches;
  });
  assert.equal(events.length, count, `unexpected count for ${kind}`);
  return events;
}
