import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EFFECT_JOURNAL_SCHEMA_VERSION,
  deriveEffectId,
  deriveEffectRequestDigest,
  readEffectJournalEntry,
  requireEffectJournalAdapter,
  validateEffectJournalEntry,
  validateEffectReceipt,
  writeEffectJournalEntry,
} from "../src/effect-contract.mjs";
import {
  decodeToolHandlerResponse,
  runProcessToolHandler,
} from "../src/handler-protocol.mjs";
import { RuntimeFailure } from "../src/runtime-errors.mjs";
import { createFileEffectJournal } from "../src/file-effect-journal.mjs";

const AIR_DIGEST = `sha256:${"a".repeat(64)}`;
const REQUEST_DIGEST = `sha256:${"b".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"c".repeat(64)}`;
const EFFECT_ID = `effect:sha256:${"d".repeat(64)}`;

test("derives stable effect identities and canonical request digests", () => {
  const identity = {
    effectScopeId: "queue:stable-1",
    airDigest: AIR_DIGEST,
    entryRef: "trigger:test/CreateOrder",
    effectIndex: 1,
  };
  assert.equal(deriveEffectId(identity), deriveEffectId({ ...identity }));
  assert.notEqual(deriveEffectId(identity), deriveEffectId({ ...identity, effectIndex: 2 }));

  const left = deriveEffectRequestDigest({
    airDigest: AIR_DIGEST,
    toolRef: "tool:test/CreateOrder",
    arguments: { customer: { id: 7, name: "Ada" }, items: ["a", "b"] },
    resourceBindings: [{ resource_ref: "resource:test/Orders", config: { b: 2, a: 1 } }],
  });
  const reordered = deriveEffectRequestDigest({
    airDigest: AIR_DIGEST,
    toolRef: "tool:test/CreateOrder",
    arguments: { items: ["a", "b"], customer: { name: "Ada", id: 7 } },
    resourceBindings: [{ config: { a: 1, b: 2 }, resource_ref: "resource:test/Orders" }],
  });
  const differentListOrder = deriveEffectRequestDigest({
    airDigest: AIR_DIGEST,
    toolRef: "tool:test/CreateOrder",
    arguments: { items: ["b", "a"], customer: { name: "Ada", id: 7 } },
    resourceBindings: [{ config: { a: 1, b: 2 }, resource_ref: "resource:test/Orders" }],
  });
  assert.equal(left, reordered);
  assert.notEqual(left, differentListOrder);
  assert.equal(left, deriveEffectRequestDigest({
    airDigest: AIR_DIGEST,
    toolRef: "tool:test/CreateOrder",
    arguments: { customer: { id: 7, name: "Ada" }, items: ["a", "b"] },
    resourceBindings: [{ resource_ref: "resource:test/Orders", config: { b: 2, a: 1 } }],
  }));
  assert.notEqual(left, deriveEffectRequestDigest({
    airDigest: AIR_DIGEST,
    toolRef: "tool:test/CreateOrder",
    arguments: { customer: { id: 7, name: "Ada" }, items: ["a", "b"] },
    resourceBindings: [{ resource_ref: "resource:test/Orders", config: { b: 2, a: 1 } }],
    controlContext: { compensation_id: `compensation:sha256:${"e".repeat(64)}` },
  }));
});

