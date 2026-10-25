import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagePythonSdk } from "./package-python-sdk.mjs";
import { installSdk } from "../../touba-project/src/sdk-command.mjs";

const implementation = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const python = process.env.TOUBA_PYTHON_BUILD_BIN || (process.platform === "win32" ? "python" : "python3");
function run(command, args, root) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 60000,
    env: { ...process.env, UV_OFFLINE: "true", UV_PYTHON_DOWNLOADS: "never" } });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

test("real Python wheel installs offline with pip and uv; uv sync preserves the dependency", { timeout: 180000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "touba-sdk-python-"));
  const previousCache = process.env.UV_CACHE_DIR;
  process.env.UV_CACHE_DIR = join(root, "uv-cache");
  t.after(() => {
    if (previousCache === undefined) delete process.env.UV_CACHE_DIR;
    else process.env.UV_CACHE_DIR = previousCache;
    rmSync(root, { recursive: true, force: true });
  });
  const distributionRoot = join(root, "distribution");
  const python_sdk = packagePythonSdk(implementation, distributionRoot);
  writeFileSync(join(distributionRoot, "TOOLCHAIN.json"), JSON.stringify({ python_sdk }));
  for (const manager of ["pip", "uv"]) {
    const project = join(root, `${manager} project`); mkdirSync(project);
    const installed = installSdk("python", { root: project, distributionRoot, manager, python });
    assert.equal(installed.manager, manager);
    assert.match(run(installed.python, ["-I", "-c", "import touba_sdk; print(touba_sdk.__file__)"], project), /touba_sdk/);
    assert.equal(existsSync(join(project, "pyproject.toml")), false, "standalone installation does not invent a Python project");
    installSdk("python", { root: project, distributionRoot, manager, python });
  }
  const project = join(root, "managed project"); mkdirSync(project);
  writeFileSync(join(project, "pyproject.toml"), '[project]\nname="storage-test"\nversion="0.1.0"\nrequires-python=">=3.11"\ndependencies=[]\n');
  run("uv", ["lock", "--offline", "--python", python], project);
  const before = readFileSync(join(project, "uv.lock"), "utf8");
  assert.throws(() => installSdk("python", { root: project, distributionRoot, manager: "pip", python }), /uv.lock/);
  assert.equal(readFileSync(join(project, "uv.lock"), "utf8"), before);
  const installed = installSdk("python", { root: project, distributionRoot, python });
  assert.equal(installed.manager, "uv");
  assert.match(readFileSync(join(project, "pyproject.toml"), "utf8"), /touba-sdk/);
  assert.match(readFileSync(join(project, "uv.lock"), "utf8"), /vendor\/touba-sdk\//);
  run("uv", ["sync", "--frozen", "--offline", "--no-build", "--python", installed.python], project);
  run(installed.python, ["-I", "-c", "from touba_sdk import ToubaEngine, AsyncToubaEngine"], project);
});
