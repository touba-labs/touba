import { closeSync, constants, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openCliEffectJournal } from "./effect-journal.mjs";
import { writeParallelCheckpoint } from "./parallel-checkpoint-file.mjs";
import { loadPythonHost } from "./python-host.mjs";
import { openLocalHandlerDiagnostics } from "../../../runtime/touba-runtime/src/handler-diagnostics.mjs";
import { resolvedSecretEntries } from "../../../runtime/touba-runtime/src/secret-redaction.mjs";
import { requiredResourceReferences } from "../../../contracts/resource-bindings.mjs";
import { publicRunResult, runExitCode } from "../../../contracts/run-outcome.mjs";
import { loadSkillPack } from "../../touba-project/src/skill-packs.mjs";
import { verifyManifestPackages } from "../../touba-project/src/handler-packages.mjs";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { TraceBuilder } from "../../../runtime/touba-runtime/src/trace-builder.mjs";
import { validateTraceMachineContract } from "../../../contracts/machine/contracts.mjs";
import { createAdmissionRefusalTrace } from "../../../runtime/touba-runtime/src/admission-trace.mjs";
import { HARDENED_ERROR_CODES } from "../../../runtime/touba-runtime/src/hardened-execution-profile.mjs";
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

// Shared admission path: each invocation owns its arguments, output and runtime state.
export async function executeRunCommand(args, { stdout = process.stdout, stderr = process.stderr, signal } = {}) {

const RUN_PLAN_SCHEMA_VERSION = "touba-run-plan-v1";
const RUN_EVIDENCE_SCHEMA_VERSION = "touba-run-evidence-v1";
const RUN_SUMMARY_SCHEMA_VERSION = "touba-run-summary-v1";
const BINDING_FRAGMENT_SCHEMA_VERSION = "touba-binding-fragment-v1";
const RESOURCE_BINDINGS_SCHEMA_VERSION = "touba-resource-bindings-v1";
const RUN_OUTPUT_MODES = new Set(["show", "result", "trace", "all", "run-summary", "json"]);
const TRIGGER_STATE_SCHEMA_VERSION = "touba-trigger-state-v1";
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
const pythonHosts = [];

// Flush this invocation's output before returning its explicit exit status.
async function exitAfterFlush(code) {
  for (const host of pythonHosts) host.close();
  await Promise.all([stdout, stderr].map(stream =>
    new Promise((resolve, reject) => stream.write("", error => error ? reject(error) : resolve()))));
  return code;
}

async function refuseAdmission(code, stage, exitCode = 1) {
  const trace = createAdmissionRefusalTrace(code, stage);
  if (parsedArgs.traceOutPath !== undefined) {
    try {
      writeFileSync(parsedArgs.traceOutPath, serializeJson(trace), "utf8");
    } catch {
      stderr.write("error: admission refusal trace could not be written\n");
    }
  }
  if (parsedArgs.outputMode === "json") {
    stdout.write(serializeJson(publicRunResult({ status: "failure", reason: code,
      result: null, messages: [], trace })));
  }
  return await exitAfterFlush(exitCode);
}

if (parsedArgs.error) {
  stderr.write(`error: ${parsedArgs.error}\n`);
  printUsage();
  return await refuseAdmission("ArgumentsInvalid", "arguments", 2);
}

if (parsedArgs.runPlanPath !== undefined) {
  try {
    const runPlan = loadRunPlanFromPath(parsedArgs.runPlanPath);
    applyRunPlan(parsedArgs, runPlan);
    applyRunPlanProfileDefaults(parsedArgs);
  } catch (e) {
    stderr.write(`run plan error [${e.code ?? "RunPlanInvalid"}]: ${e.message}\n`);
    return await refuseAdmission("RunPlanInvalid", "run_plan", 1);
  }
}

const parsedArgsError = validateParsedArgsAfterRunPlan(parsedArgs);
if (parsedArgs.handlerDiagnosticsPath !== undefined && (parsedArgs.runPlanProfile !== "dev"
    || parsedArgs.requireSupplyChainLock || parsedArgs.hardenedProfilePath !== undefined || process.platform === "win32")) {
  stderr.write("error: local handler diagnostics require an explicit dev run plan on a POSIX host, without production or hardened execution\n");
  return await refuseAdmission("HandlerDiagnosticsForbidden", "arguments", 2);
}
if (parsedArgsError) {
  if (typeof parsedArgsError === "object") {
    stderr.write(`run plan error [${parsedArgsError.code}]: ${parsedArgsError.message}\n`);
    return await refuseAdmission("RunPlanInvalid", "run_plan", 1);
  } else {
    stderr.write(`error: ${parsedArgsError}\n`);
    printUsage();
    return await refuseAdmission("ArgumentsInvalid", "arguments", 2);
  }
}

if (parsedArgs.positional.length !== 1) {
  printUsage();
  return await refuseAdmission("ArgumentsInvalid", "arguments", 2);
}

const filePath = parsedArgs.positional[0];
let json;
try {
  json = readFileSync(filePath, "utf8");
} catch (e) {
  stderr.write(`error: cannot read ${filePath}: ${e.message}\n`);
  return await refuseAdmission("AirUnreadable", "air", 2);
}

let document;
try {
  document = loadAirFromJson(json);
} catch (e) {
  stderr.write(`error: invalid AIR JSON: ${e.message}\n`);
  return await refuseAdmission("AirInvalid", "air", 1);
}

if (parsedArgs.runPlanPath !== undefined) {
  try {
    validateRunPlanAgainstAir(parsedArgs, document, filePath);
  } catch (e) {
    stderr.write(`run plan error [${e.code ?? "RunPlanInvalid"}]: ${e.message}\n`);
    return await refuseAdmission("RunPlanInvalid", "run_plan", 1);
  }
}

let skillPacks;
try {
  skillPacks = parsedArgs.skillPackPaths.map(path => loadSkillPack(path, document));
} catch (error) {
  const code = error.code ?? "SkillPackInvalid";
  stderr.write(`skill pack error [${code}]: ${error.message}\n`);
  return await refuseAdmission(/^(SkillPack|Package)[A-Za-z]+$/.test(code) ? code : "SkillPackInvalid", "skill_pack", 1);
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
    stderr.write(`resource bindings error [${e.code ?? "ResourceBindingsInvalid"}]: ${e.message}\n`);
    return await refuseAdmission(e instanceof ResourceBindingsCliError ? e.code : "ResourceBindingsInvalid", "resources", 1);
  }
}

const toolHandlers = {};

let toolBindingManifest;
if (parsedArgs.manifestPath !== undefined) {
  try {
    toolBindingManifest = loadManifestFromPath(parsedArgs.manifestPath);
  } catch (e) {
    stderr.write(`error: invalid manifest ${parsedArgs.manifestPath}: ${e.message}\n`);
    return await refuseAdmission("ManifestInvalid", "manifest", 1);
  }
}

let supplyChainValidated = false;
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
    stderr.write(formatSupplyChainGateError(supplyChainGate));
    return await refuseAdmission("SupplyChainAdmissionRefused", "supply_chain", 1);
  }
  supplyChainValidated = true;
}

let hardenedExecutionProfile;
if (parsedArgs.hardenedProfilePath !== undefined) {
  try {
    hardenedExecutionProfile = parseJsonObject(
      readFileSync(parsedArgs.hardenedProfilePath, "utf8"),
      `hardened execution profile ${parsedArgs.hardenedProfilePath}`,
    );
  } catch (e) {
    stderr.write(`error: invalid hardened execution profile ${parsedArgs.hardenedProfilePath}: ${e.message}\n`);
    return await refuseAdmission("HardenedProfileInvalid", "profile", 1);
  }
}

