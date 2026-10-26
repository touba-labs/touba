import test from "node:test";
import assert from "node:assert/strict";
import { validatedRecordCodec } from "../src/validated-records.mjs";

test("validated disk bytes return fresh snapshots and recheck changed relationships", () => {
  let calls = 0;
  const { parse: read } = validatedRecordCodec(store => {
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
  assert.throws(() => read({ toString: () => bytes }), TypeError);
});

test("JSON validation reuses exact bytes and never caches a refusal", () => {
  let calls = 0;
  const { parse } = validatedRecordCodec(record => {
    calls++;
    assert.equal(record.value, "valid");
    assert.equal(record.proof, "intact");
  });
  const record = { id: "one", value: "valid", proof: "intact" };
  parse(JSON.stringify(record));
  parse(JSON.stringify(structuredClone(record)));
  assert.equal(calls, 1);
  record.proof = "wrong";
  assert.throws(() => parse(JSON.stringify(record)));
  assert.throws(() => parse(JSON.stringify(record)));
  assert.equal(calls, 3);
  record.proof = "intact";
  parse(JSON.stringify(record));
  assert.equal(calls, 3);
});

test("JSON validation memory is bounded by entries and bytes", () => {
  let calls = 0;
  const { parse: byCount } = validatedRecordCodec(() => calls++, { maxEntries: 2 });
  for (const n of [1, 2, 1, 3, 1, 2]) byCount(JSON.stringify({ n }));
  assert.equal(calls, 4);
  calls = 0;
  const { parse: byBytes } = validatedRecordCodec(() => calls++, { maxBytes: 7 });
  for (const n of [1, 1, 2, 1]) byBytes(JSON.stringify({ n }));
  assert.equal(calls, 3);
  const oversized = { n: "long content" };
  byBytes(JSON.stringify(oversized));
  byBytes(JSON.stringify(oversized));
  assert.equal(calls, 5);
});

test("writer validation never accepts JSON serialization aliases from the read cache", () => {
  let calls = 0;
  const codec = validatedRecordCodec(record => {
    calls++;
    assert.deepEqual(Reflect.ownKeys(record), ["value"]);
    assert.equal(record.value, null);
  });
  codec.parse('{"value":null}');
  codec.validate({ value: null });
  assert.equal(calls, 2);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => codec.validate({ value }));
  }
  assert.throws(() => codec.validate({ value: null, extra: undefined }));
  assert.throws(() => codec.validate({ value: "invalid", toJSON() { return { value: null }; } }));
  assert.throws(() => codec.parse('{"value":1e999}'));
  assert.equal(calls, 8);
  codec.parse('{"value":null}');
  assert.equal(calls, 8);
});

test("read cache keys distinguish exact JSON texts and do not retain caller mutations", () => {
  let calls = 0;
  const codec = validatedRecordCodec(record => { calls++; assert.equal(record.value, "valid"); });
  const first = codec.parse('{"value":"valid"}');
  first.value = "invalid";
  assert.throws(() => codec.validate(first));
  assert.equal(codec.parse('{"value":"valid"}').value, "valid");
  codec.parse('{ "value": "valid" }');
  assert.equal(calls, 3);
});
