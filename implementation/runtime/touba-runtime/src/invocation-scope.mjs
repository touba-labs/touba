// @ts-check

import { RuntimeFailure } from "./runtime-errors.mjs";

/**
 * Copy data at a host boundary without exposing an exception or raw payload.
 * This is value isolation, not confinement of arbitrary in-process host code.
 * @param {any} value
 * @param {string} [code]
 * @returns {any}
 */
export function snapshotInvocationValue(value, code = "InvalidInvocationValue") {
  try {
    return structuredClone(value);
  } catch {
    throw new RuntimeFailure("invocation data must support value isolation", {}, code);
  }
}

/**
 * An invocation owns its mutable lexical/control scope. Run-wide authority,
 * counters, cancellation and durable effect state are deliberately shared.
 * The three scalar result/allocation slots below also remain run-wide. A fork
 * must not restart call IDs or hide a pause from the public run lifecycle.
 *
 * This does not schedule parallel work. Parallel branches still need their own
 * continuation, checkpoint and join contract before they can be dispatched.
 * @param {Record<string, any>} parent
 * @returns {Record<string, any>}
 */
export function createInvocationScope(parent) {
  const run = parent.sharedRunRoot ?? parent;
  const scope = {
    ...parent,
    sharedRunRoot: run,
    // Copy the binding table here, not all caller payloads. Explicit argument
    // binding and host boundaries snapshot the values actually transferred.
    values: new Map(parent.values),
    valueTypes: new Map(parent.valueTypes),
    inputValueKeys: new Set(parent.inputValueKeys),
    callStack: [...parent.callStack],
    loopState: new Map(parent.loopState),
    skillPackProjectionTraces: new Set(parent.skillPackProjectionTraces),
  };
  for (const key of ["nextCallIndex", "pendingHumanApprovalCheckpoint", "pendingInteraction"]) {
    Object.defineProperty(scope, key, {
      enumerable: true,
      get: () => run[key],
      set: value => { run[key] = value; },
    });
  }
  return scope;
}
