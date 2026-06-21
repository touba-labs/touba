import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  loadAirFromJson,
  executeAirDocument,
  executeTriggerEvent,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
  ToubaRuntimeError,
} from "@touba/runtime";
import {
  loadSupplyChainArtifacts,
  renderSupplyChainValidation,
  validateSupplyChainArtifacts,
} from "@touba/supply-chain";
import {
  buildLocalToolHandlers,
  LINEAR_FETCH_SOURCE_TOOL_REF,
  STRATEGY_APPLY_CHANGE_TOOL_REF,
} from "./local-handlers.mjs";

const args = process.argv.slice(2);
const RUN_PLAN_SCHEMA_VERSION = "touba-run-plan-v0.1";
const RUN_EVIDENCE_SCHEMA_VERSION = "touba-run-evidence-v0.1";
const BINDING_FRAGMENT_SCHEMA_VERSION = "touba-binding-fragment-v0.1";
const RESOURCE_BINDINGS_SCHEMA_VERSION = "touba-resource-bindings-v0.1";
const TRIGGER_STATE_SCHEMA_VERSION = "touba-trigger-state-v0.1";
const RESOURCE_BINDING_KINDS = new Set(["memory_backend", "event_source", "decision_provider"]);
const RUN_LIMIT_KEYS = new Set([
  "max_run_ms",
  "timeout_ms",
  "max_steps",
  "max_tool_calls",
  "max_agent_invocations",
  "max_provider_calls",
]);
const RESOURCE_BINDING_KIND_PREFIX = Object.freeze({
  memory_backend: "memory:",
  event_source: "trigger:",
  decision_provider: "agent:",
});
const RESOURCE_BINDING_PAYLOAD_FORBIDDEN_FIELDS = new Set([
  "api_key",
  "connection_string",
  "database_url",
  "dsn",
  "payload",
  "payload_raw",
  "raw_payload",
  "secret_value",
  "secret_values",
  "token",
  "value",
]);
const RUN_PLAN_FORBIDDEN_FIELDS = new Set([
  "input",
  "inputs",
  "inputs_json",
  "payload",
  "prompt",
  "prompts",
  "secret",
  "secret_value",
  "secret_values",
  "secrets",
]);

class RunPlanCliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class ResourceBindingsCliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const parsedArgs = parseArgs(args);

if (parsedArgs.error) {
  process.stderr.write(`error: ${parsedArgs.error}\n`);
  printUsage();
  process.exit(2);
}

if (parsedArgs.runPlanPath !== undefined) {
  try {
    const runPlan = loadRunPlanFromPath(parsedArgs.runPlanPath);
    applyRunPlan(parsedArgs, runPlan);
  } catch (e) {
    process.stderr.write(`run plan error [${e.code ?? "RunPlanInvalid"}]: ${e.message}\n`);
    process.exit(1);
  }
}

const parsedArgsError = validateParsedArgsAfterRunPlan(parsedArgs);
if (parsedArgsError) {
  if (typeof parsedArgsError === "object") {
    process.stderr.write(`run plan error [${parsedArgsError.code}]: ${parsedArgsError.message}\n`);
    process.exit(1);
  } else {
    process.stderr.write(`error: ${parsedArgsError}\n`);
    printUsage();
    process.exit(2);
  }
}

if (parsedArgs.positional.length !== 1) {
  printUsage();
  process.exit(2);
}

const filePath = parsedArgs.positional[0];
let json;
try {
  json = readFileSync(filePath, "utf8");
} catch (e) {
  process.stderr.write(`error: cannot read ${filePath}: ${e.message}\n`);
  process.exit(2);
}

let document;
try {
  document = loadAirFromJson(json);
} catch (e) {
  process.stderr.write(`error: invalid AIR JSON: ${e.message}\n`);
  process.exit(1);
}

if (parsedArgs.runPlanPath !== undefined) {
  try {
    validateRunPlanAgainstAir(parsedArgs, document, filePath);
  } catch (e) {
    process.stderr.write(`run plan error [${e.code ?? "RunPlanInvalid"}]: ${e.message}\n`);
    process.exit(1);
  }
}

let resourceBindings;
if (parsedArgs.resourceBindingsPath !== undefined || parsedArgs.requireResourceBindings) {
  try {
    resourceBindings = validateResourceBindingsForAir({
      resourceBindingsPath: parsedArgs.resourceBindingsPath,
      requireAll: parsedArgs.requireResourceBindings,
      document,
    });
  } catch (e) {
    process.stderr.write(`resource bindings error [${e.code ?? "ResourceBindingsInvalid"}]: ${e.message}\n`);
    process.exit(1);
  }
}

const localHandlerOptions = {};
if (parsedArgs.localFetchSourceText !== undefined) {
  localHandlerOptions.linearSourceText = parsedArgs.localFetchSourceText;
}
if (parsedArgs.localApplyChangeSummary !== undefined) {
  localHandlerOptions.changeSummary = parsedArgs.localApplyChangeSummary;
}

const toolHandlers = parsedArgs.stubs
  ? buildStubHandlers(document)
  : buildLocalToolHandlers(localHandlerOptions);

let toolBindingManifest;
if (parsedArgs.manifestPath !== undefined) {
  try {
    toolBindingManifest = loadManifestFromPath(parsedArgs.manifestPath);
  } catch (e) {
    process.stderr.write(`error: invalid manifest ${parsedArgs.manifestPath}: ${e.message}\n`);
    process.exit(1);
  }
}

if (parsedArgs.supplyChainLockPath !== undefined) {
  const supplyChainGate = validateSupplyChainGate({
    lockPath: parsedArgs.supplyChainLockPath,
    airPath: filePath,
    manifestPath: parsedArgs.manifestPath,
    requireLock: parsedArgs.requireSupplyChainLock,
  });
  if (!supplyChainGate.accepted) {
    if (parsedArgs.runPlanPath !== undefined) {
      supplyChainGate.code = "RunPlanSupplyChainDrift";
    }
    process.stderr.write(formatSupplyChainGateError(supplyChainGate));
    process.exit(1);
  }
}

let secretStore;
if (parsedArgs.secretsPath !== undefined) {
  try {
    secretStore = loadSecretsFromPath(parsedArgs.secretsPath);
  } catch (e) {
    process.stderr.write(`error: invalid secrets file ${parsedArgs.secretsPath}: ${e.message}\n`);
    process.exit(1);
  }
}

let inputs = {};
if (parsedArgs.inputsJson !== undefined) {
  try {
    inputs = JSON.parse(parsedArgs.inputsJson);
  } catch (e) {
    process.stderr.write(`error: invalid --inputs-json: ${e.message}\n`);
    process.exit(2);
  }
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    process.stderr.write("error: --inputs-json must decode to a JSON object\n");
    process.exit(2);
  }
}

let humanApprovalDecisions = {};
if (parsedArgs.humanDecisionsPath !== undefined) {
  try {
    humanApprovalDecisions = parseJsonObject(
      readFileSync(parsedArgs.humanDecisionsPath, "utf8"),
      `human decisions file ${parsedArgs.humanDecisionsPath}`,
    );
  } catch (e) {
    process.stderr.write(`error: invalid human decisions ${parsedArgs.humanDecisionsPath}: ${e.message}\n`);
    process.exit(1);
  }
}
if (parsedArgs.humanDecisionsJson !== undefined) {
  try {
    humanApprovalDecisions = parseJsonObject(parsedArgs.humanDecisionsJson, "--human-decisions-json");
  } catch (e) {
    process.stderr.write(`error: invalid --human-decisions-json: ${e.message}\n`);
    process.exit(2);
  }
}

let humanApprovalResumeCheckpoint;
if (parsedArgs.humanResumeCheckpointPath !== undefined) {
  try {
    humanApprovalResumeCheckpoint = parseJsonObject(
      readFileSync(parsedArgs.humanResumeCheckpointPath, "utf8"),
      `human resume checkpoint ${parsedArgs.humanResumeCheckpointPath}`,
    );
  } catch (e) {
    process.stderr.write(`error: invalid human resume checkpoint ${parsedArgs.humanResumeCheckpointPath}: ${e.message}\n`);
    process.exit(1);
  }
}

let userInputs = {};
if (parsedArgs.userInputsPath !== undefined) {
  try {
    userInputs = parseJsonObject(
      readFileSync(parsedArgs.userInputsPath, "utf8"),
      `user inputs file ${parsedArgs.userInputsPath}`,
    );
  } catch (e) {
    process.stderr.write(`error: invalid user inputs ${parsedArgs.userInputsPath}: ${e.message}\n`);
    process.exit(1);
  }
}
if (parsedArgs.userInputsJson !== undefined) {
  try {
    userInputs = parseJsonObject(parsedArgs.userInputsJson, "--user-inputs-json");
  } catch (e) {
    process.stderr.write(`error: invalid --user-inputs-json: ${e.message}\n`);
    process.exit(2);
  }
}

let agentDecisions = {};
if (parsedArgs.agentDecisionsPath !== undefined) {
  try {
    agentDecisions = parseJsonObject(
      readFileSync(parsedArgs.agentDecisionsPath, "utf8"),
      `agent decisions file ${parsedArgs.agentDecisionsPath}`,
    );
  } catch (e) {
    process.stderr.write(`error: invalid agent decisions ${parsedArgs.agentDecisionsPath}: ${e.message}\n`);
    process.exit(1);
  }
}
if (parsedArgs.agentDecisionsJson !== undefined) {
  try {
    agentDecisions = parseJsonObject(parsedArgs.agentDecisionsJson, "--agent-decisions-json");
  } catch (e) {
    process.stderr.write(`error: invalid --agent-decisions-json: ${e.message}\n`);
    process.exit(2);
  }
}

let agentDecisionProvider;
if (parsedArgs.agentDecisionProviderPath !== undefined) {
  try {
    agentDecisionProvider = await loadAgentDecisionProviderFromPath(parsedArgs.agentDecisionProviderPath);
  } catch (e) {
    process.stderr.write(`error: invalid agent decision provider ${parsedArgs.agentDecisionProviderPath}: ${e.message}\n`);
    process.exit(1);
  }
}

let triggerEvent;
if (parsedArgs.triggerEventPath !== undefined) {
  try {
    triggerEvent = parseJsonObject(
      readFileSync(parsedArgs.triggerEventPath, "utf8"),
      `trigger event file ${parsedArgs.triggerEventPath}`,
    );
  } catch (e) {
    process.stderr.write(`error: invalid trigger event ${parsedArgs.triggerEventPath}: ${e.message}\n`);
    process.exit(1);
  }
}
if (parsedArgs.triggerEventJson !== undefined) {
  try {
    triggerEvent = parseJsonObject(parsedArgs.triggerEventJson, "--trigger-event-json");
  } catch (e) {
    process.stderr.write(`error: invalid --trigger-event-json: ${e.message}\n`);
    process.exit(2);
  }
}

if (parsedArgs.triggerDryRun) {
  const report = dryRunTriggerEvent(document, triggerEvent, toolBindingManifest);
  process.stdout.write(serializeJson(report));
  process.exit(report.status === "accepted" ? 0 : 1);
}

let triggerState;
if (parsedArgs.triggerStatePath !== undefined) {
  try {
    triggerState = loadTriggerStateFromPath(parsedArgs.triggerStatePath);
  } catch (e) {
    process.stderr.write(`trigger state error [${e.code ?? "TriggerStateInvalid"}]: ${e.message}\n`);
    process.exit(1);
  }
}

let result;
const interactiveUserInputSession = parsedArgs.interactiveUserInputs
  ? createInteractiveUserInputSession()
  : null;
