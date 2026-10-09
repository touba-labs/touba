// @ts-check

import {
  canonicalDigest,
  validateExecutionCheckpoint,
} from "./execution-checkpoints.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";

export const COMPENSATION_STORE_SCHEMA_VERSION = "touba-compensation-store-v1";
export const COMPENSATION_RESULTS = Object.freeze([
  "completed",
  "partial",
  "unavailable",
  "failed",
  "unknown",
]);

const RESULT_SET = new Set(COMPENSATION_RESULTS);
const STATE_SET = new Set(["ready", "running", "action_required", "terminal"]);
const COMPENSATION_ID = /^compensation:sha256:[0-9a-f]{64}$/u;
const EFFECT_ID = /^effect:sha256:[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMAND_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const ROOT_FIELDS = new Set([
  "compensation_id",
  "compensation_request_id",
  "creation_command_digest",
  "execution_request_digest",
  "compatibility_digest",
  "revision",
  "record_digest",
  "operation_id",
  "run_id",
  "effect_scope_id",
  "compensates_effect_id",
  "original",
  "inverse",
  "approval",
  "state",
  "result",
  "blocker_code",
  "pre_checkpoint_trace_state",
  "checkpoint",
  "processed_resume_requests",
  "created_at",
  "updated_at",
]);

/** @param {unknown} value @returns {Record<string, any>} */
export function validateCompensationRecord(value) {
  const record = requireRecord(value, "record");
  rejectUnknown(record, ROOT_FIELDS, "record");
  requirePattern(record.compensation_id, COMPENSATION_ID, "compensation_id");
  requirePattern(record.compensates_effect_id, EFFECT_ID, "compensates_effect_id");
  requirePattern(record.compensation_request_id, COMMAND_ID, "compensation_request_id");
  requireDigest(record.creation_command_digest, "creation_command_digest");
  requireNullableDigest(record.execution_request_digest, "execution_request_digest");
  requireNullableDigest(record.compatibility_digest, "compatibility_digest");
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) invalid("revision is invalid");
  requireDigest(record.record_digest, "record_digest");
  const expected = compensationRecordDigest(record);
  if (record.record_digest !== expected) {
    invalid("record digest does not match its content", "CompensationRecordDigestMismatch");
  }
  if (
    record.operation_id !== record.compensation_id
    || record.effect_scope_id !== record.compensation_id
    || typeof record.run_id !== "string"
    || record.run_id.length === 0
    || record.run_id.length > 256
  ) invalid("record identities are inconsistent");
  validateOriginal(record.original, record.compensates_effect_id);
  validateInverse(record.inverse);
  validateApproval(record.approval, record.compensation_id, record.inverse);
  if (!STATE_SET.has(record.state)) invalid("state is invalid");
  if (record.result !== null && !RESULT_SET.has(record.result)) invalid("result is invalid");
  if (record.blocker_code !== null && !isBoundedString(record.blocker_code, 128)) {
    invalid("blocker_code is invalid");
  }
  validateLifecycle(record);
  const preTrace = record.pre_checkpoint_trace_state;
  if (record.checkpoint === null) {
    validateTraceState(preTrace);
  } else {
    if (preTrace !== null) invalid("pre-checkpoint trace state must be cleared");
    const checkpoint = validateExecutionCheckpoint(record.checkpoint);
    if (
      checkpoint.operation_id !== record.compensation_id
      || checkpoint.effect_scope_id !== record.compensation_id
      || checkpoint.run_id !== record.run_id
      || checkpoint.entry_ref !== record.inverse?.entry_ref
    ) invalid("checkpoint identities do not match the record", "CompensationCheckpointIncompatible");
  }
  if (!Array.isArray(record.processed_resume_requests) || record.processed_resume_requests.length > 64) {
    invalid("processed_resume_requests is invalid");
  }
  const resumeIds = new Set();
  for (const item of record.processed_resume_requests) {
    const request = requireRecord(item, "processed_resume_requests item");
    rejectUnknown(request, new Set(["resume_request_id", "resume_request_digest"]), "resume request");
    requirePattern(request.resume_request_id, COMMAND_ID, "resume_request_id");
    requireDigest(request.resume_request_digest, "resume_request_digest");
    if (resumeIds.has(request.resume_request_id)) invalid("duplicate resume request id");
    resumeIds.add(request.resume_request_id);
  }
  requireTimestamp(record.created_at, "created_at");
  requireTimestamp(record.updated_at, "updated_at");
  if (Date.parse(record.updated_at) < Date.parse(record.created_at)) {
    invalid("updated_at precedes created_at");
  }
  return structuredClone(record);
}

