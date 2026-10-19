import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, symlinkSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createSqliteProviderBudget } from "../src/sqlite-provider-budget.mjs";
import { createProviderCostFetch, createOpenAiDecisionProvider } from "../src/index.mjs";

const quote = (maxCostMicros = 10n) => ({ basis: "upper_bound", maxCostMicros,
  currency: "USD", tariffId: "test-contract", tariffDate: "2026-10-18" });
const hasCode = code => error => error.code === code;
function setup(t, limitMicros = 100n) {
  const dir = mkdtempSync(join(tmpdir(), "touba-cost-test-"));
  const filename = join(dir, "budget.sqlite");
  const config = { filename, budgetId: "business-run", currency: "USD", limitMicros };
  const stores = [];
  const open = (changes = {}) => { const store = createSqliteProviderBudget({ ...config, ...changes }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) { try { store.close(); } catch { /* explicitly closed by a test */ } } rmSync(dir, { recursive: true, force: true }); });
  return { dir, filename, config, open, budget: open() };
}

test("reservations precede calls, reported usage releases only the unused amount", t => {
  const { budget } = setup(t, 15n);
  const id = budget.reserve(quote());
  assert.equal(budget.snapshot().committedMicros, 10n);
  assert.throws(() => budget.reserve(quote()), hasCode("ProviderCostBudgetExceeded"));
  budget.settle(id, { kind: "reported", costMicros: 3n });
  assert.equal(budget.snapshot().remainingMicros, 12n);
  budget.settle(id, { kind: "reported", costMicros: 3n });
  assert.equal(budget.snapshot().committedMicros, 3n);
  assert.throws(() => budget.settle(id, { kind: "reported", costMicros: 0n }), hasCode("ProviderBudgetSettlementConflict"));
  assert.equal(budget.attempt(id).costMicros, 3n);
  budget.reserve(quote());
});

test("unknown and estimated usage retain the bound and allow later evidence", t => {
  const { budget } = setup(t, 20n);
  const unknown = budget.reserve(quote()), estimated = budget.reserve(quote());
  budget.settle(unknown, { kind: "unknown" });
  budget.settle(estimated, { kind: "estimated", costMicros: 1n });
  assert.equal(budget.attempt(unknown).costMicros, null);
  assert.equal(budget.attempt(estimated).costMicros, 1n);
  assert.throws(() => budget.settle(estimated, { kind: "unknown" }), hasCode("ProviderBudgetSettlementConflict"));
  budget.settle(estimated, { kind: "estimated", costMicros: 1n });
  assert.equal(budget.snapshot().remainingMicros, 0n);
  assert.deepEqual(budget.snapshot().attempts, { pending: 0, reported: 0, estimated: 1, unknown: 1 });
  budget.settle(unknown, { kind: "reported", costMicros: 2n });
  assert.equal(budget.snapshot().remainingMicros, 8n);
});

test("a violated upper bound is recorded durably before all new calls are blocked", t => {
  const { budget, open } = setup(t, 20n);
  const id = budget.reserve(quote());
  assert.throws(() => budget.settle(id, { kind: "reported", costMicros: 25n }), hasCode("ProviderCostBoundViolated"));
  assert.equal(budget.attempt(id).costMicros, 25n);
  assert.equal(budget.snapshot().committedMicros, 25n);
  assert.equal(budget.snapshot().remainingMicros, 0n);
  assert.equal(open().snapshot().blocked, true);
  assert.throws(() => open().reserve(quote(0n)), hasCode("ProviderBudgetBlocked"));
});

test("restart preserves pending calls, tightening propagates, reopening never increases the cap", t => {
  const { budget, open } = setup(t);
  const id = budget.reserve(quote(40n));
  const second = open({ limitMicros: 45n });
  assert.equal(budget.snapshot().limitMicros, 45n);
  assert.throws(() => budget.reserve(quote()), hasCode("ProviderCostBudgetExceeded"));
  assert.equal(open({ limitMicros: 1000n }).snapshot().limitMicros, 45n);
  assert.equal(second.attempt(id).status, "pending");
  assert.throws(() => open({ currency: "EUR" }), hasCode("ProviderBudgetMismatch"));
  assert.throws(() => open({ budgetId: "other" }).settle(id, { kind: "reported", costMicros: 0n }), hasCode("ProviderBudgetAttemptUnknown"));
});

