import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../src/project.mjs";
import { newPackage, addPackage, updatePackage } from "../src/packages.mjs";
import { readPackageWorkspace, verifyInstalledPackages } from "../src/package-store.mjs";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-package-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const consumer = join(root, "consumer"); initProject({ root: consumer });
  const source = newPackage("fixture.update", { root, version: "1.0.0" }).path;
  await addPackage(source, { root: consumer });
  const path = join(source, "touba.package.json");
  const version = value => writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path)), version: value }));
  const lock = () => verifyInstalledPackages(consumer, readPackageWorkspace(consumer).records);
  return { consumer, source, version, lock };
}

test("explicit update changes only the selected package and keeps consumer governance", async t => {
  const f = await fixture(t);
  const configPath = join(f.consumer, "touba.project.json");
  const config = JSON.parse(readFileSync(configPath));
  config.governance = { retained: "consumer minimum must survive" };
  writeFileSync(configPath, JSON.stringify(config));
  f.version("1.1.0");
  await assert.rejects(addPackage(f.source, { root: f.consumer }), { code: "PackageDependencyConflict" });
  const result = await updatePackage(f.source, { root: f.consumer, name: "fixture.update" });
  assert.equal(result.command, "package update"); assert.equal(f.lock().packages[0].version, "1.1.0");
  assert.deepEqual(JSON.parse(readFileSync(configPath)).governance, config.governance);
  assert.equal(existsSync(join(f.consumer, ".touba-package-installing")), false);
  await assert.rejects(updatePackage(f.source, { root: f.consumer, name: "fixture.update" }), { code: "PackageVersionConflict" });
  f.version("1.0.0");
  await assert.rejects(updatePackage(f.source, { root: f.consumer, name: "fixture.update" }), { code: "PackageVersionConflict" });
  assert.equal(f.lock().packages[0].version, "1.1.0");
});

test("update refuses identity changes and tampered installed content before replacing it", async t => {
  const f = await fixture(t); f.version("1.1.0");
  await assert.rejects(updatePackage(f.source, { root: f.consumer, name: "fixture.missing" }), { code: "PackageNotInstalled" });
  const manifest = join(f.consumer, "packages/fixture.update/touba.package.json");
  writeFileSync(manifest, readFileSync(manifest, "utf8") + "\n");
  await assert.rejects(updatePackage(f.source, { root: f.consumer, name: "fixture.update" }), { code: "PackageIntegrityMismatch" });
  assert.equal(JSON.parse(readFileSync(manifest)).version, "1.0.0");
});
