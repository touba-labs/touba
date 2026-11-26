import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

test("OS ENOSPC preserves records and traces, refuses dispatch, and recovers after space is released", { timeout: 60000 }, t => {
  const name = `touba-storage-qa-${randomUUID()}`;
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const image = "node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530";
  const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    // A timed-out child must not leave the isolated container running.
    try { docker(["rm", "--force", name]); } catch { /* --rm already removed it */ }
  });
  const output = docker(["run", "--rm", "--pull", "never", "--name", name,
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "1000:1000", "--memory", "256m", "--cpus", "0.5", "--pids-limit", "64",
    "--tmpfs", "/state:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=1000,gid=1000",
    "--mount", `type=bind,source=${source},target=/source,readonly`, image,
    "node", "--max-old-space-size=128", "/source/tests/storage-qualification/disk-full.mjs"]);
  const result = JSON.parse(output);
  assert.equal(result.recordsRollback, true); assert.equal(result.traceIntegrity, true);
  assert.equal(result.refusedEffects, 1); assert.equal(result.recoveredEffects, 1);
  t.diagnostic(JSON.stringify(result));
});
