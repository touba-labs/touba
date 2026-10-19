import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createOpenAiDecisionProvider, createProviderTokenCostAdapter } from "../src/index.mjs";
import { createSqliteProviderBudget } from "../src/sqlite-provider-budget.mjs";
import { executeAirDocument } from "../../touba-runtime/src/index.mjs";
import { createProviderCostRecorder } from "../../touba-runtime/src/provider-cost-evidence.mjs";

const implementation = fileURLToPath(new URL("../../../", import.meta.url));
const entryRef = "strategy:tests.cost_runtime/Run";
let air;
before(() => {
  const dir = mkdtempSync(join(tmpdir(), "touba-cost-source-"));
  try {
    const filename = join(dir, "main.tb");
    writeFileSync(filename, `module tests.cost_runtime

agent Worker
    gives Text
    responsibility "Return the requested completion."
    callable_by strategy Run

strategy Run
    gives Text
    uses Worker
    do
        Worker
            into result
        give result
`);
    const compiled = spawnSync(resolve(implementation, "target/debug/touba-compile"), [filename], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    air = JSON.parse(compiled.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function setup(t, { limit = 1000n, delay = 0, context = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "touba-cost-runtime-"));
  const budget = createSqliteProviderBudget({ filename: join(dir, "budget.sqlite"), budgetId: "run-ledger", currency: "USD", limitMicros: limit });
  const received = [];
  const http = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push(body);
    assert.equal(budget.snapshot().attempts.pending, 1);
    if (delay) await new Promise(done => setTimeout(done, delay));
    if (req.url.endsWith("/input_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 2 })); return;
    }
    const native = body.tools?.some(tool => tool.name === "touba_finish");
    const output = native ? [{ type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "touba_finish",
      arguments: JSON.stringify({ reason: "The work is complete.", result: "done" }), status: "completed" }]
      : [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [],
        text: JSON.stringify({ decision: { action: "answer_directly", source: "cost_test", reason: "The work is complete.", result: "done" } }) }] }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_fixture", created_at: 1, model: "fixture-model", status: "completed", output,
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(async () => {
    http.closeAllConnections(); await new Promise(done => http.close(done));
    budget.close(); rmSync(dir, { recursive: true, force: true });
  });
  const envName = "TOUBA_COST_RUNTIME_TEST_KEY", previous = process.env[envName];
  process.env[envName] = "offline-fixture-not-a-key";
  t.after(() => { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; });
  // A deliberately synthetic tariff and bound for the finite local fixture.
  const adapter = createProviderTokenCostAdapter({ protocol: "openai-responses", model: "fixture-model",
    tariff: { id: "local-fixture", date: "2026-10-19", currency: "USD", rates: { input: 1000000n, output: 1000000n } },
    inputTokenBound: () => ({ basis: "upper_bound", tokens: 100 }) });
  const localURL = `http://127.0.0.1:${http.address().port}`;
  const localFetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.hostname, "api.openai.com");
    // Preserve the official endpoint contract for the context validator while
    // sending every byte exclusively to the loopback fixture, never to OpenAI.
    return fetch(localURL + url.pathname, { method: request.method, headers: request.headers,
      body: await request.arrayBuffer(), signal: request.signal });
  };
  return { budget, received, provider: decisionInterface => createOpenAiDecisionProvider({ model: "fixture-model", decisionInterface,
    apiKeyEnvNames: [envName], baseURL: context ? "https://api.openai.com/v1" : localURL + "/v1", history: false,
    ...(context ? { fetch: localFetch, countFetch: localFetch } : {}),
    ...(context ? { context: { contextWindowTokens: 1000, safetyMarginTokens: 0 } } : {}),
    maxOutputTokens: 64, maxRetries: 0, cost: { budget, ...adapter, ...(context ? { counting: {
      // Deliberately synthetic accounting for this finite counting fixture.
      quote: () => ({ basis: "upper_bound", maxCostMicros: 2n, currency: "USD", tariffId: "local-count-fixture", tariffDate: "2026-10-19" }),
      readUsage: () => ({ kind: "reported", costMicros: 1n }),
    } } : {}) } }) };
}

test("token counting and generation share one budget and correlate both attempts", async t => {
  const { provider, budget, received } = await setup(t, { context: true });
  const result = await executeAirDocument(air, { entryRef, agentDecisionProvider: provider("native"), agentDecisionProviderInitialMode: "capabilities" });
  assert.equal(result.status, "success", JSON.stringify(result.trace));
  assert.equal(received.length, 2);
  assert.equal(budget.snapshot().committedMicros, 4n);
  const events = result.trace.events.filter(e => e.kind === "provider_cost_recorded");
  assert.deepEqual(events.map(e => e.payload.status), ["pending", "reported", "pending", "reported"]);
  assert.equal(new Set(events.map(e => e.payload.invocation_id)).size, 1);
  assert.equal(new Set(events.map(e => e.payload.attempt_id)).size, 2);
});

test("a priced token-count call cannot leave generation outside the budget", async t => {
  const { provider, budget, received } = await setup(t, { context: true, limit: 2n });
  const result = await executeAirDocument(air, { entryRef, agentDecisionProvider: provider("structured"), agentDecisionProviderMaxRetries: 2 });
  assert.equal(result.status, "failure");
  assert.equal(result.trace.events.findLast(e => e.kind === "failure_detected").payload.runtime_error_code, "ProviderCostBudgetExceeded");
  assert.equal(received.length, 1);
  assert.equal(budget.snapshot().committedMicros, 1n);
});

for (const decisionInterface of ["structured", "native"]) test(`real Core + SDK + HTTP cost evidence: ${decisionInterface}`, async t => {
  const { provider, budget, received } = await setup(t);
  const result = await executeAirDocument(air, { entryRef, agentDecisionProvider: provider(decisionInterface),
    agentDecisionProviderInitialMode: "capabilities", agentDecisionProviderContentMode: "inline" });
  assert.equal(result.status, "success", JSON.stringify(result.trace));
  assert.equal(received.length, 1);
  const events = result.trace.events.filter(event => event.kind === "provider_cost_recorded");
  assert.deepEqual(events.map(event => event.payload.status), ["pending", "reported"]);
  assert.equal(events[1].payload.cost_micros, "3");
  assert.equal(events[0].payload.reserved_micros, "164");
  const attempt = budget.listAttempts()[0];
  assert.equal(attempt.context.invocation_id, events[0].payload.invocation_id);
  assert.equal(attempt.context.agent_ref, "agent:tests.cost_runtime/Worker");
  assert.equal(budget.snapshot().committedMicros, 3n);
  assert.equal(JSON.stringify(received).includes("recordProviderCost"), false);
  assert.equal(JSON.stringify(result.trace).includes("offline-fixture-not-a-key"), false);
});

test("insufficient budget sends no HTTP request and does not enter runtime retry", async t => {
  const { provider, received, budget } = await setup(t, { limit: 100n });
  const result = await executeAirDocument(air, { entryRef, agentDecisionProvider: provider("structured"), agentDecisionProviderMaxRetries: 3 });
  assert.equal(result.status, "failure");
  assert.equal(result.trace.events.findLast(e => e.kind === "failure_detected").payload.runtime_error_code, "ProviderCostBudgetExceeded");
  assert.equal(received.length, 0);
  assert.equal(budget.listAttempts().length, 0);
  assert.equal(result.trace.events.filter(e => e.kind === "agent_decision_provider_call_attempted").length, 1);
});

test("late usage settles SQLite but cannot append to a terminal trace", async t => {
  const { provider, received, budget } = await setup(t, { delay: 150 });
  const result = await executeAirDocument(air, { entryRef, agentDecisionProvider: provider("structured"),
    agentDecisionProviderTimeoutMs: 70, agentDecisionProviderMaxRetries: 0 });
  assert.equal(result.status, "failure");
  const trace = JSON.stringify(result.trace);
  await new Promise(done => setTimeout(done, 250));
  assert.equal(received.length, 1);
  assert.equal(budget.snapshot().committedMicros, 3n);
  assert.equal(JSON.stringify(result.trace), trace);
});

test("cost recorder rejects arbitrary fields, invalid dates and coercible objects", () => {
  const events = [], recorder = createProviderCostRecorder({ agent_ref: "agent:x/A", invocation_id: "invocation:test" },
    { trace: { push: (...args) => events.push(args) } }, () => {});
  const value = { attempt_id: "attempt-1", budget_ref: `sha256:${"a".repeat(64)}`, status: "pending", currency: "USD",
    reserved_micros: "10", cost_micros: null, tariff_id: "fixture", tariff_date: "2026-10-19" };
  for (const change of [{ prompt: "private" }, { tariff_date: "2026-02-30" }, { currency: { toString: () => "USD" } }, { reserved_micros: "01" }]) {
    assert.throws(() => recorder.recordProviderCost({ ...value, ...change }), error => error.code === "ProviderCostEvidenceInvalid");
  }
  assert.equal(events.length, 0);
  assert.equal(recorder.recordProviderCost(value), true);
  recorder.close(); assert.equal(recorder.recordProviderCost(value), false);
  assert.equal(events.length, 1);
});