test("validates bounded correlated receipts and refuses unknown or secret fields", () => {
  assert.deepEqual(validateEffectReceipt({
    effect_id: EFFECT_ID,
    request_digest: REQUEST_DIGEST,
    outcome: "applied",
    receipt_ref: "opaque:order:17",
    receipt_digest: OTHER_DIGEST,
  }, {
    effectId: EFFECT_ID,
    requestDigest: REQUEST_DIGEST,
  }), {
    effect_id: EFFECT_ID,
    request_digest: REQUEST_DIGEST,
    outcome: "applied",
    receipt_ref: "opaque:order:17",
    receipt_digest: OTHER_DIGEST,
  });

  for (const receipt of [
    {
      effect_id: EFFECT_ID,
      request_digest: OTHER_DIGEST,
      outcome: "applied",
    },
    {
      effect_id: EFFECT_ID,
      request_digest: REQUEST_DIGEST,
      outcome: "applied",
      provider_response: { raw: true },
    },
    {
      effect_id: EFFECT_ID,
      request_digest: REQUEST_DIGEST,
      outcome: "applied",
      receipt_ref: "opaque:resolved-secret-value",
    },
  ]) {
    assert.throws(
      () => validateEffectReceipt(receipt, {
        effectId: EFFECT_ID,
        requestDigest: REQUEST_DIGEST,
        secretValues: ["resolved-secret-value"],
      }),
      (error) => error instanceof RuntimeFailure && error.code === "EffectReceiptInvalid",
    );
  }

  const escapedSecret = "resolved-\"secret\"\nwith\\escapes";
  assert.throws(
    () => validateEffectReceipt({
      effect_id: EFFECT_ID,
      request_digest: REQUEST_DIGEST,
      outcome: "applied",
      receipt_ref: `opaque:${escapedSecret}`,
    }, {
      effectId: EFFECT_ID,
      requestDigest: REQUEST_DIGEST,
      secretValues: [escapedSecret],
    }),
    (error) => error instanceof RuntimeFailure && error.code === "EffectReceiptInvalid",
  );
});

test("does not disclose secret-bearing unknown receipt or journal field names", () => {
  const sensitiveKey = "private-\"field\"\nwith\\escapes-never-disclose";
  for (const validate of [
    () => validateEffectReceipt({
      effect_id: EFFECT_ID,
      request_digest: REQUEST_DIGEST,
      outcome: "applied",
      [sensitiveKey]: true,
    }, {
      effectId: EFFECT_ID,
      requestDigest: REQUEST_DIGEST,
      secretValues: [sensitiveKey],
    }),
    () => validateEffectJournalEntry({
      ...journalEntry(),
      [sensitiveKey]: true,
    }, EFFECT_ID),
  ]) {
    assert.throws(validate, (error) => (
      ["EffectReceiptInvalid", "EffectJournalInvalid"].includes(error?.code)
      && !`${error.message}${JSON.stringify(error.details)}`.includes(sensitiveKey)
      && error.details.unknownFieldCount === 1
    ));
  }
});

