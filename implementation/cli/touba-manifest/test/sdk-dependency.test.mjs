import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectSdkDependency } from "../src/sdk-dependency.mjs";
import { sdkBuildIdentity } from "../src/sdk-build-identity.mjs";

test("same-version SDK builds are distinguished by source bytes without loading project code", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-sdk-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdk = join(root, "node_modules/@touba/sdk"), expected = join(root, "expected");
  for (const dir of [sdk, expected]) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/index.mjs"), 'throw new Error("never load during inspection");');
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@touba/sdk", version: "0.1.0", main: "src/index.mjs" }));
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@touba/sdk": "file:sdk.tgz" } }));
  assert.equal(inspectSdkDependency(root, "0.1.0", expected).build, sdkBuildIdentity(expected));
  writeFileSync(join(sdk, "src/index.mjs"), "// obsolete build\n");
  const mismatch = inspectSdkDependency(root, "0.1.0", expected);
  assert.equal(mismatch.code, "HandlerSdkBuildMismatch");
  assert.notEqual(mismatch.build, mismatch.expected_build);
});

test("SDK diagnostics distinguish missing, incompatible, incomplete and undeclared dependencies without executing or rewriting files", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-sdk-diagnostics-"));
  try {
    assert.equal(inspectSdkDependency(root, "0.1.0").code, "HandlerSdkMissing");
    const sdk = join(root, "node_modules/@touba/sdk"); mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, "index.mjs"), 'throw new Error("must never execute");');
    const manifest = { name: "@touba/sdk", version: "99.0.0", main: "index.mjs" };
    writeFileSync(join(sdk, "package.json"), JSON.stringify(manifest));
    assert.equal(inspectSdkDependency(root, "0.1.0").code, "HandlerSdkIncompatible");
    manifest.version = "0.1.0"; manifest.dependencies = { "missing-provider-dependency": "1.0.0" };
    writeFileSync(join(sdk, "package.json"), JSON.stringify(manifest));
    assert.equal(inspectSdkDependency(root, "0.1.0").code, "HandlerSdkDependencyMissing");
    delete manifest.dependencies; writeFileSync(join(sdk, "package.json"), JSON.stringify(manifest));
    assert.equal(inspectSdkDependency(root, "0.1.0").code, "HandlerSdkDependencyUndeclared");
    const project = JSON.stringify({ dependencies: { "@touba/sdk": "file:vendor/sdk.tgz" }, scripts: { existing: "preserved" } });
    writeFileSync(join(root, "package.json"), project);
    assert.equal(inspectSdkDependency(root, "0.1.0").status, "ready");
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), project);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
