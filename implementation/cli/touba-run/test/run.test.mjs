import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text } from "@touba/supply-chain";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";

import {
  LINEAR_FETCH_SOURCE_TOOL_REF,
  STRATEGY_APPLY_CHANGE_TOOL_REF,
} from "../src/local-handlers.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const runPath = join(__dir, "../src/run.mjs");
const implementationDir = join(__dir, "../../..");
const cargoManifest = join(implementationDir, "Cargo.toml");
const runSummarySchema = join(
  implementationDir,
  "contracts/product-surfaces/schemas/touba-run-summary-v1.schema.json",
);
const linearSkillFixture = join(
  implementationDir,
  "grammar/tree-sitter-touba/examples/tb-v01-001-linear-skill.tb",
);
const strategyAgentsFixture = join(
  implementationDir,
  "grammar/tree-sitter-touba/examples/tb-v01-005-strategy-agents.tb",
);
const toolBindingV1FixtureRoot = join(implementationDir, "tests/tool-binding-v1");
const toolBindingV1SourceFixture = join(
  toolBindingV1FixtureRoot,
  "source/tb-v1-p01-process-fetch-source.tb",
);
const toolBindingV1SecretsFixture = join(
  toolBindingV1FixtureRoot,
  "secrets/touba.secret-handles.fixture.json",
);
const donneesQuebecLiveValidatePath = join(
  toolBindingV1FixtureRoot,
  "live-donnees-quebec/validate.mjs",
);
const CARGO = process.env.CARGO ?? "cargo";

test("runs an AIR document with the bounded local FetchSource handler", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument());
    const stdout = execFileSync(
      process.execPath,
      [runPath, airPath, "--local-fetch-source-text", "local source text", "--output", "trace"],
      { encoding: "utf8" },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.run.entry_ref, "skill:examples.linear_skill/BuildNote");
    assert.equal(eventOf(trace, "call_completed").payload.target_ref, LINEAR_FETCH_SOURCE_TOOL_REF);
    assert.equal(trace.events.at(-1).payload.status, "success");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("emits touba-run-summary-v1 for a successful run", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-summary-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument());
    const tracePath = join(workspace, "run.trace.json");
    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--local-fetch-source-text",
        "local source text",
        "--max-steps",
        "10",
        "--max-tool-calls",
        "3",
        "--trace-out",
        tracePath,
        "--output",
        "run-summary",
      ],
      { encoding: "utf8" },
    );

    const summary = JSON.parse(stdout);
    const schema = JSON.parse(readFileSync(runSummarySchema, "utf8"));
    assert.deepEqual(validateObject(schema, summary), []);
    assert.equal(summary.schema_version, "touba-run-summary-v1");
    assert.equal(summary.status, "succeeded");
    assert.equal(summary.entrypoint_ref, "skill:examples.linear_skill/BuildNote");
    assert.equal(summary.trace_ref, `file:${tracePath}`);
    assert.equal(summary.trigger_ref, null);
    assert.deepEqual(summary.approvals_pending, []);
    assert.deepEqual(summary.refusals, []);
    assert.equal(summary.budgets.tool_calls_used, 1);
    assert.equal(summary.budgets.steps_used >= 1, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("emits approval_pending run summary for a paused approval", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-summary-approval-"));
  try {
    const airPath = writeAirDocument(workspace, humanApprovalDocument());
    const stdout = execFileSync(
      process.execPath,
      [runPath, airPath, "--output", "run-summary"],
      { encoding: "utf8" },
    );

    const summary = JSON.parse(stdout);
    const schema = JSON.parse(readFileSync(runSummarySchema, "utf8"));
    assert.deepEqual(validateObject(schema, summary), []);
    assert.equal(summary.status, "approval_pending");
    assert.equal(summary.completed_at, null);
    assert.deepEqual(summary.approvals_pending, ["approval:examples.cli:required"]);
    assert.deepEqual(summary.refusals, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("surfaces a local handler error through the existing fallback path", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument({ withFallback: true }));
    const stdout = execFileSync(
      process.execPath,
      [runPath, airPath, "--local-fetch-source-text", "", "--output", "trace"],
      { encoding: "utf8" },
    );

    const trace = JSON.parse(stdout);
    assert.match(eventOf(trace, "failure_detected").message, /local source text/);
    assert.equal(eventOf(trace, "fallback_selected").payload.target_node_id, "n3");
    assert.equal(trace.events.at(-1).payload.status, "success");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("compiles the linear corpus fixture and runs it without stubs through the local handler", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-corpus-"));
  try {
    const airPath = compileFixtureToAir(workspace, linearSkillFixture, "linear-skill");

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--inputs-json",
        JSON.stringify({ request: { topic: "corpus" } }),
        "--local-fetch-source-text",
        "corpus local source",
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.run.module_ref, "module:examples.linear_skill");
    assert.equal(trace.run.entry_ref, "strategy:examples.linear_skill/RunSourcedNote");
    assert.equal(eventOf(trace, "call_completed").payload.target_ref, LINEAR_FETCH_SOURCE_TOOL_REF);
    assert.equal(trace.events.at(-1).kind, "run_completed");
    assert.equal(trace.events.at(-1).payload.status, "success");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("compiles the strategy agents fixture and runs it without stubs through ApplyChange", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-corpus-"));
  try {
    const airPath = compileFixtureToAir(workspace, strategyAgentsFixture, "strategy-agents");

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--inputs-json",
        JSON.stringify({ request: { summary: "requested change" } }),
        "--local-apply-change-summary",
        "bounded local change",
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.run.module_ref, "module:examples.strategy_agents");
    assert.equal(trace.run.entry_ref, "strategy:examples.strategy_agents/RunChange");
    assert.equal(
      eventOf(trace, "call_completed").payload.target_ref,
      STRATEGY_APPLY_CHANGE_TOOL_REF,
    );
    assert.equal(trace.events.at(-1).kind, "run_completed");
    assert.equal(trace.events.at(-1).payload.status, "success");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports an explicit diagnostic when a tool binding is missing", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument());
    const failure = runCliExpectFailure([runPath, airPath]);

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /missing tool binding/);
    assert.match(failure.stderr, /tool:examples\.linear_skill\/FetchSource/);
    assert.match(failure.stderr, /--local-fetch-source-text <text>/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports an explicit diagnostic when a local handler fails", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument());
    const failure = runCliExpectFailure([runPath, airPath, "--local-fetch-source-text", ""]);

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /failed tool binding/);
    assert.match(failure.stderr, /handler reported: local source text must be a non-empty string/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports an explicit diagnostic when the ApplyChange handler fails", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-corpus-"));
  try {
    const airPath = compileFixtureToAir(workspace, strategyAgentsFixture, "strategy-agents");
    const failure = runCliExpectFailure([
      runPath,
      airPath,
      "--inputs-json",
      JSON.stringify({ request: { summary: "requested change" } }),
      "--local-apply-change-summary",
      "",
    ]);

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /failed tool binding/);
    assert.match(failure.stderr, /tool:examples\.strategy_agents\/ApplyChange/);
    assert.match(
      failure.stderr,
      /handler reported: local change summary must be a non-empty string/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects incompatible binding configuration flags before execution", () => {
  const failure = runCliExpectFailure([
    runPath,
    "fixture.air.json",
    "--stubs",
    "--local-fetch-source-text",
    "text",
  ]);

  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /--stubs cannot be combined with local handler options/);

  const manifestWithStubs = runCliExpectFailure([
    runPath,
    "fixture.air.json",
    "--manifest",
    "touba.manifest.json",
    "--stubs",
  ]);
  assert.equal(manifestWithStubs.status, 2);
  assert.match(manifestWithStubs.stderr, /--manifest cannot be combined/);

  const secretsWithoutManifest = runCliExpectFailure([
    runPath,
    "fixture.air.json",
    "--secrets",
    "touba.secrets.json",
  ]);
  assert.equal(secretsWithoutManifest.status, 2);
  assert.match(secretsWithoutManifest.stderr, /--secrets requires --manifest/);
});

test("rejects invalid run timeout values before execution", () => {
  const failure = runCliExpectFailure([runPath, "fixture.air.json", "--run-timeout-ms", "0"]);

  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /--run-timeout-ms requires a positive integer/);
});

test("rejects invalid BQ-1 CLI budget values before execution", () => {
  const failure = runCliExpectFailure([runPath, "fixture.air.json", "--max-tool-calls", "0"]);

  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /--max-tool-calls requires a positive integer/);

  const invalidJson = runCliExpectFailure([
    runPath,
    "fixture.air.json",
    "--run-limits-json",
    "[]",
  ]);
  assert.equal(invalidJson.status, 2);
  assert.match(invalidJson.stderr, /--run-limits-json must decode to a JSON object/);
});

test("rejects invalid agent decision provider content modes before execution", () => {
  const failure = runCliExpectFailure([
    runPath,
    "fixture.air.json",
    "--agent-decision-provider-content-mode",
    "raw",
  ]);

  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /--agent-decision-provider-content-mode must be one of: inline, opaque_refs/);
});

