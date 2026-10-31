import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { validateObject } from "../../../contracts/product-surfaces/validate.mjs";
import { projectTraceStorageStatus } from "../src/trace-storage-status.mjs";

const schema = JSON.parse(readFileSync(new URL("../../../contracts/product-surfaces/schemas/touba-trace-storage-status-v1.schema.json", import.meta.url)));
const now = "2026-10-31T12:00:00Z";
const check = report => assert.deepEqual(validateObject(schema, report), []);

test("trace storage distinguishes unavailable, measured usage and quota without exposing journal identities", t => {
  const unavailable = projectTraceStorageStatus(null, now);
  check(unavailable);
  assert.equal(unavailable.status, "unavailable");
  const root = mkdtempSync(join(tmpdir(), "touba-storage-status-"));
  const filename = join(root, "journal.sqlite");
  const store = createSqliteTraceStore({ filename, maxBytes: 8192 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const empty = projectTraceStorageStatus(store, now);
  check(empty);
  assert.equal(empty.storage.events, 0);
  assert.equal(empty.storage.retained_bytes, 0);
  assert.deepEqual(empty.exports, []);
  store.configureExport({ name: "analytics", destinationId: "private-destination" });
  const segment = store.openSegment({ run: { run_id: "private-run" } }, 0);
  store.append(segment, { kind: "run_completed", run_id: "private-run", event_id: "event:private-run:1", sequence_index: 0, payload: { status: "success" } });
  const pending = projectTraceStorageStatus(store, now);
  check(pending);
  assert.equal(pending.storage.events, 1);
  assert.equal(pending.storage.segments, 1);
  assert.ok(pending.storage.retained_bytes > 0);
  assert.deepEqual(pending.exports, [{ name: "analytics", pending_events: 1, status: "pending" }]);
  for (const privateValue of [filename, "private-destination", "private-run", "sourceId"]) assert.ok(!JSON.stringify(pending).includes(privateValue));
  const lease = { owner: "isolated-worker", epoch: 1 };
  store.exportLease("analytics", lease);
  store.acknowledgeExport("analytics", lease, store.nextExport("analytics", lease, 1));
  assert.deepEqual(projectTraceStorageStatus(store, now).exports, [{ name: "analytics", pending_events: 0, status: "caught_up" }]);
  const readonly = createSqliteTraceStore({ filename, maxBytes: 8192, readOnly: true });
  try { assert.deepEqual(readonly.statistics(), store.statistics()); } finally { readonly.close(); }
  const limit = projectTraceStorageStatus({ statistics: () => ({ bytes: 8192, maxBytes: 8192, events: 1, segments: 1, exports: [] }) }, now);
  check(limit); assert.equal(limit.status, "at_limit");
});
