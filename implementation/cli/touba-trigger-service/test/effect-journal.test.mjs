import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEffectJournalFixture } from "../../../tests/helpers/effect-journal.mjs";
import { auditSqliteEffectJournal, migrateEffectJournal } from "../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs";
import {
  EFFECT_JOURNAL_SCHEMA_VERSION,
  createSqliteEffectJournal,
  unknownEffectRetryDecision,
} from "../src/effect-journal.mjs";

const effectId = `effect:sha256:${"a".repeat(64)}`;
const otherEffectId = `effect:sha256:${"c".repeat(64)}`;

function validJournalEntry(overrides = {}) {
  return {
    effect_id: effectId,
    effect_scope_id: "queue:fixture:001",
    air_digest: `sha256:${"d".repeat(64)}`,
    entry_ref: "trigger:fixture/CreateOrder",
    effect_index: 1,
    request_digest: `sha256:${"b".repeat(64)}`,
    tool_ref: "tool:fixture/CreateOrder",
    retry_mode: "idempotency_key",
    state: "prepared",
    attempt_count: 0,
    ...overrides,
  };
}

test("persists complete runtime effect entries atomically and returns detached values", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-journal-"));
  try {
    const path = join(workspace, "runs.effect-journal.sqlite");
    const journal = createSqliteEffectJournal(path);
    assert.equal(journal.schemaVersion, EFFECT_JOURNAL_SCHEMA_VERSION);
    assert.equal(journal.readEntry(effectId), null);

    journal.writeEntry(validJournalEntry());

    const firstRead = journal.readEntry(effectId);
    firstRead.state = "tampered";
    assert.equal(journal.readEntry(effectId).state, "prepared");
    assert.equal(readdirSync(workspace).some((name) => name.endsWith(".tmp")), false);

    const stored = readEffectJournalFixture(path);
    assert.equal(stored.schema_version, "touba-effect-journal-v1");
    assert.equal(stored.entries[effectId].effect_scope_id, "queue:fixture:001");
    assert.equal(auditSqliteEffectJournal(path).entry_count, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses a malformed journal or effect identity without replacing durable data", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-journal-invalid-"));
  try {
    const path = join(workspace, "runs.effect-journal.sqlite");
    writeFileSync(path, JSON.stringify({ schema_version: "unknown", entries: {} }), "utf8");
    assert.throws(
      () => createSqliteEffectJournal(path),
      (error) => error?.code === "EffectJournalInvalid",
    );
    assert.equal(existsSync(path), true);

    rmSync(path);
    const journal = createSqliteEffectJournal(path);
    assert.throws(
      () => journal.writeEntry({ effect_id: "not-an-effect-id" }),
      (error) => error?.code === "EffectJournalInvalid",
    );
    assert.equal(auditSqliteEffectJournal(path).entry_count, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("migration refuses invalid states, unknown fields and resolved secret values before use", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-journal-strict-"));
  try {
    const path = join(workspace, "runs.effect-journal.sqlite");
    writeFileSync(path, JSON.stringify({
      schema_version: "touba-effect-journal-v1",
      entries: {
        [effectId]: validJournalEntry(),
        [otherEffectId]: validJournalEntry({
          effect_id: otherEffectId,
          effect_index: 2,
          state: "foreign_state",
        }),
      },
    }), "utf8");
    assert.throws(
      () => migrateEffectJournal({ source: path, destination: path + ".migrated.sqlite" }),
      (error) => error?.code === "EffectJournalInvalid",
    );

    writeFileSync(path, JSON.stringify({
      schema_version: "touba-effect-journal-v1",
      entries: {
        [effectId]: validJournalEntry({ vendor: "unknown" }),
      },
    }), "utf8");
    assert.throws(
      () => migrateEffectJournal({ source: path, destination: path + ".migrated.sqlite" }),
      (error) => error?.code === "EffectJournalInvalid",
    );

    rmSync(path);
    const journal = createSqliteEffectJournal(path, { secretValues: ["resolved-secret-fixture"] });
    assert.throws(
      () => journal.writeEntry(validJournalEntry({
        effect_scope_id: "queue:resolved-secret-fixture",
      })),
      (error) => error?.code === "EffectJournalInvalid",
    );
    assert.equal(auditSqliteEffectJournal(path).entry_count, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("blocks a mixed unknown scope unless every uncertain effect is idempotent", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-journal-mixed-"));
  try {
    const path = join(workspace, "runs.effect-journal.sqlite");
    const journal = createSqliteEffectJournal(path);
    journal.writeEntry(validJournalEntry({
      state: "unknown",
      attempt_count: 1,
      last_call_id: "call:fixture:1",
    }));
    journal.writeEntry(validJournalEntry({
      effect_id: otherEffectId,
      effect_index: 2,
      state: "unknown",
      attempt_count: 1,
      last_call_id: "call:fixture:2",
      retry_mode: "none",
    }));
    const mixed = journal.entriesForScope("queue:fixture:001");
    assert.equal(unknownEffectRetryDecision(mixed), false);

    journal.writeEntry(validJournalEntry({
      effect_id: otherEffectId,
      effect_index: 2,
      state: "unknown",
      attempt_count: 1,
      last_call_id: "call:fixture:2",
    }));
    assert.equal(
      unknownEffectRetryDecision(journal.entriesForScope("queue:fixture:001")),
      true,
    );
    assert.equal(unknownEffectRetryDecision([]), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
