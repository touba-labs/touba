import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { packagePythonSdk } from "../cli/touba-distribution/src/package-python-sdk.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "touba-python-install-check-"));
const python = process.env.TOUBA_PYTHON_BUILD_BIN || "python3";
const env = { ...process.env, PYTHONPATH: "", TOUBA_TEST_NODE: process.execPath,
  TOUBA_TEST_CLI: process.env.TOUBA_TEST_CLI || join(root, "cli/touba-project/src/main.mjs") };
function run(command, args) {
  const result = spawnSync(command, args, { cwd: temporary, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error("Python SDK installed qualification failed");
}
try {
  const metadata = packagePythonSdk(root, temporary);
  const venv = join(temporary, "venv");
  run(python, ["-m", "venv", venv]);
  const installed = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  run(installed, ["-m", "pip", "install", "--disable-pip-version-check", "--no-index", "--no-deps", join(temporary, metadata.archive)]);
  run(installed, ["-c", "import touba_sdk; assert 'site-packages' in touba_sdk.__file__; print(touba_sdk.sdk_metadata())"]);
  run(installed, ["-m", "unittest", "discover", "-s", join(root, "runtime/touba-python-sdk/tests"), "-v"]);
} finally { rmSync(temporary, { recursive: true, force: true }); }
