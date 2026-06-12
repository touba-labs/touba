import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const implementationRoot = resolve(fixtureRoot, "../..");
const projectFixtureRoot = join(fixtureRoot, "project");
const handlerFixturePath = join(fixtureRoot, "handlers/fetch_customer_profile.handler.mjs");
const leakyHandlerFixturePath = join(fixtureRoot, "handlers/fetch_customer_profile_leaky_error.handler.mjs");
const negativeRoot = join(fixtureRoot, "negative");
const projectCli = join(implementationRoot, "cli/touba-project/src/main.mjs");
const runCli = join(implementationRoot, "cli/touba-run/src/run.mjs");
const supplyChainCli = join(implementationRoot, "cli/touba-supply-chain/src/validate.mjs");
const inspectCli = join(implementationRoot, "cli/touba-inspect/src/inspect.mjs");

const TOOL_REF = "tool:org.example.customer/FetchCustomerProfile";
const ENTRY_REF = "strategy:examples.customer_review_app/RunCustomerReview";
const SECRET_VALUE = "team-scenario-secret";

const tmpRoot = mkdtempSync(join(tmpdir(), "touba-team-multi-equipe-"));

try {
  const positiveProject = materializeProject("positive");
  const prepareReport = preparePositive(positiveProject);
  assert.equal(prepareReport.status, "success");
  assert.deepEqual(prepareReport.tools, [TOOL_REF]);
  assert.equal(prepareReport.ownership.profile, "prod");
  assert.equal(prepareReport.ownership.active_gate_subjects.includes("supply_chain_lock"), true);

  const handlerPath = overwriteHandler(positiveProject);
  const lockPath = writeSupplyChainLock(positiveProject, handlerPath);
  const supplyChainReport = validateSupplyChain(positiveProject, lockPath);
  assert.equal(supplyChainReport.status, "ok");

  const inspectOutput = inspectWorkspace(positiveProject);
  assert.match(inspectOutput, /Availability graph/);
  assert.match(inspectOutput, /Authority graph/);
  assert.match(inspectOutput, /Responsibility graph/);
  assert.match(inspectOutput, /status=not_runtime_authority/);

  const traceText = runPositive(positiveProject);
  assertTrace(JSON.parse(traceText));
  assertNoSecretLeak(traceText);

  assertPrepareFailure("missing-review", "touba.ownership.missing-review.json", "ReviewGateMissing");
  assertPrepareFailure("missing-run-plan-owner", "touba.ownership.missing-run-plan-owner.json", "OwnershipMissing");
  assertPrepareFailure("unknown-reviewer", "touba.ownership.unknown-reviewer.json", "ReviewReviewerUnknown");
  assertPrepareFailure("rejected-review", "touba.ownership.rejected-review.json", "ReviewRejected");
  assertPrepareFailure("authority-field", "touba.ownership.authority-field.json", "OwnershipAuthorityFieldForbidden");
  assertResourceBindingFailure("missing-memory-grant", "touba.resources.missing-grant.json", "ResourceBindingGrantMissing");
  assertSupplyChainMissingHandlerEntry();
  assertHandlerSecretRedaction();
  assertSupplyChainDrift(positiveProject, handlerPath);

  console.log("team-multi-equipe: status=success scenario=customer_review checks=positive,review,owner,reviewer,rejected,authority,resource,lock,redaction,drift");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function materializeProject(label) {
  const projectRoot = join(tmpRoot, label);
  cpSync(projectFixtureRoot, projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, "node_modules/@touba"), { recursive: true });
  cpSync(
    join(implementationRoot, "runtime/touba-handler-sdk"),
    join(projectRoot, "node_modules/@touba/sdk"),
    { recursive: true },
  );
  return projectRoot;
}

function preparePositive(projectRoot) {
  const result = spawnSync(process.execPath, prepareArgs(projectRoot, {
    mode: "write",
    ownershipPath: "touba.ownership.json",
    resourceBindingsPath: "touba.resources.json",
  }), {
    cwd: implementationRoot,
    encoding: "utf8",
  });
  assertSuccess("prepare positive", result);
  return JSON.parse(result.stdout);
}

function assertPrepareFailure(label, ownershipFixture, expectedCode) {
  const projectRoot = materializeProject(label);
  cpSync(join(negativeRoot, ownershipFixture), join(projectRoot, "touba.ownership.json"));
  const result = spawnSync(process.execPath, prepareArgs(projectRoot, {
    mode: "check",
    ownershipPath: "touba.ownership.json",
    resourceBindingsPath: "touba.resources.json",
  }), {
    cwd: implementationRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, `${label} should fail`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === expectedCode), true, label);
  assertNoSecretLeak(result.stdout + result.stderr);
}

