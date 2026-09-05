import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  implementationDir,
  loadSupplyChainArtifacts,
  renderSupplyChainValidation,
  sha256Text,
  validateSupplyChainArtifacts,
} from "../src/validate.mjs";

const validateScript = path.join(implementationDir, "cli/touba-supply-chain/src/validate.mjs");

test("validates coherent AIR, manifest and handler artifacts", () => {
  withFixtureProject((fixture) => {
    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));
    const rendered = renderSupplyChainValidation(report);

    assert.equal(report.status, "ok");
    assert.equal(report.artifacts.air.drift_status, "ok");
    assert.equal(report.artifacts.manifest.drift_status, "ok");
    assert.equal(report.handlers[0].drift_status, "ok");
    assert.equal(report.handlers[0].sdk_name, "@touba/sdk");
    assert.equal(report.handlers[0].sdk_version, "0.1.0");
    assert.equal(report.handlers[0].sdk_protocol, "touba-tool-handler-v1");
    assert.equal(report.handlers[0].handler_package_status, "ok");
    assert.equal(report.handlers[0].handler_package_kind, "local");
    assert.equal(report.handlers[0].handler_package_name, "examples.sc1.handlers");
    assert.equal(report.handlers[0].handler_package_version, "0.1.0");
    assert.equal(report.handlers[0].handler_package_entrypoint, "handlers/search.handler.mjs");
    assert.equal(report.handlers[0].handler_package_root, "handlers");
    assert.equal(report.handlers[0].handler_package_files_status, "ok");
    assert.equal(report.handlers[0].handler_dependency_artifacts_status, "ok");
    assert.equal(report.provenance.status, "ok");
    assert.equal(report.provenance.prepared_by_kind, "ci");
    assert.equal(report.provenance.source_kind, "git");
    assert.equal(report.review.status, "approved");
    assert.equal(report.review.evidence_status, "ok");
    assert.equal(report.review.reviewers, 1);
    assert.equal(report.checked.handler_package_files, true);
    assert.equal(report.checked.handler_dependency_artifacts, true);
    assert.equal(report.checked.provenance_metadata, true);
    assert.equal(report.checked.review_metadata, true);
    assert.equal(report.checked.review_evidence, true);
    assert.equal(report.checked.review_required, false);
    assert.match(rendered, /Review approved evidence=ok required=no/);
    assert.match(rendered, /Diagnostics ok/);
    assert.doesNotMatch(JSON.stringify(report), /TOUBA_SHOULD_NOT_LEAK/);
  });
});

test("keeps review optional unless explicitly required", () => {
  withFixtureProject((fixture) => {
    delete fixture.lock.review;
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "ok");
    assert.equal(report.review.status, "unknown");
  });
});

test("requires approved review when requested", () => {
  withFixtureProject((fixture) => {
    delete fixture.lock.review;
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths), { requireReview: true });

    assert.equal(report.status, "error");
    assert.equal(report.review.status, "missing");
    assert.equal(report.checked.review_required, true);
    assertDiagnostic(report, "SupplyChainReviewMissing");
  });
});

test("accepts approved review when required", () => {
  withFixtureProject((fixture) => {
    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths), { requireReview: true });

    assert.equal(report.status, "ok");
    assert.equal(report.review.status, "approved");
    assert.equal(report.checked.review_required, true);
  });
});

test("refuses rejected review", () => {
  withFixtureProject((fixture) => {
    fixture.lock.review.status = "rejected";
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assertDiagnostic(report, "SupplyChainReviewRejected");
  });
});

test("reports changed review evidence digest", () => {
  withFixtureProject((fixture) => {
    writeFileSync(fixture.paths.reviewEvidence, "changed review evidence\n", "utf8");

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assert.equal(report.review.evidence_status, "changed");
    assertDiagnostic(report, "SupplyChainReviewEvidenceChanged");
  });
});

test("refuses compliance claims in review metadata", () => {
  withFixtureProject((fixture) => {
    fixture.lock.review.compliance_status = "passed";
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assertDiagnostic(report, "SupplyChainUnsupportedTrustClaim");
  });
});

