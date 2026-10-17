import { EFFECT_JOURNAL_SCHEMA_VERSION, validateStoredEffectEntry } from "@touba/runtime/file-effect-journal";
import { indexedStore } from "./indexed-store.mjs";

function journalStore(path, options) {
  return indexedStore({
    path,
    schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
    keyOf: entry => entry.effect_id,
    validate: entry => validateStoredEffectEntry(entry, entry?.effect_id, options),
    indexes: { effect_scope_id: "json_extract(body, '$.effect_scope_id')" },
  });
}

// The runtime owns the state machine and checks authority on dispatch. This
// adapter only persists its entries; construction does not scan the history.
export function createIndexedEffectJournal(path, options = {}) {
  const store = journalStore(path, options);
  return Object.freeze({
    schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
    readEntry(effectId) { return store.read([{ id: effectId }])[0] ?? null; },
    entriesForScope(effectScopeId) { return store.read([{ effect_scope_id: effectScopeId }]); },
    writeEntry(entry) {
      validateStoredEffectEntry(entry, entry?.effect_id, options);
      const records = store.read([{ id: entry.effect_id }]);
      records.splice(0, records.length, structuredClone(entry));
      store.write(records);
    },
  });
}

// Explicit full audit used at service startup, never on a per-effect dispatch.
export function loadIndexedEffectJournal(path) {
  const records = journalStore(path).read();
  return { schema_version: EFFECT_JOURNAL_SCHEMA_VERSION,
    entries: Object.fromEntries(records.map(entry => [entry.effect_id, entry])) };
}