try {
  const executionOptions = {
    inputs,
    toolHandlers,
    toolBindingManifest,
    resourceBindings,
    secretStore,
    humanApprovalDecisions,
    userInputs,
    userInputProvider: interactiveUserInputSession?.provider,
    agentDecisions,
    agentDecisionProvider,
    agentDecisionProviderMetadata: parsedArgs.agentDecisionProviderMetadata,
    agentDecisionProviderContentMode: parsedArgs.agentDecisionProviderContentMode,
    agentDecisionProviderInitialMode: parsedArgs.agentDecisionProviderInitialMode,
    agentDecisionProviderTimeoutMs: parsedArgs.agentDecisionProviderTimeoutMs,
    agentDecisionProviderMaxRetries: parsedArgs.agentDecisionProviderMaxRetries,
    maxAgentSteps: parsedArgs.maxAgentSteps,
    runTimeoutMs: parsedArgs.runTimeoutMs,
    runLimits: parsedArgs.runLimits,
    cancelRequested: parsedArgs.cancelBeforeDispatch,
    cancelAuthoritySource: parsedArgs.cancelBeforeDispatch ? "cli" : undefined,
    cancelOnPause: parsedArgs.cancelOnPause,
    killSwitchEnabled: parsedArgs.killSwitchEnabled,
    durableHumanApprovals: parsedArgs.humanCheckpointOutPath !== undefined,
    humanApprovalResumeCheckpoint,
  };
  result = parsedArgs.triggerRef
    ? await runTriggerScheduleRunner(document, parsedArgs, executionOptions, triggerState)
    : triggerEvent
    ? await executeTriggerEventWithState(document, triggerEvent, executionOptions, triggerState)
    : await executeAirDocument(document, {
      ...executionOptions,
      entryRef: parsedArgs.entryRef,
    });
} catch (e) {
  if (e instanceof ToubaRuntimeError) {
    process.stderr.write(formatRuntimeError(e));
  } else {
    process.stderr.write(`unexpected error: ${e.message}\n`);
  }
  interactiveUserInputSession?.close();
  process.exit(1);
} finally {
  interactiveUserInputSession?.close();
}

if (result.status === "failure") {
  const diagnostic =
    formatBudgetTraceDiagnostic(result.trace)
    || formatFailureTraceDiagnostic(result.trace)
    || formatTriggerTraceDiagnostic(result.trace);
  if (diagnostic) {
    process.stderr.write(diagnostic);
  }
}

if (parsedArgs.traceOutPath !== undefined) {
  try {
    writeFileSync(parsedArgs.traceOutPath, serializeJson(result.trace), "utf8");
  } catch (e) {
    process.stderr.write(`error: cannot write trace ${parsedArgs.traceOutPath}: ${e.message}\n`);
    process.exit(1);
  }
}

if (parsedArgs.humanCheckpointOutPath !== undefined) {
  if (!result.checkpoint) {
    process.stderr.write("error: no human approval checkpoint was produced\n");
    process.exit(1);
  }
  try {
    writeFileSync(parsedArgs.humanCheckpointOutPath, serializeJson(result.checkpoint), "utf8");
  } catch (e) {
    process.stderr.write(`error: cannot write human checkpoint ${parsedArgs.humanCheckpointOutPath}: ${e.message}\n`);
    process.exit(1);
  }
}

if (parsedArgs.evidenceOutPath !== undefined) {
  try {
    writeFileSync(parsedArgs.evidenceOutPath, serializeJson(buildRunEvidence(result, parsedArgs)), "utf8");
  } catch (e) {
    process.stderr.write(`error: cannot write evidence ${parsedArgs.evidenceOutPath}: ${e.message}\n`);
    process.exit(1);
  }
}

process.stdout.write(renderOutput(result, parsedArgs.outputMode));
process.exit(result.status === "failure" ? 1 : 0);

function loadRunPlanFromPath(runPlanPath) {
  const resolvedPath = resolve(runPlanPath);
  let document;
  try {
    document = parseJsonObject(readFileSync(resolvedPath, "utf8"), `run plan ${runPlanPath}`);
  } catch (error) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", error.message);
  }
  if (document.run_plan_schema_version !== RUN_PLAN_SCHEMA_VERSION) {
    throw new RunPlanCliError(
      "RunPlanSchemaMismatch",
      `run_plan_schema_version must be ${RUN_PLAN_SCHEMA_VERSION}`,
    );
  }
  const forbiddenField = findForbiddenRunPlanField(document);
  if (forbiddenField !== null) {
    throw new RunPlanCliError(
      "RunPlanSensitivePayloadForbidden",
      `run plan cannot contain sensitive payload field ${forbiddenField}`,
    );
  }
  if (typeof document.air !== "string" || document.air.trim() === "") {
    throw new RunPlanCliError("RunPlanAirMissing", "run plan must point to an AIR file");
  }
  if (typeof document.entry_ref !== "string" || document.entry_ref.trim() === "") {
    throw new RunPlanCliError("RunPlanEntryUnknown", "run plan must declare entry_ref");
  }
  if (document.profile !== undefined && !/^[a-z][a-z0-9_-]*$/u.test(String(document.profile))) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", "run plan profile name is invalid");
  }
  validateRunPlanOptionalPath(document, "manifest");
  validateRunPlanOptionalPath(document, "secrets_profile");
  validateRunPlanOptionalPath(document, "supply_chain_lock");
  validateRunPlanOptionalPath(document, "trigger_manifest");
  validateRunPlanLimits(document.run_limits);
  validateRunPlanOutputs(document.outputs);

  return {
    path: resolvedPath,
    baseDir: dirname(resolvedPath),
    document,
  };
}

function applyRunPlan(parsed, runPlan) {
  if (parsed.positional.length > 0) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", "--run-plan cannot be combined with a positional AIR path");
  }
  const plan = runPlan.document;
  const airPath = resolveRunPlanPath(runPlan, plan.air);
  if (!existsSync(airPath)) {
    throw new RunPlanCliError("RunPlanAirMissing", `AIR file does not exist: ${airPath}`);
  }
  parsed.positional = [airPath];
  parsed.runPlanPath = runPlan.path;
  parsed.runPlanProfile = plan.profile;

  if (parsed.entryRef === undefined) {
    parsed.entryRef = plan.entry_ref;
  }
  if (parsed.manifestPath === undefined && plan.manifest !== undefined) {
    parsed.manifestPath = resolveRunPlanPath(runPlan, plan.manifest);
  }
  if (parsed.secretsPath === undefined && plan.secrets_profile !== undefined) {
    parsed.secretsPath = resolveRunPlanPath(runPlan, plan.secrets_profile);
  }
  if (parsed.supplyChainLockPath === undefined && plan.supply_chain_lock !== undefined) {
    parsed.supplyChainLockPath = resolveRunPlanPath(runPlan, plan.supply_chain_lock);
  }
  if (plan.profile === "prod") {
    parsed.requireSupplyChainLock = true;
  }
  if (plan.run_limits !== undefined) {
    const normalizedLimits = normalizeRunPlanLimits(plan.run_limits);
    if (parsed.runTimeoutMs === undefined && normalizedLimits.timeout_ms !== undefined) {
      parsed.runTimeoutMs = normalizedLimits.timeout_ms;
    }
    parsed.runLimits = {
      ...normalizedLimits.run_limits,
      ...(parsed.runLimits ?? {}),
      ...parsed.runLimitFlags,
    };
    if (Object.keys(parsed.runLimits).length === 0) {
      parsed.runLimits = undefined;
    }
  }
  if (plan.outputs?.mode !== undefined && !parsed.outputModeExplicit) {
    parsed.outputMode = plan.outputs.mode;
  }
  if (plan.outputs?.trace_out !== undefined && !parsed.traceOutExplicit) {
    parsed.traceOutPath = resolveRunPlanPath(runPlan, plan.outputs.trace_out);
  }
  if (plan.outputs?.evidence_out !== undefined && !parsed.evidenceOutExplicit) {
    parsed.evidenceOutPath = resolveRunPlanPath(runPlan, plan.outputs.evidence_out);
  }
  if (Array.isArray(plan.outputs?.evidence_refs) && parsed.evidenceRefs.length === 0) {
    parsed.evidenceRefs = plan.outputs.evidence_refs.map((ref) => ({ ...ref }));
  }
  if (plan.trigger_manifest !== undefined) {
    const triggerManifestPath = resolveRunPlanPath(runPlan, plan.trigger_manifest);
    if (!existsSync(triggerManifestPath)) {
      throw new RunPlanCliError("RunPlanTriggerManifestMissing", `trigger manifest does not exist: ${triggerManifestPath}`);
    }
    parsed.triggerManifestPath = triggerManifestPath;
  }
}

function validateParsedArgsAfterRunPlan(parsed) {
  if (
    parsed.manifestPath !== undefined
    && (
      parsed.stubs
      || parsed.localFetchSourceText !== undefined
      || parsed.localApplyChangeSummary !== undefined
    )
  ) {
    return "--manifest cannot be combined with --stubs or local handler options";
  }
  if (parsed.secretsPath !== undefined && parsed.manifestPath === undefined) {
    return parsed.runPlanPath !== undefined
      ? {
        code: "RunPlanManifestMissing",
        message: "run plan secrets_profile requires manifest",
      }
      : "--secrets requires --manifest";
  }
  if (parsed.requireSupplyChainLock && parsed.supplyChainLockPath === undefined) {
    return parsed.runPlanPath !== undefined
      ? {
        code: "RunPlanSupplyChainLockRequired",
        message: "run plan profile requires supply_chain_lock",
      }
      : "--require-supply-chain-lock requires --supply-chain-lock <path>";
  }
  if (parsed.triggerRef !== undefined && parsed.manifestPath === undefined) {
    return "--trigger requires --manifest";
  }
  if (
    (parsed.triggerEventPath !== undefined || parsed.triggerEventJson !== undefined)
    && parsed.manifestPath === undefined
  ) {
    return "--trigger-event requires --manifest";
  }
  return "";
}

function validateRunPlanAgainstAir(parsed, document, airPath) {
  if (!airEntryExists(document, parsed.entryRef)) {
    throw new RunPlanCliError("RunPlanEntryUnknown", `entry_ref ${parsed.entryRef} is not declared by AIR ${airPath}`);
  }
  if (airRequiresManifest(document)) {
    if (parsed.manifestPath === undefined || !existsSync(parsed.manifestPath)) {
      throw new RunPlanCliError("RunPlanManifestMissing", "AIR declares tools, but the run plan does not point to an existing manifest");
    }
  }
  if (airRequiresSecretsProfile(document)) {
    if (parsed.secretsPath === undefined || !existsSync(parsed.secretsPath)) {
      throw new RunPlanCliError("RunPlanSecretsProfileMissing", "AIR declares required secrets, but the run plan does not point to an existing secrets profile");
    }
  }
  if (parsed.requireSupplyChainLock && parsed.supplyChainLockPath === undefined) {
    throw new RunPlanCliError("RunPlanSupplyChainLockRequired", "run plan profile requires a supply_chain_lock");
  }
  if (parsed.supplyChainLockPath !== undefined && !existsSync(parsed.supplyChainLockPath)) {
    throw new RunPlanCliError("RunPlanSupplyChainLockRequired", `supply chain lock does not exist: ${parsed.supplyChainLockPath}`);
  }
}

function validateRunPlanOptionalPath(document, field) {
  if (document[field] !== undefined && (typeof document[field] !== "string" || document[field].trim() === "")) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", `run plan ${field} must be a non-empty string`);
  }
}

function validateRunPlanLimits(limits) {
  if (limits === undefined) {
    return;
  }
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new RunPlanCliError("RunPlanLimitInvalid", "run_limits must be an object");
  }
  for (const [key, value] of Object.entries(limits)) {
    if (!RUN_LIMIT_KEYS.has(key)) {
      throw new RunPlanCliError("RunPlanLimitInvalid", `unsupported run limit ${key}`);
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RunPlanCliError("RunPlanLimitInvalid", `run limit ${key} must be a positive integer`);
    }
  }
}

function validateRunPlanOutputs(outputs) {
  if (outputs === undefined) {
    return;
  }
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", "outputs must be an object");
  }
  if (outputs.mode !== undefined && !["show", "result", "trace", "all"].includes(outputs.mode)) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", "outputs.mode must be one of: show, result, trace, all");
  }
  if (outputs.trace_out !== undefined && (typeof outputs.trace_out !== "string" || outputs.trace_out.trim() === "")) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", "outputs.trace_out must be a non-empty string");
  }
  if (outputs.evidence_out !== undefined && (typeof outputs.evidence_out !== "string" || outputs.evidence_out.trim() === "")) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", "outputs.evidence_out must be a non-empty string");
  }
  if (outputs.evidence_refs !== undefined) {
    if (!Array.isArray(outputs.evidence_refs)) {
      throw new RunPlanCliError("RunPlanSchemaMismatch", "outputs.evidence_refs must be an array");
    }
    for (const [index, ref] of outputs.evidence_refs.entries()) {
      validateEvidenceRef(ref, `outputs.evidence_refs[${index}]`, RunPlanCliError);
    }
  }
}

