// @ts-check

import { createHash } from "node:crypto";
import { canonicalizeMachineValue } from "../../../contracts/machine/contracts.mjs";
import { RuntimeFailure, ToubaRuntimeError } from "./runtime-errors.mjs";

export const EXECUTION_CHECKPOINT_VERSION = "touba-run-checkpoint-v1";
const HUMAN_APPROVAL_CHECKPOINT_VERSION = "touba-run-checkpoint-v0.1";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CHECKPOINT_PHASES = new Set(["ready", "started", "completed"]);
const PENDING_PHASES = new Set(["reserved", "dispatched"]);
const EFFECT_KINDS = new Set(["none", "external_write"]);
const RETRY_MODES = new Set(["idempotency_key", "reconcile", "none"]);

const ROOT_FIELDS = new Set([
  "checkpoint_schema_version",
  "revision",
  "previous_checkpoint_digest",
  "checkpoint_digest",
  "operation_id",
  "run_id",
  "effect_scope_id",
  "entry_ref",
  "module_ref",
  "graph_ref",
  "compatibility",
  "cursor",
  "runtime_state",
  "pending_dispatch",
  "decisions_consumed",
  "trace_state",
]);

const COMPATIBILITY_FIELDS = new Set([
  "air_schema_version",
  "air_digest",
  "manifest_schema_version",
  "manifest_digest",
  "run_plan_digest",
  "resource_bindings_digest",
  "supply_chain_lock_digest",
  "hardened_profile_digest",
  "authority_artifacts_digest",
]);

const RUNTIME_STATE_FIELDS = new Set([
  "values",
  "value_types",
  "input_keys",
  "budget_counters",
  "effective_limits",
  "active_elapsed_ms",
  "next_call_index",
  "next_effect_index",
  "external_tool_dispatches",
]);

/**
 * @param {unknown} observer
 * @returns {((snapshot: {checkpoint: Record<string, any>, trace: Record<string, any>}) => unknown | Promise<unknown>) | null}
 */
export function normalizeExecutionCheckpointObserver(observer) {
  if (observer === undefined || observer === null) return null;
  if (typeof observer !== "function") {
    throw new ToubaRuntimeError(
      "InvalidRuntimeOption",
      "executionCheckpointObserver must be a function",
    );
  }
  return /** @type {(snapshot: {checkpoint: Record<string, any>, trace: Record<string, any>}) => unknown | Promise<unknown>} */ (observer);
}

/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
export function normalizeOptionalExecutionCheckpoint(value) {
  if (value === undefined || value === null) return null;
  return validateExecutionCheckpoint(value);
}

/**
 * Validate an untrusted durable execution checkpoint. The returned value is a
 * detached clone so a host cannot mutate runtime state after validation.
 *
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
export function validateExecutionCheckpoint(value) {
  const checkpoint = requireRecord(value, "checkpoint", "DurableResumeCheckpointInvalid");
  if (checkpoint.checkpoint_schema_version === HUMAN_APPROVAL_CHECKPOINT_VERSION) {
    throw new RuntimeFailure(
      "a human approval checkpoint cannot be migrated implicitly",
      { checkpointSchemaVersion: checkpoint.checkpoint_schema_version },
      "DurableResumeCheckpointMigrationRequired",
    );
  }
  if (checkpoint.checkpoint_schema_version !== EXECUTION_CHECKPOINT_VERSION) {
    throw invalidCheckpoint("checkpoint_schema_version is unsupported");
  }
  rejectUnknownFields(checkpoint, ROOT_FIELDS, "checkpoint");
  requirePositiveInteger(checkpoint.revision, "revision");
  requireNullableDigest(checkpoint.previous_checkpoint_digest, "previous_checkpoint_digest");
  if (
    (checkpoint.revision === 1 && checkpoint.previous_checkpoint_digest !== null)
    || (checkpoint.revision > 1 && checkpoint.previous_checkpoint_digest === null)
  ) {
    throw invalidCheckpoint(
      "previous_checkpoint_digest must be null only for checkpoint revision 1",
    );
  }
  requireDigest(checkpoint.checkpoint_digest, "checkpoint_digest");
  for (const field of [
    "operation_id",
    "run_id",
    "effect_scope_id",
    "entry_ref",
    "module_ref",
    "graph_ref",
  ]) {
    requireString(checkpoint[field], field);
  }
  if (checkpoint.operation_id !== checkpoint.effect_scope_id) {
    throw incompatibleCheckpoint("effect_scope_id must equal operation_id");
  }

  validateCompatibility(checkpoint.compatibility);
  validateCursor(checkpoint.cursor);
  validateRuntimeState(checkpoint.runtime_state);
  validatePendingDispatch(checkpoint.pending_dispatch, checkpoint);
  validateDecisions(checkpoint.decisions_consumed);
  validateTraceState(checkpoint.trace_state);

  const expectedDigest = digestCheckpoint(checkpoint);
  if (checkpoint.checkpoint_digest !== expectedDigest) {
    throw new RuntimeFailure(
      "durable execution checkpoint digest does not match its content",
      { revision: checkpoint.revision },
      "DurableResumeCheckpointIntegrityMismatch",
    );
  }
  return structuredClone(checkpoint);
}

/**
 * @param {Record<string, any>} checkpointWithoutDigest
 * @returns {Record<string, any>}
 */
