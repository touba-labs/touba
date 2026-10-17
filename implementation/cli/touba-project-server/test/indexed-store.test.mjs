import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { indexedStore } from "../src/indexed-store.mjs";

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "touba-indexed-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "records.sqlite");
  const store = indexedStore({
    path, schemaVersion: "test-record-v1", keyOf: record => record.id,
    indexes: { status: "json_extract(body, '$.status')", run_id: "json_extract(body, '$.run_id')" },
    validate: record => {
      assert.equal(typeof record.id, "string");
      assert.equal(typeof record.status, "string");
      options.validate?.(record);
    },
    checkTransaction: options.checkTransaction,
  });
  return { path, store };
}

test("indexed store selects and updates only the requested record, retaining all history", t => {
  let validations = 0;
  const { path, store } = fixture(t, { validate: () => validations++ });
  const initial = store.read();
  initial.push(...Array.from({ length: 1000 }, (_, i) => ({ id: `run-${i}`, run_id: `run-${i}`, status: "completed" })));
  store.write(initial);
  validations = 0;
  const selected = store.read([{ id: "run-40" }]);
  assert.equal(validations, 1);
  selected[0].status = "reviewed";
  store.write(selected);
  assert.equal(validations, 2);
  assert.equal(store.read().length, 1000);
  assert.deepEqual(store.read([{ status: "reviewed" }]).map(r => r.id), ["run-40"]);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT body FROM records WHERE json_extract(body, '$.run_id') IS ?").all("run-40");
    assert.match(plan.map(r => r.detail).join(" "), /USING INDEX idx_run_id/);
  } finally { db.close(); }
});

test("conflicting writes roll back the whole batch and cannot erase unrelated history", t => {
  const { store } = fixture(t);
  const empty = store.read();
  empty.push({ id: "a", status: "pending" }, { id: "b", status: "pending" });
  store.write(empty);
  const first = store.read(), stale = store.read();
  first[1].status = "approved";
  store.write(first);
  stale[0].status = "completed";
  stale[1].status = "rejected";
  assert.throws(() => store.write(stale), { code: "ToubaStoreWriteConflict" });
  assert.deepEqual(store.read().map(r => r.status), ["pending", "approved"]);
  first.pop();
  assert.throws(() => store.write(first), { code: "ToubaStoreDeletionRefused" });
});

test("transaction invariants reject all writes atomically", t => {
  const { store } = fixture(t, { checkTransaction(db) {
    if (db.prepare("SELECT COUNT(*) AS n FROM records").get().n > 1) throw Error("capacity");
  } });
  const records = store.read();
  records.push({ id: "a", status: "pending" }, { id: "b", status: "pending" });
  assert.throws(() => store.write(records), /capacity/);
  assert.deepEqual(store.read(), []);
});

test("old JSON state is refused without rewriting or migrating it", t => {
  const { path, store } = fixture(t);
  const old = JSON.stringify({ schema_version: "test-record-v1", records: [] });
  writeFileSync(path, old);
  assert.throws(() => store.read(), { code: "ToubaStoreFormatIncompatible" });
  assert.equal(readFileSync(path, "utf8"), old);
});

test("read and write validate current content and reject fabricated snapshots", t => {
  const { path, store } = fixture(t);
  assert.throws(() => store.write([]), { code: "ToubaStoreSnapshotRequired" });
  const initial = store.read(); initial.push({ id: "a", status: "pending" }); store.write(initial);
  const db = new DatabaseSync(path);
  try { db.prepare("UPDATE records SET body=? WHERE id=?").run(JSON.stringify({ id: "b", status: "pending" }), "a"); }
  finally { db.close(); }
  assert.throws(() => store.read([{ id: "a" }]), { code: "ToubaStoreRecordInvalid" });
});

test("selection parameters are bound, not interpolated SQL", t => {
  const { store } = fixture(t);
  const records = store.read(); records.push({ id: "safe", status: "pending" }); store.write(records);
  assert.deepEqual(store.read([{ id: "safe' OR 1=1 --" }]), []);
  assert.throws(() => store.read([{ unknown: "a" }]), { code: "ToubaStoreQueryInvalid" });
  assert.throws(() => store.read([{}]), { code: "ToubaStoreQueryInvalid" });
  assert.throws(() => store.read([]), { code: "ToubaStoreQueryInvalid" });
});

