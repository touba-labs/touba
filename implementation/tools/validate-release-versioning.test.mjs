import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  } finally {
    rmSync(workspace, { recursive: true, force: true });
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

function writeFixtureRepo({ repoRoot, implementationRoot, version, childVersion = version, retiredCurrent = false, omitReleaseNote = false }) {
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
    "on: workflow_dispatch\nsteps:\n  - run: pnpm --filter @touba/distribution package:release --public\n  - run: node tools/assemble-release-assets.mjs\n  - run: gh release create\n",
    "utf8",
  );
  writeJson(join(implementationRoot, "release", "releases.json"), releaseIndex(version, retiredCurrent));
}

function releaseIndex(version, retiredCurrent) {
  return {
    schema_version: "touba-release-index-v0.1",
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