export function sealExecutionCheckpoint(checkpointWithoutDigest) {
  const checkpoint = structuredClone(checkpointWithoutDigest);
  delete checkpoint.checkpoint_digest;
  checkpoint.checkpoint_digest = digestCheckpoint(checkpoint);
  return validateExecutionCheckpoint(checkpoint);
}

/**
 * @param {Record<string, any>} checkpoint
 * @returns {string}
 */
export function digestCheckpoint(checkpoint) {
  const unsigned = structuredClone(checkpoint);
  delete unsigned.checkpoint_digest;
  return canonicalDigest(unsigned);
}

/** @param {unknown} value @returns {string} */
export function canonicalDigest(value) {
  let canonical;
  try {
    canonical = canonicalizeMachineValue(value);
  } catch (error) {
    const invalidPath = firstNonCanonicalValuePath(value);
    throw invalidCheckpoint(
      `checkpoint state is not canonical JSON${invalidPath ? ` at ${invalidPath}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * @param {unknown} value
 * @param {string} [path]
 * @param {WeakSet<object>} [seen]
 * @returns {string | null}
 */
function firstNonCanonicalValuePath(value, path = "$", seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    if (seen.has(value)) return path;
    seen.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const invalidPath = firstNonCanonicalValuePath(value[index], `${path}[${index}]`, seen);
      if (invalidPath !== null) return invalidPath;
    }
    return null;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return path;
    seen.add(value);
    for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
      const invalidPath = firstNonCanonicalValuePath(
        /** @type {Record<string, unknown>} */ (value)[key],
        `${path}.*`,
        seen,
      );
      if (invalidPath !== null) return invalidPath;
    }
    return null;
  }
  return path;
}

/**
 * Chain only newly emitted events. The host can merge trace segments by their
 * absolute sequence indexes without retaining the raw prefix in the runtime.
 *
 * @param {string | null} previousPrefixDigest
 * @param {Record<string, any>} traceDocument
 * @param {number} localEventOffset
 * @returns {string}
 */
export function tracePrefixDigest(previousPrefixDigest, traceDocument, localEventOffset) {
  const events = Array.isArray(traceDocument.events)
    ? traceDocument.events.slice(localEventOffset)
    : [];
  return canonicalDigest({
    previous_prefix_digest: previousPrefixDigest,
    run: traceDocument.run,
    events,
  });
}

/**
 * @param {unknown} value
 * @param {string[]} resolvedSecretValues
 */
