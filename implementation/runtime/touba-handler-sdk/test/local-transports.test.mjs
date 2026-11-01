import test from "node:test";
import assert from "node:assert/strict";
import { createOllamaDecisionProvider } from "../src/index.mjs";
import { nativeCapabilityName } from "../src/native-decision.mjs";

const ref = "tool:local/Read";
const toolName = nativeCapabilityName(ref);
const request = mode => ({ protocol: "touba-agent-decision-v1", mode, content_mode: "inline",
  agent_ref: "agent:local/Reader", agent_signature: { output_type: "builtin:Text" },
  capability_refs: [ref], capabilities: [{ target_ref: ref, name: "Read", description: "Read a local note.",
    signature: { inputs: [], output_type: "builtin:Text" } }],
  model_input: { protocol: "touba-agent-model-input-v1", user_input: { value: {} }, allowed_actions: [], agent_state: {} } });

for (const transport of ["responses", "chat"]) for (const decisionInterface of ["structured", "native"]) {
  for (const mode of ["summary", "capabilities", "finalization"]) test(`${transport}: ${decisionInterface} ${mode} keeps the decision contract`, async () => {
    const native = decisionInterface === "native" && mode === "capabilities";
    const decision = mode === "capabilities"
      ? { action: "select_capability", target_ref: ref, arguments: {}, source: "local_test", reason: "", review_prompt: "" }
      : { action: "answer_directly", source: "local_test", reason: "", result: "done" };
    let calls = 0;
    const provider = createOllamaDecisionProvider({ model: "local-fixture", transport, decisionInterface, history: false,
      fetch: async (url, init) => {
        calls++;
        assert.ok(String(url).endsWith(transport === "chat" ? "/chat/completions" : "/responses"));
        const body = JSON.parse(init.body);
        assert.equal(body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens, 4096);
        if (!native) assert.equal(transport === "chat" ? body.response_format.type : body.text.format.type, "json_schema");
        const response = transport === "chat" ? {
          id: "chatcmpl_local", object: "chat.completion", created: 1, model: "local-fixture",
          choices: [{ index: 0, finish_reason: native ? "tool_calls" : "stop", message: { role: "assistant",
            content: native ? null : JSON.stringify({ decision }), ...(native ? { tool_calls: [{ id: "call_1", type: "function",
              function: { name: toolName, arguments: "{}" } }] } : {}) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        } : {
          object: "response", id: "resp_local", created_at: 1, model: "local-fixture", status: "completed", error: null, incomplete_details: null,
          output: native ? [{ type: "function_call", id: "fc_local", call_id: "call_1", name: toolName, arguments: "{}", status: "completed" }]
            : [{ type: "message", id: "msg_local", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ decision }), annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        return Response.json(response);
      } });
    const result = await provider(request(mode));
    assert.equal(mode === "capabilities" ? result.target_ref : result.result, mode === "capabilities" ? ref : "done");
    assert.equal(calls, 1);
  });
}

test("invalid transport is refused before any request", () => {
  assert.throws(() => createOllamaDecisionProvider({ transport: "auto" }), { code: "InvalidDecisionProviderOptions" });
});

for (const action of ["timeout", "cancel"]) test(`local HTTP ${action} propagates cancellation without retry`, async () => {
  const controller = new AbortController();
  let calls = 0, aborted = false;
  const provider = createOllamaDecisionProvider({ transport: "chat", history: false, timeoutMs: 30,
    fetch: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        const stop = () => { aborted = true; reject(init.signal.reason); };
        if (init.signal.aborted) stop(); else init.signal.addEventListener("abort", stop, { once: true });
      });
    } });
  // An HTTP socket normally keeps the event loop alive; this mock needs a timer.
  const keepalive = setTimeout(() => {}, 1000);
  const pending = provider(request("summary"), { signal: controller.signal });
  if (action === "cancel") setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(pending); } finally { clearTimeout(keepalive); }
  assert.equal(calls, 1); assert.equal(aborted, true);
});