test("reports missing handler without workspace discovery", () => {
  withFixtureProject((fixture) => {
    rmSync(fixture.paths.handler, { force: true });

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assert.equal(report.handlers[0].drift_status, "missing");
    assertDiagnostic(report, "HandlerMissing");
  });
});

test("reports changed handler digest", () => {
  withFixtureProject((fixture) => {
    writeFileSync(fixture.paths.handler, "export default 'changed';\n", "utf8");

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assert.equal(report.handlers[0].drift_status, "changed");
    assertDiagnostic(report, "HandlerChanged");
  });
});

test("reports unknown SDK metadata as warning", () => {
  withFixtureProject((fixture) => {
    delete fixture.lock.handlers[0].sdk;
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "warning");
    assert.equal(report.handlers[0].sdk_status, "unknown");
    assertDiagnostic(report, "HandlerSdkUnknown");
  });
});

test("reports missing SDK status as warning", () => {
  withFixtureProject((fixture) => {
    fixture.lock.handlers[0].sdk = {
      status: "missing",
    };
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "warning");
    assert.equal(report.handlers[0].sdk_status, "unsupported");
    assertDiagnostic(report, "HandlerSdkUnsupported");
  });
});

test("reports incompatible SDK protocol as warning", () => {
  withFixtureProject((fixture) => {
    fixture.lock.handlers[0].sdk.protocol = "other-protocol";
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "warning");
    assert.equal(report.handlers[0].sdk_status, "unsupported");
    assertDiagnostic(report, "HandlerSdkUnsupported");
  });
});

test("reports unsupported SDK version as warning", () => {
  withFixtureProject((fixture) => {
    fixture.lock.handlers[0].sdk.version = "9.9.9";
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "warning");
    assert.equal(report.handlers[0].sdk_status, "unsupported");
    assertDiagnostic(report, "HandlerSdkUnsupported");
  });
});

test("reports missing handler package metadata as warning", () => {
  withFixtureProject((fixture) => {
    delete fixture.lock.handlers[0].handler_package;
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "warning");
    assert.equal(report.handlers[0].handler_package_status, "unknown");
    assertDiagnostic(report, "HandlerPackageUnknown");
  });
});

test("reports unsupported handler package kind as error", () => {
  withFixtureProject((fixture) => {
    fixture.lock.handlers[0].handler_package.kind = "registry";
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assert.equal(report.handlers[0].handler_package_status, "unsupported");
    assertDiagnostic(report, "HandlerPackageUnsupported");
  });
});

test("reports handler package entrypoint mismatch as changed", () => {
  withFixtureProject((fixture) => {
    fixture.lock.handlers[0].handler_package.entrypoint = "handlers/other.handler.mjs";
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assert.equal(report.handlers[0].drift_status, "changed");
    assert.equal(report.handlers[0].handler_package_status, "mismatch");
    assertDiagnostic(report, "HandlerPackageEntrypointMismatch");
  });
});

test("reports changed handler package file digest", () => {
  withFixtureProject((fixture) => {
    writeFileSync(fixture.paths.packageManifest, "{\"name\":\"changed\"}\n", "utf8");

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assert.equal(report.handlers[0].handler_package_files_status, "changed");
    assertDiagnostic(report, "HandlerPackageFileChanged");
  });
});

test("reports changed handler dependency artifact digest", () => {
  withFixtureProject((fixture) => {
    writeFileSync(fixture.paths.dependencyLock, "lockfile changed\n", "utf8");

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assert.equal(report.handlers[0].handler_dependency_artifacts_status, "changed");
    assertDiagnostic(report, "HandlerDependencyArtifactChanged");
  });
});

test("refuses handler package artifact path traversal", () => {
  withFixtureProject((fixture) => {
    fixture.lock.handlers[0].handler_package.files[0].path = "../outside.handler.mjs";
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assert.equal(report.handlers[0].handler_package_files_status, "invalid");
    assertDiagnostic(report, "HandlerPackageFileInvalid");
  });
});

test("refuses dependency vulnerability audit claims in the lock", () => {
  withFixtureProject((fixture) => {
    fixture.lock.handlers[0].handler_package.dependency_audit_status = "passed";
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assertDiagnostic(report, "DependencyAuditUnsupported");
  });
});

