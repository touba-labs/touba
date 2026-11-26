import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { indexedStore } from "../../../runtime/touba-runtime/src/sqlite-record-store.mjs";
import { validatedRecordCodec } from "../src/validated-records.mjs";

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

test("all record readers reject stored UTF-8 bodies over their configured limit before parsing", t => {
  const { path, store } = fixture(t);
  const initial = store.read();
  initial.push({ id: "large", status: "done", payload: "é".repeat(80) });
  store.write(initial);
  const before = readFileSync(path);
  let parses = 0;
  const limited = indexedStore({ path, schemaVersion: "test-record-v1", keyOf: record => record.id,
    maxRecordBytes: 128, validate() { parses++; },
    parseValidated(body) { parses++; return JSON.parse(body); } });
  for (const read of [() => limited.read([{ id: "large" }]),
    () => limited.page({ filter: [{ id: "large" }] }),
    () => limited.project(row => row.id, { filter: [{ id: "large" }], limit: 1 })]) {
    assert.throws(read, { code: "ToubaStoreRecordTooLarge" });
  }
  assert.equal(parses, 0, "byte admission must precede JSON parsing or validation-cache reuse");
  assert.deepEqual(readFileSync(path), before);
});

test("bounded pages retain indexed OR filters, cursors and revision-checked writes", t => {
  let validations = 0;
  const { store } = fixture(t, { validate: () => validations++ });
  const initial = store.read();
  initial.push(...Array.from({ length: 1005 }, (_, i) => ({ id: String(i).padStart(5, "0"), status: i % 2 ? "pending" : "done" })));
  store.write(initial); validations = 0;
  const first = store.page({ filter: [{ status: "pending" }, { id: "00002" }], limit: 3 });
  assert.equal(validations, 3);
  assert.deepEqual(first.items.map(item => item.id), ["00001", "00002", "00003"]);
  const second = store.page({ filter: [{ status: "pending" }, { id: "00002" }], after: first.next, limit: 3 });
  assert.deepEqual(second.items.map(item => item.id), ["00005", "00007", "00009"]);
  second.items[0].status = "reviewed"; store.write(second.items);
  assert.equal(store.count([{ status: "reviewed" }]), 1);
  assert.equal(store.count(), 1005);
  assert.deepEqual(store.countBy("status").map(row => ({ ...row })), [
    { value: "done", count: 503 }, { value: "pending", count: 501 }, { value: "reviewed", count: 1 },
  ]);
  assert.throws(() => store.countBy("not_an_index"), { code: "ToubaStoreQueryInvalid" });
  assert.throws(() => store.page({ limit: 1001 }), { code: "ToubaStoreQueryInvalid" });
  assert.throws(() => store.page({ after: 3 }), { code: "ToubaStoreQueryInvalid" });
  assert.equal(store.page({ after: "zzzz" }).next, null);
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

test("bounded read-only projections validate whole records without creating writable snapshots", t => {
  let validations = 0;
  const { path, store } = fixture(t, { validate: () => validations++ });
  const initial = store.read();
  initial.push(...Array.from({ length: 12 }, (_, i) => ({ id: `row-${i}`, status: "done", payload: "x".repeat(1024 * 1024) })));
  store.write(initial); validations = 0;
  const before = readFileSync(path);
  const projected = store.project(record => ({ id: record.id, status: record.status }), { limit: 12, maxOutputBytes: 1024 });
  assert.equal(projected.length, 12); assert.equal(validations, 12);
  assert.ok(!JSON.stringify(projected).includes("payload"));
  assert.throws(() => store.write(projected), { code: "ToubaStoreSnapshotRequired" });
  assert.throws(() => store.project(row => row, { limit: 11 }), { code: "ToubaStoreCapacityExceeded" });
  assert.throws(() => store.project(row => row, { limit: 12, maxOutputBytes: 100 }), { code: "ToubaStoreCapacityExceeded" });
  assert.throws(() => store.project(row => row, { limit: 1001 }), { code: "ToubaStoreQueryInvalid" });
  assert.deepEqual(store.project(row => row.id, { limit: 1, filter: [{ id: "row-3" }] }), ["row-3"]);
  assert.deepEqual(readFileSync(path), before);
  const db = new DatabaseSync(path);
  try { db.prepare("UPDATE records SET body=? WHERE id=?").run(JSON.stringify({ id: "row-3", status: false }), "row-3"); }
  finally { db.close(); }
  assert.throws(() => store.project(row => row.id, { limit: 12 }));
});

test("reverse pages keep a stable key boundary when new records arrive", t => {
  let validations = 0;
  const { store } = fixture(t, { validate: () => validations++ });
  const initial = store.read();
  initial.push(...["z", "b", "x", "a", "y"].map(id => ({ id, status: "done" })));
  store.write(initial); validations = 0;
  const first = store.page({ order: "rowid", direction: "desc", limit: 2 });
  assert.equal(validations, 2);
  assert.deepEqual(first.items.map(row => row.id), ["y", "a"]);
  assert.equal(first.hasMore, true);
  const added = store.read([{ id: "new" }]); added.push({ id: "new", status: "pending" }); store.write(added);
  const second = store.page({ order: "rowid", direction: "desc", after: first.next, limit: 2 });
  assert.deepEqual(second.items.map(row => row.id), ["x", "b"]);
  assert.equal(second.hasMore, true);
  const last = store.page({ order: "rowid", direction: "desc", after: second.next, limit: 2 });
  assert.deepEqual(last.items.map(row => row.id), ["z"]);
  assert.equal(last.hasMore, false);
  assert.deepEqual(store.page({ order: "id", direction: "desc", filter: [{ status: "pending" }, { id: "z" }] }).items.map(row => row.id), ["z", "new"]);
  assert.throws(() => store.page({ direction: "DESC; DELETE FROM records" }), { code: "ToubaStoreQueryInvalid" });
});

test("bounded physical-order audit pages retain filters, full validation and writable snapshots", t => {
  let validations = 0;
  const { path, store } = fixture(t, { validate: () => validations++ });
  const records = store.read();
  records.push(...["z", "b", "x", "a", "y"].map(id => ({ id, status: "done" })));
  store.write(records);
  validations = 0;
  const first = store.page({ order: "rowid", limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ["z", "b"]);
  assert.equal(first.next, 2);
  first.items[0].status = "reviewed"; store.write(first.items);
  const second = store.page({ order: "rowid", after: first.next, limit: 2,
    filter: [{ id: "x" }, { id: "y" }] });
  assert.deepEqual(second.items.map(item => item.id), ["x", "y"]);
  assert.equal(second.next, 5);
  assert.equal(validations, 6);
  assert.equal(store.page({ order: "rowid", after: second.next }).next, null);
  assert.throws(() => store.page({ order: "rowid", after: "2" }), { code: "ToubaStoreQueryInvalid" });
  assert.throws(() => store.page({ order: "rowid", after: NaN }), { code: "ToubaStoreQueryInvalid" });
  assert.throws(() => store.page({ order: "rowid", after: 2 ** 53 }), { code: "ToubaStoreQueryInvalid" });
  assert.throws(() => store.page({ order: "id; DROP TABLE records" }), { code: "ToubaStoreQueryInvalid" });
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE records SET body=? WHERE id=?").run(JSON.stringify({ id: "y", status: false }), "y");
  } finally { db.close(); }
  assert.throws(() => store.page({ order: "rowid", after: 4 }));
});

test("validating parsers preserve fresh reads, writer checks, key checks and revision conflicts", t => {
  const { path } = fixture(t);
  let validations = 0;
  const codec = validatedRecordCodec(record => {
    validations++;
    assert.equal(typeof record.id, "string");
    assert.ok(Number.isFinite(record.number));
  });
  const store = indexedStore({ path, schemaVersion: "test-record-v1", keyOf: record => record.id,
    validate: codec.validate, parseValidated: codec.parse });
  const initial = store.read(); initial.push({ id: "one", number: 1 }); store.write(initial);
  const first = store.page().items, stale = store.page().items;
  assert.equal(validations, 2); // One write and one validation of these exact bytes.
  first[0].number = 2; store.write(first);
  stale[0].number = 3;
  assert.throws(() => store.write(stale), { code: "ToubaStoreWriteConflict" });
  const current = store.read(); current[0].number = NaN;
  assert.throws(() => store.write(current));
  assert.equal(store.read()[0].number, 2);
  const db = new DatabaseSync(path);
  try { db.prepare("UPDATE records SET id=? WHERE id=?").run("foreign", "one"); }
  finally { db.close(); }
  assert.throws(() => store.read(), { code: "ToubaStoreRecordInvalid" });
});

test("both page orders enforce the byte ceiling before returning validated records", t => {
  const { path } = fixture(t);
  const codec = validatedRecordCodec(record => assert.equal(typeof record.id, "string"));
  const store = indexedStore({ path, schemaVersion: "test-record-v1", keyOf: record => record.id,
    validate: codec.validate, parseValidated: codec.parse, maxRecordBytes: 32 * 1024 * 1024 });
  const initial = store.read();
  initial.push({ id: "one", data: "x".repeat(9 * 1024 * 1024) }, { id: "two", data: "y".repeat(9 * 1024 * 1024) });
  store.write(initial);
  for (const order of ["id", "rowid"]) {
    const first = store.page({ order });
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].id, "one");
    assert.equal(store.page({ order, after: first.next }).items[0].id, "two");
  }
  const changed = store.read([{ id: "two" }]); changed[0].data = "z".repeat(17 * 1024 * 1024);
  store.write(changed);
  for (const order of ["id", "rowid"]) {
    assert.throws(() => store.page({ order, filter: [{ id: "two" }] }), { code: "ToubaStoreRecordTooLarge" });
  }
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

test("an unchanged snapshot still checks concurrent revocation at commit", t => {
  const { store } = fixture(t);
  const initial = store.read(); initial.push({ id: "key", status: "active" }); store.write(initial);
  const stale = store.read();
  const revoked = store.read(); revoked[0].status = "revoked"; store.write(revoked);
  assert.throws(() => store.write(stale), { code: "ToubaStoreWriteConflict" });
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
  const source = `import { indexedStore } from ${JSON.stringify(new URL("../../../runtime/touba-runtime/src/sqlite-record-store.mjs", import.meta.url).href)};
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
