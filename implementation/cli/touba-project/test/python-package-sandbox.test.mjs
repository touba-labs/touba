import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { newPackage, addPackage } from "../src/packages.mjs";
import { initProject, prepareProject } from "../src/project.mjs";
import { sandboxSdkConfig } from "../src/sdk-sandbox.mjs";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";
import { buildHandlerSandboxPlan, runProcessToolHandler } from "../../../runtime/touba-runtime/src/handler-protocol.mjs";

const json = file => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const sdkSource = fileURLToPath(new URL("../../../runtime/touba-python-sdk/src/touba_sdk", import.meta.url));

test("Python package with explicit fragment: prepare, SDK, approval and sandbox data/network isolation", {
  skip: process.platform !== "darwin" && !(process.platform === "linux" && process.env.TOUBA_TEST_SANDBOX_LAUNCHER),
}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-python-package-sandbox-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "consumer"); mkdirSync(project); initProject({ root: project, language: "python" });
  const python = process.env.TOUBA_TEST_SANDBOX_PYTHON ?? (existsSync("/opt/homebrew/opt/python@3.14/bin/python3.14")
    ? "/opt/homebrew/opt/python@3.14/bin/python3.14" : "python3");
  const venv = spawnSync(python, ["-I", "-B", "-m", "venv", "--without-pip", join(project, ".venv")], { encoding: "utf8", timeout: 30000 });
  assert.equal(venv.status, 0, venv.stderr);
  const command = join(project, ".venv/bin/python");
  const probe = spawnSync(command, ["-I", "-B", "-c", "import sys,sysconfig; assert sys.version_info >= (3,11); print(sysconfig.get_path('purelib'))"], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  cpSync(sdkSource, join(probe.stdout.trim(), "touba_sdk"), { recursive: true });
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const privatePath = join(project, "private.txt"), permittedPath = join(project, "permitted.txt");
  writeFileSync(privatePath, "synthetic-private-content"); writeFileSync(permittedPath, "permitted-content");
  const name = "example.reader", ref = "tool:example.reader/Read";
  const source = newPackage(name, { root }).path;
  const packageFile = join(source, "touba.package.json");
  const pkg = json(packageFile);
  Object.assign(pkg, { publisher: "test", license: "MIT", exports: { tools: [ref] },
    handlers: [{ tool: ref, path: "handlers/read.py", protocol: "touba-tool-handler-v1" }] });
  save(packageFile, pkg);
  writeFileSync(join(source, "src/example/reader.tb"), `module example.reader
tool Read
    takes path as Text
    gives Text
    requires filesystem_read
    human.approve
        with role as "reviewer"
`);
  mkdirSync(join(source, "handlers"));
  writeFileSync(join(source, "handlers/read.py"), `import asyncio,json,socket,os,subprocess,sys
from touba_sdk import define_tool
async def run(request,context):
    try:
        with open(request) as stream: content=stream.read()
    except OSError: content=None
    try:
        client=socket.create_connection(('127.0.0.1',${server.address().port}),timeout=0.5)
        client.close(); network=True
    except OSError: network=False
    try:
        subprocess.run([sys.executable,'-c','pass'],check=True,capture_output=True); child=True
    except (OSError,subprocess.CalledProcessError): child=False
    return json.dumps({'content':content,'network':network,'child':child,'env':os.getenv('TOUBA_SYNTHETIC_SECRET'),'cwd':os.getcwd()})
asyncio.run(define_tool(tool_ref=${JSON.stringify(ref)},input_signature=[{'name':'path','type_ref':'builtin:Text'}],output_type='builtin:Text',required_grants=['filesystem_read'],run=run))
`);
  await addPackage(source, { root: project });
  mkdirSync(join(project, "src/client"), { recursive: true });
  writeFileSync(join(project, "src/client/main.tb"), `module client.main
import tool Read from example.reader
strategy Run
    takes path as Text
    gives Text
    uses Read
    do
        Read
            with path as path
            into result
        give result
`);
  const selected = sandboxSdkConfig("python", { root: project, handler: "packages/example.reader/handlers/read.py" });
  assert.equal(selected.handler.command, command);
  assert.ok(selected.sandbox.code_paths.some(path => path.endsWith("touba_sdk/__init__.py")));
  assert.ok(selected.sandbox.code_paths.every(path => !path.endsWith("private.txt")));
  const fragment = { fragment_schema_version: "touba-binding-fragment-v1", source: { kind: "module", module: name },
    bindings: { [ref]: { ...selected, sandbox: { ...selected.sandbox, read_paths: [permittedPath] }, grants: ["filesystem_read"],
      effect_contract: { kind: "none" }, secrets: [], timeout_ms: 10000, max_payload_bytes: 65536 } } };
  save(join(project, "bindings.json"), fragment);
  const configFile = join(project, "touba.project.json"), config = json(configFile);
  config.configuration = { binding_fragments: ["bindings.json"] };
  save(configFile, config);
  const options = { root: project, entryRef: "strategy:client.main/Run", mode: "write" };
  for (const mode of ["write", "plan", "write", "check"]) {
    const report = await prepareProject({ ...options, mode });
    assert.equal(report.diagnostics.some(d => d.severity === "error"), false, JSON.stringify(report.diagnostics));
  }
  writeFileSync(join(project, "authority.mjs"), 'export const initiatorRef="user:author"; export function attestHumanApproval({request,decision}) {return {request_id:request.request_id,run_id:request.run_id,decision,subject_ref:"user:reviewer",roles:["reviewer"]};}');
  const engine = new ToubaEngine({ projectRoot: project, command: process.execPath, commandArgs: [cli] });
  t.after(() => engine.close());
  for (const [label, path, content] of [["private", privatePath, null], ["permitted", permittedPath, "permitted-content"]]) {
    const common = { project, humanApprovalHost: "authority.mjs", humanCheckpointOut: `pending-${label}.json` };
    const pending = await engine.run({ ...common, inputs: { path } });
    assert.equal(pending.reason, "human_approval_pending", JSON.stringify(pending));
    const checkpoint = json(join(project, common.humanCheckpointOut));
    const resumed = await engine.run({ ...common, humanResumeCheckpoint: common.humanCheckpointOut,
      humanDecisions: { [checkpoint.approval_ref]: { decision: "approved", evidence_ref: "test" } } });
    assert.equal(resumed.status, "success", JSON.stringify(resumed));
    assert.deepEqual(JSON.parse(resumed.result), { content, network: false, child: false, env: null, cwd: project });
    assert.equal(resumed.trace.events.filter(e => e.kind === "tool_approval_authorized").length, 1);
  }
  const binding = { ...fragment.bindings[ref], limits: { timeout_ms: 10000, max_payload_bytes: 65536 } };
  const plan = buildHandlerSandboxPlan({ binding });
  if (process.platform === "darwin") assert.ok(!plan.args[1].includes("(allow process-fork)"));
  if (plan.environment?.__PYVENV_LAUNCHER__) {
    assert.equal(plan.environment.__PYVENV_LAUNCHER__, command);
    assert.throws(() => buildHandlerSandboxPlan({ binding: { ...binding, sandbox: { required: true } } }), { code: "HandlerSandboxPythonRuntimeMissing" });
  }
  const direct = await runProcessToolHandler({ toolRef: ref, binding, secretHandles: [], secretStore: undefined,
    env: { ...process.env, TOUBA_SYNTHETIC_SECRET: "synthetic-parent-secret" },
    request: { protocol: "touba-tool-handler-v1", operation: "invoke", tool_ref: ref, arguments: { path: privatePath }, grants: ["filesystem_read"], secret_handles: [] } });
  assert.deepEqual(JSON.parse(direct.value), { content: null, network: false, child: false, env: null, cwd: project });
});
