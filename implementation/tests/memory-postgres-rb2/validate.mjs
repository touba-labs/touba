import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateManifestFromAirDocument } from "../../cli/touba-manifest/src/generate.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const composeFile = path.join(fixtureRoot, "docker/docker-compose.memory-postgres.yml");
const projectName = `touba-memory-postgres-rb2-${process.pid}`;
const hostPort = Number.parseInt(process.env.TOUBA_POSTGRES_MEMORY_API_PORT ?? "18788", 10);
const endpoint = `http://127.0.0.1:${hostPort}`;
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-memory-postgres-rb2-"));
const projectRoot = path.join(tmpRoot, "project");
const airPath = path.join(projectRoot, ".touba/air/memory-postgres-rb2.air.json");
const readOnlyAirPath = path.join(projectRoot, ".touba/air/memory-postgres-rb2-read-only.air.json");
const approvalAirPath = path.join(projectRoot, ".touba/air/memory-postgres-rb2-approval.air.json");
const triggerAirPath = path.join(projectRoot, ".touba/air/memory-postgres-rb2-trigger.air.json");
const mutatedAirPath = path.join(projectRoot, ".touba/air/memory-postgres-rb2-no-agent-scope.air.json");
const mutatedReadOnlyAirPath = path.join(projectRoot, ".touba/air/memory-postgres-rb2-read-only-no-agent-scope.air.json");
const manifestPath = path.join(projectRoot, "touba.manifest.json");
const resourceBindingsPath = path.join(projectRoot, "touba.resources.json");
const secretsPath = path.join(projectRoot, "touba.secrets.dev.json");
const tracePath = path.join(projectRoot, "run.trace.json");
const lockPath = path.join(projectRoot, "touba.lock.json");
const supplyChainReportPath = path.join(projectRoot, "touba.supply-chain-report.json");
const supplyChainCli = path.join(implementationRoot, "cli/touba-supply-chain/src/validate.mjs");
const cargo = process.env.CARGO ?? "cargo";
const secretValue = process.env.POSTGRES_MEMORY_TOKEN ?? "postgres-memory-token-secret";
const openAiLiveMode = process.argv.includes("--openai-live");
const dockerEnv = {
  ...process.env,
  POSTGRES_MEMORY_TOKEN: secretValue,
  TOUBA_POSTGRES_MEMORY_API_PORT: String(hostPort),
};

try {
  await dockerCompose(["up", "--build", "-d"]);
  await waitForHealth();

  materializeProject();
  compileSourceToAir("source/memory-postgres-rb2.tb", airPath);
  compileSourceToAir("source/memory-postgres-rb2-read-only.tb", readOnlyAirPath);
  compileSourceToAir("source/memory-postgres-rb2-approval-write.tb", approvalAirPath);
  compileSourceToAir("source/memory-postgres-rb2-trigger-write.tb", triggerAirPath);
  assertStaticMissingScopeDiagnostic();
  writeSecrets();

  materializeManifestFromAir(airPath);
  writeResourceBindings();
  const positive = await runAir({
    customerId: "ACME-PG-001",
    note: "PostgreSQL memory scope validated by Touba",
  });
  await assertPositiveRun(positive);

  await assertReadOnlyControls();
  await assertApprovalBeforeWrite();
  await assertBudgetBeforeWrite();
  await assertTriggerWrite();
  assertSupplyChainControls();
  if (openAiLiveMode) {
    await assertOpenAiDecisionProviderWithPostgres();
  }

  const missingBindingId = "ACME-PG-MISSING-BINDING";
  materializeManifestFromAir(airPath);
  writeResourceBindings();
  const missingBinding = await runAir({
    customerId: missingBindingId,
    note: "must not be persisted",
    omitResourceBindings: true,
    expectFailure: true,
  });
  assertFailure("ResourceBindingMissing", missingBinding);
  await assertNoPostgresNote(missingBindingId);

  const missingGrantId = "ACME-PG-MISSING-GRANT";
  writeResourceBindings({ grants: ["memory.read"] });
  const missingGrant = await runAir({
    customerId: missingGrantId,
    note: "must not be persisted",
    expectFailure: true,
  });
  assertFailure("ResourceBindingGrantMissing", missingGrant);
  await assertNoPostgresNote(missingGrantId);

  const missingManifestMemoryId = "ACME-PG-MISSING-MANIFEST-MEMORY";
  materializeManifestFromAir(airPath);
  removeManifestMemoryAccess("tool:examples.memory_postgres_rb2/WriteCustomerMemory", "write");
  writeResourceBindings();
  const missingManifestMemory = await runAir({
    customerId: missingManifestMemoryId,
    note: "must not be persisted",
    expectFailure: true,
  });
  assertFailure("MemoryNotGrantedToBinding", missingManifestMemory);
  await assertNoPostgresNote(missingManifestMemoryId);

  materializeManifestFromAir(airPath);
  writeResourceBindings();
  writeAirWithoutAgentMemoryScopes();
  const missingOwnerScopeId = "ACME-PG-MISSING-OWNER-SCOPE";
  const missingOwnerScope = await runAir({
    airFile: mutatedAirPath,
    customerId: missingOwnerScopeId,
    note: "must not be persisted",
    expectFailure: true,
  });
  assertFailure("MemoryNotGrantedToOwner", missingOwnerScope);
  assertTraceFailure("MemoryNotGrantedToOwner");
  await assertNoPostgresNote(missingOwnerScopeId);

  const checks = [
    "positive",
    "read_write_grants",
    "manifest_memory",
    "pi1",
    "approval",
    "budget",
    "trigger",
    "supply_chain",
    "missing_binding",
    "missing_grant",
    "missing_agent_scope",
  ];
  if (openAiLiveMode) {
    checks.push("openai_live");
  }
  console.log(`memory-postgres-rb2: status=success backend=postgres:17.10-alpine checks=${checks.join(",")}`);
} finally {
  await dockerCompose(["down", "-v"], { allowFailure: true });
  rmSync(tmpRoot, { recursive: true, force: true });
}

