import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, chmodSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createSqliteTraceStore } from "../src/sqlite-trace-store.mjs";
import { TraceBuilder, sha256Json } from "../src/trace-builder.mjs";
import { executeAirDocument } from "../src/index.mjs";
import { canonicalDigest } from "../src/execution-checkpoints.mjs";
import { validateTraceMachineContract } from "../../../contracts/machine/contracts.mjs";
import { createTraceReference, traceJsonDigest } from "../../../contracts/trace-reference.mjs";

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "touba-trace-sqlite-"));
  const filename = join(root, "state.sqlite");
  const store = createSqliteTraceStore({ filename, ...options });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, filename, store };
}
const air = { air_schema_version: "touba-air-v1", air_capability_profile: "touba-air-capabilities-v1",
  air_json_profile: "touba-air-json-canonical-v1", module: { id: "module:storage", name: "storage" },
  definitions: { types: [], constants: [], functions: [], tools: [], memories: [], agents: [], strategies: [], triggers: [],
    skills: [{ id: "skill:storage/Run", name: "Run", flow_graph_ref: "graph:skill:storage/Run",
      signature: { inputs: [], output_type: "builtin:Text" }, uses: [] }] },
  execution_graphs: [{ id: "graph:skill:storage/Run", owner_ref: "skill:storage/Run", entry_node_id: "n1",
    nodes: [{ id: "n1", kind: "give", arguments: ["literal:string:ok"] }], edges: [], expressions: [], failure_paths: [] }], trace_points: [] };
function builder(store, start = 0) { return new TraceBuilder(air, "skill:storage/Run", "stored-run", null, start, "full", store); }

test('run discovery groups segments, paginates literal identifiers and filters across all segments', t => {
  const { store } = fixture(t);
  const add = (id, start, kind, payload = {}) => {
    const trace = new TraceBuilder(air, 'skill:storage/Run', id, null, start, 'full', store);
    trace.push(kind, { payload });
  };
  add('run-a', 0, 'tool_dispatch_refused');
  add('run-a', 1, 'run_completed', { status: 'success' });
  add('run-b', 0, 'tool_execution_status', { status: 'refused', phase: 'execution' });
  add('run-c', 0, 'run_completed', { status: 'success', private: 'sensitive-search-text' });
  add('run-%literal', 0, 'tool_execution_status', { status: 'refused', phase: 'admission' });
  const all = store.runPage();
  assert.equal(all.runs.length, 4);
  assert.equal(all.runs.find(row => row.runId === 'run-a').segmentCount, 2);
  assert.equal(all.runs.find(row => row.runId === 'run-a').eventCount, 2);
  let cursor = '', found = [];
  do { const page = store.runPage({ after: cursor, limit: 1 }); found.push(...page.runs.map(row => row.runId)); cursor = page.next; } while (cursor);
  assert.deepEqual(found, all.runs.map(row => row.runId));
  assert.deepEqual(store.runPage({ search: '%' }).runs.map(row => row.runId), ['run-%literal']);
  assert.equal(store.runPage({ search: 'sensitive-search-text' }).runs.length, 0);
  assert.equal(store.runPage({ search: "' OR 1=1 --" }).runs.length, 0);
  assert.deepEqual(store.runPage({ category: 'refusal' }).runs.map(row => row.runId), ['run-%literal', 'run-a']);
  assert.deepEqual(store.runPage({ category: 'error' }).runs.map(row => row.runId), ['run-b']);
  assert.equal(store.runPage({ search: 'STORAGE' }).runs.length, 4);
  for (const options of [{ limit: 0 }, { limit: 101 }, { search: 'x'.repeat(257) }, { category: 'payload' }]) assert.throws(() => store.runPage(options));
});

