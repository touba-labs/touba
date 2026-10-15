import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RELEASE_READINESS_SCHEMA_VERSION,
  OBSERVED_RELEASE_GATES,
  identifyReleaseCandidate,
  buildReleaseReadinessReport,
  parseReleaseReadinessArgs,
  renderReleaseReadinessReport,
} from "./release-readiness.mjs";

const requiredScripts = {
  "validate:v1-local": "pnpm validate:v1-local",
  "test:runtime": "pnpm test:runtime",
  "test:distribution-sdk": "pnpm test:distribution-sdk",
  "validate:docs-recipes": "pnpm validate:docs-recipes",
  "test:cli": "pnpm test:cli",
  "test:distribution-release": "pnpm test:distribution-release",
  "release:versioning": "pnpm release:versioning",
  "test:release-versioning": "pnpm test:release-versioning",
  "package:touba-release": "pnpm package:touba-release",
  "check:touba-release-archive": "pnpm check:touba-release-archive",
  "validate:docs-user": "pnpm validate:docs-user",
  "validate:docs-public-boundary": "pnpm validate:docs-public-boundary",
};

test("builds a stable blocked V1 release readiness report", () => {
  const report = buildReleaseReadinessReport({
    packageJson: {
      version: "0.1.0",
      scripts: requiredScripts,
    },
    pathExists: () => true,
    readJson: () => ({ version: "0.1.0" }),
  });

  assert.equal(report.schema_version, RELEASE_READINESS_SCHEMA_VERSION);
  assert.equal(report.product, "touba");
  assert.equal(report.release_track, "v1-public");
  assert.equal(report.implementation_version, "0.1.0");
  assert.equal(report.overall_status, "blocked");
  assert.deepEqual(report.counts, {
    satisfied: 19,
    pending: 0,
    blocked: 9,
    failed: 0,
  });
  assert.equal(report.gates.find((gate) => gate.id === "external_user_validation")?.status, "blocked");
  assert.equal(report.gates.find((gate) => gate.id === "public_docs_site_deployment")?.status, "blocked");
  assert.equal(report.gates.find((gate) => gate.id === "fresh_v1_local_validation")?.status, "blocked");
});

test("reports failed gates when required release evidence is missing", () => {
  const report = buildReleaseReadinessReport({
    packageJson: {
      version: "0.1.0",
      scripts: {
        ...requiredScripts,
        "test:cli": undefined,
      },
    },
    pathExists: (relativePath) => relativePath !== "release/notes/v0.1.0.md",
    readJson: (relativePath) => ({
      version: relativePath === "runtime/touba-runtime/package.json" ? "0.0.0" : "0.1.0",
    }),
  });

  assert.equal(report.overall_status, "failed");
  assert.equal(report.gates.find((gate) => gate.id === "cli_tests_command")?.status, "failed");
  assert.equal(report.gates.find((gate) => gate.id === "current_release_note")?.status, "failed");
  assert.equal(report.gates.find((gate) => gate.id === "package_versions")?.status, "failed");
});

test("parses CLI flags and renders compact JSON", () => {
  const options = parseReleaseReadinessArgs(["--", "--allow-blocked", "--compact"]);
  const report = buildReleaseReadinessReport({
    packageJson: {
      version: "0.1.0",
      scripts: requiredScripts,
    },
    pathExists: () => true,
    readJson: () => ({ version: "0.1.0" }),
  });
  const rendered = renderReleaseReadinessReport(report, options);

  assert.equal(options.allowBlocked, true);
  assert.equal(options.pretty, false);
  assert.equal(JSON.parse(rendered).schema_version, RELEASE_READINESS_SCHEMA_VERSION);
  assert.equal(rendered.includes("\n"), false);
});

