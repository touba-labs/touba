import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as wait } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createSqliteTraceStore } from "../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { createPostgresTraceDestination } from "../../runtime/touba-runtime/src/postgres-trace-destination.mjs";
import { createTraceExportWorker } from "../../runtime/touba-runtime/src/trace-export-worker.mjs";
import { isolatedPostgres } from "../helpers/postgres.mjs";
import { fileURLToPath } from "node:url";

const { Pool } = createRequire(new URL("../../cli/touba-run/package.json", import.meta.url))("pg");

test("real PostgreSQL: lost COMMIT reply, replay, conflict, fencing, outage and restart", { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-postgres-trace-"));
  let postgres, pool, store, child, saturated;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL"); await once(child, "exit");
    }
    postgres?.resume();
    store?.close();
    saturated?.close();
    try { await pool?.end(); }
    finally {
      try { await postgres?.stop(); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  postgres = await isolatedPostgres({ user: "trace_test", password: "isolated-trace-test", database: "trace_test" });
  const { port } = postgres;
  pool = new Pool({ host: "127.0.0.1", port, database: "trace_test", user: "trace_test", password: "isolated-trace-test", max: 3, connectionTimeoutMillis: 1000, query_timeout: 2000 });
  pool.on("error", () => {});
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { await pool.query("SELECT 1"); ready = true; break; } catch { await wait(200); }
  }
  assert.ok(ready, "isolated PostgreSQL must become ready");
  const destination = await createPostgresTraceDestination({ pool });
  const filename = join(root, "traces.sqlite");
  store = createSqliteTraceStore({ filename });
  const id = store.openSegment({ run: { run_id: "pg-run" } }, 0);
  for (let i = 0; i < 5; i++) store.append(id, { run_id: "pg-run", event_id: `event:pg-run:${i + 1}`, sequence_index: i,
    kind: i === 4 ? "run_completed" : "run_started", payload: i === 4 ? { status: "success" } : {} });
  let loseReply = true;
  const worker = createTraceExportWorker({ store, batchSize: 2, owner: "worker-a", destination: {
    ...destination, async deliver(...args) {
      const ack = await destination.deliver(...args);
      if (loseReply) { loseReply = false; throw Object.assign(new Error("lost reply after real COMMIT"), { code: "ECONNRESET" }); }
      return ack;
    },
  } });
  await assert.rejects(worker.step(), { code: "ECONNRESET" });
  assert.equal(store.exportStatus("primary").pendingEvents, 5);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM touba_traces.events")).rows[0].n), 2);
  assert.equal((await worker.step()).pendingEvents, 3);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM touba_traces.events")).rows[0].n), 2);
  const source = store.exportStatus("primary").sourceId;
  assert.equal(await destination.acquire(source, "worker-b"), null);
  const oldLease = { owner: "worker-a", epoch: 1 }, batch = store.nextExport("primary", oldLease, 2);
  await pool.query("UPDATE touba_traces.leases SET expires_at=clock_timestamp()-interval '1 second' WHERE source_id=$1", [source]);
  const newLease = await destination.acquire(source, "worker-b");
  assert.equal(newLease.epoch, 2); store.exportLease("primary", newLease);
  await assert.rejects(destination.deliver(source, oldLease, batch), { code: "TraceExportLeaseStale" });
  assert.throws(() => store.acknowledgeExport("primary", oldLease, batch), { code: "TraceExportLeaseStale" });
  await destination.deliver(source, newLease, batch);
  store.acknowledgeExport("primary", newLease, batch);
  await assert.rejects(destination.deliver(source, newLease, { ...batch, events: batch.events.map((event, i) => i ? event : { ...event, payload: { forged: true } }) }), { code: "TraceExportConflict" });
  await destination.release(source, newLease);
  const resumed = createTraceExportWorker({ store, destination, owner: "worker-c", batchSize: 2 });
  assert.equal((await resumed.step()).pendingEvents, 0);
  assert.equal((await resumed.step()).status, "caught_up");
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM touba_traces.events")).rows[0].n), 5);
  await resumed.close();
  const crashId = store.openSegment({ run: { run_id: "crash-run" } }, 0);
  for (let i = 0; i < 2; i++) store.append(crashId, { run_id: "crash-run", event_id: `event:crash-run:${i + 1}`, sequence_index: i,
    kind: i ? "run_completed" : "run_started", payload: i ? { status: "success", reason: "completed" } : {} });
  const script = `
    import { createRequire } from 'node:module';
    import { createSqliteTraceStore } from ${JSON.stringify(new URL("../../runtime/touba-runtime/src/sqlite-trace-store.mjs", import.meta.url).href)};
    import { createPostgresTraceDestination } from ${JSON.stringify(new URL("../../runtime/touba-runtime/src/postgres-trace-destination.mjs", import.meta.url).href)};
    import { createTraceExportWorker } from ${JSON.stringify(new URL("../../runtime/touba-runtime/src/trace-export-worker.mjs", import.meta.url).href)};
    const { Pool } = createRequire(${JSON.stringify(new URL("../../cli/touba-run/package.json", import.meta.url).href)})('pg');
    const pool = new Pool({host:'127.0.0.1',port:${port},database:'trace_test',user:'trace_test',password:'isolated-trace-test',max:1,connectionTimeoutMillis:1000,query_timeout:10000});
    const destination = await createPostgresTraceDestination({pool});
    const worker = createTraceExportWorker({store:createSqliteTraceStore({filename:${JSON.stringify(filename)}}),owner:'worker-crash',destination:{...destination,
      async deliver(...args){await destination.deliver(...args);process.kill(process.pid,'SIGKILL');}
    }});
    await worker.step(); process.exit(2);
  `;
  child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, "SIGKILL", `unexpected child exit ${code}: ${stderr}`);
  assert.equal(store.exportStatus("primary").pendingEvents, 2);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM touba_traces.events")).rows[0].n), 7);
  await pool.query("UPDATE touba_traces.leases SET expires_at=clock_timestamp()-interval '1 second' WHERE source_id=$1", [source]);
  const recovered = createTraceExportWorker({ store, destination, owner: "worker-recovered" });
  assert.equal((await recovered.step()).pendingEvents, 0);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM touba_traces.events")).rows[0].n), 7);
  await recovered.close();
  const liveId = store.openSegment({ run: { run_id: "live-run" } }, 0);
  store.append(liveId, { run_id: "live-run", event_id: "event:live-run:1", sequence_index: 0, kind: "run_started", payload: {} });
  const liveWorker = createTraceExportWorker({ store, destination, owner: "worker-live" });
  assert.equal((await liveWorker.step()).pendingEvents, 0);
  assert.equal((await pool.query("SELECT closed FROM touba_traces.segments WHERE id=$1", [liveId])).rows[0].closed, false);
  store.append(liveId, { run_id: "live-run", event_id: "event:live-run:2", sequence_index: 1, kind: "run_completed", payload: { status: "success", reason: "completed" } });
  assert.equal((await liveWorker.step()).pendingEvents, 0);
  assert.equal((await pool.query("SELECT closed FROM touba_traces.segments WHERE id=$1", [liveId])).rows[0].closed, true);
  await liveWorker.close();

  const outageId = store.openSegment({ run: { run_id: "outage-run" } }, 0);
  store.append(outageId, { run_id: "outage-run", event_id: "event:outage-run:1", sequence_index: 0, kind: "run_started", payload: {} });
  const outageWorker = createTraceExportWorker({ store, destination, owner: "worker-outage" });
  assert.equal((await outageWorker.step()).pendingEvents, 0);
  postgres.pause();
  // Real remote unavailability does not stop local journaling. No local cursor
  // may move until PostgreSQL acknowledges the missing event after recovery.
  store.append(outageId, { run_id: "outage-run", event_id: "event:outage-run:2", sequence_index: 1, kind: "run_completed", payload: { status: "success" } });
  const pending = store.exportStatus("primary").pendingEvents;
  await assert.rejects(outageWorker.step(), /timeout|terminated|closed/i);
  assert.equal(store.exportStatus("primary").pendingEvents, pending);
  // Fill only a synthetic journal's logical byte quota, not the host disk.
  // PostgreSQL is still paused: unread evidence must remain local and intact.
  saturated = createSqliteTraceStore({ filename: join(root, "saturated.sqlite"), maxBytes: 4096 });
  const saturatedId = saturated.openSegment({ run: { run_id: "saturated-run" } }, 0);
  const saturatedWorker = createTraceExportWorker({ store: saturated, destination, owner: "worker-saturated", batchSize: 3 });
  let accepted = 0;
  for (; accepted < 100; accepted++) {
    try {
      saturated.append(saturatedId, { run_id: "saturated-run", event_id: `event:saturated-run:${accepted + 1}`,
        sequence_index: accepted, kind: "tool_result_received", payload: { text: "x".repeat(300) } });
    } catch (error) { assert.equal(error.code, "TraceStorageLimitExceeded"); break; }
  }
  assert.ok(accepted > 0 && accepted < 100);
  assert.equal(saturated.exportStatus("primary").pendingEvents, accepted);
  assert.equal(saturated.page(saturatedId, { limit: 100 }).events.length, accepted);
  assert.equal(saturated.archive({}).segments, 0, "unacknowledged/incomplete evidence is not reclaimable");
  await assert.rejects(saturatedWorker.step(), /timeout|terminated|closed/i);
  assert.equal(saturated.exportStatus("primary").pendingEvents, accepted);
  postgres.resume();
  assert.equal((await outageWorker.step()).pendingEvents, 0);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM touba_traces.events WHERE segment_id=$1", [outageId])).rows[0].n), 2);
  await outageWorker.close();
  while (saturated.exportStatus("primary").pendingEvents) await saturatedWorker.step();
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM touba_traces.events WHERE segment_id=$1", [saturatedId])).rows[0].n), accepted);
  assert.equal(saturated.page(saturatedId, { limit: 100 }).events.length, accepted, "export does not delete evidence");
  await saturatedWorker.close(); saturated.close(); saturated = null;
  store.close();
  // An isolated distribution can replace the source launcher. The same real
  // database and assertions then exercise its bundled runtime and pg dependency.
  const launcher = process.env.TOUBA_TRACE_TEST_CLI;
  const output = execFileSync(launcher ?? process.execPath, [...(launcher ? [] : [fileURLToPath(new URL("../../cli/touba-project/src/main.mjs", import.meta.url))]),
    "trace", "export", "--store", filename, "--postgres-env", "TOUBA_TRACE_QA_DATABASE"], {
    encoding: "utf8", timeout: 20000, env: { ...process.env,
      TOUBA_TRACE_QA_DATABASE: `postgresql://trace_test:isolated-trace-test@127.0.0.1:${port}/trace_test` },
  });
  assert.equal(JSON.parse(output).pendingEvents, 0);
  const reopened = createSqliteTraceStore({ filename });
  try {
    assert.equal(reopened.exportStatus("primary").pendingEvents, 0);
    assert.throws(() => reopened.configureExport({ destinationId: randomUUID() }), { code: "TraceExportDestinationChanged" });
  } finally { reopened.close(); }
});
