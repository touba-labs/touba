import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { linuxHandlerSandboxPlan, probeLinuxSandbox } from "../src/linux-handler-sandbox.mjs";
import { runProcessToolHandler } from "../src/handler-protocol.mjs";

const nativeOnly = { skip: process.platform !== "linux" || !process.env.TOUBA_TEST_SANDBOX_LAUNCHER };
const sandboxEnv = () => ({ TOUBA_BWRAP_COMMAND: process.env.TOUBA_TEST_BWRAP,
  TOUBA_SANDBOX_LAUNCHER: process.env.TOUBA_TEST_SANDBOX_LAUNCHER });

// Explicit native qualification, never inferred from a BPF simulation or the
// presence of a binary. Every canary belongs to this temporary fixture.
test("native Linux enforces read/write separation, descendants, symlinks and sockets", {
  skip: process.platform !== "linux" || !process.env.TOUBA_TEST_SANDBOX_LAUNCHER,
}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-linux-scopes-")));
  assert.equal(probeLinuxSandbox({ TOUBA_BWRAP_COMMAND: process.env.TOUBA_TEST_BWRAP,
    TOUBA_SANDBOX_LAUNCHER: process.env.TOUBA_TEST_SANDBOX_LAUNCHER }).available, true);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allowed = join(root, "allowed"), output = join(root, "output"), canary = join(root, "private.txt");
  mkdirSync(allowed); mkdirSync(output); writeFileSync(canary, "isolated-canary");
  writeFileSync(join(output, "existing.txt"), "write-is-not-read");
  symlinkSync(canary, join(allowed, "link.txt"));
  const tcp = createServer(socket => socket.end()), unix = createServer(socket => socket.end());
  await new Promise(done => tcp.listen(0, "127.0.0.1", done));
  const socketPath = join(allowed, "undeclared.sock");
  await new Promise(done => unix.listen(socketPath, done));
  t.after(async () => Promise.all([tcp, unix].map(server => new Promise(done => server.close(done)))));
  const script = join(root, "handler.mjs");
  writeFileSync(script, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process'; import net from 'node:net';
const safe = action => { try { action(); return true; } catch { return false; } };
const connect = options => new Promise(done=>{const s=net.createConnection(options);const end=v=>{s.destroy();done(v)};s.once('connect',()=>end(true));s.once('error',()=>end(false));s.setTimeout(300,()=>end(false));});
const child=spawnSync(process.execPath,['-e', 'try { require("node:fs").readFileSync('+JSON.stringify(${JSON.stringify(canary)})+'); process.exit(0); } catch { process.exit(7); }']);
console.log(JSON.stringify({read:safe(()=>fs.readFileSync(${JSON.stringify(canary)})),linked:safe(()=>fs.readFileSync(${JSON.stringify(join(allowed, "link.txt"))})),
readOutput:safe(()=>fs.readFileSync(${JSON.stringify(join(output, "existing.txt"))})),write:safe(()=>fs.writeFileSync(${JSON.stringify(join(output, "new.txt"))},'fixture')),
child:child.status,childDenied:!!child.error,tcp:await connect({host:'localhost',family:4,port:${tcp.address().port}}),unix:await connect({path:${JSON.stringify(socketPath)}})}));`);
  const run = async (grants, sandbox) => {
    const plan = linuxHandlerSandboxPlan({ handler: { command: process.execPath, args: [script], cwd: root }, grants, sandbox }, process.execPath,
      { bwrap: process.env.TOUBA_TEST_BWRAP, launcher: process.env.TOUBA_TEST_SANDBOX_LAUNCHER });
    const child = spawn(plan.command, plan.args, { cwd: root, env: {}, stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "pipe"] });
    child.stdio[4].on("error", () => {}); child.stdio[4].end(plan.seccomp);
    child.stdio[5].on("error", () => {}); child.stdio[5].end(plan.policy);
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 65536) child.kill("SIGKILL"); });
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 65536) child.kill("SIGKILL"); });
    const code = await new Promise((done, reject) => { child.on("close", done); child.on("error", reject); });
    clearTimeout(timer);
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };
  assert.deepEqual(await run([], {}), { read: false, linked: false, readOutput: false, write: false, child: null, childDenied: true, tcp: false, unix: false });
  const writer = await run(["filesystem_write"], { write_paths: [output] });
  assert.equal(writer.write, true); assert.equal(writer.readOutput, false); assert.equal(writer.read, false);
  const child = await run(["filesystem_read", "process"], { read_paths: [allowed] });
  assert.equal(child.child, 7); assert.equal(child.childDenied, false); assert.equal(child.linked, false); assert.equal(child.unix, false);
  const reader = await run(["filesystem_read"], { read_paths: [canary, output] });
  assert.equal(reader.read, true); assert.equal(reader.readOutput, true); assert.equal(reader.write, false);
  const network = await run(["network"], {});
  assert.equal(network.tcp, true); assert.equal(network.read, false);
  const probe = JSON.parse(spawnSync(process.env.TOUBA_TEST_SANDBOX_LAUNCHER, ["--probe"], { encoding: "utf8" }).stdout);
  if (probe.landlock_abi < 9) {
    await assert.rejects(run(["network_local"], { local_sockets: [socketPath] }),
      error => error.code === "HandlerSandboxUnsupportedPolicy");
  }
});

test("native Linux handler protocol runs Python with scoped reads and a closed environment", nativeOnly, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-linux-python-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const code = join(root, "handler.py"), canary = join(root, "private.txt");
  writeFileSync(canary, "isolated-python-canary");
  writeFileSync(code, `import json, os, sys
request = json.load(sys.stdin)
try:
    with open(${JSON.stringify(canary)}, encoding="utf-8") as source:
        content = source.read()
except OSError:
    content = None
print(json.dumps({"ok": True, "value": {"content": content, "input": request["arguments"], "env": dict(os.environ)}}))
`);
  const run = read => runProcessToolHandler({ toolRef: "tool:isolated/Python", secretHandles: [], secretStore: undefined,
    env: sandboxEnv(), request: { arguments: { message: "hello" } }, binding: {
      handler: { command: "/usr/bin/python3", args: [code], cwd: root },
      limits: { timeout_ms: 3000, max_payload_bytes: 65536 }, grants: read ? ["filesystem_read"] : [],
      sandbox: { required: true, ...(read ? { read_paths: [canary] } : {}) },
    } });
  const denied = (await run(false)).value, allowed = (await run(true)).value;
  assert.equal(denied.content, null);
  assert.equal(allowed.content, "isolated-python-canary");
  assert.deepEqual(allowed.input, { message: "hello" });
  // Bubblewrap supplies the selected cwd and Python may coerce its locale.
  // Neither is inherited host configuration or authority.
  assert.equal(allowed.env.PWD, root);
  assert.deepEqual(Object.keys(allowed.env).filter(name => !["LC_CTYPE", "PWD"].includes(name)), []);
});

test("native Linux handler timeout tears down detached descendants before returning", nativeOnly, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-linux-timeout-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "output"), code = join(root, "handler.mjs");
  mkdirSync(output);
  const heartbeat = join(output, "heartbeat.txt");
  writeFileSync(heartbeat, "");
  const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`;
  writeFileSync(code, `import {spawn} from 'node:child_process';
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});
child.unref(); setInterval(()=>{},100);
`);
  await assert.rejects(runProcessToolHandler({ toolRef: "tool:isolated/Timeout", secretHandles: [], secretStore: undefined,
    request: { arguments: {} }, env: sandboxEnv(), binding: {
      handler: { command: process.execPath, args: [code], cwd: root }, grants: ["process", "filesystem_write"],
      limits: { timeout_ms: 800, max_payload_bytes: 65536 }, sandbox: { required: true, write_paths: [output] },
    } }), error => error.code === "ToolHandlerTimeout");
  const stopped = readFileSync(heartbeat, "utf8");
  assert.ok(stopped.length > 0, "the descendant must actually run before timeout");
  await new Promise(done => setTimeout(done, 250));
  assert.equal(readFileSync(heartbeat, "utf8"), stopped, "no descendant effect may occur after timeout returns");
});
