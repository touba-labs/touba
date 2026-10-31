import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDeploymentBundle,
  createRevisionStore,
  deploymentReadinessChecks,
  verifyDeploymentBundle,
} from "../src/index.mjs";
import { createDeploymentTargetService } from "../src/serve.mjs";
import { newPackage, packPackage, addPackage } from "../../touba-project/src/packages.mjs";
import { packageHostInventory } from "../../touba-project/src/package-host-plan.mjs";

const TOKEN = "deployment-test-token-with-at-least-32-characters";

test("deployment bundles are deterministic, verified and contain no secret stores", () => {
  const project = createProject();
  try {
    const options = {
      projectRoot: project.root,
      profile: "prod",
      createdAt: "2026-07-23T00:00:00.000Z",
      sourceRevision: { commit: "0123456789abcdef", dirty: false },
    };
    const first = buildDeploymentBundle(options);
    const second = buildDeploymentBundle(options);
    assert.deepEqual(second, first);
    const later = buildDeploymentBundle({
      ...options,
      createdAt: "2026-07-23T00:10:00.000Z",
    });
    assert.equal(later.bundle_id, first.bundle_id);
    assert.equal(later.bundle_sha256, first.bundle_sha256);
    assert.notEqual(later.created_at, first.created_at);
    assert.equal(first.artifacts.some((item) => item.path === ".env"), false);
    assert.equal(first.artifacts.some((item) => item.path.includes("secrets")), false);
    assert.equal(first.artifacts.some((item) => item.path === "src/main.tb"), true);
    assert.equal(verifyDeploymentBundle(first).artifact_count, first.artifacts.length);

    const tampered = structuredClone(first);
    tampered.artifacts[0].content_base64 = Buffer.from("tampered").toString("base64");
    assert.throws(() => verifyDeploymentBundle(tampered), /digest/u);
  } finally {
    project.dispose();
  }
});

test("prod bundle creation rejects missing lock and raw secret values", () => {
  const project = createProject();
  try {
    rmSync(join(project.root, "touba.lock.json"));
    assert.throws(
      () => buildDeploymentBundle({ projectRoot: project.root, profile: "prod" }),
      /requires touba\.lock\.json/u,
    );
    writeFileSync(join(project.root, "touba.lock.json"), "{}\n", "utf8");
    writeFileSync(join(project.root, "touba.resources.json"), JSON.stringify({
      resource_bindings_schema_version: "touba-resource-bindings-v1",
      resources: {},
      connection_string: "postgres://raw-secret",
    }), "utf8");
    assert.throws(
      () => buildDeploymentBundle({ projectRoot: project.root, profile: "prod" }),
      /raw secret-like value/u,
    );
  } finally {
    project.dispose();
  }
});

test("production readiness blocks generated handler stubs", () => {
  const project = createProject();
  try {
    writeFileSync(join(project.root, "handlers", "pending.handler.mjs"), [
      "#!/usr/bin/env node",
      "// Touba generated handler stub v0.1",
      "process.stderr.write(`${code}\\n`);",
      "",
    ].join("\n"), "utf8");
    const prod = buildDeploymentBundle({
      projectRoot: project.root,
      profile: "prod",
      sourceRevision: { commit: "stub-check", dirty: false },
    });
    const prodChecks = deploymentReadinessChecks(prod, { targetConfigured: true });
    assert.equal(
      prodChecks.find((check) => check.code === "ToubaDeploymentHandlerImplementation").status,
      "blocked",
    );
    const dev = buildDeploymentBundle({
      projectRoot: project.root,
      profile: "dev",
      sourceRevision: { commit: "stub-check", dirty: true },
    });
    assert.equal(
      deploymentReadinessChecks(dev, { targetConfigured: true })
        .find((check) => check.code === "ToubaDeploymentHandlerImplementation").status,
      "passed",
    );
  } finally {
    project.dispose();
  }
});

