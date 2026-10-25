import { createSqliteEffectJournal } from "../../runtime/touba-runtime/src/sqlite-effect-journal.mjs";

// Small-fixture projection for assertions only. Production consumers use the
// indexed API; this helper refuses an unexpectedly large test fixture.
export function readEffectJournalFixture(path) {
  const journal = createSqliteEffectJournal(path);
  const page = journal.page({ limit: 1000 });
  if (page.next && journal.page({ after: page.next, limit: 1 }).items.length) throw new Error("effect journal test fixture exceeds 1000 entries");
  return { schema_version: journal.schemaVersion,
    entries: Object.fromEntries(page.items.map(entry => [entry.effect_id, entry])) };
}
