// @ts-check

import { payloadValueKind } from "./payload-validation.mjs";
import { RuntimeFailure, ToubaRuntimeError } from "./runtime-errors.mjs";
import { resolvedSecretEntries } from "./secret-redaction.mjs";
import { airDocumentDigest } from "./air-identity.mjs";
export { airDocumentDigest } from "./air-identity.mjs";

export const HUMAN_APPROVAL_CHECKPOINT_VERSION = "touba-human-approval-checkpoint-v1";

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
      "InvalidHumanApprovalCheckpoint",
      `checkpoint_schema_version must be ${HUMAN_APPROVAL_CHECKPOINT_VERSION}`,
      { actual: record.checkpoint_schema_version },
    );
  }
  return record;
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
      "HumanApprovalCheckpointIncompatible",
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
 * @returns {unknown}
 */
export function checkpointJsonClone(value, path) {
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
  if (Array.isArray(value)) {
    return value.map((entry, index) => checkpointJsonClone(entry, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const clone = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        throw new RuntimeFailure(
          `human approval checkpoint ${path}.${key} contains undefined`,
          { path: `${path}.${key}` },
          "HumanApprovalCheckpointValueNotPortable",
        );
      }
      clone[key] = checkpointJsonClone(child, `${path}.${key}`);
    }
    return clone;
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
  const serialized = JSON.stringify(values);
  if (typeof serialized !== "string") {
    return;
  }
  const leakedSecrets = resolvedSecretEntries(context.secretStore)
    .filter((entry) => entry.value.length > 0 && serialized.includes(entry.value));
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