let secretStore;
if (parsedArgs.secretsPath !== undefined) {
  try {
    secretStore = loadSecretsFromPath(parsedArgs.secretsPath);
  } catch (e) {
    stderr.write(`error: invalid secrets file ${parsedArgs.secretsPath}: ${e.message}\n`);
    return await refuseAdmission("SecretsInvalid", "secrets", 1);
  }
}

let inputs = {};
if (parsedArgs.inputsJson !== undefined) {
  try {
    inputs = JSON.parse(parsedArgs.inputsJson);
  } catch (e) {
    stderr.write(`error: invalid --inputs-json: ${e.message}\n`);
    return await refuseAdmission("InputsInvalid", "inputs", 2);
  }
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    stderr.write("error: --inputs-json must decode to a JSON object\n");
    return await refuseAdmission("InputsInvalid", "inputs", 2);
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
    stderr.write(`error: invalid human decisions ${parsedArgs.humanDecisionsPath}: ${e.message}\n`);
    return await refuseAdmission("HumanDecisionsInvalid", "human_decisions", 1);
  }
}
if (parsedArgs.humanDecisionsJson !== undefined) {
  try {
    humanApprovalDecisions = parseJsonObject(parsedArgs.humanDecisionsJson, "--human-decisions-json");
  } catch (e) {
    stderr.write(`error: invalid --human-decisions-json: ${e.message}\n`);
    return await refuseAdmission("HumanDecisionsInvalid", "human_decisions", 2);
  }
}

let humanApprovalResumeCheckpoint;
const resumeCheckpointPath = parsedArgs.parallelResumeCheckpointPath ?? parsedArgs.humanResumeCheckpointPath;
if (resumeCheckpointPath !== undefined) {
  try {
    humanApprovalResumeCheckpoint = parseJsonObject(
      readFileSync(resumeCheckpointPath, "utf8"),
      `human resume checkpoint ${parsedArgs.humanResumeCheckpointPath}`,
    );
  } catch (e) {
    stderr.write(`error: invalid human resume checkpoint ${parsedArgs.humanResumeCheckpointPath}: ${e.message}\n`);
    return await refuseAdmission("HumanCheckpointInvalid", "checkpoint", 1);
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
    stderr.write(`error: invalid user inputs ${parsedArgs.userInputsPath}: ${e.message}\n`);
    return await refuseAdmission("UserInputsInvalid", "user_inputs", 1);
  }
}
if (parsedArgs.userInputsJson !== undefined) {
  try {
    userInputs = parseJsonObject(parsedArgs.userInputsJson, "--user-inputs-json");
  } catch (e) {
    stderr.write(`error: invalid --user-inputs-json: ${e.message}\n`);
    return await refuseAdmission("UserInputsInvalid", "user_inputs", 2);
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
    stderr.write(`error: invalid agent decisions ${parsedArgs.agentDecisionsPath}: ${e.message}\n`);
    return await refuseAdmission("AgentDecisionsInvalid", "agent_decisions", 1);
  }
}
if (parsedArgs.agentDecisionsJson !== undefined) {
  try {
    agentDecisions = parseJsonObject(parsedArgs.agentDecisionsJson, "--agent-decisions-json");
  } catch (e) {
    stderr.write(`error: invalid --agent-decisions-json: ${e.message}\n`);
    return await refuseAdmission("AgentDecisionsInvalid", "agent_decisions", 2);
  }
}

let agentDecisionProvider;
let humanApprovalHost = {};
if (parsedArgs.humanApprovalHostPath !== undefined) {
  try {
    if (parsedArgs.humanApprovalHostPath.endsWith(".py")) {
      const host = await loadPythonHost(parsedArgs.humanApprovalHostPath); pythonHosts.push(host);
      if (!host.metadata.attest) throw new Error("host must export attest_human_approval");
      humanApprovalHost = { humanApprovalAuthority: host.attest, humanApprovalInitiator: host.metadata.initiator_ref ?? undefined };
    } else {
      const host = await import(pathToFileURL(resolve(parsedArgs.humanApprovalHostPath)).href);
      if (typeof host.attestHumanApproval !== "function") throw new Error("host must export attestHumanApproval");
      humanApprovalHost = { humanApprovalAuthority: host.attestHumanApproval, humanApprovalInitiator: host.initiatorRef };
    }
  } catch {
    stderr.write("error: trusted human approval host module could not be loaded\n");
    return await refuseAdmission("HumanApprovalAuthorityUnavailable", "human_authority", 1);
  }
}
if (parsedArgs.agentDecisionProviderPath !== undefined) {
  try {
    agentDecisionProvider = await loadAgentDecisionProviderFromPath(parsedArgs.agentDecisionProviderPath);
  } catch (e) {
    stderr.write(`error: invalid agent decision provider ${parsedArgs.agentDecisionProviderPath}: ${e.message}\n`);
    return await refuseAdmission("DecisionProviderInvalid", "provider", 1);
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
    stderr.write(`error: invalid trigger event ${parsedArgs.triggerEventPath}: ${e.message}\n`);
    return await refuseAdmission("TriggerEventInvalid", "trigger", 1);
  }
}
if (parsedArgs.triggerEventJson !== undefined) {
  try {
    triggerEvent = parseJsonObject(parsedArgs.triggerEventJson, "--trigger-event-json");
  } catch (e) {
    stderr.write(`error: invalid --trigger-event-json: ${e.message}\n`);
    return await refuseAdmission("TriggerEventInvalid", "trigger", 2);
  }
}

if (parsedArgs.triggerDryRun) {
  const report = dryRunTriggerEvent(document, triggerEvent, toolBindingManifest);
  stdout.write(serializeJson(report));
  return await exitAfterFlush(report.status === "accepted" ? 0 : 1);
}

let triggerState;
if (parsedArgs.triggerStatePath !== undefined) {
  try {
    triggerState = loadTriggerStateFromPath(parsedArgs.triggerStatePath);
  } catch (e) {
    stderr.write(`trigger state error [${e.code ?? "TriggerStateInvalid"}]: ${e.message}\n`);
    return await refuseAdmission("TriggerStateInvalid", "trigger_state", 1);
  }
}

let result;
let effectHost;
let handlerDiagnostics;
const interactiveUserInputSession = parsedArgs.interactiveUserInputs
  ? createInteractiveUserInputSession()
  : null;