test("micro-units remain exact above both JS safe integers and SQLite int64", t => {
  const huge = 10n ** 30n, { budget } = setup(t, huge);
  const id = budget.reserve(quote(huge - 1n));
  assert.equal(budget.snapshot().remainingMicros, 1n);
  budget.settle(id, { kind: "reported", costMicros: huge - 3n });
  assert.equal(budget.snapshot().remainingMicros, 3n);
});

test("attempts can be recovered after restart with bounded pagination and scope isolation", t => {
  const { budget, open } = setup(t);
  const ids = Array.from({ length: 5 }, () => budget.reserve(quote()));
  budget.settle(ids[0], { kind: "unknown" });
  const first = open().listAttempts({ limit: 2 });
  const second = open().listAttempts({ afterId: first.at(-1).id, limit: 3 });
  assert.deepEqual([...first, ...second].map(row => row.id), ids.sort());
  assert.equal(open().listAttempts({ status: "pending" }).length, 4);
  assert.equal(open({ budgetId: "another" }).listAttempts().length, 0);
  for (const options of [{ limit: 1001 }, { limit: 0 }, { afterId: 12 }, { status: "PRIVATE" }]) {
    assert.throws(() => budget.listAttempts(options), hasCode("InvalidProviderBudgetOptions"));
  }
});

test("invalid bounds and usage cannot mutate the ledger or leak supplied values", t => {
  const { budget, config } = setup(t);
  for (const change of [{ basis: "estimate" }, { maxCostMicros: 1 }, { maxCostMicros: -1n }, { currency: "EUR" },
    { tariffDate: "2026-02-30" }, { tariffId: "secret token" }, { tariffDate: "PRIVATE" }]) {
    assert.throws(() => budget.reserve({ ...quote(), ...change }), hasCode("ProviderCostBoundUnavailable"));
  }
  for (const limitMicros of [null, 1, -1n, "1", NaN]) assert.throws(() => createSqliteProviderBudget({ ...config, limitMicros }), hasCode("InvalidProviderBudgetOptions"));
  assert.equal(budget.snapshot().committedMicros, 0n);
  const id = budget.reserve(quote());
  for (const usage of [null, {}, { kind: "unknown", costMicros: 0n }, { kind: "reported", costMicros: 1 }, { kind: "estimated", costMicros: -1n }]) {
    assert.throws(() => budget.settle(id, usage), hasCode("ProviderCostUsageInvalid"));
  }
  assert.equal(budget.attempt(id).status, "pending");
});

test("storage is private and linked paths are refused", t => {
  const { config, filename, dir } = setup(t);
  if (process.platform !== "win32") {
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    const link = join(dir, "alias.sqlite");
    symlinkSync(filename, link);
    assert.throws(() => createSqliteProviderBudget({ ...config, filename: link }), hasCode("ProviderBudgetStorageUnsafe"));
  }
  assert.throws(() => createSqliteProviderBudget({ ...config, filename: ":memory:" }), hasCode("InvalidProviderBudgetOptions"));
});

async function server(t, handler) {
  const http = createServer(handler);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  return `http://127.0.0.1:${http.address().port}/generate`;
}
const requestInit = { method: "POST", headers: { "content-type": "application/json", authorization: "PRIVATE_SECRET" }, body: JSON.stringify({ input: "PRIVATE_PROMPT", max_output_tokens: 10 }) };

test("real HTTP response stays readable and only accounting metadata reaches SQLite", async t => {
  const { budget, filename } = setup(t);
  const url = await server(t, (req, res) => { assert.equal(budget.snapshot().committedMicros, 10n); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ output: "PRIVATE_RESPONSE", cost: 3 })); });
  const transport = createProviderCostFetch({ budget, quote: async request => {
    assert.equal((await request.json()).max_output_tokens, 10); request.headers.set("authorization", "changed-copy");
    return { ...quote(), secret: "PRIVATE_SECRET" };
  }, readUsage: async response => ({ kind: "reported", costMicros: BigInt((await response.json()).cost) }) });
  const response = await transport(url, requestInit);
  assert.equal((await response.json()).output, "PRIVATE_RESPONSE");
  assert.equal(budget.snapshot().committedMicros, 3n);
  for (const secret of ["PRIVATE_SECRET", "PRIVATE_PROMPT", "PRIVATE_RESPONSE"]) assert.equal(readFileSync(filename).includes(Buffer.from(secret)), false);
});

