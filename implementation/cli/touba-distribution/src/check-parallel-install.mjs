import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installLocalToolchain } from "./install-local-toolchain.mjs";

const root = mkdtempSync(join(tmpdir(), "touba-native-parallel-installed-"));
try {
  const source = fileURLToPath(new URL(`../dist/touba-toolchain-${process.platform}-${process.arch}`, import.meta.url));
  const installation = installLocalToolchain({ source, prefix: join(root, "installed") });
  const version = JSON.parse(execFileSync(installation.cli_path, ["version", "--json"], { encoding: "utf8" }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--cache", join(root, "npm-cache"), "--save-exact", version.distribution.sdk_archive],
    { cwd: root, stdio: "pipe", timeout: 120000 });
  const require = createRequire(join(root, "package.json"));
  const { ToubaEngine } = await import(pathToFileURL(require.resolve("@touba/sdk")));
  writeFileSync(join(root, "diagnostics.tb"), readFileSync(new URL("../../../grammar/tree-sitter-touba/examples/parallel-v1/positive/diagnostics.tb", import.meta.url)));
  writeFileSync(join(root, "provider.mjs"), `export async function decide(request) {
    await new Promise(resolve => setTimeout(resolve, request.inputs.request === 'first' ? 25 : 5));
    return { action: 'answer_directly', result: request.inputs.request + ': reviewed' };
  }`);
  const engine = new ToubaEngine({ projectRoot: root, command: installation.cli_path });
  const options = { source: "diagnostics.tb", entryRef: "strategy:parallel.diagnostics/Run",
    agentDecisionProvider: "provider.mjs", parallelLimits: { maxExternalCalls: 2 }, parallelCheckpointOut: "progress.json" };
  const result = await engine.run({ ...options, inputs: { incidents: ["first", "second", "third"] } });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(result.result, ["first: reviewed", "second: reviewed", "third: reviewed"]);
  const resumed = await engine.run({ ...options, parallelResumeCheckpoint: "progress.json" });
  assert.deepEqual(resumed.result, result.result);
  assert.equal(resumed.trace.events.filter(e => e.kind === "agent_decision_provider_call_attempted").length, 0);
  console.log("PARALLEL_INSTALLED_CLI_AND_OFFLINE_SDK_OK");
} finally { rmSync(root, { recursive: true, force: true }); }
