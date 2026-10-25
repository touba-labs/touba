import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { indexedStore } from "../../../runtime/touba-runtime/src/sqlite-record-store.mjs";

// Storage-level workload, not a substitute for HTTP/handler qualification.
// Three repetitions, five queued batches each. Durability stays enabled.
for (const history of [0, 100, 1000, 10000]) test(`indexed operations with ${history} retained historical records`, t => {
  const root = mkdtempSync(join(tmpdir(), "touba-indexed-load-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "records.sqlite");
  let validations = 0;
  const store = indexedStore({ path, schemaVersion: "load-v1", keyOf: record => record.id,
    indexes: { status: "json_extract(body, '$.status')" },
    validate(record) {
      validations++;
      assert.equal(typeof record.id, "string");
      assert.equal(record.payload.length, 4096);
      assert.ok(Number.isSafeInteger(record.sequence));
    },
  });
  const seed = store.read();
  for (let i = 0; i < history; i++) seed.push({ id: `history-${i}`, status: "completed", sequence: 0, payload: "h".repeat(4096) });
  for (let i = 0; i < 32; i++) seed.push({ id: `active-${i}`, status: "active", sequence: 0, payload: "a".repeat(4096) });
  store.write(seed);
  // Count changed SQLite pages for one same-size update. This measures the
  // resulting database delta, NOT physical bytes written by the disk/OS.
  const before = readFileSync(path);
  validations = 0;
  const one = store.read([{ id: "active-0" }]); one[0].sequence++; store.write(one);
  assert.equal(validations, 2, "point operations must validate one read and one write, never N records");
  const after = readFileSync(path);
  const pageSize = before.readUInt16BE(16) || 65536;
  let changedPages = 0;
  for (let offset = 0; offset < after.length; offset += pageSize) {
    if (!before.subarray(offset, offset + pageSize).equals(after.subarray(offset, offset + pageSize))) changedPages++;
  }
  assert.ok(changedPages <= 16, `point update changed ${changedPages} pages`);
  t.diagnostic(JSON.stringify({ history, database_bytes: after.length, point_changed_pages: changedPages, page_size: pageSize }));
  for (const concurrency of [1, 8, 32]) {
    for (let repetition = 1; repetition <= 3; repetition++) {
      const serviceMs = [], queuedMs = [], cpu = process.cpuUsage(), started = performance.now();
      validations = 0;
      for (let batch = 0; batch < 5; batch++) {
        const admitted = performance.now();
        for (let i = 0; i < concurrency; i++) {
          const at = performance.now(), records = store.read([{ id: `active-${i}` }]);
          records[0].sequence++; store.write(records);
          serviceMs.push(performance.now() - at); queuedMs.push(performance.now() - admitted);
        }
      }
      const elapsed = performance.now() - started, used = process.cpuUsage(cpu);
      assert.equal(validations, concurrency * 5 * 2);
      const percentile = (samples, p) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1];
      t.diagnostic(JSON.stringify({ history, concurrency, repetition, errors: 0, operations: serviceMs.length,
        elapsed_ms: elapsed, operations_per_second: serviceMs.length * 1000 / elapsed,
        service_p50_ms: percentile(serviceMs, .5), service_p95_ms: percentile(serviceMs, .95), service_p99_ms: percentile(serviceMs, .99),
        queued_p95_ms: percentile(queuedMs, .95), cpu_ms: (used.user + used.system) / 1000,
        rss_bytes: process.memoryUsage().rss, service_samples_ms: serviceMs, queued_samples_ms: queuedMs }));
    }
  }
  assert.equal(store.read([{ status: "completed" }]).length, history, "history must remain intact");
});
