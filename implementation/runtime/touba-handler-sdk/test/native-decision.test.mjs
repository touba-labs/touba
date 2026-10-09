import assert from "node:assert/strict";
import test from "node:test";
import { createAiSdkDecisionProvider, createOpenAiDecisionProvider, createOllamaDecisionProvider } from "../src/index.mjs";
import { nativeCapabilityName } from "../src/native-decision.mjs";

function request(mode = "capabilities") {
  const capability = { target_ref: "tool:service/Read", name: "Read", kind: "tool",
    signature: { inputs: [{ name: "reference", type_ref: "builtin:Text" }], output_type: "builtin:Int" } };
  return { protocol: "touba-agent-decision-v1", mode, content_mode: "inline", agent_ref: "agent:service/Worker",
    capability_refs: [capability.target_ref], capabilities: [capability], observations: [],
    model_input: { protocol: "touba-agent-model-input-v1", mode, agent: { responsibility: "Read a reference." },
      user_input: { value: { reference: "A-17" } }, allowed_actions: mode === "capabilities" ? ["select_capability"] : ["answer_directly", "request_capabilities"],
      decision_policy: {}, output_contract: {}, agent_state: {} } };
}

function nativeOptions(overrides = {}) {
  return { model: "offline", decisionInterface: "native", allowHumanReview: false,
    jsonSchema: (schema) => schema, ...overrides };
}

const selection = () => ({ toolName: nativeCapabilityName("tool:service/Read"), input: { reference: "A-17" } });

test("native selection derives one strict non-executable function per authorized signature", async () => {
  let generated;
  const input = request();
  const original = structuredClone(input);
  const provider = createAiSdkDecisionProvider(nativeOptions({
    instructions: "Local service guidance.",
    generateText: async (options) => { generated = options; return { finishReason: "tool-calls", toolCalls: [selection()] }; },
  }));
  assert.deepEqual(await provider(input), { target_ref: input.capability_refs[0], source: "ai_sdk_native_tools", reason: "", arguments: { reference: "A-17" } });
  assert.deepEqual(input, original);
  assert.equal(generated.toolChoice, "required");
  assert.equal(generated.providerOptions.openai.parallelToolCalls, false);
  assert.match(generated.system, /Local service guidance/);
  assert.equal(generated.prompt, undefined);
  const tool = generated.tools[selection().toolName];
  assert.equal(tool.execute, undefined);
  assert.equal(tool.strict, true);
  assert.deepEqual(tool.inputSchema, { type: "object", properties: { reference: { type: "string" } }, required: ["reference"], additionalProperties: false });
});

test("native selection rejects ambiguous, unknown, malformed, provider-executed and incomplete proposals", async () => {
  for (const response of [
    { finishReason: "length", toolCalls: [selection()] },
    { finishReason: "tool-calls", toolCalls: [] },
    { finishReason: "tool-calls", toolCalls: [selection(), selection()] },
    { finishReason: "tool-calls", toolCalls: [{ ...selection(), providerExecuted: true }] },
    { finishReason: "tool-calls", toolCalls: [{ ...selection(), invalid: true }] },
    { finishReason: "tool-calls", toolCalls: [{ ...selection(), toolName: "unauthorized" }] },
    { finishReason: "tool-calls", toolCalls: [{ ...selection(), input: { reference: 123 } }] },
    { finishReason: "tool-calls", toolCalls: [{ ...selection(), input: { reference: "A", extra: true } }] },
    { finishReason: "tool-calls", toolCalls: [selection()], toolResults: [{ result: 42 }] },
  ]) await assert.rejects(() => createAiSdkDecisionProvider(nativeOptions({ generateText: async () => response }))(request()),
    (error) => ["IncompleteModelDecision", "InvalidModelDecision"].includes(error.code));
});

test("native finalization preserves typed output and cannot select capabilities or consume partial output", async () => {
  const input = request("finalization");
  input.agent_signature = { output_type: "builtin:Int" };
  for (const [object, finishReason, valid] of [
    [{ action: "answer_directly", result: 42 }, "stop", true],
    [{ action: "answer_directly", result: "42" }, "stop", false],
    [{ action: "request_capabilities" }, "stop", false],
    [{ action: "answer_directly", result: 42 }, "length", false],
    [{ action: "cannot_complete", reason: "Missing evidence" }, "stop", true],
  ]) {
    const provider = createAiSdkDecisionProvider(nativeOptions({ generateObject: async (options) => {
      assert.equal(options.tools, undefined);
      assert.equal(options.providerOptions?.openai?.parallelToolCalls, undefined);
      return { object, finishReason };
    } }));
    if (valid) assert.equal((await provider(input)).action, object.action);
    else await assert.rejects(() => provider(input));
  }
});

