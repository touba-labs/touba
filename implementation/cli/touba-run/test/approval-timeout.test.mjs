import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createToubaProjectServer } from "../../touba-project-server/src/serve.mjs";

const run = fileURLToPath(new URL("../src/run.mjs", import.meta.url));
const serve = fileURLToPath(new URL("../../touba-project-server/src/serve.mjs", import.meta.url));
const flag = "--human-approval-authority-timeout-ms";

test("run and serve reject invalid attestation timeouts before loading files", () => {
  for (const command of [run, serve]) for (const value of ["", "0", "60001", "2ms", "1.5", "-1", "Infinity"]) {
    const result = spawnSync(process.execPath, [command, `${flag}=${value}`], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /human-approval-authority-timeout-ms/);
  }
  for (const value of [0, 60001, NaN, "1000"]) {
    assert.throws(() => createToubaProjectServer({ humanApprovalAuthorityTimeoutMs: value }), { code: "ToubaServeHumanApprovalInvalid" });
  }
});

test("run propagates the configured timeout to trusted initiator resolution", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-approval-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "approval.tb"), air = join(root, "approval.air.json"), host = join(root, "host.mjs");
  writeFileSync(source, `module timeout_demo
strategy Run
    gives Text
    do
        human.approve
            with context as "Review"
            with role as "finance"
            with distinct_from as "initiator"
            into approval
        give "accepted"
`);
  writeFileSync(air, execFileSync("cargo", ["run", "--quiet", "--manifest-path",
    fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--", source]));
  writeFileSync(host, `export async function resolveInitiator() {
    await new Promise(resolve => setTimeout(resolve, 80)); return "employee:initiator";
  }
  export function attestHumanApproval() { throw new Error("no decision submitted"); }
`);
  const invoke = value => spawnSync(process.execPath, [run, air, "--entry", "strategy:timeout_demo/Run", "--human-approval-host", host,
    flag, String(value), "--human-checkpoint-out", join(root, `checkpoint-${value}.json`), "--output", "json"], { encoding: "utf8" });
  const refused = invoke(10);
  assert.match(refused.stdout + refused.stderr, /HumanApprovalAuthorityUnavailable/);
  const pending = invoke(1000);
  assert.match(pending.stdout, /human_approval_pending/);
  assert.doesNotMatch(pending.stdout + pending.stderr, /HumanApprovalAuthorityUnavailable/);
});