test("file journal refuses escaped resolved secret values before persistence", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-journal-secret-"));
  try {
    const escapedSecret = "journal-\"secret\"\nwith\\escapes";
    const journal = createFileEffectJournal(join(workspace, "effects.json"), {
      secretValues: [escapedSecret],
    });
    assert.throws(
      () => journal.writeEntry({
        ...journalEntry(),
        state: "applied",
        attempt_count: 1,
        last_call_id: "call:test:1",
        receipt: {
          effect_id: EFFECT_ID,
          request_digest: REQUEST_DIGEST,
          outcome: "applied",
        },
        result: `created:${escapedSecret}`,
      }),
      (error) => error?.code === "EffectJournalInvalid",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("file journal JSON diagnostics never echo resolved secret source text", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-journal-invalid-json-"));
  try {
    const escapedSecret = "journal-json-\"secret\"\nwith\\escapes";
    const path = join(workspace, "effects.json");
    writeFileSync(path, `{"leak":${JSON.stringify(escapedSecret)}`, "utf8");
    assert.throws(
      () => createFileEffectJournal(path, { secretValues: [escapedSecret] }),
      (error) => (
        error?.code === "EffectJournalInvalid"
        && !`${error.message}${JSON.stringify(error.details)}`.includes(escapedSecret)
      ),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("uses a narrow host journal adapter and clones entries across its boundary", async () => {
  const entries = new Map();
  const adapter = requireEffectJournalAdapter({
    schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
    readEntry: (effectId) => entries.get(effectId) ?? null,
    writeEntry: (entry) => entries.set(entry.effect_id, entry),
  });
  const entry = journalEntry();
  await writeEffectJournalEntry(adapter, entry);
  entry.state = "unknown";
  assert.equal(entries.get(EFFECT_ID).state, "prepared");
  assert.deepEqual(await readEffectJournalEntry(adapter, EFFECT_ID), journalEntry());

  assert.throws(
    () => requireEffectJournalAdapter({
      schemaVersion: "unknown",
      readEntry() {},
      writeEntry() {},
    }),
    (error) => error instanceof RuntimeFailure && error.code === "EffectJournalRequired",
  );
});

test("bounds journal adapter failures without echoing host-controlled messages", async () => {
  const sensitiveMessage = "raw-prompt-\"secret\"\nwith\\escapes-never-disclose";
  const readAdapter = requireEffectJournalAdapter({
    schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
    readEntry: () => { throw new Error(sensitiveMessage); },
    writeEntry: () => {},
  });
  const writeAdapter = requireEffectJournalAdapter({
    schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
    readEntry: () => null,
    writeEntry: () => { throw new RuntimeFailure(sensitiveMessage, { cause: sensitiveMessage }); },
  });
  for (const [operation, code] of [
    [() => readEffectJournalEntry(readAdapter, EFFECT_ID), "EffectJournalReadFailed"],
    [() => writeEffectJournalEntry(writeAdapter, journalEntry()), "EffectJournalWriteFailed"],
  ]) {
    await assert.rejects(operation, (error) => (
      error?.code === code
      && !`${error.message}${JSON.stringify(error.details)}`.includes(sensitiveMessage)
      && !Object.hasOwn(error.details, "cause")
    ));
  }
});

test("enforces journal invariants between state, attempts, receipt and result", async () => {
  const adapter = requireEffectJournalAdapter({
    schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
    readEntry: () => null,
    writeEntry: () => {},
  });
  const correlatedReceipt = {
    effect_id: EFFECT_ID,
    request_digest: REQUEST_DIGEST,
    outcome: "applied",
  };
  const invalidEntries = [
    { ...journalEntry(), state: "prepared", receipt: correlatedReceipt },
    { ...journalEntry(), state: "dispatched", attempt_count: 0 },
    {
      ...journalEntry(),
      state: "dispatched",
      attempt_count: 1,
      last_call_id: "call:test:1",
      result: "too early",
    },
    {
      ...journalEntry(),
      state: "applied",
      attempt_count: 1,
      last_call_id: "call:test:1",
      result: "unproven",
    },
    {
      ...journalEntry(),
      state: "applied",
      attempt_count: 1,
      last_call_id: "call:test:1",
      receipt: { ...correlatedReceipt, outcome: "unknown" },
    },
    {
      ...journalEntry(),
      state: "unknown",
      attempt_count: 1,
      last_call_id: "call:test:1",
      receipt: correlatedReceipt,
    },
    {
      ...journalEntry(),
      state: "unknown",
      attempt_count: 1,
      last_call_id: "call:test:1",
      result: "not restorable",
    },
    {
      ...journalEntry(),
      state: "not_applied",
      attempt_count: 1,
      last_call_id: "call:test:1",
      receipt: { ...correlatedReceipt, outcome: "not_applied" },
      result: "forbidden",
    },
  ];
  for (const entry of invalidEntries) {
    await assert.rejects(
      () => writeEffectJournalEntry(adapter, entry),
      (error) => error instanceof RuntimeFailure && error.code === "EffectJournalInvalid",
    );
  }

  await writeEffectJournalEntry(adapter, {
    ...journalEntry(),
    state: "prepared",
    attempt_count: 2,
    last_call_id: "call:test:2",
  });
  await writeEffectJournalEntry(adapter, {
    ...journalEntry(),
    state: "applied",
    attempt_count: 1,
    last_call_id: "call:test:1",
    receipt: correlatedReceipt,
  });
});

test("decodes effectful success and error receipts and pure results", () => {
  const effect = {
    effect_id: EFFECT_ID,
    attempt_index: 1,
    request_digest: REQUEST_DIGEST,
  };
  assert.deepEqual(decodeToolHandlerResponse({
    ok: true,
    value: { order_id: 17 },
    effect_receipt: {
      effect_id: EFFECT_ID,
      request_digest: REQUEST_DIGEST,
      outcome: "applied",
    },
  }, "tool:test/CreateOrder", [], { effect }), {
    value: { order_id: 17 },
    effectReceipt: {
      effect_id: EFFECT_ID,
      request_digest: REQUEST_DIGEST,
      outcome: "applied",
    },
  });
  assert.deepEqual(decodeToolHandlerResponse({ ok: true, value: 3 }, "tool:test/Read", []), {
    value: 3,
  });
  assert.throws(
    () => decodeToolHandlerResponse({
      ok: false,
      error: { code: "Rejected", message: "not accepted" },
      effect_receipt: {
        effect_id: EFFECT_ID,
        request_digest: REQUEST_DIGEST,
        outcome: "not_applied",
      },
    }, "tool:test/CreateOrder", [], { effect }),
    (error) =>
      error instanceof RuntimeFailure
      && error.code === "ToolHandlerReportedError"
      && error.details.effectReceipt.outcome === "not_applied",
  );
});

test("decodes only strict correlated compensation compensation responses", () => {
  const effect = {
    effect_id: EFFECT_ID,
    attempt_index: 1,
    request_digest: REQUEST_DIGEST,
  };
  const compensation = {
    compensation_id: `compensation:sha256:${"e".repeat(64)}`,
    compensates_effect_id: `effect:sha256:${"f".repeat(64)}`,
  };
  const success = {
    ok: true,
    value: { released: true },
    effect_receipt: {
      effect_id: EFFECT_ID,
      request_digest: REQUEST_DIGEST,
      outcome: "applied",
    },
    compensation_receipt: {
      compensation_id: compensation.compensation_id,
      compensates_effect_id: compensation.compensates_effect_id,
      inverse_effect_id: EFFECT_ID,
      result: "partial",
    },
  };
  assert.deepEqual(
    decodeToolHandlerResponse(success, "tool:test/Undo", [], { effect, compensation }),
    {
      value: { released: true },
      effectReceipt: success.effect_receipt,
      compensationReceipt: success.compensation_receipt,
    },
  );
  for (const response of [
    { ...success, compensation_receipt: { ...success.compensation_receipt, result: "failed" } },
    { ...success, effect_receipt: { ...success.effect_receipt, outcome: "unknown" } },
    { ...success, compensation_receipt: { ...success.compensation_receipt, vendor: true } },
  ]) {
    assert.throws(
      () => decodeToolHandlerResponse(response, "tool:test/Undo", [], { effect, compensation }),
      (error) => error instanceof RuntimeFailure && error.code === "CompensationReceiptInvalid",
    );
  }
  assert.throws(
    () => decodeToolHandlerResponse({
      ok: false,
      error: { code: "UndoRejected", message: "no" },
      effect_receipt: { ...success.effect_receipt, outcome: "not_applied" },
    }, "tool:test/Undo", [], { effect, compensation }),
    (error) => error instanceof RuntimeFailure
      && error.code === "ToolHandlerReportedError"
      && error.details.effectReceipt.outcome === "not_applied",
  );
});

test("redacts resolved secrets from V1 and effectful handler error codes", () => {
  const secretValue = "handler-code-\"secret\"\nwith\\escapes";
  const baseResponse = {
    ok: false,
    error: { code: secretValue, message: "rejected" },
  };
  const effect = {
    effect_id: EFFECT_ID,
    attempt_index: 1,
    request_digest: REQUEST_DIGEST,
  };
  for (const [response, options] of [
    [baseResponse, undefined],
    [{
      ...baseResponse,
      effect_receipt: {
        effect_id: EFFECT_ID,
        request_digest: REQUEST_DIGEST,
        outcome: "not_applied",
      },
    }, { effect }],
  ]) {
    assert.throws(
      () => decodeToolHandlerResponse(response, "tool:test/CreateOrder", [secretValue], options),
      (error) => (
        error?.code === "ToolHandlerReportedError"
        && !`${error.message}${JSON.stringify(error.details)}`.includes(secretValue)
      ),
    );
  }
});

test("persists dispatched before an effectful process receives its request", async () => {
  let dispatchPersisted = false;
  const script = `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        ok: true,
        value: { persisted_before_input: true },
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: "applied"
        }
      }));
    });
  `;
  const effect = {
    effect_id: EFFECT_ID,
    attempt_index: 1,
    request_digest: REQUEST_DIGEST,
  };
  const result = await runProcessToolHandler({
    toolRef: "tool:test/CreateOrder",
    binding: {
      handler: { command: process.execPath, args: ["-e", script] },
      limits: { timeout_ms: 1000, max_payload_bytes: 4096 },
    },
    request: {
      protocol: "touba-tool-handler-v1", operation: "invoke",
      tool_ref: "tool:test/CreateOrder",
      call_id: "call:test:1",
      arguments: {},
      effect,
    },
    secretHandles: [],
    secretStore: null,
    beforeDispatch: async () => {
      await Promise.resolve();
      dispatchPersisted = true;
    },
  });
  assert.equal(dispatchPersisted, true);
  assert.deepEqual(result.effectReceipt, {
    effect_id: EFFECT_ID,
    request_digest: REQUEST_DIGEST,
    outcome: "applied",
  });
});

test("prepares compensation secrets before the single dispatch guard and skips a second guard", async () => {
  const sequence = [];
  const compensation = {
    compensation_id: `compensation:sha256:${"e".repeat(64)}`,
    compensates_effect_id: `effect:sha256:${"f".repeat(64)}`,
  };
  const script = `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        ok: true,
        value: { released: true },
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: "applied"
        },
        compensation_receipt: {
          compensation_id: request.compensation.compensation_id,
          compensates_effect_id: request.compensation.compensates_effect_id,
          inverse_effect_id: request.effect.effect_id,
          result: "completed"
        }
      }));
    });
  `;
  const result = await runProcessToolHandler({
    toolRef: "tool:test/Undo",
    binding: {
      handler: { command: process.execPath, args: ["-e", script] },
      limits: { timeout_ms: 1000, max_payload_bytes: 4096 },
    },
    request: {
      protocol: "touba-tool-handler-v1", operation: "compensate",
      tool_ref: "tool:test/Undo",
      arguments: {},
      effect: { effect_id: EFFECT_ID, attempt_index: 1, request_digest: REQUEST_DIGEST },
      compensation,
    },
    secretHandles: ["TOKEN"],
    secretStore: {
      valueFor(handle) {
        sequence.push(`secret:${handle}`);
        return "value";
      },
      entries() { return []; },
    },
    beforeDispatch() { sequence.push("dispatch"); },
    beforeSpawn() { sequence.push("second-guard"); },
  });
  assert.deepEqual(sequence, ["secret:TOKEN", "dispatch"]);
  assert.equal(result.compensationReceipt.result, "completed");
});

function journalEntry() {
  return {
    effect_id: EFFECT_ID,
    effect_scope_id: "queue:stable-1",
    air_digest: AIR_DIGEST,
    entry_ref: "trigger:test/CreateOrder",
    effect_index: 1,
    request_digest: REQUEST_DIGEST,
    tool_ref: "tool:test/CreateOrder",
    retry_mode: "idempotency_key",
    state: "prepared",
    attempt_count: 0,
  };
}