test("invalid interface and unenforceable generic transport budgets fail explicitly", () => {
  for (const decisionInterface of ["native_history", "unknown", false, null]) {
    assert.throws(() => createAiSdkDecisionProvider({ decisionInterface }), /decisionInterface/);
  }
  assert.throws(() => createAiSdkDecisionProvider({ maxProviderRequestBytes: 100 }), /HTTP provider factory/);
});

test("native names are stable, bounded and distinct even with identical or non-ASCII display names", () => {
  const refs = ["tool:one/Read", "skill:one/Read", "agent:two/Read", `tool:long/${"é".repeat(100)}`, "tool:long/____"];
  const names = refs.map(nativeCapabilityName);
  assert.equal(new Set(names).size, refs.length);
  for (const [index, name] of names.entries()) {
    assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(name, nativeCapabilityName(refs[index]));
  }
});

function httpResponse(output) {
  return new Response(JSON.stringify({ id: "resp_test", created_at: 1, model: "gpt-4o-mini-2024-07-18", status: "completed",
    output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }), { headers: { "Content-Type": "application/json" } });
}

test("actual AI SDK HTTP serialization preserves executed pairs, native signatures and tool-free finalization", async () => {
  const envName = "TOUBA_NATIVE_TEST_API_KEY";
  const previous = process.env[envName];
  process.env[envName] = "local-fake-key-not-a-credential";
  try {
    for (const factory of [createOpenAiDecisionProvider, createOllamaDecisionProvider]) {
      const input = request();
      input.observations = [{ action: "select_capability", target_ref: "tool:service/Read", arguments: { reference: "previous" }, value: 23 }];
      const bodies = [];
      const provider = factory({ model: "gpt-4o-mini-2024-07-18", apiKeyEnvNames: [envName],
        decisionInterface: "native", allowHumanReview: false, maxRetries: 0, source: "transport_test",
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          bodies.push(body);
          return body.tools?.length
            ? httpResponse([{ type: "function_call", id: "fc_new", call_id: "call_new", name: selection().toolName, arguments: JSON.stringify(selection().input), status: "completed" }])
            : httpResponse([{ type: "message", id: "msg_new", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ action: "answer_directly", source: "transport_test", reason: "done", result: "completed" }), annotations: [] }] }]);
        } });
      assert.deepEqual((await provider(input)).arguments, { reference: "A-17" });
      assert.equal(bodies[0].tools[0].strict, true);
      assert.equal(bodies[0].parallel_tool_calls, false);
      assert.equal(bodies[0].text?.format?.type, undefined);
      const call = bodies[0].input.find((item) => item.type === "function_call");
      const result = bodies[0].input.find((item) => item.type === "function_call_output");
      assert.deepEqual(JSON.parse(call.arguments), { reference: "previous" });
      assert.equal(result.output, "23");
      assert.equal(result.call_id, call.call_id);
      input.mode = input.model_input.mode = "finalization";
      assert.equal((await provider(input)).result, "completed");
      assert.equal(bodies[1].tools, undefined);
      assert.equal(bodies[1].parallel_tool_calls, undefined);
      assert.equal(bodies[1].text.format.type, "json_schema");
      assert.equal(bodies[1].text.format.strict, true);
    }
  } finally {
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
  }
});

test("HTTP factory budgets guard the fully serialized native request before any network call", async () => {
  const envName = "TOUBA_NATIVE_BUDGET_TEST_KEY";
  const previous = process.env[envName];
  process.env[envName] = "local-fake-key-not-a-credential";
  try {
    for (const factory of [createOpenAiDecisionProvider, createOllamaDecisionProvider]) {
      for (const runtimeLimit of [undefined, 64]) {
        let httpCalls = 0;
        const input = request();
        input.model_input.skill_pack_budgets = { model_input_max_bytes: runtimeLimit };
        const provider = factory({ model: "gpt-4o-mini-2024-07-18", apiKeyEnvNames: [envName], decisionInterface: "native",
          allowHumanReview: false, maxRetries: 0, maxProviderRequestBytes: runtimeLimit ? 100000 : 64,
          fetch: async () => { httpCalls++; assert.fail("over-budget request must not be transmitted"); } });
        await assert.rejects(() => provider(input), (error) => {
          const budgetError = error.code === "ProviderRequestBudgetExceeded" ? error : error.cause;
          assert.equal(budgetError?.code, "ProviderRequestBudgetExceeded");
          assert.equal(budgetError.details.max_bytes, 64);
          assert(budgetError.details.actual_bytes > 64);
          return true;
        });
        assert.equal(httpCalls, 0);
      }
      assert.throws(() => factory({ maxProviderRequestBytes: 0 }), /positive safe integer/);
    }
  } finally {
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
  }
});
