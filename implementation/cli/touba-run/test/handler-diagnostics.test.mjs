import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { prepareProject } from "../../touba-project/src/project.mjs";
import { openLocalHandlerDiagnostics, validatedHandlerDiagnostic } from "../../../runtime/touba-runtime/src/handler-diagnostics.mjs";

const cli = fileURLToPath(new URL("../src/run.mjs", import.meta.url));
const sdk = new URL("../../../runtime/touba-handler-sdk/src/index.mjs", import.meta.url).href;
const sentinel = "diagnostic-secret-do-not-leak";
const unknownSecret = "unregistered-sensitive-do-not-leak";
const tool = "tool:diagnostic.example/Normalize";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-local-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src/diagnostic"), { recursive: true });
  writeFileSync(join(root, "src/diagnostic/example.tb"), `module diagnostic.example
tool Normalize
    takes ticket as Text
    gives Text
    requires secret_read
    secrets DEBUG_TOKEN
strategy Run
    takes ticket as Text
    gives Text
    uses Normalize
    do
        Normalize
            with ticket as ticket
            into normalized
        give normalized
`);
  const report = await prepareProject({ root, mode: "write", hostDecisions: { bindings: {
    [tool]: { grants: ["secret_read"], secrets: ["DEBUG_TOKEN"], effect_contract: { kind: "none" } },
  } } });
  assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
  const manifest = JSON.parse(readFileSync(report.manifest_path, "utf8"));
  const handler = manifest.bindings[tool].handler.args[0];
  const handlerPath = join(root, handler);
  const handlerCode = body => `import { defineTool } from ${JSON.stringify(sdk)};
await defineTool({ toolRef: ${JSON.stringify(tool)}, requiredGrants:["secret_read"], requiredSecretHandles:["DEBUG_TOKEN"],
inputSignature:[{name:"ticket",type_ref:"builtin:Text"}], outputType:"builtin:Text", run: async ({request}) => { ${body} } });
`;
  writeFileSync(handlerPath, handlerCode(`throw new TypeError(process.env.DEBUG_TOKEN + ${JSON.stringify(unknownSecret)});`));
  const secrets = join(root, "secrets.json");
  writeFileSync(secrets, JSON.stringify({ secrets_version: "touba-secrets-v1", secrets: { DEBUG_TOKEN: { source: "env", name: "DEBUG_TOKEN" } } }));
  const plan = join(root, ".touba/build/dev/touba.run-plan.json");
  const run = (args = [], planPath = plan) => spawnSync(process.execPath, [cli, "--run-plan", planPath,
    "--secrets", secrets, "--inputs-json", '{"ticket":"test"}', "--output", "json", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, DEBUG_TOKEN: sentinel,
      TOUBA_LOCAL_DIAGNOSTIC_FD: "3", TOUBA_LOCAL_DIAGNOSTIC_SOURCES: "[]" },
  });
  return { root, plan, handlerPath, handlerCode, run };
}

test("local opt-in records actual SDK exception location without secrets, messages or public trace fields", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  const plain = f.run();
  assert.equal(plain.status, 1, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).reason, "ToolHandlerReportedError");
  const path = join(f.root, "diagnostics.jsonl");
  const run = f.run(["--handler-diagnostics", path]);
  assert.equal(run.status, 1, run.stderr);
  const entry = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(entry.error_class, "TypeError");
  assert.equal(entry.line, 3);
  assert.equal(entry.handler_arg_index, 0);
  assert.ok(entry.call_id.startsWith("call:"));
  assert.equal(entry.tool_ref, tool);
  assert.equal(entry.reason, "ToolHandlerReportedError");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const output of [plain.stdout + plain.stderr, run.stdout + run.stderr, readFileSync(path, "utf8")]) {
    assert.equal(output.includes(sentinel), false);
    assert.equal(output.includes(unknownSecret), false);
  }
  assert.equal(run.stdout.includes("handler_arg_index"), false);
  assert.equal(run.stdout.includes("diagnostics.jsonl"), false);
  const existing = readFileSync(path, "utf8");
  const repeat = f.run(["--handler-diagnostics", path]);
  assert.equal(JSON.parse(repeat.stdout).reason, "HandlerDiagnosticsUnavailable");
  assert.equal(readFileSync(path, "utf8"), existing);
  const link = join(f.root, "linked.jsonl");
  symlinkSync(path, link);
  assert.equal(JSON.parse(f.run(["--handler-diagnostics", link]).stdout).reason, "HandlerDiagnosticsUnavailable");
});

