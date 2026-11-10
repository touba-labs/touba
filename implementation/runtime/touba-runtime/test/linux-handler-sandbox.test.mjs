import test from "node:test";
import assert from "node:assert/strict";
import { linuxHandlerSeccomp, linuxHandlerSandboxPlan } from "../src/linux-handler-sandbox.mjs";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tiny interpreter for exactly the emitted classic-BPF instructions. These
// tests prove filter construction, not enforcement by a Linux kernel.
function evaluate(filter, nr, flags = 0, arch = 0xc000003e) {
  let accumulator = 0;
  for (let pc = 0; pc < filter.length / 8; pc++) {
    const offset = pc * 8, code = filter.readUInt16LE(offset), yes = filter[offset + 2], no = filter[offset + 3], value = filter.readUInt32LE(offset + 4);
    if (code === 0x20) accumulator = value === 0 ? nr : value === 4 ? arch : value === 16 ? flags : assert.fail("unknown load");
    else if (code === 0x15) pc += accumulator === value ? yes : no;
    else if (code === 0x35) pc += accumulator >= value ? yes : no;
    else if (code === 0x54) accumulator = (accumulator & value) >>> 0;
    else if (code === 0x06) return value;
    else assert.fail("unknown instruction");
  }
  assert.fail("filter fell through");
}

test("seccomp rejects foreign ABIs, namespace escape and non-thread clone without process grant", () => {
  const filter = linuxHandlerSeccomp({ arch: "x64" });
  assert.equal(evaluate(filter, 0), 0x7fff0000);
  for (const nr of [57, 58, 101, 165, 272, 308, 321, 425]) assert.equal(evaluate(filter, nr), 0x50001);
  assert.equal(evaluate(filter, 435), 0x50026);
  assert.equal(evaluate(filter, 41, 1), 0x50001);
  const sockets = linuxHandlerSeccomp({ arch: "x64", localSockets: true });
  assert.equal(evaluate(sockets, 41, 1), 0x7fff0000);
  assert.equal(evaluate(sockets, 41, 2), 0x50001);
  assert.equal(evaluate(sockets, 57), 0x50001);
  assert.equal(evaluate(sockets, 0), 0x7fff0000);
  assert.equal(evaluate(filter, 56, 17), 0x50001);
  assert.equal(evaluate(filter, 56, 0x3d0f00), 0x7fff0000);
  assert.equal(evaluate(filter, 56, 0x103d0f00), 0x50001);
  assert.equal(evaluate(filter, 0, 0, 0x40000003), 0x80000000);
  assert.equal(evaluate(filter, 0x40000000), 0x80000000);
  const processes = linuxHandlerSeccomp({ arch: "x64", processAllowed: true });
  assert.equal(evaluate(processes, 57), 0x7fff0000);
  assert.equal(evaluate(processes, 56, 17), 0x7fff0000);
  assert.equal(evaluate(processes, 56, 0x10000011), 0x50001);
  assert.throws(() => linuxHandlerSeccomp({ arch: "arm64" }), error => error.code === "HandlerSandboxUnsupportedPlatform");
});

test("Linux plan has no blanket project/home mount and refuses nonexistent write targets", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-linux-plan-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "handler.mjs"); writeFileSync(script, "// fixture");
  const binding = { handler: { command: process.execPath, args: [script], cwd: root }, grants: [], sandbox: { required: true } };
  const plan = linuxHandlerSandboxPlan(binding, process.execPath, { bwrap: process.execPath, launcher: process.execPath, arch: "x64", landlockAbi: 3 });
  assert.ok(plan.args.includes("--unshare-net"));
  assert.ok(plan.args.includes("--unshare-user"));
  assert.ok(plan.args.includes("--seccomp"));
  const policy = JSON.parse(plan.policy);
  assert.ok(policy.read_directories.includes(root));
  assert.ok(!policy.read.includes(root));
  for (let i = 0; i < plan.args.length; i++) if (["--bind", "--ro-bind"].includes(plan.args[i])) assert.notEqual(plan.args[i + 1], root);
  assert.throws(() => linuxHandlerSandboxPlan({ ...binding, grants: ["filesystem_write"], sandbox: { write_paths: [join(root, "missing")] } },
    process.execPath, { bwrap: process.execPath, launcher: process.execPath, arch: "x64", landlockAbi: 3 }), error => error.code === "HandlerSandboxPathInvalid");
});

test("Linux plan retains the venv launch alias and separate directory-listing rights", { skip: process.platform === "win32" }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-linux-venv-plan-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, ".venv/bin"), module = join(root, ".venv/lib/python3.14/site-packages/touba_sdk");
  mkdirSync(bin, { recursive: true }); mkdirSync(module, { recursive: true });
  const command = join(bin, "python"), init = join(module, "__init__.py");
  symlinkSync(process.execPath, command); writeFileSync(init, "# synthetic module");
  const binding = { handler: { command, args: ["-c", "pass"], cwd: root }, grants: [], sandbox: { code_paths: [init] } };
  const plan = linuxHandlerSandboxPlan(binding, command, { bwrap: process.execPath, launcher: process.execPath, arch: "x64", landlockAbi: 3 });
  assert.deepEqual(plan.args.slice(-3), [command, "-c", "pass"]);
  assert.ok(plan.args.includes(command));
  const policy = JSON.parse(plan.policy);
  assert.ok(policy.execute.includes(command));
  assert.ok(policy.read.includes(command));
  assert.ok(policy.read_directories.includes(module));
  assert.ok(policy.read_directories.includes(join(module, "..")));
  assert.ok(!policy.read.includes(root));
  assert.ok(!policy.read.includes(module));
  assert.deepEqual(policy.write, ["/dev/null"]);
});
