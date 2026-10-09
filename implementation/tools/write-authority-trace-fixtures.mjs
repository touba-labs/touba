import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  AIR_SCHEMA_VERSION, AIR_CAPABILITY_PROFILE, AIR_JSON_PROFILE,
  validateTraceMachineContract,
} from "../contracts/machine/contracts.mjs";
import { executeAirDocument } from "../runtime/touba-runtime/src/index.mjs";

const outputDir = fileURLToPath(new URL("../tests/traces/agent-authority-anneau-2/", import.meta.url));
const checkOnly = process.argv.includes("--check");
if (!checkOnly) mkdirSync(outputDir, { recursive: true });

// Replays the runtime scenarios "executes a strategy through an agent
// responsibility" and "refuses unauthorized agent invocation before entering
// the target agent". Only the explicit callable_by caller changes.
for (const authorized of [true, false]) {
  const id = `agent-invocation-${authorized ? "authorized" : "refused"}`;
  const result = await executeAirDocument(authorityDocument(authorized), {
    entryRef: "strategy:test/RunBuild",
  });
  validateTraceMachineContract(result.trace);
  assert.equal(result.status, authorized ? "success" : "failure", id);
  const authorityEvents = result.trace.events.filter((event) => event.kind.startsWith("agent_invocation_"));
  assert.equal(authorityEvents.length, 1, `${id}: exactly one authority decision`);
  assert.equal(authorityEvents[0].kind, authorized ? "agent_invocation_authorized" : "agent_invocation_refused", id);
  assert.equal(authorityEvents[0].payload.caller_ref, "strategy:test/RunBuild", id);
  assert.equal(authorityEvents[0].payload.agent_ref, "agent:test/Builder", id);
  assert.equal(result.trace.events.some((event) => event.air_ref?.owner_ref === "skill:test/Build"), authorized,
    `${id}: forbidden agent capability is never entered`);
  if (authorized) {
    assert.equal(result.result, "complete", id);
    assert.equal(authorityEvents[0].payload.authority_source, "callable_by", id);
  } else {
    assert.equal(authorityEvents[0].payload.reason, "caller_not_allowed", id);
    const failure = result.trace.events.find((event) => event.kind === "failure_detected");
    assert.equal(failure?.payload.runtime_error_code, "UnauthorizedAgentInvocation", id);
    assert.equal(failure?.payload.failure_family, "authority", id);
  }
  const outputPath = join(outputDir, `${id}.trace.json`);
  const serialized = `${JSON.stringify(result.trace, null, 2)}\n`;
  if (checkOnly) {
    assert.equal(readFileSync(outputPath, "utf8"), serialized, `${id}: authority trace fixture is stale`);
    console.log(`pass [${id}] authority trace fixture current`);
  } else {
    writeFileSync(outputPath, serialized, "utf8");
    console.log(`wrote ${outputPath}`);
  }
}

function authorityDocument(authorized) {
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: { id: "module:test", name: "test", source_ref: sourceRef() },
    definitions: {
      types: [], constants: [], functions: [], tools: [], memories: [], triggers: [],
      skills: [{
        id: "skill:test/Build", name: "Build", description: "Build test skill capability.",
        signature: { inputs: [], output_type: "builtin:Text" }, uses: [],
        flow_graph_ref: "graph:skill:test/Build", source_ref: sourceRef(),
      }],
      agents: [{
        id: "agent:test/Builder", name: "Builder", responsibility: "Builder",
        uses: ["skill:test/Build"],
        callable_by: [{ caller_ref: authorized ? "strategy:test/RunBuild" : "strategy:test/AdminRun",
          caller_kind: "strategy", source_ref: sourceRef() }],
        source_ref: sourceRef(),
      }],
      strategies: [{
        id: "strategy:test/RunBuild", name: "RunBuild", uses: ["agent:test/Builder"],
        flow_graph_ref: "graph:strategy:test/RunBuild", source_ref: sourceRef(),
      }],
    },
    execution_graphs: [
      graph("graph:skill:test/Build", "skill:test/Build", [
        node("b1", "give", { arguments: ["literal:string:built"] }),
      ]),
      graph("graph:strategy:test/RunBuild", "strategy:test/RunBuild", [
        node("s1", "call_agent", { target_ref: "agent:test/Builder" }),
        node("s2", "give", { arguments: ["literal:string:complete"] }),
      ], [{ from_node_id: "s1", to_node_id: "s2", role: "next" }]),
    ],
    trace_points: [],
  };
}

function sourceRef() {
  return { source_id: "test.tb", start_byte: 0, end_byte: 0,
    start_line: 1, start_column: 0, end_line: 1, end_column: 0 };
}

function graph(id, ownerRef, nodes, edges = []) {
  return { id, owner_ref: ownerRef, entry_node_id: nodes[0].id, nodes, edges,
    expressions: [], failure_paths: [], failure_path_refs: [], source_ref: sourceRef() };
}

function node(id, kind, fields = {}) {
  return { id, kind, arguments: [], trace_point_refs: [], source_ref: sourceRef(), ...fields };
}
