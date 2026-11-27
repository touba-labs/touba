import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createSqliteTriggerStore, migrateTriggerState } from "../src/sqlite-trigger-store.mjs";

const moduleUrl = new URL("../src/sqlite-trigger-store.mjs", import.meta.url).href;
const request = { triggerRef: "trigger:example/Receive", eventId: "event-1", runId: "run-1", sourceKind: "request", maxRunsPerDay: 1 };
const openStores = new WeakMap();
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-trigger-store-"));
  const stores = [];
  openStores.set(t, stores);
  t.after(() => {
    for (const store of stores.reverse()) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return join(root, "triggers.sqlite");
}
function open(t, filename, options) {
  const store = createSqliteTriggerStore({ filename, ...options });
  openStores.get(t).push(store);
  return store;
}
function child(code) {
  const processChild = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    processChild.stdout.on("data", chunk => stdout += chunk);
    processChild.stderr.on("data", chunk => stderr += chunk);
    processChild.on("error", reject);
    processChild.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("admission survives reopen, preserves duplicate identity and checks daily limit atomically", t => {
  const filename = workspace(t), first = open(t, filename);
  assert.deepEqual(first.admit(request), { accepted: true }); first.close();
  const second = open(t, filename);
  assert.equal(second.consumed(request.triggerRef, request.eventId), true);
  assert.deepEqual(second.admit({ ...request, runId: "another" }), { accepted: false, reason: "event_replay" });
  assert.deepEqual(second.admit({ ...request, eventId: "event-2" }), { accepted: false, reason: "max_runs_per_day_reached", observedCount: 1 });
  assert.equal(second.summary(request.triggerRef).accepted_count, 1);
});

test("separate processes admit exactly one event at a shared daily limit", async t => {
  const filename = workspace(t);
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => child(`
    import {createSqliteTriggerStore} from ${JSON.stringify(moduleUrl)};
    const store=createSqliteTriggerStore({filename:${JSON.stringify(filename)}});
    console.log(JSON.stringify(store.admit(${JSON.stringify({ ...request, eventId: `event-${index}`, runId: `run-${index}` })})));
    store.close();`)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(results.map(r => JSON.parse(r.stdout)).filter(r => r.accepted).length, 1);
  assert.equal(open(t, filename).count(request.triggerRef), 1);
});

test("SIGKILL after admission does not allow replay", async t => {
  const filename = workspace(t);
  const result = await child(`import {createSqliteTriggerStore} from ${JSON.stringify(moduleUrl)};
    const store=createSqliteTriggerStore({filename:${JSON.stringify(filename)}});
    store.admit(${JSON.stringify(request)}); process.kill(process.pid,'SIGKILL');`);
  if (process.platform === "win32") assert.ok(Number.isInteger(result.code) && result.code !== 0, result.stderr);
  else assert.equal(result.signal, "SIGKILL", result.stderr);
  assert.equal(open(t, filename).admit({ ...request, runId: "after-crash" }).reason, "event_replay");
});

test("only a newer explicitly owned attempt reuses a consumed event", t => {
  const store = open(t, workspace(t));
  store.admit({ ...request, ownerId: "queue-1" });
  assert.equal(store.admit({ ...request, ownerId: "queue-2", attempt: 2, retry: true }).accepted, false);
  assert.equal(store.admit({ ...request, ownerId: "queue-1", attempt: 1, retry: true }).accepted, false);
  assert.equal(store.admit({ ...request, ownerId: "queue-1", attempt: 2, retry: true }).accepted, true);
  assert.equal(store.count(request.triggerRef), 1);
  assert.equal(store.page().items.length, 1);
  store.recordResult(request, { status: "success", trace: { run: { run_id: request.runId }, events: [
    { kind: "trigger_event_accepted", payload: { trigger_ref: request.triggerRef } },
  ] } });
  assert.equal(store.admit({ ...request, ownerId: "queue-1", attempt: 3, retry: true }).accepted, false);
});

test("UTC rollover, stable pagination and strict quota", t => {
  const filename = workspace(t);
  let date = new Date("2026-10-24T23:59:59Z");
  const store = open(t, filename, { clock: () => date, maxBytes: 65536 });
  store.admit(request); date = new Date("2026-10-25T00:00:00Z");
  assert.equal(store.admit({ ...request, eventId: "today" }).accepted, true);
  assert.equal(store.count(request.triggerRef), 1);
  const page = store.page({ limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(store.page({ after: page.next }).items[0].event_id, "today");
  assert.throws(() => store.page({ limit: 1001 }));
  let failure;
  for (let i = 0; i < 1000; i++) {
    try { store.admit({ ...request, eventId: `quota-${i}`, maxRunsPerDay: 10000 }); }
    catch (error) { failure = error; break; }
  }
  assert.ok(failure, "quota must stop admissions before unbounded growth");
  assert.match(failure.message, /full/);
  assert.equal(store.consumed(request.triggerRef, "quota-999"), false);
});

test("read-only inspection, links and foreign databases", t => {
  const filename = workspace(t), store = open(t, filename);
  store.admit(request); store.close();
  const reader = open(t, filename, { readOnly: true });
  assert.equal(reader.page().items.length, 1);
  assert.throws(() => reader.admit(request), { code: "TriggerStateReadOnly" }); reader.close();
  symlinkSync(filename, filename + ".link.sqlite");
  assert.throws(() => createSqliteTriggerStore({ filename: filename + ".link.sqlite" }), { code: "TriggerStatePathInvalid" });
  const foreign = filename + ".foreign.sqlite";
  writeFileSync(foreign, "", { mode: 0o600 });
  const db = new DatabaseSync(foreign); db.exec("CREATE TABLE business(id TEXT)"); db.close();
  const before = readFileSync(foreign);
  assert.throws(() => createSqliteTriggerStore({ filename: foreign }));
  assert.deepEqual(readFileSync(foreign), before);
});

test("retention archives completed events while preserving claims, totals and uncertain work", t => {
  const filename = workspace(t), store = open(t, filename);
  store.admit(request);
  store.admit({ ...request, eventId: "unfinished", runId: "unfinished", maxRunsPerDay: 10 });
  store.recordResult(request, { status: "success", trace: { run: { run_id: request.runId }, events: [
    { kind: "trigger_event_accepted", payload: { trigger_ref: request.triggerRef } },
  ] } });
  const options = { before: "2099-01-01T00:00:00Z", destination: filename + ".archive.sqlite" };
  assert.equal(store.archive(options).event_count, 1);
  assert.equal(store.page().items.length, 2);
  const archived = store.archive({ ...options, apply: true });
  assert.equal(archived.event_count, 1); assert.match(archived.sha256, /^[a-f0-9]{64}$/);
  assert.equal(store.page().items.length, 1);
  assert.equal(store.page().items[0].event_id, "unfinished");
  assert.equal(store.admit(request).reason, "event_replay");
  assert.equal(store.summary(request.triggerRef).accepted_count, 2);
  assert.equal(open(t, options.destination, { readOnly: true }).page().items[0].event_id, request.eventId);
  assert.throws(() => store.archive({ ...options, apply: true }));
  assert.equal(store.page().items.length, 1);
});

test("explicit migration previews, preserves exact backup and refuses overwrite or lost dedup identifiers", t => {
  const filename = workspace(t), source = filename + ".json";
  const legacy = { trigger_state_schema_version: "touba-trigger-state-v1", triggers: { [request.triggerRef]: {
    consumed_event_ids: [request.eventId], events: [{ event_id: request.eventId, source_kind: "request", run_id: request.runId,
      observed_at: "2026-10-24T12:00:00.000Z", status: "accepted" }],
  } } };
  writeFileSync(source, JSON.stringify(legacy));
  assert.equal(migrateTriggerState({ source, destination: filename }).applied, false);
  assert.equal(existsSync(filename), false);
  const result = migrateTriggerState({ source, destination: filename, apply: true });
  assert.deepEqual(readFileSync(result.backup), readFileSync(source));
  const store = open(t, filename);
  assert.equal(store.consumed(request.triggerRef, request.eventId), true);
  assert.equal(store.count(request.triggerRef, "2026-10-24"), 1);
  assert.throws(() => migrateTriggerState({ source, destination: filename, apply: true }));
  legacy.triggers[request.triggerRef].consumed_event_ids.push("lost");
  writeFileSync(source, JSON.stringify(legacy));
  assert.throws(() => migrateTriggerState({ source, destination: filename + ".new.sqlite", apply: true }), { code: "TriggerStateSchemaMismatch" });
  assert.equal(existsSync(filename + ".new.sqlite"), false);
});
