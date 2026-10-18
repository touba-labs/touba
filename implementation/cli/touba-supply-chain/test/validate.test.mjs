import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  cpSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { generateSupplyChainLock } from "../src/generate.mjs";

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
    assert.equal(report.handlers[0].handler_package_entrypoint, "search.handler.mjs");
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
    assert.equal(report.checked.effect_contracts, true);
    assert.equal(report.checked.provenance_metadata, true);
    assert.equal(report.checked.review_metadata, true);
    assert.equal(report.checked.review_evidence, true);
    assert.equal(report.checked.review_required, false);
    assert.match(rendered, /Review approved evidence=ok required=no/);
    assert.match(rendered, /Diagnostics ok/);
    assert.doesNotMatch(JSON.stringify(report), /TOUBA_SHOULD_NOT_LEAK/);
  });
});

test("one SDK protocol covers external writes and refuses legacy protocol metadata", () => {
  withFixtureProject((fixture) => {
    fixture.manifest.bindings["tool:examples.sc1/Search"].effect_contract = { kind: "external_write", retry_mode: "idempotency_key" };
    refreshManifestLock(fixture);
    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));
    assert.equal(report.status, "ok");
    assert.equal(report.checked.effect_contracts, true);
    for (const protocol of ["touba-tool-handler-v2", "touba-tool-handler-v3"]) {
      fixture.lock.handlers[0].sdk.protocol = protocol;
      writeJson(fixture.paths.lock, fixture.lock);
      const refused = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));
      assert.equal(refused.handlers[0].sdk_status, "unsupported");
      assertDiagnostic(refused, "HandlerSdkUnsupported");
    }
    fixture.lock.handlers[0].sdk.protocol = "touba-tool-handler-v1";
    fixture.lock.handlers[0].sdk.protocols = ["touba-tool-handler-v1"];
    writeJson(fixture.paths.lock, fixture.lock);
    assert.equal(validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths)).handlers[0].sdk_status, "unsupported");
  });
});

test("validates kind none with the canonical handler protocol", () => {
  withFixtureProject((fixture) => {
    fixture.manifest.manifest_version = "touba-manifest-v1";
    fixture.manifest.bindings["tool:examples.sc1/Search"].effect_contract = { kind: "none" };
    refreshManifestLock(fixture);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));
    assert.equal(report.status, "ok");
    assert.equal(report.handlers[0].sdk_protocol, "touba-tool-handler-v1");
  });
});

test("validates compensation entry references instead of ignoring them", () => {
  withFixtureProject((fixture) => {
    fixture.manifest.manifest_version = "touba-manifest-v1";
    fixture.manifest.bindings["tool:examples.sc1/Search"].effect_contract = {
      kind: "external_write",
      retry_mode: "idempotency_key",
      compensation: { entry_ref: "strategy:examples.sc1/MissingInverse" },
    };
    refreshManifestLock(fixture);

    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));
    assert.equal(report.status, "error");
    assertDiagnostic(report, "CompensationEntryUnresolved");
  });
});

test("rejects unknown effect fields, retry modes and manifest versions fail closed", () => {
  const cases = [
    [{ manifest_version: "touba-manifest-v4" }, "SupplyChainLockSchemaMismatch"],
    [{
      manifest_version: "touba-manifest-v1",
      effect_contract: { kind: "none", vendor: "example" },
    }, "EffectContractFieldUnknown"],
    [{
      manifest_version: "touba-manifest-v1",
      effect_contract: { kind: "external_write", retry_mode: "automatic" },
    }, "EffectRetryModeUnsupported"],
  ];

  for (const [change, expectedCode] of cases) {
    withFixtureProject((fixture) => {
      fixture.manifest.manifest_version = change.manifest_version;
      if (change.effect_contract) {
        fixture.manifest.bindings["tool:examples.sc1/Search"].effect_contract = change.effect_contract;
      }
      refreshManifestLock(fixture);

      const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));
      assert.equal(report.status, "error", expectedCode);
      assertDiagnostic(report, expectedCode);
    });
  }
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
    assert.equal(report.supply_chain_validation_schema_version, "touba-supply-chain-validation-v1");
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
    assert.equal(report.supply_chain_validation_schema_version, "touba-supply-chain-validation-v1");
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