try {
  if (parsedArgs.handlerDiagnosticsPath !== undefined) {
    try { handlerDiagnostics = openLocalHandlerDiagnostics(parsedArgs.handlerDiagnosticsPath); }
    catch {
      stderr.write("error: handler diagnostics require a new writable private file; no existing file is overwritten\n");
      return await refuseAdmission("HandlerDiagnosticsUnavailable", "arguments", 2);
    }
    process.once("exit", handlerDiagnostics.close);
  }
  if (parsedArgs.effectJournalPath !== undefined) {
    effectHost = openCliEffectJournal(parsedArgs.effectJournalPath, resolvedSecretEntries(secretStore).map(entry => entry.value));
    process.once("exit", effectHost.close);
  }
  const effectRunId = effectHost ? (humanApprovalResumeCheckpoint?.run_id ?? `cli_${randomUUID()}`) : undefined;
  const executionOptions = {
    localHandlerDiagnostics: handlerDiagnostics,
    runId: effectRunId,
    effectScopeId: effectRunId,
    effectJournal: effectHost?.journal,
    inputs,
    toolHandlers,
    toolBindingManifest,
    resourceBindings,
    secretStore,
    humanApprovalDecisions,
    ...humanApprovalHost,
    userInputs,
    userInputProvider: interactiveUserInputSession?.provider,
    agentDecisions,
    agentDecisionProvider,
    skillPacks,
    activeSkillPackRefs: parsedArgs.activeSkillPackRefs,
    skillPackActivationReasons: Object.fromEntries(parsedArgs.activeSkillPackRefs.map(ref => [ref, "user_invoked"])),
    skillPackDiscoveryMaxBytes: parsedArgs.skillPackDiscoveryMaxBytes,
    skillPackActivationMaxBytes: parsedArgs.skillPackActivationMaxBytes,
    agentModelInputMaxBytes: parsedArgs.agentModelInputMaxBytes,
    agentDecisionProviderMetadata: parsedArgs.agentDecisionProviderMetadata,
    agentDecisionProviderContentMode: parsedArgs.agentDecisionProviderContentMode,
    agentDecisionProviderInitialMode: resolvedAgentDecisionProviderInitialMode(parsedArgs),
    agentDecisionProviderTimeoutMs: parsedArgs.agentDecisionProviderTimeoutMs,
    agentDecisionProviderMaxRetries: parsedArgs.agentDecisionProviderMaxRetries,
    maxAgentSteps: parsedArgs.maxAgentSteps,
    maxLoopIterations: parsedArgs.maxLoopIterations,
    runTimeoutMs: parsedArgs.runTimeoutMs,
    runLimits: parsedArgs.runLimits,
    cancelRequested: parsedArgs.cancelBeforeDispatch,
    cancelRequestedProvider: signal ? () => signal.aborted : undefined,
    cancelAuthoritySource: parsedArgs.cancelBeforeDispatch ? "cli" : undefined,
    cancelOnPause: parsedArgs.cancelOnPause,
    killSwitchEnabled: parsedArgs.killSwitchEnabled,
    durableHumanApprovals: parsedArgs.humanCheckpointOutPath !== undefined,
    humanApprovalResumeCheckpoint,
    parallelLimits: parsedArgs.parallelLimitsJson === undefined ? undefined : parseJsonObject(parsedArgs.parallelLimitsJson, "--parallel-limits-json"),
    parallelCheckpointObserver: parsedArgs.parallelCheckpointOutPath === undefined ? undefined
      : ({ checkpoint }) => writeParallelCheckpoint(parsedArgs.parallelCheckpointOutPath, checkpoint),
    hardenedExecutionProfile,
    supplyChainValidated,
    redactionEnabled: true,
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
    stderr.write(formatRuntimeError(e));
  } else {
    stderr.write(`unexpected error: ${e.message}\n`);
  }
  interactiveUserInputSession?.close();
  const code = e instanceof ToubaRuntimeError && HARDENED_ERROR_CODES.includes(e.code)
    ? e.code : "RuntimeAdmissionRefused";
  return await refuseAdmission(code, "runtime", 1);
} finally {
  if (handlerDiagnostics) {
    handlerDiagnostics.close();
    process.removeListener("exit", handlerDiagnostics.close);
    if (handlerDiagnostics.incomplete) stderr.write("warning: local handler diagnostics are incomplete (invalid, full or unavailable channel)\n");
  }
  effectHost?.close();
  if (effectHost) process.removeListener("exit", effectHost.close);
  interactiveUserInputSession?.close();
}

if (result.status === "failure") {
  const diagnostic =
    formatBudgetTraceDiagnostic(result.trace)
    || formatTriggerTraceDiagnostic(result.trace)
    || formatFailureTraceDiagnostic(result.trace);
  if (diagnostic) {
    stderr.write(diagnostic);
  }
}

if (parsedArgs.traceOutPath !== undefined) {
  try {
    writeFileSync(parsedArgs.traceOutPath, serializeJson(result.trace), "utf8");
  } catch (e) {
    stderr.write(`error: cannot write trace ${parsedArgs.traceOutPath}: ${e.message}\n`);
    return await exitAfterFlush(1);
  }
}

// Enabling durable pauses does not require the executed path to pause. A
// completed run may already have produced effects; preserve its real outcome.
if (parsedArgs.humanCheckpointOutPath !== undefined && result.checkpoint && result.status !== "failure") {
  try {
    const fd = openSync(parsedArgs.humanCheckpointOutPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, serializeJson(result.checkpoint), "utf8");
    } finally { closeSync(fd); }
  } catch (e) {
    stderr.write(`error: cannot write human checkpoint ${parsedArgs.humanCheckpointOutPath}: ${e.message}\n`);
    return await exitAfterFlush(1);
  }
}

if (parsedArgs.evidenceOutPath !== undefined) {
  try {
    writeFileSync(parsedArgs.evidenceOutPath, serializeJson(buildRunEvidence(result, parsedArgs)), "utf8");
  } catch (e) {
    stderr.write(`error: cannot write evidence ${parsedArgs.evidenceOutPath}: ${e.message}\n`);
    return await exitAfterFlush(1);
  }
}

