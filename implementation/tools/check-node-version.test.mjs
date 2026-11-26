import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("./check-node-version.mjs", import.meta.url));
for (const [version, allowed] of [
  ["22.23.4", false], ["24.15.0", false], ["24.22.0", false],
  ["24.22.1", false], ["24.22.2", false], ["24.22.3", true], ["24.23.0", true], ["25.0.0", false],
]) {
  test(`Node security baseline: ${version} is ${allowed ? "accepted" : "refused"}`, () => {
    const setup = `Object.defineProperty(process.versions, 'node', {value: '${version}'});`;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(setup)}`, checker], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, allowed ? 0 : 1, result.stderr);
    if (!allowed) assert.match(result.stderr, /Node\.js >=24\.22\.3 <25 is required/);
  });
}
