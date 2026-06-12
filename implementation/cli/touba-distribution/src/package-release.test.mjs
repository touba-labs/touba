import assert from "node:assert/strict";
import test from "node:test";

import {
  createReleasePlan,
  parsePackageReleaseArgs,
} from "./package-release.mjs";

test("release plan keeps the locally verified macOS profile explicit", () => {
  const plan = createReleasePlan({
    platform: "darwin-arm64",
    hostPlatform: "darwin-arm64",
    toubaVersion: "1.2.3",
    releaseRoot: "/tmp/touba-release-test",
  });

  assert.equal(plan.releaseName, "touba-v1.2.3-darwin-arm64");
  assert.equal(plan.channel, "macos-local-release");
  assert.equal(plan.validationStatus, "local_verified");
  assert.equal(plan.releaseProfile, "touba-local-release-v0.2");
  assert.equal(plan.publicRelease, false);
  assert.ok(plan.limitations.includes("not signed"));
  assert.ok(plan.limitations.includes("not published through a public update channel"));
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
  assert.equal(plan.releaseProfile, "touba-local-release-experimental-v0.1");
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

test("release CLI parser accepts platform, experimental and json flags", () => {
  assert.deepEqual(parsePackageReleaseArgs([
    "--platform",
    "linux-x64",
    "--experimental",
    "--json",
    "--no-build-compiler",
  ]), {
    platform: "linux-x64",
    experimental: true,
    json: true,
    buildCompiler: false,
  });
});
