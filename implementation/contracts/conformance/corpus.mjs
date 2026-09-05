import {
  AIR_CAPABILITY_PROFILE,
  AIR_JSON_PROFILE,
  AIR_SCHEMA_VERSION,
  TRACE_CAPABILITY_PROFILE,
  TRACE_PROTOCOL_VERSION,
} from "../machine/contracts.mjs";

export const CONFORMANCE_CORPUS_VERSION = "touba-machine-conformance-v1";

const sourceRef = () => ({
  source_id: "conformance.tb", start_byte: 0, end_byte: 1,
  start_line: 0, start_column: 0, end_line: 0, end_column: 1,
});

export function baseAir() {
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: { id: "module:conformance", name: "conformance", source_ref: sourceRef() },
    budgets: { run: {
      max_steps: { value: 8, source_ref: sourceRef() },
      max_tool_calls: { value: 1, source_ref: sourceRef() },
      max_agent_invocations: { value: 1, source_ref: sourceRef() },
      max_run_ms: { value: 1000, source_ref: sourceRef() },
    } },
    definitions: {
      types: [{ id: "type:conformance/Result", name: "Result", fields: [], source_ref: sourceRef() }],
      constants: [], functions: [], tools: [],
      memories: [{ id: "memory:conformance/Audit", name: "Audit", source_ref: sourceRef() }],
      skills: [{
        id: "skill:conformance/Run", name: "Run", description: "Pure conformance entry.",
        signature: { inputs: [], output_type: "builtin:Text" }, uses: [],
        flow_graph_ref: "graph:skill:conformance/Run", source_ref: sourceRef(),
      }],
      agents: [{
        id: "agent:conformance/Reviewer", name: "Reviewer",
        responsibility: "Review only capabilities explicitly granted by the source.",
        uses: [], callable_by: [{
          caller_ref: "strategy:conformance/Review", caller_kind: "strategy", source_ref: sourceRef(),
        }], source_ref: sourceRef(),
      }],
      strategies: [{
        id: "strategy:conformance/Review", name: "Review", uses: ["agent:conformance/Reviewer"],
        flow_graph_ref: "graph:strategy:conformance/Review", source_ref: sourceRef(),
      }],
      triggers: [{
        id: "trigger:conformance/Daily", name: "Daily",
        event: { kind: "schedule", value: "0 8 * * *", source_ref: sourceRef() },
        target_ref: "strategy:conformance/Review", target_kind: "strategy", arguments: [],
        limits: { max_runs_per_day: 1, timeout_ms: 1000, source_ref: sourceRef() },
        source_ref: sourceRef(),
      }],
    },
    execution_graphs: [
      {
        id: "graph:skill:conformance/Run", owner_ref: "skill:conformance/Run",
        entry_node_id: "give", nodes: [{
          id: "give", kind: "give", arguments: ["literal:string:conformant"],
          trace_point_refs: [], source_ref: sourceRef(),
        }], edges: [], expressions: [], failure_paths: [], failure_path_refs: [], source_ref: sourceRef(),
      },
      {
        id: "graph:strategy:conformance/Review", owner_ref: "strategy:conformance/Review",
        entry_node_id: "stop", nodes: [{
          id: "stop", kind: "stop", arguments: [], trace_point_refs: [], source_ref: sourceRef(),
        }], edges: [], expressions: [], failure_paths: [], failure_path_refs: [], source_ref: sourceRef(),
      },
    ],
    trace_points: [],
  };
}

export function baseTrace() {
  const runId = "run-conformance";
  return {
    trace_protocol_version: TRACE_PROTOCOL_VERSION,
    trace_capability_profile: TRACE_CAPABILITY_PROFILE,
    run: {
      run_id: runId, air_schema_version: AIR_SCHEMA_VERSION,
      module_ref: "module:conformance", entry_ref: "skill:conformance/Run",
    },
    events: [
      { event_id: `event:${runId}:1`, run_id: runId, sequence_index: 0, kind: "run_started", payload: {} },
      { event_id: `event:${runId}:2`, run_id: runId, sequence_index: 1, kind: "run_completed", payload: { status: "success" } },
    ],
  };
}

export function conformanceCases() {
  return [
    { id: "air-profile-complete", kind: "air", expectation: "accept", tags: ["parsing", "types", "authority", "agents", "budgets", "memories", "triggers"], value: baseAir() },
    { id: "trace-terminal-complete", kind: "trace", expectation: "accept", tags: ["errors", "terminal", "correlation"], value: baseTrace() },
    negativeAir("air-version-unknown", "MachineVersionUnsupported", (air) => { air.air_schema_version = "touba-air-v99"; }),
    negativeAir("air-extension-unknown", "MachineExtensionUnknown", (air) => { air.required_extension = "vendor:x"; }),
    negativeAir("air-definition-collection-unknown", "MachineExtensionUnknown", (air) => { air.definitions.handlers = []; }),
    negativeAir("air-graph-reference-missing", "AirReferenceUnresolved", (air) => { air.execution_graphs[0].entry_node_id = "missing"; }),
    negativeAir("air-node-kind-unknown", "MachineEnumUnknown", (air) => { air.execution_graphs[0].nodes[0].kind = "host_eval"; }),
    negativeTrace("trace-version-unknown", "MachineVersionUnsupported", (trace) => { trace.trace_protocol_version = "touba-trace-v99"; }),
    negativeTrace("trace-sequence-gap", "TraceSequenceInvalid", (trace) => { trace.events[1].sequence_index = 3; }),
    negativeTrace("trace-terminal-missing", "TraceTerminalInvalid", (trace) => { trace.events[1].kind = "scope_exited"; }),
    negativeTrace("trace-sensitive-field", "TraceSensitiveFieldForbidden", (trace) => { trace.events[0].payload.secret_value = "never-copy"; }),
  ];
}

function negativeAir(id, code, mutate) {
  const value = baseAir(); mutate(value);
  return { id, kind: "air", expectation: "reject", expected_code: code, refusal_phase: "contract_before_effect", tags: ["errors"], value };
}

function negativeTrace(id, code, mutate) {
  const value = baseTrace(); mutate(value);
  return { id, kind: "trace", expectation: "reject", expected_code: code, refusal_phase: "contract_before_publish", tags: ["errors", "terminal"], value };
}
