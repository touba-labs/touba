import test from "node:test";
import assert from "node:assert/strict";
import { createProviderContextFetch, createOpenAiDecisionProvider, createAiSdkDecisionProvider } from "../src/index.mjs";
import { contextPreflightError } from "../src/provider-context.mjs";

const samples = {
  openai: { url: "https://api.openai.com/v1/responses", body: { model: "test-model", input: [{ role: "user", content: "Private input" }],
    instructions: "System instructions", tools: [{ name: "Read", type: "function", parameters: { type: "object" } }],
    text: { format: { type: "json_schema", schema: { type: "object" } } }, max_output_tokens: 100 } },
  anthropic: { url: "https://api.anthropic.com/v1/messages?beta=true", body: { model: "test-model", system: "System instructions",
    messages: [{ role: "user", content: "Private input" }], tools: [{ name: "Read", input_schema: { type: "object" } }],
    thinking: { type: "adaptive" }, max_tokens: 100 } },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent", body: {
    contents: [{ role: "user", parts: [{ text: "Private input" }, { functionCall: { name: "Read", args: {} }, thoughtSignature: "original-signature" }] }],
    systemInstruction: { parts: [{ text: "System instructions" }] }, tools: [{ functionDeclarations: [{ name: "Read" }] }],
    generationConfig: { maxOutputTokens: 100, responseJsonSchema: { type: "object" } } } },
};
for (const [provider, { url, body }] of Object.entries(samples)) {
  test(`${provider}: counts the full serialized input and forwards the original request unchanged`, async () => {
    const events = [], counts = [], sent = [];
    const guard = createProviderContextFetch({ provider, contextWindowTokens: 1000, safetyMarginTokens: 20,
      onEvent: event => events.push(event),
      countFetch: async (endpoint, init) => { counts.push({ endpoint, ...init }); return Response.json({ input_tokens: 200, totalTokens: 200 }); },
      fetch: async (input, init) => { sent.push({ input, init }); return Response.json({ done: true }); } });
    const init = { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer private-key", "anthropic-beta": "test-beta" } };
    await guard(url, init);
    assert.equal(sent.length, 1); assert.equal(sent[0].init, init);
    assert.equal(counts.length, 1); assert.equal(new URL(counts[0].endpoint).origin, new URL(url).origin);
    assert.match(counts[0].endpoint, /count_tokens|input_tokens|countTokens/);
    assert.equal(counts[0].headers.get("authorization"), "Bearer private-key");
    assert.equal(counts[0].headers.get("anthropic-beta"), "test-beta");
    assert.equal(counts[0].redirect, "error");
    const counted = JSON.parse(counts[0].body);
    if (provider === "google") assert.deepEqual(counted.generateContentRequest, { ...body, model: "models/test-model" });
    else {
      assert.deepEqual(counted.tools, body.tools);
      assert.deepEqual(counted.input ?? counted.messages, body.input ?? body.messages);
      assert.equal(counted.instructions ?? counted.system, "System instructions");
      if (provider === "openai") assert.deepEqual(counted.text, body.text);
    }
    assert.equal(events[0].reserved_input_tokens, 260);
    assert(!JSON.stringify(events).includes("Private input")); assert(!JSON.stringify(events).includes("private-key"));
  });
  test(`${provider}: insufficient space refuses before paid generation`, async () => {
    let sent = 0;
    const guard = createProviderContextFetch({ provider, contextWindowTokens: 200, safetyMarginTokens: 0,
      countFetch: async () => Response.json({ input_tokens: 100, totalTokens: 100 }),
      fetch: async () => { sent++; assert.fail("must not generate"); } });
    await assert.rejects(guard(url, { method: "POST", body: JSON.stringify(body) }), error => {
      assert.equal(error.code, "ProviderContextWindowExceeded");
      assert.equal(contextPreflightError(new Error("wrapped", { cause: error })), error);
      assert.equal(contextPreflightError({ code: error.code }), null);
      return true;
    });
    assert.equal(sent, 0);
  });
}
test("count errors, invalid responses and unsupported endpoints fail closed without leaking payloads", async () => {
  for (const countFetch of [async () => { throw new Error("private-key Private input"); },
    async () => new Response("private-key", { status: 429 }), async () => Response.json({}),
    async () => Response.json({ input_tokens: -1 })]) {
    const guard = createProviderContextFetch({ provider: "openai", contextWindowTokens: 1000, countFetch,
      fetch: () => assert.fail("must not generate") });
    await assert.rejects(guard(samples.openai.url, { body: JSON.stringify(samples.openai.body) }), error => {
      assert.equal(error.code, "ProviderContextCountUnavailable");
      assert(!JSON.stringify(error).includes("private-key")); return true;
    });
  }
  const guard = createProviderContextFetch({ provider: "openai", contextWindowTokens: 1000,
    fetch: () => assert.fail("must not contact arbitrary endpoints") });
  for (const url of ["https://example.test/v1/responses", "https://api.openai.com/v1/chat/completions"]) {
    await assert.rejects(guard(url, { body: JSON.stringify(samples.openai.body) }), { code: "ProviderContextCountUnavailable" });
  }
  for (const extra of [{ previous_response_id: "external" }, { truncation: "auto" }, { conversation: "external" }]) {
    await assert.rejects(guard(samples.openai.url, { body: JSON.stringify({ ...samples.openai.body, ...extra }) }), { code: "ProviderContextCountUnavailable" });
  }
});
test("Request bodies remain readable; missing output reservation refuses", async () => {
  const guard = createProviderContextFetch({ provider: "openai", contextWindowTokens: 1000, safetyMarginTokens: 0,
    countFetch: async () => Response.json({ input_tokens: 100 }), fetch: async input => Response.json(await input.json()) });
  const input = new Request(samples.openai.url, { method: "POST", body: JSON.stringify(samples.openai.body) });
  assert.deepEqual(await (await guard(input)).json(), samples.openai.body);
  await assert.rejects(guard(samples.openai.url, { body: JSON.stringify({ ...samples.openai.body, max_output_tokens: undefined }) }),
    { code: "InvalidDecisionProviderOptions" });
});
test("generic provider cannot silently ignore context settings", () => {
  assert.throws(() => createAiSdkDecisionProvider({ model: "test", context: { contextWindowTokens: 1000 } }),
    { code: "InvalidDecisionProviderOptions" });
});
test("real OpenAI serializer refuses mandatory context with no generation or automatic retry", async () => {
  const key = "TOUBA_CONTEXT_FIXTURE_KEY", previous = process.env[key]; process.env[key] = "fixture";
  const counts = [];
  try {
    const decide = createOpenAiDecisionProvider({ model: "test-model", apiKeyEnvNames: [key], maxRetries: 2,
      context: { contextWindowTokens: 1000 }, countFetch: async (_url, init) => {
        counts.push(JSON.parse(init.body)); return Response.json({ input_tokens: 5000 });
      }, fetch: () => assert.fail("must not generate") });
    await assert.rejects(decide({ protocol: "touba-agent-decision-v1", mode: "summary", run_id: "r", invocation_id: "i",
      agent_ref: "agent:context/Reader", capability_refs: [], inputs: { query: "Read." }, observations: [],
      agent_signature: { output_type: "builtin:Text" },
      model_input: { protocol: "touba-agent-model-input-v1", agent: { responsibility: "Read." }, agent_state: {},
        decision_policy: {}, output_contract: {}, user_input: { value: "Read." } } }), { code: "ProviderContextWindowExceeded" });
    assert.equal(counts.length, 1);
    assert.equal(counts[0].text.format.type, "json_schema");
    assert(counts[0].input.some(message => message.role === "system"));
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});