test("startup failures retain only class and selected source position before the SDK loads", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  writeFileSync(f.handlerPath, `throw new TypeError(${JSON.stringify(unknownSecret)});`);
  const path = join(f.root, "startup.jsonl");
  const run = f.run(["--handler-diagnostics", path]);
  assert.equal(JSON.parse(run.stdout).reason, "ToolHandlerNonZeroExit");
  const entry = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(entry.error_class, "TypeError");
  assert.equal(entry.line, 1);
  assert.equal(entry.handler_arg_index, 0);
  assert.doesNotMatch(run.stdout + run.stderr + readFileSync(path, "utf8"), new RegExp(unknownSecret));
});

test("prod and locked runs refuse diagnostics before invoking the handler", async t => {
  const f = await fixture(t);
  const original = JSON.parse(readFileSync(f.plan, "utf8"));
  const path = join(f.root, "forbidden.jsonl");
  // Keep all relative references valid: replace only the profile in the same plan.
  writeFileSync(f.plan, JSON.stringify({ ...original, profile: "prod", supply_chain_lock: "missing-lock.json" }));
  const prod = f.run(["--handler-diagnostics", path]);
  assert.equal(JSON.parse(prod.stdout).reason, "HandlerDiagnosticsForbidden");
  assert.equal(existsSync(path), false);
  writeFileSync(f.plan, JSON.stringify(original));
  const locked = f.run(["--require-supply-chain-lock", "--handler-diagnostics", path]);
  assert.equal(JSON.parse(locked.stdout).reason, "HandlerDiagnosticsForbidden");
  assert.equal(existsSync(path), false);
  const hardened = f.run(["--hardened-profile", "not-loaded.json", "--handler-diagnostics", path]);
  assert.equal(JSON.parse(hardened.stdout).reason, "HandlerDiagnosticsForbidden");
  assert.equal(existsSync(path), false);
});

test("Windows refuses the POSIX diagnostic channel before dispatch", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const diagnostic = join(f.root, "diagnostic.jsonl");
  const run = f.run(["--handler-diagnostics", diagnostic]);
  assert.equal(run.status, 2, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.reason, "HandlerDiagnosticsForbidden");
  assert.deepEqual(result.trace.events.map(event => event.kind), ["admission_refused"]);
  assert.equal(existsSync(diagnostic), false);
});

test("ambient diagnostic variables never activate the child channel without the CLI opt-in", async t => {
  const f = await fixture(t);
  writeFileSync(f.handlerPath, f.handlerCode('if (process.env.TOUBA_LOCAL_DIAGNOSTIC_FD) throw new Error("unexpected channel"); return request;'));
  const run = f.run();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).result, "test");
});

test("malicious private data is discarded and non-zero stderr never enters public output", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  writeFileSync(f.handlerPath, `import { writeSync } from "node:fs";
if (process.env.TOUBA_LOCAL_DIAGNOSTIC_FD) writeSync(3, "x".repeat(20000) + process.env.DEBUG_TOKEN);
process.stderr.write(process.env.DEBUG_TOKEN + ${JSON.stringify(unknownSecret)});
process.exit(3);
`);
  const path = join(f.root, "malicious.jsonl");
  const run = f.run(["--handler-diagnostics", path]);
  assert.equal(JSON.parse(run.stdout).reason, "ToolHandlerNonZeroExit");
  assert.match(run.stderr, /diagnostics are incomplete/u);
  const entry = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(entry.error_class, undefined);
  assert.equal(entry.reason, "ToolHandlerNonZeroExit");
  assert.ok(statSync(path).size < 1024);
  for (const output of [run.stdout + run.stderr, readFileSync(path, "utf8"), f.run().stdout]) {
    assert.equal(output.includes(sentinel), false);
    assert.equal(output.includes(unknownSecret), false);
  }
});

test("diagnostic validator uses a closed vocabulary and the private file has hard bounds", t => {
  const sources = [{ index: 0, path: "/tmp/handler.mjs" }];
  for (const value of [{ error_class: "SecretValue" }, { error_class: "Error", message: sentinel },
    { error_class: "Error", line: 1 }, { error_class: "Error", handler_arg_index: 2, line: 1, column: 1 },
    { error_class: "Error", handler_arg_index: 0, line: 1, column: -1 }]) {
    assert.equal(validatedHandlerDiagnostic(JSON.stringify(value), sources), null);
  }
  const root = mkdtempSync(join(tmpdir(), "touba-diagnostic-bound-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "private.jsonl");
  const sink = openLocalHandlerDiagnostics(path);
  for (let i = 0; i < 1000; i++) sink.record({ reason: "completed", tool_ref: tool });
  assert.equal(sink.incomplete, true);
  sink.close();
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 128);
  assert.ok(statSync(path).size <= 65536);
});
