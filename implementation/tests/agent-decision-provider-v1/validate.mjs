import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const sourcePath = path.join(fixtureRoot, "source/agent-decision-provider-v1.tb");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-agent-decision-provider-v1-"));
const airPath = path.join(tmpRoot, "agent-decision-provider-v1.air.json");
const tracePath = path.join(tmpRoot, "agent-decision-provider-v1.trace.json");
const cargo = process.env.CARGO ?? "cargo";
const runCli = path.join(implementationRoot, "cli/touba-run/src/run.mjs");

try {
  compileSourceToAir();
  const positive = runWithProvider("catalog-first.provider.mjs", {
    request: {
      query: "postgres",
    },
  });
  assertPositiveRun(positive);

  const refused = runWithProvider("refused.provider.mjs", {
    request: {
      query: "postgres",
    },
  }, { expectFailure: true });
  assertRefusedRun(refused);

  const invalidArguments = runWithProvider("invalid-arguments.provider.mjs", {
    request: {
      query: "postgres",
    },
  }, { expectFailure: true });
  assertInvalidArgumentsRun(invalidArguments);

  console.log("agent-decision-provider-v1: status=success mode=catalog_on_demand observations=returned args=governed refusal=uses_boundary");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function compileSourceToAir() {
  const compileResult = spawnSync(
    cargo,
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourcePath],
    {
      cwd: implementationRoot,
      encoding: "utf8",
    },
  );
  assertSuccess("compile", compileResult);
  writeFileSync(airPath, compileResult.stdout, "utf8");
  const air = JSON.parse(readFileSync(airPath, "utf8"));
  if (air.module?.id !== "module:examples.agent_decision_provider_v1") {
    throw new Error(`unexpected module id ${air.module?.id}`);
  }
}

function runWithProvider(providerName, inputs, options = {}) {
  const result = spawnSync(
    process.execPath,
    [
      runCli,
      airPath,
      "--inputs-json",
      JSON.stringify(inputs),
      "--agent-decision-provider",
      path.join(fixtureRoot, "providers", providerName),
      "--agent-decision-provider-metadata-json",
      JSON.stringify({
        provider_kind: "test_provider",
        provider_name: "agent-decision-provider-v1-fixture",
        provider_version: "1.0.0",
        decision_schema_version: "touba-agent-decision-v1",
      }),
      "--agent-decision-provider-timeout-ms",
      "1000",
      "--agent-decision-provider-max-retries",
      "0",
      "--max-provider-calls",
      "4",
      "--trace-out",
      tracePath,
      "--output",
      "json",
    ],
    {
      cwd: implementationRoot,
      encoding: "utf8",
    },
  );

  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  if (options.expectFailure === true) {
    if (result.status === 0) {
      throw new Error("expected provider run to fail");
    }
  } else {
    assertSuccess("run", result);
  }
  return {
    result,
    output: JSON.parse(result.stdout),
    trace,
  };
}

