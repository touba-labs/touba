import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTraceMachineContract } from "../../contracts/machine/contracts.mjs";
import { airDocumentDigest } from "../../runtime/touba-runtime/src/air-identity.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const sourcePath = path.join(
  implementationRoot,
  "grammar/tree-sitter-touba/examples/agent-interface-v1/positive/tb-agent-interface-p01-strategy-call.tb",
);
const expectedAirPath = path.join(fixtureRoot, "expected/agent-interface-v1.air.json");
const expectedTracePath = path.join(fixtureRoot, "expected/agent-interface-v1.trace.json");
const providerPath = path.join(fixtureRoot, "providers/direct-review.provider.mjs");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-agent-interface-v1-"));
const airPath = path.join(tmpRoot, "agent-interface-v1.air.json");
const tracePath = path.join(tmpRoot, "agent-interface-v1.trace.json");
const cargo = process.env.CARGO ?? "cargo";

try {
  const air = compilePositiveSource();
  assertAirContract(air, readJson(expectedAirPath));
  validateNegativeSources();

  const run = spawnSync(
    process.execPath,
    [
      path.join(implementationRoot, "cli/touba-run/src/run.mjs"),
      airPath,
      "--inputs-json",
      JSON.stringify({ request: { summary: "Review fixture" } }),
      "--agent-decision-provider",
      providerPath,
      "--agent-decision-provider-metadata-json",
      JSON.stringify({
        provider_kind: "test_provider",
        provider_name: "agent-interface-v1-fixture",
        provider_version: "1.0.0",
        decision_schema_version: "touba-agent-decision-v1",
      }),
      "--trace-out",
      tracePath,
      "--output",
      "result",
    ],
    { cwd: implementationRoot, encoding: "utf8" },
  );
  assertSuccess("run", run);
  assert.deepEqual(JSON.parse(run.stdout), { verdict: "approved" });
  const trace = readJson(tracePath);
  validateTraceMachineContract(trace);
  assert.match(trace.run.run_id, /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const event of trace.events) assert.equal(event.run_id, trace.run.run_id);
  // Event timestamps are required and validated independently of the semantic
  // fixture, which predates wall-clock trace observations.
  const semanticTrace = { ...trace, events: trace.events.map(({ observed_at, ...event }) => {
    assert.equal(typeof observed_at, "string");
    assert.equal(new Date(observed_at).toISOString(), observed_at);
    return event;
  }) };
  if (process.argv.includes("--write-trace-fixture")) {
    writeFileSync(expectedTracePath, JSON.stringify(stripSourceRefs(normalizeRunIdentifiers(semanticTrace, trace.run.run_id)), null, 2) + "\n");
  }
  const expectedTrace = readJson(expectedTracePath);
  // The snapshot describes event semantics. Independently recompute the full
  // commitment from this compilation, including its portable source metadata.
  // Never omit the commitment assertion or normalize semantic decisions.
  expectedTrace.run.air_digest = airDocumentDigest(air);
  assert.deepEqual(stripSourceRefs(normalizeRunIdentifiers(semanticTrace, trace.run.run_id)), expectedTrace);
  assert.equal(JSON.stringify(trace).includes("Review fixture"), false);
  assert.equal(JSON.stringify(trace).includes("approved"), false);

  console.log("agent-interface-v1: status=success source=compiled air=stable trace=stable negatives=4");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function compilePositiveSource() {
  const sourceArgument = path.relative(implementationRoot, sourcePath);
  const result = spawnSync(
    cargo,
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourceArgument],
    { cwd: implementationRoot, encoding: "utf8" },
  );
  assertSuccess("compile positive source", result);
  writeFileSync(airPath, result.stdout, "utf8");
  return JSON.parse(result.stdout);
}

function validateNegativeSources() {
  const negativeRoot = path.join(
    implementationRoot,
    "grammar/tree-sitter-touba/examples/agent-interface-v1/negative/semantic",
  );
  const expectedCodes = new Map([
    ["tb-agent-interface-n01-missing-gives.tb", "MissingAgentInterfaceOutput"],
    ["tb-agent-interface-n02-missing-argument.tb", "MissingExplicitCallArgument"],
    ["tb-agent-interface-n03-unknown-argument.tb", "UnknownCallArgument"],
    ["tb-agent-interface-n04-wrong-type.tb", "IncompatibleExpressionType"],
  ]);

  for (const [name, code] of expectedCodes) {
    const sourceArgument = path.relative(implementationRoot, path.join(negativeRoot, name));
    const result = spawnSync(
      cargo,
      ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourceArgument],
      { cwd: implementationRoot, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, `${name} must be refused`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(code), `${name} must expose ${code}`);
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertAirContract(actual, expected) {
  assert.equal(actual.air_schema_version, expected.air_schema_version);
  assert.deepEqual(stripSourceRefs(actual.module), expected.module);
  assert.deepEqual(stripSourceRefs(actual.definitions), expected.definitions);
  assert.deepEqual(stripSourceRefs(actual.execution_graphs), expected.execution_graphs);
}

function stripSourceRefs(value) {
  if (Array.isArray(value)) return value.map(stripSourceRefs);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "source_ref" && key !== "use_refs" && key !== "trace_point_refs")
      .map(([key, item]) => [key, stripSourceRefs(item)]),
  );
}

function assertSuccess(label, result) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}

function normalizeRunIdentifiers(value, runId) {
  const invocations = new Map();
  const visit = (value, key = "") => {
    if (Array.isArray(value)) return value.map(item => visit(item, key));
    if (value !== null && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    if (typeof value !== "string" || !/(?:_id|_ref)$/.test(key)) return value;
    if (key === "agent_invocation_id") {
      assert.match(value, /^invocation:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      if (!invocations.has(value)) invocations.set(value, `invocation:${invocations.size + 1}`);
      return invocations.get(value);
    }
    return value.replaceAll(runId, "run-1");
  };
  return visit(value);
}