stdout.write(renderOutput(result, parsedArgs.outputMode, parsedArgs));
return await exitAfterFlush(runExitCode(result));

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
  validateRunPlanOptionalPath(document, "hardened_profile");
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
  if (parsed.hardenedProfilePath === undefined && plan.hardened_profile !== undefined) {
    parsed.hardenedProfilePath = resolveRunPlanPath(runPlan, plan.hardened_profile);
  }
  if (plan.profile === "prod") {
    parsed.requireSupplyChainLock = true;
    if (parsed.agentDecisionProviderInitialMode === undefined) {
      parsed.agentDecisionProviderInitialMode = "capabilities";
    }
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

function applyRunPlanProfileDefaults(parsed) {
  if (
    parsed.runPlanProfile === "prod"
    && parsed.agentDecisionProviderInitialMode === undefined
  ) {
    parsed.agentDecisionProviderInitialMode = "capabilities";
  }
}

function resolvedAgentDecisionProviderInitialMode(parsed) {
  if (parsed.agentDecisionProviderInitialMode !== undefined) {
    return parsed.agentDecisionProviderInitialMode;
  }
  return undefined;
}

function validateParsedArgsAfterRunPlan(parsed) {
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
  if (outputs.mode !== undefined && !RUN_OUTPUT_MODES.has(outputs.mode)) {
    throw new RunPlanCliError("RunPlanSchemaMismatch", `outputs.mode must be one of: ${runOutputModesLabel()}`);
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

  const required = new Set([...requiredResourceReferences(bindingsDocument), ...(requireAll ? inventory.requiredResourceRefs : [])]);
  for (const resourceRef of required) {
    if (!inventory.knownResourceRefs.has(resourceRef)) throw new ResourceBindingsCliError("ResourceBindingUnknownResource", `required resource ${resourceRef} is absent from AIR`);
    if (!boundResources.has(resourceRef)) {
      throw new ResourceBindingsCliError("ResourceBindingMissing", `resource ${resourceRef} requires an active resource binding`);
    }
  }

  return bindingsDocument;
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
  verifyManifestPackages(manifestPath, rawManifest);
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
  if (providerPath.endsWith(".py")) {
    const host = await loadPythonHost(providerPath); pythonHosts.push(host);
    if (!host.metadata.decide) throw new Error("host must export decide_agent_capability or decide");
    return host.metadata.provider_metadata == null ? host.decide : { decide: host.decide, metadata: host.metadata.provider_metadata };
  }
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
    skillPackPaths: [],
    activeSkillPackRefs: [],
    manifestPath: undefined,
    resourceBindingsPath: undefined,
    requireResourceBindings: false,
    secretsPath: undefined,
    inputsJson: undefined,
    humanDecisionsPath: undefined,
    humanDecisionsJson: undefined,
    humanApprovalHostPath: undefined,
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
    hardenedProfilePath: undefined,
    entryRef: undefined,
    maxAgentSteps: undefined,
    maxLoopIterations: undefined,
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
    const packOption = arg.split("=", 1)[0];
    const packFlags = {
      "--skill-pack": "skillPackPaths", "--activate-skill-pack": "activeSkillPackRefs",
      "--skill-pack-discovery-max-bytes": "skillPackDiscoveryMaxBytes",
      "--skill-pack-activation-max-bytes": "skillPackActivationMaxBytes",
      "--agent-model-input-max-bytes": "agentModelInputMaxBytes",
    };
    if (Object.hasOwn(packFlags, packOption)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : rawArgs[++index];
      if (!value || value.startsWith("--")) return { ...parsed, error: `${packOption} requires a value` };
      const key = packFlags[packOption];
      if (Array.isArray(parsed[key])) parsed[key].push(value);
      else {
        const limit = parsePositiveInteger(value);
        if (!limit) return { ...parsed, error: `${packOption} requires a positive integer` };
        parsed[key] = limit;
      }
    } else if (arg === "--run-plan") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--run-plan requires a path" };
      }
      parsed.runPlanPath = rawArgs[index];
    } else if (arg.startsWith("--run-plan=")) {
      parsed.runPlanPath = arg.slice("--run-plan=".length);
    } else if (arg === "--manifest") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--manifest requires a path" };
      }
      parsed.manifestPath = rawArgs[index];
    } else if (arg.startsWith("--manifest=")) {
      parsed.manifestPath = arg.slice("--manifest=".length);
    } else if (arg === "--resource-bindings") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--resource-bindings requires a path" };
      }
      parsed.resourceBindingsPath = rawArgs[index];
    } else if (arg.startsWith("--resource-bindings=")) {
      parsed.resourceBindingsPath = arg.slice("--resource-bindings=".length);
    } else if (arg === "--require-resource-bindings") {
      parsed.requireResourceBindings = true;
    } else if (arg === "--secrets") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--secrets requires a path" };
      }
      parsed.secretsPath = rawArgs[index];
    } else if (arg.startsWith("--secrets=")) {
      parsed.secretsPath = arg.slice("--secrets=".length);
    } else if (arg === "--inputs-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--inputs-json requires a JSON object" };
      }
      parsed.inputsJson = rawArgs[index];
    } else if (arg.startsWith("--inputs-json=")) {
      parsed.inputsJson = arg.slice("--inputs-json=".length);
    } else if (arg === "--human-approval-host") {
      index += 1;
      if (index >= rawArgs.length || rawArgs[index].startsWith("--")) return { ...parsed, error: "--human-approval-host requires a trusted module path" };
      parsed.humanApprovalHostPath = rawArgs[index];
    } else if (arg.startsWith("--human-approval-host=")) {
      parsed.humanApprovalHostPath = arg.slice("--human-approval-host=".length);
      if (!parsed.humanApprovalHostPath) return { ...parsed, error: "--human-approval-host requires a trusted module path" };
    } else if (arg === "--human-decisions") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--human-decisions requires a path" };
      }
      parsed.humanDecisionsPath = rawArgs[index];
    } else if (arg.startsWith("--human-decisions=")) {
      parsed.humanDecisionsPath = arg.slice("--human-decisions=".length);
    } else if (arg === "--human-decisions-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--human-decisions-json requires a JSON object" };
      }
      parsed.humanDecisionsJson = rawArgs[index];
    } else if (arg.startsWith("--human-decisions-json=")) {
      parsed.humanDecisionsJson = arg.slice("--human-decisions-json=".length);
    } else if (arg === "--effect-journal") {
      index += 1;
      parsed.effectJournalPath = rawArgs[index];
      if (!parsed.effectJournalPath?.endsWith(".effect-journal.json")) return { ...parsed, error: "--effect-journal requires a .effect-journal.json path" };
    } else if (arg.startsWith("--effect-journal=")) {
      parsed.effectJournalPath = arg.slice("--effect-journal=".length);
      if (!parsed.effectJournalPath.endsWith(".effect-journal.json")) return { ...parsed, error: "--effect-journal requires a .effect-journal.json path" };
    } else if (["--parallel-checkpoint-out", "--parallel-resume-checkpoint", "--parallel-limits-json"].includes(arg.split("=")[0])) {
      const flag = arg.split("=")[0];
      const value = arg.includes("=") ? arg.slice(flag.length + 1) : rawArgs[++index];
      if (!value || value.startsWith("--")) return { ...parsed, error: `${flag} requires a value` };
      const key = { "--parallel-checkpoint-out": "parallelCheckpointOutPath",
        "--parallel-resume-checkpoint": "parallelResumeCheckpointPath", "--parallel-limits-json": "parallelLimitsJson" }[flag];
      parsed[key] = value;
    } else if (arg === "--human-checkpoint-out") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--human-checkpoint-out requires a path" };
      }
      parsed.humanCheckpointOutPath = rawArgs[index];
    } else if (arg.startsWith("--human-checkpoint-out=")) {
      parsed.humanCheckpointOutPath = arg.slice("--human-checkpoint-out=".length);
    } else if (arg === "--human-resume-checkpoint") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--human-resume-checkpoint requires a path" };
      }
      parsed.humanResumeCheckpointPath = rawArgs[index];
    } else if (arg.startsWith("--human-resume-checkpoint=")) {
      parsed.humanResumeCheckpointPath = arg.slice("--human-resume-checkpoint=".length);
    } else if (arg === "--user-inputs") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--user-inputs requires a path" };
      }
      parsed.userInputsPath = rawArgs[index];
    } else if (arg.startsWith("--user-inputs=")) {
      parsed.userInputsPath = arg.slice("--user-inputs=".length);
    } else if (arg === "--user-inputs-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--user-inputs-json requires a JSON object" };
      }
      parsed.userInputsJson = rawArgs[index];
    } else if (arg.startsWith("--user-inputs-json=")) {
      parsed.userInputsJson = arg.slice("--user-inputs-json=".length);
    } else if (arg === "--interactive-user-inputs") {
      parsed.interactiveUserInputs = true;
    } else if (arg === "--agent-decisions") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--agent-decisions requires a path" };
      }
      parsed.agentDecisionsPath = rawArgs[index];
    } else if (arg.startsWith("--agent-decisions=")) {
      parsed.agentDecisionsPath = arg.slice("--agent-decisions=".length);
    } else if (arg === "--agent-decisions-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--agent-decisions-json requires a JSON object" };
      }
      parsed.agentDecisionsJson = rawArgs[index];
    } else if (arg.startsWith("--agent-decisions-json=")) {
      parsed.agentDecisionsJson = arg.slice("--agent-decisions-json=".length);
    } else if (arg === "--agent-decision-provider") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--agent-decision-provider requires a path" };
      }
      parsed.agentDecisionProviderPath = rawArgs[index];
    } else if (arg.startsWith("--agent-decision-provider=")) {
      parsed.agentDecisionProviderPath = arg.slice("--agent-decision-provider=".length);
    } else if (arg === "--agent-decision-provider-metadata-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--agent-decision-provider-metadata-json requires a JSON object" };
      }
      parsed.agentDecisionProviderMetadataJson = rawArgs[index];
    } else if (arg.startsWith("--agent-decision-provider-metadata-json=")) {
      parsed.agentDecisionProviderMetadataJson = arg.slice("--agent-decision-provider-metadata-json=".length);
    } else if (arg === "--agent-decision-provider-timeout-ms") {
      index += 1;
      const timeoutMs = parsePositiveInteger(rawArgs[index]);
      if (!timeoutMs) {
        return { ...parsed, error: "--agent-decision-provider-timeout-ms requires a positive integer" };
      }
      parsed.agentDecisionProviderTimeoutMs = timeoutMs;
    } else if (arg.startsWith("--agent-decision-provider-timeout-ms=")) {
      const timeoutMs = parsePositiveInteger(arg.slice("--agent-decision-provider-timeout-ms=".length));
      if (!timeoutMs) {
        return { ...parsed, error: "--agent-decision-provider-timeout-ms requires a positive integer" };
      }
      parsed.agentDecisionProviderTimeoutMs = timeoutMs;
    } else if (arg === "--agent-decision-provider-max-retries") {
      index += 1;
      const maxRetries = parseNonNegativeInteger(rawArgs[index]);
      if (maxRetries === null) {
        return { ...parsed, error: "--agent-decision-provider-max-retries requires a non-negative integer" };
      }
      parsed.agentDecisionProviderMaxRetries = maxRetries;
    } else if (arg.startsWith("--agent-decision-provider-max-retries=")) {
      const maxRetries = parseNonNegativeInteger(arg.slice("--agent-decision-provider-max-retries=".length));
      if (maxRetries === null) {
        return { ...parsed, error: "--agent-decision-provider-max-retries requires a non-negative integer" };
      }
      parsed.agentDecisionProviderMaxRetries = maxRetries;
    } else if (arg === "--agent-decision-provider-content-mode") {
      index += 1;
      if (!["inline", "opaque_refs"].includes(rawArgs[index])) {
        return { ...parsed, error: "--agent-decision-provider-content-mode must be one of: inline, opaque_refs" };
      }
      parsed.agentDecisionProviderContentMode = rawArgs[index];
    } else if (arg.startsWith("--agent-decision-provider-content-mode=")) {
      const contentMode = arg.slice("--agent-decision-provider-content-mode=".length);
      if (!["inline", "opaque_refs"].includes(contentMode)) {
        return { ...parsed, error: "--agent-decision-provider-content-mode must be one of: inline, opaque_refs" };
      }
      parsed.agentDecisionProviderContentMode = contentMode;
    } else if (arg === "--agent-decision-provider-initial-mode") {
      index += 1;
      if (!["summary", "capabilities"].includes(rawArgs[index])) {
        return { ...parsed, error: "--agent-decision-provider-initial-mode must be one of: summary, capabilities" };
      }
      parsed.agentDecisionProviderInitialMode = rawArgs[index];
    } else if (arg.startsWith("--agent-decision-provider-initial-mode=")) {
      const initialMode = arg.slice("--agent-decision-provider-initial-mode=".length);
      if (!["summary", "capabilities"].includes(initialMode)) {
        return { ...parsed, error: "--agent-decision-provider-initial-mode must be one of: summary, capabilities" };
      }
      parsed.agentDecisionProviderInitialMode = initialMode;
    } else if (arg === "--trigger-event") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--trigger-event requires a path" };
      }
      parsed.triggerEventPath = rawArgs[index];
    } else if (arg.startsWith("--trigger-event=")) {
      parsed.triggerEventPath = arg.slice("--trigger-event=".length);
    } else if (arg === "--trigger-event-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--trigger-event-json requires a JSON object" };
      }
      parsed.triggerEventJson = rawArgs[index];
    } else if (arg.startsWith("--trigger-event-json=")) {
      parsed.triggerEventJson = arg.slice("--trigger-event-json=".length);
    } else if (arg === "--trigger-dry-run") {
      parsed.triggerDryRun = true;
    } else if (arg === "--state" || arg === "--trigger-state") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: `${arg} requires a path` };
      }
      parsed.triggerStatePath = rawArgs[index];
    } else if (arg.startsWith("--state=")) {
      parsed.triggerStatePath = arg.slice("--state=".length);
    } else if (arg.startsWith("--trigger-state=")) {
      parsed.triggerStatePath = arg.slice("--trigger-state=".length);
    } else if (arg === "--supply-chain-lock") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--supply-chain-lock requires a path" };
      }
      parsed.supplyChainLockPath = rawArgs[index];
    } else if (arg.startsWith("--supply-chain-lock=")) {
      parsed.supplyChainLockPath = arg.slice("--supply-chain-lock=".length);
    } else if (arg === "--require-supply-chain-lock") {
      parsed.requireSupplyChainLock = true;
    } else if (arg === "--handler-diagnostics" || arg.startsWith("--handler-diagnostics=")) {
      if (parsed.handlerDiagnosticsPath !== undefined) return { ...parsed, error: "--handler-diagnostics must be supplied once" };
      const path = arg === "--handler-diagnostics" ? rawArgs[++index] : arg.slice("--handler-diagnostics=".length);
      if (!path || path.startsWith("--")) return { ...parsed, error: "--handler-diagnostics requires a new file path" };
      parsed.handlerDiagnosticsPath = path;
    } else if (arg === "--hardened-profile") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--hardened-profile requires a path" };
      }
      parsed.hardenedProfilePath = rawArgs[index];
    } else if (arg.startsWith("--hardened-profile=")) {
      parsed.hardenedProfilePath = arg.slice("--hardened-profile=".length);
    } else if (arg === "--trigger") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--trigger requires a trigger ref" };
      }
      parsed.triggerRef = rawArgs[index];
    } else if (arg.startsWith("--trigger=")) {
      parsed.triggerRef = arg.slice("--trigger=".length);
    } else if (arg === "--max-runs") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--max-runs requires a positive integer" };
      }
      const maxRuns = parsePositiveInteger(rawArgs[index]);
      if (!maxRuns) {
        return { ...parsed, error: "--max-runs requires a positive integer" };
      }
      parsed.triggerRunnerMaxRuns = maxRuns;
    } else if (arg.startsWith("--max-runs=")) {
      const maxRuns = parsePositiveInteger(arg.slice("--max-runs=".length));
      if (!maxRuns) {
        return { ...parsed, error: "--max-runs requires a positive integer" };
      }
      parsed.triggerRunnerMaxRuns = maxRuns;
    } else if (arg === "--max-agent-steps") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--max-agent-steps requires a positive integer" };
      }
      const maxAgentSteps = parsePositiveInteger(rawArgs[index]);
      if (!maxAgentSteps) {
        return { ...parsed, error: "--max-agent-steps requires a positive integer" };
      }
      parsed.maxAgentSteps = maxAgentSteps;
    } else if (arg.startsWith("--max-agent-steps=")) {
      const maxAgentSteps = parsePositiveInteger(arg.slice("--max-agent-steps=".length));
      if (!maxAgentSteps) {
        return { ...parsed, error: "--max-agent-steps requires a positive integer" };
      }
      parsed.maxAgentSteps = maxAgentSteps;
    } else if (arg === "--max-loop-iterations") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--max-loop-iterations requires a positive integer" };
      }
      const maxLoopIterations = parsePositiveInteger(rawArgs[index]);
      if (!maxLoopIterations) {
        return { ...parsed, error: "--max-loop-iterations requires a positive integer" };
      }
      parsed.maxLoopIterations = maxLoopIterations;
    } else if (arg.startsWith("--max-loop-iterations=")) {
      const maxLoopIterations = parsePositiveInteger(arg.slice("--max-loop-iterations=".length));
      if (!maxLoopIterations) {
        return { ...parsed, error: "--max-loop-iterations requires a positive integer" };
      }
      parsed.maxLoopIterations = maxLoopIterations;
    } else if (arg === "--run-timeout-ms") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--run-timeout-ms requires a positive integer" };
      }
      const runTimeoutMs = parsePositiveInteger(rawArgs[index]);
      if (!runTimeoutMs) {
        return { ...parsed, error: "--run-timeout-ms requires a positive integer" };
      }
      parsed.runTimeoutMs = runTimeoutMs;
    } else if (arg.startsWith("--run-timeout-ms=")) {
      const runTimeoutMs = parsePositiveInteger(arg.slice("--run-timeout-ms=".length));
      if (!runTimeoutMs) {
        return { ...parsed, error: "--run-timeout-ms requires a positive integer" };
      }
      parsed.runTimeoutMs = runTimeoutMs;
    } else if (arg === "--run-limits-json") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--run-limits-json requires a JSON object" };
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
        return { ...parsed, error: "--entry requires an AIR reference" };
      }
      parsed.entryRef = rawArgs[index];
    } else if (arg.startsWith("--entry=")) {
      parsed.entryRef = arg.slice("--entry=".length);
    } else if (arg === "--output") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: `--output requires one of: ${runOutputModesLabel()}` };
      }
      parsed.outputMode = rawArgs[index];
      parsed.outputModeExplicit = true;
    } else if (arg.startsWith("--output=")) {
      parsed.outputMode = arg.slice("--output=".length);
      parsed.outputModeExplicit = true;
    } else if (arg === "--trace-out") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--trace-out requires a path" };
      }
      parsed.traceOutPath = rawArgs[index];
      parsed.traceOutExplicit = true;
    } else if (arg.startsWith("--trace-out=")) {
      parsed.traceOutPath = arg.slice("--trace-out=".length);
      parsed.traceOutExplicit = true;
    } else if (arg === "--evidence-out") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--evidence-out requires a path" };
      }
      parsed.evidenceOutPath = rawArgs[index];
      parsed.evidenceOutExplicit = true;
    } else if (arg.startsWith("--evidence-out=")) {
      parsed.evidenceOutPath = arg.slice("--evidence-out=".length);
      parsed.evidenceOutExplicit = true;
    } else if (arg === "--evidence-ref") {
      index += 1;
      if (index >= rawArgs.length) {
        return { ...parsed, error: "--evidence-ref requires label=uri" };
      }
      try {
        parsed.evidenceRefs.push(parseEvidenceRef(rawArgs[index]));
      } catch (error) {
        return { ...parsed, error: error.message };
      }
    } else if (arg.startsWith("--evidence-ref=")) {
      try {
        parsed.evidenceRefs.push(parseEvidenceRef(arg.slice("--evidence-ref=".length)));
      } catch (error) {
        return { ...parsed, error: error.message };
      }
    } else if (arg.startsWith("--")) {
      return { ...parsed, error: `unknown option ${arg}` };
    } else {
      parsed.positional.push(arg);
    }
  }



  if (parsed.humanDecisionsPath !== undefined && parsed.humanDecisionsJson !== undefined) {
    return { ...parsed, error: "--human-decisions cannot be combined with --human-decisions-json" };
  }
  if (parsed.parallelResumeCheckpointPath !== undefined && parsed.humanResumeCheckpointPath !== undefined) {
    return { ...parsed, error: "choose only one resume checkpoint" };
  }

  // A persisted source deadline may authorize only the explicit expiration
  // branch without a supplied decision. The runtime checks that it is due.

  if (parsed.userInputsPath !== undefined && parsed.userInputsJson !== undefined) {
    return { ...parsed, error: "--user-inputs cannot be combined with --user-inputs-json" };
  }

  if (parsed.agentDecisionsPath !== undefined && parsed.agentDecisionsJson !== undefined) {
    return { ...parsed, error: "--agent-decisions cannot be combined with --agent-decisions-json" };
  }

  if (parsed.agentDecisionProviderMetadataJson !== undefined) {
    try {
      parsed.agentDecisionProviderMetadata = parseJsonObject(
        parsed.agentDecisionProviderMetadataJson,
        "--agent-decision-provider-metadata-json",
      );
    } catch (e) {
      return { ...parsed, error: `invalid --agent-decision-provider-metadata-json: ${e.message}` };
    }
  }

  if (parsed.triggerEventPath !== undefined && parsed.triggerEventJson !== undefined) {
    return { ...parsed, error: "--trigger-event cannot be combined with --trigger-event-json" };
  }

  if (parsed.triggerDryRun && parsed.triggerEventPath === undefined && parsed.triggerEventJson === undefined) {
    return { ...parsed, error: "--trigger-dry-run requires --trigger-event or --trigger-event-json" };
  }

  if (parsed.triggerDryRun && parsed.triggerStatePath !== undefined) {
    return { ...parsed, error: "--state cannot be combined with --trigger-dry-run" };
  }

  if (
    parsed.triggerStatePath !== undefined
    && parsed.triggerRef === undefined
    && parsed.triggerEventPath === undefined
    && parsed.triggerEventJson === undefined
  ) {
    return { ...parsed, error: "--state requires --trigger, --trigger-event or --trigger-event-json" };
  }

  if (parsed.triggerRef !== undefined && parsed.triggerRunnerMaxRuns === undefined) {
    return { ...parsed, error: "--trigger requires --max-runs" };
  }

  if (parsed.triggerRef !== undefined && parsed.triggerStatePath === undefined) {
    return { ...parsed, error: "--trigger requires --state <*.trigger-state.json> for durable replay and quota checks" };
  }

  if (parsed.triggerRunnerMaxRuns !== undefined && parsed.triggerRef === undefined) {
    return { ...parsed, error: "--max-runs requires --trigger" };
  }

  if (
    parsed.triggerRef !== undefined
    && (parsed.triggerEventPath !== undefined || parsed.triggerEventJson !== undefined || parsed.triggerDryRun)
  ) {
    return { ...parsed, error: "--trigger cannot be combined with --trigger-event, --trigger-event-json or --trigger-dry-run" };
  }

  if (parsed.triggerRef !== undefined && parsed.entryRef !== undefined) {
    return { ...parsed, error: "--entry cannot be combined with trigger runner execution" };
  }

  if (parsed.triggerRef !== undefined && parsed.humanCheckpointOutPath !== undefined) {
    return { ...parsed, error: "--human-checkpoint-out cannot be combined with trigger runner execution" };
  }

  if (parsed.triggerRef !== undefined && parsed.humanResumeCheckpointPath !== undefined) {
    return { ...parsed, error: "--human-resume-checkpoint cannot be combined with trigger runner execution" };
  }

  if (
    (parsed.triggerEventPath !== undefined || parsed.triggerEventJson !== undefined)
    && parsed.entryRef !== undefined
  ) {
    return { ...parsed, error: "--entry cannot be combined with trigger execution" };
  }

  if (
    (parsed.triggerEventPath !== undefined || parsed.triggerEventJson !== undefined)
    && parsed.humanCheckpointOutPath !== undefined
  ) {
    return { ...parsed, error: "--human-checkpoint-out cannot be combined with trigger execution" };
  }

  if (
    (parsed.triggerEventPath !== undefined || parsed.triggerEventJson !== undefined)
    && parsed.humanResumeCheckpointPath !== undefined
  ) {
    return { ...parsed, error: "--human-resume-checkpoint cannot be combined with trigger execution" };
  }

  if (
    parsed.interactiveUserInputs
    && (parsed.userInputsPath !== undefined || parsed.userInputsJson !== undefined)
  ) {
    return { ...parsed, error: "--interactive-user-inputs cannot be combined with --user-inputs or --user-inputs-json" };
  }

  if (parsed.runLimitsJson !== undefined) {
    try {
      parsed.runLimits = parseJsonObject(parsed.runLimitsJson, "--run-limits-json");
    } catch (e) {
      return { ...parsed, error: `invalid --run-limits-json: ${e.message}` };
    }
  }

  parsed.runLimits = {
    ...(parsed.runLimits ?? {}),
    ...parsed.runLimitFlags,
  };
  if (Object.keys(parsed.runLimits).length === 0) {
    parsed.runLimits = undefined;
  }

  if (!RUN_OUTPUT_MODES.has(parsed.outputMode)) {
    return { ...parsed, error: `--output must be one of: ${runOutputModesLabel()}` };
  }

  if (parsed.evidenceRefs.length > 0 && parsed.evidenceOutPath === undefined) {
    return { ...parsed, error: "--evidence-ref requires --evidence-out" };
  }

  return parsed;
}

