import test from "node:test";
import assert from "node:assert/strict";
import { validateTraceReference, validateTracePage } from "../src/trace-reference.mjs";
import { createTraceReference, validateTraceReference as validateCoreReference } from "../../../contracts/trace-reference.mjs";
import { validateRunResult } from "../../../contracts/run-outcome.mjs";

const header = { run: { run_id: "r" } };
const events = [
  { run_id: "r", sequence_index: 0, event_id: "event:r:1", kind: "run_started" },
  { run_id: "r", sequence_index: 1, event_id: "event:r:2", kind: "run_completed", payload: { status: "success", reason: "completed" } },
];
const reference = createTraceReference({ complete: true, segmentId: "00000000-0000-0000-0000-000000000001",
  header, startIndex: 0, eventCount: 2, *events() { yield* events; } });

test("Core and JavaScript agree on closed trace reference validation", () => {
  for (const validate of [validateCoreReference, validateTraceReference]) {
    assert.deepEqual(validate(reference), reference);
    for (const patch of [{ start_index: true }, { event_count: 1 }, { event_count: Number.MAX_SAFE_INTEGER },
      { start_index: -1 }, { segment_id: "../db" }, { extra: 1 }, { header_digest: {} }, { run_id: "other" },
      { terminal: { ...reference.terminal, reason: "" } }]) {
      assert.throws(() => validate({ ...reference, ...patch }));
    }
  }
});

test("pages enforce header, sequence, cursor, terminal and wire shape", () => {
  const page = { schema_version: "touba-trace-page-v1", reference, header, events, next: 1, done: true };
  assert.equal(validateTracePage(page, reference, -1, 2), page);
  assert.doesNotThrow(() => validateTracePage({ ...page, reference: Object.fromEntries(Object.entries(reference).reverse()) }, reference, -1, 2));
  for (const patch of [{ next: 2 }, { done: false }, { header: {} }, { extra: 1 }, { events: [] },
    { events: [{ ...events[0], kind: "run_completed" }, events[1]] },
    { events: [events[0], { ...events[1], payload: { status: "success", reason: "forged" } }] }]) {
    assert.throws(() => validateTracePage({ ...page, ...patch }, reference, -1, 2));
  }
  const envelope = { schema_version: "touba-run-reference-v1", status: "success", reason: "completed",
    messages: [], result: null, trace_reference: reference };
  assert.equal(validateRunResult(envelope), envelope);
  for (const patch of [{ trace: {} }, { reason: "forged" }, { schema_version: "touba-run-result-v1" }]) {
    assert.throws(() => validateRunResult({ ...envelope, ...patch }));
  }
});