test("generates real digests without approvals or overwriting review decisions", () => {
  withFixtureProject((fixture) => {
    const imported = path.join(path.dirname(fixture.paths.handler), "helper.mjs");
    writeFileSync(imported, "export const value = 1;\n");
    writeFileSync(fixture.paths.handler, "import './helper.mjs';\n" + readFileSync(fixture.paths.handler, "utf8"));
    const output = path.join(fixture.root, "generated.lock.json");
    const options = { ...fixture.paths, out: output, packageRoot: "handlers" };
    const result = generateSupplyChainLock(options);
    assert.equal(result.review_status, "pending");
    const generated = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(generated.review, { status: "pending" });
    assert.equal(generated.handlers[0].digest.value, sha256Text(readFileSync(fixture.paths.handler)));
    assert.equal(generated.handlers[0].handler_package.dependency_artifacts[0].digest.value, sha256Text(readFileSync(fixture.paths.dependencyLock)));
    assert.equal(generated.handlers[0].sdk, undefined);
    assert.ok(generated.handlers[0].handler_package.files.some(file => file.path === "helper.mjs"));
    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts({ ...fixture.paths, lock: output }), { requireReview: true });
    assert.equal(report.status, "error");
    assertDiagnostic(report, "SupplyChainReviewNotApproved");
    assert.throws(() => generateSupplyChainLock(options), /already exists/);
    const cli = spawnSync(process.execPath, [path.join(implementationDir, "cli/touba-project/src/main.mjs"), "supply-chain", "generate", "--air", fixture.paths.air, "--manifest", fixture.paths.manifest, "--out", path.join(fixture.root, "cli.lock.json"), "--package-root", "handlers"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).review_status, "pending");
    const declared = path.join(fixture.root, "sdk.lock.json");
    generateSupplyChainLock({ ...options, out: declared, sdkMetadataJson: JSON.stringify(fixture.lock.handlers[0].sdk) });
    const checked = validateSupplyChainArtifacts(loadSupplyChainArtifacts({ ...fixture.paths, lock: declared }));
    assert.deepEqual(checked.diagnostics.map(item => item.code), ["SupplyChainReviewNotApproved"]);
    assert.throws(() => generateSupplyChainLock({ ...options, out: path.join(fixture.root, "forbidden.lock.json"), sdkMetadataJson: JSON.stringify({ ...fixture.lock.handlers[0].sdk, grants: ["network"] }) }), /SupplyChainAuthorityFieldForbidden/);
    assert.equal(existsSync(path.join(fixture.root, "forbidden.lock.json")), false);
  });
});

