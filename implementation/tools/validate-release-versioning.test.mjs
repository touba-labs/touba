import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_VERSIONING_SCHEMA_VERSION,
  buildReleaseVersioningReport,
  parseReleaseVersioningArgs,
} from "./validate-release-versioning.mjs";

test("validates a coherent Touba release version set", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  try {
    const repoRoot = join(workspace, "touba");
    const implementationRoot = join(repoRoot, "implementation");
    writeFixtureRepo({ repoRoot, implementationRoot, version: "1.2.3" });

    const report = buildReleaseVersioningReport({
      repoRoot,
      implementationRoot,
      expectedVersion: "1.2.3",
    });

    assert.equal(report.schema_version, RELEASE_VERSIONING_SCHEMA_VERSION);
    assert.equal(report.status, "ok");
    assert.equal(report.current_version, "1.2.3");
    assert.equal(report.summary.package_count, 2);
    assert.equal(report.diagnostics.length, 0);

    writeFileSync(join(repoRoot, "CHANGELOG.md"), "## 1.2.3-rc.1\n\nPrerelease only.\n");
    const missingStable = buildReleaseVersioningReport({ repoRoot, implementationRoot });
    assert.ok(missingStable.diagnostics.some(item => item.code === "ChangelogVersionMissing"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("source validation works without a release workflow and still checks versions", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  const implementationRoot = join(repoRoot, "implementation");
  try {
    writeFixtureRepo({ repoRoot, implementationRoot, version: "1.2.3" });
    rmSync(join(repoRoot, ".github/workflows/release.yml"));
    const options = { repoRoot, implementationRoot, ...parseReleaseVersioningArgs(["--source-only"]) };
    assert.equal(buildReleaseVersioningReport(options).status, "ok");
    assert.ok(buildReleaseVersioningReport({ repoRoot, implementationRoot })
      .diagnostics.some(item => item.code === "ReleaseWorkflowMissing"));
    assert.equal(buildReleaseVersioningReport({ ...options, expectedVersion: "1.2.4" }).status, "failed");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("reports mismatched package and expected versions", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  try {
    const repoRoot = join(workspace, "touba");
    const implementationRoot = join(repoRoot, "implementation");
    writeFixtureRepo({ repoRoot, implementationRoot, version: "1.2.3", childVersion: "1.2.2" });

    const report = buildReleaseVersioningReport({
      repoRoot,
      implementationRoot,
      expectedVersion: "1.2.4",
    });

    assert.equal(report.status, "failed");
    assert.equal(report.diagnostics.some((item) => item.code === "ExpectedVersionMismatch"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "PackageVersionMismatch"), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("requires retired releases to carry maintainer decision metadata", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  try {
    const repoRoot = join(workspace, "touba");
    const implementationRoot = join(repoRoot, "implementation");
    writeFixtureRepo({ repoRoot, implementationRoot, version: "1.2.3", retiredCurrent: true });

    const report = buildReleaseVersioningReport({
      repoRoot,
      implementationRoot,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.diagnostics.some((item) => item.code === "CurrentReleaseRetired"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "ReleaseRetirementInvalid"), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects Rust and Python component version drift", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  const implementationRoot = join(repoRoot, "implementation");
  try {
    writeFixtureRepo({ repoRoot, implementationRoot, version: "1.2.3" });
    writeFileSync(join(implementationRoot, "compiler/touba-compiler/Cargo.toml"), '[package]\nversion = "1.2.2"\n');
    writeFileSync(join(implementationRoot, "runtime/touba-python-sdk/pyproject.toml"), '[project]\nversion = "1.2.2"\n');
    const report = buildReleaseVersioningReport({ repoRoot, implementationRoot });
    assert.equal(report.status, "failed");
    assert.equal(report.diagnostics.filter(item => item.code === "ComponentVersionMismatch").length, 2);
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
});

test("rejects a stale Python runtime identity before packaging", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  const implementationRoot = join(repoRoot, "implementation");
  try {
    writeFixtureRepo({ repoRoot, implementationRoot, version: "1.2.3" });
    writeFileSync(join(implementationRoot, "runtime/touba-python-sdk/src/touba_sdk/_version.py"), 'VERSION = "1.2.2"\n');
    const report = buildReleaseVersioningReport({ repoRoot, implementationRoot });
    assert.equal(report.status, "failed");
    assert.equal(report.diagnostics.filter(item => item.code === "SdkIdentityMismatch").length, 1);
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
});

test("requires all four graphical installers in active releases", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  const implementationRoot = join(repoRoot, "implementation");
  try {
    writeFixtureRepo({ repoRoot, implementationRoot, version: "1.2.3" });
    const index = releaseIndex("1.2.3", false);
    index.versions[0].artifacts = index.versions[0].artifacts.filter(name => !name.endsWith(".exe"));
    writeJson(join(implementationRoot, "release/releases.json"), index);
    const report = buildReleaseVersioningReport({ repoRoot, implementationRoot });
    assert.equal(report.status, "failed");
    assert.equal(report.diagnostics.filter(item => item.code === "ReleaseInstallerMissing").length, 1);
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
});

test("requires structured release notes for each managed version", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  try {
    const repoRoot = join(workspace, "touba");
    const implementationRoot = join(repoRoot, "implementation");
    writeFixtureRepo({ repoRoot, implementationRoot, version: "1.2.3", omitReleaseNote: true });

    const report = buildReleaseVersioningReport({
      repoRoot,
      implementationRoot,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.diagnostics.some((item) => item.code === "ReleaseNotesMissing"), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("parses release versioning CLI flags", () => {
  assert.deepEqual(parseReleaseVersioningArgs(["--version=1.2.3", "--compact"]), {
    expectedVersion: "1.2.3",
    pretty: false,
  });
});

test("standalone conformance has an independent but still validated version", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  const implementationRoot = join(repoRoot, "implementation");
  try {
    writeFixtureRepo({ repoRoot, implementationRoot, version: "0.2.0" });
    mkdirSync(join(implementationRoot, "contracts"));
    const file = join(implementationRoot, "contracts/package.json");
    writeJson(file, { name: "@touba/machine-conformance", version: "1.0.0" });
    assert.equal(buildReleaseVersioningReport({ repoRoot, implementationRoot }).status, "ok");
    writeJson(file, { name: "@touba/machine-conformance", version: "invalid" });
    assert.ok(buildReleaseVersioningReport({ repoRoot, implementationRoot }).diagnostics.some(d => d.code === "PackageVersionInvalid"));
    writeJson(file, { name: "@touba/another-package", version: "1.0.0" });
    assert.ok(buildReleaseVersioningReport({ repoRoot, implementationRoot }).diagnostics.some(d => d.code === "PackageVersionMismatch"));
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
});

test("release validator rejects asset replacement", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "touba-versioning-test-"));
  const implementationRoot = join(repoRoot, "implementation");
  try {
    writeFixtureRepo({ repoRoot, implementationRoot, version: "0.2.0" });
    appendFileSync(join(repoRoot, ".github/workflows/release.yml"), "  - run: gh release upload v0.2.0 asset --clobber\n");
    assert.ok(buildReleaseVersioningReport({ repoRoot, implementationRoot }).diagnostics.some(d => d.code === "MutableReleaseWorkflow"));
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
});

function writeFixtureRepo({ repoRoot, implementationRoot, version, childVersion = version, retiredCurrent = false, omitReleaseNote = false }) {
  const identityDir = join(implementationRoot, "runtime/touba-python-sdk/src/touba_sdk");
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(join(identityDir, "_version.py"), `VERSION = "${version}"\n`);
  for (const [directory, file, section] of [
    ["compiler/touba-compiler", "Cargo.toml", "package"],
    ["cli/touba-cli", "Cargo.toml", "package"],
    ["runtime/touba-sandbox", "Cargo.toml", "package"],
    ["runtime/touba-python-sdk", "pyproject.toml", "project"],
  ]) {
    mkdirSync(join(implementationRoot, directory), { recursive: true });
    writeFileSync(join(implementationRoot, directory, file), `[${section}]\nversion = "${version}"\n`);
  }
  mkdirSync(join(implementationRoot, "release", "notes"), { recursive: true });
  mkdirSync(join(implementationRoot, "runtime", "touba-runtime"), { recursive: true });
  mkdirSync(join(repoRoot, ".github", "workflows"), { recursive: true });
  writeJson(join(implementationRoot, "package.json"), { name: "@touba/implementation", version });
  writeJson(join(implementationRoot, "runtime", "touba-runtime", "package.json"), { name: "@touba/runtime", version: childVersion });
  writeFileSync(join(repoRoot, "CHANGELOG.md"), `# Changelog\n\n## ${version}\n\n- Release.\n`, "utf8");
  if (!omitReleaseNote) {
    writeFileSync(join(implementationRoot, "release", "notes", `v${version}.md`), releaseNote(version), "utf8");
  }
  writeFileSync(
    join(repoRoot, ".github", "workflows", "release.yml"),
    "on: workflow_dispatch\nsteps:\n  - run: pnpm --filter @touba/distribution package:release --public\n  - run: node tools/assemble-release-assets.mjs\n  - run: gh release create --verify-tag --draft\n# Guards: GITHUB_REF_TYPE refs/tags/ Release already exists\n",
    "utf8",
  );
  writeJson(join(implementationRoot, "release", "releases.json"), releaseIndex(version, retiredCurrent));
}

function releaseIndex(version, retiredCurrent) {
  return {
    schema_version: "touba-release-index-v1",
    product: "touba",
    current_version: version,
    policy: {
      versioning: "semver",
      canonical_public_channel: "github_release",
      public_entrypoint: "touba_hub",
      default_retention: "preserve_published_versions",
      retirement_rule: "published versions are retained unless retired",
    },
    platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"],
    versions: [
      {
        version,
        tag: `v${version}`,
        status: retiredCurrent ? "retired" : "published",
        released_on: "2026-06-22",
        summary: "Fixture release.",
        release_notes: `release/notes/v${version}.md`,
        breaking_changes: [],
        migration_guide: null,
        evidence: ["release/releases.json"],
        compare_url: null,
        channels: ["github_release", "touba_hub"],
        artifacts: [
          `touba-v${version}-darwin-arm64.tar.gz`,
          `touba-v${version}-darwin-x64.tar.gz`,
          `touba-v${version}-linux-x64.tar.gz`,
          `touba-v${version}-win32-x64.tar.gz`,
          `touba-v${version}-darwin-arm64-setup.dmg`,
          `touba-v${version}-darwin-x64-setup.dmg`,
          `touba-v${version}-linux-x64-setup.deb`,
          `touba-v${version}-win32-x64-setup.exe`,
          "SHA256SUMS",
          "CHECKSUMS.json",
        ],
        retirement: { status: retiredCurrent ? "retired" : "active" },
      },
    ],
  };
}

function releaseNote(version) {
  return [
    `# Touba ${version}`,
    "",
    "## Executive Summary",
    "",
    "Fixture release.",
    "",
    "## Added",
    "",
    "- Fixture.",
    "",
    "## Changed",
    "",
    "- Fixture.",
    "",
    "## Fixed",
    "",
    "- Fixture.",
    "",
    "## Security And Governance",
    "",
    "- Fixture.",
    "",
    "## Breaking Changes",
    "",
    "- None.",
    "",
    "## Migration",
    "",
    "- None.",
    "",
    "## Validation Evidence",
    "",
    "- Fixture.",
    "",
    "## Known Limits",
    "",
    "- None.",
    "",
  ].join("\n");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