function validateLifecycle(record) {
  const planned = record.execution_request_digest !== null
    || record.compatibility_digest !== null
    || (record.inverse !== null && record.inverse.plan_digest !== null);
  const fullyPlanned = record.execution_request_digest !== null
    && record.compatibility_digest !== null
    && record.inverse?.plan_digest !== null;
  if (planned !== fullyPlanned) invalid("compensation plan digests are incomplete");
  if (record.checkpoint !== null && !fullyPlanned) {
    invalid("checkpoint requires a complete compensation plan", "CompensationCheckpointIncompatible");
  }
  if (record.inverse === null && (
    record.approval !== null
    || fullyPlanned
    || record.checkpoint !== null
    || record.state !== "terminal"
    || record.result !== "unavailable"
  )) invalid("missing inverse is only valid for terminal unavailable");
  if (["ready", "running"].includes(record.state) && (
    record.result !== null
    || record.blocker_code !== null
    || !fullyPlanned
    || record.inverse === null
  )) invalid(`${record.state} lifecycle fields are inconsistent`);
  if (record.state === "action_required" && (
    record.blocker_code === null
    || ![null, "failed", "unknown"].includes(record.result)
  )) invalid("action_required lifecycle fields are inconsistent");
  if (record.state === "terminal" && !["completed", "partial", "unavailable"].includes(record.result)) {
    invalid("terminal lifecycle result is invalid");
  }
  if (["completed", "partial"].includes(record.result) && (
    record.state !== "terminal"
    || record.blocker_code !== null
    || !fullyPlanned
    || record.inverse === null
  )) invalid("applied terminal lifecycle fields are inconsistent");
  if (record.result === "unavailable" && (
    record.state !== "terminal"
    || record.blocker_code !== "CompensationUnavailable"
  )) invalid("unavailable lifecycle fields are inconsistent");
}

/** @param {Record<string, any>} value @returns {Record<string, any>} */
export function sealCompensationRecord(value) {
  const record = structuredClone(value);
  delete record.record_digest;
  record.record_digest = compensationRecordDigest(record);
  return validateCompensationRecord(record);
}

/** @param {Record<string, any>} value @returns {string} */
export function compensationRecordDigest(value) {
  const unsigned = structuredClone(value);
  delete unsigned.record_digest;
  return canonicalDigest(unsigned);
}

/** @param {unknown} value @returns {Record<string, any>} */
export function requireCompensationStoreAdapter(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== COMPENSATION_STORE_SCHEMA_VERSION
    || typeof value.read !== "function"
    || typeof value.createIfAbsent !== "function"
    || typeof value.compareAndSwap !== "function"
  ) {
    throw new RuntimeFailure(
      "COMP-1 requires a compensation store adapter",
      {},
      "CompensationRecordInvalid",
    );
  }
  return /** @type {Record<string, any>} */ (value);
}