test("continues to refuse package authority claims outside handler_package", () => {
  withFixtureProject((fixture) => {
    fixture.lock.handlers[0].package = {
      registry: "https://registry.example.invalid",
    };
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));

    assert.equal(report.status, "error");
    assertDiagnostic(report, "SupplyChainRegistryUnsupported");
  });
});

test("refuses authority fields and sensitive values without copying the value", () => {
  withFixtureProject((fixture) => {
    fixture.lock.handlers[0].grants = ["network"];
    fixture.lock.secret_value = "TOUBA_SHOULD_NOT_LEAK";
    fixture.lock.handlers[0].handler_source = "console.log('raw handler')";
    writeJson(fixture.paths.lock, fixture.lock);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));
    const serialized = JSON.stringify(report);

    assert.equal(report.status, "error");
    assertDiagnostic(report, "SupplyChainAuthorityFieldForbidden");
    assertDiagnostic(report, "SupplyChainSecretLeakDetected");
    assertDiagnostic(report, "SupplyChainHandlerContentLeakDetected");
    assert.doesNotMatch(serialized, /TOUBA_SHOULD_NOT_LEAK|raw handler/);
  });
});

test("CLI validates SC-1 lock and supports JSON output", () => {
  withFixtureProject((fixture) => {
    const result = spawnSync(
      process.execPath,
      [
        validateScript,
        "--lock",
        fixture.paths.lock,
        "--air",
        fixture.paths.air,
        "--manifest",
        fixture.paths.manifest,
        "--output",
        "json",
        "--require-review",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.supply_chain_validation_schema_version, "touba-supply-chain-validation-v0.1");
    assert.equal(report.status, "ok");
  });
});

test("CLI writes an explicit supply-chain report with the canonical suffix", () => {
  withFixtureProject((fixture) => {
    const reportPath = path.join(fixture.root, "sc.supply-chain-report.json");
    const result = spawnSync(
      process.execPath,
      [
        validateScript,
        "--lock",
        fixture.paths.lock,
        "--air",
        fixture.paths.air,
        "--manifest",
        fixture.paths.manifest,
        "--report-out",
        reportPath,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Touba Supply Chain/);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.supply_chain_validation_schema_version, "touba-supply-chain-validation-v0.1");
    assert.equal(report.status, "ok");
  });
});

test("CLI refuses ambiguous supply-chain report output suffixes", () => {
  withFixtureProject((fixture) => {
    const reportPath = path.join(fixture.root, "sc.report.json");
    const result = spawnSync(
      process.execPath,
      [
        validateScript,
        "--lock",
        fixture.paths.lock,
        "--air",
        fixture.paths.air,
        "--manifest",
        fixture.paths.manifest,
        "--report-out",
        reportPath,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--report-out path must end with \.supply-chain-report\.json/);
    assert.throws(() => readFileSync(reportPath, "utf8"));
  });
});

test("CLI strict mode fails on warning", () => {
  withFixtureProject((fixture) => {
    delete fixture.lock.handlers[0].sdk;
    writeJson(fixture.paths.lock, fixture.lock);

    const result = spawnSync(
      process.execPath,
      [
        validateScript,
        "--lock",
        fixture.paths.lock,
        "--air",
        fixture.paths.air,
        "--manifest",
        fixture.paths.manifest,
        "--strict",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /HandlerSdkUnknown/);
  });
});

function withFixtureProject(callback) {
  const root = mkdtempSync(path.join(tmpdir(), "touba-sc1-"));
  try {
    const handlerDir = path.join(root, "handlers");
    mkdirSync(handlerDir, { recursive: true });

    const paths = {
      air: path.join(root, "program.air.json"),
      manifest: path.join(root, "touba.manifest.json"),
      lock: path.join(root, "touba.lock.json"),
      handler: path.join(handlerDir, "search.handler.mjs"),
      packageManifest: path.join(handlerDir, "package.json"),
      dependencyLock: path.join(handlerDir, "pnpm-lock.yaml"),
      reviewEvidence: path.join(root, "review-note.txt"),
    };

    const handlerText = "export function run() { return { ok: true }; }\n";
    writeFileSync(paths.handler, handlerText, "utf8");
    const packageManifestText = writeJson(paths.packageManifest, {
      name: "examples.sc1.handlers",
      version: "0.1.0",
      type: "module",
    });
    const dependencyLockText = "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n";
    writeFileSync(paths.dependencyLock, dependencyLockText, "utf8");
    const reviewEvidenceText = "reviewed supply chain lock against SC-1/SC-2 local evidence\n";
    writeFileSync(paths.reviewEvidence, reviewEvidenceText, "utf8");

    const air = {
      air_schema_version: "touba-air-v1",
      module: {
        id: "module:examples.sc1",
        name: "examples.sc1",
      },
      definitions: {
        types: [],
        functions: [],
        tools: [
          {
            id: "tool:examples.sc1/Search",
            name: "Search",
          },
        ],
        skills: [],
        agents: [],
        strategies: [],
      },
      execution_graphs: [],
    };
    const airText = writeJson(paths.air, air);

    const manifest = {
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:examples.sc1/Search": {
          handler: {
            kind: "process",
            command: "node",
            cwd: ".",
            args: ["handlers/search.handler.mjs"],
          },
          grants: ["network"],
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
        },
      },
    };
    const manifestText = writeJson(paths.manifest, manifest);

    const lock = {
      lock_schema_version: "touba-lock-v0.1",
      lock_kind: "supply_chain",
      generated_at: "2026-06-05T12:00:00Z",
      generated_by: {
        tool: "touba prepare",
        version: "0.1.0",
      },
      provenance: {
        prepared_by: {
          kind: "ci",
          id: "ci:touba-fixture",
        },
        prepared_at: "2026-06-05T12:00:00Z",
        source: {
          kind: "git",
          ref: "refs/heads/main",
          commit: "0123456789abcdef",
        },
      },
      review: {
        status: "approved",
        reviewed_at: "2026-06-05T12:30:00Z",
        reviewers: [
          {
            kind: "human",
            id: "reviewer:security",
            role: "security",
          },
        ],
        evidence: [
          {
            kind: "review_note",
            path: "review-note.txt",
            digest: {
              kind: "sha256",
              value: sha256Text(reviewEvidenceText),
            },
          },
        ],
      },
      air: {
        path: "program.air.json",
        digest: {
          kind: "sha256",
          value: sha256Text(airText),
        },
      },
      manifest: {
        path: "touba.manifest.json",
        digest: {
          kind: "sha256",
          value: sha256Text(manifestText),
        },
      },
      handlers: [
        {
          tool_ref: "tool:examples.sc1/Search",
          path: "handlers/search.handler.mjs",
          command: "node",
          cwd: ".",
          args: ["handlers/search.handler.mjs"],
          digest: {
            kind: "sha256",
            value: sha256Text(handlerText),
          },
          sdk: {
            name: "@touba/sdk",
            version: "0.1.0",
            protocol: "touba-tool-handler-v1",
            status: "ok",
          },
          handler_package: {
            kind: "local",
            name: "examples.sc1.handlers",
            version: "0.1.0",
            entrypoint: "handlers/search.handler.mjs",
            package_root: "handlers",
            files: [
              {
                path: "search.handler.mjs",
                digest: {
                  kind: "sha256",
                  value: sha256Text(handlerText),
                },
              },
              {
                path: "package.json",
                digest: {
                  kind: "sha256",
                  value: sha256Text(packageManifestText),
                },
              },
            ],
            dependency_artifacts: [
              {
                path: "pnpm-lock.yaml",
                digest: {
                  kind: "sha256",
                  value: sha256Text(dependencyLockText),
                },
              },
            ],
          },
        },
      ],
    };
    writeJson(paths.lock, lock);

    callback({
      root,
      paths,
      air,
      manifest,
      lock,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(filePath, text, "utf8");
  return text;
}

function assertDiagnostic(report, code) {
  assert.ok(
    report.diagnostics.some((diagnostic) => diagnostic.code === code),
    `missing diagnostic ${code}\n${JSON.stringify(report, null, 2)}`,
  );
}
