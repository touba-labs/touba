import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject, prepareProject } from "../src/project.mjs";
import { generateSupplyChainLock } from "../../touba-supply-chain/src/generate.mjs";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
test("init/prepare/project run share one layout across profiles, spaces and relocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba canonical project "));
  const moved = mkdtempSync(join(tmpdir(), "touba moved project "));
  try {
    initProject({ root });
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/hello.tb"), 'module examples.hello\nstrategy Run\n    gives Text\n    do\n        give "ready"\n');
    for (const profile of ["pure", "dev", "prod"]) {
      const plan = await prepareProject({ root, mode: "plan", runProfile: profile });
      assert.equal(existsSync(join(root, `.touba/build/${profile}/air/examples/hello.air.json`)), false);
      assert.equal(plan.run_plan_path, join(root, `.touba/build/${profile}/touba.run-plan.json`));
      const prepared = await prepareProject({ root, mode: "write", runProfile: profile });
      assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
      if (profile === "prod") {
        generateSupplyChainLock({ air: join(root, ".touba/build/prod/air/examples/hello.air.json"), out: join(root, "touba.lock.json") });
        const pending = spawnSync(process.execPath, [cli, "run", "--project", root, "--profile", profile, "--output", "json"], { encoding: "utf8" });
        assert.equal(pending.status, 1, pending.stdout + pending.stderr);
        // Explicit synthetic reviewer fixture, never performed by lock generation.
        const lockPath = join(root, "touba.lock.json");
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        lock.review = { status: "approved", reviewed_at: new Date().toISOString(), reviewers: [{ kind: "human", id: "test:reviewer" }] };
        writeFileSync(lockPath, JSON.stringify(lock));
      }
      const run = spawnSync(process.execPath, [cli, "run", "--project", root, "--profile", profile, "--output", "json"], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.equal(JSON.parse(run.stdout).result, "ready");
    }
    assert.equal(existsSync(join(root, ".touba/air")), false);
    assert.equal(existsSync(join(root, ".touba/secrets.local.json")), false);
    cpSync(root, moved, { recursive: true });
    const run = spawnSync(process.execPath, [cli, "run", "--project", moved, "--profile", "prod", "--output", "json"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(JSON.parse(run.stdout).result, "ready");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(moved, { recursive: true, force: true }); }
});
