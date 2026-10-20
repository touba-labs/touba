import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeMacFiles, sealMacApp, validateMacSigningIdentity, verifyMacSignature } from "./macos-signing.mjs";
import { notarizeInstaller, requireAcceptedNotarization } from "./notarize-installer.mjs";

test("signing refuses ambiguous identities and never accepts ad hoc as Developer ID", () => {
  for (const identity of [undefined, "", "-", "Developer ID Application", "A".repeat(39), "X".repeat(40)]) {
    assert.throws(() => validateMacSigningIdentity(identity), /fingerprint/);
  }
});

test("notarization requires a real acceptance receipt, not a submitted or rejected job", () => {
  const id = "a1111111-1111-1111-1111-111111111111";
  assert.doesNotThrow(() => requireAcceptedNotarization({ id, status: "Accepted" }));
  for (const receipt of [{ id, status: "In Progress" }, { id, status: "Invalid" }, { status: "Accepted" }, { id: "-".repeat(36), status: "Accepted" }, null]) {
    assert.throws(() => requireAcceptedNotarization(receipt), /not accepted/);
  }
});

test("notarization rejects unsigned or altered inputs before creating output", { skip: process.platform !== "darwin" }, t => {
  const root = mkdtempSync(join(tmpdir(), "touba-signing-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputDir = join(root, "notarized"), metadata = join(root, "INSTALLER.json");
  const options = { installerDir: root, outputDir, keychainProfile: "test-no-credentials-used" };
  writeFileSync(metadata, JSON.stringify({ format: "dmg", signing_status: "adhoc_local_candidate" }));
  assert.throws(() => notarizeInstaller(options), /Developer ID signed/);
  const report = { format: "dmg", signing_status: "developer_id_signed", filename: "../escape.dmg" };
  writeFileSync(metadata, JSON.stringify(report));
  assert.throws(() => notarizeInstaller(options), /Invalid installer filename/);
  report.filename = "candidate.dmg"; report.sha256 = "0".repeat(64);
  writeFileSync(join(root, report.filename), "altered");
  writeFileSync(metadata, JSON.stringify(report));
  assert.throws(() => notarizeInstaller(options), /checksum mismatch/);
  assert.equal(existsSync(outputDir), false);
});

test("Node release entitlements support JIT/modules without development debugger grants", () => {
  const entitlements = readFileSync(new URL("../installers/node-entitlements.plist", import.meta.url), "utf8");
  assert.match(entitlements, /com.apple.security.cs.allow-jit/);
  assert.match(entitlements, /com.apple.security.cs.disable-library-validation/);
  assert.doesNotMatch(entitlements, /get-task-allow|allow-dyld-environment-variables|disable-executable-page-protection/);
});

test("payload discovery checks bytes rather than executable bits or extensions", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-macho-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, bytes] of [["native", Buffer.from("cffaedfe01000000", "hex")], ["module.node", Buffer.from("cafebabe00000002", "hex")], ["launcher", Buffer.from("#!/bin/sh\n")], ["empty", Buffer.alloc(0)]]) writeFileSync(join(root, name), bytes);
  assert.deepEqual(nativeMacFiles(root), [join(root, "module.node"), join(root, "native")]);
  if (process.platform !== "win32") {
    symlinkSync(join(root, "native"), join(root, "redirect"));
    assert.throws(() => nativeMacFiles(root), /Unsupported signing entry/);
  }
});

test("real macOS bundle is sealed after assembly and resource tampering is rejected", { skip: process.platform !== "darwin" }, t => {
  const root = mkdtempSync(join(tmpdir(), "touba-app-seal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "Test Installer.app"), contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"));
  writeFileSync(join(contents, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.toubalang.signature-test</string><key>CFBundleExecutable</key><string>TestInstaller</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const resource = join(contents, "Resources/payload.txt");
  writeFileSync(resource, "original payload\n");
  const compile = spawnSync("/usr/bin/clang", ["-x", "c", "-", "-o", join(contents, "MacOS/TestInstaller")], { input: "int main(void) { return 0; }\n", encoding: "utf8", timeout: 30000 });
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
  // Regression: the linker's executable signature does not seal the bundle.
  assert.throws(() => verifyMacSignature(app));
  sealMacApp(app);
  assert.doesNotThrow(() => verifyMacSignature(app));
  assert.throws(() => verifyMacSignature(app, { developerId: true }), /Developer ID/);
  writeFileSync(resource, "changed after signing\n");
  assert.throws(() => verifyMacSignature(app), /failed/);
});
