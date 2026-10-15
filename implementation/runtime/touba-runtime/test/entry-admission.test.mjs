import assert from "node:assert/strict";
import test from "node:test";
import { executeAirDocument } from "../src/index.mjs";
import { AIR_SCHEMA_VERSION, AIR_CAPABILITY_PROFILE, AIR_JSON_PROFILE, failureFamilyForRuntimeCode } from "../../../contracts/machine/contracts.mjs";

function document() {
  return {
    air_schema_version: AIR_SCHEMA_VERSION, air_capability_profile: AIR_CAPABILITY_PROFILE, air_json_profile: AIR_JSON_PROFILE,
    module: { id: "module:admission", name: "admission" }, trace_points: [],
    definitions: {
      types: [{ id: "type:admission/Request", name: "Request", fields: [
        { name: "title", type_ref: "builtin:Text" }, { name: "counts", type_ref: "list:builtin:Int" },
      ] }],
      tools: [{ id: "tool:admission/Write", name: "Write", signature: { inputs: [], output_type: "builtin:Text" } }],
      skills: [{ id: "skill:admission/Run", name: "Run", signature: {
        inputs: [{ name: "request", type_ref: "type:admission/Request" }], output_type: "builtin:Text" },
        uses: ["tool:admission/Write"], flow_graph_ref: "graph:run" }],
    },
    execution_graphs: [{ id: "graph:run", owner_ref: "skill:admission/Run", entry_node_id: "write", nodes: [
      { id: "write", kind: "call_tool", target_ref: "tool:admission/Write", arguments: [], trace_point_refs: [] },
    ], edges: [], expressions: [], failure_paths: [] }],
  };
}
const valid = { request: { title: "ordinary", counts: [1, 2] } };
function failureCode(result) { return result.trace.events.find(event => event.kind === "failure_detected")?.payload.runtime_error_code; }

test("entry admission checks required, extra, nested and numeric values before any effect", async () => {
  for (const inputs of [{}, { ...valid, hidden: true }, { request: null },
    { request: { title: "private-input", counts: ["1"] } },
    { request: { title: "private-input", counts: [Infinity] } },
    { request: { title: "private-input", counts: [Number.MAX_SAFE_INTEGER + 1] } },
    { request: { title: "private-input", counts: [], extra: true } },
    { request: { counts: [] } }]) {
    let writes = 0;
    const result = await executeAirDocument(document(), { inputs, toolHandlers: {
      "tool:admission/Write": () => { writes++; return "stored"; },
    } });
    assert.equal(failureCode(result), "EntryInputSchemaInvalid");
    assert.equal(writes, 0);
    assert.equal(result.trace.events.some(event => event.kind === "call_started"), false);
    assert.equal(JSON.stringify(result.trace).includes("private-input"), false);
  }
  const result = await executeAirDocument(document(), { inputs: valid,
    toolHandlers: { "tool:admission/Write": () => "stored" } });
  assert.equal(result.status, "success");
});

test("unknown or unresolved input types are refused rather than treated as untyped data", async () => {
  const air = document(); air.definitions.skills[0].signature.inputs[0].type_ref = "type:missing/Request";
  const result = await executeAirDocument(air, { inputs: valid, toolHandlers: {
    "tool:admission/Write": () => assert.fail("unresolved input must not dispatch"),
  } });
  assert.equal(failureCode(result), "EntryInputSchemaInvalid");
});

test("host responses must target known interactions or agents before effects", async () => {
  for (const [options, code] of [
    [{ humanApprovalDecisions: { "approval:missing": "approved" } }, "UnknownApprovalReference"],
    [{ userInputs: { "interaction:missing": "answer" } }, "UnknownInteractionReference"],
    [{ agentDecisions: { "agent:admission/Missing": "tool:admission/Write" } }, "UnknownAgentDecisionReference"],
  ]) {
    const result = await executeAirDocument(document(), { inputs: valid, ...options,
      toolHandlers: { "tool:admission/Write": () => assert.fail("unknown reference must not dispatch") } });
    assert.equal(failureCode(result), code);
  }
});

test("known future ask and approval responses remain accepted", async () => {
  const air = document();
  air.execution_graphs[0].nodes.push(
    { id: "ask", kind: "user_interaction", interaction_mode: "ask", interaction_ref: "interaction:future", arguments: ["literal:string:Question?"], trace_point_refs: [] },
    { id: "approve", kind: "human_approval", approval_mode: "required_approval", approval_ref: "approval:future", context_refs: [], trace_point_refs: [] });
  const result = await executeAirDocument(air, { inputs: valid,
    userInputs: { "interaction:future": "answer" }, humanApprovalDecisions: { "approval:future": "approved" },
    toolHandlers: { "tool:admission/Write": () => "stored" } });
  assert.equal(result.status, "success");
});

test("authority failures cannot be classified as business or provider failures", () => {
  for (const code of ["AgentCapabilityNotAllowed", "AgentProviderBudgetExceeded", "ToolHandlerSecretNotGranted", "ToolCapabilityNotGranted"]) {
    assert.equal(failureFamilyForRuntimeCode(code), "authority", code);
  }
  assert.equal(failureFamilyForRuntimeCode("AgentDecisionProviderUnavailable"), "provider");
  assert.equal(failureFamilyForRuntimeCode("ToolHandlerNonZeroExit"), "handler");
});

test("external resources explicitly required by the host cannot be missing or inactive", async () => {
  const air = document();
  air.definitions.memories = [{ id: "memory:admission/Records", name: "Records" }];
  const resources = { resource_bindings_schema_version: "touba-resource-bindings-v1",
    required_resources: ["memory:admission/Records"], resources: {} };
  const options = { inputs: valid, resourceBindings: resources,
    toolHandlers: { "tool:admission/Write": () => assert.fail("required resource must be present before any effect") } };
  assert.equal(failureCode(await executeAirDocument(air, options)), "ResourceBindingMissing");
  resources.resources["memory:admission/Records"] = { kind: "memory_backend", provider: "application.custom-backend", grants: [], secrets: [], active: false };
  await assert.rejects(executeAirDocument(air, options), { code: "ResourceBindingInactive" });
  resources.resources["memory:admission/Records"].active = true;
  const accepted = await executeAirDocument(air, { ...options, toolHandlers: { "tool:admission/Write": () => "stored" } });
  assert.equal(accepted.status, "success", "provider identifiers remain owned by the host adapter");
  const logical = await executeAirDocument(air, { inputs: valid, toolHandlers: { "tool:admission/Write": () => "stored" } });
  assert.equal(logical.status, "success", "logical memory alone does not require an external backend");
  resources.required_resources = ["memory:admission/Missing"];
  assert.equal(failureCode(await executeAirDocument(air, options)), "ResourceBindingUnknownResource");
});