function normalizeRunPlanLimits(limits) {
  const runLimits = {};
  let timeoutMs;
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (key === "timeout_ms") {
      timeoutMs = value;
    } else {
      runLimits[key] = value;
    }
  }
  return {
    timeout_ms: timeoutMs,
    run_limits: runLimits,
  };
}

function resolveRunPlanPath(runPlan, path) {
  return resolve(runPlan.baseDir, path);
}

function findForbiddenRunPlanField(value, path = []) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (RUN_PLAN_FORBIDDEN_FIELDS.has(key)) {
      return [...path, key].join(".");
    }
    const nested = findForbiddenRunPlanField(child, [...path, key]);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function airEntryExists(document, entryRef) {
  if (typeof entryRef !== "string") {
    return false;
  }
  for (const collection of ["functions", "skills", "agents", "strategies"]) {
    if ((document.definitions?.[collection] ?? []).some((item) => item.id === entryRef)) {
      return true;
    }
  }
  return false;
}

function airRequiresManifest(document) {
  return (document.definitions?.tools ?? []).length > 0;
}

function airRequiresSecretsProfile(document) {
  return (document.definitions?.tools ?? []).some((tool) => (tool.required_secrets ?? []).length > 0);
}

function validateResourceBindingsForAir({ resourceBindingsPath, requireAll, document }) {
  const inventory = buildResourceInventory(document);
  const boundResources = new Set();
  let bindingsDocument;

  if (resourceBindingsPath !== undefined) {
    bindingsDocument = readResourceBindingsDocument(resourceBindingsPath);
    for (const [resourceRef, binding] of Object.entries(bindingsDocument.resources)) {
      validateResourceBindingEntry(resourceRef, binding, inventory, resourceBindingsPath);
      if (binding?.active !== false) {
        boundResources.add(resourceRef);
      }
    }
  }

  validateRequiredMemoryScopes(inventory);

  if (requireAll) {
    for (const resourceRef of inventory.requiredResourceRefs) {
      if (!boundResources.has(resourceRef)) {
      throw new ResourceBindingsCliError("ResourceBindingMissing", `resource ${resourceRef} requires an active resource binding`);
    }
  }

  return bindingsDocument;
}
}

function readResourceBindingsDocument(resourceBindingsPath) {
  let document;
  try {
    document = JSON.parse(readFileSync(resourceBindingsPath, "utf8"));
  } catch (error) {
    throw new ResourceBindingsCliError("ResourceBindingsReadFailed", error.message);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", "resource bindings must be a JSON object");
  }
  if (document.resource_bindings_schema_version !== RESOURCE_BINDINGS_SCHEMA_VERSION) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource_bindings_schema_version must be ${RESOURCE_BINDINGS_SCHEMA_VERSION}`);
  }
  const forbiddenField = findForbiddenResourceBindingPayloadField(document);
  if (forbiddenField !== null) {
    throw new ResourceBindingsCliError("ResourceBindingPayloadForbidden", `resource binding cannot contain payload or secret value field ${forbiddenField}`);
  }
  if (!document.resources || typeof document.resources !== "object" || Array.isArray(document.resources)) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", "resource bindings resources must be an object");
  }
  return document;
}

function validateResourceBindingEntry(resourceRef, binding, inventory) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} must be an object`);
  }
  const kind = binding.kind;
  if (!RESOURCE_BINDING_KINDS.has(kind)) {
    throw new ResourceBindingsCliError("ResourceBindingUnsupportedKind", `resource binding kind ${kind} is not supported by RB-1`);
  }
  if (!resourceRef.startsWith(RESOURCE_BINDING_KIND_PREFIX[kind])) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource ${resourceRef} is not compatible with kind ${kind}`);
  }
  if (!inventory.knownResourceRefs.has(resourceRef)) {
    throw new ResourceBindingsCliError("ResourceBindingUnknownResource", `resource ${resourceRef} is absent from AIR`);
  }
  if (binding.active === false) {
    throw new ResourceBindingsCliError("ResourceBindingInactive", `resource binding ${resourceRef} is inactive`);
  }
  if (binding.active !== undefined && typeof binding.active !== "boolean") {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} active must be boolean`);
  }
  if (typeof binding.provider !== "string" || binding.provider.trim() === "") {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} provider must be a non-empty string`);
  }
  if (!Array.isArray(binding.grants) || binding.grants.some((grant) => typeof grant !== "string" || grant.trim() === "")) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} grants must contain non-empty strings`);
  }
  if (binding.secrets !== undefined && (!Array.isArray(binding.secrets) || binding.secrets.some((secret) => typeof secret !== "string" || secret.trim() === ""))) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} secrets must contain non-empty handles`);
  }
  if (binding.required_secrets !== undefined && (!Array.isArray(binding.required_secrets) || binding.required_secrets.some((secret) => typeof secret !== "string" || secret.trim() === ""))) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} required_secrets must contain non-empty handles`);
  }
  for (const secret of binding.required_secrets ?? []) {
    if (!binding.secrets?.includes(secret)) {
      throw new ResourceBindingsCliError("ResourceBindingSecretMissing", `resource binding ${resourceRef} is missing secret handle ${secret}`);
    }
  }
  for (const grant of inventory.requiredGrantsByResource.get(resourceRef) ?? []) {
    if (!binding.grants.includes(grant)) {
      throw new ResourceBindingsCliError("ResourceBindingGrantMissing", `resource binding ${resourceRef} is missing grant ${grant}`);
    }
  }
  validateResourceBindingLimits(binding.limits, resourceRef);
}

