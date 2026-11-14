import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = new URL("../src/main.mjs", import.meta.url).pathname;

test("CLI registry resolve writes a verified draft static lock with explicit opt-in", () => {
  const fixture = createRegistryFixture();
  try {
    const outPath = join(fixture.root, "resolved.lock.json");
    const result = runCli([
      "registry",
      "resolve",
      "--registry",
      fixture.registryRoot,
      "--package",
      "pkg:example.package",
      "--version",
      "0.1.0",
      "--source-root",
      fixture.sourceRoot,
      "--allow-draft",
      "--generated-on",
      "2026-06-12",
      "--out",
      outPath,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const lock = JSON.parse(result.stdout);
    assert.equal(lock.lock_schema_version, "touba-static-registry-lock-v1");
    assert.equal(lock.package.status, "draft");
    assert.equal(lock.artifacts[0].verified, true);
    assert.equal(existsSync(outPath), true);
    assert.equal(JSON.parse(readFileSync(outPath, "utf8")).artifacts[0].verified, true);
  } finally {
    cleanup(fixture.root);
  }
});

test("CLI registry resolve refuses draft packages without explicit opt-in", () => {
  const fixture = createRegistryFixture();
  try {
    const result = runCli([
      "registry",
      "resolve",
      "--registry",
      fixture.registryRoot,
      "--package",
      "pkg:example.package",
      "--version",
      "0.1.0",
      "--source-root",
      fixture.sourceRoot,
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /RegistryPackageDraft/);
  } finally {
    cleanup(fixture.root);
  }
});

test("CLI registry resolve distinguishes missing versions", () => {
  const fixture = createRegistryFixture();
  try {
    const result = runCli([
      "registry",
      "resolve",
      "--registry",
      fixture.registryRoot,
      "--package",
      "pkg:example.package",
      "--version",
      "9.9.9",
      "--allow-draft",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /RegistryPackageVersionMissing/);
  } finally {
    cleanup(fixture.root);
  }
});

test("CLI registry resolve refuses metadata digest mismatches", () => {
  const fixture = createRegistryFixture({ metadataDigest: zeroDigest() });
  try {
    const result = runCli([
      "registry",
      "resolve",
      "--registry",
      fixture.registryRoot,
      "--package",
      "pkg:example.package",
      "--version",
      "0.1.0",
      "--source-root",
      fixture.sourceRoot,
      "--allow-draft",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /RegistryMetadataDigestMismatch/);
  } finally {
    cleanup(fixture.root);
  }
});

test("CLI registry resolve refuses source artifact digest mismatches", () => {
  const fixture = createRegistryFixture({ artifactDigest: zeroDigest() });
  try {
    const result = runCli([
      "registry",
      "resolve",
      "--registry",
      fixture.registryRoot,
      "--package",
      "pkg:example.package",
      "--version",
      "0.1.0",
      "--source-root",
      fixture.sourceRoot,
      "--allow-draft",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /RegistryArtifactDigestMismatch/);
  } finally {
    cleanup(fixture.root);
  }
});

test("CLI registry resolve refuses incompatible protocols", () => {
  const fixture = createRegistryFixture({ protocols: ["unknown-protocol-v1"] });
  try {
    const result = runCli([
      "registry",
      "resolve",
      "--registry",
      fixture.registryRoot,
      "--package",
      "pkg:example.package",
      "--version",
      "0.1.0",
      "--source-root",
      fixture.sourceRoot,
      "--allow-draft",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /RegistryProtocolIncompatible/);
  } finally {
    cleanup(fixture.root);
  }
});

test("CLI registry resolve refuses yanked packages", () => {
  const fixture = createRegistryFixture({ status: "yanked", withdrawal: { reason: 'Unsafe handler. Use 0.2.0.', changed_at: '2026-11-14T12:00:00Z' } });
  try {
    const result = runCli([
      "registry",
      "resolve",
      "--registry",
      fixture.registryRoot,
      "--package",
      "pkg:example.package",
      "--version",
      "0.1.0",
      "--source-root",
      fixture.sourceRoot,
      "--allow-draft",
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /RegistryPackageYanked/);
    assert.match(result.stderr, /Unsafe handler\. Use 0\.2\.0\./);
  } finally {
    cleanup(fixture.root);
  }
});

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

function createRegistryFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "touba-registry-cli-"));
  const registryRoot = join(root, "registry");
  const sourceRoot = join(root, "touba-library");
  const sourcePack = join(sourceRoot, "packages/example.package");
  const metadataDir = join(registryRoot, "packages/example/package/0.1.0");
  mkdirSync(sourcePack, { recursive: true });
  mkdirSync(metadataDir, { recursive: true });

  const descriptorPath = join(sourcePack, "touba.package.json");
  writeJson(descriptorPath, {
    package_schema_version: "touba-package-v1", name: "example.package", version: "0.1.0",
    touba: { air_profile: "touba-air-json-canonical-v1", runtime_compatibility: ">=1.0.0 <2.0.0" },
    exports: {}, contexts: [{ id: "review", description: "Review supplied evidence.", procedure: "SKILL.md" }],
  });
  writeFileSync(join(sourcePack, "SKILL.md"), "# Review\nReview the supplied evidence.\n");

  const metadata = {
    schema_version: "touba-registry-package-v1",
    package_ref: "pkg:example.package",
    namespace: "example",
    name: "package",
    version: "0.1.0",
    kind: "touba_package",
    status: options.status ?? "draft",
    ...(options.withdrawal ? { withdrawal: options.withdrawal } : {}),
    summary: "Example pack.",
    source: {
      type: "git",
      url: "https://example.com/packages",
      path: "packages/example.package",
      revision: "main",
    },
    compatibility: {
      touba: ">=1.0.0 <2.0.0",
      protocols: options.protocols ?? ["touba-package-v1"],
    },
    artifacts: [
      {
        kind: "package_manifest",
        path: "packages/example.package/touba.package.json",
        digest: options.artifactDigest ?? digestFile(descriptorPath),
      },
    ],
    publication: {
      review: "required",
      published_by: "Khadim Lo",
      published_on: "2026-06-12",
    },
    limits: ["Draft fixture."],
  };
  const metadataPath = join(metadataDir, "package.json");
  writeJson(metadataPath, metadata);
  const metadataDigest = options.metadataDigest ?? digestFile(metadataPath);
  writeJson(join(registryRoot, "index.json"), {
    index_schema_version: "touba-registry-index-v1",
    updated_on: "2026-06-12",
    packages: [
      {
        package_ref: metadata.package_ref,
        version: metadata.version,
        kind: metadata.kind,
        status: metadata.status,
        metadata_path: "packages/example/package/0.1.0/package.json",
        metadata_digest: metadataDigest,
      },
    ],
  });
  return { root, registryRoot, sourceRoot };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digestFile(filePath) {
  return `sha256:${crypto.createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
}

function zeroDigest() {
  return "sha256:0000000000000000000000000000000000000000000000000000000000000000";
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}
