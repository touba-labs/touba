import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { deploymentTargetRequest } from "../src/index.mjs";

const token = "isolated-target-test-token-32-characters";

test("a scoped mutation refuses an older target before sending any write", async () => {
  const requests = [];
  await assert.rejects(deploymentTargetRequest({ targetUrl: "http://127.0.0.1", token,
    path: "/revisions", method: "POST", body: { bundle: {} }, projectScope: "a".repeat(64),
    fetchImpl: async (url, options) => {
      requests.push(options.method);
      return new Response('{"status":"ready"}', { status: 200 });
    },
  }), { code: "ToubaDeploymentProjectScopeUnsupported" });
  assert.deepEqual(requests, ["GET"]);
});

test("target requests keep credentials on their configured HTTP(S) origin", async () => {
  for (const [targetUrl, path, code] of [
    ["http://example.test", "/revisions", "ToubaDeploymentInsecureTargetRejected"],
    ["ftp://127.0.0.1", "/revisions", "ToubaDeploymentInsecureTargetRejected"],
    ["https://user:pass@example.test", "/revisions", "ToubaDeploymentInsecureTargetRejected"],
    ["https://example.test", "https://elsewhere.test/revisions", "ToubaDeploymentTargetPathInvalid"],
    ["https://example.test", "//elsewhere.test/revisions", "ToubaDeploymentTargetPathInvalid"],
  ]) {
    await assert.rejects(deploymentTargetRequest({ targetUrl, path, token,
      fetchImpl: () => assert.fail("invalid target must not be called") }), { code });
  }
});

test("target response size, headers, body deadlines and redirect refusal are enforced without retries", async t => {
  let reads = 0, mutations = 0;
  const server = createServer((request, response) => {
    reads++;
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === "/headers") return; // Timeout before headers.
    if (request.url === "/redirect") { response.writeHead(302, { location: "/ok" }); response.end(); return; }
    if (request.url === "/large-header") { response.writeHead(200, { "content-length": "1000" }); response.end("{}"); return; }
    response.writeHead(request.url === "/conflict" ? 409 : 200, { "content-type": "application/json" });
    if (request.url === "/body") { mutations++; response.write('{"pending":'); return; }
    if (request.url === "/large-stream") { response.write('"'); response.end("x".repeat(1000)); return; }
    if (request.url === "/malformed") { response.end("not JSON"); return; }
    response.end(JSON.stringify(request.url === "/conflict"
      ? { code: "ToubaDeploymentStateConflict", message: "Target changed" } : { status: "ready" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const targetUrl = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => deploymentTargetRequest({ targetUrl, token, path, timeoutMs: 300, maxResponseBytes: 512, ...options });
  assert.deepEqual(await call("/ok"), { status: "ready" });
  await assert.rejects(call("/headers"), { code: "ToubaDeploymentTargetTimeout" });
  await assert.rejects(call("/body", { method: "POST", body: {} }), { code: "ToubaDeploymentTargetTimeout" });
  assert.equal(mutations, 1, "a timed out mutation must never be retried");
  for (const path of ["/large-header", "/large-stream", "/malformed"]) {
    await assert.rejects(call(path), { code: "ToubaDeploymentTargetResponseInvalid" });
  }
  await assert.rejects(call("/redirect"), { code: "ToubaDeploymentTargetUnavailable" });
  await assert.rejects(call("/conflict"), { code: "ToubaDeploymentStateConflict" });
  assert.equal(reads, 8, "one request per operation, no followed redirect");
});
