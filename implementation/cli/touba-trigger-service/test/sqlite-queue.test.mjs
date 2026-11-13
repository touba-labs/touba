import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createSqliteTriggerQueue, migrateTriggerQueue } from "../src/sqlite-queue.mjs";

const moduleUrl = new URL("../src/sqlite-queue.mjs", import.meta.url).href;
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "touba-queue-store-"));
  const filename = join(root, "queue.sqlite");
  const store = createSqliteTriggerQueue({ filename, ...options });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { filename, store };
}
function entry(id = "1") { return { queue_id: `queue:${id}`, event_id: `event-${id}`, trigger_ref: "trigger:example/Webhook",
  source_kind: "request", status: "queued", received_at: "2026-01-01T00:00:00.000Z" }; }
function child(code) {
  const worker = spawn(process.execPath, ["--input-type=module", "-e", code]);
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    worker.stdout.on("data", c => stdout += c); worker.stderr.on("data", c => stderr += c);
    worker.on("error", reject); worker.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("queue limits and pages; completion requires a fresh owned snapshot", t => {
  const { store } = fixture(t, { maxEntries: 2 });
  store.enqueue(entry()); store.enqueue(entry("2"));
  assert.throws(() => store.enqueue(entry("3")), { code: "TriggerQueueCapacityExceeded" });
  assert.equal(store.page({ limit: 1 }).entries.length, 1);
  assert.equal(store.page({ after: "queue:1" }).entries[0].event_id, "event-2");
  assert.throws(() => store.page({ limit: 1001 }), { code: "TriggerQueueQueryInvalid" });
  const claimed = store.claim(1000), stale = store.find(claimed.trigger_ref, claimed.event_id);
  assert.equal(claimed.attempt_count, 1);
  assert.throws(() => store.finish({ ...claimed }), { code: "TriggerQueueWriteConflict" });
  claimed.status = "succeeded"; store.finish(claimed);
  stale.status = "failed";
  assert.throws(() => store.finish(stale), { code: "TriggerQueueWriteConflict" });
  assert.equal(store.find(claimed.trigger_ref, claimed.event_id).status, "succeeded");
});

test('metadata omits private bodies; filtered pages and durable retry counts agree',t=>{
  const {store}=fixture(t);store.enqueue({...entry(),arguments:{secret:'private'}});store.enqueue(entry('2'));
  const claimed=store.claim(1000),stale=store.get(claimed.queue_id);
  claimed.run_id='run:test';store.progress(claimed);
  assert.throws(()=>store.progress(stale),{code:'TriggerQueueWriteConflict'});
  assert.equal(store.page({states:['processing']}).entries.length,1);
  assert.equal(store.page({states:['queued']}).entries.length,1);
  assert.throws(()=>store.page({states:["queued') OR 1=1"]}),{code:'TriggerQueueQueryInvalid'});
  assert.doesNotMatch(JSON.stringify(store.metadata()),/private|arguments/);
  claimed.status='queued';claimed.next_attempt_at=new Date(Date.now()+10000).toISOString();store.finish(claimed);
  assert.equal(store.retries(claimed.trigger_ref),1);
  assert.throws(()=>store.progress(claimed),{code:'TriggerQueueWriteConflict'});
  claimed.status='succeeded';store.finish(claimed);assert.equal(store.retries(claimed.trigger_ref),0);
});

test("a timed-out live worker is not reclaimed by another queue connection", t => {
  const { store, filename } = fixture(t);
  store.enqueue(entry()); const now = Date.now();
  assert.ok(store.claim(10, now));
  const peer = createSqliteTriggerQueue({ filename });
  try { assert.equal(peer.claim(10, now + 1000), undefined); }
  finally { peer.close(); }
});

test("separate processes compete for one queue attempt", async t => {
  const { store, filename } = fixture(t); store.enqueue(entry());
  const results = await Promise.all(Array.from({ length: 6 }, () => child(`
    import {createSqliteTriggerQueue} from ${JSON.stringify(moduleUrl)};
    const store=createSqliteTriggerQueue({filename:${JSON.stringify(filename)}});
    console.log(JSON.stringify({claimed:Boolean(store.claim(60000))})); store.close();`)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(results.filter(r => JSON.parse(r.stdout).claimed).length, 1);
});

test("crashed workers become explicitly uncertain and retain the queue identity", async t => {
  const { store, filename } = fixture(t); store.enqueue(entry());
  const result = await child(`import {createSqliteTriggerQueue} from ${JSON.stringify(moduleUrl)};
    const store=createSqliteTriggerQueue({filename:${JSON.stringify(filename)}}); store.claim(1);
    process.kill(process.pid,'SIGKILL');`);
  assert.equal(result.signal, "SIGKILL", result.stderr);
  const recovered = store.claim(1, Date.now() + 10);
  assert.equal(recovered.queue_id, "queue:1"); assert.equal(recovered.attempt_count, 2);
  assert.equal(recovered.recovery_effect_outcome, "unknown");
  assert.equal(store.counts("trigger:example/Webhook").processing, 1);
});

test("archival verifies successful entries and leaves active, failed and uncertain work intact", t => {
  const { filename, store } = fixture(t, { maxEntries: 3 });
  store.enqueue(entry()); store.enqueue(entry("pending"));
  store.enqueue({ ...entry("uncertain"), status: "dead_lettered" });
  const completed = store.claim(1000); completed.status = "succeeded"; completed.completed_at = "2026-02-01T00:00:00.000Z";
  store.finish(completed);
  const options = { before: "2027-01-01T00:00:00Z", destination: filename + ".archive.sqlite" };
  assert.equal(store.archive(options).entry_count, 1);
  assert.equal(store.page().entries.length, 3);
  assert.equal(store.archive({ ...options, apply: true }).entry_count, 1);
  assert.equal(store.page().entries.length, 2);
  assert.ok(store.find(entry().trigger_ref, "event-uncertain"));
  store.enqueue(entry("new")); // The verified archive frees a slot.
  const archived = createSqliteTriggerQueue({ filename: options.destination, readOnly: true });
  try { assert.equal(archived.page().entries[0].status, "succeeded"); } finally { archived.close(); }
  assert.throws(() => store.archive({ ...options, apply: true }));
});

test("a crashed continuation is never eligible for automatic admission", async t => {
  const {store,filename}=fixture(t); store.enqueue(entry());
  const pending=store.claim(10); pending.status='awaiting_human'; pending.checkpoint={approval_ref:'approval:test',
    approval_state:{requests:{'approval:test':{request_id:'request-one'}}}};
  store.finish(pending); assert.equal(store.claim(10),undefined);
  assert.throws(()=>store.continue('queue:1','old-request'),{code:'TriggerApprovalConflict'});
  const result=await child(`import {createSqliteTriggerQueue} from ${JSON.stringify(moduleUrl)};
    const store=createSqliteTriggerQueue({filename:${JSON.stringify(filename)}});
    store.continue('queue:1','request-one'); process.kill(process.pid,'SIGKILL');`);
  assert.equal(result.signal,'SIGKILL');
  assert.equal(store.claim(1,Date.now()+10),undefined);
  const interrupted=store.get('queue:1'); assert.equal(interrupted.status,'interrupted');
  assert.equal(interrupted.attempt_count,1); assert.equal(interrupted.continuation_count,1);
  assert.equal(store.counts(entry().trigger_ref).interrupted,1);
  assert.throws(()=>store.continue('queue:1','request-one'),{code:'TriggerApprovalConflict'});
});

test("queue migration validates a preview, preserves the source and refuses duplicate identities", t => {
  const { filename } = fixture(t);
  const source = filename + ".json", destination = filename + ".migrated.sqlite";
  const document = { trigger_queue_schema_version: "touba-trigger-queue-v1", entries: [entry()] };
  writeFileSync(source, JSON.stringify(document));
  assert.equal(migrateTriggerQueue({ source, destination }).record_count, 1);
  assert.equal(existsSync(destination), false);
  const migrated = migrateTriggerQueue({ source, destination, apply: true });
  assert.deepEqual(readFileSync(migrated.backup), readFileSync(source));
  const queue = createSqliteTriggerQueue({ filename: destination, readOnly: true });
  try { assert.deepEqual(queue.page().entries[0], entry()); } finally { queue.close(); }
  document.entries.push(entry()); writeFileSync(source, JSON.stringify(document));
  assert.throws(() => migrateTriggerQueue({ source, destination }), { code: "TriggerQueueEntryInvalid" });
});