test("Python lock inventories real local imports, preserves review, and refuses source/dependency drift", () => {
  withFixtureProject(fixture => {
    const handler = path.join(fixture.root, "handlers/search.py");
    const helper = path.join(fixture.root, "handlers/helper.py");
    const project = path.join(fixture.root, "handlers/pyproject.toml");
    const dependency = path.join(fixture.root, "handlers/pylock.toml");
    writeFileSync(handler, "from helper import answer\nraise RuntimeError('never execute during generation')\n");
    writeFileSync(helper, "answer = 42\n");
    writeFileSync(project, '[project]\nname = "example-python"\nversion = "0.1.0"\ndependencies = ["touba-sdk==0.1.0"]\n');
    const binding = fixture.manifest.bindings["tool:examples.sc1/Search"];
    binding.handler = { kind: "process", command: process.platform === "win32" ? "python" : "python3", cwd: ".", args: ["handlers/search.py"] };
    writeJson(fixture.paths.manifest, fixture.manifest);
    const output = path.join(fixture.root, "python.lock.json");
    const options = { ...fixture.paths, out: output, packageRoot: "handlers", sdkMetadataJson: JSON.stringify({ ...fixture.lock.handlers[0].sdk, name: "touba-sdk" }) };
    assert.throws(() => generateSupplyChainLock(options), /Python package dependencies require a real dependency lockfile/);
    assert.equal(existsSync(output), false);
    // This test checks artifact drift, not resolution/installation of this package.
    writeFileSync(dependency, 'lock-version = "1.0"\n[[packages]]\nname = "touba-sdk"\nversion = "0.1.0"\n');
    generateSupplyChainLock(options);
    const lock = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(lock.handlers[0].handler_package.name, "example-python");
    assert.deepEqual(lock.handlers[0].handler_package.files.map(file => file.path), ["helper.py", "pyproject.toml", "search.py"]);
    assert.deepEqual(lock.handlers[0].handler_package.dependency_artifacts.map(file => file.path), ["pylock.toml"]);
    assert.deepEqual(lock.review, { status: "pending" });
    const check = () => validateSupplyChainArtifacts(loadSupplyChainArtifacts({ ...fixture.paths, lock: output }));
    assert.deepEqual(check().diagnostics.map(item => item.code), ["SupplyChainReviewNotApproved"]);
    for (const file of [handler, helper, project, dependency]) {
      const original = readFileSync(file);
      writeFileSync(file, Buffer.concat([original, Buffer.from("\n")]));
      assert.equal(check().status, "error", file);
      writeFileSync(file, original);
    }
    const cli = spawnSync(process.execPath, [path.join(implementationDir, "cli/touba-project/src/main.mjs"), "supply-chain", "generate", "--air", fixture.paths.air, "--manifest", fixture.paths.manifest, "--out", path.join(fixture.root, "cli-python.lock.json"), "--package-root", "handlers", "--python", process.platform === "win32" ? "python" : "python3"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
  });
});

test("mixed Python/JavaScript handlers retain their own package identities", () => {
  withFixtureProject(fixture => {
    const second = "tool:examples.sc1/Python";
    fixture.air.definitions.tools.push({ id: second, name: "Python" });
    writeJson(fixture.paths.air, fixture.air);
    fixture.manifest.bindings[second] = { ...structuredClone(fixture.manifest.bindings["tool:examples.sc1/Search"]), handler: {
      kind: "process", command: process.platform === "win32" ? "python" : "python3", cwd: ".", args: ["handlers/second.py"],
    } };
    writeJson(fixture.paths.manifest, fixture.manifest);
    writeFileSync(path.join(fixture.root, "handlers/second.py"), "import json\n");
    writeFileSync(path.join(fixture.root, "handlers/pyproject.toml"), '[project]\nname = "python-part"\nversion = "0.1.0"\n');
    const output = path.join(fixture.root, "mixed.lock.json");
    generateSupplyChainLock({ ...fixture.paths, out: output, packageRoot: "handlers" });
    const lock = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(lock.handlers.map(handler => handler.handler_package.name), ["examples.sc1.handlers", "python-part"]);
    for (const handler of lock.handlers) assert.deepEqual(handler.handler_package.files.map(file => file.path), ["package.json", "pyproject.toml", "search.handler.mjs", "second.py"]);
    assert.notEqual(validateSupplyChainArtifacts(loadSupplyChainArtifacts({ ...fixture.paths, lock: output })).status, "error");
  });
});

test("one project lock covers multiple explicit AIRs and refuses any artifact drift", () => {
  withFixtureProject(fixture => {
    const otherAir = path.join(fixture.root, "other.air.json");
    const other = JSON.parse(readFileSync(fixture.paths.air, "utf8"));
    other.module.name = "examples.other";
    other.module.id = "module:examples.other";
    other.definitions.tools = other.definitions.tools.map(tool => ({ ...tool, id: "tool:examples.other/Second" }));
    fixture.manifest.bindings["tool:examples.other/Second"] = structuredClone(Object.values(fixture.manifest.bindings)[0]);
    writeJson(otherAir, other);
    writeJson(fixture.paths.manifest, fixture.manifest);
    const output = path.join(fixture.root, "project.lock.json");
    generateSupplyChainLock({ ...fixture.paths, additionalAir: [otherAir], out: output,
      packageRoot: "handlers", sdkMetadataJson: JSON.stringify(fixture.lock.handlers[0].sdk) });
    for (const air of [fixture.paths.air, otherAir]) {
      const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts({ ...fixture.paths, lock: output, air }));
      assert.deepEqual(report.diagnostics.map(item => item.code), ["SupplyChainReviewNotApproved"]);
      assert.equal(report.handlers.length, 2);
    }
    const original = readFileSync(otherAir, "utf8");
    const cliOutput = path.join(fixture.root, "cli-multi.lock.json");
    const generated = spawnSync(process.execPath, [path.join(implementationDir, "cli/touba-project/src/main.mjs"),
      "supply-chain", "generate", "--air", fixture.paths.air, "--air", otherAir,
      "--manifest", fixture.paths.manifest, "--out", cliOutput, "--package-root", "handlers"], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(JSON.parse(readFileSync(cliOutput, "utf8")).additional_air.length, 1);
    const reviewed = JSON.parse(readFileSync(output, "utf8"));
    reviewed.review = structuredClone(fixture.lock.review);
    writeJson(output, reviewed);
    for (const air of [fixture.paths.air, otherAir]) {
      const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts({ ...fixture.paths, lock: output, air }), { requireReview: true });
      assert.equal(report.status, "ok", JSON.stringify(report.diagnostics));
    }
    writeFileSync(otherAir, original + "\n");
    const drift = validateSupplyChainArtifacts(loadSupplyChainArtifacts({ ...fixture.paths, lock: output }));
    assert.equal(drift.status, "error");
    assertDiagnostic(drift, "SupplyChainDigestMismatch");
    writeFileSync(otherAir, original);
    const lock = JSON.parse(readFileSync(output, "utf8"));
    const validLock = structuredClone(lock);
    lock.additional_air[0] = structuredClone(lock.air);
    writeJson(output, lock);
    assertDiagnostic(validateSupplyChainArtifacts(loadSupplyChainArtifacts({ ...fixture.paths, lock: output })), "SupplyChainLockSchemaMismatch");
    writeJson(output, validLock);
    lock.additional_air[0].path = "../escape.air.json";
    writeJson(output, lock);
    assertDiagnostic(validateSupplyChainArtifacts(loadSupplyChainArtifacts({ ...fixture.paths, lock: output })), "SupplyChainArtifactPathMismatch");
  });
});

test("accepts equivalent project-root aliases without relaxing file confinement", () => {
  withFixtureProject((fixture) => {
    const aliases = mkdtempSync(path.join(tmpdir(), "touba-lock-alias-"));
    try {
      const alias = path.join(aliases, "project");
      symlinkSync(fixture.root, alias, "dir");
      const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts({
        ...fixture.paths, manifest: path.join(alias, path.relative(fixture.root, fixture.paths.manifest)),
      }));
      assert.equal(report.status, "ok", JSON.stringify(report.diagnostics));
    } finally { rmSync(aliases, { recursive: true, force: true }); }
  });
});