function printUsage() {
  stderr.write("Local development only: --handler-diagnostics <new-private-file.jsonl> requires a dev run plan on POSIX; unavailable in production.\n");
  stderr.write(
    "usage: touba run (<file.air.json> | --run-plan <touba.run-plan.json>) [--manifest <path> [--secrets <path>]] [--resource-bindings <path> [--require-resource-bindings]] [--supply-chain-lock <path> [--require-supply-chain-lock]] [--effect-journal <run.effect-journal.json>] [--hardened-profile <touba.hardened-profile.json>] [--inputs-json <json-object>] [--human-approval-host <host.mjs>] [--human-decisions <path> | --human-decisions-json <json-object>] [--human-checkpoint-out <path>] [--human-resume-checkpoint <path>] [--parallel-checkpoint-out <path>] [--parallel-resume-checkpoint <path>] [--parallel-limits-json <json-object>] [--user-inputs <path> | --user-inputs-json <json-object> | --interactive-user-inputs] [--agent-decisions <path> | --agent-decisions-json <json-object>] [--agent-decision-provider <path> [--agent-decision-provider-metadata-json <json-object>] [--agent-decision-provider-content-mode inline|opaque_refs] [--agent-decision-provider-initial-mode summary|capabilities] [--agent-decision-provider-timeout-ms <positive-integer>] [--agent-decision-provider-max-retries <non-negative-integer>]] [--trigger-event <path> | --trigger-event-json <json-object> [--state <touba.trigger-state.json>]] [--trigger-dry-run] [--trigger <trigger-ref> --max-runs <positive-integer> --state <touba.trigger-state.json>] [--skill-pack <directory>...] [--activate-skill-pack <ref>...] [--skill-pack-discovery-max-bytes <n>] [--skill-pack-activation-max-bytes <n>] [--agent-model-input-max-bytes <n>] [--max-agent-steps <positive-integer>] [--max-loop-iterations <positive-integer>] [--run-timeout-ms <positive-integer>] [--run-limits-json <json-object>] [--max-run-ms <positive-integer>] [--max-steps <positive-integer>] [--max-tool-calls <positive-integer>] [--max-agent-invocations <positive-integer>] [--max-provider-calls <positive-integer>] [--cancel-before-dispatch] [--cancel-on-pause] [--kill-switch-enabled] [--entry <air-ref>] [--output show|result|trace|all|run-summary|json] [--trace-out <path>] [--evidence-out <run.evidence.json> [--evidence-ref <label=uri>...]]\n",
  );
}

