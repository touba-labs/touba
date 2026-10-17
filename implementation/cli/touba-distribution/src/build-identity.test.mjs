import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toolchainBuildIdentity } from "./build-identity.mjs";

function fixture(t, reverse = false) {
  const root = mkdtempSync(join(tmpdir(), "touba build identity "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["bin", "lib", "sdk"]) mkdirSync(join(root, dir));
  const files = ["bin/touba", "lib/main.mjs", "lib/package.json", "sdk/sdk.tgz"];
  for (const path of reverse ? files.toReversed() : files) writeFileSync(join(root, path), `contents: ${path}\n`);
  return root;
}

test("build identity is independent of installation path, creation order, timestamps and outer metadata", t => {
  const first = fixture(t);
  const second = fixture(t, true);
  const identity = toolchainBuildIdentity(first);
  assert.match(identity.id, /^[a-f0-9]{64}$/);
  assert.equal(identity.algorithm, "sha256");
  assert.equal(identity.identity_scope, "touba-toolchain-content-v1");
  utimesSync(join(second, "bin/touba"), 100, 100);
  writeFileSync(join(second, "TOOLCHAIN.json"), JSON.stringify({ build: identity, node_source: "/different/location" }));
  writeFileSync(join(second, "README.txt"), "Different packaging notes");
  assert.deepEqual(toolchainBuildIdentity(second), identity);
});

test("build identity changes with bytes, file names or directory structure", t => {
  const root = fixture(t);
  const original = toolchainBuildIdentity(root).id;
  writeFileSync(join(root, "lib/main.mjs"), "changed source");
  const modified = toolchainBuildIdentity(root).id;
  assert.notEqual(modified, original);
  renameSync(join(root, "lib/main.mjs"), join(root, "lib/renamed.mjs"));
  const renamed = toolchainBuildIdentity(root).id;
  assert.notEqual(renamed, modified);
  mkdirSync(join(root, "lib/empty"));
  assert.notEqual(toolchainBuildIdentity(root).id, renamed);
});

test("build identity refuses missing payload roots and symbolic links", t => {
  const root = fixture(t);
  renameSync(join(root, "sdk"), join(root, "missing-sdk"));
  assert.throws(() => toolchainBuildIdentity(root), /ENOENT/);
  // Directory junctions need no symlink privilege on Windows.
  symlinkSync(join(root, "missing-sdk"), join(root, "sdk"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => toolchainBuildIdentity(root), /unsupported build identity entry: sdk/);
});
