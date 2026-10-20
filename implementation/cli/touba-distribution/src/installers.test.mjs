import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { debianControl, installerPlan, packageInstallers, macosInstallerTarget } from "./package-installers.mjs";
import { desktopLauncher, installDesktop } from "./desktop-install.mjs";
import { toolchainBuildIdentity } from "./build-identity.mjs";

test("native formats cover the four release targets without claiming native qualification", () => {
  for (const [platform, format] of [["darwin-arm64", "dmg"], ["darwin-x64", "dmg"], ["win32-x64", "exe"], ["linux-x64", "deb"]]) {
    const plan = installerPlan({ platform, touba_version: "0.1.0" });
    assert.equal(plan.format, format);
    assert.equal(plan.validation_status, "pending_native_validation");
    assert.equal(plan.signing_status, "unsigned_local_candidate");
    assert.equal(plan.filename, `touba-v0.1.0-${platform}-setup.${format}`);
  }
  assert.throws(() => installerPlan({ platform: "linux-arm64", touba_version: "0.1.0" }), /Unsupported/);
  assert.throws(() => installerPlan({ platform: "linux-x64", touba_version: "1\nInjected" }), /version/);
});

test("native launchers quote paths and forward arguments without embedding user input", () => {
  assert.match(desktopLauncher("darwin"), /"\$@"/);
  assert.match(desktopLauncher("win32"), /"%~dp0\.\.\\touba-toolchain\\bin\\touba.cmd" %\*/);
  assert.equal(desktopLauncher("darwin").includes("curl"), false);
});

test("Debian package declares its actual baseline and architecture", () => {
  assert.match(debianControl("0.1.0"), /Architecture: amd64/);
  assert.match(debianControl("0.1.0"), /libc6 \(>= 2.39\)/);
  assert.throws(() => debianControl("0.1.0\n"), /Invalid/);
});

test("macOS installers target the bundled runtime minimum rather than the build host OS", () => {
  assert.equal(macosInstallerTarget("darwin-arm64"), "arm64-apple-macos13.5");
  assert.equal(macosInstallerTarget("darwin-x64"), "x86_64-apple-macos13.5");
  assert.throws(()=>macosInstallerTarget("win32-x64"),/macOS/);
});

test("desktop installer refuses a different platform before creating a prefix", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-desktop-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "TOOLCHAIN.json"), JSON.stringify({ platform: "not-this-host" }));
  const prefix = join(root, "install");
  assert.throws(() => installDesktop({ source, prefix }), /InstallerPlatformMismatch/);
  assert.equal(existsSync(prefix), false);
});

test("desktop installer refuses a foreign launcher and a redirected bin before payload mutation", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-desktop-owned-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "TOOLCHAIN.json"), JSON.stringify({ platform: `${process.platform}-${process.arch}` }));
  const prefix = join(root, "install"); mkdirSync(join(prefix, "bin"), { recursive: true });
  const name = process.platform === "win32" ? "touba.cmd" : "touba";
  writeFileSync(join(prefix, "bin", name), "user-owned launcher");
  assert.throws(() => installDesktop({ source, prefix }), /InstallerUnmanagedLauncher/);
  assert.equal(readFileSync(join(prefix, "bin", name), "utf8"), "user-owned launcher");
  const redirect = join(root, "redirect"); mkdirSync(redirect);
  symlinkSync(join(prefix, "bin"), join(redirect, "bin"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => installDesktop({ source, prefix: redirect }), /InstallerPathUnsafe/);
  if (process.platform !== "win32") {
    const dangling = join(root, "dangling"); mkdirSync(join(dangling, "bin"), { recursive: true });
    const outside = join(root, "must-not-create");
    symlinkSync(outside, join(dangling, "bin", name));
    assert.throws(() => installDesktop({ source, prefix: dangling }), /InstallerPathUnsafe/);
    assert.equal(existsSync(outside), false);
  }
});

test("Windows wizard is per user, keeps project data, and reports child failures", () => {
  const source = readFileSync(new URL("../installers/windows.iss", import.meta.url), "utf8");
  assert.match(source, /PrivilegesRequired=lowest/);
  assert.match(source, /if ExitCode <> 0 then\s+RaiseException/);
  assert.match(source, /UninstallDelete/);
  assert.doesNotMatch(source, /Type: filesandordirs; Name: "\{app\}"/);
  assert.doesNotMatch(source, /ExecutionPolicy Bypass|https?:\/\//);
});

test("packaging preserves existing candidate output and refuses altered payloads", t => {
  const temp = mkdtempSync(join(tmpdir(), "touba-installer-candidate-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const releaseDir = join(temp, "release"), source = join(releaseDir, "touba-toolchain");
  for (const dir of ["bin", "lib", "sdk"]) mkdirSync(join(source, dir), { recursive: true });
  const metadata = { platform: `${process.platform}-${process.arch}`, touba_version: "1.0.0", build: toolchainBuildIdentity(source) };
  writeFileSync(join(source, "TOOLCHAIN.json"), JSON.stringify(metadata));
  writeFileSync(join(releaseDir, "RELEASE.json"), JSON.stringify(metadata));
  const outputDir = join(temp, "output"); mkdirSync(outputDir);
  writeFileSync(join(outputDir, "INSTALLER.json"), "previous candidate\n");
  assert.throws(() => packageInstallers({ releaseDir, outputDir }), /output directory must be empty/);
  assert.equal(readFileSync(join(outputDir, "INSTALLER.json"), "utf8"), "previous candidate\n");
  writeFileSync(join(source, "lib", "changed.mjs"), "altered payload\n");
  const fresh = join(temp, "fresh");
  assert.throws(() => packageInstallers({ releaseDir, outputDir: fresh }), /build identity mismatch/);
  assert.equal(existsSync(fresh), false);
});