test("simultaneous first writers initialize one SQLite journal without schema races", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-trace-first-writers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/sqlite-trace-store.mjs", import.meta.url).href;
  for (let round = 0; round < 3; round++) {
    const filename = join(root, `round-${round}.sqlite`);
    await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import {createSqliteTraceStore} from ${JSON.stringify(moduleUrl)};
        const store=createSqliteTraceStore({filename:${JSON.stringify(filename)}});
        const id=store.openSegment({run:{run_id:${JSON.stringify(`run-${index}`)}}},0);
        store.append(id,{kind:'run_completed',run_id:${JSON.stringify(`run-${index}`)},
          event_id:${JSON.stringify(`event:run-${index}:1`)},sequence_index:0,payload:{status:'success'}});
        store.close();`], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
    })));
    const store = createSqliteTraceStore({ filename, readOnly: true });
    try { assert.equal([...store.segments()].length, 8); } finally { store.close(); }
  }
});

test('host execution origin is immutable, searchable and retained with its trace', async t => {
  const {store, root} = fixture(t);
  const result = await executeAirDocument(air, {traceStorage:store});
  const runId = result.traceReader.header.run.run_id;
  const before = store.statistics().bytes;
  const origin = {kind:'service', id:'application:qa', name:'Portail achats'};
  store.recordOrigin(runId, origin);
  const bytes = store.statistics().bytes;
  assert.ok(bytes > before);
  store.recordOrigin(runId, origin);
  assert.equal(store.statistics().bytes, bytes);
  assert.throws(() => store.recordOrigin(runId, {...origin,name:'Other'}), {code:'TraceOriginConflict'});
  assert.deepEqual(store.origin(runId), origin);
  assert.deepEqual(store.runPage({search:'Portail achats'}).runs.map(row => row.runId), [runId]);
  const destination = join(root, 'with-origin.sqlite');
  store.archive({destination,apply:true});
  assert.equal(store.origin(runId), null);
  const archived = createSqliteTraceStore({filename:destination,readOnly:true});
  try { assert.deepEqual(archived.origin(runId),origin); } finally { archived.close(); }
});

test("retention previews, durably archives and preserves references without retaining completed payloads", async t => {
  const { store, root } = fixture(t);
  const result = await executeAirDocument(air, { traceStorage: store });
  const reference = createTraceReference(result.traceReader);
  assert.equal(store.archive().status, "preview");
  assert.equal([...store.segments()].length, 1);
  const destination = join(root, "archive.sqlite");
  assert.equal(store.archive({ destination, apply: true, protectedRunIds: [reference.run_id] }).segments, 0);
  assert.equal(existsSync(destination), false);
  const report = store.archive({ destination, apply: true });
  assert.equal(report.segments, 1); assert.equal(report.status, "archived");
  assert.equal([...store.segments()].length, 0);
  const retained = createSqliteTraceStore({ filename: destination, readOnly: true });
  try { assert.ok(retained.readReference(reference).done); } finally { retained.close(); }
  const next = await executeAirDocument(air, { traceStorage: store });
  assert.equal(next.status, "success");
  assert.throws(() => store.archive({ destination, apply: true }), { code: "EEXIST" });
  assert.equal([...store.segments()].length, 1);
});

test("retention protects paused, failed and interrupted runs and removes a resumed success as one run", t => {
  const { store, root } = fixture(t);
  const first = builder(store); first.push("run_started");
  first.push("run_completed", { payload: { status: "stopped", reason: "human_approval_pending" } });
  assert.equal(store.archive().segments, 0);
  const resumed = builder(store, 2); resumed.push("run_started");
  assert.equal(store.archive().segments, 0);
  resumed.push("run_completed", { payload: { status: "failure", reason: "failed" } });
  assert.equal(store.archive().segments, 0);
  const final = builder(store, 4); final.push("run_started");
  final.push("run_completed", { payload: { status: "success", reason: "completed" } });
  assert.equal(store.archive({ destination: join(root, "history.sqlite"), apply: true }).segments, 3);
  assert.equal([...store.segments()].length, 0);
});

test("durable references read completed resumed segments without writing or materializing", t => {
  const { filename, store, root } = fixture(t, { maxDocumentBytes: 1 });
  const trace = builder(store, 40);
  trace.push("run_started");
  assert.throws(() => createTraceReference(trace.snapshot()), /completed durable segment/);
  for (let i = 0; i < 8; i++) trace.push("binding_created", { payload: { label: "é🙂", index: i } });
  trace.push("run_completed", { payload: { status: "stopped", reason: "user_input_pending" } });
  const reader = trace.snapshot(), reference = createTraceReference(reader);
  assert.equal(reference.trace_digest, traceJsonDigest(JSON.parse([...reader.json()].join(""))));
  store.close();
  const before = readFileSync(filename), modified = statSync(filename).mtimeMs;
  const readOnly = createSqliteTraceStore({ filename, readOnly: true, maxDocumentBytes: 1 });
  try {
    let after = 39, all = [];
    while (true) {
      const page = readOnly.readReference(reference, { after, limit: 3 });
      assert.ok(page.events.length <= 3);
      all.push(...page.events); after = page.next;
      if (page.done) break;
    }
    assert.equal(all.length, 10);
    assert.deepEqual(all.map(event => event.sequence_index), Array.from({ length: 10 }, (_, i) => i + 40));
    assert.deepEqual(readOnly.readReference(reference, { after }).events, []);
    assert.throws(() => readOnly.openSegment(reader.header), { code: "TraceStorageReadOnly" });
    assert.throws(() => readOnly.append(reader.segmentId, all[0]), { code: "TraceStorageReadOnly" });
    for (const change of [
      { run_id: "other" }, { event_count: 11 }, { header_digest: "sha256:" + "0".repeat(64) },
      { trace_digest: "sha256:" + "0".repeat(64) }, { terminal: { ...reference.terminal, digest: "sha256:" + "0".repeat(64) } },
    ]) assert.throws(() => readOnly.readReference({ ...reference, ...change }));
    for (const options of [{ after: 38 }, { after: 50 }, { limit: 0 }, { limit: 1001 }, { after: 40.5 }]) {
      assert.throws(() => readOnly.readReference(reference, options));
    }
  } finally { readOnly.close(); }
  assert.deepEqual(readFileSync(filename), before);
  assert.equal(statSync(filename).mtimeMs, modified);
  const missing = join(root, "missing", "trace.sqlite");
  assert.throws(() => createSqliteTraceStore({ filename: missing, readOnly: true }));
  assert.equal(existsSync(join(root, "missing")), false);
});

test("reference traversal detects altered content even when its local event hash was replaced", t => {
  const { filename, store } = fixture(t);
  const trace = builder(store);
  trace.push("run_started"); trace.push("binding_created", { payload: { value: "original" } });
  trace.push("run_completed", { payload: { status: "success", reason: "completed" } });
  const reference = createTraceReference(trace.snapshot()); store.close();
  const db = new DatabaseSync(filename);
  const row = db.prepare("SELECT body FROM touba_trace_events WHERE sequence_index=1").get();
  const event = JSON.parse(row.body); event.payload.value = "altered";
  db.prepare("UPDATE touba_trace_events SET body=?,digest=? WHERE sequence_index=1")
    .run(JSON.stringify(event), traceJsonDigest(event).slice(7));
  db.close();
  const reader = createSqliteTraceStore({ filename, readOnly: true });
  try { assert.throws(() => reader.readReference(reference), { code: "TraceReferenceMismatch" }); }
  finally { reader.close(); }
});

test("runtime records a real run incrementally and returns the same canonical trace", async t => {
  const { store } = fixture(t);
  const result = await executeAirDocument(air, { traceStorage: store, runId: "stored-run" });
  assert.equal(result.status, "success"); assert.equal(result.result, "ok");
  const [segment] = [...store.segments()];
  assert.ok(segment.complete);
  assert.deepEqual(store.document(segment.id), result.trace);
  validateTraceMachineContract(result.trace);
});

test("a completed run remains usable above the full-document limit", async t => {
  const { store } = fixture(t, { maxDocumentBytes: 1 });
  const result = await executeAirDocument(air, { traceStorage: store });
  assert.equal(result.status, "success");
  assert.equal(result.result, "ok");
  assert.throws(() => result.trace, { code: "TraceMaterializationLimitExceeded" });
  const document = JSON.parse([...result.traceReader.json()].join(""));
  validateTraceMachineContract(document);
  assert.equal(document.events.length, result.traceReader.eventCount);
  assert.equal(Object.keys(result).includes("traceReader"), false);
  assert.equal(document.events.at(-1).payload.status, "success");
});

test("a reader captures its prefix before a delayed consumer starts", t => {
  const { store } = fixture(t);
  const trace = builder(store, 40);
  trace.push("run_started");
  const reader = trace.snapshot();
  const envelope = trace.attach({ checkpoint: { next_sequence_index: 41 } }, reader);
  trace.push("binding_created");
  trace.push("run_completed", { payload: { status: "success", reason: "completed" } });
  assert.equal(reader.eventCount, 1);
  assert.equal(reader.nextSequenceIndex, 41);
  assert.equal([...reader.events()].length, 1);
  assert.equal(JSON.parse([...reader.json()].join("")).events.length, 1);
  assert.equal(envelope.trace.events.length, 1);
  assert.equal(reader.document().events.length, 1);
  const changed = reader.header; changed.run.run_id = "forged";
  assert.equal(reader.header.run.run_id, "stored-run");
  assert.deepEqual([...reader.events({ after: 40 })], []);
  assert.throws(() => [...reader.events({ after: -2 })], TypeError);
  const delta = [...trace.snapshot().events({ after: 40 })];
  assert.deepEqual(delta.map(event => event.sequence_index), [41, 42]);
});

test("materialization counts JSON separators as well as stored payloads", t => {
  const { filename, store } = fixture(t);
  const trace = builder(store); trace.push("run_started");
  const bytes = Buffer.byteLength(JSON.stringify(trace.document()));
  const limited = createSqliteTraceStore({ filename, maxDocumentBytes: bytes - 1 });
  t.after(() => limited.close());
  assert.throws(() => limited.document(trace.storageSegment), { code: "TraceMaterializationLimitExceeded" });
  assert.equal(Buffer.byteLength([...limited.json(trace.storageSegment)].join("")), bytes);
});

test("durable builder releases events and pages respect sequence and count", t => {
  const { store } = fixture(t);
  const trace = builder(store, 40);
  trace.push("run_started");
  for (let i = 0; i < 250; i++) trace.push("binding_created", { payload: { index: i } });
  trace.push("run_completed", { payload: { status: "success", reason: "completed" } });
  assert.equal(trace.events.length, 0);
  assert.equal(trace.nextSequenceIndex(), 292);
  assert.equal(store.page(trace.storageSegment, { after: 140, limit: 7 }).events[0].sequence_index, 141);
  assert.equal(store.document(trace.storageSegment).events.length, 252);
  validateTraceMachineContract(trace.document());
  assert.equal(trace.digest(), sha256Json(trace.document()));
  assert.equal(`sha256:${trace.digest(true)}`, canonicalDigest(trace.document()));
  assert.equal([...store.json(trace.storageSegment)].join(""), JSON.stringify(trace.document()));
});

test("duplicate append is idempotent; conflicts, gaps, another run and late events are refused", t => {
  const { store } = fixture(t); const trace = builder(store);
  const first = trace.push("run_started");
  assert.equal(store.append(trace.storageSegment, first), false);
  assert.throws(() => store.append(trace.storageSegment, { ...first, kind: "binding_created" }), { code: "TraceEventConflict" });
  assert.throws(() => store.append(trace.storageSegment, { ...first, run_id: "other" }), { code: "TraceEventIdentityInvalid" });
  assert.throws(() => store.append(trace.storageSegment, { ...first, sequence_index: 9, event_id: "event:stored-run:10" }), { code: "TraceSequenceInvalid" });
  trace.push("run_completed");
  assert.throws(() => trace.push("binding_created"), { code: "TraceSegmentClosed" });
  assert.equal(trace.nextSequenceIndex(), 2);
});

test("quota failure is atomic and an event is never acknowledged in RAM", t => {
  const { store } = fixture(t, { maxBytes: 1000 }); const trace = builder(store);
  trace.push("run_started"); const before = [...store.segments()][0];
  assert.throws(() => trace.push("binding_created", { payload: { content: "x".repeat(1000) } }), { code: "TraceStorageLimitExceeded" });
  assert.deepEqual([...store.segments()][0], before);
  assert.equal(trace.nextSequenceIndex(), 1);
});

test("a failed batch rolls back its prefix and accounting together", t => {
  const { store } = fixture(t); const trace = builder(store);
  const start = trace.push("run_started");
  const before = [...store.segments()][0];
  const event = index => ({ ...start, sequence_index: index, event_id: `event:stored-run:${index + 1}`, kind: "binding_created" });
  assert.throws(() => store.appendBatch(trace.storageSegment, [event(1), event(3)]), { code: "TraceSequenceInvalid" });
  assert.deepEqual([...store.segments()][0], before);
  assert.equal(store.page(trace.storageSegment).events.length, 1);
});

function pureBuilder(store) {
  const document = structuredClone(air);
  document.execution_graphs.push({ id: "graph:function:storage/Pure", owner_ref: "function:storage/Pure" });
  return new TraceBuilder(document, "skill:storage/Run", "stored-run", null, 0, "full", store);
}
const pureRef = { flow_graph_ref: "graph:function:storage/Pure", owner_ref: "function:storage/Pure" };

test("pure details use bounded batches, flushed before the next call", t => {
  const { store } = fixture(t);
  let batches = 0;
  const trace = pureBuilder({ ...store, appendBatch(id, events) { batches++; return store.appendBatch(id, events); } });
  const started = performance.now();
  trace.push("run_started");
  for (let i = 0; i < 250; i++) {
    trace.push("binding_created", { airRef: pureRef, payload: { binding: `v${i}` } });
    assert.ok(trace.pendingEvents.length <= 32 && trace.pendingBytes <= 65536);
  }
  assert.ok(trace.pendingEvents.length > 0);
  trace.push("call_started");
  assert.equal(trace.pendingEvents.length, 0);
  assert.equal(store.page(trace.storageSegment).eventCount, 252);
  assert.equal(batches, 8);
  trace.push("run_completed", { payload: { status: "success", reason: "completed" } });
  validateTraceMachineContract(trace.document());
  t.diagnostic(`250 pure observations, 8 batches: ${Math.round(performance.now() - started)} ms`);
});

test("digest reads flush staged details and a failed flush never records the following call", t => {
  const { store } = fixture(t);
  let failed = false;
  const trace = pureBuilder({ ...store, appendBatch(id, events) {
    if (failed) throw Object.assign(new Error("synthetic disk failure"), { code: "SQLITE_FULL" });
    return store.appendBatch(id, events);
  } });
  trace.push("run_started");
  trace.push("binding_created", { airRef: pureRef });
  assert.equal(store.page(trace.storageSegment).eventCount, 1);
  trace.digest();
  assert.equal(store.page(trace.storageSegment).eventCount, 2);
  trace.push("binding_created", { airRef: pureRef }); failed = true;
  assert.throws(() => trace.push("call_started"), { code: "SQLITE_FULL" });
  assert.equal(store.page(trace.storageSegment).eventCount, 2);
  assert.equal(trace.nextSequenceIndex(), 3);
});

test("pure batches respect a smaller host byte limit", t => {
  const { store } = fixture(t, { maxEventBytes: 1024 }); const trace = pureBuilder(store);
  trace.push("run_started");
  for (let i = 0; i < 20; i++) {
    trace.push("binding_created", { airRef: pureRef });
    assert.ok(trace.pendingBytes <= 1024);
  }
  trace.push("run_completed", { payload: { status: "success", reason: "completed" } });
  assert.equal(trace.document().events.length, 22);
});

test("a compiled-shape pure function flushes before its following real handler", async t => {
  const { store } = fixture(t);
  const document = structuredClone(air);
  document.definitions.functions = [{ id: "function:storage/Pure", name: "Pure",
    body_graph_ref: pureRef.flow_graph_ref, signature: { inputs: [], output_type: "builtin:Text" } }];
  document.execution_graphs.push({ id: pureRef.flow_graph_ref, owner_ref: "function:storage/Pure", entry_node_id: "bind",
    nodes: [{ id: "bind", kind: "bind", result_binding: "value", arguments: ["literal:string:ok"] },
      { id: "give", kind: "give", arguments: ["value:value"] }],
    edges: [{ from_node_id: "bind", to_node_id: "give", role: "next" }], expressions: [], failure_paths: [] });
  document.definitions.tools = [{ id: "tool:storage/Write", name: "Write", signature: { inputs: [], output_type: "builtin:Text" } }];
  document.definitions.skills[0].uses = ["tool:storage/Write"];
  document.execution_graphs[0].nodes.unshift({ id: "pure", kind: "call_function", target_ref: "function:storage/Pure" },
    { id: "effect", kind: "call_tool", target_ref: "tool:storage/Write" });
  document.execution_graphs[0].entry_node_id = "pure";
  document.execution_graphs[0].edges = [{ from_node_id: "pure", to_node_id: "effect", role: "next" }, { from_node_id: "effect", to_node_id: "n1", role: "next" }];
  for (const fail of [false, true]) {
    let calls = 0, batches = 0;
    const traceStorage = { ...store, appendBatch(id, events) {
      batches++;
      if (fail) throw Object.assign(new Error("synthetic disk failure"), { code: "SQLITE_FULL" });
      return store.appendBatch(id, events);
    } };
    const execution = executeAirDocument(document, { traceStorage,
      toolHandlers: { "tool:storage/Write": () => { calls++; return "ok"; } } });
    if (fail) {
      await assert.rejects(execution, { code: "SQLITE_FULL" });
      assert.equal(calls, 0);
    } else {
      const result = await execution;
      assert.equal(result.status, "success", result.reason);
      assert.equal(calls, 1);
    }
    assert.ok(batches > 0);
  }
});

test("full document limit leaves paginated evidence available", t => {
  const { store } = fixture(t, { maxDocumentBytes: 600 }); const trace = builder(store);
  for (let i = 0; i < 10; i++) trace.push("binding_created");
  assert.throws(() => trace.document(), { code: "TraceMaterializationLimitExceeded" });
  assert.equal(store.page(trace.storageSegment, { limit: 2 }).events.length, 2);
  assert.equal(trace.events.length, 0);
  assert.equal(JSON.parse([...store.json(trace.storageSegment)].join("")).events.length, 10);
  assert.equal(trace.digest().length, 64);
});

test("two connections share the quota and reject competing events atomically", t => {
  const { filename, store } = fixture(t, { maxBytes: 1000 });
  const second = createSqliteTraceStore({ filename, maxBytes: 1000 }); t.after(() => second.close());
  const trace = builder(store);
  const event = trace.push("run_started");
  assert.equal(second.append(trace.storageSegment, event), false);
  assert.throws(() => second.append(trace.storageSegment, { ...event, payload: { changed: true } }), { code: "TraceEventConflict" });
  assert.throws(() => second.append(trace.storageSegment, { ...event, sequence_index: 1, event_id: "event:stored-run:2", payload: { data: "x".repeat(900) } }), { code: "TraceStorageLimitExceeded" });
  assert.equal(store.page(trace.storageSegment).eventCount, 1);
});

test("an export keeps its initial upper bound while another connection appends", t => {
  const { filename, store } = fixture(t);
  const second = createSqliteTraceStore({ filename }); t.after(() => second.close());
  const trace = builder(store); trace.push("run_started");
  const exported = store.json(trace.storageSegment);
  const header = exported.next().value;
  second.append(trace.storageSegment, { event_id: "event:stored-run:2", run_id: "stored-run", sequence_index: 1, kind: "binding_created" });
  assert.equal(JSON.parse(header + [...exported].join("")).events.length, 1);
  assert.equal(store.page(trace.storageSegment).eventCount, 2);
});

test("asynchronous or missing durable acknowledgements cannot advance execution", async t => {
  const { store } = fixture(t);
  for (const acknowledgement of [undefined, false, Promise.resolve(true)]) {
    const invalid = { ...store, append: () => acknowledgement };
    await assert.rejects(executeAirDocument(air, { traceStorage: invalid }), /synchronously acknowledge/);
  }
  assert.throws(() => builder({ ...store, openSegment: () => Promise.resolve("fake") }), /synchronously return/);
});

test("a storage failure before a call prevents the handler from running", async t => {
  const { store } = fixture(t);
  const document = structuredClone(air);
  document.definitions.tools = [{ id: "tool:storage/Write", name: "Write", signature: { inputs: [], output_type: "builtin:Text" }, required_secrets: [], memory_accesses: [] }];
  document.definitions.skills[0].uses = ["tool:storage/Write"];
  document.execution_graphs[0].nodes.unshift({ id: "call", kind: "call_tool", target_ref: "tool:storage/Write" });
  document.execution_graphs[0].entry_node_id = "call";
  document.execution_graphs[0].edges = [{ from_node_id: "call", to_node_id: "n1", role: "next" }];
  let calls = 0;
  const traceStorage = { ...store, append(id, event) {
    if (event.kind === "call_started") throw Object.assign(new Error("synthetic disk failure"), { code: "SQLITE_FULL" });
    return store.append(id, event);
  } };
  await assert.rejects(executeAirDocument(document, { traceStorage, toolHandlers: { "tool:storage/Write": () => { calls++; return "ok"; } } }), { code: "SQLITE_FULL" });
  assert.equal(calls, 0);
  assert.equal([...store.segments()][0].complete, false);
});

test("reopening preserves partial segments and never invents a terminal event", t => {
  const { filename, store } = fixture(t); const trace = builder(store);
  trace.push("run_started"); store.close();
  const reopened = createSqliteTraceStore({ filename }); t.after(() => reopened.close());
  assert.equal([...reopened.segments()][0].complete, false);
  assert.equal(reopened.document(trace.storageSegment).events.length, 1);
});

test("a real approval pause and its resume retain two immutable trace segments", async t => {
  const { store } = fixture(t);
  const document = structuredClone(air);
  document.execution_graphs[0].nodes.unshift({ id: "review", kind: "human_approval",
    approval_ref: "approval:storage/review", approval_mode: "required_approval", result_binding: "approval", context_refs: [] });
  document.execution_graphs[0].entry_node_id = "review";
  document.execution_graphs[0].edges = [{ from_node_id: "review", to_node_id: "n1", role: "next" }];
  const paused = await executeAirDocument(document, { traceStorage: store, durableHumanApprovals: true });
  assert.equal(paused.reason, "human_approval_pending");
  const before = [...store.segments()][0];
  const resumed = await executeAirDocument(document, { traceStorage: store,
    humanApprovalResumeCheckpoint: paused.checkpoint, humanApprovalDecisions: { "approval:storage/review": "approved" } });
  assert.equal(resumed.status, "success", JSON.stringify(resumed.trace.events.filter(event => event.kind === "failure_detected")));
  assert.deepEqual(store.document(before.id), paused.trace);
  const other = [...store.segments()].find(segment => segment.id !== before.id);
  assert.deepEqual(store.document(other.id), resumed.trace);
  assert.equal(before.runId, other.runId);
});

test("reads reject corruption and deletion instead of returning a truncated trace", t => {
  const { filename, store } = fixture(t); const trace = builder(store);
  trace.push("run_started"); trace.push("binding_created");
  const db = new DatabaseSync(filename); t.after(() => db.close());
  db.prepare("UPDATE touba_trace_events SET body='{}' WHERE sequence_index=0").run();
  assert.throws(() => trace.document(), { code: "TraceStorageCorrupt" });
  db.prepare("DELETE FROM touba_trace_events").run();
  assert.throws(() => trace.document(), { code: "TraceStorageCorrupt" });
});

test("private file, unknown schema and invalid pagination fail explicitly", t => {
  const { root, filename, store } = fixture(t);
  const trace = builder(store);
  assert.throws(() => store.page(trace.storageSegment, { limit: 1001 }), RangeError);
  assert.throws(() => store.page(trace.storageSegment, { after: -2 }), TypeError);
  store.close(); const db = new DatabaseSync(filename);
  db.exec("UPDATE touba_trace_storage SET format='unknown'"); db.close();
  assert.throws(() => createSqliteTraceStore({ filename }), { code: "TraceStorageFormatInvalid" });
  if (process.platform !== "win32") {
    const link = join(root, "link.sqlite"); symlinkSync(filename, link);
    assert.throws(() => createSqliteTraceStore({ filename: link }), { code: "TraceStoragePathInvalid" });
    chmodSync(filename, 0o644);
    assert.throws(() => createSqliteTraceStore({ filename }), { code: "TraceStoragePathInvalid" });
    chmodSync(root, 0o777);
    assert.throws(() => createSqliteTraceStore({ filename: join(root, "unsafe.sqlite") }), { code: "TraceStoragePathInvalid" });
    chmodSync(root, 0o700);
  }
});

test("a foreign database is refused without changing its contents or journal mode", t => {
  const { root } = fixture(t);
  const filename = join(root, "business.sqlite");
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER); INSERT INTO orders VALUES(1, 125);");
  db.close();
  if (process.platform !== "win32") chmodSync(filename, 0o600);
  const before = readFileSync(filename);
  assert.throws(() => createSqliteTraceStore({ filename }), { code: "TraceStorageFormatInvalid" });
  assert.deepEqual(readFileSync(filename), before);
  const check = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(check.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(check.prepare("SELECT amount FROM orders WHERE id=1").get().amount, 125);
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'touba_%'").get().n, 0);
  } finally { check.close(); }
});

test("reopening never recreates missing accounting or schema over existing traces", t => {
  const { filename, store } = fixture(t);
  builder(store).push("run_started"); store.close();
  const db = new DatabaseSync(filename); t.after(() => db.close());
  db.exec("DELETE FROM touba_trace_storage");
  assert.throws(() => createSqliteTraceStore({ filename }), { code: "TraceStorageCorrupt" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM touba_trace_storage").get().n, 0);
  db.exec("DROP TABLE touba_trace_storage");
  assert.throws(() => createSqliteTraceStore({ filename }), { code: "TraceStorageCorrupt" });
});

test("committed events survive an actual process kill", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const { filename, store } = fixture(t); store.close();
  const module = new URL("../src/sqlite-trace-store.mjs", import.meta.url).href;
  const source = `import {createSqliteTraceStore} from ${JSON.stringify(module)};
    const s=createSqliteTraceStore({filename:${JSON.stringify(filename)}});
    const id=s.openSegment({run:{run_id:'crash'}});
    s.append(id,{event_id:'event:crash:1',run_id:'crash',sequence_index:0,kind:'run_started'});
    process.stdout.write(id+'\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let errors = ""; child.stderr.on("data", data => { errors += data; });
  const id = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", data => resolve(data.toString().trim()));
    child.once("exit", () => reject(new Error(errors)));
  });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const reopened = createSqliteTraceStore({ filename }); t.after(() => reopened.close());
  assert.equal(reopened.page(id).events.length, 1);
  assert.equal([...reopened.segments()][0].complete, false);
});