export function assertExecutionCheckpointHasNoResolvedSecret(value, resolvedSecretValues) {
  try {
    canonicalizeMachineValue(value);
  } catch (error) {
    throw invalidCheckpoint(
      `checkpoint state is not JSON-portable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (containsResolvedSecretValue(value, resolvedSecretValues)) {
    throw new RuntimeFailure(
      "durable execution checkpoint contains a resolved secret value",
      {},
      "DurableResumeAuthorityRefused",
    );
  }
}

/**
 * Search semantic string values before JSON escaping. Object keys are scanned
 * too because a credential used as a dynamic key is still persisted data.
 *
 * @param {unknown} value
 * @param {string[]} resolvedSecretValues
 * @returns {boolean}
 */
export function containsResolvedSecretValue(value, resolvedSecretValues) {
  const secrets = resolvedSecretValues.filter((secret) => secret.length > 0);
  if (secrets.length === 0) return false;
  /** @type {Set<object>} */
  const seen = new Set();
  /** @param {unknown} candidate @returns {boolean} */
  const visit = (candidate) => {
    if (typeof candidate === "string") {
      return secrets.some((secret) => candidate.includes(secret));
    }
    if (!candidate || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    return Object.entries(candidate).some(([key, item]) => visit(key) || visit(item));
  };
  return visit(value);
}

/** @param {unknown} value */
function validateCompatibility(value) {
  const compatibility = requireRecord(value, "compatibility", "DurableResumeCheckpointInvalid");
  rejectUnknownFields(compatibility, COMPATIBILITY_FIELDS, "compatibility");
  requireString(compatibility.air_schema_version, "compatibility.air_schema_version");
  requireDigest(compatibility.air_digest, "compatibility.air_digest");
  if (compatibility.manifest_schema_version !== null) {
    requireString(
      compatibility.manifest_schema_version,
      "compatibility.manifest_schema_version",
    );
  }
  for (const field of [
    "manifest_digest",
    "run_plan_digest",
    "resource_bindings_digest",
    "supply_chain_lock_digest",
    "hardened_profile_digest",
  ]) {
    requireNullableDigest(compatibility[field], `compatibility.${field}`);
  }
  requireDigest(
    compatibility.authority_artifacts_digest,
    "compatibility.authority_artifacts_digest",
  );
}

/** @param {unknown} value */
function validateCursor(value) {
  const cursor = requireRecord(value, "cursor", "DurableResumeCheckpointInvalid");
  rejectUnknownFields(cursor, new Set(["node_id", "phase"]), "cursor");
  if (cursor.node_id !== null) requireString(cursor.node_id, "cursor.node_id");
  if (!CHECKPOINT_PHASES.has(cursor.phase)) {
    throw invalidCheckpoint("cursor.phase is invalid");
  }
  if (cursor.phase !== "completed" && cursor.node_id === null) {
    throw invalidCheckpoint("an active cursor requires node_id");
  }
}

/** @param {unknown} value */
function validateRuntimeState(value) {
  const state = requireRecord(value, "runtime_state", "DurableResumeCheckpointInvalid");
  rejectUnknownFields(state, RUNTIME_STATE_FIELDS, "runtime_state");
  requireRecord(state.values, "runtime_state.values", "DurableResumeCheckpointInvalid");
  requireRecord(state.value_types, "runtime_state.value_types", "DurableResumeCheckpointInvalid");
  if (!Array.isArray(state.input_keys) || state.input_keys.some((item) => typeof item !== "string")) {
    throw invalidCheckpoint("runtime_state.input_keys must be a string array");
  }
  const counters = requireRecord(
    state.budget_counters,
    "runtime_state.budget_counters",
    "DurableResumeCheckpointInvalid",
  );
  rejectUnknownFields(
    counters,
    new Set(["steps", "tool_calls", "agent_invocations", "provider_calls"]),
    "runtime_state.budget_counters",
  );
  for (const field of ["steps", "tool_calls", "agent_invocations", "provider_calls"]) {
    requireNonNegativeInteger(counters[field], `runtime_state.budget_counters.${field}`);
  }
  const limits = requireRecord(
    state.effective_limits,
    "runtime_state.effective_limits",
    "DurableResumeCheckpointInvalid",
  );
  for (const limit of Object.values(limits)) {
    requirePositiveInteger(limit, "runtime_state.effective_limits.*");
  }
  requireNonNegativeInteger(state.active_elapsed_ms, "runtime_state.active_elapsed_ms");
  requirePositiveInteger(state.next_call_index, "runtime_state.next_call_index");
  requirePositiveInteger(state.next_effect_index, "runtime_state.next_effect_index");
  requireNonNegativeInteger(
    state.external_tool_dispatches,
    "runtime_state.external_tool_dispatches",
  );
}

/**
 * @param {unknown} value
 * @param {Record<string, any>} checkpoint
 */
function validatePendingDispatch(value, checkpoint) {
  if (value === null) return;
  const pending = requireRecord(value, "pending_dispatch", "DurableResumeCheckpointInvalid");
  const allowed = new Set([
    "node_id", "tool_ref", "call_id", "call_index", "effect_index", "effect_id",
    "request_digest", "effect_contract_kind", "retry_mode", "attempt_index", "phase",
    "timeout_ms", "budget_reserved",
  ]);
  rejectUnknownFields(pending, allowed, "pending_dispatch");
  requireString(pending.node_id, "pending_dispatch.node_id");
  requireString(pending.tool_ref, "pending_dispatch.tool_ref");
  requireString(pending.call_id, "pending_dispatch.call_id");
  requirePositiveInteger(pending.call_index, "pending_dispatch.call_index");
  requirePositiveInteger(pending.attempt_index, "pending_dispatch.attempt_index");
  requirePositiveInteger(pending.timeout_ms, "pending_dispatch.timeout_ms");
  if (!PENDING_PHASES.has(pending.phase)) {
    throw invalidCheckpoint("pending_dispatch.phase is invalid");
  }
  if (!EFFECT_KINDS.has(pending.effect_contract_kind)) {
    throw invalidCheckpoint("pending_dispatch.effect_contract_kind is invalid");
  }
  if (pending.effect_contract_kind === "external_write") {
    requirePositiveInteger(pending.effect_index, "pending_dispatch.effect_index");
    requireString(pending.effect_id, "pending_dispatch.effect_id");
    requireDigest(pending.request_digest, "pending_dispatch.request_digest");
    if (!RETRY_MODES.has(pending.retry_mode)) {
      throw invalidCheckpoint("pending_dispatch.retry_mode is invalid");
    }
    if (pending.effect_index !== checkpoint.runtime_state.next_effect_index - 1) {
      throw invalidCheckpoint(
        "pending effect_index must immediately precede next_effect_index",
      );
    }
  } else if (
    pending.effect_index !== null
    || pending.effect_id !== null
    || pending.request_digest !== null
    || pending.retry_mode !== null
  ) {
    throw invalidCheckpoint("kind none pending dispatch cannot carry effect identity");
  }
  if (checkpoint.runtime_state.next_call_index <= pending.call_index) {
    throw invalidCheckpoint("next_call_index must be greater than reserved call_index");
  }
  const expectedCallId = `call:${checkpoint.run_id}:${pending.call_index}`;
  if (pending.call_id !== expectedCallId) {
    throw incompatibleCheckpoint("pending dispatch call_id does not match its run and index");
  }
  const reserved = requireRecord(
    pending.budget_reserved,
    "pending_dispatch.budget_reserved",
    "DurableResumeCheckpointInvalid",
  );
  rejectUnknownFields(reserved, new Set(["tool_calls", "active_ms"]), "pending_dispatch.budget_reserved");
  if (reserved.tool_calls !== 1) {
    throw invalidCheckpoint("pending dispatch must reserve exactly one tool call");
  }
  requirePositiveInteger(reserved.active_ms, "pending_dispatch.budget_reserved.active_ms");
  if (reserved.active_ms !== pending.timeout_ms) {
    throw invalidCheckpoint(
      "pending dispatch active-time reservation must match its timeout",
    );
  }
  if (checkpoint.runtime_state.budget_counters.tool_calls < reserved.tool_calls) {
    throw invalidCheckpoint(
      "pending dispatch tool-call reservation must be reflected in runtime counters",
    );
  }
  if (checkpoint.runtime_state.active_elapsed_ms < reserved.active_ms) {
    throw invalidCheckpoint(
      "pending dispatch active-time reservation must be reflected in runtime counters",
    );
  }
}

/** @param {unknown} value */
function validateDecisions(value) {
  if (!Array.isArray(value)) {
    throw invalidCheckpoint("decisions_consumed must be an array");
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    const decision = requireRecord(
      item,
      `decisions_consumed[${index}]`,
      "DurableResumeCheckpointInvalid",
    );
    rejectUnknownFields(
      decision,
      new Set(["decision_ref", "result", "decision_digest"]),
      `decisions_consumed[${index}]`,
    );
    requireString(decision.decision_ref, `decisions_consumed[${index}].decision_ref`);
    requireString(decision.result, `decisions_consumed[${index}].result`);
    requireDigest(decision.decision_digest, `decisions_consumed[${index}].decision_digest`);
    if (seen.has(decision.decision_ref)) {
      throw invalidCheckpoint("decisions_consumed contains a duplicate decision_ref");
    }
    seen.add(decision.decision_ref);
  }
}

/** @param {unknown} value */
function validateTraceState(value) {
  const state = requireRecord(value, "trace_state", "DurableResumeCheckpointInvalid");
  rejectUnknownFields(state, new Set(["prefix_digest", "next_sequence_index"]), "trace_state");
  requireDigest(state.prefix_digest, "trace_state.prefix_digest");
  requireNonNegativeInteger(state.next_sequence_index, "trace_state.next_sequence_index");
}

/** @param {unknown} value @param {Set<string>} allowed @param {string} path */
function rejectUnknownFields(value, allowed, path) {
  const record = /** @type {Record<string, unknown>} */ (value);
  const unknownFields = Object.keys(record).filter((field) => !allowed.has(field));
  if (unknownFields.length > 0) {
    throw invalidCheckpoint(
      `${path} contains ${unknownFields.length} unknown field${unknownFields.length === 1 ? "" : "s"}`,
    );
  }
}

/** @param {unknown} value @param {string} path @param {string} code */
function requireRecord(value, path, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeFailure(`${path} must be an object`, { path }, code);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} path */
function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidCheckpoint(`${path} must be a non-empty string`);
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function requireDigest(value, path) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidCheckpoint(`${path} must be a sha256 digest`);
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function requireNullableDigest(value, path) {
  if (value !== null) requireDigest(value, path);
}

/** @param {unknown} value @param {string} path */
function requirePositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw invalidCheckpoint(`${path} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} path */
function requireNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidCheckpoint(`${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

/** @param {string} message */
function invalidCheckpoint(message) {
  return new RuntimeFailure(message, {}, "DurableResumeCheckpointInvalid");
}

/** @param {string} message */
function incompatibleCheckpoint(message) {
  return new RuntimeFailure(message, {}, "DurableResumeCheckpointIncompatible");
}
