import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createToubaProjectServer } from "../src/serve.mjs";
import { createSqliteEffectJournal, auditSqliteEffectJournal } from "../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs";
import { deriveEffectId } from "../../../runtime/touba-runtime/src/effect-contract.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;

for (const name of ["sandbox-checkpoints", "human-requests", "human-decisions", "project.effect-journal", "interaction-sessions", "interaction-assets"]) {
  test(`previous ${name} store blocks startup unchanged before recovery`, t => {
    const root = mkdtempSync(join(tmpdir(), "touba-previous-store-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".touba")); mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.tb"), "module test.compatibility\n");
    const oldPath = join(root, ".touba", `${name}.json`), bytes = Buffer.from('{"historical":"preserve exactly"}\n');
    writeFileSync(oldPath, bytes);
    assert.throws(() => createToubaProjectServer({ projectRoot: root, contractsRoot, quiet: true, port: 0 }),
      { code: "ToubaServeStoredStateIncompatible" });
    assert.deepEqual(readFileSync(oldPath), bytes);
    assert.equal(existsSync(join(root, ".touba", `${name}.sqlite`)), false);
  });
}

test("indexed effect journal validates selected entries, scopes and resolved secrets", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-indexed-effects-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "effects.sqlite"), secret = "private-resolved-token";
  const journal = createSqliteEffectJournal(path, { secretValues: [secret] });
  const entry = {
    effect_scope_id: "operation:one", air_digest: `sha256:${"a".repeat(64)}`, entry_ref: "strategy:incident/Resolve",
    effect_index: 1, request_digest: `sha256:${"b".repeat(64)}`, tool_ref: "tool:incident/Write",
    retry_mode: "idempotency_key", state: "prepared", attempt_count: 0,
  };
  entry.effect_id = deriveEffectId({ effectScopeId: entry.effect_scope_id, airDigest: entry.air_digest,
    entryRef: entry.entry_ref, effectIndex: entry.effect_index });
  journal.writeEntry(entry);
  assert.deepEqual(journal.readEntry(entry.effect_id), entry);
  assert.deepEqual(journal.entriesForScope("operation:one"), [entry]);
  assert.deepEqual(journal.entriesForScope("operation:other"), []);
  const bytes = readFileSync(path);
  assert.throws(() => journal.writeEntry({ ...entry, last_call_id: secret }), { code: "EffectJournalInvalid" });
  assert.deepEqual(readFileSync(path), bytes);
  const db = new DatabaseSync(path);
  try { db.prepare("UPDATE records SET body=? WHERE id=?").run(JSON.stringify({ ...entry, attempt_count: -1 }), entry.effect_id); }
  finally { db.close(); }
  assert.throws(() => journal.readEntry(entry.effect_id), { code: "EffectJournalInvalid" });
  assert.throws(() => auditSqliteEffectJournal(path), { code: "EffectJournalInvalid" });
});
