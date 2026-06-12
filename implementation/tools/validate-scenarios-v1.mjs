#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { generateManifestFromAirDocument } from "../cli/touba-manifest/src/generate.mjs";
import {
  executeAirDocument,
  loadAirFromJson,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
} from "../runtime/touba-runtime/src/index.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const implementationRoot = resolve(__dir, "..");
const scenarioRoot = resolve(
  implementationRoot,
  "grammar/tree-sitter-touba/examples/scenarios-v1",
);
const cargoManifest = resolve(implementationRoot, "Cargo.toml");
const cargo = process.env.CARGO ?? "cargo";

const positives = {
  pureFunctions: "positive/tb-scenario-v1-p01-fonctions-metier-pures.tb",
  changeReview: "positive/tb-scenario-v1-p02-agent-strategy-revue-changement.tb",
  humanInteraction: "positive/tb-scenario-v1-p03-interaction-humaine-validation.tb",
  memoryScope: "positive/tb-scenario-v1-p04-memoire-scopee-agent.tb",
  regulatedPayment: "positive/tb-scenario-v1-p05-validation-avant-effet-externe.tb",
};

const negatives = [
  {
    id: "bad-function-concat",
    file: "negative/semantic/tb-scenario-v1-n01-fonction-concat-type-invalide.tb",
    diagnostic: "InvalidExpressionOperandType",
  },
  {
    id: "bad-function-return",
    file: "negative/semantic/tb-scenario-v1-n02-fonction-retour-type-invalide.tb",
    diagnostic: "IncompatibleExpressionType",
  },
  {
    id: "agent-caller-denied",
    file: "negative/semantic/tb-scenario-v1-n03-agent-caller-non-autorise.tb",
    diagnostic: "AgentCallerNotAllowed",
  },
  {
    id: "show-in-function",
    file: "negative/semantic/tb-scenario-v1-n04-interaction-dans-function.tb",
    diagnostic: "UserInteractionInFunction",
  },
  {
    id: "human-approval-in-function",
    file: "negative/semantic/tb-scenario-v1-n05-human-approval-dans-function.tb",
    diagnostic: "HumanApprovalInFunction",
  },
  {
    id: "memory-owner-scope-missing",
    file: "negative/semantic/tb-scenario-v1-n06-memoire-scope-manquant.tb",
    diagnostic: "OwnerMemoryScopeMissing",
  },
];

let checks = 0;

await main();

async function main() {
  try {
    await runStep("compile positive scenario fixtures", () => {
      for (const file of Object.values(positives)) {
        compileScenario(file);
        checks += 1;
      }
    });
    await runStep("compile negative scenario fixtures", () => {
      for (const fixture of negatives) {
        compileNegativeScenario(fixture);
        checks += 1;
      }
    });

    await runStep("scenario S01 pure functions runtime", validatePureFunctions);
    await runStep("scenario S02 agent strategy review runtime", validateChangeReview);
    await runStep("scenario S03 human interaction runtime", validateHumanInteraction);
    await runStep("scenario S06 memory scope runtime", validateMemoryScope);
    await runStep("scenario S17 regulated external effect runtime", validateRegulatedPayment);
    await runStep("scenario S07 tool security refusals", validateToolSecurityRefusals);
    await runStep("scenario S05 Donnees Quebec agent dry-run", runDonneesQuebecAgentDryRun);

    process.stdout.write(`scenarios-v1: status=success checked=${checks}\n`);
  } catch (error) {
    process.stderr.write(formatScenarioFailure(error));
    process.exitCode = 1;
  }
}