function runOutputModesLabel() {
  return [...RUN_OUTPUT_MODES].join(", ");
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
    output: stderr,
  });
  let closed = false;
  let questions = Promise.resolve();
  return {
    provider: ({ prompt }) => {
      const answer = questions.then(() => rl.question(`${prompt} `));
      questions = answer.then(() => undefined, () => undefined);
      return answer;
    },
    close: () => {
      if (!closed) {
        closed = true;
        rl.close();
      }
    },
  };
}

function renderOutput(result, mode, parsed = {}) {
  if (mode === "show") {
    return renderShowOutput(result);
  }
  if (mode === "json") return serializeJson(publicRunResult(result));
  if (mode === "result") {
    return serializeJson(result.result ?? null);
  }
  if (mode === "trace") {
    return serializeJson(result.trace);
  }
  if (mode === "run-summary") {
    return serializeJson(buildRunSummary(result, parsed));
  }
  if (mode === "all") {
    return renderAllOutput(result);
  }
  throw new Error(`unsupported output mode ${mode}`);
}

function renderShowOutput(result) {
  const messages = (result.messages ?? []).map(message => message.text);

  if (messages.length === 0) {
    return "";
  }
  return `${messages.join("\n")}\n`;
}

function renderAllOutput(result) {
  const sections = [];
  const showOutput = renderShowOutput(result).trimEnd();
  if (showOutput !== "") {
    sections.push(`[show]\n${showOutput}`);
  }
  sections.push(`[result]\n${JSON.stringify(result.result ?? null, null, 2)}`);
  sections.push(`[trace]\n${JSON.stringify(result.trace, null, 2)}`);
  return `${sections.join("\n\n")}\n`;
}

