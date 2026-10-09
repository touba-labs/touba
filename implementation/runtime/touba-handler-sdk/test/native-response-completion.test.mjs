import assert from "node:assert/strict";
import test from "node:test";
import { createAiSdkDecisionProvider, createOpenAiDecisionProvider, createOllamaDecisionProvider } from "../src/index.mjs";
import { nativeCapabilityName } from "../src/native-decision.mjs";

const capabilityRef = "tool:response_completion/Read";
const toolName = nativeCapabilityName(capabilityRef);
const source = "completion_test";
const model = "offline-response-fixture";
const completeAnswer = { action: "answer_directly", source, reason: "The requested work is complete.", result: "done" };

function request(mode) {
  return {
    protocol: "touba-agent-decision-v1", mode, content_mode: "inline",
    agent_ref: "agent:response_completion/Worker", agent_signature: { output_type: "builtin:Text" },
    capability_refs: [capabilityRef], capabilities: [{ target_ref: capabilityRef, name: "Read",
      signature: { inputs: [], output_type: "builtin:Text" } }],
    model_input: { protocol: "touba-agent-model-input-v1", user_input: { value: {} },
      allowed_actions: [], agent_state: {} },
  };
}

function responseBody(mode, status, decisionInterface = "native") {
  const object = mode === "capabilities" && decisionInterface === "structured"
    ? { action: "select_capability", target_ref: capabilityRef, arguments: {}, source, reason: "", review_prompt: "" }
    : completeAnswer;
  return {
    object: "response", id: "resp_completion", created_at: 1, model, status,
    error: null, incomplete_details: null,
    output: mode === "capabilities" && decisionInterface === "native"
      ? [{ type: "function_call", id: "fc_completion", call_id: "call_completion", name: toolName, arguments: "{}", status: "completed" }]
      : [{ type: "message", id: "msg_completion", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(object), annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

async function withFakeKey(run) {
  const name = "TOUBA_RESPONSE_COMPLETION_TEST_KEY";
  const previous = process.env[name];
  process.env[name] = "local-fixture-not-a-credential";
  try { return await run(name); }
  finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
}

// HTTP is replaced, not the installed AI SDK parsing/finish-reason mapping.
// These counterexamples contain usable JSON/calls but must never be decisions.
test("native and structured HTTP Responses reject non-completed envelopes despite complete-looking output", async () => {
  await withFakeKey(async (keyName) => {
    for (const factory of [createOpenAiDecisionProvider, createOllamaDecisionProvider]) {
      for (const decisionInterface of ["structured", "native"]) for (const mode of ["summary", "capabilities", "finalization"]) {
        for (const status of ["failed", "incomplete", "in_progress", "cancelled", "queued"]) {
          let calls = 0;
          const provider = factory({ model, source, decisionInterface, allowHumanReview: false,
            apiKeyEnvNames: [keyName], maxRetries: 0,
            fetch: async () => {
              calls++;
              return new Response(JSON.stringify(responseBody(mode, status, decisionInterface)), { headers: { "Content-Type": "application/json" } });
            } });
          await assert.rejects(() => provider(request(mode)), (error) => error.code === "IncompleteModelDecision",
            `${factory.name}/${mode}/${status}`);
          assert.equal(calls, 1);
        }
      }
    }
  });
});

test("known Responses factories require completed status even without the object discriminator", async () => {
  await withFakeKey(async (keyName) => {
    for (const factory of [createOpenAiDecisionProvider, createOllamaDecisionProvider]) {
      for (const status of [undefined, "incomplete", "completed"]) {
        const body = responseBody("summary", status);
        delete body.object;
        const provider = factory({ model, source, decisionInterface: "native", allowHumanReview: false,
          apiKeyEnvNames: [keyName], maxRetries: 0,
          fetch: async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }) });
        if (status === "completed") assert.deepEqual(await provider(request("summary")), completeAnswer);
        else await assert.rejects(() => provider(request("summary")), (error) => error.code === "IncompleteModelDecision");
      }
    }
  });
});

test("native and structured HTTP Responses accept completed decisions in all three modes", async () => {
  await withFakeKey(async (keyName) => {
    for (const factory of [createOpenAiDecisionProvider, createOllamaDecisionProvider]) {
      for (const decisionInterface of ["structured", "native"]) for (const mode of ["summary", "capabilities", "finalization"]) {
        const provider = factory({ model, source, decisionInterface, allowHumanReview: false,
          apiKeyEnvNames: [keyName], maxRetries: 0,
          fetch: async () => new Response(JSON.stringify(responseBody(mode, "completed", decisionInterface)), { headers: { "Content-Type": "application/json" } }) });
        const decision = await provider(request(mode));
        if (mode === "capabilities") assert.deepEqual(decision, { target_ref: capabilityRef, source, reason: "", arguments: {} });
        else assert.deepEqual(decision, completeAnswer);
      }
    }
  });
});

test("generic AI SDK models keep provider-neutral completion while explicit Responses envelopes are checked", async () => {
  for (const mode of ["summary", "capabilities", "finalization"]) {
    const success = mode === "capabilities"
      ? { finishReason: "tool-calls", toolCalls: [{ toolName, input: {} }] }
      : { finishReason: "stop", object: completeAnswer };
    for (const body of [undefined, { object: "another-provider", status: "provider-specific" }, { object: "response", status: "completed" }]) {
      const provider = createAiSdkDecisionProvider({ model, source, decisionInterface: "native", allowHumanReview: false,
        jsonSchema: (schema) => schema,
        generateObject: async () => ({ ...success, response: { body } }),
        generateText: async () => ({ ...success, response: { body } }),
      });
      assert(await provider(request(mode)));
    }
    for (const body of [
      { object: "response", status: "failed" },
      { object: "response", status: "incomplete" },
      { object: "response" },
      { object: "response", status: "completed", error: { message: "PRIVATE_PROVIDER_ERROR" } },
      { object: "response", status: "completed", incomplete_details: { reason: "PRIVATE_PARTIAL_OUTPUT" } },
    ]) {
      const provider = createAiSdkDecisionProvider({ model, source, decisionInterface: "native", allowHumanReview: false,
        jsonSchema: (schema) => schema,
        generateObject: async () => ({ ...success, response: { body } }),
        generateText: async () => ({ ...success, response: { body } }),
      });
      await assert.rejects(() => provider(request(mode)), (error) => {
        assert.equal(error.code, "IncompleteModelDecision");
        assert(!error.message.includes("PRIVATE_"));
        assert(!JSON.stringify(error).includes("PRIVATE_"));
        return true;
      });
    }
  }
});
