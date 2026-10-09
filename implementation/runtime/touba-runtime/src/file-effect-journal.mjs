// @ts-check

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  EFFECT_JOURNAL_SCHEMA_VERSION,
  validateEffectJournalEntry,
} from "./effect-contract.mjs";
import { containsResolvedSecretValue } from "./execution-checkpoints.mjs";
import { ToubaRuntimeError } from "./runtime-errors.mjs";

export { EFFECT_JOURNAL_SCHEMA_VERSION };

const JOURNAL_FIELDS = new Set(["schema_version", "entries", "updated_at"]);
const EFFECT_ID_PATTERN = /^effect:sha256:[a-f0-9]{64}$/u;

/**
 * Local, single-process file adapter for the runtime effect state machine.
 * Complete entries are validated before an atomic file replacement. Hosts
 * own the path and process lifecycle; the runtime owns effect transitions.
 *
 * @param {string} path
 * @param {{secretValues?: string[]}} [options]
 */
export function createFileEffectJournal(path, options = {}) {
  const secretValues = (options.secretValues ?? []).filter((value) => value.length > 0);
  loadEffectJournal(path, { secretValues });
  return Object.freeze({
    schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,

    readEntry(effectId) {
      const entry = loadEffectJournal(path, { secretValues }).entries[effectId];
      return entry === undefined ? null : structuredClone(entry);
    },

    entriesForScope(effectScopeId) {
      return Object.values(loadEffectJournal(path, { secretValues }).entries)
        .filter((entry) => entry.effect_scope_id === effectScopeId)
        .map((entry) => structuredClone(entry));
    },

    writeEntry(entry) {
      if (
        !entry
        || typeof entry !== "object"
        || Array.isArray(entry)
        || typeof entry.effect_id !== "string"
        || !EFFECT_ID_PATTERN.test(entry.effect_id)
      ) {
        throw journalError("EffectJournalInvalid", "effect journal entry requires effect_id");
      }
      const normalized = validateEffectJournalEntry(entry, entry.effect_id);
      assertNoSecretValue(normalized, secretValues);
      const journal = loadEffectJournal(path, { secretValues });
      journal.entries[entry.effect_id] = structuredClone(normalized);
      saveEffectJournal(path, journal);
    },
  });
}

/**
 * @param {string} path
 * @param {{secretValues?: string[]}} [options]
 */
export function loadEffectJournal(path, { secretValues = [] } = {}) {
  if (!existsSync(path)) {
    return {
      schema_version: EFFECT_JOURNAL_SCHEMA_VERSION,
      entries: {},
    };
  }
  let journal;
  try {
    journal = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw journalError(
      "EffectJournalInvalid",
      "effect journal is not valid JSON",
    );
  }
  if (
    !journal
    || typeof journal !== "object"
    || Array.isArray(journal)
    || journal.schema_version !== EFFECT_JOURNAL_SCHEMA_VERSION
    || !journal.entries
    || typeof journal.entries !== "object"
    || Array.isArray(journal.entries)
  ) {
    throw journalError(
      "EffectJournalInvalid",
      `effect journal must use ${EFFECT_JOURNAL_SCHEMA_VERSION} with an entries object`,
    );
  }
  const unknownJournalFields = Object.keys(journal).filter((field) => !JOURNAL_FIELDS.has(field));
  if (unknownJournalFields.length > 0) {
    throw journalError("EffectJournalInvalid", "effect journal contains unknown fields");
  }
  for (const [effectId, entry] of Object.entries(journal.entries)) {
    if (!EFFECT_ID_PATTERN.test(effectId) || !isPlainRecord(entry)) {
      throw journalError("EffectJournalInvalid", "effect journal contains an invalid entry");
    }
    journal.entries[effectId] = structuredClone(validateEffectJournalEntry(entry, effectId));
  }
  assertNoSecretValue(journal, secretValues);
  return journal;
}

function saveEffectJournal(path, journal) {
  mkdirSync(dirname(path), { recursive: true });
  journal.updated_at = new Date().toISOString();
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function journalError(code, message) {
  return new ToubaRuntimeError(code, message);
}

function assertNoSecretValue(value, secretValues) {
  if (secretValues.length === 0) {
    return;
  }
  if (containsResolvedSecretValue(value, secretValues)) {
    throw journalError("EffectJournalInvalid", "effect journal contains a resolved secret value");
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