function validateResourceBindingLimits(limits, resourceRef) {
  if (limits === undefined) {
    return;
  }
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} limits must be an object`);
  }
  if (limits.max_payload_bytes !== undefined && (!Number.isInteger(limits.max_payload_bytes) || limits.max_payload_bytes <= 0)) {
    throw new ResourceBindingsCliError("ResourceBindingsSchemaMismatch", `resource binding ${resourceRef} limits.max_payload_bytes must be a positive integer`);
  }
}

function buildResourceInventory(document) {
  const knownResourceRefs = new Set();
  const requiredResourceRefs = new Set();
  const requiredGrantsByResource = new Map();
  const ownersByRef = new Map();
  const toolsByRef = new Map();

  for (const memory of document.definitions?.memories ?? []) {
    knownResourceRefs.add(memory.id);
  }
  for (const trigger of document.definitions?.triggers ?? []) {
    knownResourceRefs.add(trigger.id);
    requiredResourceRefs.add(trigger.id);
  }
  for (const agent of document.definitions?.agents ?? []) {
    knownResourceRefs.add(agent.id);
  }
  for (const collection of ["skills", "agents", "strategies", "functions"]) {
    for (const owner of document.definitions?.[collection] ?? []) {
      ownersByRef.set(owner.id, owner);
    }
  }
  for (const tool of document.definitions?.tools ?? []) {
    toolsByRef.set(tool.id, tool);
    for (const access of tool.memory_accesses ?? []) {
      requiredResourceRefs.add(access.memory_ref);
      addResourceGrant(requiredGrantsByResource, access.memory_ref, access.access === "write" ? "memory.write" : "memory.read");
    }
  }

  return {
    knownResourceRefs,
    requiredResourceRefs,
    requiredGrantsByResource,
    ownersByRef,
    toolsByRef,
    graphOwners: document.execution_graphs ?? [],
  };
}

function validateRequiredMemoryScopes(inventory) {
  for (const graph of inventory.graphOwners) {
    const owner = inventory.ownersByRef.get(graph.owner_ref);
    const scopes = owner?.memory_scopes ?? [];
    for (const node of graph.nodes ?? []) {
      if (node.kind !== "call_tool") {
        continue;
      }
      const tool = inventory.toolsByRef.get(node.target_ref);
      for (const access of tool?.memory_accesses ?? []) {
        const found = scopes.some((scope) => scope.memory_ref === access.memory_ref && scope.access === access.access);
        if (!found) {
          throw new ResourceBindingsCliError("ResourceBindingScopeMissing", `${graph.owner_ref} lacks memory scope for ${access.memory_ref} ${access.access}`);
        }
      }
    }
  }
}

function addResourceGrant(map, resourceRef, grant) {
  const grants = map.get(resourceRef) ?? new Set();
  grants.add(grant);
  map.set(resourceRef, grants);
}

function findForbiddenResourceBindingPayloadField(value, path = []) {
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (RESOURCE_BINDING_PAYLOAD_FORBIDDEN_FIELDS.has(key)) {
      return [...path, key].join(".");
    }
    const nested = findForbiddenResourceBindingPayloadField(child, [...path, key]);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function loadManifestFromPath(manifestPath) {
  const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (rawManifest?.fragment_schema_version === BINDING_FRAGMENT_SCHEMA_VERSION) {
    throw new Error("BindingFragmentNotAssembled: binding fragments must be assembled by touba prepare before runtime");
  }
  const manifestDir = dirname(resolve(manifestPath));
  for (const binding of Object.values(rawManifest.bindings ?? {})) {
    if (binding?.handler?.cwd && !isAbsolute(binding.handler.cwd)) {
      binding.handler.cwd = resolve(manifestDir, binding.handler.cwd);
    }
  }
  return loadToolBindingManifestFromJson(JSON.stringify(rawManifest));
}

function loadSecretsFromPath(secretsPath) {
  return loadSecretsFromJson(readFileSync(secretsPath, "utf8"), {
    baseDir: dirname(resolve(secretsPath)),
  });
}

async function loadAgentDecisionProviderFromPath(providerPath) {
  const moduleUrl = pathToFileURL(resolve(providerPath)).href;
  const providerModule = await import(moduleUrl);
  const provider =
    providerModule.decideAgentCapability
    ?? providerModule.decide
    ?? providerModule.default;
  if (typeof provider !== "function") {
    throw new Error("provider module must export decideAgentCapability, decide, or a default function");
  }
  const metadata = providerModule.provider_metadata
    ?? providerModule.providerMetadata
    ?? provider.metadata
    ?? providerModule.default?.metadata;
  return metadata === undefined
    ? provider
    : {
      decide: provider,
      metadata,
    };
}

function parseArgs(rawArgs) {
  const parsed = {
    runPlanPath: undefined,
    runPlanProfile: undefined,
    outputModeExplicit: false,
    traceOutExplicit: false,
    stubs: false,
    localFetchSourceText: undefined,
    localApplyChangeSummary: undefined,
    manifestPath: undefined,
    resourceBindingsPath: undefined,
    requireResourceBindings: false,
    secretsPath: undefined,
    inputsJson: undefined,
    humanDecisionsPath: undefined,
    humanDecisionsJson: undefined,
    userInputsPath: undefined,
    userInputsJson: undefined,
    interactiveUserInputs: false,
    agentDecisionsPath: undefined,
    agentDecisionsJson: undefined,
    agentDecisionProviderPath: undefined,
    agentDecisionProviderMetadataJson: undefined,
    agentDecisionProviderMetadata: undefined,
    agentDecisionProviderInitialMode: undefined,
    agentDecisionProviderTimeoutMs: undefined,
    agentDecisionProviderMaxRetries: undefined,
    triggerEventPath: undefined,
    triggerEventJson: undefined,
    triggerDryRun: false,
    triggerStatePath: undefined,
    triggerRef: undefined,
    triggerRunnerMaxRuns: undefined,
    supplyChainLockPath: undefined,
    requireSupplyChainLock: false,
    entryRef: undefined,
    maxAgentSteps: undefined,
    runTimeoutMs: undefined,
    runLimitsJson: undefined,
    runLimitFlags: {},
    runLimits: undefined,
    cancelBeforeDispatch: false,
    cancelOnPause: false,
    killSwitchEnabled: false,
    humanCheckpointOutPath: undefined,
    humanResumeCheckpointPath: undefined,
    outputMode: "show",
    traceOutPath: undefined,
    evidenceOutPath: undefined,
    evidenceOutExplicit: false,
    evidenceRefs: [],
    positional: [],
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--run-plan") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--run-plan requires a path" };
      }
      parsed.runPlanPath = rawArgs[index];
    } else if (arg.startsWith("--run-plan=")) {
      parsed.runPlanPath = arg.slice("--run-plan=".length);
    } else if (arg === "--stubs") {
      parsed.stubs = true;
    } else if (arg === "--local-fetch-source-text") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--local-fetch-source-text requires a value" };
      }
      parsed.localFetchSourceText = rawArgs[index];
    } else if (arg.startsWith("--local-fetch-source-text=")) {
      parsed.localFetchSourceText = arg.slice("--local-fetch-source-text=".length);
    } else if (arg === "--local-apply-change-summary") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--local-apply-change-summary requires a value" };
      }
      parsed.localApplyChangeSummary = rawArgs[index];
    } else if (arg.startsWith("--local-apply-change-summary=")) {
      parsed.localApplyChangeSummary = arg.slice("--local-apply-change-summary=".length);
    } else if (arg === "--manifest") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--manifest requires a path" };
      }
      parsed.manifestPath = rawArgs[index];
    } else if (arg.startsWith("--manifest=")) {
      parsed.manifestPath = arg.slice("--manifest=".length);
    } else if (arg === "--resource-bindings") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--resource-bindings requires a path" };
      }
      parsed.resourceBindingsPath = rawArgs[index];
    } else if (arg.startsWith("--resource-bindings=")) {
      parsed.resourceBindingsPath = arg.slice("--resource-bindings=".length);
    } else if (arg === "--require-resource-bindings") {
      parsed.requireResourceBindings = true;
    } else if (arg === "--secrets") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--secrets requires a path" };
      }
      parsed.secretsPath = rawArgs[index];
    } else if (arg.startsWith("--secrets=")) {
      parsed.secretsPath = arg.slice("--secrets=".length);
    } else if (arg === "--inputs-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--inputs-json requires a JSON object" };
      }
      parsed.inputsJson = rawArgs[index];
    } else if (arg.startsWith("--inputs-json=")) {
      parsed.inputsJson = arg.slice("--inputs-json=".length);
    } else if (arg === "--human-decisions") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--human-decisions requires a path" };
      }
      parsed.humanDecisionsPath = rawArgs[index];
    } else if (arg.startsWith("--human-decisions=")) {
      parsed.humanDecisionsPath = arg.slice("--human-decisions=".length);
    } else if (arg === "--human-decisions-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--human-decisions-json requires a JSON object" };
      }
      parsed.humanDecisionsJson = rawArgs[index];
    } else if (arg.startsWith("--human-decisions-json=")) {
      parsed.humanDecisionsJson = arg.slice("--human-decisions-json=".length);
    } else if (arg === "--human-checkpoint-out") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--human-checkpoint-out requires a path" };
      }
      parsed.humanCheckpointOutPath = rawArgs[index];
    } else if (arg.startsWith("--human-checkpoint-out=")) {
      parsed.humanCheckpointOutPath = arg.slice("--human-checkpoint-out=".length);
    } else if (arg === "--human-resume-checkpoint") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--human-resume-checkpoint requires a path" };
      }
      parsed.humanResumeCheckpointPath = rawArgs[index];
    } else if (arg.startsWith("--human-resume-checkpoint=")) {
      parsed.humanResumeCheckpointPath = arg.slice("--human-resume-checkpoint=".length);
    } else if (arg === "--user-inputs") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--user-inputs requires a path" };
      }
      parsed.userInputsPath = rawArgs[index];
    } else if (arg.startsWith("--user-inputs=")) {
      parsed.userInputsPath = arg.slice("--user-inputs=".length);
    } else if (arg === "--user-inputs-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--user-inputs-json requires a JSON object" };
      }
      parsed.userInputsJson = rawArgs[index];
    } else if (arg.startsWith("--user-inputs-json=")) {
      parsed.userInputsJson = arg.slice("--user-inputs-json=".length);
    } else if (arg === "--interactive-user-inputs") {
      parsed.interactiveUserInputs = true;
    } else if (arg === "--agent-decisions") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--agent-decisions requires a path" };
      }
      parsed.agentDecisionsPath = rawArgs[index];
    } else if (arg.startsWith("--agent-decisions=")) {
      parsed.agentDecisionsPath = arg.slice("--agent-decisions=".length);
    } else if (arg === "--agent-decisions-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--agent-decisions-json requires a JSON object" };
      }
      parsed.agentDecisionsJson = rawArgs[index];
    } else if (arg.startsWith("--agent-decisions-json=")) {
      parsed.agentDecisionsJson = arg.slice("--agent-decisions-json=".length);
    } else if (arg === "--agent-decision-provider") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--agent-decision-provider requires a path" };
      }
      parsed.agentDecisionProviderPath = rawArgs[index];
    } else if (arg.startsWith("--agent-decision-provider=")) {
      parsed.agentDecisionProviderPath = arg.slice("--agent-decision-provider=".length);
    } else if (arg === "--agent-decision-provider-metadata-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--agent-decision-provider-metadata-json requires a JSON object" };
      }
      parsed.agentDecisionProviderMetadataJson = rawArgs[index];
    } else if (arg.startsWith("--agent-decision-provider-metadata-json=")) {
      parsed.agentDecisionProviderMetadataJson = arg.slice("--agent-decision-provider-metadata-json=".length);
    } else if (arg === "--agent-decision-provider-timeout-ms") {
      index += 1;
      const timeoutMs = parsePositiveInteger(rawArgs[index]);
      if (!timeoutMs) {
        return { error: "--agent-decision-provider-timeout-ms requires a positive integer" };
      }
      parsed.agentDecisionProviderTimeoutMs = timeoutMs;
    } else if (arg.startsWith("--agent-decision-provider-timeout-ms=")) {
      const timeoutMs = parsePositiveInteger(arg.slice("--agent-decision-provider-timeout-ms=".length));
      if (!timeoutMs) {
        return { error: "--agent-decision-provider-timeout-ms requires a positive integer" };
      }
      parsed.agentDecisionProviderTimeoutMs = timeoutMs;
    } else if (arg === "--agent-decision-provider-max-retries") {
      index += 1;
      const maxRetries = parseNonNegativeInteger(rawArgs[index]);
      if (maxRetries === null) {
        return { error: "--agent-decision-provider-max-retries requires a non-negative integer" };
      }
      parsed.agentDecisionProviderMaxRetries = maxRetries;
    } else if (arg.startsWith("--agent-decision-provider-max-retries=")) {
      const maxRetries = parseNonNegativeInteger(arg.slice("--agent-decision-provider-max-retries=".length));
      if (maxRetries === null) {
        return { error: "--agent-decision-provider-max-retries requires a non-negative integer" };
      }
      parsed.agentDecisionProviderMaxRetries = maxRetries;
    } else if (arg === "--agent-decision-provider-content-mode") {
      index += 1;
      if (!["inline", "opaque_refs"].includes(rawArgs[index])) {
        return { error: "--agent-decision-provider-content-mode must be one of: inline, opaque_refs" };
      }
      parsed.agentDecisionProviderContentMode = rawArgs[index];
    } else if (arg.startsWith("--agent-decision-provider-content-mode=")) {
      const contentMode = arg.slice("--agent-decision-provider-content-mode=".length);
      if (!["inline", "opaque_refs"].includes(contentMode)) {
        return { error: "--agent-decision-provider-content-mode must be one of: inline, opaque_refs" };
      }
      parsed.agentDecisionProviderContentMode = contentMode;
    } else if (arg === "--agent-decision-provider-initial-mode") {
      index += 1;
      if (!["summary", "capabilities"].includes(rawArgs[index])) {
        return { error: "--agent-decision-provider-initial-mode must be one of: summary, capabilities" };
      }
      parsed.agentDecisionProviderInitialMode = rawArgs[index];
    } else if (arg.startsWith("--agent-decision-provider-initial-mode=")) {
      const initialMode = arg.slice("--agent-decision-provider-initial-mode=".length);
      if (!["summary", "capabilities"].includes(initialMode)) {
        return { error: "--agent-decision-provider-initial-mode must be one of: summary, capabilities" };
      }
      parsed.agentDecisionProviderInitialMode = initialMode;
    } else if (arg === "--trigger-event") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--trigger-event requires a path" };
      }
      parsed.triggerEventPath = rawArgs[index];
    } else if (arg.startsWith("--trigger-event=")) {
      parsed.triggerEventPath = arg.slice("--trigger-event=".length);
    } else if (arg === "--trigger-event-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--trigger-event-json requires a JSON object" };
      }
      parsed.triggerEventJson = rawArgs[index];
    } else if (arg.startsWith("--trigger-event-json=")) {
      parsed.triggerEventJson = arg.slice("--trigger-event-json=".length);
    } else if (arg === "--trigger-dry-run") {
      parsed.triggerDryRun = true;
    } else if (arg === "--state" || arg === "--trigger-state") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: `${arg} requires a path` };
      }
      parsed.triggerStatePath = rawArgs[index];
    } else if (arg.startsWith("--state=")) {
      parsed.triggerStatePath = arg.slice("--state=".length);
    } else if (arg.startsWith("--trigger-state=")) {
      parsed.triggerStatePath = arg.slice("--trigger-state=".length);
    } else if (arg === "--supply-chain-lock") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--supply-chain-lock requires a path" };
      }
      parsed.supplyChainLockPath = rawArgs[index];
    } else if (arg.startsWith("--supply-chain-lock=")) {
      parsed.supplyChainLockPath = arg.slice("--supply-chain-lock=".length);
    } else if (arg === "--require-supply-chain-lock") {
      parsed.requireSupplyChainLock = true;
    } else if (arg === "--trigger") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--trigger requires a trigger ref" };
      }
      parsed.triggerRef = rawArgs[index];
    } else if (arg.startsWith("--trigger=")) {
      parsed.triggerRef = arg.slice("--trigger=".length);
    } else if (arg === "--max-runs") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--max-runs requires a positive integer" };
      }
      const maxRuns = parsePositiveInteger(rawArgs[index]);
      if (!maxRuns) {
        return { error: "--max-runs requires a positive integer" };
      }
      parsed.triggerRunnerMaxRuns = maxRuns;
    } else if (arg.startsWith("--max-runs=")) {
      const maxRuns = parsePositiveInteger(arg.slice("--max-runs=".length));
      if (!maxRuns) {
        return { error: "--max-runs requires a positive integer" };
      }
      parsed.triggerRunnerMaxRuns = maxRuns;
    } else if (arg === "--max-agent-steps") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--max-agent-steps requires a positive integer" };
      }
      const maxAgentSteps = parsePositiveInteger(rawArgs[index]);
      if (!maxAgentSteps) {
        return { error: "--max-agent-steps requires a positive integer" };
      }
      parsed.maxAgentSteps = maxAgentSteps;
    } else if (arg.startsWith("--max-agent-steps=")) {
      const maxAgentSteps = parsePositiveInteger(arg.slice("--max-agent-steps=".length));
      if (!maxAgentSteps) {
        return { error: "--max-agent-steps requires a positive integer" };
      }
      parsed.maxAgentSteps = maxAgentSteps;
    } else if (arg === "--run-timeout-ms") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--run-timeout-ms requires a positive integer" };
      }
      const runTimeoutMs = parsePositiveInteger(rawArgs[index]);
      if (!runTimeoutMs) {
        return { error: "--run-timeout-ms requires a positive integer" };
      }
      parsed.runTimeoutMs = runTimeoutMs;
    } else if (arg.startsWith("--run-timeout-ms=")) {
      const runTimeoutMs = parsePositiveInteger(arg.slice("--run-timeout-ms=".length));
      if (!runTimeoutMs) {
        return { error: "--run-timeout-ms requires a positive integer" };
      }
      parsed.runTimeoutMs = runTimeoutMs;
    } else if (arg === "--run-limits-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--run-limits-json requires a JSON object" };
      }
      parsed.runLimitsJson = rawArgs[index];
    } else if (arg.startsWith("--run-limits-json=")) {
      parsed.runLimitsJson = arg.slice("--run-limits-json=".length);
    } else if (arg === "--max-run-ms") {
      index += 1;
      const error = setRunLimitFlag(parsed, "max_run_ms", rawArgs[index], "--max-run-ms");
      if (error) {
        return { error };
      }
    } else if (arg.startsWith("--max-run-ms=")) {
      const error = setRunLimitFlag(parsed, "max_run_ms", arg.slice("--max-run-ms=".length), "--max-run-ms");
      if (error) {
        return { error };
      }
    } else if (arg === "--max-steps") {
      index += 1;
      const error = setRunLimitFlag(parsed, "max_steps", rawArgs[index], "--max-steps");
      if (error) {
        return { error };
      }
    } else if (arg.startsWith("--max-steps=")) {
      const error = setRunLimitFlag(parsed, "max_steps", arg.slice("--max-steps=".length), "--max-steps");
      if (error) {
        return { error };
      }
    } else if (arg === "--max-tool-calls") {
      index += 1;
      const error = setRunLimitFlag(parsed, "max_tool_calls", rawArgs[index], "--max-tool-calls");
      if (error) {
        return { error };
      }
    } else if (arg.startsWith("--max-tool-calls=")) {
      const error = setRunLimitFlag(parsed, "max_tool_calls", arg.slice("--max-tool-calls=".length), "--max-tool-calls");
      if (error) {
        return { error };
      }
    } else if (arg === "--max-agent-invocations") {
      index += 1;
      const error = setRunLimitFlag(
        parsed,
        "max_agent_invocations",
        rawArgs[index],
        "--max-agent-invocations",
      );
      if (error) {
        return { error };
      }
    } else if (arg.startsWith("--max-agent-invocations=")) {
      const error = setRunLimitFlag(
        parsed,
        "max_agent_invocations",
        arg.slice("--max-agent-invocations=".length),
        "--max-agent-invocations",
      );
      if (error) {
        return { error };
      }
    } else if (arg === "--max-provider-calls") {
      index += 1;
      const error = setRunLimitFlag(parsed, "max_provider_calls", rawArgs[index], "--max-provider-calls");
      if (error) {
        return { error };
      }
    } else if (arg.startsWith("--max-provider-calls=")) {
      const error = setRunLimitFlag(parsed, "max_provider_calls", arg.slice("--max-provider-calls=".length), "--max-provider-calls");
      if (error) {
        return { error };
      }
    } else if (arg === "--cancel-before-dispatch") {
      parsed.cancelBeforeDispatch = true;
    } else if (arg === "--cancel-on-pause") {
      parsed.cancelOnPause = true;
    } else if (arg === "--kill-switch-enabled") {
      parsed.killSwitchEnabled = true;
    } else if (arg === "--entry") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--entry requires an AIR reference" };
      }
      parsed.entryRef = rawArgs[index];
    } else if (arg.startsWith("--entry=")) {
      parsed.entryRef = arg.slice("--entry=".length);
    } else if (arg === "--output") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--output requires one of: show, result, trace, all" };
      }
      parsed.outputMode = rawArgs[index];
      parsed.outputModeExplicit = true;
    } else if (arg.startsWith("--output=")) {
      parsed.outputMode = arg.slice("--output=".length);
      parsed.outputModeExplicit = true;
    } else if (arg === "--trace-out") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--trace-out requires a path" };
      }
      parsed.traceOutPath = rawArgs[index];
      parsed.traceOutExplicit = true;
    } else if (arg.startsWith("--trace-out=")) {
      parsed.traceOutPath = arg.slice("--trace-out=".length);
      parsed.traceOutExplicit = true;
    } else if (arg === "--evidence-out") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--evidence-out requires a path" };
      }
      parsed.evidenceOutPath = rawArgs[index];
      parsed.evidenceOutExplicit = true;
    } else if (arg.startsWith("--evidence-out=")) {
      parsed.evidenceOutPath = arg.slice("--evidence-out=".length);
      parsed.evidenceOutExplicit = true;
    } else if (arg === "--evidence-ref") {
      index += 1;
      if (index >= rawArgs.length) {
        return { error: "--evidence-ref requires label=uri" };
      }
      try {
        parsed.evidenceRefs.push(parseEvidenceRef(rawArgs[index]));
      } catch (error) {
        return { error: error.message };
      }
    } else if (arg.startsWith("--evidence-ref=")) {
      try {
        parsed.evidenceRefs.push(parseEvidenceRef(arg.slice("--evidence-ref=".length)));
      } catch (error) {
        return { error: error.message };
      }
    } else if (arg.startsWith("--")) {
      return { error: `unknown option ${arg}` };
    } else {
      parsed.positional.push(arg);
    }
  }

  if (
    parsed.stubs
    && (parsed.localFetchSourceText !== undefined || parsed.localApplyChangeSummary !== undefined)
  ) {
    return { error: "--stubs cannot be combined with local handler options" };
  }

  if (
    parsed.manifestPath !== undefined
    && (
      parsed.stubs
      || parsed.localFetchSourceText !== undefined
      || parsed.localApplyChangeSummary !== undefined
    )
  ) {
    return { error: "--manifest cannot be combined with --stubs or local handler options" };
  }

  if (parsed.humanDecisionsPath !== undefined && parsed.humanDecisionsJson !== undefined) {
    return { error: "--human-decisions cannot be combined with --human-decisions-json" };
  }

  if (parsed.humanCheckpointOutPath !== undefined && parsed.humanResumeCheckpointPath !== undefined) {
    return { error: "--human-checkpoint-out cannot be combined with --human-resume-checkpoint" };
  }

  if (
    parsed.humanResumeCheckpointPath !== undefined
    && parsed.humanDecisionsPath === undefined
    && parsed.humanDecisionsJson === undefined
  ) {
    return { error: "--human-resume-checkpoint requires --human-decisions or --human-decisions-json" };
  }

  if (parsed.userInputsPath !== undefined && parsed.userInputsJson !== undefined) {
    return { error: "--user-inputs cannot be combined with --user-inputs-json" };
  }

  if (parsed.agentDecisionsPath !== undefined && parsed.agentDecisionsJson !== undefined) {
    return { error: "--agent-decisions cannot be combined with --agent-decisions-json" };
  }

  if (parsed.agentDecisionProviderMetadataJson !== undefined) {
    try {
      parsed.agentDecisionProviderMetadata = parseJsonObject(
        parsed.agentDecisionProviderMetadataJson,
        "--agent-decision-provider-metadata-json",
      );
    } catch (e) {
      return { error: `invalid --agent-decision-provider-metadata-json: ${e.message}` };
    }
  }

  if (parsed.triggerEventPath !== undefined && parsed.triggerEventJson !== undefined) {
    return { error: "--trigger-event cannot be combined with --trigger-event-json" };
  }

  if (parsed.triggerDryRun && parsed.triggerEventPath === undefined && parsed.triggerEventJson === undefined) {
    return { error: "--trigger-dry-run requires --trigger-event or --trigger-event-json" };
  }

  if (parsed.triggerDryRun && parsed.triggerStatePath !== undefined) {
    return { error: "--state cannot be combined with --trigger-dry-run" };
  }

  if (
    parsed.triggerStatePath !== undefined
    && parsed.triggerRef === undefined
    && parsed.triggerEventPath === undefined
    && parsed.triggerEventJson === undefined
  ) {
    return { error: "--state requires --trigger, --trigger-event or --trigger-event-json" };
  }

  if (parsed.triggerRef !== undefined && parsed.triggerRunnerMaxRuns === undefined) {
    return { error: "--trigger requires --max-runs" };
  }

  if (parsed.triggerRef !== undefined && parsed.triggerStatePath === undefined) {
    return { error: "--trigger requires --state <*.trigger-state.json> for durable replay and quota checks" };
  }

  if (parsed.triggerRunnerMaxRuns !== undefined && parsed.triggerRef === undefined) {
    return { error: "--max-runs requires --trigger" };
  }

  if (
    parsed.triggerRef !== undefined
    && (parsed.triggerEventPath !== undefined || parsed.triggerEventJson !== undefined || parsed.triggerDryRun)
  ) {
    return { error: "--trigger cannot be combined with --trigger-event, --trigger-event-json or --trigger-dry-run" };
  }

  if (parsed.triggerRef !== undefined && parsed.entryRef !== undefined) {
    return { error: "--entry cannot be combined with trigger runner execution" };
  }

  if (parsed.triggerRef !== undefined && parsed.humanCheckpointOutPath !== undefined) {
    return { error: "--human-checkpoint-out cannot be combined with trigger runner execution" };
  }

  if (parsed.triggerRef !== undefined && parsed.humanResumeCheckpointPath !== undefined) {
    return { error: "--human-resume-checkpoint cannot be combined with trigger runner execution" };
  }

  if (
    (parsed.triggerEventPath !== undefined || parsed.triggerEventJson !== undefined)
    && parsed.entryRef !== undefined
  ) {
    return { error: "--entry cannot be combined with trigger execution" };
  }

  if (
    (parsed.triggerEventPath !== undefined || parsed.triggerEventJson !== undefined)
    && parsed.humanCheckpointOutPath !== undefined
  ) {
    return { error: "--human-checkpoint-out cannot be combined with trigger execution" };
  }

  if (
    (parsed.triggerEventPath !== undefined || parsed.triggerEventJson !== undefined)
    && parsed.humanResumeCheckpointPath !== undefined
  ) {
    return { error: "--human-resume-checkpoint cannot be combined with trigger execution" };
  }

  if (
    parsed.interactiveUserInputs
    && (parsed.userInputsPath !== undefined || parsed.userInputsJson !== undefined)
  ) {
    return { error: "--interactive-user-inputs cannot be combined with --user-inputs or --user-inputs-json" };
  }

  if (parsed.runLimitsJson !== undefined) {
    try {
      parsed.runLimits = parseJsonObject(parsed.runLimitsJson, "--run-limits-json");
    } catch (e) {
      return { error: `invalid --run-limits-json: ${e.message}` };
    }
  }

  parsed.runLimits = {
    ...(parsed.runLimits ?? {}),
    ...parsed.runLimitFlags,
  };
  if (Object.keys(parsed.runLimits).length === 0) {
    parsed.runLimits = undefined;
  }

  if (!["show", "result", "trace", "all"].includes(parsed.outputMode)) {
    return { error: "--output must be one of: show, result, trace, all" };
  }

  if (parsed.evidenceRefs.length > 0 && parsed.evidenceOutPath === undefined) {
    return { error: "--evidence-ref requires --evidence-out" };
  }

  return parsed;
}

function printUsage() {
  process.stderr.write(
    "usage: node run.mjs (<file.air.json> | --run-plan <touba.run-plan.json>) [--stubs | --local-fetch-source-text <text> | --local-apply-change-summary <text> | --manifest <path> [--secrets <path>]] [--resource-bindings <path> [--require-resource-bindings]] [--supply-chain-lock <path> [--require-supply-chain-lock]] [--inputs-json <json-object>] [--human-decisions <path> | --human-decisions-json <json-object>] [--human-checkpoint-out <path> | --human-resume-checkpoint <path>] [--user-inputs <path> | --user-inputs-json <json-object> | --interactive-user-inputs] [--agent-decisions <path> | --agent-decisions-json <json-object>] [--agent-decision-provider <path> [--agent-decision-provider-metadata-json <json-object>] [--agent-decision-provider-content-mode inline|opaque_refs] [--agent-decision-provider-initial-mode summary|capabilities] [--agent-decision-provider-timeout-ms <positive-integer>] [--agent-decision-provider-max-retries <non-negative-integer>]] [--trigger-event <path> | --trigger-event-json <json-object> [--state <touba.trigger-state.json>]] [--trigger-dry-run] [--trigger <trigger-ref> --max-runs <positive-integer> --state <touba.trigger-state.json>] [--max-agent-steps <positive-integer>] [--run-timeout-ms <positive-integer>] [--run-limits-json <json-object>] [--max-run-ms <positive-integer>] [--max-steps <positive-integer>] [--max-tool-calls <positive-integer>] [--max-agent-invocations <positive-integer>] [--max-provider-calls <positive-integer>] [--cancel-before-dispatch] [--cancel-on-pause] [--kill-switch-enabled] [--entry <air-ref>] [--output show|result|trace|all] [--trace-out <path>] [--evidence-out <run.evidence.json> [--evidence-ref <label=uri>...]]\n",
  );
}

function validateSupplyChainGate({ lockPath, airPath, manifestPath, requireLock }) {
  let report;
  try {
    const artifacts = loadSupplyChainArtifacts({
      lock: lockPath,
      air: airPath,
      manifest: manifestPath,
    });
    report = validateSupplyChainArtifacts(artifacts);
  } catch (error) {
    return {
      accepted: false,
      code: "SupplyChainLockReadFailed",
      message: error.message,
    };
  }

  if (report.status === "error") {
    return {
      accepted: false,
      code: "SupplyChainLockInvalid",
      report,
    };
  }
  if (requireLock && report.status === "warning") {
    return {
      accepted: false,
      code: "SupplyChainLockWarning",
      report,
    };
  }
  return {
    accepted: true,
    report,
  };
}

function formatSupplyChainGateError(gate) {
  const lines = [`supply chain error [${gate.code}]: run refused before dispatch`];
  if (gate.message) {
    lines.push(gate.message);
  }
  if (gate.report) {
    lines.push(renderSupplyChainValidation(gate.report).trimEnd());
  }
  lines.push("provide a coherent --supply-chain-lock, regenerate the lock from current AIR/manifest/handlers, or rerun without --require-supply-chain-lock only if this gate is intentionally not required");
  return `${lines.join("\n")}\n`;
}

function createInteractiveUserInputSession() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  let closed = false;
  return {
    provider: async ({ prompt }) => rl.question(`${prompt} `),
    close: () => {
      if (!closed) {
        closed = true;
        rl.close();
      }
    },
  };
}

function renderOutput(result, mode) {
  if (mode === "show") {
    return renderShowOutput(result.trace);
  }
  if (mode === "result") {
    return serializeJson(result.result ?? null);
  }
  if (mode === "trace") {
    return serializeJson(result.trace);
  }
  if (mode === "all") {
    return renderAllOutput(result);
  }
  throw new Error(`unsupported output mode ${mode}`);
}

function renderShowOutput(trace) {
  const messages = (trace.events ?? [])
    .filter((event) => event.kind === "user_interaction_shown")
    .map((event) => event.payload?.message)
    .filter((message) => typeof message === "string");

  if (messages.length === 0) {
    return "";
  }
  return `${messages.join("\n")}\n`;
}

function renderAllOutput(result) {
  const sections = [];
  const showOutput = renderShowOutput(result.trace).trimEnd();
  if (showOutput !== "") {
    sections.push(`[show]\n${showOutput}`);
  }
  sections.push(`[result]\n${JSON.stringify(result.result ?? null, null, 2)}`);
  sections.push(`[trace]\n${JSON.stringify(result.trace, null, 2)}`);
  return `${sections.join("\n\n")}\n`;
}

function buildRunEvidence(result, parsed) {
  const trace = result.trace ?? {};
  const terminalEvent = Array.isArray(trace.events) ? trace.events.at(-1) : undefined;
  const resultValue = result.result ?? null;
  const checkpointValue = result.checkpoint ?? null;
  return {
    evidence_schema_version: RUN_EVIDENCE_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    run: {
      run_id: trace.run?.run_id ?? null,
      status: result.status,
      module_ref: trace.run?.module_ref ?? null,
      entry_ref: trace.run?.entry_ref ?? parsed.entryRef ?? null,
      terminal_event: terminalEvent?.kind ?? null,
    },
    trace: {
      available: trace !== undefined,
      events_count: Array.isArray(trace.events) ? trace.events.length : 0,
      digest: digestJson(trace),
      output: parsed.traceOutPath === undefined ? null : {
        kind: "file",
        path: parsed.traceOutPath,
      },
    },
    result: {
      available: result.result !== undefined,
      json_type: jsonType(resultValue),
      digest: digestJson(resultValue),
    },
    checkpoint: {
      available: checkpointValue !== null,
      digest: checkpointValue === null ? null : digestJson(checkpointValue),
      output: parsed.humanCheckpointOutPath === undefined ? null : {
        kind: "file",
        path: parsed.humanCheckpointOutPath,
      },
    },
    external_evidence_refs: parsed.evidenceRefs,
  };
}

function parseEvidenceRef(raw) {
  const separatorIndex = raw.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    throw new Error("--evidence-ref must use label=uri");
  }
  const ref = {
    label: raw.slice(0, separatorIndex),
    uri: raw.slice(separatorIndex + 1),
  };
  validateEvidenceRef(ref, "--evidence-ref", Error);
  return ref;
}

function validateEvidenceRef(ref, label, ErrorClass) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    throwEvidenceRefError(ErrorClass, `${label} must be an object`);
  }
  if (typeof ref.label !== "string" || !/^[A-Za-z0-9_.:-]+$/u.test(ref.label)) {
    throwEvidenceRefError(ErrorClass, `${label}.label must match [A-Za-z0-9_.:-]+`);
  }
  if (typeof ref.uri !== "string" || ref.uri.trim() === "") {
    throwEvidenceRefError(ErrorClass, `${label}.uri must be a non-empty string`);
  }
  if (/(api[_-]?key|password|secret|token)=/iu.test(ref.uri)) {
    throwEvidenceRefError(ErrorClass, `${label}.uri must not contain obvious secret query parameters`);
  }
}

function throwEvidenceRefError(ErrorClass, message) {
  if (ErrorClass === RunPlanCliError) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", message);
  }
  throw new Error(message);
}

function digestJson(value) {
  return {
    kind: "sha256",
    value: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}

function jsonType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJsonObject(raw, label) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must decode to a JSON object`);
  }
  return value;
}