test("an unchanged peer in a stale read set cannot authorize another update", t => {
  const { store } = fixture(t);
  const initial = store.read(); initial.push({ id: "decision", status: "approved" }, { id: "effect", status: "pending" }); store.write(initial);
  const stale = store.read();
  const revoked = store.read([{ id: "decision" }]); revoked[0].status = "revoked"; store.write(revoked);
  stale.find(record => record.id === "effect").status = "applied";
  assert.throws(() => store.write(stale), { code: "ToubaStoreWriteConflict" });
  assert.equal(store.read([{ id: "effect" }])[0].status, "pending");
});

test("explicit projection eviction cannot delete an unseen or concurrently modified row", t => {
  const { store } = fixture(t);
  const initial = store.read(); initial.push({ id: "old", status: "complete" }); store.write(initial);
  assert.throws(() => store.write(store.read(), { removeIds: ["unknown"] }), { code: "ToubaStoreDeletionRefused" });
  const stale = store.read(); stale.splice(0);
  const changed = store.read(); changed[0].status = "pending"; store.write(changed);
  assert.throws(() => store.write(stale, { removeIds: ["old"] }), { code: "ToubaStoreWriteConflict" });
  const current = store.read(); current.splice(0); store.write(current, { removeIds: ["old"] });
  assert.deepEqual(store.read(), []);
});

test("SQLite storage exhaustion rolls back every write and preserves the original error", t => {
  let exhaust = false;
  const { store } = fixture(t, { checkTransaction(db) {
    if (!exhaust) return;
    const count = db.prepare("PRAGMA page_count").get().page_count;
    db.exec(`PRAGMA max_page_count=${count}`);
    db.prepare("INSERT INTO records VALUES ('overflow', 1, ?)").run(JSON.stringify({ id: "overflow", status: "pending", data: "x".repeat(1024 * 1024) }));
  } });
  const initial = store.read(); initial.push({ id: "kept", status: "pending" }); store.write(initial);
  const next = store.read(); next[0].status = "completed"; exhaust = true;
  assert.throws(() => store.write(next), error => error.errcode === 13 && /full/i.test(error.message));
  assert.equal(store.read()[0].status, "pending");
  assert.equal(store.read().length, 1);
});

function childStore(path, body) {
  const source = `import { indexedStore } from ${JSON.stringify(new URL("../src/indexed-store.mjs", import.meta.url).href)};
    const store = indexedStore({ path: ${JSON.stringify(path)}, schemaVersion: "test-record-v1",
      keyOf: record => record.id, validate() {}, ${body.includes("checkTransaction") ? body : ""} });
    ${body.includes("checkTransaction") ? "const records=store.read(); records[0].status='uncommitted'; store.write(records);" : body}`;
  return spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
}

test("eight separate processes competing for one revision have exactly one winner", { timeout: 15000 }, async t => {
  const { path, store } = fixture(t);
  const initial = store.read(); initial.push({ id: "shared", status: "pending" }); store.write(initial);
  const children = Array.from({ length: 8 }, () => childStore(path, `
    const records=store.read(); process.send('ready');
    process.once('message', () => {
      records[0].status='claimed';
      try { store.write(records); process.send('committed'); }
      catch(error) { process.send(error.code); }
      process.disconnect();
    });`));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill("SIGKILL"); }));
  const exits = children.map(child => once(child, "exit"));
  await Promise.all(children.map(async child => assert.equal((await once(child, "message"))[0], "ready")));
  const outcomes = children.map(child => once(child, "message"));
  children.forEach(child => child.send("go"));
  const results = (await Promise.all(outcomes)).flat();
  assert.equal(results.filter(result => result === "committed").length, 1);
  assert.equal(results.filter(result => result === "ToubaStoreWriteConflict").length, 7);
  await Promise.all(exits);
  assert.equal(store.read()[0].status, "claimed");
});

test("SIGKILL during an uncommitted transaction leaves the previous durable record", { timeout: 10000 }, async t => {
  const { path, store } = fixture(t);
  const initial = store.read(); initial.push({ id: "kept", status: "committed" }); store.write(initial);
  const child = childStore(path, `checkTransaction() {
    process.send('written-not-committed'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }`);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  assert.equal((await once(child, "message"))[0], "written-not-committed");
  child.kill("SIGKILL"); await exited;
  assert.equal(store.read()[0].status, "committed");
});
