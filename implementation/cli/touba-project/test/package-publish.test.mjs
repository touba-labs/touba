import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newPackage, versionPackage } from "../src/package-author.mjs";
import { addRegistryPackage } from "../src/packages.mjs";
import { publishPackage } from "../src/package-publish.mjs";
import { checkRegistry } from "../src/registry.mjs";
import { initProject, prepareProject } from "../src/project.mjs";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
function workspace(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-publish-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function author(root) { return newPackage("acme.echo", { root, publisher: "Acme", license: "MIT", description: "Echo supplied text." }).path; }

test("local CLI publication produces a valid draft registry, installable only with explicit opt-in", async t => {
  const root = workspace(t), source = author(root), registry = join(root, "registry");
  // Publication compiles but never executes author tests or hooks.
  writeFileSync(join(source, "tests/echo.test.mjs"), 'throw new Error("publication must not execute author code");');
  const published = spawnSync(process.execPath, [cli, "package", "publish", source, "--registry", registry, "--json"], { encoding: "utf8" });
  assert.equal(published.status, 0, published.stdout + published.stderr);
  assert.equal(JSON.parse(published.stdout).status, "success");
  const checked = await checkRegistry({ registry, sourceRoot: registry });
  assert.equal(checked.status, "success", JSON.stringify(checked));
  const cliCheck = spawnSync(process.execPath, [cli, "registry", "check", "--registry", registry, "--source-root", registry, "--json"], { encoding: "utf8" });
  assert.equal(cliCheck.status, 0, cliCheck.stderr);
  assert.equal(JSON.parse(cliCheck.stdout).status, "success");
  for (const args of [["registry", "--help"], ["registry", "check", "--help"]]) {
    const help = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /touba registry check/u);
  }
  const before = readFileSync(join(registry, "index.json"), "utf8");
  const index = JSON.parse(before);
  assert.equal(index.packages[0].status, "draft");
  await assert.rejects(publishPackage(source, { registry }), { code: "RegistryPublishedVersionImmutable" });
  assert.equal(readFileSync(join(registry, "index.json"), "utf8"), before);
  const project = join(root, "consumer"); initProject({ root: project });
  const options = { registry, version: "0.1.0", root: project };
  await assert.rejects(addRegistryPackage("acme.echo", options), /draft packages require --allow-draft/);
  assert.equal(existsSync(join(project, "packages/acme.echo")), false);
  await addRegistryPackage("acme.echo", { ...options, "allow-draft": true });
  mkdirSync(join(project, "src/client"), { recursive: true });
  writeFileSync(join(project, "src/client/main.tb"), `module client.main
import skill Echo from acme.echo
strategy Run
    takes value as Text
    gives Text
    uses Echo
    do
        Echo
            with value as value
            into result
        give result
`);
  const prepared = await prepareProject({ root: project, mode: "write", entryRef: "strategy:client.main/Run" });
  assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
  const air = JSON.parse(readFileSync(join(project, ".touba/build/dev/air/client/main.air.json")));
  const result = await executeAirDocument(air, { entryRef: "strategy:client.main/Run", inputs: { value: "Published package works" } });
  assert.equal(result.result, "Published package works");
  versionPackage("patch", { root: source });
  await publishPackage(source, { registry });
  const after = JSON.parse(readFileSync(join(registry, "index.json")));
  assert.equal(after.packages.length, 2);
  assert.deepEqual(after.packages.find(p => p.version === "0.1.0"), index.packages[0]);
  assert.equal((await checkRegistry({ registry, sourceRoot: registry })).status, "success");
  assert.equal(existsSync(join(registry, ".touba-registry-publishing")), false);
});

test("publication refuses links, conflicts, concurrent writers and unsupported remote targets", async t => {
  const root = workspace(t), source = author(root), registry = join(root, "registry");
  mkdirSync(registry);
  await assert.rejects(publishPackage(source, { registry: "https://example.invalid/registry" }), { code: "PackagePublicationTargetInvalid" });
  const alias = join(root, "alias"); symlinkSync(registry, alias, "dir");
  await assert.rejects(publishPackage(source, { registry: alias }), { code: "PackagePublicationTargetInvalid" });
  const lock = join(registry, ".touba-registry-publishing"); writeFileSync(lock, "another publisher");
  await assert.rejects(publishPackage(source, { registry }), { code: "PackagePublicationBusy" });
  assert.equal(readFileSync(lock, "utf8"), "another publisher"); rmSync(lock);
  const archives = join(registry, "archives"); symlinkSync(root, archives, "dir");
  await assert.rejects(publishPackage(source, { registry }), /PackageSymlinkForbidden/);
  assert.equal(existsSync(join(registry, "index.json")), false); rmSync(archives);
  mkdirSync(archives); const orphan = join(archives, "acme.echo-0.1.0.tar.gz"); writeFileSync(orphan, "preserve evidence");
  await assert.rejects(publishPackage(source, { registry }), { code: "PackagePublicationConflict" });
  assert.equal(readFileSync(orphan, "utf8"), "preserve evidence");
  assert.equal(existsSync(lock), false);
});