test("surfaces BQ-1 budget refusals through CLI diagnostics and traces", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-budget-"));
  try {
    const airPath = writeAirDocument(workspace, twoToolBudgetDocument());
    const result = spawnSync(
      process.execPath,
      [runPath, airPath, "--stubs", "--max-tool-calls", "1", "--output", "trace"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /budget error \[ToolCallBudgetExceeded\]/);
    assert.match(result.stderr, /reason: budget_limit_exceeded/);
    assert.match(result.stderr, /target: tool:examples\.budget_cli\/Second/);
    assert.equal(result.stderr.includes("raw-secret-payload"), false);

    const trace = JSON.parse(result.stdout);
    assert.equal(trace.events.at(-1).payload.status, "failure");
    assert.equal(
      eventOf(trace, "dispatch_refused_budget_exceeded").payload.runtime_error_code,
      "ToolCallBudgetExceeded",
    );
    assert.equal(eventOf(trace, "budget_consumed").payload.consumed_value, 1);
    assert.equal(JSON.stringify(trace).includes("raw-secret-payload"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs the tool binding V1 fixture through explicit manifest and secrets files", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-binding-v1-"));
  try {
    const airPath = compileFixtureToAir(workspace, toolBindingV1SourceFixture, "tool-binding-v1");
    const manifestPath = writeFixtureManifest(workspace, "touba.manifest.positive.json");
    const inputs = JSON.stringify({ request: { query: "cli-source" } });

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--secrets",
        toolBindingV1SecretsFixture,
        "--inputs-json",
        inputs,
        "--output",
        "trace",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SEARCH_API_TOKEN: "fixture-secret-value",
          TOUBA_SHOULD_NOT_LEAK: "host-only",
        },
      },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.run.module_ref, "module:examples.v1_process_binding");
    assert.equal(trace.events.at(-1).payload.status, "success");
    assert.equal(
      eventOf(trace, "call_completed").payload.target_ref,
      "tool:examples.v1_process_binding/FetchSource",
    );
    assert.equal(stdout.includes("fixture-secret-value"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses a binding fragment passed directly as the runtime manifest", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-binding-fragment-"));
  try {
    const airPath = writeAirDocument(workspace, projectToolDocument());
    const manifestPath = join(workspace, "fragment.json");
    writeFileSync(manifestPath, JSON.stringify({
      fragment_schema_version: "touba-binding-fragment-v0.1",
      source: {
        kind: "module",
        module: "project.echo",
      },
      bindings: {},
    }, null, 2), "utf8");

    const result = spawnSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--inputs-json",
        JSON.stringify({ request: "hello" }),
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /BindingFragmentNotAssembled/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses invalid RB-1 resource bindings before runtime dispatch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-resource-bindings-"));
  try {
    const airPath = writeAirDocument(workspace, memoryResourceDocument());
    const unknownPath = join(workspace, "unknown.resources.json");
    writeFileSync(unknownPath, JSON.stringify({
      resource_bindings_schema_version: "touba-resource-bindings-v0.1",
      resources: {
        "memory:project.memory/Unknown": {
          kind: "memory_backend",
          provider: "host.local",
          grants: ["memory.read"],
          secrets: [],
        },
      },
    }, null, 2), "utf8");
    const payloadPath = join(workspace, "payload.resources.json");
    writeFileSync(payloadPath, JSON.stringify({
      resource_bindings_schema_version: "touba-resource-bindings-v0.1",
      resources: {
        "memory:project.memory/Notes": {
          kind: "memory_backend",
          provider: "host.local",
          grants: ["memory.read"],
          secrets: [],
          payload: { should_not: "appear" },
        },
      },
    }, null, 2), "utf8");

    const unknown = spawnSync(process.execPath, [
      runPath,
      airPath,
      "--resource-bindings",
      unknownPath,
    ], { encoding: "utf8" });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /ResourceBindingUnknownResource/);

    const payload = spawnSync(process.execPath, [
      runPath,
      airPath,
      "--resource-bindings",
      payloadPath,
    ], { encoding: "utf8" });
    assert.equal(payload.status, 1);
    assert.match(payload.stderr, /ResourceBindingPayloadForbidden/);
    assert.equal(payload.stderr.includes("should_not"), false);

    const missing = spawnSync(process.execPath, [
      runPath,
      airPath,
      "--require-resource-bindings",
    ], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ResourceBindingMissing/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs an IM-2A imported tool through manifest, secrets, constraints and SC-1", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-im2a-import-tool-"));
  try {
    const fixture = writeImportedToolRuntimeFixture(workspace);

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        fixture.airPath,
        "--manifest",
        fixture.manifestPath,
        "--secrets",
        fixture.secretsPath,
        "--supply-chain-lock",
        fixture.lockPath,
        "--require-supply-chain-lock",
        "--inputs-json",
        JSON.stringify({ request: { query: "transport", rows: 2 } }),
        "--output",
        "trace",
      ],
      {
        cwd: fixture.projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          DATA_API_TOKEN: "im2a-secret-value",
        },
      },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.run.module_ref, "module:examples.research_app");
    assert.equal(trace.events.at(-1).payload.status, "success");
    assert.equal(
      eventOf(trace, "tool_binding_authorized").payload.tool_ref,
      "tool:examples.data_tools/SearchDatasets",
    );
    assert.equal(
      eventOf(trace, "call_completed").payload.target_ref,
      "tool:examples.data_tools/SearchDatasets",
    );
    assert.equal(stdout.includes("im2a-secret-value"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses IM-2A imported tools before handler on constraints, grants, secrets and SC-1 drift", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-im2a-import-tool-refused-"));
  try {
    const fixture = writeImportedToolRuntimeFixture(workspace);

    let failure = runCliExpectFailure([
      runPath,
      fixture.airPath,
      "--manifest",
      fixture.manifestPath,
      "--secrets",
      fixture.secretsPath,
      "--inputs-json",
      JSON.stringify({ request: { query: "transport", rows: 500 } }),
    ], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        DATA_API_TOKEN: "im2a-secret-value",
      },
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /ToolPayloadConstraintViolation/);
    assert.equal(fileExists(fixture.markerPath), false);

    writeFileSync(fixture.manifestPath, importedToolManifestText({ grants: ["network"] }), "utf8");
    failure = runCliExpectFailure([
      runPath,
      fixture.airPath,
      "--manifest",
      fixture.manifestPath,
      "--secrets",
      fixture.secretsPath,
      "--inputs-json",
      JSON.stringify({ request: { query: "transport", rows: 2 } }),
    ], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        DATA_API_TOKEN: "im2a-secret-value",
      },
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /ToolCapabilityMissing|missing capability/);
    assert.equal(fileExists(fixture.markerPath), false);

    writeFileSync(fixture.manifestPath, importedToolManifestText(), "utf8");
    failure = runCliExpectFailure([
      runPath,
      fixture.airPath,
      "--manifest",
      fixture.manifestPath,
      "--secrets",
      fixture.secretsPath,
      "--inputs-json",
      JSON.stringify({ request: { query: "transport", rows: 2 } }),
    ], {
      cwd: fixture.projectRoot,
      env: withoutEnv("DATA_API_TOKEN"),
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /SecretResolutionFailed|secret/i);
    assert.equal(fileExists(fixture.markerPath), false);

    writeFileSync(
      fixture.handlerPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(fixture.markerPath)}, "called");`,
        "process.stdout.write(JSON.stringify({ ok: true, value: { title: 'changed', url: 'https://example.invalid', result_count: 1 } }));",
        "",
      ].join("\n"),
      "utf8",
    );
    failure = runCliExpectFailure([
      runPath,
      fixture.airPath,
      "--manifest",
      fixture.manifestPath,
      "--secrets",
      fixture.secretsPath,
      "--supply-chain-lock",
      fixture.lockPath,
      "--require-supply-chain-lock",
      "--inputs-json",
      JSON.stringify({ request: { query: "transport", rows: 2 } }),
    ], {
      cwd: fixture.projectRoot,
      env: {
        ...process.env,
        DATA_API_TOKEN: "im2a-secret-value",
      },
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /SupplyChainLockInvalid/);
    assert.equal(fileExists(fixture.markerPath), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("resolves explicit dotenv and touba_store secrets relative to the secrets file", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-secret-sources-"));
  try {
    const airPath = compileFixtureToAir(workspace, toolBindingV1SourceFixture, "tool-binding-v1");
    const manifestPath = writeFixtureManifest(workspace, "touba.manifest.positive.json");
    mkdirSync(join(workspace, "profiles/.touba"), { recursive: true });
    writeFileSync(join(workspace, "profiles/.env"), "SEARCH_API_TOKEN=dotenv-secret-value\n", "utf8");
    writeFileSync(join(workspace, "profiles/.touba/secrets.local.json"), JSON.stringify({
      store_version: "touba-secret-store-local-v1",
      secrets: {
        SEARCH_API_KEY: "store-secret-value",
      },
    }), "utf8");

    const dotenvSecretsPath = join(workspace, "profiles/touba.secrets.dotenv.json");
    writeFileSync(dotenvSecretsPath, JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        SEARCH_API_KEY: {
          source: "dotenv",
          path: ".env",
          name: "SEARCH_API_TOKEN",
        },
      },
    }), "utf8");
    const storeSecretsPath = join(workspace, "profiles/touba.secrets.dev.json");
    writeFileSync(storeSecretsPath, JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        SEARCH_API_KEY: {
          source: "touba_store",
          path: ".touba/secrets.local.json",
          name: "SEARCH_API_KEY",
        },
      },
    }), "utf8");

    for (const [secretsPath, secretValue] of [
      [dotenvSecretsPath, "dotenv-secret-value"],
      [storeSecretsPath, "store-secret-value"],
    ]) {
      const stdout = execFileSync(
        process.execPath,
        [
          runPath,
          airPath,
          "--manifest",
          manifestPath,
          "--secrets",
          secretsPath,
          "--inputs-json",
          JSON.stringify({ request: { query: "cli-source" } }),
          "--output",
          "trace",
        ],
        {
          encoding: "utf8",
          env: withoutEnv("SEARCH_API_TOKEN"),
        },
      );

      const trace = JSON.parse(stdout);
      assert.equal(trace.events.at(-1).payload.status, "success");
      assert.equal(stdout.includes(secretValue), false);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("resolves relative handler cwd from manifest location", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-project-manifest-"));
  try {
    const project = join(workspace, "project");
    mkdirSync(join(project, "handlers"), { recursive: true });
    const airPath = writeAirDocument(workspace, projectToolDocument());
    writeFileSync(
      join(project, "handlers/echo.handler.mjs"),
      "let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ ok: true, value: 'relative-ok' })));\n",
      "utf8",
    );
    const manifestPath = join(project, "touba.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:project.echo/Echo": {
          handler: {
            kind: "process",
            command: process.execPath,
            args: ["handlers/echo.handler.mjs"],
            cwd: ".",
          },
          grants: ["local"],
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
        },
      },
    }), "utf8");

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--inputs-json",
        JSON.stringify({ request: "hello" }),
        "--output",
        "result",
      ],
      {
        cwd: workspace,
        encoding: "utf8",
      },
    );

    assert.equal(JSON.parse(stdout), "relative-ok");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("enforces a coherent SC-1 supply chain lock before process handler dispatch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-sc1-lock-"));
  try {
    const fixture = writeProjectToolRuntimeFixture(workspace);

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        fixture.airPath,
        "--manifest",
        fixture.manifestPath,
        "--supply-chain-lock",
        fixture.lockPath,
        "--require-supply-chain-lock",
        "--inputs-json",
        JSON.stringify({ request: "hello" }),
        "--output",
        "result",
      ],
      {
        cwd: workspace,
        encoding: "utf8",
      },
    );

    assert.equal(JSON.parse(stdout), "relative-ok");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("requires an explicit SC-1 lock path when the run gate is required", () => {
  const failure = runCliExpectFailure([
    runPath,
    "fixture.air.json",
    "--require-supply-chain-lock",
  ]);

  assert.equal(failure.status, 2);
  assert.match(failure.stderr, /--require-supply-chain-lock requires --supply-chain-lock/);
});

test("refuses process handler dispatch when the SC-1 lock detects handler drift", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-sc1-drift-"));
  try {
    const markerPath = join(workspace, "handler-called");
    const fixture = writeProjectToolRuntimeFixture(workspace);
    writeFileSync(
      fixture.handlerPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, "called");`,
        "process.stdout.write(JSON.stringify({ ok: true, value: 'changed' }));",
        "",
      ].join("\n"),
      "utf8",
    );

    const failure = runCliExpectFailure([
      runPath,
      fixture.airPath,
      "--manifest",
      fixture.manifestPath,
      "--supply-chain-lock",
      fixture.lockPath,
      "--require-supply-chain-lock",
      "--inputs-json",
      JSON.stringify({ request: "hello" }),
    ]);

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /SupplyChainLockInvalid/);
    assert.match(failure.stderr, /HandlerChanged/);
    assert.equal(failure.stderr.includes("changed'"), false);
    assert.equal(fileExists(markerPath), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("allows a non-required SC-1 warning while preserving explicit strict refusal", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-sc1-warning-"));
  try {
    const fixture = writeProjectToolRuntimeFixture(workspace, { sdk: null });

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        fixture.airPath,
        "--manifest",
        fixture.manifestPath,
        "--supply-chain-lock",
        fixture.lockPath,
        "--inputs-json",
        JSON.stringify({ request: "hello" }),
        "--output",
        "result",
      ],
      {
        cwd: workspace,
        encoding: "utf8",
      },
    );
    assert.equal(JSON.parse(stdout), "relative-ok");

    const strictFailure = runCliExpectFailure([
      runPath,
      fixture.airPath,
      "--manifest",
      fixture.manifestPath,
      "--supply-chain-lock",
      fixture.lockPath,
      "--require-supply-chain-lock",
      "--inputs-json",
      JSON.stringify({ request: "hello" }),
    ]);

    assert.equal(strictFailure.status, 1);
    assert.match(strictFailure.stderr, /SupplyChainLockWarning/);
    assert.match(strictFailure.stderr, /HandlerSdkUnknown/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports explicit manifest, grant and secret diagnostics for tool binding V1", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-binding-v1-"));
  try {
    const airPath = compileFixtureToAir(workspace, toolBindingV1SourceFixture, "tool-binding-v1");
    const missingGrantManifest = writeFixtureManifest(
      workspace,
      "touba.manifest.missing-network-grant.json",
    );
    const missingSecretManifest = writeFixtureManifest(
      workspace,
      "touba.manifest.missing-secret-grant.json",
    );
    const positiveManifest = writeFixtureManifest(workspace, "touba.manifest.positive.json");
    const inputs = JSON.stringify({ request: { query: "cli-source" } });

    const missingManifest = runCliExpectFailure([
      runPath,
      airPath,
      "--inputs-json",
      inputs,
    ]);
    assert.equal(missingManifest.status, 1);
    assert.match(missingManifest.stderr, /missing tool binding manifest/);
    assert.match(missingManifest.stderr, /provide --manifest <path>/);

    const missingGrant = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      missingGrantManifest,
      "--secrets",
      toolBindingV1SecretsFixture,
      "--inputs-json",
      inputs,
    ]);
    assert.equal(missingGrant.status, 1);
    assert.match(missingGrant.stderr, /ToolCapabilityNotGranted/);
    assert.match(missingGrant.stderr, /missing capabilities: network/);

    const missingSecretBinding = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      missingSecretManifest,
      "--secrets",
      toolBindingV1SecretsFixture,
      "--inputs-json",
      inputs,
    ]);
    assert.equal(missingSecretBinding.status, 1);
    assert.match(missingSecretBinding.stderr, /SecretRequiredButNotBound/);
    assert.match(missingSecretBinding.stderr, /missing secret handles: SEARCH_API_KEY/);

    const missingEnv = runCliExpectFailure(
      [
        runPath,
        airPath,
        "--manifest",
        positiveManifest,
        "--secrets",
        toolBindingV1SecretsFixture,
        "--inputs-json",
        inputs,
      ],
      { env: withoutEnv("SEARCH_API_TOKEN") },
    );
    assert.equal(missingEnv.status, 1);
    assert.match(missingEnv.stderr, /SecretNotResolved/);
    assert.match(missingEnv.stderr, /missing secret handles: SEARCH_API_KEY/);
    assert.equal(missingEnv.stderr.includes("fixture-secret-value"), false);

    const revokedSecretsPath = join(workspace, "touba.secrets.revoked.json");
    writeFileSync(revokedSecretsPath, JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        SEARCH_API_KEY: {
          source: "env",
          name: "SEARCH_API_TOKEN",
          status: "revoked",
        },
      },
    }), "utf8");
    const revokedSecret = runCliExpectFailure(
      [
        runPath,
        airPath,
        "--manifest",
        positiveManifest,
        "--secrets",
        revokedSecretsPath,
        "--inputs-json",
        inputs,
      ],
      {
        env: {
          ...process.env,
          SEARCH_API_TOKEN: "fixture-secret-value",
        },
      },
    );
    assert.equal(revokedSecret.status, 1);
    assert.match(revokedSecret.stderr, /SecretHandleRevoked/);
    assert.match(revokedSecret.stderr, /refused secret handles: SEARCH_API_KEY/);
    assert.equal(revokedSecret.stderr.includes("fixture-secret-value"), false);

    const secretInPayload = runCliExpectFailure(
      [
        runPath,
        airPath,
        "--manifest",
        positiveManifest,
        "--secrets",
        toolBindingV1SecretsFixture,
        "--inputs-json",
        JSON.stringify({ request: { query: "fixture-secret-value" } }),
      ],
      {
        env: {
          ...process.env,
          SEARCH_API_TOKEN: "fixture-secret-value",
        },
      },
    );
    assert.equal(secretInPayload.status, 1);
    assert.match(secretInPayload.stderr, /SecretValueInToolArguments/);
    assert.match(secretInPayload.stderr, /refused secret handles: SEARCH_API_KEY/);
    assert.equal(secretInPayload.stderr.includes("fixture-secret-value"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports tool payload schema diagnostics before process handler dispatch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-binding-schema-"));
  try {
    const airPath = compileFixtureToAir(workspace, toolBindingV1SourceFixture, "tool-binding-v1");
    const manifestPath = writeFixtureManifest(workspace, "touba.manifest.positive.json");
    const failure = runCliExpectFailure(
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--secrets",
        toolBindingV1SecretsFixture,
        "--inputs-json",
        JSON.stringify({ request: { query: 123 } }),
      ],
      {
        env: {
          ...process.env,
          SEARCH_API_TOKEN: "fixture-secret-value",
        },
      },
    );

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /ToolInputSchemaInvalid/);
    assert.match(failure.stderr, /arguments\.request\.query/);
    assert.equal(failure.stderr.includes("fixture-secret-value"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports tool payload constraint diagnostics before process handler dispatch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-binding-constraints-"));
  try {
    const airPath = compileFixtureToAir(workspace, toolBindingV1SourceFixture, "tool-binding-v1");
    const markerPath = join(workspace, "handler-called.txt");
    const handlerPath = join(workspace, "constraint-marker.handler.mjs");
    writeFileSync(handlerPath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.argv[2], 'called', 'utf8');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      "    ok: true,",
      "    value: {",
      "      body: 'ok',",
      "      inherited_env_visible: false,",
      "      secret_value_in_stdin: false",
      "    }",
      "  }));",
      "});",
      "",
    ].join("\n"), "utf8");
    const manifestPath = join(workspace, "touba.manifest.constraints.json");
    writeFileSync(manifestPath, JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:examples.v1_process_binding/FetchSource": {
          handler: {
            kind: "process",
            command: process.execPath,
            args: [handlerPath, markerPath],
            cwd: workspace,
          },
          grants: ["network", "secret_read"],
          secrets: ["SEARCH_API_KEY"],
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
          payload_constraints: {
            input: {
              "request.query": {
                non_empty: true,
                max_length: 8,
              },
            },
          },
        },
      },
    }), "utf8");

    const failure = runCliExpectFailure(
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--secrets",
        toolBindingV1SecretsFixture,
        "--inputs-json",
        JSON.stringify({ request: { query: "fixture-secret-value should not dispatch" } }),
      ],
      {
        env: {
          ...process.env,
          SEARCH_API_TOKEN: "fixture-secret-value",
        },
      },
    );

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /ToolPayloadConstraintViolation/);
    assert.match(failure.stderr, /request\.query/);
    assert.equal(failure.stderr.includes("fixture-secret-value"), false);
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports list payload constraint diagnostics before process handler dispatch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-list-constraints-"));
  try {
    const airPath = writeAirDocument(workspace, listConstraintToolDocument());
    const markerPath = join(workspace, "handler-called.marker");
    const handlerPath = join(workspace, "send_batch.handler.mjs");
    writeFileSync(handlerPath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.argv[2], 'called', 'utf8');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ ok: true, value: ['sent'] }));",
      "});",
      "",
    ].join("\n"), "utf8");
    const manifestPath = join(workspace, "touba.manifest.list-constraints.json");
    writeFileSync(manifestPath, JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:project.batch/SendBatch": {
          handler: {
            kind: "process",
            command: process.execPath,
            args: [handlerPath, markerPath],
            cwd: workspace,
          },
          grants: [],
          secrets: [],
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
          payload_constraints: {
            input: {
              "request.recipients": {
                min_items: 1,
                max_items: 2,
              },
            },
          },
        },
      },
    }), "utf8");

    const failure = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      manifestPath,
      "--inputs-json",
      JSON.stringify({
        request: {
          recipients: ["alpha@example.test", "beta@example.test", "gamma@example.test"],
        },
      }),
    ]);

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /ToolPayloadConstraintViolation/);
    assert.match(failure.stderr, /request\.recipients/);
    assert.match(failure.stderr, /max_items/);
    assert.equal(failure.stderr.includes("alpha@example.test"), false);
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("validates the Donnees Quebec process handler fixture in dry-run mode", () => {
  const stdout = execFileSync(process.execPath, [donneesQuebecLiveValidatePath, "--dry-run"], {
    cwd: implementationDir,
    encoding: "utf8",
  });

  assert.match(stdout, /tool-binding:donnees-quebec mode=dry_run status=success/);
});