function buildRunSummary(result, parsed = {}) {
  const trace = result.trace ?? {};
  const events = Array.isArray(trace.events) ? trace.events : [];
  const generatedAt = new Date().toISOString();
  const runId = stringOrDefault(trace.run?.run_id, "run:unknown");
  const status = productRunStatus(result, events);
  return {
    schema_version: RUN_SUMMARY_SCHEMA_VERSION,
    run_id: runId,
    status,
    entrypoint_ref: stringOrDefault(trace.run?.entry_ref ?? parsed.entryRef, "entry:unknown"),
    started_at: generatedAt,
    completed_at: isTerminalProductRunStatus(status) ? generatedAt : null,
    trigger_ref: triggerRefFromTrace(trace, events),
    trace_ref: parsed.traceOutPath ? `file:${parsed.traceOutPath}` : `trace:${runId}`,
    approvals_pending: pendingApprovalRefs(events),
    refusals: refusalSummaries(events),
    budgets: budgetCounters(events),
  };
}

function productRunStatus(result, events) {
  const pendingApprovals = pendingApprovalEvents(events);
  if (pendingApprovals.length > 0) {
    return pendingApprovals.some((event) => event.payload?.mode === "agent_review")
      ? "review_pending"
      : "approval_pending";
  }
  if (result.status === "success") {
    return "succeeded";
  }
  if (result.status === "cancelled") {
    return "cancelled";
  }
  if (result.status === "stopped") {
    if (result.reason === "human_approval_cancelled") return "cancelled";
    if (["human_approval_rejected", "human_approval_expired"].includes(result.reason)) return "refused";
    return result.reason === "explicit_stop" ? "stopped" : "paused";
  }
  if (result.status === "failure") {
    return refusalSummaries(events).length > 0 ? "refused" : "failed";
  }
  return "failed";
}

function isTerminalProductRunStatus(status) {
  return ["succeeded", "failed", "cancelled", "refused", "stopped"].includes(status);
}

function triggerRefFromTrace(trace, events) {
  if (typeof trace.run?.entry_ref === "string" && trace.run.entry_ref.startsWith("trigger:")) {
    return trace.run.entry_ref;
  }
  const triggerEvent = events.find((event) => typeof event.payload?.trigger_ref === "string");
  return triggerEvent?.payload?.trigger_ref ?? null;
}

function pendingApprovalRefs(events) {
  return pendingApprovalEvents(events).map((event) => event.payload.approval_ref);
}

function pendingApprovalEvents(events) {
  const settled = new Set(
    events
      .filter((event) => [
        "human_approval_decided",
        "human_approval_resumed",
        "human_approval_rejected",
        "human_approval_expired",
        "human_approval_cancelled",
      ].includes(event.kind))
      .map((event) => event.payload?.approval_ref)
      .filter((approvalRef) => typeof approvalRef === "string"),
  );
  return events.filter((event) =>
    event.kind === "human_approval_paused"
    && typeof event.payload?.approval_ref === "string"
    && !settled.has(event.payload.approval_ref),
  );
}

function hasHumanApprovalTerminalRefusal(events) {
  return events.some((event) => [
    "human_approval_rejected",
    "human_approval_expired",
    "human_approval_cancelled",
  ].includes(event.kind));
}

