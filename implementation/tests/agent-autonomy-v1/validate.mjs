import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const sourcePath = path.join(fixtureRoot, "source/agent-autonomy-v1.tb");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-agent-autonomy-v1-"));
const airPath = path.join(tmpRoot, "agent-autonomy-v1.air.json");
const cargo = process.env.CARGO ?? "cargo";

try {
  compileSourceToAir();
  const selected = runAir({
    "agent:examples.agent_autonomy_v1/Researcher": {
      target_ref: "skill:examples.agent_autonomy_v1/UseMemorySearch",
      source: "fixture_decision",
      reason: "memory path requested",
    },
  });
  assertSelectedTrace(selected.trace);

  const refused = runAir({
    "agent:examples.agent_autonomy_v1/Researcher": "skill:examples.agent_autonomy_v1/HiddenSearch",
  }, { expectFailure: true });
  assertRefusedTrace(refused.trace, refused.stderr);

  console.log("agent-autonomy-v1: status=success decision=governed_selection refusal=uses_boundary");
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
  if (air.module?.id !== "module:examples.agent_autonomy_v1") {
    throw new Error(`unexpected module id ${air.module?.id}`);
  }
  if (!air.definitions?.agents?.some((agent) => agent.id === "agent:examples.agent_autonomy_v1/Researcher")) {
    throw new Error("compiled AIR is missing Researcher agent");
  }
}

function runAir(agentDecisions, options = {}) {
  const runResult = spawnSync(
    process.execPath,
    [
      path.join(implementationRoot, "cli/touba-run/src/run.mjs"),
      airPath,
      "--agent-decisions-json",
      JSON.stringify(agentDecisions),
      "--output",
      "trace",
    ],
    {
      cwd: implementationRoot,
      encoding: "utf8",
    },
  );

  if (options.expectFailure === true) {
    if (runResult.status === 0) {
      throw new Error("expected run failure for refused agent capability");
    }
  } else {
    assertSuccess("run", runResult);
  }

  return {
    trace: JSON.parse(runResult.stdout),
    stderr: runResult.stderr,
  };
}

function assertSelectedTrace(trace) {
  const listed = event(trace, "agent_capabilities_listed");
  assertDeepEqual(listed.payload.capability_refs, [
    "skill:examples.agent_autonomy_v1/UseDatasetSearch",
    "skill:examples.agent_autonomy_v1/UseMemorySearch",
  ], "capability_refs");

  const decision = event(trace, "agent_decision_recorded");
  if (decision.payload.selected_ref !== "skill:examples.agent_autonomy_v1/UseMemorySearch") {
    throw new Error(`unexpected selected_ref ${decision.payload.selected_ref}`);
  }
  if (decision.payload.decision_source !== "fixture_decision") {
    throw new Error(`unexpected decision_source ${decision.payload.decision_source}`);
  }

  const selected = event(trace, "agent_capability_selected");
  if (selected.payload.authority_source !== "uses") {
    throw new Error(`unexpected authority_source ${selected.payload.authority_source}`);
  }

  const messages = shownMessages(trace);
  assertDeepEqual(messages, ["Memory search selected"], "shown messages");
  if (trace.events.some((item) => item.kind === "agent_capability_refused")) {
    throw new Error("selected run must not include agent_capability_refused");
  }
  assertRunStatus(trace, "success");
}

function assertRefusedTrace(trace, stderr) {
  const refused = event(trace, "agent_capability_refused");
  if (refused.payload.selected_ref !== "skill:examples.agent_autonomy_v1/HiddenSearch") {
    throw new Error(`unexpected refused selected_ref ${refused.payload.selected_ref}`);
  }
  assertDeepEqual(refused.payload.allowed_refs, [
    "skill:examples.agent_autonomy_v1/UseDatasetSearch",
    "skill:examples.agent_autonomy_v1/UseMemorySearch",
  ], "allowed_refs");
  if (!stderr.includes("AgentCapabilityNotAllowed")) {
    throw new Error("stderr must expose AgentCapabilityNotAllowed");
  }
  if (shownMessages(trace).length !== 0) {
    throw new Error("refused capability must not enter any selected skill");
  }
  assertRunStatus(trace, "failure");
}

function shownMessages(trace) {
  return trace.events
    .filter((item) => item.kind === "user_interaction_shown")
    .map((item) => item.payload?.message)
    .filter((message) => typeof message === "string");
}

function assertRunStatus(trace, expected) {
  const completed = trace.events.at(-1);
  if (completed?.kind !== "run_completed" || completed.payload?.status !== expected) {
    throw new Error(`expected run_completed ${expected}, got ${completed?.payload?.status}`);
  }
}

function event(trace, kind) {
  const found = trace.events.find((item) => item.kind === kind);
  if (!found) {
    throw new Error(`missing trace event ${kind}`);
  }
  return found;
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
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
