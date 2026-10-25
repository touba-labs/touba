import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  compensationRecordDigest,
  sealCompensationRecord,
} from "../src/compensation-store.mjs";
import { createSqliteCompensationStore, migrateCompensationStore, COMPENSATION_STORE_SCHEMA_VERSION } from "../src/sqlite-compensation-store.mjs";

test("persists one current compensation record and applies exact CAS", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-store-"));
  try {
    const path = join(workspace, "compensations.sqlite");
    const store = createSqliteCompensationStore(path);
    const initial = recordFixture();
    const created = store.createIfAbsent(initial);
    assert.deepEqual(store.read(initial.compensation_id), created);
    assert.equal(created.record_digest, compensationRecordDigest(created));

    const next = sealCompensationRecord({
      ...created,
      revision: 2,
      state: "action_required",
      result: "unknown",
      blocker_code: "CompensationOriginalOutcomeUnknown",
      updated_at: "2026-09-22T10:01:00.000Z",
    });
    const replaced = store.compareAndSwap(
      created.compensation_id,
      created.revision,
      created.record_digest,
      next,
    );
    assert.equal(replaced.revision, 2);
    assert.throws(
      () => store.compareAndSwap(created.compensation_id, 1, created.record_digest, next),
      (error) => error?.code === "CompensationConflict",
    );
    const terminal = sealCompensationRecord({
      ...replaced,
      revision: 3,
      state: "terminal",
      result: "unavailable",
      blocker_code: "CompensationUnavailable",
      updated_at: "2026-09-22T10:02:00.000Z",
    });
    const sealedTerminal = store.compareAndSwap(
      replaced.compensation_id,
      replaced.revision,
      replaced.record_digest,
      terminal,
    );
    assert.throws(
      () => store.compareAndSwap(
        sealedTerminal.compensation_id,
        sealedTerminal.revision,
        sealedTerminal.record_digest,
        sealCompensationRecord({
          ...sealedTerminal,
          revision: 4,
          updated_at: "2026-09-22T10:03:00.000Z",
        }),
      ),
      (error) => error?.code === "CompensationConflict",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses digest corruption and resolved secrets before persistence", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-store-integrity-"));
  try {
    const path = join(workspace, "compensations.sqlite");
    const secret = "resolved-secret-never-persist";
    const store = createSqliteCompensationStore(path, { secretValues: [secret] });
    const initial = recordFixture();
    store.createIfAbsent(initial);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE records SET body=json_set(body, '$.state', 'terminal') WHERE id=?").run(initial.compensation_id);
    db.close();
    assert.throws(
      () => store.read(initial.compensation_id),
      (error) => error?.code === "CompensationRecordDigestMismatch",
    );

    const secondPath = join(workspace, "secret.sqlite");
    const secretStore = createSqliteCompensationStore(secondPath, { secretValues: [secret] });
    assert.throws(
      () => secretStore.createIfAbsent(sealCompensationRecord({
        ...recordFixture(),
        blocker_code: secret,
      })),
      (error) => error?.code === "CompensationRecordInvalid",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("competing processes can advance one compensation revision only once", async t => {
  const directory = mkdtempSync(join(tmpdir(), "touba-comp-cas-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite"), initial = recordFixture();
  const store = createSqliteCompensationStore(path);
  store.createIfAbsent(initial);
  const next = sealCompensationRecord({ ...initial, revision: 2, updated_at: "2026-09-22T10:01:00.000Z" });
  const script = `import { createSqliteCompensationStore } from ${JSON.stringify(new URL("../src/sqlite-compensation-store.mjs", import.meta.url).href)};
    const [path, before, after] = process.argv.slice(1), record = JSON.parse(before);
    try { createSqliteCompensationStore(path).compareAndSwap(record.compensation_id, record.revision, record.record_digest, JSON.parse(after)); process.stdout.write('won'); }
    catch(error) { if(error.code !== 'CompensationConflict') throw error; process.stdout.write('stale'); }`;
  const run = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 6 }, () => run(process.execPath,
    ["--input-type=module", "-e", script, path, JSON.stringify(initial), JSON.stringify(next)], { timeout: 10000 })));
  assert.equal(results.filter(result => result.stdout === "won").length, 1);
  assert.equal(results.filter(result => result.stdout === "stale").length, 5);
  assert.equal(store.read(initial.compensation_id).revision, 2);
});

test("migration preserves signed revisions and original bytes, with an explicit preview", t => {
  const directory = mkdtempSync(join(tmpdir(), "touba-comp-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "old.json"), destination = join(directory, "new.sqlite");
  const record = recordFixture();
  const bytes = JSON.stringify({ schema_version: COMPENSATION_STORE_SCHEMA_VERSION, records: { [record.compensation_id]: record } });
  writeFileSync(source, bytes);
  assert.equal(migrateCompensationStore({ source, destination }).record_count, 1);
  assert.equal(existsSync(destination), false);
  migrateCompensationStore({ source, destination, apply: true });
  assert.deepEqual(createSqliteCompensationStore(destination).read(record.compensation_id), record);
  assert.equal(readFileSync(source, "utf8"), bytes);
  assert.equal(readFileSync(destination + ".source-backup.json", "utf8"), bytes);
  assert.throws(() => migrateCompensationStore({ source, destination, apply: true }));
});

function recordFixture() {
  const compensationId = `compensation:sha256:${"a".repeat(64)}`;
  return sealCompensationRecord({
    compensation_id: compensationId,
    compensation_request_id: "request:test-1",
    creation_command_digest: `sha256:${"b".repeat(64)}`,
    execution_request_digest: null,
    compatibility_digest: null,
    revision: 1,
    operation_id: compensationId,
    run_id: "run:test-1",
    effect_scope_id: compensationId,
    compensates_effect_id: `effect:sha256:${"c".repeat(64)}`,
    original: {
      tool_ref: "tool:test/Create",
      air_digest: `sha256:${"d".repeat(64)}`,
      entry_ref: "strategy:test/Create",
      request_digest: `sha256:${"e".repeat(64)}`,
      journal_state: "prepared",
      effect_receipt: null,
    },
    inverse: {
      entry_ref: "strategy:test/Release",
      tool_ref: "tool:test/Release",
      effect_id: `effect:sha256:${"f".repeat(64)}`,
      plan_digest: null,
    },
    approval: null,
    state: "action_required",
    result: "unknown",
    blocker_code: "CompensationOriginalOutcomeUnknown",
    pre_checkpoint_trace_state: {
      prefix_digest: `sha256:${"0".repeat(64)}`,
      next_sequence_index: 0,
    },
    checkpoint: null,
    processed_resume_requests: [],
    created_at: "2026-09-22T10:00:00.000Z",
    updated_at: "2026-09-22T10:00:00.000Z",
  });
}
