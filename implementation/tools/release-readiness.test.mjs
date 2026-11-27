import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RELEASE_READINESS_SCHEMA_VERSION,
  OBSERVED_RELEASE_GATES,
  REQUIRED_V1_DELIVERABLES,
  INDUSTRIAL_CHECKS,
  INSTALLER_CHECKS,
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
    blocked: 14,
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
      deliverables: Object.fromEntries(REQUIRED_V1_DELIVERABLES.map(id => [id, "completed"])),
      platforms: Object.fromEntries(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].map(platform => [platform, "passed"])),
      sdks: Object.fromEntries(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].map(platform => [platform, { javascript: "passed", python: "passed" }])),
      checks: Object.fromEntries(INDUSTRIAL_CHECKS.map(check => [check, "passed"])),
      total: 4, passed: 4, failed: 0, live: true, scope: "all", locales: ["fr", "en"], restore_test: "passed",
      results: ["fr", "en"].flatMap(locale => ["first.md", "second.md"].map(document => ({ locale, document, status: "passed", commands: 1 }))),
    }])) };
  qualification.observations.documentation_review.locales = { fr: "passed", en: "passed" };
  qualification.observations.desktop_installers.platforms = Object.fromEntries(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].map(platform =>
    [platform, Object.fromEntries(INSTALLER_CHECKS.map(check => [check, "passed"]))]));
  return { candidate, qualification, now, tutorialDocuments: ["first.md", "second.md"], packageJson: { version: "0.1.0", scripts: requiredScripts },
    pathExists: () => true, readJson: () => ({ version: "0.1.0" }) };
}

test("only fresh complete evidence for the exact candidate can qualify release readiness", () => {
  assert.equal(buildReleaseReadinessReport(qualificationFixture()).overall_status, "ready");
  const coherentEvidence = qualificationFixture();
  coherentEvidence.readJson = path => ({ version: path === "runtime/touba-runtime/package.json" ? "0.1.1" : "0.1.0" });
  const mismatched = buildReleaseReadinessReport(coherentEvidence);
  assert.equal(mismatched.overall_status, "failed");
  assert.equal(mismatched.gates.find(gate => gate.id === "package_versions").status, "failed");
  for (const mutate of [
    o => { delete o.qualification.observations.installed_sdk_distribution; },
    o => { delete o.qualification.observations.p0_delivery.deliverables; },
    o => { o.qualification.observations.p0_delivery.deliverables = {}; },
    o => { o.qualification.candidate_sha256 = "b".repeat(64); },
    o => { o.qualification.source_revision = "another-revision"; },
    o => { o.qualification.version = "another-version"; },
    o => { o.qualification.observations.fresh_v1_local_validation.observed_at = "2026-06-13"; },
    o => { o.qualification.observations.fresh_v1_local_validation.observed_at = "2027-01-01"; },
    o => { o.qualification.observations.p0_delivery.deliverables["agent_cycle_finalization"] = "in_progress"; },
    o => { o.qualification.observations.multi_os_ci_observation.platforms["win32-x64"] = "not_tested"; },
    o => { o.qualification.observations.installed_sdk_distribution.status = "failed"; },
    o => { o.qualification.observations.installed_sdk_distribution.evidence = []; },
    o => { o.qualification.observations.published_tutorial_recipes.passed = 55; },
    o => { o.qualification.observations.published_tutorial_recipes.live = false; },
    o => { o.qualification.observations.published_tutorial_recipes.results[1].document = "first.md"; },
    o => { o.tutorialDocuments.push("new-tutorial.md"); },
    o => { o.qualification.observations.published_tutorial_recipes.scope = "selected"; },
    o => { o.qualification.observations.p0_delivery.deliverables["execution_cost_budgets"] = "in_progress"; },
    o => { o.qualification.observations.p0_delivery.deliverables["history_independent_serving"] = "v1_completed"; },
    o => { o.qualification.observations.installed_sdk_distribution.sdks["win32-x64"].python = "not_tested"; },
    o => { o.qualification.observations.industrial_qualification.checks.http_load_matrix = "not_tested"; },
    o => { o.qualification.observations.desktop_installers.platforms["darwin-x64"].graphical_session = "not_tested"; },
    o => { o.qualification.observations.publisher_signatures.platforms["win32-x64"] = "not_tested"; },
    o => { o.qualification.observations.dependency_security.status = "deferred"; },
    o => { o.qualification.observations.documentation_review.locales.en = "not_tested"; },
    o => { delete o.qualification.observations.public_docs_site_deployment.restore_test; },
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
    const version = "1.0.0-rc.1";
    const names = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].flatMap(platform => [
      `touba-v${version}-${platform}.tar.gz`,
      `touba-v${version}-${platform}-setup.${platform.startsWith("darwin") ? "dmg" : platform === "win32-x64" ? "exe" : "deb"}`,
    ]);
    const file = join(root, names[0]);
    const manifest = join(root, "CHECKSUMS.json");
    const bytes = Buffer.alloc(3 * 65_536 + 17, "qualification-test-only");
    for (const name of names) writeFileSync(join(root, name), bytes);
    const asset = { name: names[0], sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length };
    const value = { version, assets: names.map(name => ({ ...asset, name })) };
    writeFileSync(manifest, JSON.stringify(value));
    const candidate = identifyReleaseCandidate(manifest, "source-commit");
    assert.equal(candidate.version, version);
    assert.equal(candidate.source_revision, "source-commit");
    assert.match(candidate.sha256, /^[a-f0-9]{64}$/);
    for (const assets of [value.assets.slice(0, 4), [...value.assets, asset]]) {
      writeFileSync(manifest, JSON.stringify({ ...value, assets }));
      assert.throws(() => identifyReleaseCandidate(manifest, "source-commit"), /all four|duplicate/);
    }
    writeFileSync(manifest, JSON.stringify({ ...value, assets: [{ ...asset, size_bytes: bytes.length + 1 }, ...value.assets.slice(1)] }));
    assert.throws(() => identifyReleaseCandidate(manifest, "source-commit"), /size mismatch/);
    writeFileSync(manifest, JSON.stringify(value));
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
