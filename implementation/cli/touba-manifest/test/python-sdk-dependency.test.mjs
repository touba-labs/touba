import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectPythonSdkDependency, pythonSdkSourceIdentity } from "../src/python-sdk-dependency.mjs";

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
  const nested = join(installed, "budget/sqlite.py"), original = readFileSync(nested);
  writeFileSync(nested, 'raise Exception("nested source must not be imported")\n');
  assert.equal(inspectPythonSdkDependency(root).code, "HandlerSdkBuildMismatch");
  writeFileSync(nested, original);
  assert.equal(inspectPythonSdkDependency(root).status, "ready");
  writeFileSync(join(installed, "__init__.py"), 'raise Exception("must not be executed")\n');
  assert.equal(inspectPythonSdkDependency(root).code, "HandlerSdkBuildMismatch");
  assert.equal(inspectPythonSdkDependency(root).status, "unavailable");
});

test("Python SDK identity covers nested source paths and refuses linked directories", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-python-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "budget"));
  writeFileSync(join(root, "__init__.py"), "");
  writeFileSync(join(root, "budget/sqlite.py"), "source = 1\n");
  const first = pythonSdkSourceIdentity(root);
  writeFileSync(join(root, "budget/sqlite.py"), "source = 2\n");
  assert.notEqual(pythonSdkSourceIdentity(root), first);
  if (process.platform !== "win32") {
    symlinkSync(join(root, "budget"), join(root, "alias"));
    assert.throws(() => pythonSdkSourceIdentity(root), /must not contain links/);
  }
});

test("linked project environments have an actionable diagnostic, including dangling links", { skip: process.platform === "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "touba-python-linked-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shared = join(root, "shared"), project = join(root, "project");
  mkdirSync(shared); mkdirSync(project);
  writeFileSync(join(shared, "pyvenv.cfg"), "home = unused\n");
  symlinkSync(shared, join(project, ".venv"));
  for (const dangling of [false, true]) {
    if (dangling) rmSync(shared, { recursive: true });
    const result = inspectPythonSdkDependency(project);
    assert.equal(result.code, "HandlerSdkInvalid");
    assert.match(result.message, /\.venv is a symbolic link/);
    assert.match(result.message, /dedicated .venv directory/);
  }
});
