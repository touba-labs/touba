import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { npmCommand } from "./npm-command.mjs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createReleasePlan,
  parsePackageReleaseArgs,
  renderInstallPowerShell,
  renderUninstallPowerShell,
  renderWindowsCmdLauncher,
} from "./package-release.mjs";

test("distribution inventories every shared root runtime contract", () => {
  const source = readFileSync(new URL("./package-local-toolchain.mjs", import.meta.url), "utf8");
  const contracts = readdirSync(new URL("../../../contracts/", import.meta.url))
    .filter(name => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  assert.ok(contracts.includes("trigger-routes.mjs"));
  for (const name of contracts) assert.ok(source.includes(JSON.stringify(name)), `Missing packaged contract: ${name}`);
});

test("isolated release roots work for packaging and archive qualification", () => {
  assert.equal(parsePackageReleaseArgs(["--release-root", "candidate artifacts"]).releaseRoot, resolve("candidate artifacts"));
  assert.throws(() => parsePackageReleaseArgs(["--release-root"]), /requires/);
});

test("npm execution preserves Windows paths with spaces without a shell", () => {
  const args = ["install", "C:\\isolated project\\touba-sdk.tgz"];
  const invocation = npmCommand(args, { platform: "win32", node: "C:\\Program Files\\nodejs\\node.exe", exists: () => true });
  assert.equal(invocation.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(invocation.args, ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", ...args]);
  assert.throws(() => npmCommand(args, { platform: "win32", node: invocation.command, exists: () => false }), /npm is missing/);
  assert.deepEqual(npmCommand(args, { platform: "darwin" }), { command: "npm", args });
});

test("release plan keeps the local macOS build pending qualification", () => {
  const plan = createReleasePlan({
    platform: "darwin-arm64",
    hostPlatform: "darwin-arm64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
  });

  assert.equal(plan.releaseName, "touba-v1.2.3-darwin-arm64");
  assert.equal(plan.channel, "macos-local-release");
  assert.equal(plan.validationStatus, "pending_validation");
  assert.equal(plan.releaseProfile, "touba-local-release-v1");
  assert.equal(plan.releaseScope, "local_validation");
  assert.equal(plan.draftPath, join("/tmp/touba-release-test", "GITHUB_RELEASE_DRAFT.md"));
  assert.equal(plan.publicRelease, false);
  assert.ok(plan.limitations.includes("not signed"));
  assert.ok(plan.limitations.includes("not published through a public update channel"));
});

test("release plan refuses public channel overrides for local-only artifacts", () => {
  assert.throws(() => createReleasePlan({
    platform: "darwin-arm64",
    hostPlatform: "darwin-arm64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
    channel: "public-release",
  }), /not allowed for local-only artifacts/u);
});

test("release plan supports public GitHub Release artifacts for supported build targets", () => {
  const plan = createReleasePlan({
    platform: "linux-x64",
    hostPlatform: "linux-x64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
    publicRelease: true,
  });

  assert.equal(plan.releaseName, "touba-v1.2.3-linux-x64");
  assert.equal(plan.channel, "github-release");
  assert.equal(plan.validationStatus, "pending_validation");
  assert.equal(plan.releaseProfile, "touba-github-release-v1");
  assert.equal(plan.installationProfile, "touba-github-release-install-v1");
  assert.equal(plan.releaseScope, "public_distribution");
  assert.equal(plan.publicRelease, true);
  assert.ok(plan.limitations.includes("verified updates require a separately approved signed catalogue"));
  assert.equal(plan.limitations.includes("not published through a public update channel"), false);
});

test("release plan refuses unsupported public release platforms", () => {
  assert.throws(() => createReleasePlan({
    platform: "freebsd-x64",
    hostPlatform: "freebsd-x64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
    publicRelease: true,
  }), /not part of the public release platform set/u);
});

test("release plan refuses unvalidated platforms unless experimental", () => {
  assert.throws(() => createReleasePlan({
    platform: "linux-x64",
    hostPlatform: "linux-x64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
  }), /not validated/u);
});

test("release plan marks experimental platforms as non-public artifacts", () => {
  const plan = createReleasePlan({
    platform: "linux-x64",
    hostPlatform: "linux-x64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
    experimental: true,
  });

  assert.equal(plan.channel, "local-release-experimental");
  assert.equal(plan.validationStatus, "experimental_unvalidated");
  assert.equal(plan.releaseProfile, "touba-local-release-experimental-v1");
  assert.equal(plan.publicRelease, false);
  assert.match(plan.limitations.join("\n"), /not a supported platform release/u);
});

test("release plan refuses cross-platform packaging by default", () => {
  assert.throws(() => createReleasePlan({
    platform: "linux-x64",
    hostPlatform: "darwin-arm64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
    experimental: true,
  }), /cross-platform release packaging is not supported/u);
});

test("release CLI parser accepts platform, public, experimental and json flags", () => {
  assert.deepEqual(parsePackageReleaseArgs([
    "--platform",
    "linux-x64",
    "--experimental",
    "--public",
    "--json",
    "--no-build-compiler",
  ]), {
    platform: "linux-x64",
    experimental: true,
    publicRelease: true,
    json: true,
    buildCompiler: false,
  });
});

test("Windows cmd launcher preserves quoting and bundled paths", () => {
  const plan = createReleasePlan({
    platform: "win32-x64",
    hostPlatform: "win32-x64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
    experimental: true,
  });

  const launcher = renderWindowsCmdLauncher(plan);
  assert.match(launcher, /TOUBA_DISTRIBUTION_CHANNEL=local-release-experimental/u);
  assert.match(launcher, /"%~dp0\.\.\\touba-toolchain\\bin\\touba\.cmd" %\*/u);
  assert.doesNotMatch(launcher, /node\.exe|main\.mjs/u);
});

test("PowerShell install script writes touba.cmd and INSTALLATION metadata", () => {
  const plan = createReleasePlan({
    platform: "win32-x64",
    hostPlatform: "win32-x64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
    experimental: true,
  });

  const script = renderInstallPowerShell(plan);
  assert.match(script, /param\(/u);
  assert.match(script, /\[switch\]\$Force/u);
  assert.match(script, /Join-Path \$Source "bin\\touba\.cmd"/u);
  assert.match(script, /Set-Content -Path \(Join-Path \$Prefix "bin\\touba\.cmd"\)/u);
  assert.match(script, /installation_profile = "touba-local-release-install-experimental-v1"/u);
  assert.match(script, /validation_status = "experimental_unvalidated"/u);
  assert.match(script, /public_release = \$false/u);
});

test("PowerShell install script marks public release metadata", () => {
  const plan = createReleasePlan({
    platform: "win32-x64",
    hostPlatform: "win32-x64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
    publicRelease: true,
  });

  const script = renderInstallPowerShell(plan);
  assert.match(script, /installation_profile = "touba-github-release-install-v1"/u);
  assert.match(script, /validation_status = "pending_validation"/u);
  assert.match(script, /public_release = \$true/u);
  assert.match(script, /signed-catalogue/u);
});

test("PowerShell uninstall script removes launcher, toolchain and metadata paths", () => {
  const script = renderUninstallPowerShell();
  assert.match(script, /Join-Path \$Prefix "bin\\touba\.cmd"/u);
  assert.match(script, /Join-Path \$Prefix "touba-toolchain"/u);
  assert.match(script, /Join-Path \$Prefix "INSTALLATION\.json"/u);
});
