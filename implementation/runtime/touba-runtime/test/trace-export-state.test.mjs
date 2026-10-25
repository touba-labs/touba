import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteTraceStore } from "../src/sqlite-trace-store.mjs";
import { createTraceExportWorker } from "../src/trace-export-worker.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-export-"));
  const filename = join(root, "traces.sqlite");
  const store = createSqliteTraceStore({ filename });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const id = store.openSegment({ run: { run_id: "export-run" } }, 0);
  for (let i = 0; i < 6; i++) store.append(id, { run_id: "export-run", event_id: `event:export-run:${i + 1}`,
    sequence_index: i, kind: i === 5 ? "run_completed" : "run_started", payload: i === 5 ? { status: "success", reason: "completed" } : {} });
  return { root, filename, store };
}

test("export acknowledgement is fenced, bounded and required before retention", t => {
  const { store, root } = fixture(t);
  const config = store.configureExport({ destinationId: "destination-a" });
  assert.deepEqual(store.configureExport({ destinationId: "destination-a" }), config);
  assert.throws(() => store.configureExport({ destinationId: "destination-b" }), { code: "TraceExportDestinationChanged" });
  const lease = { owner: "worker-a", epoch: 1 };
  store.exportLease("primary", lease);
  const batch = store.nextExport("primary", lease, 2);
  assert.equal(batch.events.length, 2); assert.equal(store.exportStatus("primary").pendingEvents, 6);
  assert.equal(store.archive().segments, 0);
  assert.throws(() => store.acknowledgeExport("primary", lease, { ...batch, through: 4 }), { code: "TraceExportAckInvalid" });
  assert.throws(() => store.acknowledgeExport("primary", lease, { ...batch, events: [batch.events[0], { ...batch.events[1], payload: { forged: true } }] }), { code: "TraceExportAckInvalid" });
  store.acknowledgeExport("primary", lease, batch);
  store.acknowledgeExport("primary", lease, batch);
  assert.equal(store.exportStatus("primary").pendingEvents, 4);
  const nextLease = { owner: "worker-b", epoch: 2 };
  store.exportLease("primary", nextLease);
  assert.throws(() => store.acknowledgeExport("primary", lease, batch), { code: "TraceExportLeaseStale" });
  assert.throws(() => store.exportLease("primary", lease), { code: "TraceExportLeaseStale" });
  for (let next; (next = store.nextExport("primary", nextLease, 2));) store.acknowledgeExport("primary", nextLease, next);
  assert.equal(store.exportStatus("primary").pendingEvents, 0);
  assert.equal(store.archive({ destination: join(root, "archive.sqlite"), apply: true }).segments, 1);
});

test("a missing or wrong remote acknowledgement retains the durable batch across reopen", async t => {
  const { filename, store } = fixture(t);
  let mode = "lost";
  const destination = { destinationId: "destination-a", acquire: async () => ({ owner: "worker", epoch: 1 }),
    renew: async () => {}, release: async () => {},
    deliver: async (_source, _lease, batch) => {
      if (mode === "lost") throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
      return { segmentId: batch.segmentId, through: mode === "wrong" ? 99 : batch.through, headerDigest: batch.headerDigest };
    },
  };
  const worker = createTraceExportWorker({ store, destination, owner: "worker", batchSize: 2 });
  await assert.rejects(worker.step(), { code: "ECONNRESET" });
  mode = "wrong"; await assert.rejects(worker.step(), { code: "TraceExportAckInvalid" });
  const reopened = createSqliteTraceStore({ filename, readOnly: true });
  assert.equal(reopened.exportStatus("primary").pendingEvents, 6); reopened.close();
  mode = "ok";
  assert.equal((await worker.step()).pendingEvents, 4);
  await worker.close();
});
