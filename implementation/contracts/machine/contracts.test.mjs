import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AIR_CAPABILITY_PROFILE, AIR_JSON_PROFILE, AIR_SCHEMA_VERSION, MachineContractError,
  TRACE_CAPABILITY_PROFILE, TRACE_PROTOCOL_VERSION, canonicalizeMachineValue,
  validateAirMachineContract, validateTraceMachineContract,
} from "./contracts.mjs";

test("validates current AIR and trace contracts", () => {
  const air = validAir();
  assert.equal(validateAirMachineContract(air), air);
  const trace = validTrace();
  assert.equal(validateTraceMachineContract(trace), trace);
});

function functionAir() {
  const air = validAir();
  const graph = air.execution_graphs[0];
  graph.owner_ref = "function:contract/Run";
  air.definitions.skills = [];
  air.definitions.functions = [{ id: graph.owner_ref, body_graph_ref: graph.id }];
  return air;
}

test("function purity admits pure graphs and rejects every effectful node kind", () => {
  assert.ok(validateAirMachineContract(functionAir()));
  for (const kind of ["call_tool", "call_skill", "call_agent", "human_approval", "user_interaction", "fallback"]) {
    const air = functionAir();
    // An unreachable effect is also forbidden.
    air.execution_graphs[0].nodes.push({ id: "unreachable", kind });
    assert.throws(() => validateAirMachineContract(air), { code: "AirFunctionNotPure" });
  }
});

test("function graph ownership and call targets cannot launder effects", () => {
  for (const mutate of [
    air => { air.definitions.functions[0].body_graph_ref = "absent"; },
    air => { air.execution_graphs[0].owner_ref = "skill:contract/Run"; },
    air => { air.definitions.functions = []; },
    air => { air.execution_graphs[0].nodes[0].kind = "call_function";
      air.execution_graphs[0].nodes[0].target_ref = "tool:contract/Write"; },
  ]) {
    const air = functionAir();
    mutate(air);
    assert.throws(() => validateAirMachineContract(air), MachineContractError);
  }
  const recursive = functionAir();
  recursive.execution_graphs[0].nodes[0].kind = "call_function";
  recursive.execution_graphs[0].nodes[0].target_ref = recursive.definitions.functions[0].id;
  assert.ok(validateAirMachineContract(recursive)); // Purity does not promise termination.
});

test("validates a contiguous resumed trace segment with opaque unique event identities", () => {
  const trace = validTrace();
  trace.events[0].sequence_index = 9;
  trace.events[0].event_id = "event:run-1:10";
  trace.events[1].sequence_index = 10;
  trace.events[1].event_id = "event:run-1:11";
  assert.equal(validateTraceMachineContract(trace), trace);

  trace.events[1].event_id = "opaque-resumed-event";
  assert.equal(validateTraceMachineContract(trace), trace);

  trace.events[1].event_id = trace.events[0].event_id;
  assert.throws(() => validateTraceMachineContract(trace), MachineContractError);
});

test("refuses unknown versions, profiles, extensions and enums", () => {
  for (const mutate of [
    (air) => { air.air_schema_version = "touba-air-v2"; },
    (air) => { air.air_capability_profile = "unknown"; },
    (air) => { air.extension = {}; },
    (air) => { air.definitions.experimental_handlers = []; },
    (air) => { air.execution_graphs[0].nodes[0].kind = "eval_host"; },
    (air) => { air.execution_graphs[0].edges[0].to_node_id = "missing"; },
  ]) {
    const air = validAir();
    mutate(air);
    assert.throws(() => validateAirMachineContract(air), MachineContractError);
  }
});

test("refuses invalid trace correlation, terminal state and sensitive fields", () => {
  for (const mutate of [
    (trace) => { trace.trace_protocol_version = "trace-minimal-v0.1"; },
    (trace) => { trace.unknown_extension = true; },
    (trace) => { trace.run.unknown_extension = true; },
    (trace) => { trace.events[0].unknown_extension = true; },
    (trace) => { trace.events[1].sequence_index = 9; },
    (trace) => { trace.events[1].kind = "unknown_event"; },
    (trace) => { trace.events[0].payload.secret_value = "forbidden"; },
    (trace) => { trace.events[1].payload.status = "maybe"; },
  ]) {
    const trace = validTrace();
    mutate(trace);
    assert.throws(() => validateTraceMachineContract(trace), MachineContractError);
  }
});

