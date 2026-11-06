import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const env = { ...process.env, TOUBA_TEST_BWRAP: process.env.TOUBA_TEST_BWRAP ?? "/usr/bin/bwrap",
    TOUBA_TEST_SANDBOX_LAUNCHER: path.join(payload, "bin/touba-sandbox"),
    TOUBA_COMPILE_BIN: path.join(payload, "bin/touba-compile") };
  for (const key of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "TOUBA_IMPLEMENTATION_DIR"]) delete env[key];
  env.TOUBA_SANDBOX_LAUNCHER = env.TOUBA_TEST_SANDBOX_LAUNCHER;
  env.TOUBA_BWRAP_COMMAND = env.TOUBA_TEST_BWRAP;
  if (process.platform === "linux") assert.ok(existsSync(env.TOUBA_TEST_SANDBOX_LAUNCHER) && existsSync(env.TOUBA_TEST_BWRAP));
  if (process.platform === "linux") {
    const launcherProbe = spawnSync(env.TOUBA_TEST_SANDBOX_LAUNCHER, ["--probe"], {env:{},encoding:"utf8",timeout:5000});
    console.log("NATIVE_SANDBOX_LAUNCHER", JSON.stringify({status:launcherProbe.status,stdout:launcherProbe.stdout,stderr:launcherProbe.stderr}));
    const {linuxHandlerSandboxPlan} = await import(pathToFileURL(path.join(payload,"lib/runtime/touba-runtime/src/linux-handler-sandbox.mjs")));
    const plan = linuxHandlerSandboxPlan({handler:{command:"/usr/bin/true",args:[],cwd:"/"},grants:[],sandbox:{}},"/usr/bin/true",
      {bwrap:env.TOUBA_TEST_BWRAP,launcher:env.TOUBA_TEST_SANDBOX_LAUNCHER});
    const filter=path.join(scratch,"probe.filter"),policy=path.join(scratch,"probe.policy");
    writeFileSync(filter,plan.seccomp,{mode:0o600});writeFileSync(policy,plan.policy,{mode:0o600});
    const fds=[openSync(filter,"r"),openSync(policy,"r")];
    try {
      const probe=spawnSync(plan.command,plan.args,{env:{},encoding:"utf8",timeout:5000,stdio:["ignore","pipe","pipe","ignore",...fds]});
      console.log("NATIVE_SANDBOX_POLICY",JSON.stringify({status:probe.status,stdout:probe.stdout,stderr:probe.stderr}));
      assert.equal(probe.status,0,"Required sandbox must start the permitted control before native tests");
    } finally {fds.forEach(fd=>closeSync(fd));}
  }
  // Exercise the installed wheel, venv and explicit fragment as well as the
  // raw protocol. The old protocol-only checks missed real SDK import failures.
  const node = path.join(payload, "bin/node");
  const cli = path.join(payload, "lib/cli/touba-project/src/main.mjs");
  const install = spawnSync(node, [cli, "sdk", "install", "python", "--manager", "pip"],
    { cwd: scratch, env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
  assert.equal(install.status, 0, install.error?.message ?? install.stderr ?? "Packaged Python SDK installation failed");
  const python = path.join(scratch, ".venv/bin/python");
  const probe = spawnSync(python, ["-I", "-B", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    { cwd: scratch, env, encoding: "utf8", timeout: 10000 });
  assert.equal(probe.status, 0, probe.stderr);
  const pythonSdk = path.join(probe.stdout.trim(), "touba_sdk");
  const packageSourcePath = path.join(implementation, "cli/touba-project/test/python-package-sandbox.test.mjs");
  const location = specifier => {
    const relative = path.relative(implementation, path.resolve(path.dirname(packageSourcePath), specifier));
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative));
    const destination = relative.split(path.sep).join("/") === "runtime/touba-python-sdk/src/touba_sdk"
      ? pythonSdk : path.join(payload, "lib", relative);
    assert.ok(existsSync(destination), `Missing packaged Python sandbox dependency: ${relative}`);
    return pathToFileURL(destination).href;
  };
  const packageSource = readFileSync(packageSourcePath, "utf8")
    .replace(/from "(\.[^"]+)"/g, (_match, specifier) => `from ${JSON.stringify(location(specifier))}`)
    .replace(/new URL\("([^"]+)", import.meta.url\)/g, (_match, specifier) => `new URL(${JSON.stringify(location(specifier))})`);
  const packageTest = path.join(scratch, "python-package-sandbox.test.mjs");
  writeFileSync(packageTest, packageSource);
  env.TOUBA_TEST_SANDBOX_PYTHON = python;
  const result = spawnSync(node, ["--test", "--test-concurrency=1", "--test-reporter=tap", testFile, packageTest],
    { cwd: scratch, env, encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  assert.equal(result.status, 0, result.error?.message ?? "Packaged sandbox qualification failed");
  assert.match(result.stdout, new RegExp(`# tests ${process.platform === "linux" ? 4 : 3}\\b`));
  assert.match(result.stdout, /# fail 0\b/);
  assert.match(result.stdout, /# skipped 0\b/);
  console.log(`HANDLER_SANDBOX_DISTRIBUTION_OK: ${process.platform}, packaged runtime, Python SDK package, explicit fragment and permitted controls.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
