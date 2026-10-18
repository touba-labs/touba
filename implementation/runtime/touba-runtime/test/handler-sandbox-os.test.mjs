import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { runProcessToolHandler } from "../src/handler-protocol.mjs";

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
  assert.deepEqual(denied, { read: false, linked: false, write: false, child: null, childDenied: true, tcp: false, unix: false });
  const processAllowed = (await run(["process", "filesystem_read", "network_local"], { read_paths: [allowed], local_sockets: [socketPath] })).value;
  assert.deepEqual(processAllowed, { read: false, linked: false, write: false, child: 7, childDenied: false, tcp: false, unix: true });
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
