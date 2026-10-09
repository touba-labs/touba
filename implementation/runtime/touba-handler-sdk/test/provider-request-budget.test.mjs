import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { ToubaAgentDecisionProviderError } from "../src/decision-contract.mjs";
import { providerBudgetFetch, validateProviderRequestBudget } from "../src/provider-request-budget.mjs";

const url = "https://provider.invalid/v1/responses";
const runtimeRequest = (limit) => ({ model_input: { skill_pack_budgets: { model_input_max_bytes: limit } } });

function transport() {
  const calls = [];
  const result = { local_response: true };
  const fetch = (...args) => { calls.push(args); return Promise.resolve(result); };
  return { calls, result, fetch };
}

test("absent budgets preserve the exact configured transport and default undefined", () => {
  const { fetch } = transport();
  assert.equal(providerBudgetFetch({ fetch }), fetch);
  assert.equal(providerBudgetFetch({}), undefined);
  assert.equal(providerBudgetFetch({ fetch, decisionInterface: "structured" }, runtimeRequest(1)), fetch);
  assert.equal(providerBudgetFetch({ fetch, decisionInterface: "native" }, runtimeRequest(null)), fetch);
  assert.equal(providerBudgetFetch({ fetch, decisionInterface: "native" }, {}), fetch);
  assert.equal(validateProviderRequestBudget({}), undefined);
});

test("host byte budgets reject invalid and unsafe values without exposing them", () => {
  for (const value of [null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "PRIVATE_VALUE", {}, () => 10]) {
    assert.throws(() => validateProviderRequestBudget({ maxProviderRequestBytes: value }), (error) =>
      error instanceof ToubaAgentDecisionProviderError && error.code === "InvalidDecisionProviderOptions"
      && !JSON.stringify(error).includes("PRIVATE_VALUE") && !error.message.includes("PRIVATE_VALUE"));
    assert.throws(() => providerBudgetFetch({ maxProviderRequestBytes: value }), (error) => error.code === "InvalidDecisionProviderOptions");
  }
  assert.equal(validateProviderRequestBudget({ maxProviderRequestBytes: 1 }), 1);
  assert.equal(validateProviderRequestBudget({ maxProviderRequestBytes: Number.MAX_SAFE_INTEGER }), Number.MAX_SAFE_INTEGER);
  for (const options of [null, [], "invalid"]) assert.throws(() => validateProviderRequestBudget(options), /options must be an object/);
});

test("string requests at or below the bound forward once with unchanged arguments", async () => {
  const sent = transport();
  const wrapper = providerBudgetFetch({ fetch: sent.fetch, maxProviderRequestBytes: 4 });
  for (const body of ["", "abc", "abcd"]) {
    const init = { method: "POST", body, headers: { "Content-Type": "application/json" } };
    assert.equal(await wrapper(url, init), sent.result);
    assert.equal(sent.calls.at(-1)[0], url);
    assert.equal(sent.calls.at(-1)[1], init);
  }
  assert.equal(sent.calls.length, 3);
});

test("over-budget bodies never reach HTTP and errors contain only byte counts", async () => {
  const sent = transport();
  const body = "DO_NOT_LEAK_PRIVATE_PAYLOAD";
  const wrapper = providerBudgetFetch({ fetch: sent.fetch, maxProviderRequestBytes: 3 });
  await assert.rejects(() => wrapper(url, { body }), (error) => {
    assert.equal(error.code, "ProviderRequestBudgetExceeded");
    assert.deepEqual(error.details, { max_bytes: 3, actual_bytes: Buffer.byteLength(body) });
    assert(!error.message.includes(body));
    assert(!JSON.stringify(error).includes(body));
    return true;
  });
  assert.equal(sent.calls.length, 0);
});

test("UTF-8 encoding rather than JavaScript character count determines the bound", async () => {
  const sent = transport();
  const body = "é🙂";
  assert.equal(body.length, 3);
  assert.equal(Buffer.byteLength(body, "utf8"), 6);
  await assert.rejects(() => providerBudgetFetch({ fetch: sent.fetch, maxProviderRequestBytes: 5 })(url, { body }),
    (error) => error.code === "ProviderRequestBudgetExceeded" && error.details.actual_bytes === 6);
  assert.equal(sent.calls.length, 0);
  await providerBudgetFetch({ fetch: sent.fetch, maxProviderRequestBytes: 6 })(url, { body });
  assert.equal(sent.calls.length, 1);
});

test("Uint8Array views and Buffers count their actual bytes, not the backing buffer", async () => {
  const sent = transport();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4);
  const buffer = Buffer.from([255, 239, 187]);
  const wrapper = providerBudgetFetch({ fetch: sent.fetch, maxProviderRequestBytes: 3 });
  await wrapper(url, { body: bytes });
  await wrapper(url, { body: buffer });
  assert.equal(sent.calls[0][1].body, bytes);
  assert.equal(sent.calls[1][1].body, buffer);
  await assert.rejects(() => wrapper(url, { body: new Uint8Array(4) }), (error) => error.code === "ProviderRequestBudgetExceeded");
  assert.equal(sent.calls.length, 2);
});

