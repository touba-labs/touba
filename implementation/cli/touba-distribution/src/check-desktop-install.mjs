#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installDesktop } from "./desktop-install.mjs";
import { checkSdkTutorials } from "./check-sdk-tutorials.mjs";

if (process.argv.length !== 3) throw new Error("Usage: check-desktop-install.mjs <extracted-release-directory>");
const release = resolve(process.argv[2]);
const source = join(release, "touba-toolchain");
const temp = mkdtempSync(join(tmpdir(), "touba-desktop-smoke-"));
const project = join(temp, "project with spaces"); mkdirSync(project);
const prefix = join(temp, "installation with spaces");
const node = process.platform === "win32" ? "node.exe" : "node";
function run(command, args, cwd = project) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, npm_config_cache: join(temp, "npm-cache") }, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command}: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
try {
  const installed = installDesktop({ source, prefix });
  assert.equal(installed.unchanged, false);
  assert.equal(installDesktop({ source, prefix, force: true }).unchanged, true);
  const root = installed.install_root;
  const binary = join(root, "bin", node);
  const cli = join(root, "lib/cli/touba-project/src/main.mjs");
  const command = (...args) => run(binary, [cli, ...args]);
  assert.equal(JSON.parse(command("version", "--json")).build.id, installed.build_id);
  if (process.platform !== "win32") assert.match(run(installed.cli_path, ["version"]), /touba 0\.1\.0/);
  assert.match(command("sdk", "path", "javascript"), /\.tgz$/);
  assert.match(command("sdk", "path", "python"), /\.whl$/);
  command("sdk", "install", "javascript");
  command("sdk", "install", "python");
  command("sdk", "install", "python");
  const packageJson = JSON.parse(readFileSync(join(project, "package.json")));
  assert.match(packageJson.dependencies["@touba/sdk"], /^file:vendor\/touba-sdk\//);
  const python = join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  writeFileSync(join(project, "program.tb"), "module test.sdk\nstrategy Echo\n    gives Text\n    do\n        give \"sdk-ok\"\n");
  const env = { ...process.env, TOUBA_COMPILE_BIN: join(root, "bin", process.platform === "win32" ? "touba-compile.exe" : "touba-compile") };
  const script = `from touba_sdk import ToubaEngine\ne = ToubaEngine(command=${JSON.stringify(join(root, "bin", process.platform === "win32" ? "touba.cmd" : "touba"))}, project_root=${JSON.stringify(project)})\nr = e.run(source="program.tb")\nassert r.result == "sdk-ok", r\nprint(r.status)\n`;
  const result = spawnSync(python, ["-I", "-c", script], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(project, "node_modules/@touba/sdk")), true);
  // A real Python tool: generated source, explicit host admission and runtime
  // process dispatch, with no PYTHONPATH or source-checkout dependency.
  command("init", "--language", "python");
  mkdirSync(join(project, "src/sdk"), { recursive: true });
  writeFileSync(join(project, "src/sdk/handlers.tb"), `module sdk.handlers
tool Normalize
    takes value as Text
    gives Text
strategy Run
    takes value as Text
    gives Text
    uses Normalize
    do
        Normalize
            with value as value
            into result
        give result
`);
  const tool = "tool:sdk.handlers/Normalize";
  const decisions = { bindings: { [tool]: { grants: [], effect_contract: { kind: "none" } } } };
  const prepared = JSON.parse(command("prepare", "--mode", "write", "--json", "--host-decisions-json", JSON.stringify(decisions)));
  assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.sdk_dependency.status, "ready");
  const manifest = JSON.parse(readFileSync(join(project, ".touba/build/dev/touba.manifest.json")));
  const handler = join(project, manifest.bindings[tool].handler.args[0]);
  writeFileSync(handler, readFileSync(handler, "utf8").replace('raise ToubaHandlerError("HandlerNotImplemented", "Handler is not implemented")', "return request.upper()"));
  run(python, [handler.replace(/\.handler\.py$/, ".handler.contract.test.py")]);
  const engineScript = `from touba_sdk import ToubaEngine\ne = ToubaEngine(command=${JSON.stringify(binary)}, command_args=[${JSON.stringify(cli)}], project_root=${JSON.stringify(project)})\nr=e.run(source="src/sdk/handlers.tb", manifest=".touba/build/dev/touba.manifest.json", inputs={"value":"invoice"})\nassert r.result == "INVOICE", r\n`;
  const governed = spawnSync(python, ["-I", "-c", engineScript], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(governed.status, 0, governed.stderr);
  // Execute the actual published tutorial body, not a hidden equivalent.
  const tutorial = readFileSync(fileURLToPath(new URL("../../../../docs/tutoriels/handlers-python.md", import.meta.url)), "utf8");
  const functionBody = tutorial.match(/```python\n([\s\S]*?)\n```/)[1];
  const application = tutorial.match(/```python title="run.py"\n([\s\S]*?)\n```/)[1];
  writeFileSync(handler, readFileSync(handler, "utf8").replace(/async def run\(request, context\):\n[\s\S]*?(?=\n\nif __name__)/, functionBody + "\n"));
  const tutorialResult = spawnSync(python, ["-I", "-c", application], { cwd: project,
    env: { ...env, PATH: join(root, "bin") + (process.platform === "win32" ? ";" : ":") + process.env.PATH },
    encoding: "utf8", timeout: 60_000 });
  assert.equal(tutorialResult.status, 0, tutorialResult.stderr);
  assert.equal(tutorialResult.stdout.trim(), "INVOICE 42");
  // Follow the tutorial's locking section with the installed CLI, then prove
  // that a changed transitive module is refused before any handler code runs.
  const projectIdentity = tutorial.match(/```toml title="pyproject.toml"\n([\s\S]*?)\n```/)[1];
  const helperBody = tutorial.match(/```python title="handlers\/sdk\/handlers\/helpers.py"\n([\s\S]*?)\n```/)[1];
  const helper = join(project, "handlers/sdk/handlers/helpers.py");
  writeFileSync(join(project, "pyproject.toml"), projectIdentity + "\n");
  writeFileSync(helper, helperBody + "\n");
  writeFileSync(handler, "from helpers import normalize\n" + readFileSync(handler, "utf8").replace("return request.strip().upper()", "return normalize(request)"));
  command("compile", "src/sdk/handlers.tb", "--out", "program.air.json");
  command("supply-chain", "generate", "--air", "program.air.json", "--manifest", ".touba/build/dev/touba.manifest.json", "--out", "touba.lock.json");
  const checked = JSON.parse(command("supply-chain", "validate", "--air", "program.air.json", "--manifest", ".touba/build/dev/touba.manifest.json", "--lock", "touba.lock.json", "--output", "json"));
  assert.notEqual(checked.status, "error");
  const lock = JSON.parse(readFileSync(join(project, "touba.lock.json")));
  assert.deepEqual(lock.review, { status: "pending" });
  assert.ok(lock.handlers[0].handler_package.files.some(file => file.path === "handlers/sdk/handlers/helpers.py"));
  // The lock identifies the explicit AIR file, not a new temporary compilation.
  const lockedScript = engineScript.replace('source="src/sdk/handlers.tb"', 'air="program.air.json"')
    .replace('inputs={"value":"invoice"}', 'inputs={"value":"invoice"}, supply_chain_lock="touba.lock.json", require_supply_chain_lock=True');
  const pending = spawnSync(python, ["-I", "-c", lockedScript], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(pending.status, 0, "A pending lock must not pass a required admission gate");
  assert.match(pending.stderr, /SupplyChainAdmissionRefused/);
  // Explicit automated test review, never a human or production sign-off.
  const metadata = JSON.parse(run(python, ["-I", "-c", "import json; from touba_sdk import touba_sdk_metadata; print(json.dumps(touba_sdk_metadata()))"]));
  lock.handlers[0].sdk = metadata;
  lock.review = { status: "approved", reviewed_at: new Date().toISOString(), reviewers: [{ kind: "tool", id: "installation-smoke", role: "test" }] };
  writeFileSync(join(project, "touba.lock.json"), JSON.stringify(lock, null, 2) + "\n");
  command("supply-chain", "validate", "--air", "program.air.json", "--manifest", ".touba/build/dev/touba.manifest.json", "--lock", "touba.lock.json", "--strict", "--require-review");
  const locked = spawnSync(python, ["-I", "-c", lockedScript], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(locked.status, 0, locked.stderr);
  const marker = join(project, "MUST-NOT-EXECUTE");
  writeFileSync(helper, helperBody + `\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\n`);
  const refused = spawnSync(python, ["-I", "-c", lockedScript], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /SupplyChain|supply.chain/i);
  assert.equal(existsSync(marker), false, "Changed local module must be refused before dispatch");
  checkSdkTutorials({ root, temp });
  process.stdout.write("PASS: real desktop installation, idempotent reinstall, offline JS/Python SDKs, paired published Engine and handler tutorials, transitive locks and Python drift refused before dispatch.\n");
} finally { rmSync(temp, { recursive: true, force: true }); }
