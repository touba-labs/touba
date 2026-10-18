import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectPythonSdkDependency } from "../src/python-sdk-dependency.mjs";

test("Python SDK readiness verifies installed sources without importing Python", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-python-readiness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(inspectPythonSdkDependency(root).code, "HandlerSdkMissing");
  const venv = join(root, ".venv");
  const installed = join(venv, process.platform === "win32" ? "Lib/site-packages/touba_sdk" : "lib/python3.14/site-packages/touba_sdk");
  mkdirSync(venv);
  writeFileSync(join(venv, "pyvenv.cfg"), "home = unused-for-static-check\n");
  cpSync(fileURLToPath(new URL("../../../runtime/touba-python-sdk/src/touba_sdk", import.meta.url)), installed, { recursive: true });
  assert.equal(inspectPythonSdkDependency(root).status, "ready");
  writeFileSync(join(installed, "__init__.py"), 'raise Exception("must not be executed")\n');
  assert.equal(inspectPythonSdkDependency(root).code, "HandlerSdkBuildMismatch");
  assert.equal(inspectPythonSdkDependency(root).status, "unavailable");
});