test(
  "validates the Donnees Quebec process handler fixture against the public API when enabled",
  {
    skip:
      process.env.TOUBA_LIVE_DONNEES_QUEBEC === "1"
        ? false
        : "set TOUBA_LIVE_DONNEES_QUEBEC=1",
  },
  () => {
    const stdout = execFileSync(process.execPath, [donneesQuebecLiveValidatePath, "--live"], {
      cwd: implementationDir,
      encoding: "utf8",
    });

    assert.match(stdout, /tool-binding:donnees-quebec mode=live status=success/);
  },
);

test("runs human approval with explicit paused and approved decisions", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-human-"));
  try {
    const airPath = writeAirDocument(workspace, humanApprovalDocument());

    const pausedStdout = execFileSync(
      process.execPath,
      [runPath, airPath, "--output", "trace"],
      { encoding: "utf8" },
    );
    const pausedTrace = JSON.parse(pausedStdout);
    assert.equal(pausedTrace.events.at(-1).payload.status, "stopped");
    assert.equal(eventOf(pausedTrace, "human_approval_requested").payload.mode, "required_approval");
    assert.equal(
      eventOf(pausedTrace, "human_approval_paused").payload.approval_ref,
      "approval:examples.cli:required",
    );

    const decisionsPath = join(workspace, "human-decisions.json");
    writeFileSync(
      decisionsPath,
      JSON.stringify({ "approval:examples.cli:required": "approved" }),
      "utf8",
    );
    const approvedStdout = execFileSync(
      process.execPath,
      [runPath, airPath, "--human-decisions", decisionsPath, "--output", "trace"],
      { encoding: "utf8" },
    );
    const approvedTrace = JSON.parse(approvedStdout);
    assert.equal(approvedTrace.events.at(-1).payload.status, "success");
    assert.equal(eventOf(approvedTrace, "human_approval_decided").payload.decision, "approved");
    assert.equal(
      eventOf(approvedTrace, "human_approval_resumed").payload.decision_binding,
      "approval",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("writes and resumes a human approval checkpoint without replaying prior tool dispatch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-human-checkpoint-"));
  try {
    const airPath = writeAirDocument(workspace, toolThenHumanApprovalDocument());
    const checkpointPath = join(workspace, "human.checkpoint.json");

    const pausedStdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--local-fetch-source-text",
        "fetched before pause",
        "--human-checkpoint-out",
        checkpointPath,
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );
    const pausedTrace = JSON.parse(pausedStdout);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));

    assert.equal(pausedTrace.events.at(-1).payload.status, "stopped");
    assert.equal(checkpoint.checkpoint_schema_version, "touba-run-checkpoint-v0.1");
    assert.equal(checkpoint.approval_ref, "approval:examples.cli:after-fetch");
    assert.equal(checkpoint.values["value:fetched"].content, "fetched before pause");
    assert.equal(eventOf(pausedTrace, "human_approval_checkpoint_created").payload.external_tool_dispatches, 1);

    const approvedStdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--local-fetch-source-text",
        "would indicate replay",
        "--human-resume-checkpoint",
        checkpointPath,
        "--human-decisions-json",
        JSON.stringify({ "approval:examples.cli:after-fetch": "approved" }),
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );
    const approvedTrace = JSON.parse(approvedStdout);

    assert.equal(approvedTrace.events.at(-1).payload.status, "success");
    assert.equal(approvedTrace.events.filter((event) => event.kind === "tool_binding_authorized").length, 0);
    assert.equal(
      eventOf(approvedTrace, "human_approval_checkpoint_loaded").payload.approval_ref,
      "approval:examples.cli:after-fetch",
    );
    assert.equal(eventOf(approvedTrace, "human_approval_decided").payload.decision, "approved");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("writes and resumes an agent human review checkpoint without replaying prior tool dispatch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-agent-human-checkpoint-"));
  try {
    const airPath = writeAirDocument(workspace, agentToolThenHumanReviewDocument());
    const providerPath = join(workspace, "provider.mjs");
    const checkpointPath = join(workspace, "agent-human.checkpoint.json");
    const tracePath = join(workspace, "resume-trace.json");

    writeFileSync(
      providerPath,
      [
        "export function decideAgentCapability(request) {",
        "  if (request.step_index === 0 && request.mode === 'summary') {",
        "    return { action: 'request_capabilities', reason: 'need source text' };",
        "  }",
        "  if (request.step_index === 0 && request.mode === 'capabilities') {",
        "    return { target_ref: 'skill:examples.cli_agent_human_checkpoint/FetchData', reason: 'fetch once', arguments: {} };",
        "  }",
        "  if (request.step_index === 1 && request.mode === 'summary') {",
        "    return { action: 'request_capabilities', reason: 'review fetched text' };",
        "  }",
        "  return { action: 'request_human_review', source: 'cli_fixture', reason: 'human review after fetch' };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const pausedStdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--local-fetch-source-text",
        "fetched before pause",
        "--agent-decision-provider",
        providerPath,
        "--human-checkpoint-out",
        checkpointPath,
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );
    const pausedTrace = JSON.parse(pausedStdout);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));

    assert.equal(pausedTrace.events.at(-1).payload.status, "stopped");
    assert.equal(checkpoint.kind, "agent_human_review");
    assert.equal(checkpoint.approval_ref, "approval:agent:examples.cli_agent_human_checkpoint/Researcher:step-1:human-review");
    assert.equal(checkpoint.agent_loop_state.observations[0].value.content, "fetched before pause");
    assert.equal(eventOf(pausedTrace, "human_approval_checkpoint_created").payload.external_tool_dispatches, 1);

    writeFileSync(
      providerPath,
      [
        "export function decideAgentCapability(request) {",
        "  if (request.step_index !== 2 || request.mode !== 'summary') {",
        "    throw new Error(`unexpected resume request ${request.mode}:${request.step_index}`);",
        "  }",
        "  const fetched = request.observations[0].value.content;",
        "  const review = request.observations[1].value.decision;",
        "  return {",
        "    action: 'answer_directly',",
        "    source: 'cli_resume_fixture',",
        "    reason: 'checkpoint review approved',",
        "    result: `${fetched} / ${review}`",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const resumedStdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--local-fetch-source-text",
        "would indicate replay",
        "--agent-decision-provider",
        providerPath,
        "--human-resume-checkpoint",
        checkpointPath,
        "--human-decisions-json",
        JSON.stringify({ "approval:agent:examples.cli_agent_human_checkpoint/Researcher:step-1:human-review": "approved" }),
        "--trace-out",
        tracePath,
        "--output",
        "result",
      ],
      { encoding: "utf8" },
    );
    const resumedTrace = JSON.parse(readFileSync(tracePath, "utf8"));

    assert.equal(JSON.parse(resumedStdout), "fetched before pause / approved");
    assert.equal(resumedTrace.events.at(-1).payload.status, "success");
    assert.equal(resumedTrace.events.filter((event) => event.kind === "tool_binding_authorized").length, 0);
    assert.equal(JSON.stringify(resumedTrace).includes("would indicate replay"), false);
    assert.equal(eventOf(resumedTrace, "human_approval_checkpoint_loaded").payload.kind, "agent_human_review");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports invalid human approval decisions without inventing approval state", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-human-"));
  try {
    const airPath = writeAirDocument(workspace, humanApprovalDocument());
    const failure = runCliExpectFailure([
      runPath,
      airPath,
      "--human-decisions-json",
      JSON.stringify({ "approval:examples.cli:required": "maybe" }),
    ]);

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /InvalidHumanApprovalDecision/);
    assert.match(failure.stderr, /human approval: approval:examples\.cli:required/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs user interaction show and ask with explicit user inputs", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-user-"));
  try {
    const airPath = writeAirDocument(workspace, userInteractionDocument());

    const pausedStdout = execFileSync(
      process.execPath,
      [runPath, airPath, "--output", "trace"],
      { encoding: "utf8" },
    );
    const pausedTrace = JSON.parse(pausedStdout);
    assert.equal(pausedTrace.events.at(-1).payload.status, "stopped");
    assert.equal(eventOf(pausedTrace, "user_interaction_shown").payload.message, "Touba ready");
    assert.equal(
      eventOf(pausedTrace, "user_interaction_paused").payload.interaction_ref,
      "interaction:examples.cli:user-query",
    );

    const userInputsPath = join(workspace, "user-inputs.json");
    writeFileSync(
      userInputsPath,
      JSON.stringify({ "interaction:examples.cli:user-query": "donnees" }),
      "utf8",
    );
    const answeredStdout = execFileSync(
      process.execPath,
      [runPath, airPath, "--user-inputs", userInputsPath, "--output", "trace"],
      { encoding: "utf8" },
    );
    const answeredTrace = JSON.parse(answeredStdout);
    assert.equal(answeredTrace.events.at(-1).payload.status, "success");
    assert.equal(
      eventOf(answeredTrace, "user_interaction_answered").payload.result_binding,
      "query",
    );
    assert.equal(JSON.stringify(answeredTrace).includes("donnees"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs user interaction ask through explicit interactive CLI host mode", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-user-interactive-"));
  try {
    const airPath = writeAirDocument(workspace, userInteractionDocument());
    const result = spawnSync(
      process.execPath,
      [runPath, airPath, "--interactive-user-inputs", "--output", "trace"],
      {
        encoding: "utf8",
        input: "donnees\n",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Search query\?/);
    const trace = JSON.parse(result.stdout);
    assert.equal(trace.events.at(-1).payload.status, "success");
    assert.equal(eventOf(trace, "user_interaction_answered").payload.result_binding, "query");
    assert.equal(JSON.stringify(trace).includes("donnees"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cancels before first dispatch through an explicit CLI cancel request", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-cancel-before-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument());
    const stdout = execFileSync(
      process.execPath,
      [runPath, airPath, "--cancel-before-dispatch", "--output", "trace"],
      { encoding: "utf8" },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.events.at(-1).payload.status, "cancelled");
    assert.equal(eventOf(trace, "run_cancel_requested").payload.authority_source, "cli");
    assert.match(eventOf(trace, "dispatch_refused_cancelled").payload.target_ref, /^skill:/);
    assert.equal(trace.events.some((event) => event.kind === "call_started"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cancels paused human approval and ask interactions through CLI host control", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-cancel-pause-"));
  try {
    const humanAirPath = writeAirDocument(workspace, humanApprovalDocument());
    const humanStdout = execFileSync(
      process.execPath,
      [runPath, humanAirPath, "--cancel-on-pause", "--output", "trace"],
      { encoding: "utf8" },
    );
    const humanTrace = JSON.parse(humanStdout);
    assert.equal(humanTrace.events.at(-1).payload.status, "cancelled");
    assert.equal(
      eventOf(humanTrace, "human_approval_paused").payload.approval_ref,
      "approval:examples.cli:required",
    );
    assert.equal(eventOf(humanTrace, "run_cancel_requested").payload.reason, "cancel_requested");

    const userAirPath = writeAirDocument(workspace, userInteractionDocument());
    const userStdout = execFileSync(
      process.execPath,
      [runPath, userAirPath, "--cancel-on-pause", "--output", "trace"],
      { encoding: "utf8" },
    );
    const userTrace = JSON.parse(userStdout);
    assert.equal(userTrace.events.at(-1).payload.status, "cancelled");
    assert.equal(
      eventOf(userTrace, "user_interaction_paused").payload.interaction_ref,
      "interaction:examples.cli:user-query",
    );
    assert.equal(userTrace.events.some((event) => event.kind === "user_interaction_answered"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects ambiguous user interaction input sources", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-user-inputs-conflict-"));
  try {
    const airPath = writeAirDocument(workspace, userInteractionDocument());
    const result = spawnSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--interactive-user-inputs",
        "--user-inputs-json",
        JSON.stringify({ "interaction:examples.cli:user-query": "donnees" }),
      ],
      {
        encoding: "utf8",
        input: "ignored\n",
      },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--interactive-user-inputs cannot be combined/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("prints show messages by default and keeps trace available through --trace-out", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-output-"));
  try {
    const airPath = writeAirDocument(workspace, userInteractionDocument());
    const tracePath = join(workspace, "trace.json");

    const stdout = execFileSync(
      process.execPath,
      [runPath, airPath, "--trace-out", tracePath],
      { encoding: "utf8" },
    );

    assert.equal(stdout, "Touba ready\n");
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(trace.events.at(-1).payload.status, "stopped");
    assert.equal(eventOf(trace, "user_interaction_shown").payload.message, "Touba ready");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("writes optional run evidence manifest separately from trace output", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-evidence-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument());
    const tracePath = join(workspace, "trace.json");
    const evidencePath = join(workspace, "run.evidence.json");
    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--local-fetch-source-text",
        "local source text",
        "--output",
        "result",
        "--trace-out",
        tracePath,
        "--evidence-out",
        evidencePath,
        "--evidence-ref",
        "db=postgres://example.local/runs/123",
      ],
      { encoding: "utf8" },
    );

    assert.equal(JSON.parse(stdout), "done");
    assert.equal(existsSync(tracePath), true);
    const evidenceText = readFileSync(evidencePath, "utf8");
    const evidence = JSON.parse(evidenceText);
    assert.equal(evidence.evidence_schema_version, "touba-run-evidence-v0.1");
    assert.equal(evidence.run.status, "success");
    assert.equal(evidence.run.entry_ref, "skill:examples.linear_skill/BuildNote");
    assert.equal(evidence.trace.output.path, tracePath);
    assert.match(evidence.trace.digest.value, /^[0-9a-f]{64}$/u);
    assert.equal(evidence.result.available, true);
    assert.equal(evidence.result.json_type, "string");
    assert.match(evidence.result.digest.value, /^[0-9a-f]{64}$/u);
    assert.equal(evidence.checkpoint.available, false);
    assert.deepEqual(evidence.external_evidence_refs, [
      { label: "db", uri: "postgres://example.local/runs/123" },
    ]);
    assert.equal(evidenceText.includes("local source text"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses external evidence refs without an evidence output manifest", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-evidence-refused-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument());
    const failure = runCliExpectFailure([
      runPath,
      airPath,
      "--local-fetch-source-text",
      "local source text",
      "--evidence-ref",
      "db=postgres://example.local/runs/123",
    ]);
    assert.equal(failure.status, 2);
    assert.match(failure.stderr, /--evidence-ref requires --evidence-out/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("prints returned value with --output result", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-output-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument());
    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--local-fetch-source-text",
        "local source text",
        "--output",
        "result",
      ],
      { encoding: "utf8" },
    );

    assert.equal(JSON.parse(stdout), "done");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs an agent decision provider module through the CLI", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-agent-provider-"));
  try {
    const airPath = writeAirDocument(workspace, agentDecisionProviderDocument());
    const providerPath = join(workspace, "provider.mjs");
    const tracePath = join(workspace, "trace.json");
    writeFileSync(
      providerPath,
      [
        "export function decideAgentCapability(request) {",
        "  if (request.mode === 'summary') {",
        "    if (request.observations?.length > 0) {",
        "      return {",
        "        action: 'answer_directly',",
        "        reason: 'answer from observed capability result',",
        "        result: request.observations[0].value",
        "      };",
        "    }",
        "    return { action: 'request_capabilities', reason: 'inspect available contracts' };",
        "  }",
        "  return {",
        "    target_ref: 'skill:examples.linear_skill/Answer',",
        "    reason: 'answer skill selected by provider',",
        "    arguments: { topic: request.inputs.topic }",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--inputs-json",
        JSON.stringify({ topic: "postgres" }),
        "--agent-decision-provider",
        providerPath,
        "--max-agent-steps",
        "4",
        "--trace-out",
        tracePath,
        "--output",
        "result",
      ],
      { encoding: "utf8" },
    );

    assert.equal(JSON.parse(stdout), "postgres");
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(eventOf(trace, "agent_decision_catalog_requested").payload.reason, "inspect available contracts");
    assert.equal(eventOf(trace, "agent_capability_selected").payload.selected_ref, "skill:examples.linear_skill/Answer");
    assert.equal(JSON.stringify(trace).includes("postgres"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("passes agent decision provider initial mode through the CLI", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-agent-provider-mode-"));
  try {
    const airPath = writeAirDocument(workspace, agentDecisionProviderDocument());
    const providerPath = join(workspace, "provider.mjs");
    const tracePath = join(workspace, "trace.json");
    writeFileSync(
      providerPath,
      [
        "export function decideAgentCapability(request) {",
        "  if (request.mode === 'summary' && request.observations?.length > 0) {",
        "    return {",
        "      action: 'answer_directly',",
        "      reason: 'answer from observed capability result',",
        "      result: request.observations[0].value",
        "    };",
        "  }",
        "  if (request.mode !== 'capabilities') {",
        "    throw new Error(`expected capabilities mode, got ${request.mode}`);",
        "  }",
        "  return {",
        "    target_ref: 'skill:examples.linear_skill/Answer',",
        "    reason: 'answer skill selected from direct catalog',",
        "    arguments: { topic: request.inputs.topic }",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--inputs-json",
        JSON.stringify({ topic: "postgres" }),
        "--agent-decision-provider",
        providerPath,
        "--agent-decision-provider-initial-mode",
        "capabilities",
        "--max-provider-calls",
        "2",
        "--trace-out",
        tracePath,
        "--output",
        "result",
      ],
      { encoding: "utf8" },
    );

    assert.equal(JSON.parse(stdout), "postgres");
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(eventOf(trace, "agent_decision_requested").payload.mode, "capabilities");
    assert.equal(trace.events.some((event) => event.kind === "agent_decision_catalog_requested"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("passes ADP-1 provider metadata and budget flags through the CLI", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-adp1-provider-"));
  try {
    const airPath = writeAirDocument(workspace, agentDecisionProviderDocument());
    const providerPath = join(workspace, "provider.mjs");
    const tracePath = join(workspace, "trace.json");
    writeFileSync(
      providerPath,
      [
        "export const provider_metadata = {",
        "  provider_kind: 'test_provider',",
        "  provider_name: 'module-metadata',",
        "  provider_version: '0.1.0'",
        "};",
        "export function decideAgentCapability() {",
        "  return {",
        "    action: 'answer_directly',",
        "    source: 'cli_adp1_fixture',",
        "    reason: 'direct bounded answer',",
        "    result: 'ok'",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--inputs-json",
        JSON.stringify({ topic: "private-cli-topic" }),
        "--agent-decision-provider",
        providerPath,
        "--agent-decision-provider-metadata-json",
        JSON.stringify({
          provider_kind: "test_provider",
          provider_name: "cli-metadata",
          model_id: "fixture-model",
          prompt_template_id: "adp1-cli-template",
          decision_schema_version: "touba-agent-decision-v1",
        }),
        "--agent-decision-provider-timeout-ms",
        "1000",
        "--agent-decision-provider-max-retries",
        "0",
        "--max-provider-calls",
        "1",
        "--trace-out",
        tracePath,
        "--output",
        "result",
      ],
      { encoding: "utf8" },
    );

    assert.equal(JSON.parse(stdout), "ok");
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    const requested = eventOf(trace, "agent_decision_requested").payload;
    assert.match(requested.request_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(requested.provider_metadata, {
      provider_kind: "test_provider",
      provider_name: "cli-metadata",
      model_id: "fixture-model",
      prompt_template_id: "adp1-cli-template",
      decision_schema_version: "touba-agent-decision-v1",
    });
    assert.equal(JSON.stringify(trace).includes("private-cli-topic"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("passes opaque_refs provider content mode through the CLI without raw payload", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-opaque-provider-"));
  try {
    const airPath = writeAirDocument(workspace, agentDecisionProviderDocument());
    const providerPath = join(workspace, "provider.mjs");
    const capturedPath = join(workspace, "provider-request.json");
    const tracePath = join(workspace, "trace.json");
    const privatePayload = "private-cli-provider-payload";
    writeFileSync(
      providerPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `const capturedPath = ${JSON.stringify(capturedPath)};`,
        "export function decideAgentCapability(request) {",
        "  writeFileSync(capturedPath, JSON.stringify(request, null, 2));",
        "  return {",
        "    action: 'answer_directly',",
        "    reason: 'opaque refs accepted',",
        "    result: 'ok'",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--inputs-json",
        JSON.stringify({ topic: privatePayload }),
        "--agent-decision-provider",
        providerPath,
        "--agent-decision-provider-content-mode",
        "opaque_refs",
        "--trace-out",
        tracePath,
        "--output",
        "result",
      ],
      { encoding: "utf8" },
    );

    assert.equal(JSON.parse(stdout), "ok");
    const requestText = readFileSync(capturedPath, "utf8");
    assert.doesNotMatch(requestText, new RegExp(privatePayload));
    const request = JSON.parse(requestText);
    assert.equal(request.content_mode, "opaque_refs");
    assert.equal(request.external_content_access.raw_content_in_provider_request, false);
    assert.equal(request.inputs.topic.value, undefined);
    assert.match(request.inputs.topic.ref, /^opaque:runtime_input\/topic$/);
    assert.equal(request.model_input.content_boundary.provider_content_mode, "opaque_refs");
    assert.equal(request.model_input.content_boundary.raw_external_content_in_request, false);

    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    const requested = eventOf(trace, "agent_decision_requested").payload;
    assert.equal(requested.content_mode, "opaque_refs");
    assert.equal(requested.external_content_access.raw_content_in_provider_request, false);
    assert.equal(JSON.stringify(trace).includes(privatePayload), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports ADP-1 provider budget refusals through CLI diagnostics", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-adp1-budget-"));
  try {
    const airPath = writeAirDocument(workspace, agentDecisionProviderDocument());
    const providerPath = join(workspace, "provider.mjs");
    const tracePath = join(workspace, "trace.json");
    writeFileSync(
      providerPath,
      [
        "export function decideAgentCapability() {",
        "  return { action: 'request_capabilities', reason: 'need catalog' };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const failure = runCliExpectFailure([
      runPath,
      airPath,
      "--inputs-json",
      JSON.stringify({ topic: "must-not-leak" }),
      "--agent-decision-provider",
      providerPath,
      "--max-provider-calls",
      "1",
      "--trace-out",
      tracePath,
      "--output",
      "result",
    ]);

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /AgentDecisionProviderBudgetExceeded/);
    assert.match(failure.stderr, /max_provider_calls/);
    assert.doesNotMatch(failure.stderr, /must-not-leak/);
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    assert.equal(eventOf(trace, "failure_detected").payload.runtime_error_code, "AgentDecisionProviderBudgetExceeded");
    assert.equal(JSON.stringify(trace).includes("must-not-leak"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs an explicit AIR entry with --entry", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-entry-"));
  try {
    const airPath = writeAirDocument(workspace, linearSourceDocument({ withFallback: true }));
    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--entry",
        "skill:examples.linear_skill/FallbackNote",
        "--output",
        "result",
      ],
      { encoding: "utf8" },
    );

    assert.equal(JSON.parse(stdout), "fallback");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs a pure AIR document through an explicit RP-1 run plan", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-plan-pure-"));
  try {
    const airPath = join(workspace, "program.air.json");
    writeFileSync(airPath, JSON.stringify(runPlanPureDocument()), "utf8");
    const runPlanPath = join(workspace, "touba.run-plan.json");
    writeFileSync(runPlanPath, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:examples.run_plan/Run",
      air: "program.air.json",
      profile: "dev",
      outputs: {
        mode: "result",
      },
    }), "utf8");

    const stdout = execFileSync(
      process.execPath,
      [runPath, "--run-plan", runPlanPath],
      { encoding: "utf8" },
    );

    assert.equal(JSON.parse(stdout), "planned");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("RP-1 run plan can request a run summary output", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-plan-summary-"));
  try {
    const airPath = join(workspace, "program.air.json");
    writeFileSync(airPath, JSON.stringify(runPlanPureDocument()), "utf8");
    const runPlanPath = join(workspace, "touba.run-plan.json");
    writeFileSync(runPlanPath, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:examples.run_plan/Run",
      air: "program.air.json",
      profile: "dev",
      outputs: {
        mode: "run-summary",
      },
    }), "utf8");

    const stdout = execFileSync(
      process.execPath,
      [runPath, "--run-plan", runPlanPath],
      { encoding: "utf8" },
    );

    const summary = JSON.parse(stdout);
    const schema = JSON.parse(readFileSync(runSummarySchema, "utf8"));
    assert.deepEqual(validateObject(schema, summary), []);
    assert.equal(summary.status, "succeeded");
    assert.equal(summary.entrypoint_ref, "strategy:examples.run_plan/Run");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("RP-1 run plan routes trace and optional evidence outputs", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-plan-evidence-"));
  try {
    const airPath = join(workspace, "program.air.json");
    writeFileSync(airPath, JSON.stringify(runPlanPureDocument()), "utf8");
    const tracePath = join(workspace, "planned.trace.json");
    const evidencePath = join(workspace, "planned.evidence.json");
    const runPlanPath = join(workspace, "touba.run-plan.json");
    writeFileSync(runPlanPath, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:examples.run_plan/Run",
      air: "program.air.json",
      profile: "dev",
      outputs: {
        mode: "result",
        trace_out: "planned.trace.json",
        evidence_out: "planned.evidence.json",
        evidence_refs: [
          { label: "storage", uri: "file://evidence/state.json" },
        ],
      },
    }), "utf8");

    const stdout = execFileSync(
      process.execPath,
      [runPath, "--run-plan", runPlanPath],
      { encoding: "utf8" },
    );

    assert.equal(JSON.parse(stdout), "planned");
    assert.equal(existsSync(tracePath), true);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.evidence_schema_version, "touba-run-evidence-v0.1");
    assert.equal(evidence.trace.output.path, tracePath);
    assert.deepEqual(evidence.external_evidence_refs, [
      { label: "storage", uri: "file://evidence/state.json" },
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs a process tool through an explicit RP-1 run plan", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-plan-tool-"));
  try {
    const fixture = writeProjectToolRuntimeFixture(workspace);
    const runPlanPath = join(fixture.projectRoot, "touba.run-plan.json");
    writeFileSync(runPlanPath, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "skill:project.echo/Main",
      air: "../fixture.air.json",
      manifest: "touba.manifest.json",
      profile: "dev",
      outputs: {
        mode: "result",
      },
    }), "utf8");

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        "--run-plan",
        runPlanPath,
        "--inputs-json",
        JSON.stringify({ request: "hello" }),
      ],
      {
        cwd: fixture.projectRoot,
        encoding: "utf8",
      },
    );

    assert.equal(JSON.parse(stdout), "relative-ok");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("RP-1 run plan refuses missing AIR, unknown entries and sensitive payload fields", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-plan-refused-"));
  try {
    const missingAirPlan = join(workspace, "missing-air.run-plan.json");
    writeFileSync(missingAirPlan, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:examples.run_plan/Run",
      air: "missing.air.json",
      profile: "dev",
    }), "utf8");
    let failure = runCliExpectFailure([runPath, "--run-plan", missingAirPlan]);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /RunPlanAirMissing/);

    const airPath = join(workspace, "program.air.json");
    writeFileSync(airPath, JSON.stringify(runPlanPureDocument()), "utf8");
    const unknownEntryPlan = join(workspace, "unknown-entry.run-plan.json");
    writeFileSync(unknownEntryPlan, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:examples.run_plan/Missing",
      air: "program.air.json",
      profile: "dev",
    }), "utf8");
    failure = runCliExpectFailure([runPath, "--run-plan", unknownEntryPlan]);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /RunPlanEntryUnknown/);

    const sensitivePlan = join(workspace, "sensitive.run-plan.json");
    writeFileSync(sensitivePlan, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:examples.run_plan/Run",
      air: "program.air.json",
      profile: "dev",
      inputs: {
        request: "forbidden",
      },
    }), "utf8");
    failure = runCliExpectFailure([runPath, "--run-plan", sensitivePlan]);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /RunPlanSensitivePayloadForbidden/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("RP-1 run plan refuses missing manifest, secrets profile and required prod lock", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-plan-authority-"));
  try {
    writeAirDocument(workspace, importedToolDocument());
    const missingManifestPlan = join(workspace, "missing-manifest.run-plan.json");
    writeFileSync(missingManifestPlan, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:examples.research_app/RunDatasetSearch",
      air: "fixture.air.json",
      profile: "dev",
    }), "utf8");
    let failure = runCliExpectFailure([runPath, "--run-plan", missingManifestPlan]);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /RunPlanManifestMissing/);

    const manifestPath = join(workspace, "touba.manifest.json");
    writeFileSync(manifestPath, importedToolManifestText(), "utf8");
    const missingSecretsPlan = join(workspace, "missing-secrets.run-plan.json");
    writeFileSync(missingSecretsPlan, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:examples.research_app/RunDatasetSearch",
      air: "fixture.air.json",
      manifest: "touba.manifest.json",
      profile: "dev",
    }), "utf8");
    failure = runCliExpectFailure([runPath, "--run-plan", missingSecretsPlan]);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /RunPlanSecretsProfileMissing/);

    const pureAirPath = join(workspace, "pure.air.json");
    writeFileSync(pureAirPath, JSON.stringify(runPlanPureDocument()), "utf8");
    const missingLockPlan = join(workspace, "missing-lock.run-plan.json");
    writeFileSync(missingLockPlan, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:examples.run_plan/Run",
      air: "pure.air.json",
      profile: "prod",
    }), "utf8");
    failure = runCliExpectFailure([runPath, "--run-plan", missingLockPlan]);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /RunPlanSupplyChainLockRequired/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("RP-1 run plan surfaces supply-chain lock drift before handler dispatch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-plan-lock-drift-"));
  try {
    const fixture = writeProjectToolRuntimeFixture(workspace);
    const runPlanPath = join(fixture.projectRoot, "touba.run-plan.json");
    writeFileSync(runPlanPath, JSON.stringify({
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "skill:project.echo/Main",
      air: "../fixture.air.json",
      manifest: "touba.manifest.json",
      profile: "prod",
      supply_chain_lock: "touba.lock.json",
      outputs: {
        mode: "result",
      },
    }), "utf8");
    writeFileSync(
      fixture.handlerPath,
      "process.stdout.write(JSON.stringify({ ok: true, value: 'changed' }));\n",
      "utf8",
    );

    const failure = runCliExpectFailure([
      runPath,
      "--run-plan",
      runPlanPath,
      "--inputs-json",
      JSON.stringify({ request: "hello" }),
    ], {
      cwd: fixture.projectRoot,
    });

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /RunPlanSupplyChainDrift/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs a trigger event through explicit manifest and event JSON", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-trigger-"));
  try {
    const airPath = writeAirDocument(workspace, triggerDocument());
    const manifestPath = writeTriggerManifest(workspace);

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--trigger-event-json",
        JSON.stringify(triggerEvent()),
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.run.entry_ref, "trigger:examples.cli_trigger/DailyRun");
    assert.equal(eventOf(trace, "trigger_event_accepted").payload.target_ref, "strategy:examples.cli_trigger/RunDaily");
    assert.equal(eventOf(trace, "trigger_execution_completed").payload.status, "success");
    assert.equal(JSON.stringify(trace).includes("raw-secret-payload"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("persists trigger state and refuses replayed trigger events", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-trigger-state-"));
  try {
    const airPath = writeAirDocument(workspace, triggerDocument());
    const manifestPath = writeTriggerManifest(workspace);
    const statePath = join(workspace, "touba.trigger-state.json");

    const first = spawnSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--trigger-event-json",
        JSON.stringify(triggerEvent()),
        "--state",
        statePath,
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );
    assert.equal(first.status, 0, first.stderr);
    const firstTrace = JSON.parse(first.stdout);
    assert.equal(eventOf(firstTrace, "trigger_event_received").payload.event_id, "evt-cli-001");
    assert.equal(eventOf(firstTrace, "trigger_event_accepted").payload.trigger_ref, "trigger:examples.cli_trigger/DailyRun");

    const replay = spawnSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--trigger-event-json",
        JSON.stringify(triggerEvent()),
        "--state",
        statePath,
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /TriggerReplayRejected/);
    const replayTrace = JSON.parse(replay.stdout);
    assert.equal(eventOf(replayTrace, "trigger_event_refused").payload.reason, "event_replay");
    assert.equal(eventOf(replayTrace, "trigger_event_refused").payload.runtime_error_code, "TriggerReplayRejected");

    const rateLimited = spawnSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--trigger-event-json",
        JSON.stringify(triggerEvent({ event_id: "evt-cli-002" })),
        "--state",
        statePath,
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );
    assert.equal(rateLimited.status, 1);
    assert.match(rateLimited.stderr, /TriggerRateLimited/);
    const rateLimitedTrace = JSON.parse(rateLimited.stdout);
    assert.equal(eventOf(rateLimitedTrace, "trigger_event_refused").payload.reason, "max_runs_per_day_reached");

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const triggerState = state.triggers["trigger:examples.cli_trigger/DailyRun"];
    assert.equal(state.trigger_state_schema_version, "touba-trigger-state-v0.1");
    assert.equal(triggerState.accepted_count, 1);
    assert.equal(triggerState.refused_count, 2);
    assert.deepEqual(triggerState.consumed_event_ids, ["evt-cli-001"]);
    assert.equal(JSON.stringify(state).includes("raw-secret-payload"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("applies trigger max_runs_per_day to the current UTC day", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-trigger-state-day-"));
  try {
    const airPath = writeAirDocument(workspace, triggerDocument());
    const manifestPath = writeTriggerManifest(workspace);
    const statePath = join(workspace, "touba.trigger-state.json");
    writeFileSync(statePath, JSON.stringify({
      trigger_state_schema_version: "touba-trigger-state-v0.1",
      created_at: "2026-01-01T00:00:00.000Z",
      triggers: {
        "trigger:examples.cli_trigger/DailyRun": {
          events: [
            {
              event_id: "evt-previous-day",
              source_kind: "schedule",
              status: "accepted",
              observed_at: "2026-01-01T00:00:00.000Z",
              day_key: "2026-01-01",
              run_id: "previous-run",
            },
          ],
        },
      },
    }), "utf8");

    const currentDay = spawnSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--trigger-event-json",
        JSON.stringify(triggerEvent({ event_id: "evt-current-day-001" })),
        "--state",
        statePath,
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );
    assert.equal(currentDay.status, 0, currentDay.stderr);
    const currentTrace = JSON.parse(currentDay.stdout);
    assert.equal(eventOf(currentTrace, "trigger_event_accepted").payload.trigger_ref, "trigger:examples.cli_trigger/DailyRun");

    const secondCurrentDay = spawnSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--trigger-event-json",
        JSON.stringify(triggerEvent({ event_id: "evt-current-day-002" })),
        "--state",
        statePath,
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );
    assert.equal(secondCurrentDay.status, 1);
    assert.match(secondCurrentDay.stderr, /TriggerRateLimited/);
    const secondTrace = JSON.parse(secondCurrentDay.stdout);
    assert.equal(eventOf(secondTrace, "trigger_event_refused").payload.reason, "max_runs_per_day_reached");

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const events = state.triggers["trigger:examples.cli_trigger/DailyRun"].events;
    assert.equal(events.some((event) => event.event_id === "evt-current-day-001" && event.status === "accepted"), true);
    assert.equal(events.some((event) => event.event_id === "evt-current-day-002" && event.reason === "max_runs_per_day_reached"), true);
    assert.equal(events.every((event) => event.day_key === undefined || /^\d{4}-\d{2}-\d{2}$/u.test(event.day_key)), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses invalid trigger state artifacts before trigger execution", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-trigger-state-invalid-"));
  try {
    const airPath = writeAirDocument(workspace, triggerDocument());
    const manifestPath = writeTriggerManifest(workspace);
    const statePath = join(workspace, "touba.trigger-state.json");
    writeFileSync(statePath, JSON.stringify({
      trigger_state_schema_version: "other",
      triggers: {},
    }), "utf8");

    const failure = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      manifestPath,
      "--trigger-event-json",
      JSON.stringify(triggerEvent()),
      "--state",
      statePath,
    ]);

    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /TriggerStateSchemaMismatch/);

    const invalidPathFailure = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      manifestPath,
      "--trigger-event-json",
      JSON.stringify(triggerEvent({ event_id: "evt-cli-invalid-path" })),
      "--state",
      join(workspace, "touba.state.json"),
    ]);

    assert.equal(invalidPathFailure.status, 1);
    assert.match(invalidPathFailure.stderr, /TriggerStatePathInvalid/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses trigger execution when the local CLI kill switch is enabled", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-kill-switch-"));
  try {
    const airPath = writeAirDocument(workspace, triggerDocument());
    const manifestPath = writeTriggerManifest(workspace);

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--trigger-event-json",
        JSON.stringify(triggerEvent()),
        "--kill-switch-enabled",
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.events.at(-1).payload.status, "cancelled");
    assert.equal(eventOf(trace, "kill_switch_enabled").payload.scope, "runtime");
    assert.equal(eventOf(trace, "trigger_event_refused").payload.reason, "kill_switch_enabled");
    assert.equal(trace.events.some((event) => event.kind === "trigger_execution_started"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cancels after a global run timeout before the next tool dispatch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-global-timeout-"));
  try {
    const markerPath = join(workspace, "second-tool-called");
    const firstHandlerPath = join(workspace, "first.handler.mjs");
    const secondHandlerPath = join(workspace, "second.handler.mjs");
    writeFileSync(
      firstHandlerPath,
      "setTimeout(() => process.stdout.write(JSON.stringify({ ok: true, value: 'first' })), 120);\n",
      "utf8",
    );
    writeFileSync(
      secondHandlerPath,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "called"); process.stdout.write(JSON.stringify({ ok: true, value: "second" }));\n`,
      "utf8",
    );
    const airPath = writeAirDocument(workspace, timeoutToolDocument());
    const manifestPath = writeTimeoutToolManifest(workspace, firstHandlerPath, secondHandlerPath);

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--run-timeout-ms",
        "50",
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.events.at(-1).payload.status, "cancelled");
    assert.equal(eventOf(trace, "run_timeout_exceeded").payload.reason, "global_timeout_exceeded");
    assert.equal(
      eventOf(trace, "dispatch_refused_cancelled").payload.target_ref,
      "tool:examples.cli_timeout/Second",
    );
    assert.equal(fileExists(markerPath), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runs a local schedule trigger runner with a real bounded interval", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-trigger-runner-"));
  try {
    const airPath = writeAirDocument(workspace, triggerDocument({ scheduleValue: "every 1s" }));
    const manifestPath = writeTriggerManifest(workspace);
    const statePath = join(workspace, "touba.trigger-state.json");

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--trigger",
        "trigger:examples.cli_trigger/DailyRun",
        "--max-runs",
        "1",
        "--state",
        statePath,
        "--output",
        "trace",
      ],
      { encoding: "utf8" },
    );

    const trace = JSON.parse(stdout);
    assert.equal(trace.run.entry_ref, "trigger:examples.cli_trigger/DailyRun");
    assert.match(eventOf(trace, "trigger_event_received").payload.event_id, /^evt-local-DailyRun-/);
    assert.equal(eventOf(trace, "trigger_event_accepted").payload.target_ref, "strategy:examples.cli_trigger/RunDaily");
    assert.equal(eventOf(trace, "trigger_execution_completed").payload.status, "success");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.trigger_state_schema_version, "touba-trigger-state-v0.1");
    assert.equal(state.triggers["trigger:examples.cli_trigger/DailyRun"].accepted_count, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects local schedule trigger runner ambiguity and unsupported schedule formats", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-trigger-runner-refused-"));
  try {
    const airPath = writeAirDocument(workspace, triggerDocument());
    const manifestPath = writeTriggerManifest(workspace);
    const statePath = join(workspace, "touba.trigger-state.json");

    const missingMaxRuns = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      manifestPath,
      "--trigger",
      "trigger:examples.cli_trigger/DailyRun",
    ]);
    assert.equal(missingMaxRuns.status, 2);
    assert.match(missingMaxRuns.stderr, /--trigger requires --max-runs/);

    const missingState = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      manifestPath,
      "--trigger",
      "trigger:examples.cli_trigger/DailyRun",
      "--max-runs",
      "1",
    ]);
    assert.equal(missingState.status, 2);
    assert.match(missingState.stderr, /--trigger requires --state/);

    const triggerAndEvent = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      manifestPath,
      "--trigger",
      "trigger:examples.cli_trigger/DailyRun",
      "--max-runs",
      "1",
      "--state",
      statePath,
      "--trigger-event-json",
      JSON.stringify(triggerEvent()),
    ]);
    assert.equal(triggerAndEvent.status, 2);
    assert.match(triggerAndEvent.stderr, /--trigger cannot be combined/);

    const unsupportedSchedule = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      manifestPath,
      "--trigger",
      "trigger:examples.cli_trigger/DailyRun",
      "--max-runs",
      "1",
      "--state",
      statePath,
    ]);
    assert.equal(unsupportedSchedule.status, 1);
    assert.match(unsupportedSchedule.stderr, /TriggerScheduleUnsupported/);
    assert.match(unsupportedSchedule.stderr, /supported local trigger runner schedule/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("dry-runs trigger checks without executing the target strategy", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-trigger-dry-"));
  try {
    const airPath = writeAirDocument(workspace, triggerDocument());
    const manifestPath = writeTriggerManifest(workspace);
    const eventPath = join(workspace, "trigger-event.json");
    writeFileSync(eventPath, JSON.stringify(triggerEvent()), "utf8");

    const stdout = execFileSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        manifestPath,
        "--trigger-event",
        eventPath,
        "--trigger-dry-run",
      ],
      { encoding: "utf8" },
    );

    const report = JSON.parse(stdout);
    assert.equal(report.mode, "trigger_dry_run");
    assert.equal(report.status, "accepted");
    assert.equal(report.trigger_ref, "trigger:examples.cli_trigger/DailyRun");
    assert.equal(report.target_ref, "strategy:examples.cli_trigger/RunDaily");
    assert.deepEqual(report.limits, {
      max_runs_per_day: 1,
      timeout_ms: 30000,
    });
    assert.equal(report.checks.some((check) => check.check === "target_arguments"), true);
    assert.equal(stdout.includes("raw-secret-payload"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports trigger refusals and dry-run manifest limit widening without payload leaks", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-run-trigger-refused-"));
  try {
    const airPath = writeAirDocument(workspace, triggerDocument());
    const manifestPath = writeTriggerManifest(workspace);
    const sourceMismatch = runCliExpectFailure([
      runPath,
      airPath,
      "--manifest",
      manifestPath,
      "--trigger-event-json",
      JSON.stringify(triggerEvent({ source_kind: "request" })),
      "--output",
      "trace",
    ]);

    assert.equal(sourceMismatch.status, 1);
    assert.match(sourceMismatch.stderr, /trigger error \[TriggerSourceMismatch\]/);
    assert.match(sourceMismatch.stderr, /reason: event_source_mismatch/);
    assert.equal(sourceMismatch.stderr.includes("raw-secret-payload"), false);

    const widenedManifestPath = writeTriggerManifest(workspace, {
      fileName: "touba.manifest.trigger.widened.json",
      limits: {
        max_runs_per_day: 2,
        timeout_ms: 30000,
      },
    });
    const dryRunRefused = spawnSync(
      process.execPath,
      [
        runPath,
        airPath,
        "--manifest",
        widenedManifestPath,
        "--trigger-event-json",
        JSON.stringify(triggerEvent()),
        "--trigger-dry-run",
      ],
      { encoding: "utf8" },
    );

    assert.equal(dryRunRefused.status, 1);
    assert.equal(dryRunRefused.stderr, "");
    const report = JSON.parse(dryRunRefused.stdout);
    assert.equal(report.status, "refused");
    assert.equal(report.runtime_error_code, "TriggerLimitExceeded");
    assert.equal(report.reason, "manifest_limit_exceeds_air");
    assert.equal(dryRunRefused.stdout.includes("raw-secret-payload"), false);

    const missingManifest = runCliExpectFailure([
      runPath,
      airPath,
      "--trigger-event-json",
      JSON.stringify(triggerEvent()),
    ]);
    assert.equal(missingManifest.status, 2);
    assert.match(missingManifest.stderr, /--trigger-event requires --manifest/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function writeAirDocument(workspace, document) {
  const path = join(workspace, "fixture.air.json");
  writeFileSync(path, JSON.stringify(document), "utf8");
  return path;
}

function projectToolDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:project.echo",
      name: "project.echo",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:project.echo/Echo",
          name: "Echo",
          signature: {
            inputs: [{ name: "request", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          required_capabilities: ["local"],
          required_secrets: [],
          source_ref: sourceRef(),
        },
      ],
      skills: [
        {
          id: "skill:project.echo/Main",
          name: "Main",
          signature: {
            inputs: [{ name: "request", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          uses: ["tool:project.echo/Echo"],
          flow_graph_ref: "graph:skill:project.echo/Main",
          source_ref: sourceRef(),
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      graph(
        "graph:skill:project.echo/Main",
        "skill:project.echo/Main",
        [
          node("n1", "call_tool", {
            target_ref: "tool:project.echo/Echo",
            arguments: ["value:request"],
            result_binding: "result",
          }),
          node("n2", "give", { arguments: ["value:result"] }),
        ],
        [edge("n1", "n2", "next")],
      ),
    ],
    trace_points: [],
  };
}

function listConstraintToolDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:project.batch",
      name: "project.batch",
    },
    definitions: {
      constants: [],
      types: [
        {
          id: "type:project.batch/BatchRequest",
          name: "BatchRequest",
          fields: [
            { name: "recipients", type_ref: "list:builtin:Text" },
          ],
          source_ref: sourceRef(),
        },
      ],
      memories: [],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:project.batch/SendBatch",
          name: "SendBatch",
          signature: {
            inputs: [{ name: "request", type_ref: "type:project.batch/BatchRequest" }],
            output_type: "list:builtin:Text",
          },
          required_capabilities: [],
          required_secrets: [],
          source_ref: sourceRef(),
        },
      ],
      skills: [
        {
          id: "skill:project.batch/Main",
          name: "Main",
          signature: {
            inputs: [{ name: "request", type_ref: "type:project.batch/BatchRequest" }],
            output_type: "list:builtin:Text",
          },
          uses: ["tool:project.batch/SendBatch"],
          flow_graph_ref: "graph:skill:project.batch/Main",
          source_ref: sourceRef(),
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      graph(
        "graph:skill:project.batch/Main",
        "skill:project.batch/Main",
        [
          node("n1", "call_tool", {
            target_ref: "tool:project.batch/SendBatch",
            arguments: ["value:request"],
            result_binding: "result",
          }),
          node("n2", "give", { arguments: ["value:result"] }),
        ],
        [edge("n1", "n2", "next")],
      ),
    ],
    trace_points: [],
  };
}

function memoryResourceDocument({ withScope = true } = {}) {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:project.memory",
      name: "project.memory",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [
        {
          id: "memory:project.memory/Notes",
          name: "Notes",
        },
      ],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:project.memory/ReadNotes",
          name: "ReadNotes",
          signature: {
            inputs: [{ name: "query", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          required_capabilities: ["memory_read"],
          memory_accesses: [
            {
              memory_ref: "memory:project.memory/Notes",
              access: "read",
            },
          ],
        },
      ],
      skills: [
        {
          id: "skill:project.memory/SearchNotes",
          name: "SearchNotes",
          signature: {
            inputs: [{ name: "query", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          uses: ["tool:project.memory/ReadNotes"],
          memory_scopes: withScope
            ? [
              {
                memory_ref: "memory:project.memory/Notes",
                access: "read",
              },
            ]
            : [],
          flow_graph_ref: "graph:skill:project.memory/SearchNotes",
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      graph(
        "graph:skill:project.memory/SearchNotes",
        "skill:project.memory/SearchNotes",
        [
          node("n1", "call_tool", {
            target_ref: "tool:project.memory/ReadNotes",
            arguments: ["value:query"],
            result_binding: "result",
          }),
          node("n2", "give", { arguments: ["value:result"] }),
        ],
        [edge("n1", "n2", "next")],
      ),
    ],
    trace_points: [],
  };
}

function runPlanPureDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:examples.run_plan",
      name: "examples.run_plan",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [],
      skills: [],
      agents: [],
      strategies: [
        {
          id: "strategy:examples.run_plan/Run",
          name: "Run",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          flow_graph_ref: "graph:strategy:examples.run_plan/Run",
          source_ref: sourceRef(),
        },
      ],
    },
    execution_graphs: [
      graph("graph:strategy:examples.run_plan/Run", "strategy:examples.run_plan/Run", [
        node("give:1", "give", { arguments: ["literal:string:planned"] }),
      ]),
    ],
    trace_points: [],
  };
}

function importedToolDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:examples.research_app",
      name: "examples.research_app",
    },
    imports: [
      {
        kind: "type",
        name: "DatasetSearchRequest",
        from_module: "examples.data_tools",
        target_ref: "type:examples.data_tools/DatasetSearchRequest",
        source_ref: sourceRef(),
      },
      {
        kind: "type",
        name: "DatasetSearchResult",
        from_module: "examples.data_tools",
        target_ref: "type:examples.data_tools/DatasetSearchResult",
        source_ref: sourceRef(),
      },
      {
        kind: "tool",
        name: "SearchDatasets",
        from_module: "examples.data_tools",
        target_ref: "tool:examples.data_tools/SearchDatasets",
        source_ref: sourceRef(),
      },
    ],
    definitions: {
      constants: [],
      types: [
        {
          id: "type:examples.data_tools/DatasetSearchRequest",
          name: "DatasetSearchRequest",
          fields: [
            { name: "query", type_ref: "builtin:Text", source_ref: sourceRef() },
            { name: "rows", type_ref: "builtin:Int", source_ref: sourceRef() },
          ],
          source_ref: sourceRef(),
        },
        {
          id: "type:examples.data_tools/DatasetSearchResult",
          name: "DatasetSearchResult",
          fields: [
            { name: "title", type_ref: "builtin:Text", source_ref: sourceRef() },
            { name: "url", type_ref: "builtin:Text", source_ref: sourceRef() },
            { name: "result_count", type_ref: "builtin:Int", source_ref: sourceRef() },
          ],
          source_ref: sourceRef(),
        },
      ],
      memories: [],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:examples.data_tools/SearchDatasets",
          name: "SearchDatasets",
          signature: {
            inputs: [
              {
                name: "request",
                type_ref: "type:examples.data_tools/DatasetSearchRequest",
                source_ref: sourceRef(),
              },
            ],
            output_type: "type:examples.data_tools/DatasetSearchResult",
          },
          required_capabilities: ["network", "secret_read"],
          required_secrets: ["DATA_API_TOKEN"],
          source_ref: sourceRef(),
        },
      ],
      skills: [
        {
          id: "skill:examples.research_app/BuildDatasetBrief",
          name: "BuildDatasetBrief",
          signature: {
            inputs: [
              {
                name: "request",
                type_ref: "type:examples.data_tools/DatasetSearchRequest",
                source_ref: sourceRef(),
              },
            ],
            output_type: "type:examples.data_tools/DatasetSearchResult",
          },
          uses: ["tool:examples.data_tools/SearchDatasets"],
          flow_graph_ref: "graph:skill:examples.research_app/BuildDatasetBrief",
          source_ref: sourceRef(),
        },
      ],
      agents: [],
      strategies: [
        {
          id: "strategy:examples.research_app/RunDatasetSearch",
          name: "RunDatasetSearch",
          signature: {
            inputs: [
              {
                name: "request",
                type_ref: "type:examples.data_tools/DatasetSearchRequest",
                source_ref: sourceRef(),
              },
            ],
            output_type: "type:examples.data_tools/DatasetSearchResult",
          },
          flow_graph_ref: "graph:strategy:examples.research_app/RunDatasetSearch",
          source_ref: sourceRef(),
        },
      ],
    },
    execution_graphs: [
      graph(
        "graph:skill:examples.research_app/BuildDatasetBrief",
        "skill:examples.research_app/BuildDatasetBrief",
        [
          node("skill-call-tool", "call_tool", {
            target_ref: "tool:examples.data_tools/SearchDatasets",
            arguments: ["value:request"],
            result_binding: "result",
          }),
          node("skill-give", "give", { arguments: ["value:result"] }),
        ],
        [edge("skill-call-tool", "skill-give", "next")],
      ),
      graph(
        "graph:strategy:examples.research_app/RunDatasetSearch",
        "strategy:examples.research_app/RunDatasetSearch",
        [
          node("strategy-call-skill", "call_skill", {
            target_ref: "skill:examples.research_app/BuildDatasetBrief",
            arguments: ["value:request"],
            result_binding: "result",
          }),
          node("strategy-give", "give", { arguments: ["value:result"] }),
        ],
        [edge("strategy-call-skill", "strategy-give", "next")],
      ),
    ],
    trace_points: [],
  };
}

function twoToolBudgetDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:examples.budget_cli",
      name: "examples.budget_cli",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:examples.budget_cli/First",
          name: "First",
          signature: {
            inputs: [],
            output_type: "type:examples.budget_cli/StubValue",
          },
          required_capabilities: [],
          required_secrets: [],
          source_ref: sourceRef(),
        },
        {
          id: "tool:examples.budget_cli/Second",
          name: "Second",
          signature: {
            inputs: [],
            output_type: "type:examples.budget_cli/StubValue",
          },
          required_capabilities: [],
          required_secrets: [],
          source_ref: sourceRef(),
        },
      ],
      skills: [
        {
          id: "skill:examples.budget_cli/TwoTools",
          name: "TwoTools",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          uses: ["tool:examples.budget_cli/First", "tool:examples.budget_cli/Second"],
          flow_graph_ref: "graph:skill:examples.budget_cli/TwoTools",
          source_ref: sourceRef(),
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      graph(
        "graph:skill:examples.budget_cli/TwoTools",
        "skill:examples.budget_cli/TwoTools",
        [
          node("n1", "call_tool", {
            target_ref: "tool:examples.budget_cli/First",
            result_binding: "first",
          }),
          node("n2", "call_tool", {
            target_ref: "tool:examples.budget_cli/Second",
            result_binding: "second",
          }),
          node("n3", "give", { arguments: ["literal:string:done"] }),
        ],
        [edge("n1", "n2", "next"), edge("n2", "n3", "next")],
      ),
    ],
    trace_points: [],
  };
}

function agentDecisionProviderDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:examples.linear_skill",
      name: "examples.linear_skill",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [],
      skills: [
        {
          id: "skill:examples.linear_skill/Search",
          name: "Search",
          description: "Collect the first research observation required before composing the answer.",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          uses: [],
          flow_graph_ref: "graph:skill:examples.linear_skill/Search",
          source_ref: sourceRef(),
        },
        {
          id: "skill:examples.linear_skill/Answer",
          name: "Answer",
          description: "Compose the final answer from the selected topic and prior observations.",
          signature: {
            inputs: [{ name: "topic", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          uses: [],
          flow_graph_ref: "graph:skill:examples.linear_skill/Answer",
          source_ref: sourceRef(),
        },
      ],
      agents: [
        {
          id: "agent:examples.linear_skill/Researcher",
          name: "Researcher",
          responsibility: "Researcher",
          uses: ["skill:examples.linear_skill/Search", "skill:examples.linear_skill/Answer"],
          callable_by: [
            {
              caller_ref: "strategy:examples.linear_skill/RunResearch",
              caller_kind: "strategy",
              source_ref: sourceRef(),
            },
          ],
          source_ref: sourceRef(),
        },
      ],
      strategies: [
        {
          id: "strategy:examples.linear_skill/RunResearch",
          name: "RunResearch",
          uses: ["agent:examples.linear_skill/Researcher"],
          flow_graph_ref: "graph:strategy:examples.linear_skill/RunResearch",
          source_ref: sourceRef(),
        },
      ],
    },
    execution_graphs: [
      graph("graph:skill:examples.linear_skill/Search", "skill:examples.linear_skill/Search", [
        node("search", "give", { arguments: ["literal:string:search"] }),
      ]),
      graph("graph:skill:examples.linear_skill/Answer", "skill:examples.linear_skill/Answer", [
        node("answer", "give", { arguments: ["value:topic"] }),
      ]),
      graph("graph:strategy:examples.linear_skill/RunResearch", "strategy:examples.linear_skill/RunResearch", [
        node("run", "call_agent", { target_ref: "agent:examples.linear_skill/Researcher" }),
      ]),
    ],
    trace_points: [],
  };
}

function compileFixtureToAir(workspace, fixturePath, name) {
  const airJson = execFileSync(
    CARGO,
    [
      "run",
      "--manifest-path",
      cargoManifest,
      "-p",
      "touba-cli",
      "--bin",
      "touba-compile",
      "--quiet",
      "--",
      fixturePath,
    ],
    { encoding: "utf8" },
  );
  const airPath = join(workspace, `${name}.air.json`);
  writeFileSync(airPath, airJson, "utf8");
  return airPath;
}

function writeFixtureManifest(workspace, fileName) {
  const raw = readFileSync(join(toolBindingV1FixtureRoot, "manifests", fileName), "utf8")
    .replaceAll("\"__NODE_EXECUTABLE_SET_BY_TEST__\"", JSON.stringify(process.execPath))
    .replaceAll("\"__FIXTURE_ROOT_SET_BY_TEST__\"", JSON.stringify(toolBindingV1FixtureRoot));
  const manifestPath = join(workspace, fileName);
  writeFileSync(manifestPath, raw, "utf8");
  return manifestPath;
}

function writeProjectToolRuntimeFixture(workspace, { sdk = {
  name: "@touba/sdk",
  version: "0.1.0",
  protocol: "touba-tool-handler-v1",
  status: "ok",
} } = {}) {
  const project = join(workspace, "project");
  mkdirSync(join(project, "handlers"), { recursive: true });

  const airPath = writeAirDocument(workspace, projectToolDocument());
  const handlerPath = join(project, "handlers/echo.handler.mjs");
  const handlerText = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ ok: true, value: 'relative-ok' })));",
    "",
  ].join("\n");
  writeFileSync(handlerPath, handlerText, "utf8");

  const manifestPath = join(project, "touba.manifest.json");
  const manifestText = `${JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:project.echo/Echo": {
        handler: {
          kind: "process",
          command: process.execPath,
          args: ["handlers/echo.handler.mjs"],
          cwd: ".",
        },
        grants: ["local"],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  }, null, 2)}\n`;
  writeFileSync(manifestPath, manifestText, "utf8");

  const airText = readFileSync(airPath, "utf8");
  const lockPath = join(project, "touba.lock.json");
  const handlerLock = {
    tool_ref: "tool:project.echo/Echo",
    path: "handlers/echo.handler.mjs",
    command: process.execPath,
    cwd: ".",
    args: ["handlers/echo.handler.mjs"],
    digest: {
      kind: "sha256",
      value: sha256Text(handlerText),
    },
    handler_package: {
      kind: "local",
      name: "project.echo.handlers",
      version: "0.1.0",
      entrypoint: "handlers/echo.handler.mjs",
    },
  };
  if (sdk !== undefined) {
    handlerLock.sdk = sdk;
  }
  writeFileSync(lockPath, `${JSON.stringify({
    lock_schema_version: "touba-lock-v0.1",
    lock_kind: "supply_chain",
    generated_at: "2026-06-05T12:00:00Z",
    generated_by: {
      tool: "touba test",
      version: "0.1.0",
    },
    air: {
      path: "../fixture.air.json",
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
    handlers: [handlerLock],
  }, null, 2)}\n`, "utf8");

  return {
    airPath,
    manifestPath,
    lockPath,
    handlerPath,
    projectRoot: project,
  };
}

function writeImportedToolRuntimeFixture(workspace) {
  const projectRoot = join(workspace, "project");
  mkdirSync(join(projectRoot, "handlers/examples/data_tools"), { recursive: true });

  const airPath = writeAirDocument(workspace, importedToolDocument());
  const markerPath = join(workspace, "handler-called");
  const handlerPath = join(projectRoot, "handlers/examples/data_tools/search_datasets.handler.mjs");
  const handlerText = [
    "import { writeFileSync } from 'node:fs';",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    `  writeFileSync(${JSON.stringify(markerPath)}, 'called');`,
    "  const request = JSON.parse(input);",
    "  const payload = request.arguments.request;",
    "  if (!process.env.DATA_API_TOKEN) {",
    "    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'MissingSecretEnv', message: 'missing token' } }));",
    "    return;",
    "  }",
    "  process.stdout.write(JSON.stringify({ ok: true, value: {",
    "    title: `Dataset ${payload.query}`,",
    "    url: 'https://www.donneesquebec.ca/recherche/dataset/demo',",
    "    result_count: payload.rows",
    "  } }));",
    "});",
    "",
  ].join("\n");
  writeFileSync(handlerPath, handlerText, "utf8");

  const manifestPath = join(projectRoot, "touba.manifest.json");
  const manifestText = importedToolManifestText();
  writeFileSync(manifestPath, manifestText, "utf8");

  const secretsPath = join(projectRoot, "touba.secrets.dev.json");
  writeFileSync(secretsPath, JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      DATA_API_TOKEN: {
        source: "env",
        name: "DATA_API_TOKEN",
      },
    },
  }), "utf8");

  const airText = readFileSync(airPath, "utf8");
  const lockPath = join(projectRoot, "touba.lock.json");
  writeFileSync(lockPath, `${JSON.stringify({
    lock_schema_version: "touba-lock-v0.1",
    lock_kind: "supply_chain",
    generated_at: "2026-06-05T12:00:00Z",
    generated_by: {
      tool: "touba test",
      version: "0.1.0",
    },
    air: {
      path: "../fixture.air.json",
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
        tool_ref: "tool:examples.data_tools/SearchDatasets",
        path: "handlers/examples/data_tools/search_datasets.handler.mjs",
        command: process.execPath,
        cwd: ".",
        args: ["handlers/examples/data_tools/search_datasets.handler.mjs"],
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
          name: "examples.data_tools.handlers",
          version: "0.1.0",
          entrypoint: "handlers/examples/data_tools/search_datasets.handler.mjs",
        },
      },
    ],
  }, null, 2)}\n`, "utf8");

  return {
    airPath,
    manifestPath,
    secretsPath,
    lockPath,
    handlerPath,
    markerPath,
    projectRoot,
  };
}

function importedToolManifestText({ grants = ["network", "secret_read"] } = {}) {
  return `${JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:examples.data_tools/SearchDatasets": {
        handler: {
          kind: "process",
          command: process.execPath,
          args: ["handlers/examples/data_tools/search_datasets.handler.mjs"],
          cwd: ".",
        },
        grants,
        secrets: ["DATA_API_TOKEN"],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
        payload_constraints: {
          input: {
            "request.query": {
              non_empty: true,
              max_length: 80,
            },
            "request.rows": {
              min: 1,
              max: 50,
            },
          },
        },
      },
    },
  }, null, 2)}\n`;
}

function writeTriggerManifest(
  workspace,
  {
    fileName = "touba.manifest.trigger.json",
    enabled = true,
    sourceKind = "schedule",
    limits = {
      max_runs_per_day: 1,
      timeout_ms: 30000,
    },
  } = {},
) {
  const manifestPath = join(workspace, fileName);
  writeFileSync(manifestPath, JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {},
    triggers: {
      "trigger:examples.cli_trigger/DailyRun": {
        enabled,
        source: {
          kind: sourceKind,
          timezone: "America/Montreal",
        },
        limits,
      },
    },
  }), "utf8");
  return manifestPath;
}

function writeTimeoutToolManifest(workspace, firstHandlerPath, secondHandlerPath) {
  const manifestPath = join(workspace, "touba.manifest.timeout.json");
  writeFileSync(manifestPath, JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:examples.cli_timeout/First": processBinding(firstHandlerPath),
      "tool:examples.cli_timeout/Second": processBinding(secondHandlerPath),
    },
  }), "utf8");
  return manifestPath;
}

function processBinding(handlerPath) {
  return {
    handler: {
      kind: "process",
      command: process.execPath,
      args: [handlerPath],
    },
    grants: ["local"],
    timeout_ms: 5000,
    max_payload_bytes: 1048576,
  };
}

function withoutEnv(name) {
  const env = { ...process.env };
  delete env[name];
  return env;
}

function timeoutToolDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:examples.cli_timeout",
      name: "examples.cli_timeout",
      source_ref: sourceRef(),
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:examples.cli_timeout/First",
          name: "First",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          required_capabilities: ["local"],
          required_secrets: [],
          source_ref: sourceRef(),
        },
        {
          id: "tool:examples.cli_timeout/Second",
          name: "Second",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          required_capabilities: ["local"],
          required_secrets: [],
          source_ref: sourceRef(),
        },
      ],
      skills: [
        {
          id: "skill:examples.cli_timeout/Run",
          name: "Run",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          uses: ["tool:examples.cli_timeout/First", "tool:examples.cli_timeout/Second"],
          flow_graph_ref: "graph:skill:examples.cli_timeout/Run",
          source_ref: sourceRef(),
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      graph(
        "graph:skill:examples.cli_timeout/Run",
        "skill:examples.cli_timeout/Run",
        [
          node("n1", "call_tool", {
            target_ref: "tool:examples.cli_timeout/First",
            result_binding: "first",
          }),
          node("n2", "call_tool", {
            target_ref: "tool:examples.cli_timeout/Second",
            result_binding: "second",
          }),
          node("n3", "give", { arguments: ["value:second"] }),
        ],
        [edge("n1", "n2", "next"), edge("n2", "n3", "next")],
      ),
    ],
    trace_points: [],
  };
}

function linearSourceDocument({ withFallback = false } = {}) {
  const mainSkill = skill("BuildNote", "graph:skill:examples.linear_skill/BuildNote", [
    LINEAR_FETCH_SOURCE_TOOL_REF,
    ...(withFallback ? ["skill:examples.linear_skill/FallbackNote"] : []),
  ]);
  const fallbackSkill = skill("FallbackNote", "graph:skill:examples.linear_skill/FallbackNote");

  return {
    air_schema_version: "air-minimal-v0.1",
    module: {
      id: "module:examples.linear_skill",
      name: "examples.linear_skill",
      source_ref: sourceRef(),
    },
    definitions: {
      types: [],
      functions: [],
      tools: [
        {
          id: LINEAR_FETCH_SOURCE_TOOL_REF,
          name: "FetchSource",
          signature: {
            inputs: [],
            output_type: "type:examples.linear_skill/SourceText",
          },
          source_ref: sourceRef(),
        },
      ],
      skills: withFallback ? [mainSkill, fallbackSkill] : [mainSkill],
      agents: [],
      strategies: [],
    },
    execution_graphs: withFallback ? [mainGraphWithFallback(), fallbackGraph()] : [mainGraph()],
    trace_points: [],
  };
}

function humanApprovalDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    module: {
      id: "module:examples.cli_human",
      name: "examples.cli_human",
      source_ref: sourceRef(),
    },
    definitions: {
      types: [],
      functions: [],
      tools: [],
      skills: [
        {
          id: "skill:examples.cli_human/ReviewChange",
          name: "ReviewChange",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          uses: [],
          flow_graph_ref: "graph:skill:examples.cli_human/ReviewChange",
          source_ref: sourceRef(),
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      graph(
        "graph:skill:examples.cli_human/ReviewChange",
        "skill:examples.cli_human/ReviewChange",
        [
          node("n1", "human_approval", {
            approval_ref: "approval:examples.cli:required",
            approval_mode: "required_approval",
            context_refs: ["literal:string:change"],
            result_binding: "approval",
          }),
          node("n2", "give", { arguments: ["value:approval"] }),
        ],
        [edge("n1", "n2", "next")],
      ),
    ],
    trace_points: [],
  };
}

function toolThenHumanApprovalDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    module: {
      id: "module:examples.cli_human_checkpoint",
      name: "examples.cli_human_checkpoint",
      source_ref: sourceRef(),
    },
    definitions: {
      types: [],
      functions: [],
      tools: [
        {
          id: LINEAR_FETCH_SOURCE_TOOL_REF,
          name: "FetchSource",
          signature: {
            inputs: [],
            output_type: "type:examples.linear_skill/SourceText",
          },
          source_ref: sourceRef(),
        },
      ],
      skills: [
        {
          id: "skill:examples.cli_human_checkpoint/ReviewFetched",
          name: "ReviewFetched",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          uses: [LINEAR_FETCH_SOURCE_TOOL_REF],
          flow_graph_ref: "graph:skill:examples.cli_human_checkpoint/ReviewFetched",
          source_ref: sourceRef(),
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      graph(
        "graph:skill:examples.cli_human_checkpoint/ReviewFetched",
        "skill:examples.cli_human_checkpoint/ReviewFetched",
        [
          node("fetch", "call_tool", {
            target_ref: LINEAR_FETCH_SOURCE_TOOL_REF,
            result_binding: "fetched",
          }),
          node("review", "human_approval", {
            approval_ref: "approval:examples.cli:after-fetch",
            approval_mode: "required_approval",
            context_refs: ["value:fetched"],
            result_binding: "approval",
          }),
          node("done", "give", { arguments: ["value:approval"] }),
        ],
        [
          edge("fetch", "review", "next"),
          edge("review", "done", "next"),
        ],
      ),
    ],
    trace_points: [],
  };
}

function agentToolThenHumanReviewDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    module: {
      id: "module:examples.cli_agent_human_checkpoint",
      name: "examples.cli_agent_human_checkpoint",
      source_ref: sourceRef(),
    },
    definitions: {
      types: [
        {
          id: "type:examples.linear_skill/SourceText",
          name: "SourceText",
          fields: [{ name: "content", type_ref: "builtin:Text" }],
          source_ref: sourceRef(),
        },
      ],
      functions: [],
      tools: [
        {
          id: LINEAR_FETCH_SOURCE_TOOL_REF,
          name: "FetchSource",
          signature: {
            inputs: [],
            output_type: "type:examples.linear_skill/SourceText",
          },
          source_ref: sourceRef(),
        },
      ],
      skills: [
        {
          id: "skill:examples.cli_agent_human_checkpoint/FetchData",
          name: "FetchData",
          description: "Fetch the source text that must be reviewed before the run can continue.",
          signature: {
            inputs: [],
            output_type: "type:examples.linear_skill/SourceText",
          },
          uses: [LINEAR_FETCH_SOURCE_TOOL_REF],
          flow_graph_ref: "graph:skill:examples.cli_agent_human_checkpoint/FetchData",
          source_ref: sourceRef(),
        },
      ],
      agents: [
        {
          id: "agent:examples.cli_agent_human_checkpoint/Researcher",
          name: "Researcher",
          responsibility: "Fetch source text and request human review when needed.",
          uses: ["skill:examples.cli_agent_human_checkpoint/FetchData"],
          callable_by: [
            {
              caller_ref: "strategy:examples.cli_agent_human_checkpoint/RunResearch",
              caller_kind: "strategy",
              source_ref: sourceRef(),
            },
          ],
          source_ref: sourceRef(),
        },
      ],
      strategies: [
        {
          id: "strategy:examples.cli_agent_human_checkpoint/RunResearch",
          name: "RunResearch",
          uses: ["agent:examples.cli_agent_human_checkpoint/Researcher"],
          flow_graph_ref: "graph:strategy:examples.cli_agent_human_checkpoint/RunResearch",
          source_ref: sourceRef(),
        },
      ],
    },
    execution_graphs: [
      graph(
        "graph:skill:examples.cli_agent_human_checkpoint/FetchData",
        "skill:examples.cli_agent_human_checkpoint/FetchData",
        [
          node("fetch", "call_tool", {
            target_ref: LINEAR_FETCH_SOURCE_TOOL_REF,
            result_binding: "fetched",
          }),
          node("done", "give", { arguments: ["value:fetched"] }),
        ],
        [
          edge("fetch", "done", "next"),
        ],
      ),
      graph(
        "graph:strategy:examples.cli_agent_human_checkpoint/RunResearch",
        "strategy:examples.cli_agent_human_checkpoint/RunResearch",
        [
          node("run", "call_agent", {
            target_ref: "agent:examples.cli_agent_human_checkpoint/Researcher",
          }),
        ],
      ),
    ],
    trace_points: [],
  };
}

function userInteractionDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    module: {
      id: "module:examples.cli_user",
      name: "examples.cli_user",
      source_ref: sourceRef(),
    },
    definitions: {
      types: [],
      functions: [],
      tools: [],
      skills: [
        {
          id: "skill:examples.cli_user/Interact",
          name: "Interact",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          uses: [],
          flow_graph_ref: "graph:skill:examples.cli_user/Interact",
          source_ref: sourceRef(),
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      graph(
        "graph:skill:examples.cli_user/Interact",
        "skill:examples.cli_user/Interact",
        [
          node("n1", "user_interaction", {
            interaction_ref: "interaction:examples.cli:show-ready",
            interaction_mode: "show",
            arguments: ["literal:string:Touba ready"],
          }),
          node("n2", "user_interaction", {
            interaction_ref: "interaction:examples.cli:user-query",
            interaction_mode: "ask",
            arguments: ["literal:string:Search query?"],
            result_binding: "query",
          }),
          node("n3", "give", { arguments: ["value:query"] }),
        ],
        [edge("n1", "n2", "next"), edge("n2", "n3", "next")],
      ),
    ],
    trace_points: [],
  };
}

function triggerDocument({ scheduleValue = "0 8 * * *" } = {}) {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:examples.cli_trigger",
      name: "examples.cli_trigger",
      source_ref: sourceRef(),
    },
    definitions: {
      types: [],
      constants: [],
      functions: [],
      tools: [],
      memories: [],
      skills: [],
      agents: [],
      strategies: [
        {
          id: "strategy:examples.cli_trigger/RunDaily",
          name: "RunDaily",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          flow_graph_ref: "graph:strategy:examples.cli_trigger/RunDaily",
          source_ref: sourceRef(),
        },
      ],
      triggers: [
        {
          id: "trigger:examples.cli_trigger/DailyRun",
          name: "DailyRun",
          event: {
            kind: "schedule",
            value: scheduleValue,
            source_ref: sourceRef(),
          },
          target_ref: "strategy:examples.cli_trigger/RunDaily",
          target_kind: "strategy",
          arguments: [],
          limits: {
            max_runs_per_day: 1,
            timeout_ms: 30000,
            source_ref: sourceRef(),
          },
          source_ref: sourceRef(),
        },
      ],
    },
    execution_graphs: [
      graph("graph:strategy:examples.cli_trigger/RunDaily", "strategy:examples.cli_trigger/RunDaily", [
        node("n1", "give", { arguments: ["literal:string:triggered"] }),
      ]),
    ],
    trace_points: [],
  };
}

function triggerEvent(fields = {}) {
  return {
    trigger_ref: "trigger:examples.cli_trigger/DailyRun",
    event_id: "evt-cli-001",
    source_kind: "schedule",
    payload: {
      raw: "raw-secret-payload",
    },
    ...fields,
  };
}

function mainGraph() {
  return graph(
    "graph:skill:examples.linear_skill/BuildNote",
    "skill:examples.linear_skill/BuildNote",
    [
      node("n1", "call_tool", { target_ref: LINEAR_FETCH_SOURCE_TOOL_REF }),
      node("n2", "give", { arguments: ["literal:string:done"] }),
    ],
    [
      edge("n1", "n2", "next"),
    ],
  );
}

function mainGraphWithFallback() {
  const failurePath = {
    id: "failure:graph:skill:examples.linear_skill/BuildNote:1",
    scope_ref: "graph:skill:examples.linear_skill/BuildNote",
    trigger_node_id: "n1",
    mode: "fallback",
    target_node_id: "n3",
    source_ref: sourceRef(),
  };

  return graph(
    "graph:skill:examples.linear_skill/BuildNote",
    "skill:examples.linear_skill/BuildNote",
    [
      node("n1", "call_tool", { target_ref: LINEAR_FETCH_SOURCE_TOOL_REF }),
      node("n2", "give", { arguments: ["literal:string:done"] }),
      node("n3", "fallback", { target_ref: "skill:examples.linear_skill/FallbackNote" }),
    ],
    [
      edge("n1", "n2", "next"),
      edge("n1", "n3", "failure"),
      edge("n1", "n3", "fallback"),
    ],
    [failurePath],
  );
}

function fallbackGraph() {
  return graph(
    "graph:skill:examples.linear_skill/FallbackNote",
    "skill:examples.linear_skill/FallbackNote",
    [
      node("f1", "give", { arguments: ["literal:string:fallback"] }),
    ],
  );
}

function skill(name, flowGraphRef, uses = []) {
  return {
    id: `skill:examples.linear_skill/${name}`,
    name,
    signature: {
      inputs: [],
      output_type: "type:examples.linear_skill/SourceNote",
    },
    uses,
    flow_graph_ref: flowGraphRef,
    source_ref: sourceRef(),
  };
}

function graph(id, ownerRef, nodes, edges = [], failurePaths = []) {
  return {
    id,
    owner_ref: ownerRef,
    entry_node_id: nodes[0].id,
    nodes,
    edges,
    failure_paths: failurePaths,
    failure_path_refs: failurePaths.map((failurePath) => failurePath.id),
    source_ref: sourceRef(),
  };
}

function node(id, kind, fields = {}) {
  return {
    id,
    kind,
    arguments: [],
    trace_point_refs: [],
    source_ref: sourceRef(),
    ...fields,
  };
}

function edge(fromNodeId, toNodeId, role) {
  return {
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    role,
  };
}

function sourceRef() {
  return {
    source_id: "linear-source-test.tb",
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: 0,
  };
}

function runCliExpectFailure(args, options = {}) {
  try {
    execFileSync(process.execPath, args, {
      encoding: "utf8",
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      status: error.status,
      stderr: error.stderr,
    };
  }

  assert.fail("expected CLI command to fail");
}

function fileExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function eventOf(trace, kind) {
  return trace.events.find((event) => event.kind === kind);
}
