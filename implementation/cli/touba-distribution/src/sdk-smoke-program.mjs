// Executed only after npm installs the distributed tarball in a clean project.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, ToubaEngine, toubaSdkMetadata, createOpenAiDecisionProvider, createOllamaDecisionProvider } from "@touba/sdk";

assert.equal(typeof defineTool, "function");
assert.equal(toubaSdkMetadata().name, "@touba/sdk");
assert.ok(import.meta.resolve("@touba/sdk").includes("node_modules/@touba/sdk/"));
const sdkRequire = createRequire(import.meta.resolve("@touba/sdk"));
for (const name of ["ai", "@ai-sdk/openai", "zod"]) assert.ok(sdkRequire.resolve(name));

writeFileSync("hello.tb", 'module distribution.hello\nstrategy Hello\n    gives Text\n    do\n        give "installed-sdk-ok"\n');
const engine = new ToubaEngine({ command: process.execPath, commandArgs: [process.argv[2]] });
const run = await engine.run({ source: "hello.tb" });
assert.equal(run.status, "success");
assert.equal(run.result, "installed-sdk-ok");

// Keep the generator's exports and signature; change only business code.
command(["init", "--root", process.cwd()]);
mkdirSync("src/distribution", { recursive: true });
writeFileSync("src/distribution/handlers.tb", `module distribution.handlers
tool Echo
    takes request as Text
    gives Text
    requires network
tool Decorate
    takes request as Text
    gives Text
skill Work
    takes request as Text
    gives Text
    uses Echo
    uses Decorate
    do
        Echo
            with request as request
            into echoed
        Decorate
            with request as echoed
            into decorated
        give decorated
`);
const packageBefore = readFileSync("package.json", "utf8");
const lockBefore = readFileSync("package-lock.json", "utf8");
const previouslyPrepared = existsSync(".touba/build/dev/touba.manifest.json");
const prepared = JSON.parse(command(["prepare", "--root", process.cwd(), "--mode", "write", "--json"]));
assert.equal(prepared.status, previouslyPrepared ? "success" : "needs_changes");
assert.equal(prepared.sdk_dependency.status, "ready");
const manifest = JSON.parse(readFileSync(prepared.manifest_path, "utf8"));
const contracts = [];
const originalHandlers = new Map();
for (const [ref, binding] of Object.entries(manifest.bindings)) {
  // Explicit host decisions for these read-only test handlers.
  binding.effect_contract = { kind: "none" };
  binding.grants = ref.endsWith("/Echo") ? ["network"] : [];
  const file = binding.handler.args[0];
  const original = readFileSync(file, "utf8");
  originalHandlers.set(file, original);
  const replaced = original.replace(/export async function run\(\{ request, context \}\) \{[\s\S]*?\n\}/u,
    `export async function run({ request, context }) {\n  void context;\n  return ${ref.endsWith("/Decorate") ? '"[" + request + "]"' : "request"};\n}`);
  assert.match(original, /export async function run\(\{ request, context \}\)/u);
  if (original.includes("HandlerNotImplemented")) assert.notEqual(replaced, original);
  writeFileSync(file, replaced);
  contracts.push(file.replace(/\.handler\.mjs$/u, ".handler.contract.test.mjs"));
}
writeFileSync(prepared.manifest_path, JSON.stringify(manifest, null, 2));
const contractRun = spawnSync(process.execPath, ["--test", ...contracts], { encoding: "utf8" });
assert.equal(contractRun.status, 0, contractRun.stdout + contractRun.stderr);
const output = await engine.run({ source: "src/distribution/handlers.tb", entryRef: "skill:distribution.handlers/Work",
  manifest: prepared.manifest_path, inputs: { request: "two handlers" } });
assert.equal(output.result, "[two handlers]");
const air = await engine.compile({ source: "src/distribution/handlers.tb" });
writeFileSync("handlers.air.json", air.airJson);
assert.equal(JSON.parse(command(["run", "handlers.air.json", "--entry", "skill:distribution.handlers/Work",
  "--manifest", prepared.manifest_path, "--inputs-json", '{"request":"CLI"}', "--output", "result"])), "[CLI]");
assert.equal(readFileSync("package.json", "utf8"), packageBefore);
assert.equal(readFileSync("package-lock.json", "utf8"), lockBefore);

