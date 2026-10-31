import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, newModule, prepareProject } from "../../touba-project/src/project.mjs";
import { refreshProject, buildAuthorityGraph } from "../src/serve.mjs";
import { readPreparedProject } from "../src/prepared-project.mjs";

test("partial project inventory is explicit and keeps prepared execution artifacts", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-inventory-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject({ root });
  const module = newModule("inventory.main", { root });
  writeFileSync(module.source_path, 'module inventory.main\nskill Hello\n    gives Text\n    do\n        give "hello"\n');
  assert.equal((await prepareProject({ root, mode: "write" })).status, "success");
  const prepared = readPreparedProject(root);
  mkdirSync(join(root, "aaa-fixtures"));
  for (let i = 0; i < 210; i++) writeFileSync(join(root, "aaa-fixtures", `${i}.tb`), `module fixtures.n${i}\n`);
  const { report } = refreshProject({ projectRoot: root });
  assert.equal(report.artifacts.length, 200);
  assert.equal(report.diagnostics.filter(item => item.code === "ToubaServeProjectInventoryLimited").length, 1);
  for (const input of prepared.inputs.filter(input => ["air", "manifest", "run_plan"].includes(input.kind))) {
    assert.ok(report.artifacts.some(artifact => artifact.relative_path === input.path), input.path);
  }
  assert.ok(buildAuthorityGraph({ projectRoot: root }).diagnostics.some(item => item.code === "ToubaServeProjectInventoryLimited"));
});

test("project inventory distinguishes an exact bound from an uninspected depth", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-inventory-depth-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 200; i++) writeFileSync(join(root, `${i}.tb`), `module fixtures.n${i}\n`);
  const exact = refreshProject({ projectRoot: root }).report;
  assert.equal(exact.artifacts.length, 200);
  assert.equal(exact.diagnostics.some(item => item.code === "ToubaServeProjectInventoryLimited"), false);
  const deep = join(root, "deep", "two", "three", "four", "five", "six", "seven");
  mkdirSync(deep, { recursive: true }); writeFileSync(join(deep, "hidden.tb"), "module hidden\n");
  const limited = refreshProject({ projectRoot: root }).report;
  assert.equal(limited.diagnostics.filter(item => item.code === "ToubaServeProjectScanDepthLimited").length, 1);
});
