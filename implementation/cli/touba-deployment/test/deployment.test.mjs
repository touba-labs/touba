import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      resource_bindings_schema_version: "touba-resource-bindings-v0.1",
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
      "// Touba Studio generated handler stub v0.1",
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
    });
    assert.equal(firstActive.current_revision_id, first.bundle_sha256);

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
  } finally {
    project.dispose();
    rmSync(storageRoot, { recursive: true, force: true });
  }
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
    assert.equal((await authorized.json()).schema_version, "touba-deployment-status-v0.1");
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
    lock_version: "touba-lock-v0.1",
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