function parsePositiveInteger(raw) {
  if (!/^[1-9][0-9]*$/u.test(String(raw))) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseNonNegativeInteger(raw) {
  if (!/^(0|[1-9][0-9]*)$/u.test(String(raw))) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function setRunLimitFlag(parsed, budgetKind, rawValue, optionName) {
  if (rawValue === undefined) {
    return `${optionName} requires a positive integer`;
  }
  const value = parsePositiveInteger(rawValue);
  if (!value) {
    return `${optionName} requires a positive integer`;
  }
  parsed.runLimitFlags[budgetKind] = value;
  return "";
}

function formatRuntimeError(error) {
  const lines = [`runtime error [${error.code}]: ${error.message}`];
  const toolRef = error.details?.toolRef;
  const approvalRef = error.details?.approvalRef;
  const interactionRef = error.details?.interactionRef;
  const agentRef = error.details?.agentRef;
  const triggerRef = error.details?.triggerRef;

  if (toolRef) {
    const missing = error.message.startsWith("missing tool binding");
    lines.push(`${missing ? "missing" : "failed"} tool binding: ${toolRef}`);

    if (error.details.cause) {
      lines.push(`handler reported: ${error.details.cause}`);
    }
    if (error.details.missingCapability) {
      lines.push(`missing capability: ${error.details.missingCapability}`);
    }
    if (error.details.missingCapabilities?.length) {
      lines.push(`missing capabilities: ${error.details.missingCapabilities.join(", ")}`);
    }
    if (error.details.missingSecrets?.length) {
      lines.push(`missing secret handles: ${error.details.missingSecrets.join(", ")}`);
    }
    if (error.details.refusedSecrets?.length) {
      lines.push(`refused secret handles: ${error.details.refusedSecrets.join(", ")}`);
    }
    if (error.details.agentRef) {
      lines.push(`agent scope: ${error.details.agentRef}`);
    }
    if (error.details.schemaPath) {
      lines.push(`schema path: ${error.details.schemaPath}`);
    }
    if (error.details.expectedTypeRef) {
      lines.push(`expected type: ${error.details.expectedTypeRef}`);
    }
    if (error.details.actualType) {
      lines.push(`actual type: ${error.details.actualType}`);
    }
    if (error.details.missingFields?.length) {
      lines.push(`missing fields: ${error.details.missingFields.join(", ")}`);
    }
    if (error.details.unknownFields?.length) {
      lines.push(`unknown fields: ${error.details.unknownFields.join(", ")}`);
    }

    lines.push(bindingGuidance(toolRef));
  }
  if (approvalRef) {
    lines.push(`human approval: ${approvalRef}`);
    if (error.details.decision) {
      lines.push(`decision: ${error.details.decision}`);
    }
  }
  if (interactionRef) {
    lines.push(`user interaction: ${interactionRef}`);
    if (error.details.mode) {
      lines.push(`mode: ${error.details.mode}`);
    }
  }
  if (agentRef && error.code?.startsWith?.("Agent")) {
    lines.push(`agent: ${agentRef}`);
    if (error.details.targetRef) {
      lines.push(`selected capability: ${error.details.targetRef}`);
    }
    if (error.details.allowedRefs?.length) {
      lines.push(`allowed capabilities: ${error.details.allowedRefs.join(", ")}`);
    }
    if (error.details.missingFields?.length) {
      lines.push(`missing fields: ${error.details.missingFields.join(", ")}`);
    }
    if (error.details.unknownFields?.length) {
      lines.push(`unknown fields: ${error.details.unknownFields.join(", ")}`);
    }
    if (error.details.secretHandlesRefused?.length) {
      lines.push(`refused secret handles: ${error.details.secretHandlesRefused.join(", ")}`);
    }
  }
  if (triggerRef && error.code?.startsWith?.("Trigger")) {
    lines.push(`trigger: ${triggerRef}`);
    if (error.details.schedule) {
      lines.push(`schedule: ${error.details.schedule}`);
    }
    if (error.details.reason) {
      lines.push(`reason: ${error.details.reason}`);
    }
    if (error.details.sourceKind) {
      lines.push(`source kind: ${error.details.sourceKind}`);
    }
    lines.push("supported local trigger runner schedule: every <n>s, every <n>m or every <n>h");
  }

  return `${lines.join("\n")}\n`;
}

function formatFailureTraceDiagnostic(trace) {
  const failureEvent = [...(trace.events ?? [])]
    .reverse()
    .find((event) => event.kind === "failure_detected" && event.message);

  if (!failureEvent) {
    return "";
  }

  return formatRuntimeError(
    new ToubaRuntimeError(
      failureEvent.payload?.runtime_error_code ?? "RuntimeFailure",
      failureEvent.message,
      {
        ...parseToolFailureDetails(failureEvent.message),
        toolRef: failureEvent.payload?.tool_ref ?? parseToolFailureDetails(failureEvent.message).toolRef,
        missingCapability: failureEvent.payload?.missing_capability,
        missingCapabilities: failureEvent.payload?.missing_capabilities,
        missingSecrets: failureEvent.payload?.missing_secret_handles,
        refusedSecrets: failureEvent.payload?.secret_handles_refused,
        agentRef: failureEvent.payload?.agent_ref,
        schemaPath: failureEvent.payload?.schema_path,
        expectedTypeRef: failureEvent.payload?.expected_type_ref,
        actualType: failureEvent.payload?.actual_type,
        missingFields: failureEvent.payload?.missing_fields,
        unknownFields: failureEvent.payload?.unknown_fields,
        approvalRef: failureEvent.payload?.approval_ref,
        decision: failureEvent.payload?.decision,
        interactionRef: failureEvent.payload?.interaction_ref,
        mode: failureEvent.payload?.mode,
        targetRef: failureEvent.payload?.selected_ref,
        allowedRefs: failureEvent.payload?.allowed_refs,
      },
    ),
  );
}

function formatBudgetTraceDiagnostic(trace) {
  const events = trace.events ?? [];
  const budgetEvent = [...events]
    .reverse()
    .find((event) => event.kind === "budget_limit_exceeded")
    ?? [...events]
      .reverse()
      .find((event) => event.kind === "dispatch_refused_budget_exceeded");

  if (!budgetEvent) {
    return "";
  }

  const payload = budgetEvent.payload ?? {};
  const budgetKind = payload.budget_kind ?? "budget";
  const refused = [...events]
    .reverse()
    .find((event) =>
      event.kind === "dispatch_refused_budget_exceeded"
      && event.payload?.budget_kind === budgetKind,
    );
  const code = refused?.payload?.runtime_error_code
    ?? payload.runtime_error_code
    ?? budgetErrorCodeForKind(budgetKind);
  const lines = [`budget error [${code}]: ${budgetKind} refused`];
  if (payload.reason) {
    lines.push(`reason: ${payload.reason}`);
  }
  if (payload.limit_value !== undefined) {
    lines.push(`limit: ${payload.limit_value}`);
  }
  if (payload.consumed_value !== undefined) {
    lines.push(`consumed: ${payload.consumed_value}`);
  }
  if (payload.attempted_value !== undefined) {
    lines.push(`attempted: ${payload.attempted_value}`);
  }
  if (payload.authority_source) {
    lines.push(`authority: ${payload.authority_source}`);
  }
  if (payload.target_ref) {
    lines.push(`target: ${payload.target_ref}`);
  }
  if (payload.caller_ref) {
    lines.push(`caller: ${payload.caller_ref}`);
  }
  if (payload.agent_ref) {
    lines.push(`agent: ${payload.agent_ref}`);
  }
  lines.push("adjust AIR budgets, manifest run_limits or CLI BQ-1 options before rerunning");
  return `${lines.join("\n")}\n`;
}

function budgetErrorCodeForKind(budgetKind) {
  if (budgetKind === "max_run_ms") {
    return "RunTimeBudgetExceeded";
  }
  if (budgetKind === "max_steps") {
    return "StepBudgetExceeded";
  }
  if (budgetKind === "max_tool_calls") {
    return "ToolCallBudgetExceeded";
  }
  if (budgetKind === "max_agent_invocations") {
    return "AgentInvocationBudgetExceeded";
  }
  if (budgetKind === "max_provider_calls") {
    return "AgentDecisionProviderBudgetExceeded";
  }
  if (budgetKind === "max_runs_per_day") {
    return "TriggerQuotaExceeded";
  }
  return "BudgetExceeded";
}

function formatTriggerTraceDiagnostic(trace) {
  const refused = [...(trace.events ?? [])]
    .reverse()
    .find((event) => event.kind === "trigger_event_refused");
  if (!refused) {
    return "";
  }
  const payload = refused.payload ?? {};
  const lines = [
    `trigger error [${payload.runtime_error_code ?? "TriggerRefused"}]: trigger refused ${payload.trigger_ref ?? "trigger:unknown"}`,
  ];
  if (payload.event_id) {
    lines.push(`event id: ${payload.event_id}`);
  }
  if (payload.source_kind) {
    lines.push(`source kind: ${payload.source_kind}`);
  }
  if (payload.reason) {
    lines.push(`reason: ${payload.reason}`);
  }
  if (payload.target_ref) {
    lines.push(`target: ${payload.target_ref}`);
  }
  if (payload.expected_source_kind) {
    lines.push(`expected source kind: ${payload.expected_source_kind}`);
  }
  if (payload.manifest_source_kind) {
    lines.push(`manifest source kind: ${payload.manifest_source_kind}`);
  }
  if (payload.limit_ref) {
    lines.push(`limit: ${payload.limit_ref}`);
  }
  lines.push("provide --manifest <path> with a matching enabled trigger entry; provide --trigger-event-json or --trigger-event explicitly");
  return `${lines.join("\n")}\n`;
}

function parseToolFailureDetails(message) {
  const missingPrefix = "missing tool binding ";
  if (message.startsWith(missingPrefix)) {
    return { toolRef: extractToolRef(message) ?? message.slice(missingPrefix.length) };
  }

  const failedPrefix = "tool handler failed ";
  if (message.startsWith(failedPrefix)) {
    const rest = message.slice(failedPrefix.length);
    const causeSeparator = rest.indexOf(": ");
    if (causeSeparator >= 0) {
      return {
        toolRef: rest.slice(0, causeSeparator),
        cause: rest.slice(causeSeparator + 2),
      };
    }
    return { toolRef: rest };
  }

  return { toolRef: extractToolRef(message) };
}

function extractToolRef(message) {
  return message.match(/tool:[^\s:,)]+/u)?.[0];
}

function bindingGuidance(toolRef) {
  if (toolRef === LINEAR_FETCH_SOURCE_TOOL_REF) {
    return "available local binding: --local-fetch-source-text <text> (cannot be combined with --stubs)";
  }
  if (toolRef === STRATEGY_APPLY_CHANGE_TOOL_REF) {
    return "available local binding: --local-apply-change-summary <text> (cannot be combined with --stubs)";
  }

  return "provide --manifest <path> with a matching touba-manifest-v1 binding; add --secrets <path> when the tool declares required secrets";
}

async function runTriggerScheduleRunner(document, parsedArgs, executionOptions, triggerState = undefined) {
  const triggerRef = parsedArgs.triggerRef;
  const trigger = (document.definitions?.triggers ?? []).find((candidate) => candidate.id === triggerRef);
  if (!trigger) {
    throw new ToubaRuntimeError("TriggerUnknown", `trigger not found ${triggerRef}`, { triggerRef });
  }
  if (trigger.event?.kind !== "schedule") {
    throw new ToubaRuntimeError(
      "TriggerScheduleUnsupported",
      `trigger runner supports only schedule triggers ${triggerRef}`,
      {
        triggerRef,
        sourceKind: trigger.event?.kind,
      },
    );
  }

  const schedule = parseTriggerRunnerSchedule(trigger.event.value);
  if (!schedule.ok) {
    throw new ToubaRuntimeError(
      "TriggerScheduleUnsupported",
      `unsupported trigger schedule ${JSON.stringify(trigger.event.value)}`,
      {
        triggerRef,
        schedule: trigger.event.value,
        reason: schedule.reason,
      },
    );
  }

  const runResults = [];
  for (let runIndex = 1; runIndex <= parsedArgs.triggerRunnerMaxRuns; runIndex += 1) {
    await sleep(schedule.delayMs);
    const event = {
      trigger_ref: triggerRef,
      event_id: localTriggerEventId(trigger, runIndex),
      source_kind: "schedule",
    };
    const runResult = await executeTriggerEventWithState(document, event, {
      ...executionOptions,
      runId: `trigger-runner-${runIndex}`,
      triggerRunCounts: {
        [triggerRef]: triggerState
          ? countAcceptedTriggerEvents(triggerState.document, triggerRef, currentTriggerDayKey())
          : 0,
      },
    }, triggerState);
    runResults.push({ event, result: runResult });
    if (runResult.status === "failure") {
      return runResult;
    }
  }

  if (runResults.length === 1) {
    return runResults[0].result;
  }

  return aggregateTriggerRunnerResults(document, triggerRef, runResults);
}

async function executeTriggerEventWithState(document, triggerEvent, executionOptions, triggerState = undefined) {
  if (!triggerState) {
    return executeTriggerEvent(document, triggerEvent, executionOptions);
  }
  const event = normalizeStateTriggerEvent(triggerEvent);
  if (event.triggerRef && event.eventId && isTriggerEventConsumed(triggerState.document, event.triggerRef, event.eventId)) {
    const result = replayRejectedResult(document, event, executionOptions.runId);
    recordTriggerStateEvent(triggerState.document, event, result);
    saveTriggerState(triggerState);
    return result;
  }

  const result = await executeTriggerEvent(document, triggerEvent, {
    ...executionOptions,
    triggerRunCounts: event.triggerRef
      ? {
        ...(executionOptions.triggerRunCounts ?? {}),
        [event.triggerRef]: countAcceptedTriggerEvents(triggerState.document, event.triggerRef, currentTriggerDayKey()),
      }
      : executionOptions.triggerRunCounts,
  });
  recordTriggerStateEvent(triggerState.document, event, result);
  saveTriggerState(triggerState);
  return result;
}

function loadTriggerStateFromPath(filePath) {
  const resolvedPath = resolve(filePath);
  assertTriggerStatePath(resolvedPath);
  if (!existsSync(resolvedPath)) {
    return {
      path: resolvedPath,
      document: emptyTriggerState(),
    };
  }
  let document;
  try {
    document = parseJsonObject(readFileSync(resolvedPath, "utf8"), `trigger state ${filePath}`);
  } catch (error) {
    error.code = "TriggerStateReadFailed";
    throw error;
  }
  if (document.trigger_state_schema_version !== TRIGGER_STATE_SCHEMA_VERSION) {
    const error = new Error(`trigger_state_schema_version must be ${TRIGGER_STATE_SCHEMA_VERSION}`);
    error.code = "TriggerStateSchemaMismatch";
    throw error;
  }
  if (!document.triggers || typeof document.triggers !== "object" || Array.isArray(document.triggers)) {
    const error = new Error("trigger state triggers must be an object");
    error.code = "TriggerStateSchemaMismatch";
    throw error;
  }
  for (const [triggerRef, state] of Object.entries(document.triggers)) {
    if (!triggerRef.startsWith("trigger:")) {
      const error = new Error("trigger state keys must be trigger refs");
      error.code = "TriggerStateSchemaMismatch";
      throw error;
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      const error = new Error(`trigger state entry must be an object for ${triggerRef}`);
      error.code = "TriggerStateSchemaMismatch";
      throw error;
    }
    if (!Array.isArray(state.events)) {
      const error = new Error(`trigger state events must be an array for ${triggerRef}`);
      error.code = "TriggerStateSchemaMismatch";
      throw error;
    }
  }
  return {
    path: resolvedPath,
    document: normalizeTriggerStateDocument(document),
  };
}

function assertTriggerStatePath(filePath) {
  if (!basename(filePath).endsWith(".trigger-state.json")) {
    const error = new Error("trigger state path must end with .trigger-state.json");
    error.code = "TriggerStatePathInvalid";
    throw error;
  }
}

function emptyTriggerState() {
  return {
    trigger_state_schema_version: TRIGGER_STATE_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    triggers: {},
  };
}

function normalizeTriggerStateDocument(document) {
  const normalized = {
    trigger_state_schema_version: TRIGGER_STATE_SCHEMA_VERSION,
    created_at: typeof document.created_at === "string" ? document.created_at : new Date().toISOString(),
    updated_at: typeof document.updated_at === "string" ? document.updated_at : undefined,
    triggers: {},
  };
  for (const [triggerRef, state] of Object.entries(document.triggers ?? {})) {
    const events = state.events
      .filter((event) => event && typeof event === "object" && !Array.isArray(event))
      .map((event) => ({
        event_id: typeof event.event_id === "string" ? event.event_id : undefined,
        source_kind: typeof event.source_kind === "string" ? event.source_kind : undefined,
        status: event.status === "accepted" ? "accepted" : "refused",
        reason: typeof event.reason === "string" ? event.reason : undefined,
        observed_at: typeof event.observed_at === "string" ? event.observed_at : undefined,
        day_key: typeof event.day_key === "string" ? event.day_key : triggerDayKeyFromObservedAt(event.observed_at),
        run_id: typeof event.run_id === "string" ? event.run_id : undefined,
      }))
      .filter((event) => event.event_id);
    normalized.triggers[triggerRef] = summarizeTriggerStateEntry(events);
  }
  return normalized;
}

function summarizeTriggerStateEntry(events) {
  const accepted = events.filter((event) => event.status === "accepted");
  const refused = events.filter((event) => event.status === "refused");
  const consumed = [...new Set(accepted.map((event) => event.event_id))].sort();
  const last = events.at(-1);
  return {
    accepted_count: accepted.length,
    refused_count: refused.length,
    consumed_event_ids: consumed,
    last_event_id: last?.event_id,
    last_status: last?.status,
    updated_at: last?.observed_at,
    events,
  };
}

function saveTriggerState(triggerState) {
  triggerState.document.updated_at = new Date().toISOString();
  mkdirSync(dirname(triggerState.path), { recursive: true });
  writeFileSync(triggerState.path, serializeJson(triggerState.document), "utf8");
}

function normalizeStateTriggerEvent(event) {
  return {
    triggerRef: normalizedString(event?.trigger_ref ?? event?.triggerRef),
    eventId: normalizedString(event?.event_id ?? event?.eventId),
    sourceKind: normalizedString(event?.source_kind ?? event?.sourceKind),
  };
}

function isTriggerEventConsumed(state, triggerRef, eventId) {
  return Boolean(state.triggers?.[triggerRef]?.consumed_event_ids?.includes(eventId));
}

function countAcceptedTriggerEvents(state, triggerRef, dayKey = currentTriggerDayKey()) {
  const events = state.triggers?.[triggerRef]?.events;
  if (!Array.isArray(events)) {
    return 0;
  }
  return events.filter((event) =>
    event?.status === "accepted"
    && triggerStateEventDayKey(event) === dayKey,
  ).length;
}

function recordTriggerStateEvent(state, event, result) {
  if (!event.triggerRef || !event.eventId) {
    return;
  }
  const accepted = hasAcceptedTriggerEvent(result.trace, event.triggerRef, event.eventId);
  const refused = lastTriggerRefusal(result.trace, event.triggerRef, event.eventId);
  const observedAt = new Date().toISOString();
  const previous = state.triggers[event.triggerRef]?.events ?? [];
  const recorded = {
    event_id: event.eventId,
    source_kind: event.sourceKind,
    status: accepted ? "accepted" : "refused",
    reason: accepted ? undefined : refused?.payload?.reason ?? "execution_failed",
    observed_at: observedAt,
    day_key: triggerDayKeyFromObservedAt(observedAt),
    run_id: result.trace?.run?.run_id,
  };
  state.triggers[event.triggerRef] = summarizeTriggerStateEntry([...previous, recorded]);
}

function currentTriggerDayKey() {
  return triggerDayKeyFromObservedAt(new Date().toISOString());
}

function triggerDayKeyFromObservedAt(observedAt) {
  if (typeof observedAt !== "string") {
    return undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T/u.exec(observedAt);
  return match?.[1];
}

function triggerStateEventDayKey(event) {
  return typeof event.day_key === "string"
    ? event.day_key
    : triggerDayKeyFromObservedAt(event.observed_at);
}

function hasAcceptedTriggerEvent(trace, triggerRef, eventId) {
  return Boolean(
    trace?.events?.some(
      (event) =>
        event.kind === "trigger_event_accepted" &&
        event.payload?.trigger_ref === triggerRef &&
        (event.payload?.event_id === undefined || event.payload?.event_id === eventId),
    ),
  );
}

function lastTriggerRefusal(trace, triggerRef, eventId) {
  return [...(trace?.events ?? [])]
    .reverse()
    .find(
      (event) =>
        event.kind === "trigger_event_refused" &&
        event.payload?.trigger_ref === triggerRef &&
        (event.payload?.event_id === undefined || event.payload?.event_id === eventId),
    );
}

function replayRejectedResult(document, event, runId = undefined) {
  const effectiveRunId = runId ?? "trigger-replay-rejected";
  const trace = {
    trace_protocol_version: "trace-minimal-v0.1",
    run: {
      module_ref: document.module?.id,
      entry_ref: event.triggerRef,
      run_id: effectiveRunId,
    },
    events: [
      traceEvent(effectiveRunId, 0, "run_started", {
        entry_ref: event.triggerRef,
      }),
      traceEvent(effectiveRunId, 1, "trigger_event_received", {
        trigger_ref: event.triggerRef,
        event_id: event.eventId,
        source_kind: event.sourceKind,
      }),
      traceEvent(effectiveRunId, 2, "trigger_event_refused", {
        trigger_ref: event.triggerRef,
        event_id: event.eventId,
        source_kind: event.sourceKind,
        reason: "event_replay",
        runtime_error_code: "TriggerReplayRejected",
      }),
      traceEvent(effectiveRunId, 3, "run_completed", {
        status: "failure",
      }),
    ],
  };
  return {
    status: "failure",
    result: null,
    trace,
  };
}

function traceEvent(runId, sequenceIndex, kind, payload) {
  return {
    event_id: `event:${runId}:${sequenceIndex + 1}`,
    run_id: runId,
    sequence_index: sequenceIndex,
    kind,
    payload,
  };
}

function parseTriggerRunnerSchedule(value) {
  if (typeof value !== "string") {
    return { ok: false, reason: "schedule_not_text" };
  }
  const match = /^every ([1-9][0-9]*)(s|m|h)$/u.exec(value.trim());
  if (!match) {
    return { ok: false, reason: "unsupported_interval_format" };
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) {
    return { ok: false, reason: "interval_not_safe_integer" };
  }
  const unitMs = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
  }[match[2]];
  const delayMs = amount * unitMs;
  if (!Number.isSafeInteger(delayMs) || delayMs > 2147483647) {
    return { ok: false, reason: "interval_exceeds_timer_limit" };
  }
  return {
    ok: true,
    delayMs,
    interval: {
      amount,
      unit: match[2],
    },
  };
}

function localTriggerEventId(trigger, runIndex) {
  const safeName = String(trigger.name ?? "trigger")
    .replaceAll(/[^A-Za-z0-9_-]/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    || "trigger";
  return `evt-local-${safeName}-${Date.now()}-${runIndex}`;
}

function aggregateTriggerRunnerResults(document, triggerRef, runResults) {
  return {
    status: "success",
    result: runResults.map(({ event, result }) => ({
      event_id: event.event_id,
      status: result.status,
      result: result.result ?? null,
    })),
    trace: {
      trace_protocol_version: "trace-minimal-v0.1",
      run: {
        module_ref: document.module?.id,
        entry_ref: triggerRef,
        run_id: "trigger-runner",
      },
      events: runResults.flatMap(({ result }) => result.trace?.events ?? []),
    },
  };
}

function dryRunTriggerEvent(document, triggerEvent, toolBindingManifest) {
  const checks = [];
  const event = normalizeCliTriggerEvent(triggerEvent);
  const base = {
    mode: "trigger_dry_run",
    trigger_ref: event.trigger_ref,
    event_id: event.event_id,
    source_kind: event.source_kind,
    checks,
  };

  if (!event.trigger_ref || !event.event_id || !event.source_kind) {
    return refusedDryRun(base, checks, "payload", "TriggerPayloadInvalid", "invalid_trigger_event");
  }
  checks.push(checkOk("payload", {
    trigger_ref: event.trigger_ref,
    event_id: event.event_id,
    source_kind: event.source_kind,
  }));

  const trigger = (document.definitions?.triggers ?? []).find((candidate) => candidate.id === event.trigger_ref);
  if (!trigger) {
    return refusedDryRun(base, checks, "air_trigger", "TriggerUnknown", "trigger_unknown");
  }
  checks.push(checkOk("air_trigger", {
    trigger_ref: trigger.id,
  }));

  if (trigger.target_kind !== "strategy") {
    return refusedDryRun(base, checks, "target_kind", "TriggerTargetKindUnsupported", "target_kind_unsupported", {
      target_ref: trigger.target_ref,
      target_kind: trigger.target_kind,
    });
  }
  checks.push(checkOk("target_kind", {
    target_kind: trigger.target_kind,
  }));

  const target = (document.definitions?.strategies ?? []).find((candidate) => candidate.id === trigger.target_ref);
  if (!target) {
    return refusedDryRun(base, checks, "target_ref", "TriggerTargetMissing", "target_missing", {
      target_ref: trigger.target_ref,
    });
  }
  checks.push(checkOk("target_ref", {
    target_ref: target.id,
  }));

  if (!toolBindingManifest) {
    return refusedDryRun(base, checks, "manifest", "TriggerDisabled", "manifest_missing");
  }
  checks.push(checkOk("manifest", {
    manifest_version: toolBindingManifest.version,
  }));

  const manifestTrigger = toolBindingManifest.triggers.get(event.trigger_ref);
  if (!manifestTrigger) {
    return refusedDryRun(base, checks, "manifest_trigger", "TriggerDisabled", "trigger_not_enabled");
  }
  checks.push(checkOk("manifest_trigger", {
    trigger_ref: event.trigger_ref,
  }));

  if (manifestTrigger.enabled !== true) {
    return refusedDryRun(base, checks, "manifest_enabled", "TriggerDisabled", "trigger_disabled");
  }
  checks.push(checkOk("manifest_enabled", {
    enabled: true,
  }));

  if (event.source_kind !== trigger.event?.kind) {
    return refusedDryRun(base, checks, "event_source", "TriggerSourceMismatch", "event_source_mismatch", {
      expected_source_kind: trigger.event?.kind,
    });
  }
  checks.push(checkOk("event_source", {
    source_kind: event.source_kind,
  }));

  if (manifestTrigger.source?.kind !== trigger.event?.kind) {
    return refusedDryRun(base, checks, "manifest_source", "TriggerSourceMismatch", "manifest_source_mismatch", {
      manifest_source_kind: manifestTrigger.source?.kind,
      expected_source_kind: trigger.event?.kind,
    });
  }
  checks.push(checkOk("manifest_source", {
    source_kind: manifestTrigger.source.kind,
  }));

  const limits = effectiveCliTriggerLimits(trigger, manifestTrigger);
  if (!limits.ok) {
    return refusedDryRun(base, checks, "limits", "TriggerLimitExceeded", limits.reason, {
      limits: limits.details,
    });
  }
  checks.push(checkOk("limits", {
    max_runs_per_day: limits.value.max_runs_per_day,
    timeout_ms: limits.value.timeout_ms,
  }));

  checks.push(checkOk("target_arguments", {
    argument_count: Array.isArray(trigger.arguments) ? trigger.arguments.length : 0,
  }));

  return {
    ...base,
    status: "accepted",
    target_ref: trigger.target_ref,
    limits: limits.value,
  };
}

function normalizeCliTriggerEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return {
      trigger_ref: null,
      event_id: null,
      source_kind: null,
    };
  }
  return {
    trigger_ref: normalizedString(event.trigger_ref ?? event.triggerRef),
    event_id: normalizedString(event.event_id ?? event.eventId),
    source_kind: normalizedString(event.source_kind ?? event.sourceKind ?? event.kind),
  };
}