test("a trace larger than the child heap is validated and exported with bounded reads", { timeout: 120000 }, async t => {
  const { filename, store } = fixture(t); store.close();
  const storeModule = new URL("../src/sqlite-trace-store.mjs", import.meta.url).href;
  const builderModule = new URL("../src/trace-builder.mjs", import.meta.url).href;
  const contractsModule = new URL("../../../contracts/machine/contracts.mjs", import.meta.url).href;
  const source = `import {createSqliteTraceStore} from ${JSON.stringify(storeModule)};
    import {TraceBuilder} from ${JSON.stringify(builderModule)};
    import {validateTraceMachineStream} from ${JSON.stringify(contractsModule)};
    import {createHash} from 'node:crypto';
    const s=createSqliteTraceStore({filename:${JSON.stringify(filename)},maxDocumentBytes:1});
    const air=${JSON.stringify(air)};
    air.execution_graphs.push({id:'pure',owner_ref:'function:storage/Pure'});
    const b=new TraceBuilder(air,'skill:storage/Run','large',null,0,'full',s);
    const started=performance.now();
    b.push('run_started');
    for(let i=0;i<10000;i++) b.push('binding_created', {airRef:{flow_graph_ref:'pure'},payload:{text:'x'.repeat(8192),index:i}});
    b.push('run_completed',{payload:{status:'success',reason:'completed'}});
    const r=b.snapshot(); validateTraceMachineStream(r.header,r.events());
    let bytes=0; const digest=createHash('sha256');
    for(const chunk of r.json()) {bytes+=Buffer.byteLength(chunk); digest.update(chunk);}
    if(digest.digest('hex')!==b.digest()) throw Error('streamed digest mismatch');
    global.gc();
    process.stdout.write(JSON.stringify({bytes,events:r.eventCount,heap:process.memoryUsage().heapUsed,ms:Math.round(performance.now()-started)}));
    s.close();`;
  const child = spawn(process.execPath, ["--max-old-space-size=48", "--expose-gc", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  const metrics = JSON.parse(stdout);
  assert.equal(metrics.events, 10002);
  assert.ok(metrics.bytes > 80 * 1024 * 1024);
  assert.ok(metrics.heap < 48 * 1024 * 1024);
  t.diagnostic(JSON.stringify(metrics));
});