function assertPositiveRun(run) {
  if (run.output.result !== "postgres") {
    throw new Error(`unexpected result ${run.result.stdout}`);
  }
  const requested = events(run.trace, "agent_decision_requested");
  if (requested.length !== 3) {
    throw new Error(`expected three provider requests, got ${requested.length}`);
  }
  assertAdp1Trace(requested[0]);
  const budget = event(run.trace, "budget_limit_checked");
  if (budget.payload.budget_kind !== "max_provider_calls" || budget.payload.limit_value !== 4) {
    throw new Error(`unexpected provider budget ${JSON.stringify(budget.payload)}`);
  }
  const providerCalls = events(run.trace, "budget_consumed")
    .filter((item) => item.payload?.budget_kind === "max_provider_calls");
  if (providerCalls.length !== 3) {
    throw new Error(`expected three provider budget consumptions, got ${providerCalls.length}`);
  }
  if (requested[0].payload.mode !== "summary" || requested[0].payload.catalog_presented !== undefined) {
    throw new Error("first provider request must be summary without catalog");
  }
  if (requested[1].payload.mode !== "capabilities" || requested[1].payload.catalog_presented !== true) {
    throw new Error("second provider request must present the capability catalog");
  }
  if (requested[2].payload.mode !== "summary" || requested[2].payload.observation_count !== 1) {
    throw new Error("third provider request must be summary with one observation");
  }
  const selected = event(run.trace, "agent_capability_selected");
  if (selected.payload.selected_ref !== "skill:examples.agent_decision_provider_v1/BuildBrief") {
    throw new Error(`unexpected selected capability ${selected.payload.selected_ref}`);
  }
  const observed = event(run.trace, "agent_capability_result_returned");
  if (observed.payload.selected_ref !== "skill:examples.agent_decision_provider_v1/BuildBrief") {
    throw new Error(`unexpected observed capability ${observed.payload.selected_ref}`);
  }
  const messages = run.output.messages.map(message => message.text);
  if (JSON.stringify(messages) !== JSON.stringify(["Brief selected"])) {
    throw new Error(`unexpected shown messages ${JSON.stringify(messages)}`);
  }
  if (JSON.stringify(run.trace).includes("postgres")) {
    throw new Error("trace must not serialize raw provider input values");
  }
  assertRunStatus(run.trace, "success");
}

function assertAdp1Trace(requested) {
  if (!/^[a-f0-9]{64}$/.test(requested.payload.request_digest)) {
    throw new Error(`missing ADP-1 request digest ${requested.payload.request_digest}`);
  }
  const metadata = requested.payload.provider_metadata;
  if (
    metadata?.provider_kind !== "test_provider"
    || metadata?.provider_name !== "agent-decision-provider-v1-fixture"
    || metadata?.decision_schema_version !== "touba-agent-decision-v1"
  ) {
    throw new Error(`unexpected ADP-1 provider metadata ${JSON.stringify(metadata)}`);
  }
}

function assertRefusedRun(run) {
  const refused = event(run.trace, "agent_capability_refused");
  if (refused.payload.selected_ref !== "skill:examples.agent_decision_provider_v1/HiddenAdminPath") {
    throw new Error(`unexpected refused ref ${refused.payload.selected_ref}`);
  }
  if (!run.result.stderr.includes("AgentCapabilityNotAllowed")) {
    throw new Error("stderr must report AgentCapabilityNotAllowed");
  }
  assertRunStatus(run.trace, "failure");
}

function assertInvalidArgumentsRun(run) {
  const failure = event(run.trace, "failure_detected");
  if (failure.payload.runtime_error_code !== "AgentCapabilityArgumentsInvalid") {
    throw new Error(`unexpected failure code ${failure.payload.runtime_error_code}`);
  }
  if (JSON.stringify(failure.payload.missing_fields) !== JSON.stringify(["request"])) {
    throw new Error(`unexpected missing_fields ${JSON.stringify(failure.payload.missing_fields)}`);
  }
  if (JSON.stringify(failure.payload.unknown_fields) !== JSON.stringify(["unexpected"])) {
    throw new Error(`unexpected unknown_fields ${JSON.stringify(failure.payload.unknown_fields)}`);
  }
  assertRunStatus(run.trace, "failure");
}

function event(trace, kind) {
  const found = trace.events.find((item) => item.kind === kind);
  if (!found) {
    throw new Error(`missing trace event ${kind}`);
  }
  return found;
}

function events(trace, kind) {
  return trace.events.filter((item) => item.kind === kind);
}

function assertRunStatus(trace, expected) {
  const completed = trace.events.at(-1);
  if (completed?.kind !== "run_completed" || completed.payload?.status !== expected) {
    throw new Error(`expected run_completed ${expected}, got ${completed?.payload?.status}`);
  }
}

function assertSuccess(label, result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}
