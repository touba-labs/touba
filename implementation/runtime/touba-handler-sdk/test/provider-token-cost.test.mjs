import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderTokenCostAdapter, createProviderCostFetch } from "../src/index.mjs";
import { createSqliteProviderBudget } from "../src/sqlite-provider-budget.mjs";

// Deliberately synthetic tariffs; no external prices or API calls.
const tariff = { id: "test-tariff", date: "2026-10-19", currency: "USD",
  rates: { input: 1000000n, output: 2000000n, cacheRead: 100000n, cacheWrite5m: 1250000n, cacheWrite1h: 2000000n } };
const fixtures = [
  { protocol: "openai-responses", path: "/v1/responses", body: { model: "test-model", input: "hello", max_output_tokens: 20 },
    response: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 15 } } }, cost: 104n },
  { protocol: "openai-chat", path: "/v1/chat/completions", body: { model: "test-model", messages: [{ role: "user", content: "hello" }], max_completion_tokens: 20 },
    response: { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 15 } } }, cost: 104n },
  { protocol: "anthropic-messages", path: "/v1/messages", body: { model: "test-model", messages: [{ role: "user", content: "hello" }], max_tokens: 20 },
    response: { usage: { input_tokens: 20, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 40,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 } } }, cost: 122n },
  { protocol: "google-generate-content", path: "/v1beta/models/test-model:generateContent", body: { contents: [{ parts: [{ text: "hello" }] }],
    generationConfig: { maxOutputTokens: 20, thinkingConfig: { thinkingBudget: 10 } } },
    response: { usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 10, totalTokenCount: 130 } }, cost: 124n },
];
const adapter = (fixture, options = {}) => createProviderTokenCostAdapter({ protocol: fixture.protocol, model: "test-model", tariff,
  inputTokenBound: async () => ({ basis: "upper_bound", tokens: 100 }), ...options });
const request = (fixture, changes = {}) => new Request(`https://provider.example${fixture.path}`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fixture.body, ...changes }) });

for (const fixture of fixtures) test(`${fixture.protocol}: full input, cache, invisible output and exact integer pricing`, async () => {
  const cost = adapter(fixture), quote = await cost.quote(request(fixture));
  assert.equal(quote.maxCostMicros, fixture.protocol === "google-generate-content" ? 260n : 240n);
  assert.deepEqual(await cost.readUsage(Response.json(fixture.response), quote), { kind: "reported", costMicros: fixture.cost });
  assert.deepEqual(await cost.readUsage(Response.json({}, { status: 503 }), quote), { kind: "unknown" });
});

test("rate snapshots cannot be mutated and rounding happens once after summation", async () => {
  const fixture = fixtures[0], prices = { ...tariff, rates: { input: 1n, output: 1n } };
  const cost = adapter(fixture, { tariff: prices });
  prices.rates.input = 1000000000n;
  const quote = await cost.quote(request(fixture));
  assert.equal(quote.maxCostMicros, 1n);
  assert.equal((await cost.readUsage(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }), quote)).costMicros, 1n);
});

test("estimated counts, unknown models, modes and extra billing features refuse before fetch", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-cost-adapters-"));
  const budget = createSqliteProviderBudget({ filename: join(root, "cost.sqlite"), budgetId: "test", currency: "USD", limitMicros: 10000n });
  t.after(() => { budget.close(); rmSync(root, { recursive: true, force: true }); });
  let sent = 0;
  const fixture = fixtures[0];
  for (const change of [{ model: "different" }, { previous_response_id: "resp_secret" }, { conversation: "stored" },
    { service_tier: "priority" }, { stream: true }, { tools: [{ type: "web_search" }] },
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://private.example" }] }] },
    { max_output_tokens: 0 }, { max_output_tokens: -1 }, { max_output_tokens: 1.1 }, { some_future_fee: true }]) {
    const fetch = createProviderCostFetch({ budget, ...adapter(fixture), fetch: async () => { sent++; return Response.json({}); } });
    await assert.rejects(() => fetch(request(fixture, change)), { code: "ProviderCostBoundUnavailable" });
  }
  const fetch = createProviderCostFetch({ budget, ...adapter(fixture, { inputTokenBound: () => ({ basis: "estimate", tokens: 5 }) }),
    fetch: async () => { sent++; return Response.json({}); } });
  await assert.rejects(() => fetch(request(fixture)), { code: "ProviderCostBoundUnavailable" });
  assert.equal(sent, 0); assert.equal(budget.snapshot().committedMicros, 0n);
});

test("incomplete usage never releases a reservation", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-cost-unknown-"));
  const budget = createSqliteProviderBudget({ filename: join(root, "cost.sqlite"), budgetId: "test", currency: "USD", limitMicros: 10000n });
  t.after(() => { budget.close(); rmSync(root, { recursive: true, force: true }); });
  const bad = [
    [0, { usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: { cached_tokens: 6 } } }],
    [0, { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 8 } }],
    [0, { usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: { cache_write_tokens: 2 } } }],
    [0, { usage: { input_tokens: 5 } }],
    [2, { usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 6 } }],
    [2, { usage: { input_tokens: 5, output_tokens: 1, server_tool_use: { web_search_requests: 1 } } }],
    [3, { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, thoughtsTokenCount: 2, totalTokenCount: 6 } }],
  ];
  let reserved = 0n;
  for (const [index, data] of bad) {
    const fixture = fixtures[index], cost = adapter(fixture);
    const fetch = createProviderCostFetch({ budget, ...cost, fetch: async () => Response.json(data) });
    const quote = await cost.quote(request(fixture)); reserved += quote.maxCostMicros;
    await fetch(request(fixture));
    assert.equal(budget.snapshot().committedMicros, reserved);
  }
  assert.equal(budget.snapshot().attempts.unknown, bad.length);
});

test("Gemini needs an explicit thinking bound and rejects remotely executed tools or media", async () => {
  const fixture = fixtures[3], cost = adapter(fixture);
  for (const change of [{ cachedContent: "cachedContents/private" }, { tools: [{ googleSearch: {} }] },
    { generationConfig: { maxOutputTokens: 20 } }, { generationConfig: { maxOutputTokens: 20, thinkingConfig: { thinkingBudget: -1 } } },
    { contents: [{ parts: [{ inlineData: { data: "private" } }] }] }]) {
    await assert.rejects(() => cost.quote(request(fixture, change)));
  }
});

test("Anthropic cache directives require the corresponding host prices", async () => {
  const fixture = fixtures[2], cost = adapter(fixture, { tariff: { ...tariff, rates: { input: 1n, output: 1n } } });
  await assert.rejects(() => cost.quote(request(fixture, { system: [{ type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } }] })));
  await assert.rejects(() => cost.quote(request(fixture, { tools: [{ type: "web_search_20250305", name: "web_search" }] })));
});

test("request and response readers are bounded even without content length", async () => {
  const fixture = fixtures[0], cost = adapter(fixture, { maxBodyBytes: 80 });
  await assert.rejects(() => cost.quote(request(fixture, { input: "x".repeat(100) })));
  const quote = { currency: "USD", tariffId: tariff.id, tariffDate: tariff.date };
  await assert.rejects(() => cost.readUsage(Response.json({ output: "x".repeat(100) }), quote));
});
