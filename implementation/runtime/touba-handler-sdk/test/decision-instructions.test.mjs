import { structuredModelObject } from "./model-output.fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createAiSdkDecisionProvider } from "../src/index.mjs";

function request(mode = "summary") {
  return {
    protocol: "touba-agent-decision-v1", mode, agent_ref: "agent:operations/Assistant",
    capability_refs: ["tool:operations/Read"],
    capabilities: [{ target_ref: "tool:operations/Read", signature: { inputs: [] } }],
    model_input: {
      protocol: "touba-agent-model-input-v1", mode,
      agent: { responsibility: "Handle support requests." },
      allowed_actions: mode === "summary" ? ["answer_directly", "request_capabilities"] : ["select_capability", "request_human_review"],
      human_interaction: { review_available: true, available_actions: ["request_human_review"] },
      decision_policy: { request_capabilities_when_human_review_is_needed: true, request_capabilities_if_authorized_work_is_needed: true },
      output_contract: { action: { enum: ["select_capability", "request_human_review"] }, human_review: { type: "Object" } },
    },
  };
}

test("business instructions supplement the SDK protocol and resolve per request", async () => {
  let captured;
  const provider = createAiSdkDecisionProvider({ history: false,
    model: "test/model", instructions: (input) => `Support service, mode ${input.mode}.`,
    generateObject: async (options) => {
      captured = options;
      return { finishReason: "stop", response: { body: { object: "response", status: "completed" } }, object: structuredModelObject({ action: "answer_directly", result: "Hello." }) };
    },
  });
  await provider(request());
  assert.match(captured.system, /declared responsibility boundary/);
  assert.match(captured.system, /observation.*actually satisfies the user's goal/);
  assert.match(captured.system, /Support service, mode summary\./);
});

test("explicit system override remains explicit and instructions reject non-text", async () => {
  let captured;
  const provider = createAiSdkDecisionProvider({ history: false,
    model: "test/model", system: "Custom protocol", instructions: "Application guidance",
    generateObject: async (options) => { captured = options; return { finishReason: "stop", response: { body: { object: "response", status: "completed" } }, object: structuredModelObject({ action: "answer_directly", result: "ok" }) }; },
  });
  await provider(request());
  assert.ok(captured.system.startsWith("Custom protocol\n\nApplication guidance\n\nRuntime context: "));
  const invalid = createAiSdkDecisionProvider({ history: false, model: "test/model", instructions: () => ({ invalid: true }), generateObject: () => assert.fail("must reject before model") });
  await assert.rejects(() => invalid(request()), /instructions must resolve to a string/);
});

test("disabled review is absent from the model action space without mutating runtime input", async () => {
  const input = request();
  const original = structuredClone(input);
  let prompt;
  const provider = createAiSdkDecisionProvider({ history: false,
    model: "test/model", allowHumanReview: false,
    generateObject: async (options) => { prompt = JSON.parse(options.system.split("\n\nRuntime context: ").at(-1)); return { finishReason: "stop", response: { body: { object: "response", status: "completed" } }, object: structuredModelObject({ action: "answer_directly", result: "ok" }) }; },
  });
  await provider(input);
  assert.deepEqual(input, original);
  assert.equal(prompt.human_interaction.review_available, false);
  assert.deepEqual(prompt.human_interaction.available_actions, []);
  assert.deepEqual(prompt.output_contract.action.enum, ["select_capability"]);
  assert.equal(prompt.output_contract.human_review, undefined);
  assert.equal(prompt.decision_policy.request_capabilities_when_human_review_is_needed, undefined);
  assert.equal(prompt.decision_policy.request_capabilities_if_authorized_work_is_needed, true);
});
