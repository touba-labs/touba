import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { runProcessToolHandler, buildHandlerSandboxPlan } from "../src/handler-protocol.mjs";
import { spawnSync } from "node:child_process";

test("macOS enforces file scopes, inherited child restrictions and separate Unix sockets", { skip: process.platform !== "darwin" }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tb-sb-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const code = join(root, "handler.mjs"), canary = join(root, "private.txt"), output = join(root, "out.txt");
  const allowed = join(root, "allowed"); mkdirSync(allowed);
  symlinkSync(canary, join(allowed, "linked.txt")); writeFileSync(canary, "isolated-canary");
  const tcp = createServer(socket => socket.end());
  const unix = createServer(socket => socket.end());
  await new Promise(resolve => tcp.listen(0, "127.0.0.1", resolve));
  const socketPath = join(root, "service.sock");
  await new Promise(resolve => unix.listen(socketPath, resolve));
  t.after(async () => { await Promise.all([tcp, unix].map(server => new Promise(resolve => server.close(resolve)))); });
  writeFileSync(code, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process'; import net from 'node:net';
let request=''; for await(const chunk of process.stdin) request+=chunk;
const safe = fn => { try { fn(); return true; } catch { return false; } };
const connect = options => new Promise(resolve => { const s=net.createConnection(options); const done=v=>{s.destroy();resolve(v)};s.once('connect',()=>done(true));s.once('error',()=>done(false));s.setTimeout(500,()=>done(false)); });
const child=spawnSync(process.execPath,['-e', 'try { require("node:fs").readFileSync('+JSON.stringify(${JSON.stringify(canary)})+'); process.exit(0); } catch { process.exit(7); }']);
process.stdout.write(JSON.stringify({ok:true,value:{
cwd:process.cwd(),
read:safe(()=>fs.readFileSync(${JSON.stringify(canary)})),
linked:safe(()=>fs.readFileSync(${JSON.stringify(join(allowed, "linked.txt"))})),
write:safe(()=>fs.writeFileSync(${JSON.stringify(output)},'canary')),
child:child.status, childDenied:!!child.error,
tcp:await connect({host:'127.0.0.1',port:${tcp.address().port}}),
unix:await connect({path:${JSON.stringify(socketPath)}})
}}));`);
  const run = async (grants, sandbox) => {
    const binding = { handler: { command: process.execPath, args: [code], cwd: root }, grants,
      limits: { timeout_ms: 4000, max_payload_bytes: 65536 }, sandbox: { required: true, ...sandbox } };
    return await runProcessToolHandler({ toolRef: "tool:isolated/Probe", secretHandles: [], secretStore: undefined, request: { arguments: {} }, binding });
  };
  const denied = (await run([], {})).value;
  assert.deepEqual(denied, { cwd: root, read: false, linked: false, write: false, child: null, childDenied: true, tcp: false, unix: false });
  const processAllowed = (await run(["process", "filesystem_read", "network_local"], { read_paths: [allowed], local_sockets: [socketPath] })).value;
  assert.deepEqual(processAllowed, { cwd: root, read: false, linked: false, write: false, child: 7, childDenied: false, tcp: false, unix: true });
  const permitted = (await run(["filesystem_read", "filesystem_write"], { read_paths: [canary], write_paths: [output] })).value;
  assert.equal(permitted.read, true); assert.equal(permitted.write, true);
  assert.equal(permitted.tcp, false); assert.equal(permitted.unix, false);
  const networkAllowed = (await run(["network"], {})).value;
  assert.equal(networkAllowed.tcp, true); assert.equal(networkAllowed.read, false);
  const relative = (await run(["filesystem_read"], { read_paths: ["allowed/../private.txt"] })).value;
  assert.equal(relative.read, true);
  await assert.rejects(run([], { read_paths: [canary] }), error => error.code === "HandlerSandboxGrantMissing");
  await assert.rejects(run([], { code_paths: [allowed] }), error => error.code === "HandlerSandboxPathInvalid");
  await assert.rejects(run([], { code_paths: [join(root, "missing.mjs")] }), error => error.code === "HandlerSandboxPathInvalid");
});

test("macOS package Python handler starts, refuses project files and network, then allows exact grants", { skip: process.platform !== "darwin" }, async t => {
  // Inventory a trusted local interpreter, never a package-supplied executable.
  // Individual runtime files are code_paths; no project directory is granted.
  const probe = spawnSync(process.env.TOUBA_TEST_SANDBOX_PYTHON ?? "/usr/bin/python3", ["-B", "-c", `import json,os,sys
files=[]
for root,dirs,names in os.walk(sys.base_prefix):
 dirs[:]=[d for d in dirs if d not in ('site-packages','__pycache__','test','tests')]
 for name in names:
  p=os.path.realpath(os.path.join(root,name))
  if name.endswith(('.py','.so','.dylib','.zip')) or name in ('Python','Python3','pyvenv.cfg'):
   files.append(p)
native=os.path.join(sys.base_prefix,'Resources/Python.app/Contents/MacOS/Python')
print(json.dumps({'command':os.path.realpath(native if os.path.isfile(native) else sys.executable),'files':sorted(set(files))}))`], { encoding: "utf8", timeout: 15000 });
  assert.equal(probe.status, 0, probe.stderr);
  const interpreter = JSON.parse(probe.stdout);
  assert.ok(interpreter.files.length > 0 && interpreter.files.length < 4096);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tb-package-python-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "packages/example.reader/handlers"); mkdirSync(directory, { recursive: true });
  const code = join(directory, "reader.py"), secret = join(root, "app.env");
  writeFileSync(secret, "synthetic-private-value");
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(code, `import json,sys,socket,os
from pathlib import Path
request=json.load(sys.stdin)
try:
 with open(${JSON.stringify(secret)}) as f: content=f.read()
except OSError: content=None
try:
 s=socket.create_connection(('127.0.0.1',${server.address().port}),timeout=1); s.close(); network=True
except OSError: network=False
print(json.dumps({'ok':True,'value':{'started':True,'cwd':str(Path.cwd()),'content':content,'network':network,'secret_env':os.getenv('TOUBA_SYNTHETIC_SECRET')}}))
`);
  const run = async (grants, read_paths = []) => {
    const input = { toolRef: "tool:example.reader/Read", secretHandles: [], secretStore: undefined,
    request: { arguments: {} }, env: { ...process.env, TOUBA_SYNTHETIC_SECRET: "private-env-test" }, binding: {
      handler: { command: interpreter.command, args: ["-B", code], cwd: root }, grants,
      limits: { timeout_ms: 10000, max_payload_bytes: 65536 },
      sandbox: { required: true, code_paths: interpreter.files, read_paths },
    } };
    // Synthetic fixture only: make interpreter startup failures actionable.
    const plan = buildHandlerSandboxPlan({ binding: input.binding });
    const startup = spawnSync(plan.command, plan.args, { cwd: root, env: { PYTHONDONTWRITEBYTECODE: "1" },
      input: '{"arguments":{}}\n', encoding: "utf8", timeout: 10000 });
    assert.equal(startup.status, 0, startup.stderr);
    return runProcessToolHandler(input);
  };
  assert.deepEqual((await run([])).value, { started: true, cwd: root, content: null, network: false, secret_env: null });
  assert.deepEqual((await run(["filesystem_read"], [secret])).value,
    { started: true, cwd: root, content: "synthetic-private-value", network: false, secret_env: null });
  assert.deepEqual((await run(["network"])).value, { started: true, cwd: root, content: null, network: true, secret_env: null });
});
