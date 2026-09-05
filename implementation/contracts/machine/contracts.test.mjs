import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

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
  const airDir = new URL("../../tests/air/", import.meta.url);
  const traceDir = new URL("../../tests/traces/", import.meta.url);
  for (const name of readdirSync(airDir).filter((item) => item.endsWith(".json"))) {
    validateAirMachineContract(JSON.parse(readFileSync(new URL(name, airDir), "utf8")));
  }
  for (const name of readdirSync(traceDir).filter((item) => item.endsWith(".json"))) {
    validateTraceMachineContract(JSON.parse(readFileSync(new URL(name, traceDir), "utf8")));
  }
});

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