function qualificationFixture() {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const candidate = { sha256: "a".repeat(64), source_revision: "revision-under-test", version: "0.1.0" };
  const qualification = { candidate_sha256: candidate.sha256, source_revision: candidate.source_revision,
    version: candidate.version, observations: Object.fromEntries(OBSERVED_RELEASE_GATES.map(id => [id, {
      status: "satisfied", observed_at: "2026-10-15T11:00:00Z", evidence: ["test-fixture-only"],
      tasks: Object.fromEntries(Array.from({ length: 14 }, (_, index) => ["TASK-" + String(903 + index).padStart(4, "0"), "completed"])),
      platforms: Object.fromEntries(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].map(platform => [platform, "passed"])),
      total: 56, passed: 56, failed: 0, live: true, locales: ["fr", "en"],
    }])) };
  return { candidate, qualification, now, packageJson: { version: "0.1.0", scripts: requiredScripts },
    pathExists: () => true, readJson: () => ({ version: "0.1.0" }) };
}

test("only fresh complete evidence for the exact candidate can qualify release readiness", () => {
  assert.equal(buildReleaseReadinessReport(qualificationFixture()).overall_status, "ready");
  for (const mutate of [
    o => { delete o.qualification.observations.installed_sdk_distribution; },
    o => { o.qualification.candidate_sha256 = "b".repeat(64); },
    o => { o.qualification.source_revision = "another-revision"; },
    o => { o.qualification.version = "another-version"; },
    o => { o.qualification.observations.fresh_v1_local_validation.observed_at = "2026-06-13"; },
    o => { o.qualification.observations.fresh_v1_local_validation.observed_at = "2027-01-01"; },
    o => { o.qualification.observations.p0_delivery.tasks["agent_cycle_finalization"] = "in_progress"; },
    o => { o.qualification.observations.multi_os_ci_observation.platforms["win32-x64"] = "not_tested"; },
    o => { o.qualification.observations.installed_sdk_distribution.status = "failed"; },
    o => { o.qualification.observations.installed_sdk_distribution.evidence = []; },
    o => { o.qualification.observations.published_tutorial_recipes.passed = 55; },
    o => { o.qualification.observations.published_tutorial_recipes.live = false; },
  ]) {
    const options = qualificationFixture(); mutate(options);
    assert.notEqual(buildReleaseReadinessReport(options).overall_status, "ready", mutate.toString());
  }
});

test("qualification flags are explicit and missing values are refused", () => {
  const parsed = parseReleaseReadinessArgs(["--candidate", "CHECKSUMS.json", "--qualification", "review.json", "--source-revision", "abc"]);
  assert.equal(parsed.candidate, "CHECKSUMS.json");
  assert.equal(parsed.qualification, "review.json");
  assert.equal(parsed.sourceRevision, "abc");
  assert.throws(() => parseReleaseReadinessArgs(["--candidate"]), /Missing value/);
});

test("candidate identity verifies real archive bytes and refuses missing, altered or escaping assets", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-readiness-"));
  try {
    const file = join(root, "candidate.tar.gz");
    const manifest = join(root, "CHECKSUMS.json");
    writeFileSync(file, "qualification-test-only");
    const asset = { name: "candidate.tar.gz", sha256: createHash("sha256").update("qualification-test-only").digest("hex") };
    const value = { version: "0.1.0", assets: [asset] };
    writeFileSync(manifest, JSON.stringify(value));
    const candidate = identifyReleaseCandidate(manifest, "source-commit");
    assert.equal(candidate.version, "0.1.0");
    assert.equal(candidate.source_revision, "source-commit");
    assert.match(candidate.sha256, /^[a-f0-9]{64}$/);
    writeFileSync(file, "changed");
    assert.throws(() => identifyReleaseCandidate(manifest, "source-commit"), /checksum mismatch/);
    for (const name of ["../candidate.tar.gz", "missing.tar.gz", "C:\\candidate.tar.gz"]) {
      writeFileSync(manifest, JSON.stringify({ ...value, assets: [{ ...asset, name }] }));
      assert.throws(() => identifyReleaseCandidate(manifest, "source-commit"));
    }
    writeFileSync(manifest, JSON.stringify({ ...value, assets: [] }));
    assert.throws(() => identifyReleaseCandidate(manifest, "source-commit"), /no artifacts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
