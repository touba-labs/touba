import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeAirDocument } from "../../runtime/touba-runtime/src/index.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const corpusRoot = path.join(implementationRoot, "grammar/tree-sitter-touba/examples/failure-flow-v1");

const positive = compile("positive/tb-failure-v1-p01-handler.tb");
assert.equal(positive.status, 0, positive.stderr);
const air = JSON.parse(positive.stdout);
assert.equal(air.execution_graphs.find((graph) => (graph.failure_paths?.length ?? 0) > 0)
  .failure_paths[0].failure_family, "handler");

for (const name of [
  "tb-failure-v1-n01-missing-family.tb",
  "tb-failure-v1-n02-unknown-family.tb",
  "tb-failure-v1-n03-nested-control.tb",
]) {
  const result = compile(`negative/syntax/${name}`);
  assert.notEqual(result.status, 0, `${name} must fail`);
}
const invariant = compile("negative/semantic/tb-failure-v1-n04-invariant-while.tb");
assert.notEqual(invariant.status, 0);
assert.match(`${invariant.stdout}\n${invariant.stderr}`, /InvariantLoopCondition/);

const handlerDocument = runtimeDocument("handler");
const recovered = await executeAirDocument(handlerDocument, { entryRef: "skill:test/Run" });
assert.equal(recovered.status, "success");
assert.equal(recovered.result, "fallback");
assert.equal(eventOf(recovered.trace, "failure_detected").payload.failure_family, "handler");

const notCaptured = await executeAirDocument(runtimeDocument("authority"), {
  entryRef: "skill:test/Run",
});
assert.equal(notCaptured.status, "failure");
assert.equal(notCaptured.trace.events.some((event) => event.kind === "fallback_selected"), false);

const bounded = await executeAirDocument(loopDocument(), {
  entryRef: "skill:test/Loop",
  maxLoopIterations: 2,
});
assert.equal(bounded.status, "failure");
assert.equal(eventOf(bounded.trace, "run_started").payload.max_loop_iterations, 2);
assert.equal(eventOf(bounded.trace, "failure_detected").payload.runtime_error_code,
  "LoopIterationLimitExceeded");

console.log("failure-flow-v1: status=success families=6 catchable=4 negatives=5");

function compile(relativePath) {
  return spawnSync(process.env.CARGO ?? "cargo", [
    "run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--",
    path.relative(implementationRoot, path.join(corpusRoot, relativePath)),
  ], { cwd: implementationRoot, encoding: "utf8" });
}

function runtimeDocument(failureFamily) {
  const sourceRef = { source_id: "failure-flow", start_byte: 0, end_byte: 1,
    start_line: 0, start_column: 0, end_line: 0, end_column: 1 };
  return {
    air_schema_version: "touba-air-v1", air_capability_profile: "touba-air-capabilities-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: { id: "module:test", name: "test", source_ref: sourceRef },
    imports: [], budgets: {},
    definitions: {
      types: [], constants: [], functions: [], memories: [], agents: [], strategies: [], triggers: [],
      tools: [{ id: "tool:test/Primary", name: "Primary", signature: { inputs: [], output_type: "builtin:Text" },
        required_capabilities: [], required_secrets: [], memory_accesses: [], source_ref: sourceRef }],
      skills: [
        { id: "skill:test/Run", name: "Run", signature: { inputs: [], output_type: "builtin:Text" },
          uses: ["tool:test/Primary", "skill:test/Backup"], flow_graph_ref: "graph:skill:test/Run",
          failure_path_refs: ["failure:1"], memory_scopes: [], source_ref: sourceRef },
        { id: "skill:test/Backup", name: "Backup", signature: { inputs: [], output_type: "builtin:Text" },
          uses: [], flow_graph_ref: "graph:skill:test/Backup", failure_path_refs: [], memory_scopes: [], source_ref: sourceRef },
      ],
    },
    execution_graphs: [
      { id: "graph:skill:test/Run", owner_ref: "skill:test/Run", entry_node_id: "n1", expressions: [],
        nodes: [node("n1", "call_tool", sourceRef, { target_ref: "tool:test/Primary" }),
          node("n2", "fallback", sourceRef, { target_ref: "skill:test/Backup" })],
        edges: [{ from_node_id: "n1", to_node_id: "n2", role: "failure", source_ref: sourceRef },
          { from_node_id: "n1", to_node_id: "n2", role: "fallback", source_ref: sourceRef }],
        failure_paths: [{ id: "failure:1", scope_ref: "graph:skill:test/Run", trigger_node_id: "n1",
          mode: "fallback", failure_family: failureFamily, target_node_id: "n2", source_ref: sourceRef }],
        failure_path_refs: ["failure:1"], source_ref: sourceRef },
      { id: "graph:skill:test/Backup", owner_ref: "skill:test/Backup", entry_node_id: "b1",
        expressions: [], nodes: [node("b1", "give", sourceRef, { arguments: ["literal:string:fallback"] })],
        edges: [], failure_paths: [], failure_path_refs: [], source_ref: sourceRef },
    ], trace_points: [],
  };
}

function loopDocument() {
  const document = runtimeDocument("handler");
  const sourceRef = document.module.source_ref;
  document.definitions.skills = [{ id: "skill:test/Loop", name: "Loop",
    signature: { inputs: [], output_type: "builtin:Text" }, uses: [],
    flow_graph_ref: "graph:skill:test/Loop", failure_path_refs: [], memory_scopes: [], source_ref: sourceRef }];
  document.definitions.tools = [];
  document.execution_graphs = [{ id: "graph:skill:test/Loop", owner_ref: "skill:test/Loop",
    entry_node_id: "l1", expressions: [], nodes: [node("l1", "loop", sourceRef,
      { condition_ref: "literal:bool:true" })], edges: [
      { from_node_id: "l1", to_node_id: "l1", role: "loop_next", source_ref: sourceRef },
    ], failure_paths: [], failure_path_refs: [], source_ref: sourceRef }];
  return document;
}

function node(id, kind, sourceRef, extra = {}) {
  return { id, kind, context_refs: [], arguments: [], trace_point_refs: [], source_ref: sourceRef, ...extra };
}

function eventOf(trace, kind) {
  return trace.events.find((event) => event.kind === kind);
}
