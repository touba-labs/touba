// Executed only inside the bounded, networkless container in validate.test.mjs.
import assert from "node:assert/strict";
import { closeSync, fsyncSync, mkdirSync, openSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { indexedStore } from "../../runtime/touba-runtime/src/sqlite-record-store.mjs";
import { createSqliteTraceStore } from "../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { executeAirDocument } from "../../runtime/touba-runtime/src/index.mjs";

const root = "/state/qualification";
mkdirSync(root, { mode: 0o700 });
const filler = `${root}/filler`;
function fill() {
  const capacity = statfsSync(root);
  assert.ok(capacity.blocks * capacity.bsize <= 32 * 1024 * 1024, "only a bounded test filesystem may be filled");
  const fd = openSync(filler, "wx", 0o600);
  let written = 0, failure;
  try {
    for (const size of [1024 * 1024, 4096]) {
      const bytes = Buffer.alloc(size, 0x74);
      for (;;) {
        try { written += writeSync(fd, bytes); }
        catch (error) { assert.equal(error.code, "ENOSPC"); failure = error.code; break; }
        assert.ok(written <= 32 * 1024 * 1024);
      }
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  assert.equal(failure, "ENOSPC");
  assert.equal(statfsSync(root).bavail, 0);
  return written;
}
function integrity(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); }
  finally { db.close(); }
}
function storageFailure(error) {
  return /full|disk|space|I\/O/i.test(error.message) || error.code === "ENOSPC";
}

const recordPath = `${root}/records.sqlite`;
const records = indexedStore({ path: recordPath, schemaVersion: "qa-records-v1", keyOf: r => r.id,
  validate: r => assert.equal(typeof r.value, "string") });
const initial = records.read(); initial.push({ id: "one", value: "retained" }); records.write(initial);
const changed = records.read(); changed[0].value = "replacement";
const filledBytes = fill();
assert.throws(() => records.write(changed), storageFailure);
unlinkSync(filler);
integrity(recordPath);
assert.equal(records.read()[0].value, "retained");
records.write(changed);
assert.equal(records.read()[0].value, "replacement");

const tracePath = `${root}/traces.sqlite`;
let traces = createSqliteTraceStore({ filename: tracePath });
const original = traces.openSegment({ run: { run_id: "retained" } });
traces.append(original, { event_id: "event:retained:1", run_id: "retained", sequence_index: 0,
  kind: "run_completed", payload: { status: "success" } });
const air = {
  air_schema_version: "touba-air-v1", air_capability_profile: "touba-air-capabilities-v1",
  air_json_profile: "touba-air-json-canonical-v1", module: { id: "module:disk", name: "disk" },
  definitions: { types: [], constants: [], functions: [], memories: [], agents: [], strategies: [], triggers: [],
    tools: [{ id: "tool:disk/Write", name: "Write", signature: { inputs: [], output_type: "builtin:Text" }, required_secrets: [], memory_accesses: [] }],
    skills: [{ id: "skill:disk/Run", name: "Run", flow_graph_ref: "graph:disk", uses: ["tool:disk/Write"], signature: { inputs: [], output_type: "builtin:Text" } }] },
  execution_graphs: [{ id: "graph:disk", owner_ref: "skill:disk/Run", entry_node_id: "call",
    nodes: [{ id: "call", kind: "call_tool", target_ref: "tool:disk/Write" }, { id: "done", kind: "give", arguments: ["literal:string:ok"] }],
    edges: [{ from_node_id: "call", to_node_id: "done", role: "next" }], expressions: [], failure_paths: [] }], trace_points: [],
};
let calls = 0, saturated = false;
await assert.rejects(executeAirDocument(air, { traceStorage: { ...traces,
  append(id, event) {
    if (event.kind === "call_started" && !saturated) { fill(); saturated = true; }
    return traces.append(id, event);
  },
}, toolHandlers: { "tool:disk/Write": () => { calls++; return "ok"; } } }), storageFailure);
assert.equal(saturated, true);
assert.equal(calls, 0, "no external effect without its durable pre-dispatch trace");
unlinkSync(filler);
traces.close(); integrity(tracePath);
traces = createSqliteTraceStore({ filename: tracePath });
assert.equal(traces.page(original).eventCount, 1);
const interrupted = [...traces.segments()].filter(segment => segment.id !== original);
assert.equal(interrupted.length, 1);
assert.equal(interrupted[0].complete, false);
assert.ok([...traces.events(interrupted[0].id)].every(event => event.kind !== "call_started"));
const resumed = await executeAirDocument(air, { traceStorage: traces,
  toolHandlers: { "tool:disk/Write": () => { calls++; return "ok"; } } });
assert.equal(resumed.status, "success"); assert.equal(calls, 1);
traces.close(); integrity(tracePath);
console.log(JSON.stringify({ node: process.version, platform: process.platform, filesystem: "bounded tmpfs", filledBytes,
  recordsRollback: true, traceIntegrity: true, refusedEffects: 1, recoveredEffects: calls }));
