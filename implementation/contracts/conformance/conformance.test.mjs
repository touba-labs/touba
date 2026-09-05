import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runConformance } from "./runner.mjs";
import principalAdapter from "./principal-runtime-adapter.mjs";
import { baseAir, baseTrace } from "./corpus.mjs";
import { migrateMachineArtifact } from "./migrate.mjs";

test("runs the public corpus in contract-only mode", async () => {
  const report = await runConformance();
  assert.equal(report.status, "success");
  assert.equal(report.summary.total, 11);
});

test("runs accepted AIR through the principal runtime", async () => {
  const report = await runConformance({ runtimeAdapter: principalAdapter });
  assert.equal(report.status, "success");
  assert.equal(report.adapter, "touba-runtime-principal-v1");
});

test("migrates legacy AIR deterministically and idempotently", () => {
  const legacy = baseAir();
  legacy.air_schema_version = "air-minimal-v0.1";
  delete legacy.air_capability_profile;
  delete legacy.air_json_profile;
  const first = migrateMachineArtifact(legacy);
  const second = migrateMachineArtifact(first.artifact);
  assert.deepEqual(second.artifact, first.artifact);
  assert.deepEqual(second.changes, []);
  assert.equal(migrateMachineArtifact(legacy).artifact.air_schema_version, "touba-air-v1");
});

test("migrates legacy traces and signals inferred failure classification", () => {
  const legacy = baseTrace();
  legacy.trace_protocol_version = "trace-minimal-v0.1";
  delete legacy.trace_capability_profile;
  legacy.events.splice(1, 0, {
    event_id: "event:run-conformance:legacy", run_id: "run-conformance", sequence_index: 1,
    kind: "failure_detected", payload: { runtime_error_code: "UnauthorizedAgentInvocation" },
  });
  legacy.events[2].sequence_index = 2;
  const result = migrateMachineArtifact(legacy);
  assert.equal(result.semantic_review_required, true);
  assert.equal(result.artifact.events[1].payload.failure_family, "authority");
});

test("refuses unknown source versions and mandatory legacy extensions", () => {
  const unknown = baseAir(); unknown.air_schema_version = "touba-air-v99";
  assert.throws(() => migrateMachineArtifact(unknown), { code: "MigrationSourceVersionUnsupported" });
  const extended = baseAir(); extended.air_schema_version = "air-minimal-v0.1";
  delete extended.air_capability_profile; delete extended.air_json_profile;
  extended.required_extensions = ["vendor:x"];
  assert.throws(() => migrateMachineArtifact(extended), { code: "MigrationMandatoryExtensionUnsupported" });
});

test("package runs outside the workspace without dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touba-conformance-"));
  try {
    const packageRoot = path.resolve(new URL("..", import.meta.url).pathname);
    const packed = spawnSync("npm", ["pack", "--silent", packageRoot], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: path.join(root, ".npm-cache") },
    });
    assert.equal(packed.status, 0, packed.stderr);
    const archive = packed.stdout.trim().split("\n").at(-1);
    const extract = spawnSync("tar", ["-xzf", archive], { cwd: root, encoding: "utf8" });
    assert.equal(extract.status, 0, extract.stderr);
    const smoke = spawnSync(process.execPath, ["package/conformance/runner.mjs"], { cwd: root, encoding: "utf8" });
    assert.equal(smoke.status, 0, smoke.stderr);
    assert.equal(JSON.parse(smoke.stdout).status, "success");
    assert.match(await readFile(path.join(root, "package/package.json"), "utf8"), /@touba\/machine-conformance/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
