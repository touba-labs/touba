import test from "node:test";
import assert from "node:assert/strict";
import {cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {join, dirname, resolve} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {prepareProject} from "../src/project.mjs";
import {runProcessToolHandler} from "../../../runtime/touba-runtime/src/handler-protocol.mjs";
import {sandboxSdkConfig} from "../src/sdk-sandbox.mjs";

test("prepared relative handler boots its SDK inside macOS sandbox without opening project data", {skip: process.platform !== "darwin"}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-prepared-sandbox-")));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const sdkRoot = fileURLToPath(new URL("../../../runtime/touba-handler-sdk", import.meta.url));
  const installed = join(root, "node_modules/@touba/sdk");
  mkdirSync(installed, {recursive: true});
  cpSync(join(sdkRoot, "src"), join(installed, "src"), {recursive: true});
  // Match the distributable SDK: materialize its workspace forwarding module.
  cpSync(join(sdkRoot, "../../contracts/machine/value-contracts.mjs"), join(installed, "src/value-contracts.mjs"));
  cpSync(join(sdkRoot, "package.json"), join(installed, "package.json"));
  symlinkSync(join(sdkRoot, "node_modules"), join(installed, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({type: "module", dependencies: {"@touba/sdk": "1.0.0"}}));
  mkdirSync(join(root, "src/isolated"), {recursive: true});
  writeFileSync(join(root, "src/isolated/main.tb"), `module isolated.main
tool Read
    takes path as Text
    gives Text
    requires filesystem_read
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
  const tool = "tool:isolated.main/Read";
  const decisions = {bindings: {[tool]: {effect_contract: {kind: "none"}, grants: ["filesystem_read"], sandbox: {required: true, code_paths: []}}}};
  const report = await prepareProject({root, mode: "write", hostDecisions: decisions});
  assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
  const before = readFileSync(report.manifest_path, "utf8");
  const binding = JSON.parse(before).bindings[tool];
  assert.ok(binding.sandbox.code_paths.some(path => path.endsWith("/src/index.mjs")));
  assert.ok(binding.sandbox.code_paths.every(path => !path.endsWith("node_modules") && !path.endsWith("src")));
  const check = await prepareProject({root, mode: "check", hostDecisions: decisions});
  assert.equal(check.status, "success", JSON.stringify(check.diagnostics));
  assert.equal(check.actions.some(item => item.kind.includes("host_decision") || item.kind.includes("configure_sandbox")), false);
  assert.equal(readFileSync(report.manifest_path, "utf8"), before);
  const cwd = resolve(dirname(report.manifest_path), binding.handler.cwd);
  assert.equal(cwd, root);
  assert.equal(binding.handler.args[0].startsWith("/"), false);
  const privatePath = join(root, "private.txt"); writeFileSync(privatePath, "private-value");
  writeFileSync(resolve(cwd, binding.handler.args[0]), `import {defineTool} from '@touba/sdk';
import {readFileSync} from 'node:fs';
await defineTool({toolRef:${JSON.stringify(tool)}, inputSignature:[{name:'path', type_ref:'builtin:Text'}], outputType:'builtin:Text',
requiredGrants:['filesystem_read'], run: async ({request}) => {try {return readFileSync(request, 'utf8');} catch {return 'denied';}}});`);
  const explicit = sandboxSdkConfig("javascript", {root, handler: binding.handler.args[0]});
  assert.equal(explicit.handler.command, process.execPath);
  assert.equal(explicit.handler.cwd, root);
  assert.ok(explicit.sandbox.code_paths.some(path => path.endsWith('/src/index.mjs')));
  const run = sandbox => runProcessToolHandler({toolRef: tool, request: {protocol: "touba-tool-handler-v1", operation: "invoke", tool_ref: tool,
      arguments: {path: privatePath}, grants: ["filesystem_read"], secret_handles: []}, secretHandles: [],
    binding: {...binding, handler: {...binding.handler, command: process.execPath, cwd}, sandbox,
      limits: {timeout_ms: 5000, max_payload_bytes: 65536}}});
  assert.equal((await run(binding.sandbox)).value, "denied");
  assert.equal((await run(explicit.sandbox)).value, "denied");
  assert.equal((await run({...binding.sandbox, read_paths: [privatePath]})).value, "private-value");
  // Node may report an unreadable module as missing rather than EPERM. Do not
  // invent a sandbox-denial diagnosis when the OS does not provide it.
  await assert.rejects(run({required: true}), error => error.code === "ToolHandlerNonZeroExit" || error.code === "HandlerSdkMissing");
  writeFileSync(resolve(cwd, binding.handler.args[0]), `import {readFileSync} from 'node:fs'; readFileSync(${JSON.stringify(privatePath)});`);
  await assert.rejects(run(binding.sandbox), error => error.code === "ToolHandlerSandboxAccessDenied");
});
