import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  executeAirDocument,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
} from "../../runtime/touba-runtime/src/index.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const sourcePath = path.join(fixtureRoot, "source/incident-remediation.tb");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-multi-agent-sequential-"));
const airPath = path.join(tmpRoot, "incident-remediation.air.json");
const toolRef = "tool:examples.incident_remediation/ApplyRemediation";
const executionAgentRef = "agent:examples.incident_remediation/ExecutionAgent";

try {
  const air = compileSource();
  const approvalRef = air.execution_graphs
    .flatMap((graph) => graph.nodes)
    .find((node) => node.kind === "human_approval")?.approval_ref;
  assert.ok(approvalRef, "compiled strategy must expose a stable approval ref");

  const positive = await executeScenario(air, approvalRef, "approved");
  assert.equal(positive.result.status, "success", JSON.stringify(positive.result.trace.events.at(-2)));
  assert.deepEqual(positive.result.result, { status: "applied" });
  assert.equal(positive.effects, 1);
  assertAgentOrder(positive.result.trace);
  assertNoPayloadLeak(positive.result.trace);

  const rejected = await executeScenario(air, approvalRef, "rejected");
  assert.equal(rejected.result.status, "stopped");
  assert.equal(rejected.effects, 0);

  const unauthorizedAir = structuredClone(air);
  unauthorizedAir.definitions.agents.find((agent) => agent.id === executionAgentRef).callable_by = [];
  const unauthorized = await executeScenario(unauthorizedAir, approvalRef, "approved");
  assertFailureBeforeEffect(unauthorized, "UnauthorizedAgentInvocation");

  const wrongType = await executeScenario(air, approvalRef, "approved", {
    inputs: { request: "not-an-incident" },
  });
  assertFailureBeforeEffect(wrongType, "EntryInputSchemaInvalid");

  const overBudget = await executeScenario(air, approvalRef, "approved", {
    runLimits: { max_agent_invocations: 2 },
  });
  assertFailureBeforeEffect(overBudget, "AgentInvocationBudgetExceeded");

  const missingSecret = await executeScenario(air, approvalRef, "approved", {
    secretStore: loadSecretsFromJson(JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {},
    })),
  });
  assertFailureBeforeEffect(missingSecret, "SecretNotResolved");

  const missingScopeAir = structuredClone(air);
  missingScopeAir.definitions.agents.find((agent) => agent.id === executionAgentRef).memory_scopes = [];
  const missingScope = await executeScenario(missingScopeAir, approvalRef, "approved");
  assertFailureBeforeEffect(missingScope, "MemoryNotGrantedToOwner");

  const outsideUses = await executeScenario(air, approvalRef, "approved", {
    executionTarget: "tool:examples.incident_remediation/HiddenEffect",
  });
  assertFailureBeforeEffect(outsideUses, "AgentCapabilityNotAllowed");

  console.log("multi-agent-sequential-v1: status=success agents=3 effects=1 refusals=human,caller,type,budget,secret,scope,uses");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function compileSource() {
  const result = spawnSync(
    process.env.CARGO ?? "cargo",
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", path.relative(implementationRoot, sourcePath)],
    { cwd: implementationRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  writeFileSync(airPath, result.stdout, "utf8");
  return JSON.parse(result.stdout);
}

async function executeScenario(air, approvalRef, humanDecision, overrides = {}) {
  let effects = 0;
  let executionSteps = 0;
  const result = await executeAirDocument(air, {
    inputs: overrides.inputs ?? { request: { service: "payments" } },
    humanApprovalDecisions: { [approvalRef]: humanDecision },
    runLimits: overrides.runLimits,
    toolBindingManifest: manifest(),
    secretStore: overrides.secretStore ?? secrets(),
    toolHandlers: {
      [toolRef]: ({ arguments: args }) => {
        effects += 1;
        assert.deepEqual(args, { plan: { action: "restart" } });
        return { status: "applied" };
      },
    },
    agentDecisionProvider: (request) => {
      if (request.agent_ref.endsWith("/TriageAgent")) {
        return { action: "answer_directly", source: "fixture", result: { severity: "high" } };
      }
      if (request.agent_ref.endsWith("/PlanningAgent")) {
        return { action: "answer_directly", source: "fixture", result: { action: "restart" } };
      }
      executionSteps += 1;
      if (executionSteps > 1) {
        return { action: "answer_directly", source: "fixture", result: { status: "applied" } };
      }
      return {
        target_ref: overrides.executionTarget ?? toolRef,
        source: "fixture",
        arguments: { plan: request.inputs.plan },
      };
    },
  });
  return { result, effects };
}

function manifest() {
  return loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    agent_secret_scopes: { [executionAgentRef]: ["REMEDIATION_TOKEN"] },
    bindings: {
      [toolRef]: {
        effect_contract: { kind: "none" }, handler: { kind: "process", command: process.execPath, args: ["unused"] },
        grants: ["network", "memory_write", "secret_read"],
        secrets: ["REMEDIATION_TOKEN"],
        memories: [{ ref: "memory:examples.incident_remediation/RemediationLedger", access: "write" }],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
    },
  }));
}

function secrets() {
  return loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: { REMEDIATION_TOKEN: { source: "env", name: "REMEDIATION_TOKEN" } },
  }), { env: { REMEDIATION_TOKEN: "fixture-secret-never-traced" } });
}

function assertAgentOrder(trace) {
  assert.deepEqual(
    trace.events.filter((event) => event.kind === "agent_interface_entered").map((event) => event.payload.agent_ref),
    [
      "agent:examples.incident_remediation/TriageAgent",
      "agent:examples.incident_remediation/PlanningAgent",
      executionAgentRef,
    ],
  );
}

function assertFailureBeforeEffect(run, expectedCode) {
  assert.equal(run.result.status, "failure");
  assert.equal(run.effects, 0);
  assert.equal(
    run.result.trace.events.some((event) => event.payload?.runtime_error_code === expectedCode),
    true,
    `missing ${expectedCode}; observed=${JSON.stringify(run.result.trace.events.map((event) => event.payload?.runtime_error_code).filter(Boolean))}`,
  );
}

function assertNoPayloadLeak(trace) {
  const serialized = JSON.stringify(trace);
  for (const forbidden of ["payments", "restart", "applied", "fixture-secret-never-traced"]) {
    assert.equal(serialized.includes(forbidden), false, `trace leaked ${forbidden}`);
  }
}