// A damaged installation must be diagnosed, never silently resolved from the CLI.
const sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@touba/sdk"))));
const sdkPackagePath = join(sdkRoot, "package.json");
const sdkPackageBytes = readFileSync(sdkPackagePath);
const sdkPackage = JSON.parse(sdkPackageBytes);
const sdkCheck = code => {
  const report = JSON.parse(command(["prepare", "--root", process.cwd(), "--mode", "plan", "--json"]));
  assert.equal(report.sdk_dependency.status, "unavailable");
  assert.equal(report.sdk_dependency.code, code);
  const refused = spawnSync(process.execPath, [process.argv[2], "run", "handlers.air.json", "--entry",
    "skill:distribution.handlers/Work", "--manifest", prepared.manifest_path,
    "--inputs-json", '{"request":"must refuse"}', "--output", "json"], { encoding: "utf8" });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).status, "failure");
};
renameSync(sdkRoot, sdkRoot + ".unavailable");
try { sdkCheck("HandlerSdkMissing"); } finally { renameSync(sdkRoot + ".unavailable", sdkRoot); }
writeFileSync(sdkPackagePath, JSON.stringify({ ...sdkPackage, version: "0.0.0-incompatible" }));
try {
  const report = JSON.parse(command(["prepare", "--root", process.cwd(), "--mode", "plan", "--json"]));
  assert.equal(report.sdk_dependency.code, "HandlerSdkIncompatible");
} finally { writeFileSync(sdkPackagePath, sdkPackageBytes); }
const aiRoot = join(sdkRoot, "node_modules/ai");
renameSync(aiRoot, aiRoot + ".unavailable");
try {
  const report = JSON.parse(command(["prepare", "--root", process.cwd(), "--mode", "plan", "--json"]));
  assert.equal(report.sdk_dependency.code, "HandlerSdkDependencyMissing");
  const missing = spawnSync(process.execPath, ["--input-type=module", "-e",
    "import {createRequire} from 'node:module'; await import(createRequire(import.meta.resolve('@touba/sdk')).resolve('ai'));"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/);
} finally { renameSync(aiRoot + ".unavailable", aiRoot); }
for (const [file, stub] of originalHandlers) {
  if (!stub.includes("HandlerNotImplemented")) continue; // Reinstallation exercises completed handlers.
  const completed = readFileSync(file);
  writeFileSync(file, stub);
  try {
    await assert.rejects(engine.run({ air: "handlers.air.json", entryRef: "skill:distribution.handlers/Work",
      manifest: prepared.manifest_path, inputs: { request: "unimplemented" } }), error => {
      assert.equal(error.details.exitCode, 1);
      assert.match(JSON.stringify(error.details.trace), /HandlerNotImplemented/);
      return true;
    });
  } finally { writeFileSync(file, completed); }
}
writeFileSync("invalid.manifest.json", JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: { bad: {} } }));
await assert.rejects(engine.run({ air: "handlers.air.json", manifest: "invalid.manifest.json" }), error => {
  assert.equal(error.details.exitCode, 1);
  assert.equal(error.details.status, "failure");
  assert.equal(error.details.trace.events.some(event => event.kind === "call_completed"), false);
  return true;
});
const denied = structuredClone(manifest);
denied.bindings["tool:distribution.handlers/Echo"].grants = [];
const deniedPath = join(dirname(prepared.manifest_path), "denied.manifest.json");
writeFileSync(deniedPath, JSON.stringify(denied));
await assert.rejects(engine.run({ air: "handlers.air.json", entryRef: "skill:distribution.handlers/Work",
  manifest: deniedPath, inputs: { request: "denied" } }), error => {
  assert.ok(error.details.trace.events.some(event => event.payload?.runtime_error_code === "ToolCapabilityNotGranted"), JSON.stringify(error.details.trace));
  assert.equal(error.details.trace.events.some(event => event.kind === "call_completed"), false);
  return true;
});

process.env.TOUBA_DISTRIBUTION_TEST_KEY = "synthetic-not-a-credential";
const decision = { action: "answer_directly", source: "archive-test", reason: "The requested work is complete.", result: "done" };
// Real installed AI SDK response parsing, only the HTTP boundary is substituted.
for (const factory of [createOpenAiDecisionProvider, createOllamaDecisionProvider]) {
  for (const decisionInterface of ["structured", "native"]) {
    let calls = 0;
    const provider = factory({ model: "offline-response-fixture", source: "archive-test", decisionInterface,
      allowHumanReview: false, apiKeyEnvNames: ["TOUBA_DISTRIBUTION_TEST_KEY"], maxRetries: 0,
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ object: "response", id: "resp_archive", created_at: 1,
          model: "offline-response-fixture", status: "completed", error: null, incomplete_details: null,
          output: [{ type: "message", id: "msg_archive", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: JSON.stringify({ decision }), annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }), { headers: { "Content-Type": "application/json" } });
      } });
    const result = await provider({ protocol: "touba-agent-decision-v1", mode: "summary", content_mode: "inline",
      agent_ref: "agent:distribution/Worker", agent_signature: { output_type: "builtin:Text" },
      capability_refs: [], capabilities: [], model_input: { protocol: "touba-agent-model-input-v1",
        user_input: { value: {} }, allowed_actions: ["answer_directly"], agent_state: {} } });
    assert.equal(result.result, "done"); assert.equal(calls, 1);
  }
}
console.log("SDK_ARCHIVE_OK");

function command(args) {
  const result = spawnSync(process.execPath, [process.argv[2], ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
