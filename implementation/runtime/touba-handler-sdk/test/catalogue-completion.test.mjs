import test from "node:test";
import assert from "node:assert/strict";
import { createAiSdkDecisionProvider } from "../src/index.mjs";
import { decisionSchemaForRequest, agentResultSchema } from "../src/decision-contract.mjs";

function request(mode = "capabilities") {
  return { protocol: "touba-agent-decision-v1", mode, run_id: "typed-completion-run", invocation_id: "invocation-1",
    agent_ref: "agent:completion/Worker", step_index: 0, content_mode: "inline", inputs: {}, observations: [],
    capability_refs: ["tool:completion/Read"],
    capabilities: [{ target_ref: "tool:completion/Read", name: "Read", signature: { inputs: [], output_type: "builtin:Text" } }],
    agent_signature: { output_type: "type:completion/Result", output_fields: [{ name: "confirmation", type_ref: "builtin:Text" }] },
    model_input: { protocol: "touba-agent-model-input-v1", agent: { responsibility: "Return the available confirmation." },
      user_input: { value: {} }, agent_state: {}, output_contract: {} } };
}
function completion(input = { result: { confirmation: "recorded" }, reason: "The receipt is available." }) {
  const call = { toolName: "touba_finish", toolCallId: "original-completion", input };
  return { finishReason: "tool-calls", toolCalls: [call],
    response: { messages: [{ role: "assistant", content: [{ type: "tool-call", ...call }] }] } };
}

test("catalogue completion is typed in both interfaces, without dispatch or a formatting request", async () => {
  const input = request();
  const schema = decisionSchemaForRequest(input, { source: "test" }, { allowHumanReview: false });
  assert.equal(schema.anyOf, undefined, "strict provider schemas require an object root");
  const answer = schema.properties.decision.anyOf.find(branch => branch.properties.action.enum.includes("answer_directly"));
  assert.deepEqual(answer.properties.result, agentResultSchema(input));
  for (const decisionInterface of ["structured", "native"]) {
    let calls = 0;
    const decide = createAiSdkDecisionProvider({ model: "test", source: "test", decisionInterface,
      allowHumanReview: false, jsonSchema: schema => schema,
      generateObject: async () => {
        calls++; assert.equal(decisionInterface, "structured");
        return { finishReason: "stop", object: { decision: { action: "answer_directly", source: "test",
          reason: "The receipt is available.", result: { confirmation: "recorded" } } } };
      },
      generateText: async options => {
        calls++; assert.equal(decisionInterface, "native");
        assert.deepEqual(options.tools.touba_finish.inputSchema.properties.result, agentResultSchema(input));
        assert(Object.values(options.tools).every(tool => tool.execute === undefined));
        assert.match(options.system, /touba_finish/);
        return completion();
      },
    });
    assert.deepEqual(await decide(input), { action: "answer_directly", source: "test",
      reason: "The receipt is available.", result: { confirmation: "recorded" } });
    assert.equal(calls, 1);
    await assert.rejects(decide(input), { code: "DecisionHistoryClosed" });
  }
});

test("native prose, mixed calls, malformed output and truncated completion never become a success", async () => {
  const responses = [
    { finishReason: "stop", text: "Everything is done.", toolCalls: [],
      response: { messages: [{ role: "assistant", content: "Everything is done." }] } },
    completion({ result: { confirmation: 7 }, reason: "Wrong type." }),
    completion({ result: { confirmation: "ok" }, reason: "Extra permission.", target_ref: "tool:outside/Write" }),
    completion({ result: { confirmation: "ok" } }),
    { ...completion(), toolCalls: [...completion().toolCalls, ...completion().toolCalls] },
    { ...completion(), finishReason: "length" },
  ];
  for (const response of responses) {
    const decide = createAiSdkDecisionProvider({ model: "test", source: "test", decisionInterface: "native",
      jsonSchema: schema => schema, generateText: async () => response });
    await assert.rejects(decide(request()), error => ["InvalidModelDecision", "IncompleteModelDecision"].includes(error.code));
  }
});

test("native completion cannot execute any capability in terminal finalization", async () => {
  const decide = createAiSdkDecisionProvider({ model: "test", source: "test", decisionInterface: "native",
    jsonSchema: schema => schema, generateText: async () => assert.fail("finalization must not expose native tools"),
    generateObject: async options => {
      assert.equal(options.tools, undefined);
      return { finishReason: "stop", object: { decision: { action: "cannot_complete", source: "test",
        reason: "The required receipt is missing.", result: "" } } };
    } });
  assert.equal((await decide(request("finalization"))).action, "cannot_complete");
});
