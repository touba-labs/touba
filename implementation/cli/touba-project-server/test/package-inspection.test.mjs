import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { initProject } from "../../touba-project/src/project.mjs";
import { newPackage, addPackage } from "../../touba-project/src/packages.mjs";
import { inspectPackageInstallation } from "../src/package-inspection.mjs";

test("discovery distinguishes a folder, a locked installation and modified inventory", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-package-inspection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const consumer = join(root, "consumer"); initProject({ root: consumer });
  const source = newPackage("fixture.inspection", { root, version: "1.0.0" }).path;
  const manifest = "packages/fixture.inspection/touba.package.json";
  cpSync(source, join(consumer, "packages/fixture.inspection"), { recursive: true });
  const digest = `sha256:${createHash("sha256").update(readFileSync(join(consumer, manifest))).digest("hex")}`;
  const folder = inspectPackageInstallation(consumer, manifest, digest);
  assert.equal(folder.status, "unregistered"); assert.equal(folder.digest_kind, "package");
  assert.equal(folder.lock_digest, null); assert.notEqual(folder.digest, digest);
  await addPackage("fixture.inspection", { root: consumer });
  const installed = inspectPackageInstallation(consumer, manifest, digest);
  assert.equal(installed.status, "installed"); assert.equal(installed.digest, installed.expected_digest);
  assert.equal(installed.manifest_digest, digest); assert.match(installed.lock_digest, /^sha256:/);
  writeFileSync(join(consumer, "packages/fixture.inspection/extra.txt"), "unexpected");
  const changed = inspectPackageInstallation(consumer, manifest, digest);
  assert.equal(changed.status, "invalid"); assert.equal(changed.issue, "PackageUnexpectedFile");
});