async function runStep(label, action) {
  try {
    return await action();
  } catch (error) {
    const wrapped = new Error(
      [
        "scenarios-v1 validation failed",
        `step: ${label}`,
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function formatScenarioFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `${message}\n`;
}

async function validatePureFunctions() {
  const document = compileScenario(positives.pureFunctions);
  const signal = {
    title: "critical patch",
    high_impact: false,
    risk: 0.9,
    files: 7,
  };

  await assertRunResult(document, {
    entryRef: "function:examples.scenario_pure_functions/CountRemainingReviews",
    inputs: { requested: 5, completed: 2 },
    expected: 3,
  });
  await assertRunResult(document, {
    entryRef: "function:examples.scenario_pure_functions/ComputeAdjustedRisk",
    inputs: { signal, mitigation: 0.2 },
    expected: 0.7,
    approximate: true,
  });
  await assertRunResult(document, {
    entryRef: "function:examples.scenario_pure_functions/BuildReviewLabel",
    inputs: { signal },
    expected: "review: critical patch / files: 7",
  });
  await assertRunResult(document, {
    entryRef: "function:examples.scenario_pure_functions/ShouldEscalateChange",
    inputs: { signal },
    expected: true,
  });
  checks += 4;
}

async function validateChangeReview() {
  const document = compileScenario(positives.changeReview);
  let handlerCalled = false;
  const result = await executeAirDocument(document, {
    entryRef: "strategy:examples.scenario_change_review/RunChangeReview",
    inputs: { request: { summary: "tighten handler contract" } },
    toolHandlers: {
      "tool:examples.scenario_change_review/ApplyChange": ({ arguments: args }) => {
        handlerCalled = true;
        return { summary: `applied: ${args.request.summary}` };
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(handlerCalled, true);
  assert.equal(eventsOf(result.trace, "agent_invocation_authorized").length, 2);
  assert.equal(eventOf(result.trace, "tool_binding_authorized"), undefined);
  checks += 1;
}

async function validateHumanInteraction() {
  const document = compileScenario(positives.humanInteraction);
  const askRef = findNode(document, "user_interaction", (node) => node.interaction_mode === "ask")
    .interaction_ref;
  const approvalRef = findNode(document, "human_approval").approval_ref;
  const ticket = "TICKET-42";

  const result = await executeAirDocument(document, {
    entryRef: "strategy:examples.scenario_human_interaction/RunHumanValidation",
    inputs: { request: { summary: "update production handler" } },
    userInputs: { [askRef]: ticket },
    humanApprovalDecisions: { [approvalRef]: "approved" },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, ticket);
  assert.equal(eventOf(result.trace, "user_interaction_answered").payload.result_binding, "ticket");
  assert.equal(eventOf(result.trace, "human_approval_decided").payload.decision, "approved");
  assert.equal(JSON.stringify(result.trace).includes(ticket), false);

  const rejected = await executeAirDocument(document, {
    entryRef: "strategy:examples.scenario_human_interaction/RunHumanValidation",
    inputs: { request: { summary: "update production handler" } },
    userInputs: { [askRef]: ticket },
    humanApprovalDecisions: { [approvalRef]: "rejected" },
  });
  assert.equal(rejected.status, "stopped");
  assert.equal(eventOf(rejected.trace, "human_approval_rejected").payload.approval_ref, approvalRef);
  checks += 2;
}

async function validateMemoryScope() {
  const document = compileScenario(positives.memoryScope);
  const manifest = generateManifestFromAirDocument(document);
  const result = await executeAirDocument(document, {
    entryRef: "strategy:examples.scenario_memory_scope/RunKnowledgeReview",
    inputs: { query: { text: "handler contract" } },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(manifest)),
    toolHandlers: {
      "tool:examples.scenario_memory_scope/ReadProjectKnowledge": ({ arguments: args, binding }) => {
        assert.deepEqual(binding.grants, ["memory_read"]);
        assert.deepEqual(binding.memories, [
          {
            memory_ref: "memory:examples.scenario_memory_scope/ProjectKnowledge",
            access: "read",
          },
        ]);
        return { summary: `local memory summary for ${args.query.text}` };
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.result.summary, "local memory summary for handler contract");
  assert.equal(eventOf(result.trace, "memory_access_authorized").payload.access, "read");
  assert.equal(JSON.stringify(result.trace).includes("local memory summary"), false);

  const deniedManifest = structuredClone(manifest);
  deniedManifest.bindings["tool:examples.scenario_memory_scope/ReadProjectKnowledge"].grants = [];
  const denied = await executeAirDocument(document, {
    entryRef: "strategy:examples.scenario_memory_scope/RunKnowledgeReview",
    inputs: { query: { text: "handler contract" } },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(deniedManifest)),
    toolHandlers: {
      "tool:examples.scenario_memory_scope/ReadProjectKnowledge": () => {
        throw new Error("handler must not be called when memory grant is missing");
      },
    },
  });

  assert.equal(denied.status, "failure");
  assert.equal(eventOf(denied.trace, "memory_access_refused").payload.reason, "grant_missing");
  checks += 2;
}

async function validateRegulatedPayment() {
  const document = compileScenario(positives.regulatedPayment);
  const manifest = generateManifestFromAirDocument(document);
  const secretStore = loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      PAYMENT_API_KEY: {
        source: "env",
        name: "PAYMENT_API_TOKEN",
      },
    },
  }), {
    env: { PAYMENT_API_TOKEN: "resolved-payment-secret" },
  });
  const request = {
    reference: "PAY-42",
    amount: 1250.5,
    destination: "supplier-a",
  };
  const approvalRef = findNode(document, "human_approval").approval_ref;
  let approvedHandlerCalled = false;

  const approved = await executeAirDocument(document, {
    entryRef: "strategy:examples.scenario_external_approval/RunRegulatedPayment",
    inputs: { request },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(manifest)),
    secretStore,
    humanApprovalDecisions: { [approvalRef]: "approved" },
    toolHandlers: {
      "tool:examples.scenario_external_approval/SendPayment": ({ arguments: args, binding }) => {
        approvedHandlerCalled = true;
        assert.deepEqual(binding.grants, ["network", "secret_read"]);
        assert.deepEqual(binding.secretHandles, ["PAYMENT_API_KEY"]);
        return { receipt: `receipt:${args.request.reference}` };
      },
    },
  });

  assert.equal(approved.status, "success");
  assert.equal(approvedHandlerCalled, true);
  assert.deepEqual(approved.result, { receipt: "receipt:PAY-42" });
  assert.equal(eventOf(approved.trace, "human_approval_decided").payload.decision, "approved");
  assert.equal(eventOf(approved.trace, "tool_binding_authorized").payload.tool_ref, "tool:examples.scenario_external_approval/SendPayment");
  assert.equal(JSON.stringify(approved.trace).includes("resolved-payment-secret"), false);

  let rejectedHandlerCalled = false;
  const rejected = await executeAirDocument(document, {
    entryRef: "strategy:examples.scenario_external_approval/RunRegulatedPayment",
    inputs: { request },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(manifest)),
    secretStore,
    humanApprovalDecisions: { [approvalRef]: "rejected" },
    toolHandlers: {
      "tool:examples.scenario_external_approval/SendPayment": () => {
        rejectedHandlerCalled = true;
        return { receipt: "must-not-run" };
      },
    },
  });

  assert.equal(rejected.status, "stopped");
  assert.equal(rejectedHandlerCalled, false);
  assert.equal(eventOf(rejected.trace, "human_approval_rejected").payload.approval_ref, approvalRef);
  assert.equal(eventsOf(rejected.trace, "tool_binding_authorized").length, 0);
  assert.equal(JSON.stringify(rejected.trace).includes("resolved-payment-secret"), false);
  checks += 2;
}

async function validateToolSecurityRefusals() {
  const sourcePath = resolve(
    implementationRoot,
    "tests/tool-binding-v1/source/tb-v1-p01-process-fetch-source.tb",
  );
  const document = compileSourcePath(sourcePath);
  const manifest = generateManifestFromAirDocument(document);
  const secretStore = loadSecretsFromJson(
    readFileSync(
      resolve(implementationRoot, "tests/tool-binding-v1/secrets/touba.secrets.env.json"),
      "utf8",
    ),
    { env: { SEARCH_API_TOKEN: "resolved-secret-value" } },
  );

  let missingSecretHandlerCalled = false;
  const missingSecret = await executeAirDocument(document, {
    entryRef: "skill:examples.v1_process_binding/BuildSource",
    inputs: { request: { query: "touba" } },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(manifest)),
    toolHandlers: {
      "tool:examples.v1_process_binding/FetchSource": () => {
        missingSecretHandlerCalled = true;
        return { body: "unexpected", inherited_env_visible: false, secret_value_in_stdin: false };
      },
    },
  });
  assert.equal(missingSecret.status, "failure");
  assert.equal(missingSecretHandlerCalled, false);
  assert.deepEqual(eventOf(missingSecret.trace, "failure_detected").payload.secret_handles_required, [
    "SEARCH_API_KEY",
  ]);

  let invalidPayloadHandlerCalled = false;
  const invalidPayload = await executeAirDocument(document, {
    entryRef: "skill:examples.v1_process_binding/BuildSource",
    inputs: { request: { query: 7 } },
    toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(manifest)),
    secretStore,
    toolHandlers: {
      "tool:examples.v1_process_binding/FetchSource": () => {
        invalidPayloadHandlerCalled = true;
        return { body: "unexpected", inherited_env_visible: false, secret_value_in_stdin: false };
      },
    },
  });
  assert.equal(invalidPayload.status, "failure");
  assert.equal(invalidPayloadHandlerCalled, false);
  assert.equal(JSON.stringify(invalidPayload.trace).includes("resolved-secret-value"), false);
  checks += 2;
}

function runDonneesQuebecAgentDryRun() {
  const result = spawnSync(
    process.execPath,
    ["tests/tool-binding-v1/live-donnees-quebec/validate-agent.mjs", "--dry-run"],
    {
      cwd: implementationRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Donnees Quebec agent dry-run failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (!result.stdout.includes("agent:donnees-quebec mode=dry_run status=success")) {
    throw new Error(`unexpected Donnees Quebec agent dry-run output: ${result.stdout}`);
  }
  if (!result.stdout.includes("agent-work: summary=")) {
    throw new Error(`Donnees Quebec agent dry-run did not expose agent work evidence: ${result.stdout}`);
  }
  checks += 1;
}

async function assertRunResult(document, options) {
  const result = await executeAirDocument(document, {
    entryRef: options.entryRef,
    inputs: options.inputs,
  });
  assert.equal(result.status, "success", options.entryRef);
  if (options.approximate) {
    assert.ok(Math.abs(result.result - options.expected) < 0.000001, options.entryRef);
  } else {
    assert.deepEqual(result.result, options.expected, options.entryRef);
  }
}

function compileScenario(file) {
  return compileSourcePath(resolve(scenarioRoot, file));
}

function compileSourcePath(sourcePath) {
  const result = spawnSync(
    cargo,
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
      sourcePath,
    ],
    {
      cwd: implementationRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`compile failed for ${sourcePath}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return loadAirFromJson(result.stdout);
}

function compileNegativeScenario(fixture) {
  const sourcePath = resolve(scenarioRoot, fixture.file);
  const result = spawnSync(
    cargo,
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
      sourcePath,
    ],
    {
      cwd: implementationRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error(
      [
        `negative fixture compiled successfully: ${fixture.id}`,
        `file: ${fixture.file}`,
        `expected diagnostic: ${fixture.diagnostic}`,
      ].join("\n"),
    );
  }
  if (!result.stderr.includes(fixture.diagnostic)) {
    throw new Error(
      [
        `negative fixture diagnostic mismatch: ${fixture.id}`,
        `file: ${fixture.file}`,
        `expected diagnostic: ${fixture.diagnostic}`,
        "stderr:",
        result.stderr,
      ].join("\n"),
    );
  }
}

function findNode(document, kind, predicate = () => true) {
  for (const graph of document.execution_graphs) {
    for (const node of graph.nodes ?? []) {
      if (node.kind === kind && predicate(node)) {
        return node;
      }
    }
  }
  throw new Error(`node not found: ${kind}`);
}

function eventOf(trace, kind) {
  return trace.events.find((event) => event.kind === kind);
}

function eventsOf(trace, kind) {
  return trace.events.filter((event) => event.kind === kind);
}