function normalizedString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function effectiveCliTriggerLimits(trigger, manifestTrigger) {
  const airLimits = trigger.limits;
  if (
    !airLimits
    || !Number.isSafeInteger(airLimits.max_runs_per_day)
    || airLimits.max_runs_per_day <= 0
    || !Number.isSafeInteger(airLimits.timeout_ms)
    || airLimits.timeout_ms <= 0
  ) {
    return {
      ok: false,
      reason: "air_limits_invalid",
      details: {
        air: airLimits ?? null,
      },
    };
  }

  const maxRunsPerDay = manifestTrigger.limits?.max_runs_per_day ?? airLimits.max_runs_per_day;
  const timeoutMs = manifestTrigger.limits?.timeout_ms ?? airLimits.timeout_ms;
  if (maxRunsPerDay > airLimits.max_runs_per_day || timeoutMs > airLimits.timeout_ms) {
    return {
      ok: false,
      reason: "manifest_limit_exceeds_air",
      details: {
        air: {
          max_runs_per_day: airLimits.max_runs_per_day,
          timeout_ms: airLimits.timeout_ms,
        },
        manifest: {
          max_runs_per_day: maxRunsPerDay,
          timeout_ms: timeoutMs,
        },
      },
    };
  }

  return {
    ok: true,
    value: {
      max_runs_per_day: maxRunsPerDay,
      timeout_ms: timeoutMs,
    },
  };
}

function refusedDryRun(base, checks, check, runtimeErrorCode, reason, details = {}) {
  checks.push({
    check,
    status: "refused",
    runtime_error_code: runtimeErrorCode,
    reason,
    ...details,
  });
  return {
    ...base,
    status: "refused",
    runtime_error_code: runtimeErrorCode,
    reason,
    ...details,
  };
}

function checkOk(check, details = {}) {
  return {
    check,
    status: "ok",
    ...details,
  };
}

function buildStubHandlers(document) {
  const handlers = {};
  for (const tool of document.definitions?.tools ?? []) {
    handlers[tool.id] = ({ toolRef }) => {
      process.stderr.write(`[corpus-stub] tool ${toolRef} called — returning null\n`);
      return null;
    };
  }
  return handlers;
}
