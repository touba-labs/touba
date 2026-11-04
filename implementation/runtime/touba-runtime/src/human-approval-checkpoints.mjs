// @ts-check

import { payloadValueKind } from "./payload-validation.mjs";
import { RuntimeFailure, ToubaRuntimeError } from "./runtime-errors.mjs";
import { resolvedSecretEntries } from "./secret-redaction.mjs";
import { airDocumentDigest } from "./air-identity.mjs";
import { containsResolvedSecretValue } from "./execution-checkpoints.mjs";
import { canonicalDigest } from "./execution-checkpoints.mjs";
import { RUN_BUDGET_COUNTERS, RUN_BUDGET_KIND_SET } from "./runtime-budgets.mjs";
import { validateParallelState, createParallelRuntime } from "./parallel-execution.mjs";
import { validateApprovalState } from "./human-approval-policy.mjs";
export { airDocumentDigest } from "./air-identity.mjs";

export const HUMAN_APPROVAL_CHECKPOINT_VERSION = "touba-human-approval-checkpoint-v1";
export const MAX_INVOCATION_FRAMES = 64;

/** Structural validation shared by the runtime and persistent stores.
 * AIR membership and authority must additionally be checked before execution.
 * @param {Record<string, any>} checkpoint */
export function validateHumanCheckpointContinuation(checkpoint) {
  try { validateCheckpointContinuationBody(checkpoint); }
  catch (error) { throw checkpointKindError(checkpoint, error); }
}

/** @param {Record<string, any>} checkpoint @param {any} error */
export function checkpointKindError(checkpoint, error) {
  if (checkpoint.kind !== "parallel_group") return error;
  if (error.code === "InvalidHumanApprovalCheckpoint") return new RuntimeFailure(error.message, error.details, "InvalidParallelCheckpoint");
  if (error.code === "HumanApprovalCheckpointIncompatible") return new RuntimeFailure(error.message, error.details, "ParallelCheckpointIncompatible");
  return error;
}

/** @param {Record<string, any>} checkpoint */
function validateCheckpointContinuationBody(checkpoint) {
  const invalid = () => { throw new RuntimeFailure("checkpoint continuation is incomplete or invalid", {}, checkpoint.kind === "parallel_group" ? "InvalidParallelCheckpoint" : "InvalidHumanApprovalCheckpoint"); };
  if (Object.hasOwn(checkpoint, "call_frame") || !Array.isArray(checkpoint.call_stack)
    || checkpoint.call_stack.length > MAX_INVOCATION_FRAMES) invalid();
  validateCheckpointScope(checkpoint);
  if (checkpoint.approval_state !== undefined) validateApprovalState(checkpoint.approval_state);
  if (checkpoint.kind === "parallel_group") {
    const { parallel_digest, ...content } = checkpoint;
    if (parallel_digest !== canonicalDigest(content)) invalid();
    validateParallelState(checkpoint.parallel_state, createParallelRuntime({ parallelLimits: checkpoint.parallel_limits }).limits);
  }
  if (checkpoint.kind === "agent_human_review") validateAgentContinuationState(checkpoint.agent_loop_state);
  for (const frame of checkpoint.call_stack) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)
      || !["call_function", "call_tool", "call_skill", "call_strategy", "call_agent", "fallback", "agent_capability"].includes(frame.kind)) invalid();
    if (frame.kind === "agent_capability") {
      const fields = ["kind", "agent_ref", "caller_ref", "target_ref", "decision_mode", "capability_refs",
        "arguments", "caller_scope", "step_index", "next_step_index", "max_steps", "observations"];
      if (Object.keys(frame).some(key => !fields.includes(key)) || !["loop", "single"].includes(frame.decision_mode)) invalid();
      for (const key of ["agent_ref", "caller_ref", "target_ref"]) checkpointString(frame[key], `call_stack.${key}`);
      if (frame.caller_ref !== frame.agent_ref || !Array.isArray(frame.capability_refs)
        || frame.capability_refs.some(/** @param {unknown} ref */ ref => typeof ref !== "string")) invalid();
      mapFromCheckpointObject(frame.arguments, "call_stack.arguments");
      validateCheckpointScope(frame.caller_scope);
      if (frame.decision_mode === "loop") validateAgentContinuationState(frame);
      else if (["step_index", "next_step_index", "max_steps", "observations"].some(key => Object.hasOwn(frame, key))) invalid();
      continue;
    }
    const allowed = new Set(["kind", "graph_ref", "graph_owner_ref", "node_id", "caller_ref", "target_ref",
      "result_binding", "success_edge_role", "resume_target_ref", "caller_scope"]);
    if (Object.keys(frame).some(key => !allowed.has(key))) invalid();
    for (const key of ["graph_ref", "graph_owner_ref", "node_id", "caller_ref", "target_ref", "success_edge_role"]) {
      checkpointString(frame[key], `call_stack.${key}`);
    }
    for (const key of ["result_binding", "resume_target_ref"]) {
      if (frame[key] !== undefined && frame[key] !== null) checkpointString(frame[key], `call_stack.${key}`);
    }
    validateCheckpointScope(frame.caller_scope);
  }
  if (!checkpoint.effect_state || typeof checkpoint.effect_state !== "object"
    || Array.isArray(checkpoint.effect_state)
    || Object.keys(checkpoint.effect_state).sort().join(",") !== "external_tool_dispatches,next_effect_index") invalid();
  checkpointNonNegativeSafeInteger(checkpoint.effect_state.external_tool_dispatches, "effect_state.external_tool_dispatches");
  if (checkpointNonNegativeSafeInteger(checkpoint.effect_state.next_effect_index, "effect_state.next_effect_index") < 1
    || checkpointNonNegativeSafeInteger(checkpoint.next_call_index, "next_call_index") < 1) invalid();
}

