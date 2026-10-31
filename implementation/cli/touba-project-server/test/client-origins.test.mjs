import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectClientOrigins, applyProjectCorsHeaders } from "../src/client-origins.mjs";
import { createToubaProjectServer } from "../src/serve.mjs";
import { initProject } from "../../touba-project/src/project.mjs";

test("HTTPS origins are exact, bounded and exclude credentials, wildcards and paths", () => {
  assert.deepEqual([...projectClientOrigins(["https://studio.example", "https://studio.example/", "https://studio.example:8443"])],
    ["https://studio.example", "https://studio.example:8443"]);
  for (const value of [null, "https://studio.example", Array(17).fill("https://studio.example"),
    ["*"], ["https://*.example"], ["https://user:pass@studio.example"], ["http://studio.example"],
    ["https://studio.example/path"], ["https://studio.example?x=1"], ["https://studio.example#x"],
    [" https://client.example"], ["https://studio.example\n"]]) {
    assert.throws(() => projectClientOrigins(value), { code: "ToubaServeClientOriginInvalid" });
  }
});

test("CORS retains local clients and admits only exact configured remote origins", () => {
  const configured = projectClientOrigins(["https://studio.example"]);
  for (const origin of ["https://studio.example", "http://127.0.0.1:5174", "https://[::1]", "tauri://localhost", "http://tauri.localhost"]) {
    const headers = {};
    assert.equal(applyProjectCorsHeaders({ headers: { origin } }, { setHeader: (k, v) => { headers[k] = v; } }, configured), true);
    assert.equal(headers["access-control-allow-origin"], origin);
    assert.equal(headers["access-control-allow-credentials"], undefined);
    assert.equal(headers["access-control-allow-private-network"], undefined);
  }
  for (const origin of [undefined, "null", ["https://studio.example"], "https://studio.example.attacker.test",
    "https://studio.example:8443", "http://studio.example", "https://studio.example/path", "https://studio.example/",
    "http://localhost.attacker.test", "tauri://localhost/path"]) {
    assert.equal(applyProjectCorsHeaders({ headers: { origin } }, { setHeader() { assert.fail("refused origin received CORS headers"); } }, configured), false);
  }
});

test("remote CORS requires authentication and rejects unlisted origins before execution", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-cors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject({ root });
  assert.throws(() => createToubaProjectServer({ projectRoot: root, clientOrigins: ["https://studio.example"] }), { code: "ToubaServeAuthRequired" });
  const tokenName = `TOUBA_CORS_TEST_${process.pid}`;
  process.env[tokenName] = "isolated-cors-test-token";
  t.after(() => { delete process.env[tokenName]; });
  const service = createToubaProjectServer({ projectRoot: root, port: 0, quiet: true,
    authTokenEnv: tokenName, clientOrigins: ["https://studio.example"] });
  await service.start(); t.after(() => service.stop());
  const url = `http://127.0.0.1:${service.server.address().port}/project`;
  const headers = { origin: "https://studio.example" };
  const preflight = await fetch(url, { method: "OPTIONS", headers: { ...headers, "access-control-request-method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), headers.origin);
  assert.equal((await fetch(url, { headers })).status, 401);
  const auth = { ...headers, authorization: `Bearer ${process.env[tokenName]}` };
  assert.equal((await fetch(url, { headers: auth })).status, 200);
  for (const method of ["GET", "POST", "OPTIONS"]) {
    const refused = await fetch(url, { method, headers: { ...auth, origin: "https://unlisted.example" } });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, "ToubaServeCorsOriginRejected");
    assert.equal(refused.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await fetch(url, { headers: { authorization: auth.authorization } })).status, 200, "CLI requests have no Origin");
});