function assertResourceBindingFailure(label, resourceFixture, expectedCode) {
  const projectRoot = materializeProject(label);
  cpSync(join(negativeRoot, resourceFixture), join(projectRoot, "touba.resources.json"));
  const result = spawnSync(process.execPath, prepareArgs(projectRoot, {
    mode: "check",
    ownershipPath: "touba.ownership.json",
    resourceBindingsPath: "touba.resources.json",
  }), {
    cwd: implementationRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, `${label} should fail`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === expectedCode), true, label);
  assertNoSecretLeak(result.stdout + result.stderr);
}

function assertSupplyChainDrift(projectRoot, handlerPath) {
  appendFileSync(handlerPath, "\n// drift introduced by TEAM-1 scenario validation\n", "utf8");
  const result = spawnSync(process.execPath, [
    runCli,
    "--run-plan",
    join(projectRoot, "touba.run-plan.json"),
    "--resource-bindings",
    join(projectRoot, "touba.resources.json"),
    "--require-resource-bindings",
    "--inputs-json",
    JSON.stringify({
      request: {
        customer_id: "CUST-001",
      },
    }),
    "--output",
    "trace",
  ], {
    cwd: implementationRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CRM_API_TOKEN: SECRET_VALUE,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RunPlanSupplyChainDrift|HandlerChanged/);
  assertNoSecretLeak(result.stdout + result.stderr);
}

function prepareArgs(projectRoot, { mode, ownershipPath, resourceBindingsPath }) {
  return [
    projectCli,
    "prepare",
    "--root",
    projectRoot,
    "--source",
    "src/examples/customer_review_app.tb",
    "--package",
    "packages/customer/touba.package.json",
    "--resource-bindings",
    resourceBindingsPath,
    "--require-resource-bindings",
    "--run-plan",
    "touba.run-plan.json",
    "--entry",
    ENTRY_REF,
    "--ownership",
    ownershipPath,
    "--require-ownership",
    "--profile",
    "prod",
    "--handler-command",
    process.execPath,
    "--mode",
    mode,
    "--json",
  ];
}

function overwriteHandler(projectRoot) {
  const handlerPath = join(projectRoot, "handlers/org/example/customer/fetch_customer_profile.handler.mjs");
  cpSync(handlerFixturePath, handlerPath);
  return handlerPath;
}

function overwriteLeakyHandler(projectRoot) {
  const handlerPath = join(projectRoot, "handlers/org/example/customer/fetch_customer_profile.handler.mjs");
  cpSync(leakyHandlerFixturePath, handlerPath);
  return handlerPath;
}

function writeSupplyChainLock(projectRoot, handlerPath) {
  const airPath = join(projectRoot, ".touba/air/examples/customer_review_app.air.json");
  const manifestPath = join(projectRoot, "touba.manifest.json");
  const manifest = readJson(manifestPath);
  const binding = manifest.bindings[TOOL_REF];
  assert.ok(binding, "expected manifest binding");

  const lock = {
    lock_schema_version: "touba-lock-v0.1",
    lock_kind: "supply_chain",
    generated_at: "2026-06-05T00:00:00Z",
    generated_by: {
      tool: "touba validate:team-multi-equipe",
      version: "0.0.0",
    },
    air: {
      path: relative(projectRoot, airPath),
      digest: digestForFile(airPath),
    },
    manifest: {
      path: relative(projectRoot, manifestPath),
      digest: digestForFile(manifestPath),
    },
    handlers: [
      {
        tool_ref: TOOL_REF,
        path: relative(projectRoot, handlerPath),
        command: binding.handler.command,
        cwd: binding.handler.cwd ?? ".",
        args: binding.handler.args,
        digest: digestForFile(handlerPath),
        sdk: {
          name: "@touba/sdk",
          version: "0.0.0",
          protocol: "touba-tool-handler-v1",
          status: "ok",
        },
        handler_package: {
          kind: "local",
          name: "org.example.customer.handlers",
          version: "0.1.0",
          entrypoint: binding.handler.args[0],
        },
      },
    ],
  };
  const lockPath = join(projectRoot, "touba.lock.json");
  writeJson(lockPath, lock);
  return lockPath;
}

function validateSupplyChain(projectRoot, lockPath) {
  const result = spawnSync(process.execPath, [
    supplyChainCli,
    "--lock",
    lockPath,
    "--air",
    join(projectRoot, ".touba/air/examples/customer_review_app.air.json"),
    "--manifest",
    join(projectRoot, "touba.manifest.json"),
    "--output",
    "json",
    "--strict",
  ], {
    cwd: implementationRoot,
    encoding: "utf8",
  });
  assertSuccess("supply chain", result);
  return JSON.parse(result.stdout);
}

function assertSupplyChainMissingHandlerEntry() {
  const projectRoot = materializeProject("missing-lock-handler-entry");
  preparePositive(projectRoot);
  const handlerPath = overwriteHandler(projectRoot);
  const lockPath = writeSupplyChainLock(projectRoot, handlerPath);
  const lock = readJson(lockPath);
  lock.handlers = [];
  writeJson(lockPath, lock);

  const result = spawnSync(process.execPath, [
    supplyChainCli,
    "--lock",
    lockPath,
    "--air",
    join(projectRoot, ".touba/air/examples/customer_review_app.air.json"),
    "--manifest",
    join(projectRoot, "touba.manifest.json"),
    "--output",
    "json",
    "--strict",
  ], {
    cwd: implementationRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1, "missing lock handler entry should fail");
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "error");
  assert.equal(
    report.diagnostics.some((diagnostic) => diagnostic.code === "HandlerLockEntryMissing"),
    true,
    "expected HandlerLockEntryMissing",
  );
  assertNoSecretLeak(result.stdout + result.stderr);
}

function assertHandlerSecretRedaction() {
  const projectRoot = materializeProject("handler-secret-redaction");
  preparePositive(projectRoot);
  const handlerPath = overwriteLeakyHandler(projectRoot);
  writeSupplyChainLock(projectRoot, handlerPath);

  const result = spawnSync(process.execPath, [
    runCli,
    "--run-plan",
    join(projectRoot, "touba.run-plan.json"),
    "--resource-bindings",
    join(projectRoot, "touba.resources.json"),
    "--require-resource-bindings",
    "--inputs-json",
    JSON.stringify({
      request: {
        customer_id: "CUST-001",
      },
    }),
    "--output",
    "trace",
  ], {
    cwd: implementationRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CRM_API_TOKEN: SECRET_VALUE,
    },
  });

  assert.equal(result.status, 1, "leaky handler should fail");
  assert.match(result.stderr, /CrmBackendRejected|ToolHandler/);
  assertNoSecretLeak(result.stdout + result.stderr);
}