/** @param {Record<string, any>} state */
export function validateAgentContinuationState(state) {
  const invalid = () => { throw new RuntimeFailure("agent continuation state is incomplete or invalid", {}, "InvalidHumanApprovalCheckpoint"); };
  if (!state || typeof state !== "object" || Array.isArray(state)) invalid();
  checkpointString(state.agent_ref, "agent_loop_state.agent_ref");
  for (const key of ["step_index", "next_step_index", "max_steps"]) checkpointNonNegativeSafeInteger(state[key], `agent_loop_state.${key}`);
  if (state.max_steps < 1 || state.step_index >= state.max_steps || state.next_step_index !== state.step_index + 1
    || !Array.isArray(state.capability_refs) || state.capability_refs.some(ref => typeof ref !== "string")
    || !Array.isArray(state.observations) || state.observations.length !== state.step_index) invalid();
  for (const [index, observation] of state.observations.entries()) {
    if (!observation || observation.step_index !== index
      || !["select_capability", "request_human_review"].includes(observation.action)
      || !Object.hasOwn(observation, "value") || typeof observation.result_type !== "string") invalid();
    if (observation.action === "select_capability") {
      checkpointString(observation.target_ref, "agent_loop_state.observations.target_ref");
      mapFromCheckpointObject(observation.arguments, "agent_loop_state.observations.arguments");
    }
  }
  checkpointJsonClone(state.observations, "agent_loop_state.observations");
}

