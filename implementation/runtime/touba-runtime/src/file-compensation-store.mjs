// @ts-check

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  COMPENSATION_STORE_SCHEMA_VERSION,
  sealCompensationRecord,
  validateCompensationRecord,
} from "./compensation-store.mjs";
import { containsResolvedSecretValue } from "./execution-checkpoints.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";

export { COMPENSATION_STORE_SCHEMA_VERSION };

const STORE_FIELDS = new Set(["schema_version", "records", "updated_at"]);

/**
 * Local single-process COMP-1 store. File replacement is atomic on the same
 * filesystem; the revision/digest CAS is checked immediately before it.
 *
 * @param {string} path
 * @param {{secretValues?: string[]}} [options]
 */
export function createFileCompensationStore(path, options = {}) {
  const secretValues = (options.secretValues ?? []).filter((value) => value.length > 0);
  loadCompensationStore(path, { secretValues });
  return Object.freeze({
    schemaVersion: COMPENSATION_STORE_SCHEMA_VERSION,

    read(compensationId) {
      const record = loadCompensationStore(path, { secretValues }).records[compensationId];
      return record === undefined ? null : structuredClone(record);
    },

    createIfAbsent(record) {
      const normalized = sealCompensationRecord(record);
      assertNoSecret(normalized, secretValues);
      const store = loadCompensationStore(path, { secretValues });
      const existing = store.records[normalized.compensation_id];
      if (existing !== undefined) return structuredClone(existing);
      if (normalized.revision !== 1) conflict();
      store.records[normalized.compensation_id] = normalized;
      save(path, store);
      return structuredClone(normalized);
    },

    compareAndSwap(compensationId, expectedRevision, expectedRecordDigest, nextRecord) {
      const store = loadCompensationStore(path, { secretValues });
      const current = store.records[compensationId];
      if (
        current === undefined
        || current.revision !== expectedRevision
        || current.record_digest !== expectedRecordDigest
      ) conflict();
      if (
        !nextRecord
        || nextRecord.compensation_id !== compensationId
        || nextRecord.revision !== current.revision + 1
      ) conflict();
      const normalized = sealCompensationRecord(nextRecord);
      assertTransition(current, normalized);
      assertNoSecret(normalized, secretValues);
      store.records[compensationId] = normalized;
      save(path, store);
      return structuredClone(normalized);
    },
  });
}

function assertTransition(current, next) {
  if (current.state === "terminal") conflict();
  for (const field of [
    "compensation_id",
    "compensation_request_id",
    "creation_command_digest",
    "operation_id",
    "run_id",
    "effect_scope_id",
    "compensates_effect_id",
    "created_at",
  ]) {
    if (current[field] !== next[field]) conflict();
  }
  if (
    current.original.tool_ref !== next.original.tool_ref
    || current.original.air_digest !== next.original.air_digest
    || current.original.entry_ref !== next.original.entry_ref
    || current.original.request_digest !== next.original.request_digest
    || current.inverse?.entry_ref !== next.inverse?.entry_ref
    || current.inverse?.tool_ref !== next.inverse?.tool_ref
    || current.inverse?.effect_id !== next.inverse?.effect_id
    || current.approval?.approval_ref !== next.approval?.approval_ref
  ) conflict();
  for (const field of ["execution_request_digest", "compatibility_digest"]) {
    if (current[field] !== null && current[field] !== next[field]) conflict();
  }
  if (current.inverse?.plan_digest !== null
    && current.inverse?.plan_digest !== next.inverse?.plan_digest) conflict();
  if (current.checkpoint !== null && next.checkpoint === null) conflict();
  if (
    next.processed_resume_requests.length < current.processed_resume_requests.length
    || current.processed_resume_requests.some((item, index) => (
      JSON.stringify(item) !== JSON.stringify(next.processed_resume_requests[index])
    ))
  ) conflict();
}

/** @param {string} path @param {{secretValues?: string[]}} [options] */
export function loadCompensationStore(path, { secretValues = [] } = {}) {
  if (!existsSync(path)) {
    return { schema_version: COMPENSATION_STORE_SCHEMA_VERSION, records: {} };
  }
  let store;
  try {
    store = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    invalid("compensation store is not valid JSON");
  }
  if (
    !store
    || typeof store !== "object"
    || Array.isArray(store)
    || store.schema_version !== COMPENSATION_STORE_SCHEMA_VERSION
    || !store.records
    || typeof store.records !== "object"
    || Array.isArray(store.records)
    || Object.keys(store).some((field) => !STORE_FIELDS.has(field))
  ) invalid("compensation store envelope is invalid");
  for (const [compensationId, record] of Object.entries(store.records)) {
    const normalized = validateCompensationRecord(record);
    if (normalized.compensation_id !== compensationId) invalid("compensation record key is invalid");
    store.records[compensationId] = normalized;
  }
  assertNoSecret(store, secretValues);
  return store;
}

function save(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  store.updated_at = new Date().toISOString();
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function assertNoSecret(value, secretValues) {
  if (containsResolvedSecretValue(value, secretValues)) {
    invalid("compensation store contains a resolved secret value");
  }
}

function invalid(message) {
  throw new RuntimeFailure(message, {}, "CompensationRecordInvalid");
}

function conflict() {
  throw new RuntimeFailure(
    "compensation record changed concurrently",
    {},
    "CompensationConflict",
  );
}
