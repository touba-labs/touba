import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runConformance } from "./runner.mjs";
import principalAdapter from "./principal-runtime-adapter.mjs";
import { baseAir, baseTrace } from "./corpus.mjs";
import { validateAirMachineContract, validateTraceMachineContract } from "../machine/contracts.mjs";

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

test("refuses obsolete AIR and traces without inferring or rewriting their content", () => {
  const air = baseAir(); air.air_schema_version = "air-minimal-v0.1";
  const trace = baseTrace(); trace.trace_protocol_version = "trace-minimal-v0.1";
  const originals = structuredClone([air, trace]);
  assert.throws(() => validateAirMachineContract(air), { code: "MachineVersionUnsupported" });
  assert.throws(() => validateTraceMachineContract(trace), { code: "MachineVersionUnsupported" });
  assert.deepEqual([air, trace], originals);
});

test("requires a terminal reason instead of inferring one from status", () => {
  const trace = baseTrace(); delete trace.events.at(-1).payload.reason;
  assert.throws(() => validateTraceMachineContract(trace), error => error.path.endsWith(".reason"));
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
