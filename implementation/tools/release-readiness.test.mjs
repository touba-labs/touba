import test from "node:test";
import assert from "node:assert/strict";

import {
  RELEASE_READINESS_SCHEMA_VERSION,
  buildReleaseReadinessReport,
  parseReleaseReadinessArgs,
  renderReleaseReadinessReport,
} from "./release-readiness.mjs";

const requiredScripts = {
  "validate:v1-local": "pnpm validate:v1-local",
  "test:runtime": "pnpm test:runtime",
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
    satisfied: 21,
    pending: 0,
    blocked: 2,
    failed: 0,
  });
  assert.equal(report.gates.find((gate) => gate.id === "external_user_validation")?.status, "blocked");
  assert.equal(report.gates.find((gate) => gate.id === "public_docs_site_deployment")?.status, "blocked");
  assert.equal(report.gates.find((gate) => gate.id === "fresh_v1_local_validation")?.status, "satisfied");
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