function inspectWorkspace(projectRoot) {
  const result = spawnSync(process.execPath, [
    inspectCli,
    "--air",
    join(projectRoot, ".touba/air/examples/customer_review_app.air.json"),
    "--manifest",
    join(projectRoot, "touba.manifest.json"),
    "--package",
    join(projectRoot, "packages/customer/touba.package.json"),
    "--resource-bindings",
    join(projectRoot, "touba.resources.json"),
    "--run-plan",
    join(projectRoot, "touba.run-plan.json"),
    "--ownership",
    join(projectRoot, "touba.ownership.json"),
  ], {
    cwd: implementationRoot,
    encoding: "utf8",
  });
  assertSuccess("inspect workspace", result);
  return result.stdout;
}

function runPositive(projectRoot) {
  const result = spawnSync(process.execPath, [
    runCli,
    "--run-plan",
    join(projectRoot, "touba.run-plan.json"),
    "--resource-bindings",
    join(projectRoot, "touba.resources.json"),
    "--require-resource-bindings",
    "--inputs-json",
    JSON.stringify({
      request: {
        customer_id: "CUST-001",
      },
    }),
    "--output",
    "trace",
  ], {
    cwd: implementationRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CRM_API_TOKEN: SECRET_VALUE,
    },
  });
  assertSuccess("run positive", result);
  return result.stdout;
}

function assertTrace(trace) {
  const completed = trace.events?.find((event) => event.kind === "run_completed");
  assert.equal(completed?.payload?.status, "success");

  const bindingEvent = trace.events.find((event) => event.kind === "tool_binding_authorized");
  assert.ok(bindingEvent, "expected tool_binding_authorized");
  assert.equal(bindingEvent.payload.tool_ref, TOOL_REF);
  assert.equal(bindingEvent.payload.granted_capabilities.includes("network"), true);
  assert.equal(bindingEvent.payload.granted_capabilities.includes("secret_read"), true);
  assert.equal(bindingEvent.payload.granted_capabilities.includes("memory_read"), true);
  assert.equal(bindingEvent.payload.secret_handles_used.includes("CRM_API_TOKEN"), true);
  assert.deepEqual(bindingEvent.payload.memory_accesses_required, [
    {
      memory_ref: "memory:org.example.customer/CustomerNotes",
      access: "read",
    },
  ]);
  assert.deepEqual(bindingEvent.payload.resource_bindings, [
    {
      resource_ref: "memory:org.example.customer/CustomerNotes",
      kind: "memory_backend",
      provider: "host.local.customer_notes",
    },
  ]);

  const memoryAuthorized = trace.events.find((event) => event.kind === "memory_access_authorized");
  assert.ok(memoryAuthorized, "expected memory_access_authorized");
  assert.equal(memoryAuthorized.payload.memory_ref, "memory:org.example.customer/CustomerNotes");

  const showEvent = trace.events.find((event) => event.kind === "user_interaction_shown");
  assert.equal(showEvent?.payload?.message, "Customer profile ready");
}

function assertNoSecretLeak(text) {
  assert.equal(String(text).includes(SECRET_VALUE), false, "resolved secret leaked");
}

function digestForFile(filePath) {
  return {
    kind: "sha256",
    value: crypto.createHash("sha256").update(readFileSync(filePath, "utf8"), "utf8").digest("hex"),
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
