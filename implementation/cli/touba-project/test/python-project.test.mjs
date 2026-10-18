import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initProject, prepareProject } from "../src/project.mjs";

const source = `module python.demo
tool Normalize
    takes value as Text
    gives Text
strategy Run
    takes value as Text
    gives Text
    uses Normalize
    do
        Normalize
            with value as value
            into result
        give result
`;
const tool = "tool:python.demo/Normalize";
const decisions = { bindings: { [tool]: { grants: [], effect_contract: { kind: "none" } } } };

test("Python init and prepare generate Python handlers and executable admission tests without importing business code", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-python-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(initProject({ root, language: "py" }).sdk, "touba-sdk");
  mkdirSync(join(root, "src/python"), { recursive: true });
  writeFileSync(join(root, "src/python/demo.tb"), source);
  const report = await prepareProject({ root, mode: "write", hostDecisions: decisions });
  assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
  const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json")));
  assert.match(manifest.bindings[tool].handler.command, /\.venv\/.*python/);
  assert.deepEqual(manifest.bindings[tool].grants, []);
  const handler = join(root, manifest.bindings[tool].handler.args[0]);
  const code = readFileSync(handler, "utf8");
  assert.match(code, /from touba_sdk import/);
  assert.match(code, /async def run/);
  const python = process.env.TOUBA_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const contract = handler.replace(/\.handler\.py$/, ".handler.contract.test.py");
  const result = spawnSync(python, [contract], { encoding: "utf8", env: { ...process.env,
    PYTHONPATH: fileURLToPath(new URL("../../../runtime/touba-python-sdk/src", import.meta.url)) } });
  assert.equal(result.status, 0, result.stderr);
  // prepare only reads generated literals; it must not evaluate this Python code.
  writeFileSync(handler, code.replace('REQUIRED_GRANTS = json.loads("[]")', 'REQUIRED_GRANTS = json.loads("[\\"network\\"]")') + '\nraise RuntimeError("do not execute during prepare")\n');
  const checked = await prepareProject({ root, mode: "check" });
  assert.equal(checked.status, "error");
  assert.ok(checked.diagnostics.some(d => d.code === "HandlerDeclaredContractDrift"), JSON.stringify(checked.diagnostics));
  assert.match(readFileSync(handler, "utf8"), /do not execute during prepare/);
});
