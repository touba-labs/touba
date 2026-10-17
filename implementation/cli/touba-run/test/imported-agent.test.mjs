import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";

const sourceRoot = new URL("../../../grammar/tree-sitter-touba/examples/imports-im2/agent/typed/", import.meta.url);
const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
  fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--",
  "--source-root", fileURLToPath(sourceRoot), fileURLToPath(new URL("incident/coordinator.tb", sourceRoot))], { encoding: "utf8" }));
const specialist = "agent:incident.specialist/Diagnose";
const coordinator = "agent:incident.coordinator/Coordinator";
const input = { query: "Investigate the delayed settlement job." };

test("a provider cannot expand uses by mutating the capability catalog it receives", async () => {
  let specialistCalls = 0;
  const forbidden = "strategy:incident.coordinator/Resolve";
  const result = await executeAirDocument(air, {
    entryRef: "strategy:incident.coordinator/RunCoordinated", inputs: { request: structuredClone(input) },
    agentDecisionProvider(request) {
      if (request.agent_ref === specialist) {
        specialistCalls++;
        return { action: "answer_directly", result: { summary: "Unexpected execution", attempt: 1 } };
      }
      if (request.observations.length) return { action: "answer_directly", result: request.observations[0].value };
      request.capability_refs.push(forbidden);
      return { target_ref: forbidden, arguments: { request: input } };
    },
  });
  assert.equal(specialistCalls, 0);
  assert.equal(result.reason, "AgentCapabilityNotAllowed");
  assert.equal(JSON.stringify(result.trace).includes(input.query), false);
});

test("provider mutations cannot change another invocation or the host input", async () => {
  const hostInput = structuredClone(input);
  const seen = [];
  const result = await executeAirDocument(air, {
    entryRef: "strategy:incident.coordinator/Resolve", inputs: { request: hostInput },
    agentDecisionProvider(request) {
      seen.push(request.inputs.request.query);
      request.inputs.request.query = "Mutated provider-local copy";
      return { action: "answer_directly", result: { summary: "Reviewed", attempt: request.inputs.attempt } };
    },
  });
  assert.equal(result.status, "success");
  assert.deepEqual(seen, [input.query, input.query]);
  assert.deepEqual(hostInput, input);
});

test("compiled imported agent can be invoked twice with explicit typed inputs and distinct results", async () => {
  const calls = [];
  const result = await executeAirDocument(air, { entryRef: "strategy:incident.coordinator/Resolve", inputs: { request: input },
    agentDecisionProvider(request) {
      assert.equal(request.agent_ref, specialist);
      assert.deepEqual(request.inputs.request, input);
      calls.push(request.inputs.attempt);
      return { action: "answer_directly", result: { summary: "Explicit diagnosis", attempt: request.inputs.attempt } };
    } });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(result.result, { summary: "Explicit diagnosis", attempt: 2 });
  assert.equal(result.trace.events.filter(event => event.kind === "agent_interface_result_returned").length, 2);
  assert.equal(JSON.stringify(result.trace).includes(input.query), false);
});

test("provider retries receive the initial request, not the previous attempt's mutations", async () => {
  let attempt = 0;
  let firstRequest;
  const result = await executeAirDocument(air, {
    entryRef: "strategy:incident.coordinator/Resolve", inputs: { request: structuredClone(input) },
    agentDecisionProviderMaxRetries: 1,
    agentDecisionProvider(request) {
      attempt++;
      if (attempt === 1) {
        firstRequest = structuredClone(request);
        request.inputs.request.query = "Changed by failed adapter";
        request.agent_ref = coordinator;
        request.capability_refs.push("strategy:incident.coordinator/Resolve");
        throw new Error("Transient adapter failure");
      }
      if (attempt === 2) assert.deepEqual(request, firstRequest);
      return { action: "answer_directly", result: { summary: "Recovered", attempt: request.inputs.attempt } };
    },
  });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(attempt, 3);
  assert.equal(result.trace.events.filter(e => e.kind === "agent_decision_provider_call_attempted").length, 3);
});

test("changing the request mode cannot authorize a finalization-only response", async () => {
  const result = await executeAirDocument(air, {
    entryRef: "strategy:incident.coordinator/Resolve", inputs: { request: structuredClone(input) },
    agentDecisionProvider(request) {
      request.mode = "finalization";
      return { action: "cannot_complete", reason: "More evidence is needed." };
    },
  });
  assert.equal(result.reason, "AgentDecisionProviderSchemaViolation");
});

