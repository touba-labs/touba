// @ts-check

import { indexedStore } from "./sqlite-record-store.mjs";
import { migrateJsonState } from "./sqlite-state-migration.mjs";

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
 * Durable COMP-1 records. SQLite checks the complete read revision in the same
 * transaction as the replacement; no history is loaded for a single operation.
 *
 * @param {string} path
 * @param {{secretValues?: string[], maxBytes?: number}} [options]
 */
export function createSqliteCompensationStore(path, options = {}) {
  if (typeof path !== "string" || !path.endsWith(".sqlite")) invalid("compensation store requires a .sqlite path; migrate JSON explicitly");
  const secretValues = (options.secretValues ?? []).filter((value) => value.length > 0);
  const store = indexedStore({ path, schemaVersion: COMPENSATION_STORE_SCHEMA_VERSION,
    maxBytes: options.maxBytes, readOnly: options.readOnly, keyOf: record => record.compensation_id,
    validate(record) { validateCompensationRecord(record); assertNoSecret(record, secretValues); },
    indexes: { state: "json_extract(body, '$.state')" },
  });
  store.initialize();
  function write(records) {
    try { store.write(records); }
    catch (error) { if (error.code === "ToubaStoreWriteConflict") conflict(); throw error; }
  }
  return Object.freeze({
    schemaVersion: COMPENSATION_STORE_SCHEMA_VERSION,
    page(options) { return store.page(options); },

    read(compensationId) {
      return store.read([{ id: compensationId }])[0] ?? null;
    },

    createIfAbsent(record) {
      const normalized = sealCompensationRecord(record);
      assertNoSecret(normalized, secretValues);
      const records = store.read([{ id: normalized.compensation_id }]);
      const existing = records[0];
      if (existing !== undefined) return structuredClone(existing);
      if (normalized.revision !== 1) conflict();
      records.push(normalized);
      try { write(records); }
      catch (error) {
        if (error.code !== "CompensationConflict") throw error;
        const winner = store.read([{ id: normalized.compensation_id }])[0];
        if (!winner) throw error;
        return winner;
      }
      return structuredClone(normalized);
    },

    compareAndSwap(compensationId, expectedRevision, expectedRecordDigest, nextRecord) {
      const records = store.read([{ id: compensationId }]);
      const current = records[0];
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
      records[0] = normalized;
      write(records);
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

function validateMigration(store, secretValues) {
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
  return Object.values(store.records);
}

export function migrateCompensationStore(options) {
  return migrateJsonState({ ...options,
    validate: document => validateMigration(document, options.secretValues ?? []),
    build(path, records) {
      const store = indexedStore({ path, schemaVersion: COMPENSATION_STORE_SCHEMA_VERSION,
        keyOf: record => record.compensation_id, validate: validateCompensationRecord,
        indexes: { state: "json_extract(body, '$.state')" },
      });
      const snapshot = store.read(); snapshot.push(...records); store.write(snapshot); store.initialize();
    },
  });
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