function materializeProject() {
  mkdirSync(path.join(projectRoot, "source"), { recursive: true });
  mkdirSync(path.join(projectRoot, "handlers"), { recursive: true });
  mkdirSync(path.join(projectRoot, ".touba/air"), { recursive: true });
  mkdirSync(path.join(projectRoot, "node_modules/@touba"), { recursive: true });
  cpSync(
    path.join(implementationRoot, "runtime/touba-handler-sdk"),
    path.join(projectRoot, "node_modules/@touba/sdk"),
    { recursive: true },
  );
  for (const file of [
    "memory-postgres-rb2.tb",
    "memory-postgres-rb2-read-only.tb",
    "memory-postgres-rb2-approval-write.tb",
    "memory-postgres-rb2-trigger-write.tb",
    "memory-postgres-rb2-missing-skill-scope.tb",
  ]) {
    cpSync(path.join(fixtureRoot, "source", file), path.join(projectRoot, "source", file));
  }
  cpSync(
    path.join(fixtureRoot, "handlers/write_customer_memory.handler.mjs"),
    path.join(projectRoot, "handlers/write_customer_memory.handler.mjs"),
  );
  cpSync(
    path.join(fixtureRoot, "handlers/read_customer_memory.handler.mjs"),
    path.join(projectRoot, "handlers/read_customer_memory.handler.mjs"),
  );
  cpSync(
    path.join(fixtureRoot, "handlers/read_customer_memory_pi.handler.mjs"),
    path.join(projectRoot, "handlers/read_customer_memory_pi.handler.mjs"),
  );
  cpSync(
    path.join(fixtureRoot, "handlers/write_trigger_memory.handler.mjs"),
    path.join(projectRoot, "handlers/write_trigger_memory.handler.mjs"),
  );
}

function compileSourceToAir(relativeSourcePath, outputPath, options = {}) {
  const compileResult = spawnSync(
    cargo,
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", path.join(projectRoot, relativeSourcePath)],
    {
      cwd: implementationRoot,
      encoding: "utf8",
    },
  );
  if (options.expectFailure === true) {
    if (compileResult.status === 0) {
      throw new Error(`expected compile failure for ${relativeSourcePath}`);
    }
    return compileResult;
  }
  assertSuccess(`compile ${relativeSourcePath}`, compileResult);
  writeFileSync(outputPath, compileResult.stdout, "utf8");
  return JSON.parse(compileResult.stdout);
}