test("rejects contradictory paths, an untracked entrypoint, missing commands and symlink escapes", () => {
  for (const [mutate, code] of [
    [(f) => { f.lock.handlers[0].path = "handlers/missing.mjs"; f.lock.handlers[0].handler_package.entrypoint = "missing.mjs"; }, "HandlerPathMismatch"],
    [(f) => { f.lock.handlers[0].handler_package.files.shift(); }, "HandlerPackageEntrypointUntracked"],
    [(f) => { f.lock.air.path = "elsewhere.air.json"; }, "SupplyChainArtifactPathMismatch"],
    [(f) => { f.lock.handlers[0].command = path.join(f.root, "missing-node"); f.manifest.bindings["tool:examples.sc1/Search"].handler.command = f.lock.handlers[0].command; refreshManifestLock(f); }, "HandlerCommandUnavailable"],
    [(f) => { symlinkSync(f.paths.reviewEvidence, path.join(f.root, "handlers", "escape.txt")); f.lock.handlers[0].handler_package.files.push({ path: "escape.txt", digest: { kind: "sha256", value: sha256Text(readFileSync(f.paths.reviewEvidence)) } }); }, "HandlerPackageFileInvalid"],
  ]) withFixtureProject((fixture) => {
    mutate(fixture);
    writeJson(fixture.paths.lock, fixture.lock);
    const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(fixture.paths));
    assert.equal(report.status, "error");
    assertDiagnostic(report, code);
  });
});

test("resolves nested manifests relative to their cwd and package paths relative to the relocated lock", () => {
  withFixtureProject((fixture) => {
    const relocated = mkdtempSync(path.join(tmpdir(), "touba relocated "));
    try {
      fixture.paths.manifest = path.join(fixture.root, ".touba/build/dev/touba.manifest.json");
      mkdirSync(path.dirname(fixture.paths.manifest), { recursive: true });
      fixture.manifest.bindings["tool:examples.sc1/Search"].handler.cwd = "../../..";
      fixture.lock.handlers[0].cwd = "../../..";
      fixture.lock.manifest.path = ".touba/build/dev/touba.manifest.json";
      refreshManifestLock(fixture);
      cpSync(fixture.root, relocated, { recursive: true });
      const paths = Object.fromEntries(Object.entries(fixture.paths).map(([key, value]) => [key, path.join(relocated, path.relative(fixture.root, value))]));
      const report = validateSupplyChainArtifacts(loadSupplyChainArtifacts(paths));
      assert.equal(report.status, "ok", JSON.stringify(report.diagnostics));
    } finally { rmSync(relocated, { recursive: true, force: true }); }
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
          effect_contract: { kind: "none" }, handler: {
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
      lock_schema_version: "touba-lock-v1",
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
            entrypoint: "search.handler.mjs",
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

function refreshManifestLock(fixture) {
  const manifestText = writeJson(fixture.paths.manifest, fixture.manifest);
  fixture.lock.manifest.digest.value = sha256Text(manifestText);
  writeJson(fixture.paths.lock, fixture.lock);
}

function assertDiagnostic(report, code) {
  assert.ok(
    report.diagnostics.some((diagnostic) => diagnostic.code === code),
    `missing diagnostic ${code}\n${JSON.stringify(report, null, 2)}`,
  );
}