function refusalSummaries(events) {
  return events
    .filter((event) => isRefusalEvent(event))
    .map((event) => {
      const payload = event.payload ?? {};
      return {
        code: stringOrDefault(payload.runtime_error_code ?? payload.reason ?? event.kind, event.kind),
        message: stringOrDefault(event.message ?? refusalMessage(event), event.kind),
        source_ref: sourceRefForEvent(event),
      };
    });
}

function isRefusalEvent(event) {
  return (
    event.kind.endsWith("_refused")
    || event.kind === "budget_limit_exceeded"
    || event.kind === "dispatch_refused_budget_exceeded"
    || event.kind === "agent_step_limit_exceeded"
    || event.kind === "trigger_rate_limited"
    || [
      "human_approval_rejected",
      "human_approval_expired",
      "human_approval_cancelled",
    ].includes(event.kind)
  );
}

function refusalMessage(event) {
  const payload = event.payload ?? {};
  if (typeof payload.reason === "string") {
    return `${event.kind}: ${payload.reason}`;
  }
  if (typeof payload.runtime_error_code === "string") {
    return `${event.kind}: ${payload.runtime_error_code}`;
  }
  return event.kind;
}

function sourceRefForEvent(event) {
  if (typeof event.air_ref === "string") {
    return event.air_ref;
  }
  const payload = event.payload ?? {};
  return [
    payload.target_ref,
    payload.trigger_ref,
    payload.approval_ref,
    payload.agent_ref,
    payload.caller_ref,
  ].find((value) => typeof value === "string") ?? null;
}

function budgetCounters(events) {
  return {
    steps_used: Math.max(latestBudgetConsumed(events, "max_steps"), observedStepCount(events)),
    tool_calls_used: Math.max(latestBudgetConsumed(events, "max_tool_calls"), observedToolCallCount(events)),
    provider_calls_used: Math.max(
      latestBudgetConsumed(events, "max_provider_calls"),
      events.filter((event) => event.kind === "agent_decision_provider_call_attempted").length,
    ),
  };
}

function latestBudgetConsumed(events, budgetKind) {
  const consumedValues = events
    .filter((event) => event.kind === "budget_consumed" && event.payload?.budget_kind === budgetKind)
    .map((event) => event.payload?.consumed_value)
    .filter((value) => Number.isInteger(value) && value >= 0);
  return consumedValues.length > 0 ? consumedValues.at(-1) : 0;
}

function observedStepCount(events) {
  const nodeRefs = new Set();
  for (const event of events) {
    const nodeId = event.air_ref?.node_id;
    const graphRef = event.air_ref?.flow_graph_ref;
    if (typeof nodeId === "string" && typeof graphRef === "string") {
      nodeRefs.add(`${graphRef}#${nodeId}`);
    }
  }
  return nodeRefs.size;
}

function observedToolCallCount(events) {
  return events.filter((event) =>
    event.kind === "call_completed"
    && typeof event.payload?.target_ref === "string"
    && event.payload.target_ref.startsWith("tool:")
  ).length;
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
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

  if (error.details?.entryRef) {
    lines.push(`entry: ${error.details.entryRef}`);
    if (error.details.schemaPath) lines.push(`schema path: ${error.details.schemaPath}`);
    if (error.details.expectedTypeRef) lines.push(`expected type: ${error.details.expectedTypeRef}`);
    if (error.details.actualType) lines.push(`actual type: ${error.details.actualType}`);
    if (error.details.missingFields?.length) lines.push(`missing fields: ${error.details.missingFields.join(", ")}`);
    if (error.details.unknownFieldCount) lines.push(`unexpected field count: ${error.details.unknownFieldCount}`);
  }

  if (toolRef) {
    const missing = error.code === "ToolBindingMissing" || error.code === "ToolBindingManifestMissing";
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

    lines.push(bindingGuidance(error.code));
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
        toolRef: failureEvent.payload?.tool_ref,
        entryRef: failureEvent.payload?.entry_ref,
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
        unknownFieldCount: failureEvent.payload?.unknown_field_count,
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



function bindingGuidance(code) {
  if (code === "ToolBindingManifestMissing" || (code === "ToolBindingMissing" && parsedArgs.manifestPath === undefined)) return "provide --manifest <path> with the tool's reviewed binding";
  if (code === "ToolBindingMissing") return "add the declared tool's binding to the supplied manifest after review";
  if (code?.startsWith("SecretValueIn")) return "keep resolved secrets out of arguments and results; matching includes object keys and substrings, so a short secret can also match ordinary text";
  if (code?.includes("Secret")) return "check declared secret handles, manifest grants and agent scopes; do not put secret values in inputs";
  if (code?.includes("Schema") || code?.includes("Payload")) return "check the declared input/output type and payload constraints at the reported schema path";
  if (code?.includes("Grant") || code?.includes("Capability")) return "review the required capability and explicit manifest grants before retrying";
  return "inspect the reported refusal and the supplied binding/handler configuration before retrying";
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
      runId: executionOptions.effectJournal ? `${executionOptions.runId}-${runIndex}` : `trigger-runner-${runIndex}`,
      effectScopeId: executionOptions.effectJournal ? `${executionOptions.runId}-${runIndex}` : undefined,
      triggerRunCounts: {
        [triggerRef]: triggerState
          ? countAcceptedTriggerEvents(triggerState.document, triggerRef, currentTriggerDayKey())
          : 0,
      },
    }, triggerState);
    runResults.push({ event, result: runResult });
    if (runResult.status !== "success") break;
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
  const trace = new TraceBuilder(document, event.triggerRef, runId ?? `trigger-replay:${randomUUID()}`);
  trace.push("run_started", { payload: { entry_ref: event.triggerRef } });
  trace.push("trigger_event_received", { payload: {
    trigger_ref: event.triggerRef, event_id: event.eventId, source_kind: event.sourceKind,
  } });
  trace.push("trigger_event_refused", { payload: {
    trigger_ref: event.triggerRef, event_id: event.eventId, source_kind: event.sourceKind,
    reason: "event_replay", runtime_error_code: "TriggerReplayRejected",
  } });
  trace.push("run_completed", { payload: { status: "failure", reason: "TriggerReplayRejected" } });
  return { status: "failure", reason: "TriggerReplayRejected", result: null, messages: [],
    trace: validateTraceMachineContract(trace.document()) };
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
  const last = runResults.at(-1).result;
  const trace = new TraceBuilder(document, triggerRef, `trigger-runner:${randomUUID()}`);
  trace.push("run_started", { payload: { entry_ref: triggerRef, execution_kind: "trigger_runner" } });
  // This is an explicitly correlated aggregate, not a concatenation of events
  // pretending to share a run ID. Keep each original event's provenance.
  for (const { result } of runResults) {
    validateTraceMachineContract(result.trace);
    for (const event of result.trace.events) {
      const kind = event.kind === "run_started" ? "trigger_runner_run_started"
        : event.kind === "run_completed" ? "trigger_runner_run_completed" : event.kind;
      trace.push(kind, { airRef: event.air_ref, message: event.message,
        payload: { ...event.payload, origin_run_id: event.run_id, origin_event_id: event.event_id } });
    }
  }
  trace.push("run_completed", { payload: { status: last.status, reason: last.reason } });
  return {
    status: last.status, reason: last.reason,
    result: runResults.map(({ event, result }) => ({ event_id: event.event_id,
      status: result.status, reason: result.reason, result: result.result ?? null })),
    messages: runResults.flatMap(({ result }) => result.messages ?? []),
    ...(last.pending_interaction ? { pending_interaction: last.pending_interaction } : {}),
    ...(last.pending_interactions?.length ? { pending_interactions: last.pending_interactions } : {}),
    ...(last.checkpoint ? { checkpoint: last.checkpoint } : {}),
    trace: validateTraceMachineContract(trace.document()),
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

}
