import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToubaProjectServer } from "../src/serve.mjs";
import { createDeploymentTargetService } from "../../touba-deployment/src/serve.mjs";

test("two real project servers cannot list or activate each other's revisions on a shared target", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-deployment-origin-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = "isolated-deployment-target-test-token-32";
  const target = createDeploymentTargetService({ port: 0, storageRoot: join(root, "target"), token });
  const address = await target.start(); t.after(() => target.stop());
  const servers = [];
  for (const id of ["a", "b"]) {
    const projectRoot = join(root, id); mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src/main.tb"), `module demo\nstrategy Run\n    gives Text\n    do\n        give "${id}"\n`);
    writeFileSync(join(projectRoot, "touba.project.json"), JSON.stringify({ project_version: "touba-project-v1", language: "javascript",
      sdk: "@touba/sdk", artifact_layout: "touba-artifacts-v1", entry: "strategy:demo/Run" }));
    const server = createToubaProjectServer({ projectRoot, port: 0, quiet: true,
      deploymentTargetUrl: `http://127.0.0.1:${address.port}`, deploymentTargetToken: token });
    await server.start(); t.after(() => server.stop()); servers.push(server);
  }
  const call = async (index, path, body) => {
    const response = await fetch(`http://127.0.0.1:${servers[index].server.address().port}/deployments${path}`, {
      method: body ? "POST" : "GET", headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify({ schema_version: "touba-deployment-action-v1", actor: "user:test", ...body }) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const plan = await call(0, "/plan", { action: "plan", profile: "dev" });
  assert.equal(plan.data.status, "ready", JSON.stringify(plan));
  const published = await call(0, "/publish", { action: "publish", profile: "dev", bundle_sha256: plan.data.bundle_sha256 });
  assert.equal(published.status, 202, JSON.stringify(published));
  const beforeB = await call(1, "");
  assert.deepEqual(beforeB.data.revisions, []);
  const cross = await call(1, "/activate", { action: "activate", revision_id: published.data.revision.revision_id, expected_state: beforeB.data.state_digest });
  assert.equal(cross.data.code, "ToubaDeploymentRevisionNotFound");
  const active = await call(0, "/activate", { action: "activate", revision_id: published.data.revision.revision_id, expected_state: published.data.state_digest });
  assert.equal(active.status, 202, JSON.stringify(active));
  assert.equal((await call(1, "")).data.current_revision_id, null);
  assert.equal((await call(0, "")).data.current_revision_id, published.data.revision.revision_id);
});
