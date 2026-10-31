import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectPackageSurface } from "../src/package-surface.mjs";
import { newPackage, packPackage, unpackPackage } from "../../touba-project/src/packages.mjs";
import { initProject } from "../../touba-project/src/project.mjs";
import { validateObject } from "../../../contracts/product-surfaces/validate.mjs";
import previewSchema from "../../../contracts/product-surfaces/schemas/touba-project-package-preview-v1.schema.json" with { type: "json" };
import inventorySchema from "../../../contracts/product-surfaces/schemas/touba-project-packages-v1.schema.json" with { type: "json" };

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-studio-package-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const consumer = join(root, "consumer"); mkdirSync(consumer);
  initProject({ root: consumer, language: "javascript" });
  const pkg = newPackage("fixture.echo", { root, publisher: "Fixture", description: "Isolated source check", license: "Apache-2.0", version: "1.0.0" });
  const packed = await packPackage(pkg.path, { output: join(root, "archive.tar.gz") });
  let time = Date.now();
  const surface = createProjectPackageSurface(consumer, { now: () => time });
  t.after(() => surface.close());
  return { surface, root: consumer, archive: packed.output, bytes: readFileSync(packed.output), advance: () => { time += 301000; } };
}

test("client package archive is checked, confirmed once, installed with canonical lock and no grants", async t => {
  const { surface, root, bytes } = await fixture(t);
  const before = readFileSync(join(root, "touba.project.json"));
  const preview = await surface.preview("alice", bytes);
  assert.deepEqual(validateObject(previewSchema, preview), []);
  assert.equal(preview.name, "fixture.echo");
  assert.deepEqual(readFileSync(join(root, "touba.project.json")), before);
  await assert.rejects(surface.apply("bob", preview), { code: "ToubaServePackagePreviewMissing" });
  await assert.rejects(surface.apply("alice", { ...preview, archive_digest: "sha256:forged" }), { code: "ToubaServePackageConflict" });
  const result = await surface.apply("alice", preview);
  assert.equal(result.status, "success");
  const inventory = surface.inventory();
  assert.deepEqual(validateObject(inventorySchema, inventory), []);
  assert.equal(inventory.packages.length, 1);
  assert.equal(inventory.packages[0].name, "fixture.echo");
  assert.match(inventory.packages[0].digest, /^sha256:/);
  const project = JSON.parse(readFileSync(join(root, "touba.project.json")));
  assert.equal(project.grants, undefined);
  await assert.rejects(surface.apply("alice", preview), { code: "ToubaServePackagePreviewMissing" });
});

test("client package previews refuse malformed archive, stale project, expiry and wrong cancellation owner", async t => {
  const { surface, root, bytes, advance } = await fixture(t);
  await assert.rejects(surface.preview("alice", Buffer.from("not an archive")));
  const preview = await surface.preview("alice", bytes);
  assert.throws(() => surface.cancel("bob", preview.id), { code: "ToubaServePackagePreviewMissing" });
  const config = join(root, "touba.project.json");
  writeFileSync(config, readFileSync(config, "utf8") + "\n");
  await assert.rejects(surface.apply("alice", preview), { code: "ToubaServePackageConflict" });
  assert.equal(surface.cancel("alice", preview.id).status, "cancelled");
  const expired = await surface.preview("alice", bytes); advance();
  await assert.rejects(surface.apply("alice", expired), { code: "ToubaServePackagePreviewMissing" });
  assert.equal(surface.inventory().packages.length, 0);
});

test("local folder installation snapshots only a managed package, checks contracts and locks without publication metadata", async t => {
  const { surface, root, archive } = await fixture(t);
  const folder = unpackPackage(archive, join(root, "unpacked"));
  const target = join(root, "packages", "fixture.echo");
  cpSync(folder, target, { recursive: true });
  const manifestPath = join(target, "touba.package.json"), manifest = JSON.parse(readFileSync(manifestPath));
  delete manifest.publisher; delete manifest.description; delete manifest.license;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const before = readFileSync(join(root, "touba.project.json"));
  const preview = await surface.previewLocal("alice", "fixture.echo");
  assert.deepEqual(validateObject(previewSchema, preview), []);
  assert.deepEqual(readFileSync(join(root, "touba.project.json")), before);
  await surface.apply("alice", preview);
  assert.equal(surface.inventory().packages[0].name, "fixture.echo");
  assert.deepEqual(readFileSync(manifestPath), Buffer.from(JSON.stringify(manifest)), "the placed source is not rewritten");
});

test("local selection refuses arbitrary paths, directory links and mismatched package identity", async t => {
  const { surface, root, archive } = await fixture(t);
  for (const name of ["../fixture.echo", "/tmp/fixture.echo", "fixture.echo/file", "fixture.echo\\file", ""]) {
    await assert.rejects(surface.previewLocal("alice", name), { code: "ToubaServePackageInvalid" });
  }
  const folder = unpackPackage(archive, join(root, "unpacked"));
  symlinkSync(folder, join(root, "packages", "fixture.link"));
  await assert.rejects(surface.previewLocal("alice", "fixture.link"), { code: "PackageSymlinkForbidden" });
  cpSync(folder, join(root, "packages", "fixture.other"), { recursive: true });
  await assert.rejects(surface.previewLocal("alice", "fixture.other"), { code: "ToubaServePackageInvalid" });
  assert.equal(surface.inventory().packages.length, 0);
});

test("local content changed after preview cannot be installed under the old digest", async t => {
  const { surface, root, archive } = await fixture(t);
  const folder = unpackPackage(archive, join(root, "unpacked"));
  const target = join(root, "packages", "fixture.echo"); cpSync(folder, target, { recursive: true });
  const preview = await surface.previewLocal("alice", "fixture.echo");
  const manifest = join(target, "touba.package.json"); writeFileSync(manifest, readFileSync(manifest, "utf8") + "\n");
  await assert.rejects(surface.apply("alice", preview), { code: "PackageAlreadyExists" });
  assert.equal(surface.inventory().packages.length, 0);
  await assert.rejects(surface.apply("alice", preview), { code: "ToubaServePackagePreviewMissing" });
});
