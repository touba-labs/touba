import test from "node:test";
import assert from "node:assert/strict";
import { ToubaEngine, ToubaEngineError } from "../src/index.mjs";
import { createScriptedDecisionProvider, assertRunSucceeded, assertRunRefused, assertTraceEvents } from "../src/testing.mjs";

test("scripted proposals keep explicit order, repeated capabilities and agent boundaries", async () => {
  const decision = { action: "select_capability", target_ref: "tool:orders/Read", arguments: { key: "one" } };
  const steps = [
    { expect: { mode: "capabilities", agent_ref: "agent:orders/Reader", step_index: 0 }, decision },
    { expect: { mode: "capabilities", agent_ref: "agent:orders/Reader", step_index: 1 }, decision: request => ({ action: "select_capability", target_ref: "tool:orders/Read", arguments: { key: request.inputs.key } }) },
    { expect: { mode: "summary", agent_ref: "agent:orders/Reviewer" }, decision: { action: "answer_directly", result: "Reviewed" } },
  ];
  const provider = createScriptedDecisionProvider(steps);
  decision.target_ref = "tool:changed/AfterConstruction";
  assert.throws(() => provider.assertConsumed());
  await assert.rejects(provider({ mode: "summary", agent_ref: "agent:orders/Reader", step_index: 0 }));
  const first = await provider({ mode: "capabilities", agent_ref: "agent:orders/Reader", step_index: 0, inputs: { secret: "not-logged" } });
  assert.equal(first.target_ref, "tool:orders/Read");
  first.arguments.key = "mutated-copy";
  const second = await provider({ mode: "capabilities", agent_ref: "agent:orders/Reader", step_index: 1, inputs: { key: "two" } });
  assert.equal(second.arguments.key, "two");
  assert.equal(second.target_ref, first.target_ref);
  await provider({ mode: "summary", agent_ref: "agent:orders/Reviewer" });
  provider.assertConsumed();
  assert.equal(JSON.stringify(provider.calls).includes("not-logged"), false);
  const calls = provider.calls; calls[0].mode = "changed";
  assert.equal(provider.calls[0].mode, "capabilities");
  await assert.rejects(provider({ mode: "summary" }), /exhausted/);
});

test("test provider does not authorize or normalize a malicious proposal", async () => {
  const proposal = { action: "select_capability", target_ref: "tool:forbidden/Delete", arguments: {} };
  const provider = createScriptedDecisionProvider([{ expect: { mode: "capabilities" }, decision: proposal }]);
  assert.deepEqual(await provider({ mode: "capabilities", capability_refs: [] }), proposal);
  for (const steps of [[], null, [{}], [{ expect: { typo: true }, decision: {} }]]) assert.throws(() => createScriptedDecisionProvider(steps));
});

test("run assertions distinguish expected runtime refusal from launch, compile and wrong-code failures", async () => {
  const success = { status: "success", reason: "completed", result: { ticket: "T-1" } };
  assertRunSucceeded(success, { ticket: "T-1" });
  assert.throws(() => assertRunSucceeded({ ...success, status: "stopped" }, success.result));
  assert.throws(() => assertRunSucceeded(success, { ticket: "T-2" }));
  const error = new ToubaEngineError("run", "refused", { status: "failure", reason: "AgentCapabilityNotAllowed", trace: { events: [] } });
  const refused = await assertRunRefused(async () => { throw error; }, "AgentCapabilityNotAllowed");
  assert.equal(refused.reason, "AgentCapabilityNotAllowed");
  for (const wrong of [new Error("crashed"), new ToubaEngineError("compile", "bad source"), new ToubaEngineError("run", "not launched"), error]) {
    await assert.rejects(assertRunRefused(async () => { throw wrong; }, "ToolCapabilityNotGranted"));
  }
  await assert.rejects(assertRunRefused(async () => success, "AgentCapabilityNotAllowed"));
});

test("trace assertions check exact counts and explicit target filters", () => {
  const trace = { events: [{ kind: "call_started", air_ref: "tool:one/Read" }, { kind: "call_started", air_ref: "tool:two/Read" }] };
  assertTraceEvents(trace, { kind: "call_started", count: 1, where: event => event.air_ref === "tool:one/Read" });
  assertTraceEvents(trace, { kind: "tool_handler_failed", count: 0 });
  assert.throws(() => assertTraceEvents(trace, { kind: "call_started", count: 1 }));
  assert.throws(() => assertTraceEvents(trace, { kind: "call_started", count: 2, where: async () => true }));
});

test("Engine refuses invalid provider mode options before launching a process", async () => {
  const engine = new ToubaEngine({ command: "must-not-be-launched-for-invalid-options" });
  for (const key of ["agentDecisionProviderInitialMode", "agentDecisionProviderContentMode"]) {
    await assert.rejects(engine.run({ airJson: {}, [key]: "invalid" }),
      error => error instanceof ToubaEngineError && error.phase === "options" && error.message.includes(key));
  }
});
