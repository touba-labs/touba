import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as sdk from "../src/index.mjs";
import {
  ToubaAgentDecisionProviderError, validateAgentDecisionRequest,
  modelInputForDecision, defaultDecisionSystemPrompt, decisionSchemaForRequest,
  argumentsSchemaForCapability, agentResultSchema, normalizeAiSdkDecisionObject,
} from "../src/decision-contract.mjs";

function request(mode = "capabilities") {
  const capability = {
    target_ref: "skill:service/Assess", kind: "skill", name: "Assess",
    signature: { inputs: [{ name: "records", type_ref: "list:type:service/Record", fields: [
      { name: "label", type_ref: "builtin:Text" }, { name: "quantity", type_ref: "builtin:Int" },
      { name: "enabled", type_ref: "builtin:Boolean" }, { name: "amount", type_ref: "builtin:Float" },
    ] }] },
    uses: ["tool:service/Inspect"], memory_accesses: [{ access: "read", scope: "current_run" }],
  };
  return {
    protocol: "touba-agent-decision-v1", mode, agent_ref: "agent:service/Worker",
    capability_refs: [capability.target_ref], capability_count: 1, capabilities: [capability],
    agent_signature: { output_type: "type:service/Result", output_fields: [{ name: "approved", type_ref: "builtin:Boolean" }] },
    model_input: {
      protocol: "touba-agent-model-input-v1", mode,
      agent: { responsibility: "Assess the supplied records." },
      developer_instruction: { source: "air_agent_responsibility", text: "Assess the supplied records." },
      capabilities: [capability],
      allowed_actions: ["select_capability", "request_human_review"],
      human_interaction: { review_available: true, available_actions: ["request_human_review"] },
      decision_policy: { prior_use_does_not_exhaust_capability: true, request_capabilities_when_human_review_is_needed: true },
      output_contract: { action: { enum: ["select_capability", "request_human_review"] }, human_review: { type: "Object" } },
    },
  };
}

const invocation = { records: [{ label: "sample", quantity: 2, enabled: true, amount: 1.5 }] };

test("internal extraction preserves the public error constructor and package exports", () => {
  assert.equal(sdk.ToubaAgentDecisionProviderError, ToubaAgentDecisionProviderError);
  assert.throws(() => validateAgentDecisionRequest({}), (error) =>
    error instanceof sdk.ToubaAgentDecisionProviderError && error.code === "InvalidAgentDecisionRequest");
  for (const name of ["validateAgentDecisionRequest", "decisionSchemaForRequest", "argumentsSchemaForCapability", "defaultDecisionSystemPrompt"]) {
    assert.equal(Object.hasOwn(sdk, name), false);
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.exports, { ".": "./src/index.mjs" });
});

test("shared signature schemas preserve records, lists and every supported scalar", () => {
  const input = request();
  assert.deepEqual(argumentsSchemaForCapability(input.capabilities[0]), {
    type: "object", properties: { records: { type: "array", items: {
      type: "object", properties: { label: { type: "string" }, quantity: { type: "integer" },
        enabled: { type: "boolean" }, amount: { type: "number" } },
      required: ["label", "quantity", "enabled", "amount"], additionalProperties: false,
    } } }, required: ["records"], additionalProperties: false,
  });
  assert.deepEqual(agentResultSchema(input), { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false });
  assert.deepEqual(agentResultSchema({}), { type: "string" });
  assert.throws(() => argumentsSchemaForCapability({ signature: { inputs: [{ name: "missing", type_ref: "type:Missing" }] } }),
    (error) => error.code === "UnsupportedDecisionTypeDescriptor");
});

