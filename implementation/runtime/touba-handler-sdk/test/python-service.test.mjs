import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const encode = value => value !== null && typeof value === "object"
  ? Array.isArray(value) ? { t: "array", v: value.map(encode) }
    : { t: "object", v: Object.entries(value).map(([key, item]) => [key, encode(item)]) }
  : { t: "value", v: value };

for (const entry of ["../src/python-service.mjs", "../../../cli/touba-project/src/main.mjs"]) {
  test(`Python backend EOF terminates an outstanding HTTP request: ${entry}`, { timeout: 10000 }, async t => {
    let received;
    const reached = new Promise(done => { received = done; });
    const server = createServer(request => { request.resume(); received(); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const child = spawn(process.execPath, [fileURLToPath(new URL(entry, import.meta.url)), ...(entry.includes("main.mjs") ? ["sdk", "service"] : [])], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TOUBA_BACKEND_OFFLINE_KEY: "offline-fixture" },
    });
    t.after(() => child.kill("SIGKILL"));
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    child.stdin.write(JSON.stringify({ id: 1, method: "create", kind: "openai", options: encode({
      model: "fixture-model", history: false, apiKeyEnvNames: ["TOUBA_BACKEND_OFFLINE_KEY"], maxRetries: 0,
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, maxOutputTokens: 64,
    }) }) + "\n");
    const created = JSON.parse((await lines.next()).value);
    assert.equal(created.error, undefined);
    const request = { protocol: "touba-agent-decision-v1", mode: "summary", run_id: "test", invocation_id: "one",
      agent_ref: "agent:service/Worker", step_index: 0, capability_refs: [], agent_signature: { output_type: "builtin:Text" },
      model_input: { protocol: "touba-agent-model-input-v1", agent: { responsibility: "Return a result." },
        user_input: {}, agent_state: {}, decision_policy: {}, output_contract: {} } };
    child.stdin.write(JSON.stringify({ id: 2, method: "call", handle: created.result.v, operation: "invoke", args: encode([request]) }) + "\n");
    await reached;
    const exit = once(child, "close");
    child.stdin.end();
    assert.deepEqual(await exit, [0, null]);
  });
}
