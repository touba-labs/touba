// @ts-check

import { createHash } from "node:crypto";
import { canonicalizeMachineValue } from "../../../contracts/machine/contracts.mjs";
import { containsResolvedSecretValue } from "./execution-checkpoints.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";

export const EFFECT_JOURNAL_SCHEMA_VERSION = "touba-effect-journal-v1";

export const EFFECT_OUTCOMES = Object.freeze([
  "applied",
  "not_applied",
  "unknown",
]);

export const EFFECT_STATES = Object.freeze([
  "prepared",
  "dispatched",
  ...EFFECT_OUTCOMES,
]);

const EFFECT_OUTCOME_SET = new Set(EFFECT_OUTCOMES);
const EFFECT_STATE_SET = new Set(EFFECT_STATES);
const EFFECT_RETRY_MODES = new Set(["idempotency_key", "reconcile", "none"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EFFECT_ID_PATTERN = /^effect:sha256:[0-9a-f]{64}$/u;
const RECEIPT_FIELDS = new Set([
  "effect_id",
  "request_digest",
  "outcome",
  "receipt_ref",
  "receipt_digest",
]);
const JOURNAL_ENTRY_FIELDS = new Set([
  "effect_id",
  "effect_scope_id",
  "air_digest",
  "entry_ref",
  "effect_index",
  "request_digest",
  "tool_ref",
  "retry_mode",
  "state",
  "attempt_count",
  "last_call_id",
  "receipt",
  "result",
]);
const MAX_OPAQUE_REF_LENGTH = 512;

/**
 * @typedef {object} EffectDescriptor
 * @property {string} effect_id
 * @property {number} attempt_index
 * @property {string} request_digest
 *
 * @typedef {object} EffectReceipt
 * @property {string} effect_id
 * @property {string} request_digest
 * @property {"applied" | "not_applied" | "unknown"} outcome
 * @property {string=} receipt_ref
 * @property {string=} receipt_digest
 *
 * @typedef {object} EffectJournalEntry
 * @property {string} effect_id
 * @property {string} effect_scope_id
 * @property {string} air_digest
 * @property {string} entry_ref
 * @property {number} effect_index
 * @property {string} request_digest
 * @property {string} tool_ref
 * @property {"idempotency_key" | "reconcile" | "none"} retry_mode
 * @property {"prepared" | "dispatched" | "applied" | "not_applied" | "unknown"} state
 * @property {number} attempt_count
 * @property {string=} last_call_id
 * @property {EffectReceipt=} receipt
 * @property {unknown=} result
 *
 * @typedef {object} EffectJournalAdapter
 * @property {string} schemaVersion
 * @property {(effectId: string) => EffectJournalEntry | null | Promise<EffectJournalEntry | null>} readEntry
 * @property {(entry: EffectJournalEntry) => void | Promise<void>} writeEntry
 * @property {((effectScopeId: string) => EffectJournalEntry[] | Promise<EffectJournalEntry[]>)=} entriesForScope
 */

/**
 * @param {{effectScopeId: string, airDigest: string, entryRef: string, effectIndex: number}} input
 * @returns {string}
 */
export function deriveEffectId(input) {
  const effectScopeId = requireBoundedString(input.effectScopeId, "effect_scope_id", "EffectContextRequired");
  const airDigest = requireSha256(input.airDigest, "air_digest", "EffectContextRequired");
  const entryRef = requireBoundedString(input.entryRef, "entry_ref", "EffectContextRequired");
  const effectIndex = requirePositiveSafeInteger(input.effectIndex, "effect_index", "EffectContextRequired");
  return `effect:sha256:${canonicalSha256({
    effect_scope_id: effectScopeId,
    air_digest: airDigest,
    entry_ref: entryRef,
    effect_index: effectIndex,
  })}`;
}

/**
 * @param {{airDigest: string, toolRef: string, arguments: unknown, resourceBindings: unknown, controlContext?: unknown}} input
 * @returns {string}
 */
export function deriveEffectRequestDigest(input) {
  const airDigest = requireSha256(input.airDigest, "air_digest", "EffectContextRequired");
  const toolRef = requireBoundedString(input.toolRef, "tool_ref", "EffectContextRequired");
  const material = {
    air_digest: airDigest,
    tool_ref: toolRef,
    arguments: input.arguments,
    resource_bindings: input.resourceBindings,
    ...(input.controlContext === undefined ? {} : { control_context: input.controlContext }),
  };
  return `sha256:${canonicalSha256(material)}`;
}

/**
 * @param {unknown} value
 * @returns {EffectJournalAdapter}
 */
export function requireEffectJournalAdapter(value) {
  if (!isPlainRecord(value)) {
    throw new RuntimeFailure(
      "external write requires a host effect journal",
      {},
      "EffectJournalRequired",
    );
  }
  if (value.schemaVersion !== EFFECT_JOURNAL_SCHEMA_VERSION) {
    throw new RuntimeFailure(
      `effect journal schemaVersion must be ${EFFECT_JOURNAL_SCHEMA_VERSION}`,
      { actual: value.schemaVersion },
      "EffectJournalRequired",
    );
  }
  if (typeof value.readEntry !== "function" || typeof value.writeEntry !== "function") {
    throw new RuntimeFailure(
      "effect journal must implement readEntry and writeEntry",
      {},
      "EffectJournalRequired",
    );
  }
  return /** @type {EffectJournalAdapter} */ (value);
}

/**
 * @param {EffectJournalAdapter} adapter
 * @param {string} effectId
 * @returns {Promise<EffectJournalEntry | null>}
 */
export async function readEffectJournalEntry(adapter, effectId) {
  let entry;
  try {
    entry = await adapter.readEntry(effectId);
  } catch {
    throw new RuntimeFailure(
      `effect journal read failed ${effectId}`,
      { effectId },
      "EffectJournalReadFailed",
    );
  }
  if (entry === null || entry === undefined) return null;
  return validateEffectJournalEntry(entry, effectId);
}

/**
 * @param {EffectJournalAdapter} adapter
 * @param {EffectJournalEntry} entry
 * @returns {Promise<EffectJournalEntry>}
 */
export async function writeEffectJournalEntry(adapter, entry) {
  const normalized = validateEffectJournalEntry(entry, entry.effect_id);
  const snapshot = structuredClone(normalized);
  try {
    await adapter.writeEntry(snapshot);
  } catch {
    throw new RuntimeFailure(
      `effect journal write failed ${entry.effect_id}`,
      { effectId: entry.effect_id },
      "EffectJournalWriteFailed",
    );
  }
  return normalized;
}

/**
 * @param {unknown} value
 * @param {{effectId?: string, requestDigest?: string, secretValues?: string[]}} [expected]
 * @returns {EffectReceipt}
 */
export function validateEffectReceipt(value, expected = {}) {
  if (!isPlainRecord(value)) {
    throw effectReceiptInvalid("effect_receipt must be an object", expected);
  }
  rejectUnknownFields(value, RECEIPT_FIELDS, "effect_receipt", expected);
  const effectId = requireReceiptEffectId(value.effect_id, "effect_receipt.effect_id", expected);
  const requestDigest = requireReceiptSha256(
    value.request_digest,
    "effect_receipt.request_digest",
    expected,
  );
  if (expected.effectId !== undefined && effectId !== expected.effectId) {
    throw effectReceiptInvalid("effect_receipt.effect_id does not match the request", expected);
  }
  if (expected.requestDigest !== undefined && requestDigest !== expected.requestDigest) {
    throw effectReceiptInvalid("effect_receipt.request_digest does not match the request", expected);
  }
  if (typeof value.outcome !== "string" || !EFFECT_OUTCOME_SET.has(value.outcome)) {
    throw effectReceiptInvalid("effect_receipt.outcome is invalid", expected);
  }
  /** @type {EffectReceipt} */
  const receipt = {
    effect_id: effectId,
    request_digest: requestDigest,
    outcome: /** @type {EffectReceipt["outcome"]} */ (value.outcome),
  };
  if (value.receipt_ref !== undefined) {
    receipt.receipt_ref = requireReceiptRef(value.receipt_ref, expected);
  }
  if (value.receipt_digest !== undefined) {
    receipt.receipt_digest = requireReceiptSha256(
      value.receipt_digest,
      "effect_receipt.receipt_digest",
      expected,
    );
  }
  canonicalJson(receipt, "EffectReceiptInvalid");
  if (containsResolvedSecretValue(receipt, expected.secretValues ?? [])) {
    throw effectReceiptInvalid("effect_receipt contains a resolved secret value", expected);
  }
  return Object.freeze(receipt);
}

/**
 * @param {unknown} value
 * @returns {EffectDescriptor}
 */
export function validateEffectDescriptor(value) {
  if (!isPlainRecord(value)) {
    throw new RuntimeFailure("effect must be an object", {}, "EffectContextRequired");
  }
  const keys = Object.keys(value);
  const allowed = new Set(["effect_id", "attempt_index", "request_digest"]);
  if (keys.some((key) => !allowed.has(key))) {
    throw new RuntimeFailure("effect contains unknown fields", {}, "EffectContextRequired");
  }
  return Object.freeze({
    effect_id: requireEffectId(value.effect_id, "effect.effect_id"),
    attempt_index: requirePositiveSafeInteger(
      value.attempt_index,
      "effect.attempt_index",
      "EffectContextRequired",
    ),
    request_digest: requireSha256(
      value.request_digest,
      "effect.request_digest",
      "EffectContextRequired",
    ),
  });
}

/**
 * @param {unknown} value
 * @param {string} expectedEffectId
 * @returns {EffectJournalEntry}
 */
export function validateEffectJournalEntry(value, expectedEffectId) {
  if (!isPlainRecord(value)) {
    throw journalInvalid(expectedEffectId, "effect journal entry must be an object");
  }
  const unknownFieldCount = Object.keys(value)
    .filter((key) => !JOURNAL_ENTRY_FIELDS.has(key)).length;
  if (unknownFieldCount > 0) {
    throw new RuntimeFailure(
      "effect journal entry contains unknown fields",
      { effectId: expectedEffectId, unknownFieldCount },
      "EffectJournalInvalid",
    );
  }
  const effectId = requireJournalEffectId(value.effect_id, expectedEffectId);
  if (effectId !== expectedEffectId) {
    throw journalInvalid(expectedEffectId, "effect journal returned a different effect_id");
  }
  const state = requireJournalEnum(value.state, EFFECT_STATE_SET, "state", expectedEffectId);
  const retryMode = requireJournalEnum(
    value.retry_mode,
    EFFECT_RETRY_MODES,
    "retry_mode",
    expectedEffectId,
  );
  /** @type {EffectJournalEntry} */
  const entry = {
    effect_id: effectId,
    effect_scope_id: requireJournalString(value.effect_scope_id, "effect_scope_id", expectedEffectId),
    air_digest: requireJournalSha256(value.air_digest, "air_digest", expectedEffectId),
    entry_ref: requireJournalString(value.entry_ref, "entry_ref", expectedEffectId),
    effect_index: requireJournalPositiveInteger(value.effect_index, "effect_index", expectedEffectId),
    request_digest: requireJournalSha256(value.request_digest, "request_digest", expectedEffectId),
    tool_ref: requireJournalString(value.tool_ref, "tool_ref", expectedEffectId),
    retry_mode: /** @type {EffectJournalEntry["retry_mode"]} */ (retryMode),
    state: /** @type {EffectJournalEntry["state"]} */ (state),
    attempt_count: requireJournalNonNegativeInteger(
      value.attempt_count,
      "attempt_count",
      expectedEffectId,
    ),
  };
  if (value.last_call_id !== undefined) {
    entry.last_call_id = requireJournalString(value.last_call_id, "last_call_id", expectedEffectId);
  }
  if (value.receipt !== undefined) {
    try {
      entry.receipt = validateEffectReceipt(value.receipt, {
        effectId,
        requestDigest: entry.request_digest,
      });
    } catch (error) {
      throw journalInvalid(expectedEffectId, errorMessage(error));
    }
  }
  if (Object.hasOwn(value, "result")) {
    assertJsonPortable(value.result, "EffectJournalInvalid");
    entry.result = structuredClone(value.result);
  }
  validateJournalStateInvariants(entry, expectedEffectId);
  return Object.freeze(entry);
}

/** @param {EffectJournalEntry} entry @param {string} effectId */
function validateJournalStateInvariants(entry, effectId) {
  const hasReceipt = Object.hasOwn(entry, "receipt");
  const hasResult = Object.hasOwn(entry, "result");
  const hasLastCallId = Object.hasOwn(entry, "last_call_id");

  if (entry.state === "prepared") {
    if (hasReceipt || hasResult) {
      throw journalInvalid(effectId, "prepared effect entry cannot contain receipt or result");
    }
    return;
  }

  if (entry.attempt_count < 1 || !hasLastCallId) {
    throw journalInvalid(
      effectId,
      `${entry.state} effect entry requires attempt_count >= 1 and last_call_id`,
    );
  }

  if (entry.state === "dispatched") {
    if (hasReceipt || hasResult) {
      throw journalInvalid(effectId, "dispatched effect entry cannot contain receipt or result");
    }
    return;
  }

  if (entry.state === "unknown") {
    if (hasResult) {
      throw journalInvalid(effectId, "unknown effect entry cannot contain result");
    }
    if (hasReceipt && entry.receipt?.outcome !== "unknown") {
      throw journalInvalid(effectId, "unknown effect entry receipt outcome must be unknown");
    }
    return;
  }

  if (!hasReceipt || entry.receipt?.outcome !== entry.state) {
    throw journalInvalid(
      effectId,
      `${entry.state} effect entry requires a receipt with the same outcome`,
    );
  }
  if (entry.state === "not_applied" && hasResult) {
    throw journalInvalid(effectId, "not_applied effect entry cannot contain result");
  }
}

/** @param {unknown} value @param {string} code */
export function assertJsonPortable(value, code = "EffectContextRequired") {
  canonicalJson(value, code);
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value @param {string} label @param {string} code */
function requireBoundedString(value, label, code) {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_OPAQUE_REF_LENGTH) {
    throw new RuntimeFailure(`${label} must be a non-empty bounded string`, {}, code);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {string} code @returns {number} */
function requirePositiveSafeInteger(value, label, code) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeFailure(`${label} must be a positive safe integer`, {}, code);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {string} code */
function requireSha256(value, label, code) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new RuntimeFailure(`${label} must be sha256:<hex>`, {}, code);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function requireEffectId(value, label) {
  if (typeof value !== "string" || !EFFECT_ID_PATTERN.test(value)) {
    throw new RuntimeFailure(`${label} is invalid`, {}, "EffectContextRequired");
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {Record<string, unknown>} expected */
function requireReceiptEffectId(value, label, expected) {
  if (typeof value !== "string" || !EFFECT_ID_PATTERN.test(value)) {
    throw effectReceiptInvalid(`${label} is invalid`, expected);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {Record<string, unknown>} expected */
function requireReceiptSha256(value, label, expected) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw effectReceiptInvalid(`${label} must be sha256:<hex>`, expected);
  }
  return value;
}

/** @param {unknown} value @param {Record<string, unknown>} expected */
function requireReceiptRef(value, expected) {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_OPAQUE_REF_LENGTH) {
    throw effectReceiptInvalid("effect_receipt.receipt_ref must be a non-empty bounded string", expected);
  }
  return value;
}

/** @param {Record<string, unknown>} value @param {Set<string>} allowed @param {string} label @param {Record<string, unknown>} expected */
function rejectUnknownFields(value, allowed, label, expected) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw effectReceiptInvalid(`${label} contains unknown fields`, {
      ...expected,
      unknownFieldCount: unknown.length,
    });
  }
}

/** @param {string} message @param {Record<string, unknown>} expected */
function effectReceiptInvalid(message, expected) {
  return new RuntimeFailure(message, {
    effectId: expected.effectId,
    requestDigest: expected.requestDigest,
    unknownFieldCount: expected.unknownFieldCount,
  }, "EffectReceiptInvalid");
}

/** @param {string} expectedEffectId @param {string} message */
function journalInvalid(expectedEffectId, message) {
  return new RuntimeFailure(message, { effectId: expectedEffectId }, "EffectJournalInvalid");
}

/** @param {unknown} value @param {string} expectedEffectId */
function requireJournalEffectId(value, expectedEffectId) {
  if (typeof value !== "string" || !EFFECT_ID_PATTERN.test(value)) {
    throw journalInvalid(expectedEffectId, "effect journal effect_id is invalid");
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {string} effectId */
function requireJournalString(value, field, effectId) {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_OPAQUE_REF_LENGTH) {
    throw journalInvalid(effectId, `effect journal ${field} is invalid`);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {string} effectId */
function requireJournalSha256(value, field, effectId) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw journalInvalid(effectId, `effect journal ${field} is invalid`);
  }
  return value;
}

/** @param {unknown} value @param {Set<string>} values @param {string} field @param {string} effectId */
function requireJournalEnum(value, values, field, effectId) {
  if (typeof value !== "string" || !values.has(value)) {
    throw journalInvalid(effectId, `effect journal ${field} is invalid`);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {string} effectId @returns {number} */
function requireJournalPositiveInteger(value, field, effectId) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw journalInvalid(effectId, `effect journal ${field} is invalid`);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {string} effectId @returns {number} */
function requireJournalNonNegativeInteger(value, field, effectId) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw journalInvalid(effectId, `effect journal ${field} is invalid`);
  }
  return value;
}

/** @param {unknown} value @param {string} code */
function canonicalJson(value, code) {
  try {
    return canonicalizeMachineValue(value);
  } catch (error) {
    throw new RuntimeFailure(
      "effect contract requires JSON-portable values",
      { cause: errorMessage(error) },
      code,
    );
  }
}

/** @param {unknown} value */
function canonicalSha256(value) {
  return createHash("sha256")
    .update(canonicalJson(value, "EffectContextRequired"))
    .digest("hex");
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