function assertStaticMissingScopeDiagnostic() {
  const result = compileSourceToAir("source/memory-postgres-rb2-missing-skill-scope.tb", airPath, {
    expectFailure: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes("OwnerMemoryScopeMissing")) {
    throw new Error(`expected OwnerMemoryScopeMissing in static diagnostic\n${output}`);
  }
}

function materializeManifestFromAir(sourceAirPath, options = {}) {
  const airDocument = JSON.parse(readFileSync(sourceAirPath, "utf8"));
  const manifest = generateManifestFromAirDocument(airDocument, {
    handlerCommand: process.execPath,
    handlerRoot: "handlers",
    handlerCwd: ".",
    timeoutMs: 15000,
    maxPayloadBytes: 1048576,
  });

  setHandlerArgIfPresent(
    manifest,
    "tool:examples.memory_postgres_rb2/WriteCustomerMemory",
    "handlers/write_customer_memory.handler.mjs",
  );
  setHandlerArgIfPresent(
    manifest,
    "tool:examples.memory_postgres_rb2/ReadCustomerMemory",
    options.readHandler ?? "handlers/read_customer_memory.handler.mjs",
  );
  setHandlerArgIfPresent(
    manifest,
    "tool:examples.memory_postgres_rb2/WriteTriggerMemory",
    "handlers/write_trigger_memory.handler.mjs",
  );
  if (airDocument.definitions?.agents?.some((agent) => agent.id === "agent:examples.memory_postgres_rb2/MemoryAgent")) {
    manifest.agent_secret_scopes = {
      "agent:examples.memory_postgres_rb2/MemoryAgent": ["POSTGRES_MEMORY_TOKEN"],
    };
  }
  if (airDocument.definitions?.triggers?.some((trigger) => trigger.id === "trigger:examples.memory_postgres_rb2/ScheduledMemoryWrite")) {
    manifest.triggers = {
      "trigger:examples.memory_postgres_rb2/ScheduledMemoryWrite": {
        enabled: true,
        source: {
          kind: "schedule",
          timezone: "America/Montreal",
        },
        limits: {
          max_runs_per_day: 1,
          timeout_ms: 30000,
        },
      },
    };
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function setHandlerArgIfPresent(manifest, toolRef, handlerPath) {
  if (manifest.bindings?.[toolRef]) {
    manifest.bindings[toolRef].handler.args = [handlerPath];
  }
}

function writeSecrets() {
  writeFileSync(
    secretsPath,
    `${JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        POSTGRES_MEMORY_TOKEN: {
          source: "env",
          name: "POSTGRES_MEMORY_TOKEN",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeResourceBindings(options = {}) {
  const resources = {
    "memory:examples.memory_postgres_rb2/CustomerMemory": {
      kind: "memory_backend",
      provider: "host.postgres.memory_api",
      config: {
        endpoint_url: endpoint,
      },
      grants: options.grants ?? ["memory.read", "memory.write"],
      secrets: ["POSTGRES_MEMORY_TOKEN"],
      required_secrets: ["POSTGRES_MEMORY_TOKEN"],
      limits: {
        max_payload_bytes: 65536,
      },
    },
  };
  if (options.includeTrigger === true) {
    resources["trigger:examples.memory_postgres_rb2/ScheduledMemoryWrite"] = {
      kind: "event_source",
      provider: "host.schedule.foreground",
      config: {
        schedule: "every 1s",
      },
      grants: ["trigger.run"],
      limits: {
        max_payload_bytes: 1024,
      },
    };
  }
  writeFileSync(
    resourceBindingsPath,
    `${JSON.stringify({
      resource_bindings_schema_version: "touba-resource-bindings-v0.1",
      resources,
    }, null, 2)}\n`,
    "utf8",
  );
}

function removeManifestMemoryAccess(toolRef, access) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const binding = manifest.bindings?.[toolRef];
  if (!binding) {
    throw new Error(`manifest binding ${toolRef} not found`);
  }
  binding.memories = (binding.memories ?? []).filter((entry) => entry.access !== access);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function writeAirWithoutAgentMemoryScopes(sourceAirPath = airPath, outputPath = mutatedAirPath) {
  const document = JSON.parse(readFileSync(sourceAirPath, "utf8"));
  const agent = document.definitions?.agents?.find(
    (candidate) => candidate.id === "agent:examples.memory_postgres_rb2/MemoryAgent",
  );
  if (!agent) {
    throw new Error("MemoryAgent not found in AIR");
  }
  agent.memory_scopes = [];
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

async function runAir(options) {
  const args = [
    path.join(implementationRoot, "cli/touba-run/src/run.mjs"),
    options.airFile ?? airPath,
    "--manifest",
    manifestPath,
    "--secrets",
    secretsPath,
    "--output",
    options.output ?? "result",
    "--trace-out",
    tracePath,
  ];
  if (options.inputs !== undefined || options.customerId !== undefined) {
    args.push(
      "--inputs-json",
      JSON.stringify(options.inputs ?? {
        request: {
          customer_id: options.customerId,
          note: options.note,
        },
      }),
    );
  }
  if (options.agentDecisionProvider !== false) {
    args.push(
      "--agent-decision-provider",
      options.agentDecisionProviderPath ?? path.join(fixtureRoot, "providers/postgres-memory.provider.mjs"),
    );
  }
  if (options.omitResourceBindings !== true) {
    args.push("--resource-bindings", resourceBindingsPath);
  }
  if (options.requireResourceBindings !== false) {
    args.push("--require-resource-bindings");
  }
  if (options.humanDecisions) {
    args.push("--human-decisions-json", JSON.stringify(options.humanDecisions));
  }
  if (options.maxToolCalls !== undefined) {
    args.push("--max-tool-calls", String(options.maxToolCalls));
  }
  if (options.maxSteps !== undefined) {
    args.push("--max-steps", String(options.maxSteps));
  }
  if (options.triggerRef) {
    args.push("--trigger", options.triggerRef, "--max-runs", String(options.maxRuns ?? 1));
  }
  if (options.entryRef) {
    args.push("--entry", options.entryRef);
  }

  const runResult = await runProcess(process.execPath, args, {
    cwd: implementationRoot,
    env: {
      ...process.env,
      POSTGRES_MEMORY_TOKEN: secretValue,
    },
  });

  if (options.expectFailure === true) {
    if (runResult.status === 0) {
      throw new Error("expected Touba run failure");
    }
    return runResult;
  }
  assertSuccess("run", runResult);
  if (options.output === "trace") {
    return JSON.parse(runResult.stdout);
  }
  return {
    result: JSON.parse(runResult.stdout),
    trace: JSON.parse(readFileSync(tracePath, "utf8")),
  };
}

async function assertPositiveRun(run) {
  if (run.result?.customer_id !== "ACME-PG-001") {
    throw new Error(`unexpected customer_id ${run.result?.customer_id}`);
  }
  if (run.result?.stored_note !== "PostgreSQL memory scope validated by Touba") {
    throw new Error(`unexpected stored_note ${run.result?.stored_note}`);
  }
  if (run.result?.backend !== "postgres") {
    throw new Error(`unexpected backend ${run.result?.backend}`);
  }
  const persisted = await fetchPostgresNote("ACME-PG-001");
  if (persisted.stored_note !== run.result.stored_note) {
    throw new Error("PostgreSQL did not persist the note returned by Touba");
  }

  const traceText = JSON.stringify(run.trace);
  for (const forbidden of [secretValue, endpoint, "touba_memory_password"]) {
    if (traceText.includes(forbidden)) {
      throw new Error(`trace leaked forbidden backend detail ${forbidden}`);
    }
  }

  const authorized = event(run.trace, "agent_invocation_authorized");
  if (authorized.payload.agent_ref !== "agent:examples.memory_postgres_rb2/MemoryAgent") {
    throw new Error(`unexpected authorized agent ${authorized.payload.agent_ref}`);
  }
  const selected = event(run.trace, "agent_capability_selected");
  if (selected.payload.selected_ref !== "skill:examples.memory_postgres_rb2/StoreAndReadCustomerMemory") {
    throw new Error(`unexpected selected capability ${selected.payload.selected_ref}`);
  }

  const bindingEvents = run.trace.events.filter((item) => item.kind === "tool_binding_authorized");
  if (bindingEvents.length !== 2) {
    throw new Error(`expected two tool_binding_authorized events, got ${bindingEvents.length}`);
  }
  for (const item of bindingEvents) {
    if (item.payload.agent_ref !== "agent:examples.memory_postgres_rb2/MemoryAgent") {
      throw new Error(`expected active agent_ref on tool binding, got ${item.payload.agent_ref}`);
    }
    const bindings = item.payload.resource_bindings;
    if (!Array.isArray(bindings) || bindings.length !== 1) {
      throw new Error("expected one transmitted resource binding per tool");
    }
    if (bindings[0].provider !== "host.postgres.memory_api") {
      throw new Error(`unexpected resource provider ${bindings[0].provider}`);
    }
    if (JSON.stringify(bindings).includes("endpoint_url")) {
      throw new Error("trace must not include endpoint_url from resource binding config");
    }
  }

  const accesses = run.trace.events
    .filter((item) => item.kind === "memory_access_authorized")
    .map((item) => `${item.payload.owner_ref}:${item.payload.access}`)
    .sort();
  const expected = [
    "agent:examples.memory_postgres_rb2/MemoryAgent:read",
    "agent:examples.memory_postgres_rb2/MemoryAgent:write",
  ];
  if (JSON.stringify(accesses) !== JSON.stringify(expected)) {
    throw new Error(`unexpected memory access authority ${JSON.stringify(accesses)}`);
  }
  const completed = event(run.trace, "run_completed");
  if (completed.payload.status !== "success") {
    throw new Error(`unexpected run status ${completed.payload.status}`);
  }
}

async function assertReadOnlyControls() {
  materializeManifestFromAir(readOnlyAirPath, {
    readHandler: "handlers/read_customer_memory_pi.handler.mjs",
  });
  writeResourceBindings();
  const readOnly = await runAir({
    airFile: readOnlyAirPath,
    customerId: "ACME-PG-001",
    note: "unused for read",
  });
  if (readOnly.result?.stored_note !== "PostgreSQL memory scope validated by Touba") {
    throw new Error("read-only path did not read the PostgreSQL note written by the positive path");
  }
  assertPi1Trace(readOnly.trace);

  writeResourceBindings({ grants: ["memory.write"] });
  const missingReadGrant = await runAir({
    airFile: readOnlyAirPath,
    customerId: "ACME-PG-001",
    note: "unused for refused read",
    expectFailure: true,
  });
  assertFailure("ResourceBindingGrantMissing", missingReadGrant);

  materializeManifestFromAir(readOnlyAirPath);
  removeManifestMemoryAccess("tool:examples.memory_postgres_rb2/ReadCustomerMemory", "read");
  writeResourceBindings();
  const missingReadManifestMemory = await runAir({
    airFile: readOnlyAirPath,
    customerId: "ACME-PG-001",
    note: "unused for refused read",
    expectFailure: true,
  });
  assertFailure("MemoryNotGrantedToBinding", missingReadManifestMemory);

  materializeManifestFromAir(readOnlyAirPath);
  writeResourceBindings();
  writeAirWithoutAgentMemoryScopes(readOnlyAirPath, mutatedReadOnlyAirPath);
  const missingReadOwnerScope = await runAir({
    airFile: mutatedReadOnlyAirPath,
    customerId: "ACME-PG-001",
    note: "unused for refused read",
    expectFailure: true,
  });
  assertFailure("MemoryNotGrantedToOwner", missingReadOwnerScope);
}

function assertPi1Trace(trace) {
  const provenance = event(trace, "memory_provenance_observed");
  if (provenance.payload.operation !== "read" || provenance.payload.memory_ref !== "memory:examples.memory_postgres_rb2/CustomerMemory") {
    throw new Error("expected PI-1 read provenance for CustomerMemory");
  }
  const integrity = event(trace, "memory_integrity_observed");
  if (integrity.payload.integrity_evidence !== "digest_reported" || integrity.payload.digest_kind !== "sha256") {
    throw new Error("expected PI-1 digest evidence");
  }
  const traceText = JSON.stringify(trace);
  for (const forbidden of [secretValue, endpoint, "touba_memory_password", "PostgreSQL memory scope validated by Touba"]) {
    if (traceText.includes(forbidden)) {
      throw new Error(`PI-1 trace leaked forbidden content ${forbidden}`);
    }
  }
}

async function assertApprovalBeforeWrite() {
  materializeManifestFromAir(approvalAirPath);
  writeResourceBindings();
  const pauseTrace = await runAir({
    airFile: approvalAirPath,
    customerId: "ACME-PG-APPROVAL-PAUSE",
    note: "must wait for approval",
    output: "trace",
  });
  const paused = event(pauseTrace, "human_approval_paused");
  await assertNoPostgresNote("ACME-PG-APPROVAL-PAUSE");

  const rejectedTrace = await runAir({
    airFile: approvalAirPath,
    customerId: "ACME-PG-APPROVAL-REJECTED",
    note: "must not be persisted after rejection",
    humanDecisions: {
      [paused.payload.approval_ref]: "rejected",
    },
    output: "trace",
  });
  event(rejectedTrace, "human_approval_rejected");
  if (rejectedTrace.events.some((item) => item.kind === "tool_binding_authorized")) {
    throw new Error("rejected approval must not reach tool binding authorization");
  }
  await assertNoPostgresNote("ACME-PG-APPROVAL-REJECTED");
}

async function assertBudgetBeforeWrite() {
  materializeManifestFromAir(airPath);
  writeResourceBindings();
  const budgetId = "ACME-PG-BUDGET-REFUSED";
  const budgetRefused = await runAir({
    customerId: budgetId,
    note: "must not be persisted after budget refusal",
    maxSteps: 1,
    expectFailure: true,
  });
  assertFailure("StepBudgetExceeded", budgetRefused);
  await assertNoPostgresNote(budgetId);
}

async function assertTriggerWrite() {
  materializeManifestFromAir(triggerAirPath);
  writeResourceBindings({ includeTrigger: true });
  const triggerRun = await runAir({
    airFile: triggerAirPath,
    agentDecisionProvider: false,
    inputs: {},
    triggerRef: "trigger:examples.memory_postgres_rb2/ScheduledMemoryWrite",
    output: "trace",
  });
  if (event(triggerRun, "trigger_execution_completed").payload.status !== "success") {
    throw new Error("trigger execution did not complete successfully");
  }
  const persisted = await fetchPostgresNote("ACME-PG-TRIGGER");
  if (persisted.stored_note !== "Triggered PostgreSQL memory write") {
    throw new Error("trigger did not persist the expected PostgreSQL note");
  }
}

function assertSupplyChainControls() {
  materializeManifestFromAir(airPath);
  writeSupplyChainLock([
    "handlers/write_customer_memory.handler.mjs",
    "handlers/read_customer_memory.handler.mjs",
  ]);
  const report = validateSupplyChain();
  if (report.status !== "ok") {
    throw new Error(`expected supply chain status ok, got ${report.status}`);
  }

  const handlerPath = path.join(projectRoot, "handlers/write_customer_memory.handler.mjs");
  writeFileSync(handlerPath, `${readFileSync(handlerPath, "utf8")}\n// drift for SC-1 negative check\n`, "utf8");
  const drift = validateSupplyChain({ expectFailure: true });
  if (!drift.diagnostics?.some((diagnostic) => diagnostic.code === "HandlerChanged")) {
    throw new Error("expected HandlerChanged after handler drift");
  }
  cpSync(
    path.join(fixtureRoot, "handlers/write_customer_memory.handler.mjs"),
    handlerPath,
  );
}

async function assertOpenAiDecisionProviderWithPostgres() {
  if (!process.env.TOUBA_AGENT_DECISION_OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error("TOUBA_AGENT_DECISION_OPENAI_API_KEY or OPENAI_API_KEY is required for --openai-live");
  }
  materializeManifestFromAir(airPath);
  writeResourceBindings();
  const run = await runAir({
    customerId: "ACME-PG-OPENAI",
    note: "OpenAI selected a governed PostgreSQL memory capability",
    agentDecisionProviderPath: path.join(fixtureRoot, "providers/postgres-memory-openai.provider.mjs"),
  });
  if (run.result?.stored_note !== "OpenAI selected a governed PostgreSQL memory capability") {
    throw new Error("OpenAI live path did not complete the governed PostgreSQL memory operation");
  }
  const decisions = run.trace.events.filter((item) => item.kind === "agent_decision_recorded");
  if (!decisions.some((item) => item.payload.source === "openai_structured_output")) {
    throw new Error("expected an OpenAI structured decision in the trace");
  }
}

function writeSupplyChainLock(handlerPaths) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lock = {
    lock_schema_version: "touba-lock-v0.1",
    lock_kind: "supply_chain",
    generated_at: "2026-06-05T00:00:00Z",
    generated_by: {
      tool: "touba validate:memory-postgres-rb2",
      version: "0.1.0",
    },
    air: {
      path: path.relative(projectRoot, airPath),
      digest: digestForFile(airPath),
    },
    manifest: {
      path: path.relative(projectRoot, manifestPath),
      digest: digestForFile(manifestPath),
    },
    handlers: handlerPaths.map((handlerPath) => {
      const absoluteHandlerPath = path.join(projectRoot, handlerPath);
      const binding = Object.entries(manifest.bindings)
        .find(([, candidate]) => candidate.handler?.args?.[0] === handlerPath);
      if (!binding) {
        throw new Error(`missing manifest binding for ${handlerPath}`);
      }
      return {
        tool_ref: binding[0],
        path: handlerPath,
        command: binding[1].handler.command,
        cwd: binding[1].handler.cwd ?? ".",
        args: binding[1].handler.args,
        digest: digestForFile(absoluteHandlerPath),
        sdk: {
          name: "@touba/sdk",
          version: "0.1.0",
          protocol: "touba-tool-handler-v1",
          status: "ok",
        },
        handler_package: {
          kind: "local",
          name: "examples.memory-postgres.handlers",
          version: "0.1.0",
          entrypoint: handlerPath,
        },
      };
    }),
  };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

function validateSupplyChain(options = {}) {
  const result = spawnSync(process.execPath, [
    supplyChainCli,
    "--lock",
    lockPath,
    "--air",
    airPath,
    "--manifest",
    manifestPath,
    "--output",
    "json",
    "--strict",
  ], {
    cwd: implementationRoot,
    encoding: "utf8",
  });
  if (options.expectFailure === true) {
    if (result.status === 0) {
      throw new Error("expected supply chain validation failure");
    }
  } else {
    assertSuccess("supply chain", result);
  }
  if (result.stdout.includes(secretValue)) {
    throw new Error("supply chain report leaked secret value");
  }
  writeFileSync(supplyChainReportPath, result.stdout, "utf8");
  return JSON.parse(result.stdout);
}

function digestForFile(filePath) {
  return {
    kind: "sha256",
    value: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
  };
}

function assertTraceFailure(expectedCode) {
  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  const failure = event(trace, "failure_detected");
  if (failure.payload.runtime_error_code !== expectedCode) {
    throw new Error(`expected ${expectedCode}, got ${failure.payload.runtime_error_code}`);
  }
  const refused = event(trace, "memory_access_refused");
  if (refused.payload.reason !== "owner_scope_missing") {
    throw new Error(`unexpected refusal reason ${refused.payload.reason}`);
  }
  const completed = event(trace, "run_completed");
  if (completed.payload.status !== "failure") {
    throw new Error(`unexpected failed run status ${completed.payload.status}`);
  }
}

async function fetchPostgresNote(customerId) {
  const response = await fetch(`${endpoint}/notes/${encodeURIComponent(customerId)}`, {
    headers: {
      authorization: `Bearer ${secretValue}`,
    },
  });
  if (!response.ok) {
    throw new Error(`expected persisted note ${customerId}, got HTTP ${response.status}`);
  }
  return response.json();
}

async function assertNoPostgresNote(customerId) {
  const response = await fetch(`${endpoint}/notes/${encodeURIComponent(customerId)}`, {
    headers: {
      authorization: `Bearer ${secretValue}`,
    },
  });
  if (response.status !== 404) {
    throw new Error(`expected no PostgreSQL note for ${customerId}, got HTTP ${response.status}`);
  }
}

async function dockerCompose(args, options = {}) {
  const result = await runProcess("docker", [
    "compose",
    "-f",
    composeFile,
    "-p",
    projectName,
    ...args,
  ], {
    cwd: fixtureRoot,
    env: dockerEnv,
  });
  if (options.allowFailure !== true) {
    assertSuccess(`docker compose ${args.join(" ")}`, result);
  }
  return result;
}

async function waitForHealth() {
  const deadline = Date.now() + 60000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.backend === "postgres") {
          return;
        }
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`PostgreSQL memory API healthcheck failed: ${lastError}`);
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function assertFailure(code, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(code)) {
    throw new Error(`expected ${code} in failure output\n${output}`);
  }
  if (output.includes(secretValue)) {
    throw new Error(`${code} failure leaked secret value`);
  }
}

function event(trace, kind) {
  const found = trace.events?.find((candidate) => candidate.kind === kind);
  if (!found) {
    throw new Error(`expected trace event ${kind}`);
  }
  return found;
}

function assertSuccess(label, result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}