test("retained provider responses and observation copies cannot rewrite runtime evidence", async () => {
  const retained = [];
  const result = await executeAirDocument(air, {
    entryRef: "strategy:incident.coordinator/RunCoordinated", inputs: { request: structuredClone(input) },
    agentDecisionProviderInitialMode: "capabilities",
    agentDecisionProvider(request) {
      if (request.agent_ref === specialist) {
        const response = { action: "answer_directly", result: { summary: "Original evidence", attempt: request.inputs.attempt } };
        retained.push(response);
        return response;
      }
      if (request.step_index === 1) {
        request.observations[0].value.summary = "Changed request copy";
        retained[0].result.summary = "Changed retained response";
      }
      if (request.step_index === 2) {
        assert.equal(request.observations[0].value.summary, "Original evidence");
        return { action: "answer_directly", result: request.observations[0].value };
      }
      return { target_ref: specialist, arguments: { request: input, attempt: request.step_index + 1 } };
    },
  });
  assert.equal(result.status, "success", JSON.stringify(result));
  for (const response of retained) response.result.summary = "Mutation after run completion";
  assert.deepEqual(result.result, { summary: "Original evidence", attempt: 1 });
});

test("non-copyable provider output has a structural schema error with no payload leakage", async () => {
  const result = await executeAirDocument(air, {
    entryRef: "strategy:incident.coordinator/Resolve", inputs: { request: structuredClone(input) },
    agentDecisionProvider: () => ({ action: "answer_directly", result: { secretLabel: "private-marker", callback() {} } }),
  });
  assert.equal(result.reason, "AgentDecisionProviderSchemaViolation");
  assert.equal(JSON.stringify(result.trace).includes("private-marker"), false);
});

test("compiled supervisor selects an imported specialist twice without acquiring new authority", async () => {
  const calls = [];
  const result = await executeAirDocument(air, { entryRef: "strategy:incident.coordinator/RunCoordinated", inputs: { request: input },
    agentDecisionProvider(request) {
      if (request.agent_ref === specialist) {
        calls.push(request.inputs.attempt);
        return { action: "answer_directly", result: { summary: "Specialist evidence", attempt: request.inputs.attempt } };
      }
      assert.equal(request.agent_ref, coordinator);
      assert.deepEqual(request.inputs.request, input);
      if (request.step_index >= 2) return { action: "answer_directly", result: request.observations.at(-1).value };
      if (request.mode === "summary") return { action: "request_capabilities", reason: "Specialist assessment required." };
      assert.deepEqual(request.capabilities.filter(cap => cap.kind === "agent").map(cap => cap.target_ref), [specialist]);
      return { target_ref: specialist, arguments: { request: input, attempt: request.step_index + 1 }, reason: "Review the incident evidence." };
    } });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.result.attempt, 2);
  assert.deepEqual(result.trace.events.filter(event => event.kind === "agent_invocation_authorized")
    .filter(event => event.payload.agent_ref === specialist).map(event => event.payload.caller_ref), [coordinator, coordinator]);
});

test("imported agent results and runtime authority remain checked after source compilation", async () => {
  const badResult = await executeAirDocument(air, { entryRef: "strategy:incident.coordinator/Resolve", inputs: { request: input },
    agentDecisionProvider: () => ({ action: "answer_directly", result: { summary: "Invalid proposal", attempt: "two" } }) });
  assert.equal(badResult.status, "failure");
  assert.ok(badResult.trace.events.some(event => event.payload?.runtime_error_code === "AgentInterfaceResultTypeMismatch"));
  const altered = structuredClone(air);
  altered.definitions.agents.find(agent => agent.id === specialist).callable_by = [];
  let calls = 0;
  const refused = await executeAirDocument(altered, { entryRef: "strategy:incident.coordinator/Resolve", inputs: { request: input },
    agentDecisionProvider: () => { calls++; throw Error("Provider must not run"); } });
  assert.equal(refused.status, "failure");
  assert.equal(calls, 0);
  assert.ok(refused.trace.events.some(event => event.payload?.runtime_error_code === "UnauthorizedAgentInvocation"));
});

test("an imported capability without a source description is refused before provider selection", async () => {
  const altered = structuredClone(air);
  delete altered.definitions.agents.find(agent => agent.id === specialist).description;
  let calls = 0;
  const result = await executeAirDocument(altered, { entryRef: "strategy:incident.coordinator/RunCoordinated", inputs: { request: input },
    agentDecisionProvider: () => { calls++; throw Error("Provider must not run"); } });
  assert.equal(result.reason, "AgentCapabilityDescriptionRequired");
  assert.equal(calls, 0);
});