function validateOriginal(value, compensatesEffectId) {
  const original = requireRecord(value, "original");
  rejectUnknown(original, new Set([
    "tool_ref", "air_digest", "entry_ref", "request_digest", "journal_state", "effect_receipt",
  ]), "original");
  requireBoundedString(original.tool_ref, "original.tool_ref");
  requireDigest(original.air_digest, "original.air_digest");
  requireBoundedString(original.entry_ref, "original.entry_ref");
  requireDigest(original.request_digest, "original.request_digest");
  if (!["prepared", "dispatched", "applied", "not_applied", "unknown"].includes(original.journal_state)) {
    invalid("original.journal_state is invalid");
  }
  if (original.effect_receipt !== null) {
    const receipt = requireRecord(original.effect_receipt, "original.effect_receipt");
    if (receipt.effect_id !== compensatesEffectId || receipt.request_digest !== original.request_digest) {
      invalid("original effect receipt is not correlated");
    }
  }
}

function validateInverse(value) {
  if (value === null) return;
  const inverse = requireRecord(value, "inverse");
  rejectUnknown(inverse, new Set(["entry_ref", "tool_ref", "effect_id", "plan_digest"]), "inverse");
  requireBoundedString(inverse.entry_ref, "inverse.entry_ref");
  requireBoundedString(inverse.tool_ref, "inverse.tool_ref");
  requirePattern(inverse.effect_id, EFFECT_ID, "inverse.effect_id");
  requireNullableDigest(inverse.plan_digest, "inverse.plan_digest");
}

function validateApproval(value, compensationId, inverse) {
  if (value === null) return;
  if (inverse === null) invalid("approval requires an inverse plan");
  const approval = requireRecord(value, "approval");
  rejectUnknown(approval, new Set(["approval_ref", "evidence", "evidence_digest"]), "approval");
  requireBoundedString(approval.approval_ref, "approval.approval_ref");
  if (approval.evidence === null) {
    if (approval.evidence_digest !== null) invalid("missing evidence must have a null digest");
    return;
  }
  const evidence = requireRecord(approval.evidence, "approval.evidence");
  rejectUnknown(evidence, new Set([
    "schema_version", "approval_id", "approval_ref", "subject_ref", "decision", "decided_at", "expires_at",
  ]), "approval.evidence");
  if (
    evidence.schema_version !== "touba-compensation-approval-v1"
    || evidence.approval_ref !== approval.approval_ref
    || evidence.subject_ref !== compensationId
    || evidence.decision !== "approved"
    || !isBoundedString(evidence.approval_id, 512)
  ) invalid("approval evidence is invalid");
  requireTimestamp(evidence.decided_at, "approval.evidence.decided_at");
  requireTimestamp(evidence.expires_at, "approval.evidence.expires_at");
  if (Date.parse(evidence.expires_at) <= Date.parse(evidence.decided_at)) {
    invalid("approval evidence window is invalid");
  }
  requireDigest(approval.evidence_digest, "approval.evidence_digest");
  if (approval.evidence_digest !== canonicalDigest(evidence)) invalid("approval evidence digest is invalid");
}

function validateTraceState(value) {
  const state = requireRecord(value, "pre_checkpoint_trace_state");
  rejectUnknown(state, new Set(["prefix_digest", "next_sequence_index"]), "trace state");
  requireDigest(state.prefix_digest, "trace prefix_digest");
  if (!Number.isSafeInteger(state.next_sequence_index) || state.next_sequence_index < 0) {
    invalid("trace next_sequence_index is invalid");
  }
}

function requireRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
  return /** @type {Record<string, any>} */ (value);
}

function rejectUnknown(value, allowed, field) {
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(`${field} contains unknown fields`);
}

function requireNullableDigest(value, field) {
  if (value !== null) requireDigest(value, field);
}

function requireDigest(value, field) {
  requirePattern(value, DIGEST, field);
}

function requirePattern(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) invalid(`${field} is invalid`);
}

function requireBoundedString(value, field) {
  if (!isBoundedString(value, 512)) invalid(`${field} is invalid`);
}

function isBoundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function requireTimestamp(value, field) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) invalid(`${field} is invalid`);
}

function invalid(message, code = "CompensationRecordInvalid") {
  throw new RuntimeFailure(message, {}, code);
}
