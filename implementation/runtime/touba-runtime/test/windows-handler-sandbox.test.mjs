import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, copyFileSync, linkSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsHandlerSandboxPlan, probeWindowsSandbox, windowsSandboxProbePlan } from "../src/windows-handler-sandbox.mjs";

test("Windows probe materializes code without leasing a hard-linked build executable", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-windows-probe-plan-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launcher = join(root, "supervisor.exe"), alias = join(root, "build-alias.exe");
  copyFileSync(process.execPath, launcher); linkSync(launcher, alias);
  assert.equal(statSync(launcher).nlink, 2);
  const plan = windowsSandboxProbePlan({ launcher, environment: { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" } }, root);
  const policy = JSON.parse(plan.policy);
  assert.equal(plan.command, launcher); assert.notEqual(policy.command, launcher);
  assert.equal(statSync(policy.command).nlink, 1);
  assert.deepEqual(readFileSync(policy.command), readFileSync(launcher));
  assert.deepEqual(policy.code, [policy.command]); assert.deepEqual(policy.args, ["--probe-child"]);
  assert.deepEqual(policy.read, []); assert.deepEqual(policy.write, []);
  assert.equal(policy.network, false); assert.equal(policy.process, false);
  assert.throws(() => windowsSandboxProbePlan({ launcher, environment: {} }, root), { code: "EEXIST" });
});

test("Windows plan sends authority on a private descriptor, with no ambient project grant", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-windows-plan-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "handler.py"), output = join(root, "output");
  writeFileSync(script, "# fixture"); writeFileSync(output, "fixture");
  const binding = { handler: { command: process.execPath, args: [script, "business argument"], cwd: root }, grants: [], sandbox: {} };
  const options = { launcher: process.execPath, environment: { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" } };
  const plan = windowsHandlerSandboxPlan(binding, process.execPath, options), policy = JSON.parse(plan.policy);
  assert.equal(plan.mechanism, "windows-lpac-job"); assert.deepEqual(plan.args, []);
  assert.deepEqual(policy.read, []); assert.deepEqual(policy.write, []);
  assert.equal(policy.network, false); assert.equal(policy.process, false); assert.equal(policy.diagnostic, false);
  assert.ok(!policy.code.includes(root)); assert.equal(policy.args.at(-1), "business argument");
  assert.deepEqual(policy.env_keys, []);
  assert.deepEqual(policy.args.slice(0, 2), ["--preserve-symlinks", "--preserve-symlinks-main"]);
  assert.throws(() => windowsHandlerSandboxPlan({ ...binding, sandbox: { write_paths: [output] } }, process.execPath, options), e => e.code === "HandlerSandboxGrantMissing");
  assert.throws(() => windowsHandlerSandboxPlan({ ...binding, grants: ["network_local"], sandbox: { local_sockets: [output] } }, process.execPath, options), e => e.code === "HandlerSandboxUnsupportedPolicy");
  assert.throws(() => windowsHandlerSandboxPlan({ ...binding, grants: ["filesystem_write"], sandbox: { write_paths: [join(root, "missing")] } }, process.execPath, options), e => e.code === "HandlerSandboxPathInvalid");
  assert.throws(() => windowsHandlerSandboxPlan(binding, process.execPath, { ...options, environment: {} }), e => e.code === "HandlerSandboxEnvironmentInvalid");
  assert.equal(probeWindowsSandbox({ TOUBA_SANDBOX_LAUNCHER: join(root, "missing") }).available, false);
});
