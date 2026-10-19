import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, copyFileSync, cpSync, readdirSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { windowsHandlerSandboxPlan, windowsSandboxOptions, probeWindowsSandbox } from "../src/windows-handler-sandbox.mjs";
import { runProcessToolHandler } from "../src/handler-protocol.mjs";

const nativeOnly = { skip: process.platform !== "win32" || !process.env.TOUBA_TEST_SANDBOX_LAUNCHER };
const env = () => ({ SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA,
  TOUBA_SANDBOX_LAUNCHER: process.env.TOUBA_TEST_SANDBOX_LAUNCHER });
const delay = ms => new Promise(done => setTimeout(done, ms));
const request = { protocol: "touba-tool-handler-v1", operation: "invoke", tool_ref: "tool:qualification/Handler", arguments: { message: "hello" } };
const files = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
const assertDenied = value => assert.ok(["EACCES", "EPERM"].includes(value), `expected an access denial, received ${value}`);
const semanticDacl = value => value.replace(/D:((?:P|AR|AI)*)/gu, (_, flags) => `D:${flags.replaceAll("AI", "")}`);
test("ACL oracle ignores only the automatic-inheritance bookkeeping bit", () => {
  const original = "O:USERG:GROUPD:P(A;;FR;;;USER)(D;;FW;;;OTHER)";
  assert.equal(semanticDacl(original.replace("D:P", "D:PAI")), original);
  for (const changed of [original.replace("D:P", "D:"), original.replace("FR", "FA"), original.replace("O:USER", "O:OTHER"), original.replace("G:GROUP", "G:OTHER")]) {
    assert.notEqual(semanticDacl(changed), original);
  }
});

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-windows-runtime-")));
  const node = join(root, "node.exe"); copyFileSync(process.execPath, node);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, node, binding(args, grants = [], sandbox = {}) {
    return { handler: { command: node, args, cwd: root }, grants, sandbox: { required: true, ...sandbox }, limits: { timeout_ms: 10000, max_payload_bytes: 65536 } };
  } };
}
async function raw(binding, diagnostic = false) {
  const plan = windowsHandlerSandboxPlan(binding, binding.handler.command, { ...windowsSandboxOptions(env()), diagnostic });
  const child = spawn(plan.command, [], { cwd: binding.handler.cwd, env: plan.environment, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", diagnostic ? "pipe" : "ignore", "pipe", "pipe"] });
  child.stdio[5].on("error", () => {}); child.stdio[5].end(plan.policy);
  child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(request));
  let stdout = "", stderr = "", privateOutput = "", completion = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  child.stdio[3]?.on("data", b => { privateOutput += b; });
  child.stdio[4]?.on("data", b => { completion += b; });
  const code = await new Promise((done, reject) => { child.on("close", done); child.on("error", reject); }); clearTimeout(timer);
  assert.equal(code, 0, `native launcher stderr: ${stderr}; stdout: ${stdout}; completion: ${completion}`);
  assert.deepEqual(JSON.parse(completion), { protocol: "touba-windows-sandbox-result-v1", ok: true, exit_code: 0 });
  return { value: JSON.parse(stdout), privateOutput };
}
const invoke = binding => runProcessToolHandler({ toolRef: "tool:qualification/Handler", binding,
  request, secretHandles: [], secretStore: null, env: env() });
function sddl(paths) {
  const command = '$env:PSModulePath = "$PSHOME\\Modules"; $ErrorActionPreference = "Stop"; '
    + paths.map(path => `(Get-Acl -LiteralPath '${path.replaceAll("'", "''")}').Sddl`).join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  // Windows marks automatic propagation with SE_DACL_AUTO_INHERITED. Compare
  // all ACEs/order, owner, group and protection, not that bookkeeping marker.
  // https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces
  return semanticDacl(result.stdout.trim());
}
function assertNoLease() {
  const root = join(process.env.LOCALAPPDATA, "ToubaSandbox");
  assert.deepEqual(readdirSync(root), [], "all completed leases must be removed");
}

test("Windows real Node protocol, FD whitelist, scoped reads/writes and ACL preservation", nativeOnly, async t => {
  const f = fixture(t), file = join(f.root, "private.txt"), output = join(f.root, "output.txt"), script = join(f.root, "handler.cjs");
  writeFileSync(file, "read-canary"); writeFileSync(output, "write-is-not-read");
  writeFileSync(script, `const fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8'));
const read=p=>{try{return fs.readFileSync(p,'utf8')}catch(e){return e.code}};
let write;try{fs.writeFileSync(${JSON.stringify(output)},'updated');write=true}catch(e){write=e.code}
let policy;try{fs.fstatSync(5);policy='leaked'}catch(e){policy=e.code}
if(process.argv[2]==='diagnostic')fs.writeSync(3,'private-channel');
console.log(JSON.stringify({ok:true,value:{input:request.arguments,read:read(${JSON.stringify(file)}),readOutput:read(${JSON.stringify(output)}),write,policy,ambient:process.env.TOUBA_TEST_AMBIENT??null}}));`);
  const before = sddl([f.root, f.node, script, file, output]);
  process.env.TOUBA_TEST_AMBIENT = "must-not-reach-handler";
  t.after(() => delete process.env.TOUBA_TEST_AMBIENT);
  // Raw startup provides a bounded, fixture-only diagnostic if an interpreter
  // cannot start. Subsequent assertions use the real runtime protocol.
  const first = (await raw(f.binding([script]))).value.value;
  assertDenied(first.read); assertDenied(first.readOutput); assertDenied(first.write);
  assert.equal(first.policy, "EBADF"); assert.equal(first.ambient, null);
  const writer = (await invoke(f.binding([script], ["filesystem_write"], { write_paths: [output] }))).value;
  assert.equal(writer.write, true); assertDenied(writer.readOutput); assertDenied(writer.read);
  const reader = (await invoke(f.binding([script], ["filesystem_read"], { read_paths: [file] }))).value;
  assert.equal(reader.read, "read-canary"); assertDenied(reader.write); assert.deepEqual(reader.input, { message: "hello" });
  const diagnostic = await raw(f.binding([script, "diagnostic"]), true);
  assert.equal(diagnostic.privateOutput, "private-channel"); assert.equal(diagnostic.value.value.policy, "EBADF");
  assert.equal(sddl([f.root, f.node, script, file, output]), before);
  const probe = probeWindowsSandbox(env());
  assert.equal(probe.available, true, JSON.stringify(probe));
  assertNoLease();
});

test("Windows denies process creation, then inherits LPAC in an allowed real Node child", nativeOnly, async t => {
  const f = fixture(t), canary = join(f.root, "private.txt"); writeFileSync(canary, "denied");
  const descendant = `try {require('node:fs').readFileSync(${JSON.stringify(canary)});process.exit(0)}catch(e){process.exit(['EACCES','EPERM'].includes(e.code)?7:9)}`;
  const source = `const {spawnSync}=require('node:child_process');const c=spawnSync(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['inherit','inherit','inherit']});console.log(JSON.stringify({ok:true,value:{status:c.status,error:c.error?.code??null}}))`;
  const denied = (await raw(f.binding(["-e", source]))).value.value;
  // libuv has no mapping for ERROR_CHILD_PROCESS_BLOCKED: it reports UNKNOWN.
  // The supervisor separately verifies the kernel child-policy bit before
  // resume, and the identical command must run in the positive control below.
  assert.equal(denied.status, null); assert.ok(["EPERM", "EACCES", "UNKNOWN"].includes(denied.error), JSON.stringify(denied));
  const allowed = (await raw(f.binding(["-e", source], ["process"]))).value.value;
  assert.deepEqual(allowed, { status: 7, error: null }); assertNoLease();
});

test("Windows loads the real JavaScript SDK without granting sibling data reads", nativeOnly, async t => {
  const f = fixture(t), sdk = join(f.root, "sdk"), script = join(f.root, "handler.mjs"), canary = join(sdk, "private.txt");
  cpSync(fileURLToPath(new URL("../../touba-handler-sdk/src", import.meta.url)), sdk, { recursive: true });
  const code = files(sdk); writeFileSync(canary, "not-code");
  writeFileSync(script, `import {defineTool} from ${JSON.stringify(pathToFileURL(join(sdk, "index.mjs")).href)};
import {readFileSync,writeFileSync} from 'node:fs';
await defineTool({toolRef:'tool:qualification/Handler',run:({request})=>{
let denied;try{readFileSync(${JSON.stringify(canary)});denied=false}catch(e){denied=['EACCES','EPERM'].includes(e.code)}
writeFileSync(${JSON.stringify(canary)},'still-not-readable');
return {input:request,denied};}});`);
  const before = sddl([sdk, canary]);
  // Directory listing for code resolution must NOT become an inherited data
  // read permission when the same directory has an explicit write grant.
  const binding = f.binding([script], ["filesystem_write"], { code_paths: code, write_paths: [sdk] });
  assert.deepEqual((await raw(binding)).value, { ok: true, value: { input: { message: "hello" }, denied: true } });
  assert.deepEqual((await invoke(binding)).value, { input: { message: "hello" }, denied: true });
  assert.equal(sddl([sdk, canary]), before); assertNoLease();
});

test("Windows forwards an explicit secret handle but not ambient libuv variables", nativeOnly, async t => {
  const f = fixture(t);
  const binding = f.binding(["-e", "console.log(JSON.stringify({ok:true,value:{selected:process.env.TEST_SELECTED==='fixture-secret',ambient:process.env.USERPROFILE??null,path:process.env.PATH??null}}))"]);
  const result = await runProcessToolHandler({ toolRef: "tool:qualification/Environment", binding, request: { arguments: {} },
    secretHandles: ["TEST_SELECTED"], secretStore: { valueFor: () => "fixture-secret" }, env: env() });
  assert.deepEqual(result.value, { selected: true, ambient: null, path: null }); assertNoLease();
});

test("Windows native network denial and explicit outbound network grant", nativeOnly, async t => {
  const f = fixture(t);
  const address = (await lookup("www.microsoft.com", { family: 4 })).address;
  const source = `const s=require('node:net').connect({host:${JSON.stringify(address)},port:443});let done=false;const end=value=>{if(done)return;done=true;s.destroy();console.log(JSON.stringify({ok:true,value}))};s.once('connect',()=>end('connected'));s.once('error',e=>end(e.code));s.setTimeout(4000,()=>end('timeout'));`;
  const control = spawnSync(f.node, ["-e", source], { encoding: "utf8", timeout: 5000 });
  assert.equal(control.status, 0, control.stderr); assert.equal(JSON.parse(control.stdout).value, "connected", "host positive network control");
  assert.equal((await raw(f.binding(["-e", source]))).value.value, "EACCES");
  assert.equal((await raw(f.binding(["-e", source], ["network"]))).value.value, "connected"); assertNoLease();
});

test("Windows concurrent ACL leases do not revoke another live invocation", nativeOnly, async t => {
  const f = fixture(t), canary = join(f.root, "shared.txt"); writeFileSync(canary, "shared-canary");
  const before = sddl([f.node, canary]);
  const source = ms => `setTimeout(()=>console.log(JSON.stringify({ok:true,value:require('node:fs').readFileSync(${JSON.stringify(canary)},'utf8')})),${ms})`;
  const bindings = [0, 750, 200].map(ms => f.binding(["-e", source(ms)], ["filesystem_read"], { read_paths: [canary] }));
  const values = await Promise.all(bindings.map(invoke));
  assert.deepEqual(values.map(v => v.value), ["shared-canary", "shared-canary", "shared-canary"]);
  assert.equal(sddl([f.node, canary]), before); assertNoLease();
});

test("Windows timeout kills a detached descendant, then recovers the abandoned ACL lease", nativeOnly, async t => {
  const f = fixture(t), output = join(f.root, "output"); mkdirSync(output);
  const heartbeat = join(output, "heartbeat.txt"); writeFileSync(heartbeat, "");
  const before = sddl([f.root, f.node, output, heartbeat]);
  const descendant = `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`;
  const source = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['inherit','inherit','inherit']});c.unref();setInterval(()=>{},100)`;
  const binding = f.binding(["-e", source], ["process", "filesystem_write"], { write_paths: [output] }); binding.limits.timeout_ms = 2500;
  await assert.rejects(invoke(binding), e => e.code === "ToolHandlerTimeout");
  const stopped = readFileSync(heartbeat, "utf8"); assert.ok(stopped.length > 0, "descendant actually ran");
  await delay(300); assert.equal(readFileSync(heartbeat, "utf8"), stopped);
  assert.ok(readdirSync(join(process.env.LOCALAPPDATA, "ToubaSandbox")).length > 0, "hard-kill recovery journal remains");
  await raw(f.binding(["-e", 'console.log(JSON.stringify({ok:true,value:"recovered"}))']));
  assert.equal(sddl([f.root, f.node, output, heartbeat]), before); assertNoLease();
});

test("Windows rejects hard-linked scope targets without changing their ACL", nativeOnly, async t => {
  const f = fixture(t), file = join(f.root, "file.txt"), linked = join(f.root, "linked.txt");
  writeFileSync(file, "canary"); linkSync(file, linked);
  const before = sddl([file]);
  await assert.rejects(invoke(f.binding(["-e", 'console.log("unreachable")'], ["filesystem_read"], { read_paths: [linked] })), e => e.code === "HandlerSandboxPathInvalid");
  assert.equal(sddl([file]), before); assertNoLease();
});

test("Windows real Python interpreter protocol uses identical scopes and a closed environment", nativeOnly, async t => {
  const f = fixture(t), pythonRoot = join(f.root, "python"); mkdirSync(pythonRoot);
  // Build a small, isolated interpreter fixture from the runner's actual
  // CPython distribution. The standard library is explicit code, not a data
  // grant to the host Python installation or its site-packages.
  const prepare = `import pathlib, shutil, sys, zipfile
dest=pathlib.Path(sys.argv[1]); base=pathlib.Path(sys.base_prefix)
version=f'python{sys.version_info.major}{sys.version_info.minor}'
shutil.copy2(sys.executable,dest/'python.exe')
for item in base.glob('*.dll'): shutil.copy2(item,dest/item.name)
for item in (base/'DLLs').iterdir():
 if item.suffix.lower() in {'.dll','.pyd'}: shutil.copy2(item,dest/item.name)
with zipfile.ZipFile(dest/(version+'.zip'),'w',compression=zipfile.ZIP_STORED) as archive:
 for item in (base/'Lib').rglob('*.py'):
  relative=item.relative_to(base/'Lib')
  if not set(relative.parts)&{'site-packages','test','tests','idlelib','tkinter','ensurepip'}: archive.write(item,relative)
(dest/(version+'._pth')).write_text(version+'.zip\\n.\\n',encoding='utf-8')
`;
  const prepared = spawnSync(process.env.TOUBA_TEST_PYTHON ?? "python", ["-c", prepare, pythonRoot], { encoding: "utf8", timeout: 20000 });
  assert.equal(prepared.status, 0, prepared.stderr);
  const command = join(pythonRoot, "python.exe"), script = join(f.root, "handler.py"), file = join(f.root, "private.txt");
  writeFileSync(file, "python-canary");
  writeFileSync(script, `import json,sys,os
request=json.load(sys.stdin)
try:
 with open(${JSON.stringify(file)},encoding='utf-8') as source: content=source.read()
except PermissionError: content=None
try: os.fstat(5); policy='leaked'
except OSError: policy='closed'
print(json.dumps({'ok':True,'value':{'content':content,'input':request['arguments'],'policy':policy,'env':sorted(os.environ)}}))
`);
  const codePaths = readdirSync(pythonRoot).map(name => join(pythonRoot, name));
  const binding = read => ({ ...f.binding([script], read ? ["filesystem_read"] : [], { code_paths: codePaths, ...(read ? { read_paths: [file] } : {}) }), handler: { command, args: [script], cwd: f.root } });
  const denied = (await raw(binding(false))).value.value;
  assert.equal(denied.content, null); assert.equal(denied.policy, "closed");
  const allowed = (await invoke(binding(true))).value;
  assert.equal(allowed.content, "python-canary"); assert.deepEqual(allowed.input, { message: "hello" });
  assert.deepEqual(allowed.env, ["LOCALAPPDATA", "SYSTEMROOT", "TEMP", "TMP"]); assertNoLease();

  const sdk = join(pythonRoot, "touba_sdk");
  cpSync(fileURLToPath(new URL("../../touba-python-sdk/src/touba_sdk", import.meta.url)), sdk,
    { recursive: true, filter: source => !source.includes("__pycache__") && !source.endsWith(".pyc") });
  writeFileSync(script, `import asyncio,os\nfrom touba_sdk import define_tool\ndef run(*,request,context):
 try:\n  with open(${JSON.stringify(file)},encoding='utf-8') as source: content=source.read()
 except PermissionError: content=None
 return {'content':content,'input':request}
asyncio.run(define_tool(tool_ref='tool:qualification/Handler',run=run))\n`);
  const sdkBinding = read => ({ ...binding(read), sandbox: { ...binding(read).sandbox, code_paths: files(pythonRoot) } });
  // Independent subtests retain both outcomes; failure without a grant must
  // not conceal whether CPython/SDK work with explicitly authorized networking.
  for (const network of [false, true]) await t.test(`real SDK, explicit network grant: ${network}`, async () => {
    const configured = read => ({ ...sdkBinding(read), grants: [...sdkBinding(read).grants, ...(network ? ["network"] : [])] });
    assert.deepEqual((await raw(configured(false))).value, { ok: true, value: { content: null, input: { message: "hello" } } });
    assert.deepEqual((await invoke(configured(true))).value, { content: "python-canary", input: { message: "hello" } });
  });
  assertNoLease();
});