test("public provider uses the shared default contract unchanged in all modes and review policies", async () => {
  for (const mode of ["summary", "capabilities", "finalization"]) for (const allowHumanReview of [true, false]) {
    const input = request(mode);
    const original = structuredClone(input);
    const output = mode === "capabilities"
      ? { action: "select_capability", target_ref: input.capability_refs[0], arguments: invocation, reason: "observed" }
      : { action: "answer_directly", reason: "observed", result: { approved: true } };
    let captured;
    const provider = sdk.createAiSdkDecisionProvider({
      model: "offline", source: "shared_contract_test", allowHumanReview, instructions: "Application context.",
      jsonSchema: (schema) => schema,
      generateObject: async (options) => { captured = options; return { object: output }; },
    });
    const normalized = await provider(input);
    const policy = { allowHumanReview };
    assert.deepEqual(captured.schema, decisionSchemaForRequest(input, { source: "shared_contract_test" }, policy));
    assert.equal(captured.prompt, JSON.stringify(modelInputForDecision(input, policy), null, 2));
    assert.equal(captured.system, `${defaultDecisionSystemPrompt(input, policy)}\n\nApplication context.`);
    assert.deepEqual(normalized, normalizeAiSdkDecisionObject(input, output, "shared_contract_test", policy));
    assert.deepEqual(input, original);
  }
});

test("default structured catalogue keeps its field ordering and human-review convention", () => {
  const schema = decisionSchemaForRequest(request(), { source: "test" });
  assert.deepEqual(Object.keys(schema.properties), ["action", "target_ref", "source", "reason", "arguments", "review_prompt"]);
  assert.deepEqual(schema.properties.action.enum, ["select_capability", "request_human_review"]);
  assert.deepEqual(schema.properties.target_ref.enum, ["skill:service/Assess", "human_review"]);
  assert.match(defaultDecisionSystemPrompt(request()), /Follow the output JSON Schema exactly\./);
  assert.match(defaultDecisionSystemPrompt(request()), /set target_ref to human_review, review_prompt to a short sentence, and arguments to an empty object\./);
});

test("explicit native transport keeps the validated prototype wording and avoids JSON review instructions", () => {
  const input = request();
  const native = defaultDecisionSystemPrompt(input, { transport: "native_tools", allowHumanReview: false });
  const baseline = defaultDecisionSystemPrompt(input, { allowHumanReview: false });
  const structuredDirective = "Follow the output JSON Schema exactly.";
  const nativeDirective = "Return exactly one authorized function call with its declared arguments; the runtime will validate and execute it.";
  assert.equal(native, baseline.replace(structuredDirective, nativeDirective));
  const review = defaultDecisionSystemPrompt(input, { transport: "native_tools", allowHumanReview: true });
  assert.match(review, /provided native review operation/);
  assert.doesNotMatch(review, /set target_ref|review_prompt|output JSON Schema/);
  assert.throws(() => defaultDecisionSystemPrompt(input, { transport: "invented" }), /unsupported decision prompt transport/);
  for (const mode of ["summary", "finalization"]) {
    assert.throws(() => defaultDecisionSystemPrompt(request(mode), { transport: "native_tools" }), /requires capabilities mode/);
    assert.equal(defaultDecisionSystemPrompt(request(mode)), defaultDecisionSystemPrompt(request(mode), { transport: "json_schema" }));
  }
});

test("shared normalizer rejects unknown targets, malformed arguments and terminal invocation", () => {
  const input = request();
  const selection = { action: "select_capability", target_ref: input.capability_refs[0], arguments: invocation, reason: "" };
  assert.deepEqual(normalizeAiSdkDecisionObject(input, selection, "native"), {
    target_ref: input.capability_refs[0], arguments: invocation, source: "native", reason: "",
  });
  for (const invalid of [
    { ...selection, target_ref: "tool:outside/Write" },
    { ...selection, arguments: { records: [{ ...invocation.records[0], quantity: "2" }] } },
    { ...selection, arguments: { records: invocation.records, extra: true } },
  ]) assert.throws(() => normalizeAiSdkDecisionObject(input, invalid, "native"), (error) => error.code === "InvalidModelDecision");
  assert.throws(() => normalizeAiSdkDecisionObject(request("finalization"), selection, "native"), /unavailable capability/);
  assert.throws(() => normalizeAiSdkDecisionObject(input, { action: "request_human_review", reason: "Review required", review_prompt: "Review" }, "native", { allowHumanReview: false }), /disabled/);
});