test("canonicalization sorts object keys, preserves arrays and refuses non-finite numbers", () => {
  assert.equal(
    canonicalizeMachineValue({ z: 1, a: { y: 2, b: [3, { d: 4, c: 5 }] } }),
    '{"a":{"b":[3,{"c":5,"d":4}],"y":2},"z":1}',
  );
  assert.throws(() => canonicalizeMachineValue({ value: Number.NaN }), MachineContractError);
});

test("keeps schemas and Rust producer constants aligned with the canonical module", () => {
  const airSchema = JSON.parse(readFileSync(new URL("./schemas/touba-air-v1.schema.json", import.meta.url)));
  const traceSchema = JSON.parse(readFileSync(new URL("./schemas/touba-trace-v1.schema.json", import.meta.url)));
  assert.equal(airSchema.properties.air_schema_version.const, AIR_SCHEMA_VERSION);
  assert.equal(airSchema.properties.air_capability_profile.const, AIR_CAPABILITY_PROFILE);
  assert.equal(airSchema.properties.air_json_profile.const, AIR_JSON_PROFILE);
  assert.equal(traceSchema.properties.trace_protocol_version.const, TRACE_PROTOCOL_VERSION);
  assert.equal(traceSchema.properties.trace_capability_profile.const, TRACE_CAPABILITY_PROFILE);
  const rust = readFileSync(new URL("../../compiler/touba-compiler/src/air.rs", import.meta.url), "utf8");
  for (const value of [AIR_SCHEMA_VERSION, AIR_CAPABILITY_PROFILE, AIR_JSON_PROFILE]) {
    assert.ok(rust.includes(`\"${value}\"`), `${value} must be shared with Rust producer`);
  }
});

test("validates generated AIR and trace fixtures through the shared contract", () => {
  const airDir = fileURLToPath(new URL("../../tests/air/", import.meta.url));
  const traceDir = fileURLToPath(new URL("../../tests/traces/", import.meta.url));
  const airFiles = jsonFixtures(airDir);
  const traceFiles = jsonFixtures(traceDir);
  assert.ok(airFiles.length > 0, "AIR fixture corpus must not be empty");
  for (const family of ["anneau-1", "agent-authority-anneau-2", "triggers-anneau-2", "cancel-v1", "budgets-bq1"]) {
    assert.ok(traceFiles.some((file) => relative(traceDir, file).split(/[\\/]/u)[0] === family),
      `trace fixture family ${family} must be covered`);
  }
  for (const [files, validate] of [[airFiles, validateAirMachineContract], [traceFiles, validateTraceMachineContract]]) {
    for (const file of files) {
      assert.doesNotThrow(() => validate(JSON.parse(readFileSync(file, "utf8"))), file);
    }
  }
});

function jsonFixtures(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? jsonFixtures(file) : entry.name.endsWith(".json") ? [file] : [];
  }).sort();
}

function validAir() {
  const source_ref = { source_id: "contract.tb", start_byte: 0, end_byte: 1,
    start_line: 0, start_column: 0, end_line: 0, end_column: 1 };
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: { id: "module:contract", name: "contract", source_ref },
    definitions: { types: [], constants: [], functions: [], tools: [], memories: [],
      skills: [{ id: "skill:contract/Run", name: "Run", source_ref }],
      agents: [], strategies: [], triggers: [] },
    execution_graphs: [{ id: "graph:skill:contract/Run", owner_ref: "skill:contract/Run",
      entry_node_id: "n1", nodes: [{ id: "n1", kind: "give",
        arguments: ["literal:string:ok"], source_ref }],
      edges: [{ from_node_id: "n1", to_node_id: "n1", role: "next", source_ref }],
      expressions: [], failure_paths: [], source_ref }],
    trace_points: [],
  };
}

function validTrace() {
  return {
    trace_protocol_version: TRACE_PROTOCOL_VERSION,
    trace_capability_profile: TRACE_CAPABILITY_PROFILE,
    run: { run_id: "run-1", air_schema_version: AIR_SCHEMA_VERSION,
      module_ref: "module:contract", entry_ref: "skill:contract/Run" },
    events: [
      { event_id: "event:run-1:1", run_id: "run-1", sequence_index: 0,
        kind: "run_started", payload: { max_loop_iterations: 100 } },
      { event_id: "event:run-1:2", run_id: "run-1", sequence_index: 1,
        kind: "run_completed", payload: { status: "success" } },
    ],
  };
}
