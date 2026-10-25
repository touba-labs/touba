import { indexedStore } from "./sqlite-record-store.mjs";
import { migrateJsonState } from "./sqlite-state-migration.mjs";
import { EFFECT_JOURNAL_SCHEMA_VERSION, validateEffectJournalEntry } from "./effect-contract.mjs";
import { containsResolvedSecretValue } from "./execution-checkpoints.mjs";
import { ToubaRuntimeError } from "./runtime-errors.mjs";
export { EFFECT_JOURNAL_SCHEMA_VERSION };
const EFFECT_ID_PATTERN = /^effect:sha256:[a-f0-9]{64}$/u;

function journalStore(path, options = {}) {
  if (typeof path !== "string" || !path.endsWith(".sqlite")) throw journalError("EffectJournalPathInvalid", "effect journal must use a .sqlite path; migrate JSON explicitly");
  return indexedStore({ path, schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
    maxBytes: options.maxBytes, readOnly: options.readOnly,
    keyOf: entry => entry.effect_id,
    validate: entry => validateStoredEffectEntry(entry, entry?.effect_id, options),
    indexes: { effect_scope_id: "json_extract(body, '$.effect_scope_id')" },
  });
}

// The runtime owns transitions and authority. Hosts own execution admission;
// revision checks protect each stored update and no history is loaded at dispatch.
export function createSqliteEffectJournal(path, options = {}) {
  const store = journalStore(path, options);
  try { store.initialize(); }
  catch { throw journalError("EffectJournalInvalid", "effect journal is not a compatible SQLite store; no migration was performed"); }
  return Object.freeze({ schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
    readEntry(effectId) { return store.read([{ id: effectId }])[0] ?? null; },
    entriesForScope(effectScopeId) { return store.read([{ effect_scope_id: effectScopeId }]); },
    page(options) { return store.page(options); },
    writeEntry(entry) {
      validateStoredEffectEntry(entry, entry?.effect_id, options);
      const records = store.read([{ id: entry.effect_id }]);
      records.splice(0, records.length, structuredClone(entry)); store.write(records);
    },
  });
}

export function auditSqliteEffectJournal(path, options = {}) {
  const store = journalStore(path, options);
  let after, count = 0;
  for (;;) {
    const page = store.page({ after });
    if (!page.items.length) break;
    count += page.items.length; after = page.next;
  }
  return { schema_version: EFFECT_JOURNAL_SCHEMA_VERSION, entry_count: count };
}

export function migrateEffectJournal(options) {
  return migrateJsonState({ ...options,
    validate(document) {
      if (!isPlainRecord(document) || document.schema_version !== EFFECT_JOURNAL_SCHEMA_VERSION || !isPlainRecord(document.entries)
          || Object.keys(document).some(key => !["schema_version", "entries", "updated_at"].includes(key))) {
        throw journalError("EffectJournalInvalid", "invalid effect journal migration envelope");
      }
      return Object.entries(document.entries).map(([id, entry]) => validateStoredEffectEntry(entry, id, options));
    },
    build(filename, entries) {
      const store = journalStore(filename, options), records = store.read();
      records.push(...entries); store.write(records); store.initialize();
    },
  });
}

/** Shared persistence validation for local journal adapters.
 * @param {unknown} entry
 * @param {string} effectId
 * @param {{secretValues?: string[]}} [options]
 */
export function validateStoredEffectEntry(entry, effectId, { secretValues = [] } = {}) {
  if (!EFFECT_ID_PATTERN.test(effectId) || !isPlainRecord(entry)) {
    throw journalError("EffectJournalInvalid", "effect journal contains an invalid entry");
  }
  const normalized = validateEffectJournalEntry(entry, effectId);
  assertNoSecretValue(normalized, secretValues);
  return normalized;
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