test("HTTP retries consume separate reservations and stop before a third request", async t => {
  const { budget } = setup(t, 20n);
  let sent = 0;
  const url = await server(t, (_req, res) => { sent++; res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); });
  const transport = createProviderCostFetch({ budget, quote: () => quote(), readUsage: () => ({ kind: "unknown" }) });
  assert.equal((await transport(url, requestInit)).status, 503);
  assert.equal((await transport(url, requestInit)).status, 503);
  await assert.rejects(transport(url, requestInit), hasCode("ProviderCostBudgetExceeded"));
  assert.equal(sent, 2);
  assert.equal(budget.snapshot().attempts.unknown, 2);
});

test("installed AI SDK retry traverses the monetary guard before each real HTTP attempt", { timeout: 15000 }, async t => {
  const { budget } = setup(t, 20n);
  let sent = 0;
  const url = await server(t, async (req, res) => {
    sent++;
    let data = ""; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    assert.equal(body.max_output_tokens, 64);
    res.setHeader("content-type", "application/json");
    if (sent === 1) { res.writeHead(503, { "retry-after": "0" }); res.end(JSON.stringify({ error: { message: "retry fixture", type: "server_error" } })); return; }
    res.end(JSON.stringify({ id: "resp_fixture", created_at: 1, model: "fixture-model", status: "completed",
      output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [],
        text: JSON.stringify({ decision: { action: "answer_directly", source: "cost_test", reason: "The requested result is available.", result: "done" } }) }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }));
  });
  const envName = "TOUBA_COST_TEST_KEY", previous = process.env[envName];
  process.env[envName] = "offline-not-a-real-credential";
  t.after(() => { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; });
  const transport = createProviderCostFetch({ budget, quote: async request => {
    assert.equal((await request.json()).max_output_tokens, 64); return quote();
  }, readUsage: async response => {
    const usage = (await response.json()).usage;
    // Deliberate unit tariff of one micro-unit per token, for this test only.
    return usage ? { kind: "reported", costMicros: BigInt(usage.input_tokens + usage.output_tokens) } : { kind: "unknown" };
  } });
  const provider = createOpenAiDecisionProvider({ history: false, model: "fixture-model", apiKeyEnvNames: [envName],
    baseURL: new URL("/v1", url).href, source: "cost_test", maxOutputTokens: 64, maxRetries: 1, fetch: transport });
  const request = { protocol: "touba-agent-decision-v1", mode: "summary", agent_ref: "agent:cost/Worker", capability_refs: [],
    agent_signature: { output_type: "builtin:Text" },
    model_input: { protocol: "touba-agent-model-input-v1", agent: { responsibility: "Return the supplied result." },
      user_input: { value: "done" }, agent_state: {}, decision_policy: {}, output_contract: {} } };
  assert.equal((await provider(request)).result, "done");
  assert.equal(sent, 2);
  assert.equal(budget.snapshot().committedMicros, 13n);
  assert.deepEqual(budget.snapshot().attempts, { pending: 0, reported: 1, estimated: 0, unknown: 1 });
  await assert.rejects(provider(request)); // Only seven units remain: no third dispatch.
  assert.equal(sent, 2);
});

test("redirects cannot send hidden requests and network failure retains the bound", async t => {
  const { budget } = setup(t);
  let sent = 0;
  const url = await server(t, (_req, res) => { sent++; res.writeHead(307, { location: "/another" }); res.end(); });
  const transport = createProviderCostFetch({ budget, quote: () => quote(), readUsage: () => assert.fail("no usage on transport error") });
  await assert.rejects(transport(url, requestInit), hasCode("ProviderTransportFailed"));
  assert.equal(sent, 1);
  assert.equal(budget.snapshot().committedMicros, 10n);
  assert.equal(budget.snapshot().attempts.unknown, 1);
});

test("preflight failure and prior cancellation send nothing, unknown is never zero", async t => {
  const { budget } = setup(t);
  let calls = 0;
  const transport = createProviderCostFetch({ budget, quote: () => { throw new Error("PRIVATE"); }, readUsage: () => ({}), fetch: () => { calls++; } });
  await assert.rejects(transport("https://provider.invalid", requestInit), hasCode("ProviderCostBoundUnavailable"));
  await assert.rejects(transport("https://provider.invalid", { ...requestInit, signal: AbortSignal.abort("PRIVATE") }), hasCode("ProviderRequestAborted"));
  assert.equal(calls, 0);
  assert.equal(budget.snapshot().committedMicros, 0n);
});

