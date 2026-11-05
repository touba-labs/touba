import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Executes native refusal and permitted-control tests against the exact payload.
// Windows confinement is intentionally outside this qualification (V2).
const payload = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && existsSync(path.join(payload, "TOOLCHAIN.json")), "A packaged toolchain is required");
assert.ok(["darwin", "linux"].includes(process.platform), "Native macOS or Linux host required");
const implementation = fileURLToPath(new URL("../", import.meta.url));
const filename = process.platform === "linux" ? "linux-handler-sandbox-native.test.mjs" : "handler-sandbox-os.test.mjs";
const sourcePath = path.join(implementation, "runtime/touba-runtime/test", filename);
let source = readFileSync(sourcePath, "utf8");
source = source.replace(/from "(\.[^"]+)"/g, (_match, specifier) => {
  const relative = path.relative(implementation, path.resolve(path.dirname(sourcePath), specifier));
  assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative));
  const destination = path.join(payload, "lib", relative);
  assert.ok(existsSync(destination), `Missing packaged sandbox module: ${relative}`);
  return `from ${JSON.stringify(pathToFileURL(destination).href)}`;
});
const scratch = mkdtempSync(path.join(tmpdir(), "touba-sandbox-distribution-"));
try {
  const testFile = path.join(scratch, filename);
  writeFileSync(testFile, source);
  const env = { ...process.env, TOUBA_TEST_BWRAP: "/usr/bin/bwrap",
    TOUBA_TEST_SANDBOX_LAUNCHER: path.join(payload, "bin/touba-sandbox") };
  for (const key of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "TOUBA_IMPLEMENTATION_DIR"]) delete env[key];
  if (process.platform === "linux") assert.ok(existsSync(env.TOUBA_TEST_SANDBOX_LAUNCHER) && existsSync(env.TOUBA_TEST_BWRAP));
  const result = spawnSync(path.join(payload, "bin/node"), ["--test", "--test-reporter=tap", testFile],
    { cwd: scratch, env, encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  assert.equal(result.status, 0, result.error?.message ?? "Packaged sandbox qualification failed");
  assert.match(result.stdout, new RegExp(`# tests ${process.platform === "linux" ? 3 : 2}\\b`));
  assert.match(result.stdout, /# fail 0\b/);
  assert.match(result.stdout, /# skipped 0\b/);
  console.log(`HANDLER_SANDBOX_DISTRIBUTION_OK: ${process.platform}, packaged runtime and permitted controls.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
