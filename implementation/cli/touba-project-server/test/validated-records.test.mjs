import test from "node:test";
import assert from "node:assert/strict";
import { validatedJson, validatedRecords } from "../src/validated-records.mjs";

test("validated disk bytes return fresh snapshots and recheck changed relationships", () => {
  let calls = 0;
  const read = validatedJson(store => {
    calls++;
    assert.equal(new Set(store.records.map(r => r.id)).size, store.records.length);
  });
  const bytes = '{"records":[{"id":"one"}]}';
  const first = read(bytes);
  first.records[0].id = "mutated locally";
  assert.equal(read(bytes).records[0].id, "one");
  assert.equal(calls, 1);
  assert.throws(() => read('{"records":[{"id":"one"},{"id":"one"}]}'));
  assert.equal(calls, 2);
  assert.throws(() => read("broken JSON"));
});

test("record validation reuses only identical content and never caches a refusal", () => {
  let calls = 0;
  const validate = validatedRecords(record => {
    calls++;
    assert.equal(record.value, "valid");
    assert.equal(record.proof, "intact");
  });
  const record = { id: "one", value: "valid", proof: "intact" };
  validate(record);
  validate(structuredClone(record));
  assert.equal(calls, 1);
  record.proof = "wrong";
  assert.throws(() => validate(record));
  assert.throws(() => validate(record));
  assert.equal(calls, 3);
  record.proof = "intact";
  validate(record);
  assert.equal(calls, 3);
});

test("record validation memory is bounded by entries and bytes", () => {
  let calls = 0;
  const byCount = validatedRecords(() => calls++, { maxEntries: 2 });
  for (const n of [1, 2, 1, 3, 1, 2]) byCount({ n });
  assert.equal(calls, 4);
  calls = 0;
  const byBytes = validatedRecords(() => calls++, { maxBytes: 7 });
  for (const n of [1, 1, 2, 1]) byBytes({ n });
  assert.equal(calls, 3);
  const oversized = { n: "long content" };
  byBytes(oversized);
  byBytes(oversized);
  assert.equal(calls, 5);
});