test("cancellation after dispatch and usage decoding/timeout failures hold their reservation", async t => {
  const { budget } = setup(t);
  for (const readUsage of [() => { throw new Error("PRIVATE"); }, () => new Promise(() => {}), () => ({ kind: "reported", costMicros: -1n })]) {
    const transport = createProviderCostFetch({ budget, quote: () => quote(), readUsage, usageTimeoutMs: 10,
      fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) });
    assert.equal((await transport("https://provider.invalid", requestInit)).status, 200);
  }
  assert.equal(budget.snapshot().committedMicros, 30n);
  const controller = new AbortController();
  const transport = createProviderCostFetch({ budget, quote: () => quote(), readUsage: () => ({}), fetch: async () => {
    controller.abort(); throw new Error("PRIVATE");
  } });
  await assert.rejects(transport("https://provider.invalid", { ...requestInit, signal: controller.signal }), hasCode("ProviderTransportFailed"));
  assert.equal(budget.snapshot().committedMicros, 40n);
});

test("multiple simultaneous HTTP calls cannot oversubscribe a budget", async t => {
  const { budget } = setup(t, 25n);
  let sent = 0;
  const url = await server(t, (_req, res) => { sent++; res.setHeader("content-type", "application/json"); res.end("{}"); });
  const transport = createProviderCostFetch({ budget, quote: () => quote(), readUsage: () => ({ kind: "unknown" }) });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => transport(url, requestInit)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
  assert.equal(sent, 2);
  assert.equal(budget.snapshot().committedMicros, 20n);
});

function child(config, count = 1) {
  const moduleUrl = new URL("../src/sqlite-provider-budget.mjs", import.meta.url).href;
  const code = `import { createSqliteProviderBudget } from ${JSON.stringify(moduleUrl)};
    const b = createSqliteProviderBudget({filename:process.argv[1],budgetId:"business-run",currency:"USD",limitMicros:100n});
    let n=0; for(let i=0;i<${count};i++) { try { b.reserve({basis:"upper_bound",maxCostMicros:10n,currency:"USD",tariffId:"test",tariffDate:"2026-10-18"}); n++; }
    catch(e) { if(e.code!=="ProviderCostBudgetExceeded") throw e; } }
    process.stdout.write(String(n)); process.exit(0);`;
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, ["--input-type=module", "-e", code, config.filename], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    worker.stdout.on("data", data => { output += data; }); worker.stderr.on("data", data => { errors += data; });
    worker.on("error", reject); worker.on("exit", status => status === 0 ? resolve(Number(output)) : reject(new Error(errors)));
  });
}

test("independent processes serialize reservations and abrupt exit never frees them", async t => {
  const { budget, config, open } = setup(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => child(config, 10)));
  assert.equal(results.reduce((sum, n) => sum + n, 0), 10);
  assert.equal(budget.snapshot().committedMicros, 100n);
  assert.equal(open().snapshot().attempts.pending, 10);
  assert.throws(() => open().reserve(quote(1n)), hasCode("ProviderCostBudgetExceeded"));
});

test("worker killed after real HTTP dispatch leaves a discoverable durable reservation", { timeout: 15000 }, async t => {
  const { budget, config, open } = setup(t, 10n);
  let received;
  const arrival = new Promise(resolve => { received = resolve; });
  const url = await server(t, () => received()); // Intentionally no response before the crash.
  const ledgerUrl = new URL("../src/sqlite-provider-budget.mjs", import.meta.url).href;
  const fetchUrl = new URL("../src/provider-cost.mjs", import.meta.url).href;
  const script = `import {createSqliteProviderBudget} from ${JSON.stringify(ledgerUrl)};
    import {createProviderCostFetch} from ${JSON.stringify(fetchUrl)};
    const budget=createSqliteProviderBudget({filename:process.argv[1],budgetId:"business-run",currency:"USD",limitMicros:10n});
    const transport=createProviderCostFetch({budget,quote:()=>({basis:"upper_bound",maxCostMicros:10n,currency:"USD",tariffId:"test",tariffDate:"2026-10-18"}),readUsage:()=>({kind:"unknown"})});
    await transport(process.argv[2],{method:"POST",body:"request"});`;
  const worker = spawn(process.execPath, ["--input-type=module", "-e", script, config.filename, url], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
  const exited = once(worker, "exit");
  await Promise.race([arrival, exited.then(() => { throw new Error("worker exited before dispatch"); })]);
  worker.kill("SIGKILL");
  await exited;
  const pending = open().listAttempts({ status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(budget.snapshot().committedMicros, 10n);
  assert.throws(() => open().reserve(quote(1n)), hasCode("ProviderCostBudgetExceeded"));
  // Explicit provider evidence can reconcile later; a restart alone could not.
  budget.settle(pending[0].id, { kind: "reported", costMicros: 4n });
  assert.equal(open().snapshot().remainingMicros, 6n);
});
