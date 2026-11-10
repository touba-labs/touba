import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Run the canonical approval/admission tests against the packaged runtime and
// SDKs installed from this payload. Only import/fixture/interpreter locations
// change. The reference model, compiler helper and LSP assertions use test sources.
const payload = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Usage: node check-approved-operation-distribution.mjs <toolchain>");
assert.ok(existsSync(path.join(payload, "TOOLCHAIN.json")), "A packaged toolchain is required");
const core = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "touba-approval-distribution-"));
const binary = path.join(payload, "bin", process.platform === "win32" ? "node.exe" : "node");
const cli = path.join(payload, "lib/cli/touba-project/src/main.mjs");
const sdk = path.join(scratch, "node_modules/@touba/sdk/src/index.mjs");
const python = path.join(scratch, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const env = { ...process.env, PYTHONPATH: "", npm_config_cache: path.join(scratch, "npm-cache"),
  TOUBA_COMPILE_BIN: path.join(payload, "bin", process.platform === "win32" ? "touba-compile.exe" : "touba-compile") };
for (const key of ["TOUBA_IMPLEMENTATION_DIR", "TOUBA_HOST_PYTHON", "TOUBA_SDK_SERVICE_COMMAND", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) delete env[key];
function run(args, timeout = 240_000) {
  const result = spawnSync(binary, args, { cwd: scratch, env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.equal(result.status, 0, result.error?.message ?? `Distribution qualification failed: ${args[0]}`);
  return result.stdout;
}
const read = relative => readFileSync(path.join(core, relative), "utf8");
try {
  run([cli, "sdk", "install", "javascript"]);
  run([cli, "sdk", "install", "python", "--manager", "pip"]);
  assert.ok(existsSync(sdk) && existsSync(python), "Both SDK installations are required");
  env.TOUBA_HOST_PYTHON = python;
  mkdirSync(path.join(scratch, "fixtures"));
  for (const name of ["approved-invoice.tb", "approved-payment.handler.mjs", "approved-payment.handler.py"]) {
    let source = read("runtime/touba-runtime/test/fixtures/" + name);
    if (name.endsWith(".mjs")) {
      const original = '"../../../touba-handler-sdk/src/index.mjs"';
      assert.ok(source.includes(original));
      source = source.replace(original, JSON.stringify(pathToFileURL(sdk).href));
    }
    if (name.endsWith(".py")) {
      const original = 'sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "touba-python-sdk" / "src"))';
      assert.ok(source.includes(original));
      source = source.replace(original, "# Use the wheel installed in this test interpreter.");
    }
    writeFileSync(path.join(scratch, "fixtures", name), source);
  }
  const files = [];
  for (const [relative, name] of [
    ["runtime/touba-runtime/test/tool-approval.test.mjs", "runtime.test.mjs"],
    ["runtime/touba-handler-sdk/test/tool-approval-engine.test.mjs", "engine.test.mjs"],
    ["runtime/touba-handler-sdk/test/engine-diagnostics.test.mjs", "diagnostics.test.mjs"],
    ["cli/touba-project/test/tool-approval-project.test.mjs", "project.test.mjs"],
    ["cli/touba-project/test/run-admission.test.mjs", "admission.test.mjs"],
    ["cli/touba-project/test/package-governance.test.mjs", "package-governance.test.mjs"],
    ["cli/touba-project/test/package-fragment-governance.test.mjs", "package-fragment-governance.test.mjs"],
    ["cli/touba-project/test/fragment-reconciliation.test.mjs", "fragment-reconciliation.test.mjs"],
    ["cli/touba-project/test/package-admission.test.mjs", "package-admission.test.mjs"],
  ]) {
    let source = read(relative);
    const resolveLocation = specifier => {
      const original = path.resolve(core, path.dirname(relative), specifier);
      const normalized = path.relative(core, original).split(path.sep).join("/");
      let target;
      if (normalized.startsWith("runtime/touba-handler-sdk/src/")) target = sdk;
      else if (normalized.includes("/test/fixtures/")) target = path.join(scratch, "fixtures", path.basename(original));
      // The source Python path is the fallback for source-only tests. With
      // TOUBA_HOST_PYTHON above it is unused: the wheel in the venv is exercised.
      else if (normalized === "runtime/touba-python-sdk/src" || ["tests/helpers/", "grammar/", "lsp/touba-lsp/src/", "contracts/reference-runtime/"].some(prefix => normalized.startsWith(prefix))) target = original;
      else target = path.join(payload, "lib", normalized);
      assert.ok(existsSync(target), `Missing qualified dependency: ${target}`);
      return pathToFileURL(target).href;
    };
    source = source.replace(/from "(\.[^"]+)"/g, (_match, specifier) => `from ${JSON.stringify(resolveLocation(specifier))}`);
    source = source.replace(/new URL\("([^"]+)", import.meta.url\)/g,
      (_match, specifier) => `new URL(${JSON.stringify(resolveLocation(specifier))})`);
    if (name === "runtime.test.mjs") {
      const original = 'sdk === "javascript" ? process.execPath : "python3"';
      assert.ok(source.includes(original));
      source = source.replace(original, `sdk === "javascript" ? process.execPath : ${JSON.stringify(python)}`);
    }
    const file = path.join(scratch, name);
    writeFileSync(file, source);
    files.push(file);
  }
  const output = run(["--test", "--test-concurrency=1", "--test-reporter=tap", ...files]);
  assert.match(output, /# tests 59\b/);
  assert.match(output, /# fail 0\b/);
  assert.match(output, /# skipped 0\b/);
  console.log("APPROVED_OPERATION_DISTRIBUTION_OK: 59 canonical tests against the packaged runtime, CLI, compiler and installed JavaScript/Python SDKs.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