test("native mode applies the minimum host/runtime budget and runtime alone", async () => {
  for (const [host, runtime, expected] of [[10, 3, 3], [3, 10, 3], [undefined, 3, 3], [3, null, 3]]) {
    const sent = transport();
    const wrapper = providerBudgetFetch({ fetch: sent.fetch, decisionInterface: "native", maxProviderRequestBytes: host }, runtimeRequest(runtime));
    await assert.rejects(() => wrapper(url, { body: "four" }), (error) =>
      error.code === "ProviderRequestBudgetExceeded" && error.details.max_bytes === expected);
    assert.equal(sent.calls.length, 0);
    await wrapper(url, { body: "abc" });
    assert.equal(sent.calls.length, 1);
  }
  for (const invalid of [0, -1, 0.5, "PRIVATE_RUNTIME_LIMIT", NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => providerBudgetFetch({ decisionInterface: "native" }, runtimeRequest(invalid)), (error) =>
      error.code === "InvalidAgentDecisionRequest" && !error.message.includes("PRIVATE_RUNTIME_LIMIT"));
  }
});

test("bounded default transport uses global fetch once without making an external request", async (t) => {
  const sent = transport();
  t.mock.method(globalThis, "fetch", sent.fetch);
  const wrapper = providerBudgetFetch({ maxProviderRequestBytes: 3 });
  assert.equal(await wrapper(url, { body: "abc" }), sent.result);
  assert.equal(sent.calls.length, 1);
  await assert.rejects(() => wrapper(url, { body: "abcd" }), (error) => error.code === "ProviderRequestBudgetExceeded");
  assert.equal(sent.calls.length, 1);
});

test("Request bodies are measured via a clone without consuming the original", async () => {
  const request = new Request(url, { method: "POST", body: "é🙂" });
  let calls = 0;
  const wrapper = providerBudgetFetch({ maxProviderRequestBytes: 6, fetch: async (input, init) => {
    calls++;
    assert.equal(input, request);
    assert.equal(init, undefined);
    assert.equal(input.bodyUsed, false);
    return input.text();
  } });
  assert.equal(await wrapper(request), "é🙂");
  assert.equal(calls, 1);
  const rejected = new Request(url, { method: "POST", body: "é🙂" });
  await assert.rejects(() => providerBudgetFetch({ maxProviderRequestBytes: 5, fetch: () => assert.fail("no HTTP") })(rejected),
    (error) => error.code === "ProviderRequestBudgetExceeded");
  assert.equal(rejected.bodyUsed, false);
  assert.equal(await rejected.text(), "é🙂");
});

test("Request measurement preserves BOM and invalid-byte lengths exactly", async () => {
  for (const bytes of [new Uint8Array([0xef, 0xbb, 0xbf, 65]), new Uint8Array([0xff, 0xfe])]) {
    const sent = transport();
    const request = new Request(url, { method: "POST", body: bytes });
    await assert.rejects(() => providerBudgetFetch({ maxProviderRequestBytes: bytes.length - 1, fetch: sent.fetch })(request),
      (error) => error.code === "ProviderRequestBudgetExceeded" && error.details.actual_bytes === bytes.length);
    assert.equal(sent.calls.length, 0);
    await providerBudgetFetch({ maxProviderRequestBytes: bytes.length, fetch: sent.fetch })(request);
    assert.equal(sent.calls.length, 1);
    assert.equal(request.bodyUsed, false);
    assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes);
  }
});

test("explicit Request body overrides are measured instead of the inherited body", async () => {
  const sent = transport();
  const request = new Request(url, { method: "POST", body: "large original body" });
  const init = { body: "ok" };
  await providerBudgetFetch({ maxProviderRequestBytes: 2, fetch: sent.fetch })(request, init);
  assert.equal(sent.calls.length, 1);
  assert.equal(sent.calls[0][1], init);
  assert.equal(request.bodyUsed, false);
  await assert.rejects(() => providerBudgetFetch({ maxProviderRequestBytes: 2, fetch: sent.fetch })(request, { body: null }),
    (error) => error.code === "ProviderRequestBudgetExceeded");
  assert.equal(sent.calls.length, 1);
});

test("unavailable or unreadable bodies fail closed without copying unsafe error messages", async () => {
  const sent = transport();
  const wrapper = providerBudgetFetch({ maxProviderRequestBytes: 10, fetch: sent.fetch });
  for (const init of [undefined, {}, { body: null }, { body: {} }, { body: new ArrayBuffer(3) }, { body: new URLSearchParams("a=1") }]) {
    await assert.rejects(() => wrapper(url, init), (error) => error.code === "ProviderRequestBodyUnavailable");
  }
  const consumed = new Request(url, { method: "POST", body: "sample" });
  await consumed.text();
  await assert.rejects(() => wrapper(consumed), (error) => error.code === "ProviderRequestBodyUnavailable");
  const broken = new Request(url, { method: "POST", body: "sample" });
  broken.clone = () => { throw new Error("PRIVATE_BODY_READER_MESSAGE"); };
  await assert.rejects(() => wrapper(broken), (error) => {
    assert.equal(error.code, "ProviderRequestBodyUnavailable");
    assert(!error.message.includes("PRIVATE_BODY_READER_MESSAGE"));
    assert(!JSON.stringify(error).includes("PRIVATE_BODY_READER_MESSAGE"));
    return true;
  });
  assert.equal(sent.calls.length, 0);
});

test("transport failures propagate without retry or a second execution", async () => {
  let calls = 0;
  const failure = new Error("local transport failure");
  const wrapper = providerBudgetFetch({ maxProviderRequestBytes: 3, fetch: async () => { calls++; throw failure; } });
  await assert.rejects(() => wrapper(url, { body: "abc" }), (error) => error === failure);
  assert.equal(calls, 1);
  assert.throws(() => providerBudgetFetch({ maxProviderRequestBytes: 3, fetch: "not a function" }), (error) => error.code === "InvalidDecisionProviderOptions");
});
