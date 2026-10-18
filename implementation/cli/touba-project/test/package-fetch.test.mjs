import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readPackageBytes } from "../src/package-fetch.mjs";

test("package downloads refuse unencrypted remote URLs and embedded credentials before access", async () => {
  await assert.rejects(readPackageBytes("http://example.invalid/package", 64), { code: "RegistryUrlInvalid" });
  await assert.rejects(readPackageBytes("https://name:password@example.invalid/package", 64), { code: "RegistryUrlInvalid" });
});

test("loopback downloads bound declared and chunked bytes and never follow redirects", async t => {
  let targetCalls = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") return response.writeHead(302, { Location: "/target" }).end();
    if (request.url === "/target") targetCalls++;
    if (request.url === "/declared") return response.writeHead(200, { "Content-Length": 128 }).end("x".repeat(128));
    if (request.url === "/chunked") { response.writeHead(200, { "Transfer-Encoding": "chunked" }); response.write("x".repeat(40)); return response.end("x".repeat(40)); }
    response.end("package bytes");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await readPackageBytes(base, 64)).toString(), "package bytes");
  await assert.rejects(readPackageBytes(base + "/redirect", 64));
  assert.equal(targetCalls, 0);
  await assert.rejects(readPackageBytes(base + "/declared", 64), { code: "PackageTooLarge" });
  await assert.rejects(readPackageBytes(base + "/chunked", 64), { code: "PackageTooLarge" });
});
