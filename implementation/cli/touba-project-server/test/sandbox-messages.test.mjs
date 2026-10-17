import test from "node:test";
import assert from "node:assert/strict";
import { buildSandboxRunResult } from "../src/serve.mjs";
import { boundedResultText } from "../src/interactions.mjs";

function result(messages) {
  return buildSandboxRunResult({ completedAt: "2026-10-16T00:00:01Z", startedAt: "2026-10-16T00:00:00Z",
    startedMs: Date.now(), runId: "message-test", targetRef: "strategy:test/Run", executionKind: "entrypoint", effectPolicy: "runtime_only",
    runtimeResult: { status: "success", reason: "completed", result: "separate business value", messages,
      trace: { run: { run_id: "message-test", entry_ref: "strategy:test/Run" }, events: [] } } });
}

test("sandbox retains ordered messages independently of results and never copies extra payload", () => {
  const output = result([{ interaction_ref: "show:1", text: "First", raw_payload: "PRIVATE" }, { interaction_ref: "show:1", text: "Second" }]);
  assert.deepEqual(output.messages, [{ interaction_ref: "show:1", text: "First" }, { interaction_ref: "show:1", text: "Second" }]);
  assert.equal(output.messages_truncated, false);
  assert.equal(output.result, "separate business value");
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE/);
  assert.doesNotMatch(JSON.stringify(output.trace), /First|Second/);
});

test("message projection bounds UTF-8 text, total bytes and count with explicit truncation", () => {
  assert.equal(boundedResultText("é😀é😀é", 10), "é😀...");
  const output = result(Array.from({ length: 1000 }, (_, i) => ({ interaction_ref: `show:${i}`, text: "😀".repeat(4096) })));
  assert.equal(output.messages_truncated, true);
  assert.ok(output.messages.length <= 100);
  assert.ok(output.messages.every(message => Buffer.byteLength(message.text) <= 4096 && !message.text.includes("\uFFFD")));
  assert.ok(output.messages.reduce((n, message) => n + Buffer.byteLength(message.text), 0) <= 16 * 1024);
  const empty = result(Array.from({ length: 101 }, () => ({ interaction_ref: "same-node", text: "" })));
  assert.equal(empty.messages.length, 100);
  assert.equal(empty.messages_truncated, true);
  assert.deepEqual(result([]).messages, []);
  assert.equal(result([]).messages_truncated, false);
  assert.throws(() => result([{ interaction_ref: "show:1", text: null }]), { code: "ToubaServeSandboxResultInvalid" });
});