/** @param {Record<string, any>} scope */
export function validateCheckpointScope(scope) {
  const invalid = () => { throw new RuntimeFailure("human checkpoint value scope is incomplete or invalid", {}, "InvalidHumanApprovalCheckpoint"); };
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) invalid();
  const values = mapFromCheckpointObject(scope.values, "values");
  const types = mapFromCheckpointObject(scope.value_types, "value_types");
  const loops = mapFromCheckpointObject(scope.loop_state, "loop_state");
  if (!Array.isArray(scope.input_value_keys) || new Set(scope.input_value_keys).size !== scope.input_value_keys.length
    || scope.input_value_keys.some(key => typeof key !== "string" || !values.has(key))
    || [...types].some(([key, value]) => !values.has(key) || typeof value !== "string")) invalid();
  for (const field of ["active_agent_ref", "active_caller_ref"]) {
    if (scope[field] !== null && (typeof scope[field] !== "string" || !scope[field])) invalid();
  }
  for (const cursor of loops.values()) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)
      || Object.keys(cursor).length !== 1 || !Object.hasOwn(cursor, "index")) invalid();
    checkpointNonNegativeSafeInteger(/** @type {{index: unknown}} */ (cursor).index, "loop_state.index");
  }
}

/** Validate persisted governance, never default missing consumption to zero.
 * @param {Record<string, any>} checkpoint */
export function validateHumanCheckpointBudgetState(checkpoint) {
  try { validateCheckpointBudgetBody(checkpoint); }
  catch (error) { throw checkpointKindError(checkpoint, error); }
}

/** @param {Record<string, any>} checkpoint */
function validateCheckpointBudgetBody(checkpoint) {
  checkpointNonNegativeSafeInteger(checkpoint.active_elapsed_ms, "active_elapsed_ms");
  const limits = mapFromCheckpointObject(checkpoint.effective_limits, "effective_limits");
  for (const [kind, value] of limits) {
    if (!RUN_BUDGET_KIND_SET.has(kind) || !Number.isSafeInteger(value) || Number(value) <= 0) {
      throw new RuntimeFailure("human checkpoint contains an invalid effective limit", {}, "InvalidHumanApprovalCheckpoint");
    }
  }
  const counters = mapFromCheckpointObject(checkpoint.budget_counters, "budget_counters");
  const fields = ["steps", "tool_calls", "agent_invocations", "provider_calls"];
  if (counters.size !== fields.length || fields.some(field => !counters.has(field))) {
    throw new RuntimeFailure("human checkpoint requires all run counters", {}, "InvalidHumanApprovalCheckpoint");
  }
  for (const [key, value] of counters) checkpointNonNegativeSafeInteger(value, `budget_counters.${key}`);
  // Keep the source/runtime mapping explicit; never accept an unknown counter.
  if (Object.keys(RUN_BUDGET_COUNTERS).length !== fields.length) {
    throw new RuntimeFailure("human checkpoint budget mapping is incomplete", {}, "InvalidHumanApprovalCheckpoint");
  }
}

/**
 * @typedef {Record<string, any>} CheckpointRecord
 */

/**
 * @param {unknown} checkpoint
 * @returns {CheckpointRecord | null}
 */
export function normalizeOptionalHumanApprovalCheckpoint(checkpoint) {
  if (checkpoint === undefined || checkpoint === null) {
    return null;
  }
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new ToubaRuntimeError("InvalidHumanApprovalCheckpoint", "human approval checkpoint must be an object");
  }
  const record = /** @type {CheckpointRecord} */ (checkpoint);
  if (record.checkpoint_schema_version !== HUMAN_APPROVAL_CHECKPOINT_VERSION) {
    throw new ToubaRuntimeError(
      record.kind === "parallel_group" ? "InvalidParallelCheckpoint" : "InvalidHumanApprovalCheckpoint",
      `checkpoint_schema_version must be ${HUMAN_APPROVAL_CHECKPOINT_VERSION}`,
      { actual: record.checkpoint_schema_version },
    );
  }
  return structuredClone(record);
}
/**
 * @param {{ air_schema_version: string, module: { id: string } }} document
 * @param {string} entryRef
 * @param {CheckpointRecord} checkpoint
 * @param {{ expectedScope?: string }} [options]
 */
