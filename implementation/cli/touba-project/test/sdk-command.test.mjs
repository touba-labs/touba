import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundledSdk, installSdk, sdkCommand } from "../src/sdk-command.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-sdk-choice-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "sdk"));
  const archive = "sdk/touba-sdk.tgz";
  writeFileSync(join(root, archive), "controlled archive");
  const metadata = { sdk: { archive, sha256: createHash("sha256").update("controlled archive").digest("hex"), name: "@touba/sdk", version: "0.1.0" } };
  writeFileSync(join(root, "TOOLCHAIN.json"), JSON.stringify(metadata));
  return { root, metadata };
}

test("SDK commands describe both SDKs and handler scope", () => {
  assert.match(sdkCommand([]).text, /install javascript/);
  assert.match(sdkCommand(["--help"]).text, /install python/);
  assert.match(sdkCommand(["--help"]).text, /init --language javascript\|python/);
  assert.throws(() => sdkCommand(["get"]), /Usage/);
  assert.throws(() => sdkCommand(["path", "python", "--root", "."]), /option/);
  assert.throws(() => sdkCommand(["install", "python", "--python"]), /option/);
});

test("SDK archive is resolved and checksum verified", t => {
  const { root } = fixture(t);
  assert.equal(bundledSdk("javascript", root).path, join(root, "sdk/touba-sdk.tgz"));
  writeFileSync(join(root, "sdk/touba-sdk.tgz"), "altered");
  assert.throws(() => bundledSdk("javascript", root), /checksum mismatch/);
});

test("SDK path refuses unknown SDK, absent metadata, traversal and symlinks", t => {
  const { root, metadata } = fixture(t);
  assert.throws(() => bundledSdk("typescript", root), /javascript or python/);
  assert.throws(() => bundledSdk("python", root), /metadata/);
  assert.throws(() => bundledSdk("javascript", join(root, "sdk")), /unavailable/);
  metadata.sdk.archive = "../escape.tgz";
  writeFileSync(join(root, "TOOLCHAIN.json"), JSON.stringify(metadata));
  assert.throws(() => bundledSdk("javascript", root), /inside/);
  metadata.sdk.archive = "sdk/link.tgz";
  writeFileSync(join(root, "TOOLCHAIN.json"), JSON.stringify(metadata));
  symlinkSync(join(root, "sdk/touba-sdk.tgz"), join(root, "sdk/link.tgz"));
  assert.throws(() => bundledSdk("javascript", root), /regular file/);
});

test("SDK installation refuses another package manager without changing its files", t => {
  const { root } = fixture(t);
  const project = join(root, "project"); mkdirSync(project);
  writeFileSync(join(project, "pnpm-lock.yaml"), "user lock");
  assert.throws(() => installSdk("javascript", { root: project, distributionRoot: root }), /package manager/);
  assert.equal(readFileSync(join(project, "pnpm-lock.yaml"), "utf8"), "user lock");
  assert.equal(existsSync(join(project, "vendor")), false);
  assert.throws(() => installSdk("javascript", { root: project, distributionRoot: root, python: "python3" }), /only to the Python/);
});

test("SDK project vendor symlink is refused before npm runs", t => {
  const { root } = fixture(t);
  const project = join(root, "project"); mkdirSync(project);
  symlinkSync(join(root, "sdk"), join(project, "vendor"), "dir");
  assert.throws(() => installSdk("javascript", { root: project, distributionRoot: root }), /regular directory|npm is required/);
  assert.equal(existsSync(join(project, "package.json")), false);
});

test("an invalid npm archive reports the installation phase rather than the Node executable", t => {
  const {root}=fixture(t);
  const project=join(root,"invalid-archive-project");mkdirSync(project);
  assert.throws(()=>installSdk("javascript",{root:project,distributionRoot:root}),/SDK command failed \(offline npm installation\)/);
});
