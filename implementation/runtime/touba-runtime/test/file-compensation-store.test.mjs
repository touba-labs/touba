import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compensationRecordDigest,
  sealCompensationRecord,
} from "../src/compensation-store.mjs";
import { createFileCompensationStore } from "../src/file-compensation-store.mjs";

test("persists one current compensation record and applies exact CAS", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-store-"));
  try {
    const path = join(workspace, "compensations.json");
    const store = createFileCompensationStore(path);
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
    const path = join(workspace, "compensations.json");
    const secret = "resolved-secret-never-persist";
    const store = createFileCompensationStore(path, { secretValues: [secret] });
    const initial = recordFixture();
    store.createIfAbsent(initial);
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    persisted.records[initial.compensation_id].state = "terminal";
    writeFileSync(path, JSON.stringify(persisted), "utf8");
    assert.throws(
      () => store.read(initial.compensation_id),
      (error) => error?.code === "CompensationRecordDigestMismatch",
    );

    const secondPath = join(workspace, "secret.json");
    const secretStore = createFileCompensationStore(secondPath, { secretValues: [secret] });
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