export function validateHumanApprovalCheckpointCompatibility(document, entryRef, checkpoint, options = {}) {
  const expectedDigest = airDocumentDigest(document);
  const compatibilityErrors = [];
  if (checkpoint.air_schema_version !== document.air_schema_version) {
    compatibilityErrors.push("air_schema_version");
  }
  if (checkpoint.module_ref !== document.module.id) {
    compatibilityErrors.push("module_ref");
  }
  if (checkpoint.entry_ref !== entryRef) {
    compatibilityErrors.push("entry_ref");
  }
  if (checkpoint.air_digest !== expectedDigest) {
    compatibilityErrors.push("air_digest");
  }
  if (options.expectedScope !== undefined && checkpoint.scope !== options.expectedScope) {
    compatibilityErrors.push("scope");
  }
  if (compatibilityErrors.length > 0) {
    throw new RuntimeFailure(
      "human approval checkpoint is not compatible with this run",
      {
        entryRef,
        approvalRef: checkpoint.approval_ref,
        compatibilityErrors,
      },
      checkpoint.kind === "parallel_group" ? "ParallelCheckpointIncompatible" : "HumanApprovalCheckpointIncompatible",
    );
  }
}

/**
 * @param {Map<string, unknown>} map
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
export function checkpointObjectFromMap(map, label) {
  const value = Object.fromEntries(map.entries());
  return /** @type {Record<string, unknown>} */ (checkpointJsonClone(value, label));
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Map<string, unknown>}
 */
export function mapFromCheckpointObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be an object`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return new Map(Object.entries(/** @type {Record<string, unknown>} */ (checkpointJsonClone(value, label))));
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]}
 */
export function checkpointStringArray(value, label) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be an array of strings`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function checkpointString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be a non-empty string`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown[]}
 */
export function checkpointArray(value, label) {
  if (!Array.isArray(value)) {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be an array`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export function checkpointNonNegativeSafeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be a non-negative safe integer`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {WeakSet<object>} [ancestors]
 * @returns {unknown}
 */
export function checkpointJsonClone(value, path, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RuntimeFailure(
        `human approval checkpoint ${path} contains a non-finite number`,
        { path },
        "HumanApprovalCheckpointValueNotPortable",
      );
    }
    return value;
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value) || (!Array.isArray(value)
      && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
      throw new RuntimeFailure("human checkpoint contains cyclic or non-JSON data", {}, "HumanApprovalCheckpointValueNotPortable");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return Array.from(value, entry => checkpointJsonClone(entry, `${path}[*]`, ancestors));
      }
      /** @type {Record<string, unknown>} */
      const clone = {};
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) {
          throw new RuntimeFailure(
            `human approval checkpoint ${path}.* contains undefined`,
            { path: `${path}.*` },
            "HumanApprovalCheckpointValueNotPortable",
          );
        }
        Object.defineProperty(clone, key, { value: checkpointJsonClone(child, `${path}.*`, ancestors),
          enumerable: true, writable: true, configurable: true });
      }
      return clone;
    } finally { ancestors.delete(value); }
  }
  throw new RuntimeFailure(
    `human approval checkpoint ${path} contains a non-JSON value`,
    { path, valueKind: payloadValueKind(value) },
    "HumanApprovalCheckpointValueNotPortable",
  );
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function stringArraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

/**
 * @param {unknown} values
 * @param {{ secretStore?: import("./secret-redaction.mjs").SecretStore | null }} context
 * @param {string} approvalRef
 */
export function assertCheckpointHasNoResolvedSecret(values, context, approvalRef) {
  const leakedSecrets = resolvedSecretEntries(context.secretStore)
    .filter((entry) => entry.value.length > 0 && containsResolvedSecretValue(values, [entry.value]));
  if (leakedSecrets.length === 0) {
    return;
  }
  throw new RuntimeFailure(
    `human approval checkpoint contains a resolved secret value ${approvalRef}`,
    {
      approvalRef,
      secretHandlesRefused: leakedSecrets.map((entry) => entry.handle),
    },
    "SecretValueInHumanApprovalCheckpoint",
  );
}