test("revision store publishes immutable artifacts, activates revisions and rolls back", () => {
  const project = createProject();
  const storageRoot = mkdtempSync(join(tmpdir(), "touba-deployment-store-"));
  try {
    const store = createRevisionStore({ storageRoot });
    const first = buildDeploymentBundle({
      projectRoot: project.root,
      profile: "prod",
      createdAt: "2026-07-23T00:00:00.000Z",
      sourceRevision: { commit: "revision-one", dirty: false },
    });
    const firstPublished = store.publish(first, {
      publishedBy: "user:khadim",
      publishedAt: "2026-07-23T00:00:01.000Z",
    });
    assert.equal(firstPublished.action, "published");
    const firstActive = store.activate(first.bundle_sha256, {
      activatedBy: "user:khadim",
      activatedAt: "2026-07-23T00:00:02.000Z",
      expectedState: firstPublished.state_digest,
    });
    assert.equal(firstActive.current_revision_id, first.bundle_sha256);
    assert.throws(() => store.activate(first.bundle_sha256, { expectedState: firstPublished.state_digest }), { code: "ToubaDeploymentStateConflict" });

    writeFileSync(join(project.root, "src", "main.tb"), [
      "module demo.deploy",
      "",
      "memory SecondRevision",
      "",
    ].join("\n"), "utf8");
    const second = buildDeploymentBundle({
      projectRoot: project.root,
      profile: "prod",
      createdAt: "2026-07-23T00:00:03.000Z",
      sourceRevision: { commit: "revision-two", dirty: false },
    });
    store.publish(second, {
      publishedBy: "user:khadim",
      publishedAt: "2026-07-23T00:00:04.000Z",
    });
    store.activate(second.bundle_sha256, {
      activatedBy: "user:khadim",
      activatedAt: "2026-07-23T00:00:05.000Z",
    });
    const rolledBack = store.rollback({
      rolledBackBy: "user:khadim",
      rolledBackAt: "2026-07-23T00:00:06.000Z",
    });
    assert.equal(rolledBack.action, "rolled_back");
    assert.equal(rolledBack.current_revision_id, first.bundle_sha256);
    const beforeAba = store.list();
    store.rollback({ expectedState: beforeAba.state_digest });
    store.rollback({ expectedState: store.list().state_digest });
    assert.equal(store.list().current_revision_id, beforeAba.current_revision_id);
    assert.equal(store.list().previous_revision_id, beforeAba.previous_revision_id);
    assert.notEqual(store.list().state_digest, beforeAba.state_digest);
    assert.throws(() => store.rollback({ expectedState: beforeAba.state_digest }), { code: "ToubaDeploymentStateConflict" });
    assert.equal(
      readFileSync(join(storageRoot, "revisions", first.bundle_sha256, "artifacts", "src", "main.tb"), "utf8"),
      "module demo.deploy\n",
    );
  } finally {
    project.dispose();
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("revision store refuses a previously materialized artifact that no longer matches its digest", () => {
  const project = createProject();
  const storageRoot = mkdtempSync(join(tmpdir(), "touba-deployment-corruption-"));
  try {
    const store = createRevisionStore({ storageRoot });
    const bundle = buildDeploymentBundle({
      projectRoot: project.root,
      profile: "prod",
      createdAt: "2026-07-23T00:00:00.000Z",
      sourceRevision: { commit: "revision-corruption-test", dirty: false },
    });
    store.publish(bundle);
    writeFileSync(
      join(storageRoot, "revisions", bundle.bundle_sha256, "artifacts", "src", "main.tb"),
      "module demo.tampered\n",
      "utf8",
    );
    assert.throws(
      () => store.publish(bundle),
      (error) => error.code === "ToubaDeploymentRevisionCorrupt",
    );
    assert.throws(() => store.activate(bundle.bundle_sha256), { code: "ToubaDeploymentRevisionCorrupt" });
    assert.throws(() => store.readBundle(bundle.bundle_sha256), { code: "ToubaDeploymentRevisionCorrupt" });
  } finally {
    project.dispose();
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("bundle includes Python, SDK requirements and the full locked package inventory without runtime state", async () => {
  const project = createProject();
  const author = realpathSync(mkdtempSync(join(tmpdir(), "touba-deploy-package-")));
  try {
    const configPath = join(project.root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, language: "python", sdk: "touba-sdk" }));
    writeFileSync(join(project.root, "handlers/echo.py"), "from touba_sdk import serve_tool\n");
    writeFileSync(join(project.root, "pyproject.toml"), '[project]\nname = "fixture"\nversion = "1.0.0"\ndependencies = ["touba-sdk==1.0.0"]\n');
    writeFileSync(join(project.root, "uv.lock"), "version = 1\n");
    mkdirSync(join(project.root, ".touba"));
    writeFileSync(join(project.root, ".touba/checkpoint.json"), "{}");
    mkdirSync(join(project.root, ".venv/lib"), { recursive: true });
    writeFileSync(join(project.root, ".venv/lib/private.py"), "# excluded");
    const pkg = newPackage("fixture.deploy", { root: author, publisher: "Fixture", description: "Package deployment", license: "Apache-2.0", version: "1.0.0" });
    const packed = await packPackage(pkg.path, { output: join(author, "archive.tar.gz") });
    await addPackage(packed.output, { root: project.root });
    writeFileSync(join(project.root, 'touba.hosts.json'), JSON.stringify({
      schema_version: 'touba-package-host-plan-v1', hosts: {}, package_lock_digest: packageHostInventory(project.root).package_lock_digest,
    }));
    const bundle = buildDeploymentBundle({ projectRoot: project.root, profile: "dev" });
    const paths = bundle.artifacts.map(item => item.path);
    for (const path of ["handlers/echo.py", "pyproject.toml", "uv.lock", "touba.hosts.json", "touba.packages.lock.json", "packages/fixture.deploy/README.md"]) assert.ok(paths.includes(path), path);
    assert.ok(!paths.some(path => path.startsWith(".touba/") || path.startsWith(".venv/")));
    const lock = JSON.parse(readFileSync(join(project.root, "touba.packages.lock.json")));
    for (const file of lock.packages[0].files) assert.ok(paths.includes(`packages/fixture.deploy/${file.path}`));
    writeFileSync(join(project.root, "packages/fixture.deploy/README.md"), "tampered");
    assert.throws(() => buildDeploymentBundle({ projectRoot: project.root, profile: "dev" }), /differs from its lock/);
  } finally { project.dispose(); rmSync(author, { recursive: true, force: true }); }
});

test("bundle refuses noncanonical paths and symlinked materialization", () => {
  const project = createProject(), storageRoot = mkdtempSync(join(tmpdir(), "touba-deploy-paths-"));
  try {
    const bundle = buildDeploymentBundle({ projectRoot: project.root, profile: "dev" });
    for (const path of ["x/../file", "x\\..\\file", "C:/file", "src//main.tb", "./main.tb", ".touba/checkpoint.json"]) {
      const bad = structuredClone(bundle); bad.artifacts[0].path = path;
      assert.throws(() => verifyDeploymentBundle(bad), { code: "ToubaDeploymentArtifactPathRejected" });
    }
    const store = createRevisionStore({ storageRoot }); store.publish(bundle);
    const path = join(storageRoot, "revisions", bundle.bundle_sha256, "artifacts/src/main.tb");
    rmSync(path); symlinkSync(join(project.root, "src/main.tb"), path);
    assert.throws(() => store.activate(bundle.bundle_sha256), { code: "ToubaDeploymentArtifactPathRejected" });
  } finally { project.dispose(); rmSync(storageRoot, { recursive: true, force: true }); }
});

test("deployment target requires strong authentication and TLS outside loopback", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "touba-deployment-service-"));
  assert.throws(
    () => createDeploymentTargetService({
      host: "0.0.0.0",
      port: 0,
      storageRoot,
      token: TOKEN,
    }),
    /require TLS/u,
  );
  const service = createDeploymentTargetService({
    host: "127.0.0.1",
    port: 0,
    storageRoot,
    token: TOKEN,
  });
  try {
    const address = await service.start();
    const baseUrl = `${address.protocol}://${address.host}:${address.port}`;
    const unauthorized = await fetch(`${baseUrl}/revisions`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${baseUrl}/revisions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).schema_version, "touba-deployment-status-v1");
  } finally {
    await service.stop();
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

function createProject() {
  const root = mkdtempSync(join(tmpdir(), "touba-deployment-project-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "handlers"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.deploy\n", "utf8");
  writeFileSync(join(root, "touba.project.json"), `${JSON.stringify({
    project_version: "touba-project-v1",
    language: "javascript",
    sdk: "@touba/sdk",
    artifact_layout: "touba-artifacts-v1",
    run_profiles: {
      dev: { require_supply_chain_lock: false },
      prod: {
        require_supply_chain_lock: true,
        supply_chain_lock: "touba.lock.json",
      },
    },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "touba.manifest.json"), `${JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {},
    triggers: {},
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "touba.lock.json"), `${JSON.stringify({
    lock_version: "touba-lock-v1",
    artifacts: [],
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, ".env"), "RAW_SECRET=never-bundle-this\n", "utf8");
  writeFileSync(join(root, "touba.secrets.dev.json"), "{\"secret\":\"never-bundle-this\"}\n", "utf8");
  return {
    root,
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
