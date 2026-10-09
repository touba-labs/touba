import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { failureFamilyForRuntimeCode } from "../../../contracts/machine/contracts.mjs";
import {
  agentDecisionProviderContent,
  agentProviderObservationBudgetReport,
} from "./agent-provider-content.mjs";
import { runAgentDecisionLoop } from "./agent-loop.mjs";
import {
  AIR_CAPABILITY_PROFILE,
  AIR_JSON_PROFILE,
  AIR_SCHEMA_VERSION,
  indexAirDocument,
  validateAirDocument,
} from "./air-runtime-profile.mjs";
import {
  callerKindFromRef,
  evaluateAgentInvocationAuthority,
} from "./authority.mjs";
import { normalizeInternalCompensationContext } from "./compensation-context.mjs";
import { executeGraphTraversal } from "./graph-execution.mjs";
import {
  COMPENSATION_HANDLER_PROTOCOL_VERSION,
  EFFECT_HANDLER_PROTOCOL_VERSION,
  EFFECT_JOURNAL_SCHEMA_VERSION,
  assertJsonPortable,
  deriveEffectId,
  deriveEffectRequestDigest,
  readEffectJournalEntry,
  requireEffectJournalAdapter,
  validateEffectJournalEntry,
  validateEffectReceipt,
  writeEffectJournalEntry,
} from "./effect-contract.mjs";
import {
  EXECUTION_CHECKPOINT_VERSION,
  assertExecutionCheckpointHasNoResolvedSecret,
  canonicalDigest,
  containsResolvedSecretValue,
  normalizeExecutionCheckpointObserver,
  normalizeOptionalExecutionCheckpoint,
  sealExecutionCheckpoint,
  tracePrefixDigest,
  validateExecutionCheckpoint,
} from "./execution-checkpoints.mjs";
import {
  HARDENED_EXECUTION_PROFILE_VERSION,
  enforceHardenedExecutionProfile,
  probeHostSandbox,
} from "./hardened-execution-profile.mjs";
import {
  runProcessToolHandler,
  TOOL_HANDLER_PROTOCOL_VERSION,
} from "./handler-protocol.mjs";
import {
  HUMAN_APPROVAL_CHECKPOINT_VERSION,
  airDocumentDigest,
  assertCheckpointHasNoResolvedSecret,
  checkpointArray,
  checkpointJsonClone,
  checkpointNonNegativeSafeInteger,
  checkpointObjectFromMap,
  checkpointString,
  checkpointStringArray,
  mapFromCheckpointObject,
  normalizeOptionalHumanApprovalCheckpoint,
  stringArraysEqual,
  validateHumanApprovalCheckpointCompatibility,
} from "./human-approval-checkpoints.mjs";
import {
  agentHumanReviewApprovalRef,
  classifyHumanApprovalDecision,
} from "./interactions.mjs";
import {
  isPortablePayloadConstraintScalar,
  payloadValueKind,
  validateToolInputPayload,
  validateToolOutputPayload,
  validateToolPayloadConstraints,
} from "./payload-validation.mjs";
import {
  RUN_BUDGET_COUNTERS,
  RUN_BUDGET_ERROR_CODES,
  RUN_BUDGET_KIND_SET,
  createBudgetState,
} from "./runtime-budgets.mjs";
import {
  RuntimeCancelled,
  RuntimeFailure,
  RuntimeStop,
  ToubaRuntimeError,
} from "./runtime-errors.mjs";
import { executeRunLifecycle } from "./result-construction.mjs";
import {
  assertRunCanContinue as assertRuntimeRunCanContinue,
  assertRunCanDispatch as assertRuntimeRunCanDispatch,
  initializeRunControls as initializeRuntimeRunControls,
  requestRunCancel,
  traceRunCancelled,
} from "./run-controls.mjs";
import {
  AGENT_PROVIDER_OBSERVATIONS_DEFAULT_MAX_BYTES,
  normalizeAgentDecisionProvider,
  normalizeAgentDecisionProviderContentMode,
  normalizeNonNegativeRuntimeInteger,
  normalizeOptionalNonNegativeRuntimeInteger,
  normalizeOptionalPositiveRuntimeInteger,
  normalizePositiveRuntimeInteger,
  normalizeSkillPackActivationReasons,
  normalizeSkillPackBudgets,
  normalizeSkillPacks,
  normalizeStringSet,
  validateActiveSkillPackRefs,
} from "./runtime-options.mjs";
import {
  redactSecrets,
  resolvedSecretEntries,
  secretValuesForRedaction,
} from "./secret-redaction.mjs";
import {
  TRACE_PROTOCOL_VERSION,
  TraceBuilder,
  compactPayload,
  sha256Json,
} from "./trace-builder.mjs";

export { ToubaRuntimeError };
export { TRACE_PROTOCOL_VERSION };
export { AIR_CAPABILITY_PROFILE, AIR_JSON_PROFILE, AIR_SCHEMA_VERSION };
export { HARDENED_EXECUTION_PROFILE_VERSION, enforceHardenedExecutionProfile, probeHostSandbox };
export {
  COMPENSATION_HANDLER_PROTOCOL_VERSION,
  EFFECT_HANDLER_PROTOCOL_VERSION,
  EFFECT_JOURNAL_SCHEMA_VERSION,
  validateEffectJournalEntry,
};
export {
  EXECUTION_CHECKPOINT_VERSION,
  canonicalDigest,
  tracePrefixDigest,
  validateExecutionCheckpoint,
};

const TOUBA_MAX_SAFE_INT = 9007199254740991n;
const BUILTIN_TEXT = "builtin:Text";
const BUILTIN_BOOLEAN = "builtin:Boolean";
const BUILTIN_INT = "builtin:Int";
const BUILTIN_FLOAT = "builtin:Float";
const TOOL_BINDING_MANIFEST_V1 = "touba-manifest-v1";
const TOOL_BINDING_MANIFEST_V2 = "touba-manifest-v2";
const TOOL_BINDING_MANIFEST_V3 = "touba-manifest-v3";
const TOOL_BINDING_MANIFEST_VERSIONS = new Set([
  TOOL_BINDING_MANIFEST_V1,
  TOOL_BINDING_MANIFEST_V2,
  TOOL_BINDING_MANIFEST_V3,
]);
const COMPENSATION_ENTRY_REF_PATTERN = /^strategy:[A-Za-z0-9_.-]+\/[A-Za-z][A-Za-z0-9_]*$/u;
const NORMALIZED_TOOL_BINDING_MANIFESTS = new WeakSet();
const TOUBA_SECRETS_VERSION = "touba-secrets-v1";
const RESOURCE_BINDINGS_SCHEMA_VERSION = "touba-resource-bindings-v0.1";
const AGENT_DECISION_PROTOCOL_VERSION = "touba-agent-decision-v1";
const AGENT_MODEL_INPUT_PROTOCOL_VERSION = "touba-agent-model-input-v1";
const SECRET_HANDLE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SECRET_RECORD_STATUS_VALUES = new Set(["active", "revoked"]);
const DOTENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PAYLOAD_CONSTRAINT_PATH_PATTERN = /^(\$|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const PAYLOAD_CONSTRAINT_OPERATORS = new Set([
  "non_empty",
  "max_length",
  "min",
  "max",
  "allowed_values",
  "min_items",
  "max_items",
]);
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
const TOUBA_LOCAL_SECRET_STORE_VERSION = "touba-secret-store-local-v1";
const MEMORY_ACCESS_TO_CAPABILITY = Object.freeze({
  read: "memory_read",
  write: "memory_write",
});
const MEMORY_ACCESS_VALUES = new Set(Object.keys(MEMORY_ACCESS_TO_CAPABILITY));
const MEMORY_PI1_SOURCE_KINDS = new Set([
  "touba_run",
  "human_input",
  "external_content",
  "tool_result",
  "backend_import",
  "unknown",
]);
const MEMORY_PI1_INTEGRITY_EVIDENCE = new Set([
  "none",
  "handler_reported",
  "digest_reported",
  "digest_matched",
  "digest_mismatch",
  "stale_by_policy",
]);
const MEMORY_PI1_DIGEST_KINDS = new Set(["sha256"]);
const MEMORY_METADATA_FORBIDDEN_FIELDS = new Set([
  "owner_ref",
  "tool_ref",
  "run_id",
  "observed_at",
  "content",
  "raw",
  "document",
  "prompt",
  "secret",
  "connection_string",
  "verified",
  "unverified",
  "trust_score",
  "risk_score",
]);
const MEMORY_METADATA_ALLOWED_FIELDS = new Set([
  "memory_ref",
  "operation",
  "source_kind",
  "source_ref",
  "integrity_evidence",
  "writer_ref",
  "written_at",
  "digest_kind",
  "digest",
  "schema_ref",
  "version_ref",
]);
const MEMORY_METADATA_LEAK_FIELDS = new Set([
  "content",
  "raw",
  "document",
  "prompt",
  "secret",
  "connection_string",
]);
export const RUNTIME_CAPABILITIES = Object.freeze([
  AIR_SCHEMA_VERSION,
  AIR_JSON_PROFILE,
  AIR_CAPABILITY_PROFILE,
  "sequential-flow-v0.1",
  "simple-failure-paths-v0.1",
  TRACE_PROTOCOL_VERSION,
]);

export function loadAirFromJson(json) {
  let document;
  try {
    document = JSON.parse(json);
  } catch (error) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR JSON is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  validateAirDocument(document);
  return document;
}

export function loadToolBindingManifestFromJson(json) {
  let manifest;
  try {
    manifest = JSON.parse(json);
  } catch (error) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "manifest JSON is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return normalizeToolBindingManifest(manifest);
}

export function loadSecretsFromJson(json, options = {}) {
  let document;
  try {
    document = JSON.parse(json);
  } catch (error) {
    throw new ToubaRuntimeError("InvalidSecretsFile", "secrets JSON is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return normalizeSecretStore(document, options);
}

export async function executeAirDocument(document, options = {}) {
  validateAirDocument(document);

  const entryRef = options.entryRef ?? defaultEntryRef(document);
  const hardenedOptions = enforceHardenedExecutionProfile(document, options);
  const context = createExecutionContext(document, entryRef, { ...options, ...hardenedOptions });
  return executeRunLifecycle(
    context,
    async () => {
      if (context.executionDurability.enabled) {
        return executeDurableEntry(document, entryRef, context);
      }
      return context.humanApprovalResumeCheckpoint
        ? await executeHumanApprovalResumeCheckpoint(document, entryRef, context)
        : executeTarget(entryRef, context);
    },
    {
      initializeRunControls,
      traceRunCancelled,
      traceUnhandledRuntimeFailure,
    },
  );
}

export async function executeTriggerEvent(document, event, options = {}) {
  validateAirDocument(document);

  const triggerEvent = normalizeTriggerEvent(event);
  const entryRef = triggerEvent.triggerRef ?? "trigger:unknown";
  const hardenedOptions = enforceHardenedExecutionProfile(document, options);
  const context = createExecutionContext(document, entryRef, { ...options, ...hardenedOptions });
  return executeRunLifecycle(
    context,
    async () => context.humanApprovalResumeCheckpoint
      ? await executeTriggerHumanApprovalResumeCheckpoint(document, entryRef, context)
      : executeNormalizedTriggerEvent(triggerEvent, context),
    {
      initializeRunControls,
      traceRunCancelled,
      traceUnhandledRuntimeFailure,
    },
  );
}

async function executeTriggerHumanApprovalResumeCheckpoint(document, entryRef, context) {
  const result = await executeHumanApprovalResumeCheckpoint(document, entryRef, context);
  const trigger = context.indexes.triggers.get(entryRef);
  context.trace.push("trigger_execution_completed", {
    payload: compactPayload({
      trigger_ref: entryRef,
      target_ref: trigger?.target_ref,
      status: "success",
      resumed_from_checkpoint: true,
    }),
  });
  return result;
}

function createExecutionContext(document, entryRef, options = {}) {
  const internalCompensation = normalizeInternalCompensationContext(
    options.__compensationExecutionContext,
  );
  const indexes = indexAirDocument(document);
  const executionResumeCheckpoint = normalizeOptionalExecutionCheckpoint(
    options.executionResumeCheckpoint ?? options.execution_resume_checkpoint,
  );
  const executionCheckpointObserver = normalizeExecutionCheckpointObserver(
    options.executionCheckpointObserver ?? options.execution_checkpoint_observer,
  );
  const executionDurabilityEnabled = executionResumeCheckpoint !== null
    || executionCheckpointObserver !== null;
  const humanApprovalResumeCheckpoint = normalizeOptionalHumanApprovalCheckpoint(
    options.humanApprovalResumeCheckpoint ?? options.human_approval_resume_checkpoint,
  );
  if (executionDurabilityEnabled && humanApprovalResumeCheckpoint !== null) {
    throw new RuntimeFailure(
      "RESUME-1 cannot be combined with a human approval v0.1 checkpoint",
      {},
      "DurableResumeUnsupportedState",
    );
  }
  const runId = options.runId ?? options.run_id ?? executionResumeCheckpoint?.run_id ?? "run-1";
  const trace = new TraceBuilder(
    document,
    entryRef,
    runId,
    normalizeTraceEventObserver(options.traceEventObserver ?? options.trace_event_observer),
    executionResumeCheckpoint?.trace_state.next_sequence_index
      ?? internalCompensation?.trace_state?.next_sequence_index
      ?? 0,
  );
  const initialValues = normalizeInputs(options.inputs ?? {});
  const toolBindingManifest = normalizeOptionalToolBindingManifest(options.toolBindingManifest);
  const resourceBindings = normalizeOptionalResourceBindings(options.resourceBindings);
  const skillPacks = normalizeSkillPacks(options.skillPacks ?? options.skill_packs ?? []);
  const activeSkillPackRefs = normalizeStringSet(
    options.activeSkillPackRefs ?? options.active_skill_pack_refs ?? [],
    "activeSkillPackRefs",
  );
  validateActiveSkillPackRefs(skillPacks, activeSkillPackRefs);
  const context = {
    indexes,
    entryRef,
    trace,
    toolHandlers: options.toolHandlers ?? {},
    toolBindingManifest,
    resourceBindings,
    secretStore: normalizeOptionalSecretStore(options.secretStore),
    values: new Map(initialValues),
    inputValueKeys: new Set(initialValues.keys()),
    valueTypes: new Map(),
    humanApprovalDecisions: normalizeHumanApprovalDecisions(
      options.humanApprovalDecisions ?? options.humanApprovals ?? {},
    ),
    userInputs: normalizeUserInputs(options.userInputs ?? options.interactionInputs ?? {}),
    userInputProvider: normalizeUserInputProvider(options.userInputProvider),
    dispatchAuthorityProvider: normalizeDispatchAuthorityProvider(
      options.dispatchAuthorityProvider ?? options.dispatch_authority_provider,
    ),
    dispatchAuthorityProviderTimeoutMs: normalizeOptionalPositiveRuntimeInteger(
      options.dispatchAuthorityProviderTimeoutMs
        ?? options.dispatch_authority_provider_timeout_ms
        ?? null,
      "dispatchAuthorityProviderTimeoutMs",
    ),
    agentDecisions: normalizeAgentDecisions(options.agentDecisions ?? {}),
    agentDecisionProvider: normalizeAgentDecisionProvider(options.agentDecisionProvider, {
      metadata: options.agentDecisionProviderMetadata ?? options.agent_decision_provider_metadata,
    }),
    agentDecisionProviderTimeoutMs: normalizeOptionalPositiveRuntimeInteger(
      options.agentDecisionProviderTimeoutMs ?? options.agent_decision_provider_timeout_ms ?? null,
      "agentDecisionProviderTimeoutMs",
    ),
    agentDecisionProviderMaxRetries: normalizeOptionalNonNegativeRuntimeInteger(
      options.agentDecisionProviderMaxRetries ?? options.agent_decision_provider_max_retries ?? 0,
      "agentDecisionProviderMaxRetries",
    ) ?? 0,
    agentDecisionProviderContentMode: normalizeAgentDecisionProviderContentMode(
      options.agentDecisionProviderContentMode
        ?? options.agent_decision_provider_content_mode
        ?? options.agentModelInputContentMode
        ?? options.agent_model_input_content_mode
        ?? "inline",
    ),
    agentDecisionProviderInitialMode: normalizeAgentDecisionProviderInitialMode(
      options.agentDecisionProviderInitialMode
        ?? options.agent_decision_provider_initial_mode
        ?? "summary",
    ),
    agentDecisionProviderVisibleInputKeys: normalizeAgentDecisionProviderVisibleInputKeys(
      options.agentDecisionProviderVisibleInputKeys
        ?? options.agent_decision_provider_visible_input_keys
        ?? [],
    ),
    agentProviderObservationsMaxBytes: normalizeOptionalPositiveRuntimeInteger(
      options.agentProviderObservationsMaxBytes
        ?? options.agent_provider_observations_max_bytes
        ?? AGENT_PROVIDER_OBSERVATIONS_DEFAULT_MAX_BYTES,
      "agentProviderObservationsMaxBytes",
    ),
    skillPacks,
    activeSkillPackRefs,
    skillPackActivationReasons: normalizeSkillPackActivationReasons(
      options.skillPackActivationReasons ?? options.skill_pack_activation_reasons ?? {},
    ),
    skillPackBudgets: normalizeSkillPackBudgets(options),
    runState: createRunState(options),
    budgetState: createBudgetState(document, toolBindingManifest, options),
    maxAgentSteps: normalizePositiveRuntimeInteger(
      options.maxAgentSteps ?? options.maxAgentDecisionSteps ?? 8,
      "maxAgentSteps",
    ),
    triggerRunCounts: normalizeTriggerRunCounts(options.triggerRunCounts ?? {}),
    effectState: createEffectState(),
    effectScopeId: options.effectScopeId
      ?? options.effect_scope_id
      ?? executionResumeCheckpoint?.effect_scope_id
      ?? null,
    effectJournal: options.effectJournal ?? options.effect_journal ?? null,
    compensation: internalCompensation === null
      ? null
      : {
        config: internalCompensation,
        lastAttempt: null,
        outcome: null,
        blockerCode: null,
      },
    durableHumanApprovals: options.durableHumanApprovals === true
      || options.durable_human_approvals === true,
    humanApprovalResumeCheckpoint,
    pendingHumanApprovalCheckpoint: null,
    callStack: [],
    loopState: new Map(),
    maxLoopIterations: normalizePositiveRuntimeInteger(
      options.maxLoopIterations ?? options.max_loop_iterations ?? 100,
      "maxLoopIterations",
    ),
    activeAgentRef: null,
    activeCallerRef: null,
    nextCallIndex: 1,
    executionDurability: createExecutionDurabilityState({
      document,
      entryRef,
      runId,
      options,
      enabled: executionDurabilityEnabled,
      observer: executionCheckpointObserver,
      resumeCheckpoint: executionResumeCheckpoint,
    }),
  };
  if (executionResumeCheckpoint) {
    assertExecutionCheckpointHasNoResolvedSecret(
      executionResumeCheckpoint,
      secretValuesForRedaction(context.secretStore),
    );
    restoreDurableRuntimeState(context, executionResumeCheckpoint);
  }
  return context;
}

function createEffectState() {
  return {
    externalToolDispatches: 0,
    nextEffectIndex: 1,
  };
}

function createExecutionDurabilityState({
  document,
  entryRef,
  runId,
  options,
  enabled,
  observer,
  resumeCheckpoint,
}) {
  if (!enabled) {
    return {
      enabled: false,
      observer: null,
      resumeCheckpoint: null,
      pendingDispatch: null,
      decisionsConsumed: [],
    };
  }
  if (observer === null) {
    throw new ToubaRuntimeError(
      "InvalidRuntimeOption",
      "executionCheckpointObserver is required for durable execution",
    );
  }
  const operationId = options.operationId ?? options.operation_id ?? resumeCheckpoint?.operation_id;
  const effectScopeId = options.effectScopeId
    ?? options.effect_scope_id
    ?? resumeCheckpoint?.effect_scope_id;
  for (const [field, value] of [
    ["operationId", operationId],
    ["runId", runId],
    ["effectScopeId", effectScopeId],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ToubaRuntimeError(
        "InvalidRuntimeOption",
        `${field} is required for durable execution`,
      );
    }
  }
  if (operationId !== effectScopeId) {
    throw new ToubaRuntimeError(
      "InvalidRuntimeOption",
      "effectScopeId must equal operationId for durable execution",
    );
  }
  const explicitEvidence = options.executionCompatibility ?? options.execution_compatibility ?? {};
  if (!explicitEvidence || typeof explicitEvidence !== "object" || Array.isArray(explicitEvidence)) {
    throw new ToubaRuntimeError(
      "InvalidRuntimeOption",
      "executionCompatibility must be an object",
    );
  }
  const evidence = {
    ...explicitEvidence,
    run_plan: explicitEvidence.run_plan
      ?? explicitEvidence.runPlan
      ?? options.runPlan
      ?? options.run_plan
      ?? null,
    supply_chain_lock: explicitEvidence.supply_chain_lock
      ?? explicitEvidence.supplyChainLock
      ?? options.supplyChainLock
      ?? options.supply_chain_lock
      ?? null,
    hardened_profile: explicitEvidence.hardened_profile
      ?? explicitEvidence.hardenedProfile
      ?? options.hardenedExecutionProfile
      ?? options.hardened_execution_profile
      ?? null,
  };
  return {
    enabled: true,
    observer,
    resumeCheckpoint,
    operationId,
    runId,
    effectScopeId,
    entryRef,
    moduleRef: document.module.id,
    graphRef: null,
    cursor: resumeCheckpoint
      ? structuredClone(resumeCheckpoint.cursor)
      : null,
    pendingDispatch: resumeCheckpoint
      ? structuredClone(resumeCheckpoint.pending_dispatch)
      : null,
    decisionsConsumed: resumeCheckpoint
      ? structuredClone(resumeCheckpoint.decisions_consumed)
      : [],
    revision: resumeCheckpoint?.revision ?? 0,
    previousCheckpointDigest: resumeCheckpoint?.checkpoint_digest ?? null,
    tracePrefixDigest: resumeCheckpoint?.trace_state.prefix_digest
      ?? options.__compensationExecutionContext?.trace_state?.prefix_digest
      ?? null,
    traceEventOffset: 0,
    lastCheckpoint: resumeCheckpoint,
    compatibility: null,
    compatibilityEvidence: structuredClone(evidence),
    prepared: false,
    pendingReservedElapsedMs: null,
    pendingReservationRetained: false,
  };
}

function restoreDurableRuntimeState(context, checkpoint) {
  context.values = mapFromCheckpointObject(checkpoint.runtime_state.values, "runtime_state.values");
  context.valueTypes = mapFromCheckpointObject(
    checkpoint.runtime_state.value_types,
    "runtime_state.value_types",
  );
  context.inputValueKeys = new Set(checkpoint.runtime_state.input_keys);
  context.budgetState.counters = {
    steps: checkpoint.runtime_state.budget_counters.steps,
    toolCalls: checkpoint.runtime_state.budget_counters.tool_calls,
    agentInvocations: checkpoint.runtime_state.budget_counters.agent_invocations,
    providerCalls: checkpoint.runtime_state.budget_counters.provider_calls,
  };
  for (const [budgetKind, priorValue] of Object.entries(
    checkpoint.runtime_state.effective_limits,
  )) {
    const current = context.budgetState.effectiveLimits.get(budgetKind);
    if (!current || current.value > priorValue) {
      context.budgetState.effectiveLimits.set(budgetKind, Object.freeze({
        budgetKind,
        value: priorValue,
        authoritySource: current?.authoritySource ?? "checkpoint",
        candidates: [
          ...(current?.candidates ?? []),
          { authority_source: "checkpoint", value: priorValue },
        ],
      }));
    }
  }
  context.runState.activeElapsedBaseMs = checkpoint.runtime_state.active_elapsed_ms;
  context.effectState.externalToolDispatches = checkpoint.runtime_state.external_tool_dispatches;
  context.effectState.nextEffectIndex = checkpoint.runtime_state.next_effect_index;
  context.nextCallIndex = checkpoint.runtime_state.next_call_index;
}

async function executeDurableEntry(document, entryRef, context) {
  const graph = await prepareDurableExecution(document, entryRef, context);
  if (context.executionDurability.cursor.phase === "completed") {
    throw new RuntimeFailure(
      "durable execution is already terminal",
      { operationId: context.executionDurability.operationId },
      "DurableResumeNotAvailable",
    );
  }
  return executeGraph(graph.id, context, {
    startNodeId: context.executionDurability.cursor.node_id,
  });
}

async function prepareDurableExecution(document, entryRef, context) {
  const durable = context.executionDurability;
  if (durable.prepared) {
    return requireDefinition(context.indexes.graphs, durable.graphRef);
  }
  if (context.inputValueKeys.size !== 0) {
    throw new RuntimeFailure(
      "RESUME-1 does not persist runtime inputs without an opaque input contract",
      { inputCount: context.inputValueKeys.size },
      "DurableResumeUnsupportedState",
    );
  }
  const { definition, graphRef } = directEntryGraph(entryRef, context);
  const graph = requireDefinition(context.indexes.graphs, graphRef);
  if (context.compensation) {
    validateCompensationRuntimeClosure(graph, entryRef, context);
  }
  validateDurableGraphClosure(graph, entryRef, context);
  const linearNodes = durableLinearNodes(graph);
  durable.graphRef = graph.id;
  durable.compatibility = durableCompatibility(document, graph, context);

  for (const input of definition.signature?.inputs ?? []) {
    const handle = valueHandle(input.name);
    if (input.type_ref) context.valueTypes.set(handle, input.type_ref);
  }

  if (durable.resumeCheckpoint) {
    validateDurableResumeCompatibility(document, graph, linearNodes, context);
    assertDurableBudgetCountersWithinLimits(context);
  }
  const repairedEffectOrdinals = await repairDurableEffectOrdinalsFromScope(
    graph,
    linearNodes,
    context,
  );
  if (!durable.resumeCheckpoint) {
    durable.cursor = { node_id: graph.entry_node_id, phase: "ready" };
    await persistDurableExecutionCheckpoint(context);
  } else if (repairedEffectOrdinals) {
    await persistDurableExecutionCheckpoint(context);
  }
  durable.prepared = true;
  return graph;
}

function validateCompensationRuntimeClosure(graph, entryRef, context) {
  const config = context.compensation.config;
  if (entryRef !== config.inverse_entry_ref) {
    throw new RuntimeFailure(
      "compensation entry does not match its sealed plan",
      {},
      "CompensationCheckpointIncompatible",
    );
  }
  const ordered = durableLinearNodes(graph);
  const effectNodes = ordered.filter((node) => node.kind === "call_tool");
  const approvalNodes = ordered.filter((node) => node.kind === "human_approval");
  const effectIndex = ordered.findIndex((node) => node.kind === "call_tool");
  const terminalIndex = ordered.findIndex((node) => node.kind === "give" || node.kind === "stop");
  const validKinds = ordered.every((node, index) => {
    if (node.kind === "bind") return index < effectIndex;
    if (node.kind === "human_approval") return index < effectIndex;
    return node.kind === "call_tool" || node.kind === "give" || node.kind === "stop";
  });
  if (
    effectNodes.length !== 1
    || approvalNodes.length > 1
    || !validKinds
    || effectIndex < 0
    || terminalIndex !== effectIndex + 1
    || requiredTarget(effectNodes[0]) !== config.inverse_tool_ref
  ) {
    throw new RuntimeFailure(
      "compensation graph is outside the closed COMP-1 subset",
      {},
      "CompensationUnsupportedGraph",
    );
  }
  const binding = context.toolBindingManifest?.bindings.get(config.inverse_tool_ref);
  if (
    context.toolBindingManifest?.version !== TOOL_BINDING_MANIFEST_V3
    || binding?.effectContract?.kind !== "external_write"
    || binding.effectContract.compensation
  ) {
    throw new RuntimeFailure(
      "compensation inverse binding is invalid",
      {},
      "CompensationUnsupportedGraph",
    );
  }
}

async function repairDurableEffectOrdinalsFromScope(graph, linearNodes, context) {
  const adapter = requireEffectJournalAdapter(context.effectJournal);
  if (typeof adapter.entriesForScope !== "function") {
    throw new RuntimeFailure(
      "RESUME-1 requires effect journal scope enumeration",
      {},
      "DurableResumeUnsupportedState",
    );
  }
  let rawEntries;
  try {
    rawEntries = await adapter.entriesForScope(context.executionDurability.effectScopeId);
  } catch {
    throw new RuntimeFailure(
      "durable effect journal scope enumeration failed",
      {},
      "EffectJournalReadFailed",
    );
  }
  if (!Array.isArray(rawEntries)) {
    throw new RuntimeFailure(
      "durable effect journal scope enumeration is invalid",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
  if (!context.executionDurability.resumeCheckpoint && rawEntries.length > 0) {
    throw new RuntimeFailure(
      "a fresh durable execution cannot reuse a non-empty effect scope",
      {},
      "DurableResumeConflict",
    );
  }

  const effectScopeId = context.executionDurability.effectScopeId;
  const airDigest = airDocumentDigest(context.trace.airDocument);
  const callPrefix = `call:${context.trace.runId}:`;
  const effectIds = new Set();
  const effectIndexes = new Set();
  const entriesByEffectIndex = new Map();
  const callIndexes = new Set();
  const lastCallIndexByEffect = new Map();
  const externalWriteNodes = linearNodes.filter(
    (node) => durableNodeEffectKind(node, context) === "external_write",
  );
  let greatestEffectIndex = 0;
  let greatestCallIndex = 0;
  let totalJournalAttempts = 0;
  for (const rawEntry of rawEntries) {
    let entry;
    try {
      const effectId = rawEntry && typeof rawEntry === "object"
        ? rawEntry.effect_id
        : null;
      if (typeof effectId !== "string") throw new TypeError("missing effect identity");
      entry = validateEffectJournalEntry(rawEntry, effectId);
    } catch {
      throw new RuntimeFailure(
        "durable effect journal scope contains an invalid entry",
        {},
        "DurableResumeCheckpointIncompatible",
      );
    }
    const expectedEffectId = deriveEffectId({
      effectScopeId,
      airDigest,
      entryRef: context.entryRef,
      effectIndex: entry.effect_index,
    });
    if (
      entry.effect_scope_id !== effectScopeId
      || entry.air_digest !== airDigest
      || entry.entry_ref !== context.entryRef
      || entry.effect_id !== expectedEffectId
      || effectIds.has(entry.effect_id)
      || effectIndexes.has(entry.effect_index)
    ) {
      throw new RuntimeFailure(
        "durable effect journal scope conflicts with the current operation",
        {},
        "DurableResumeCheckpointIncompatible",
      );
    }
    const expectedNode = externalWriteNodes[entry.effect_index - 1];
    const expectedToolRef = expectedNode?.kind === "call_tool"
      ? requiredTarget(expectedNode)
      : null;
    const expectedBinding = expectedToolRef === null
      ? null
      : context.toolBindingManifest?.bindings.get(expectedToolRef);
    const expectedTool = expectedToolRef === null
      ? null
      : context.indexes.tools.get(expectedToolRef);
    const expectedRequestDigest = expectedNode
      ? durableStaticRequestDigest(graph, expectedNode, context)
      : null;
    assertNoResolvedSecretInEffectArtifact(
      entry,
      expectedToolRef ?? "tool:durable/unknown",
      "journal_entry",
      context.secretStore,
    );
    if (
      expectedToolRef === null
      || entry.tool_ref !== expectedToolRef
      || entry.retry_mode !== expectedBinding?.effectContract?.retryMode
      || (expectedRequestDigest !== null && entry.request_digest !== expectedRequestDigest)
    ) {
      throw new RuntimeFailure(
        "durable effect journal ordinal does not match its linear tool call",
        {},
        "DurableResumeCheckpointIncompatible",
      );
    }
    if (entry.state === "applied" && Object.hasOwn(entry, "result")) {
      try {
        if (context.compensation) {
          restoreCompensationEffectResult(
            expectedTool,
            expectedBinding,
            entry,
            context,
          );
        } else {
          if (entry.result?.schema_version === "touba-compensation-effect-result-v1") {
            throw new TypeError("reserved compensation result outside COMP-1");
          }
          validateToolOutputPayload(expectedTool, entry.result, context);
          validateToolPayloadConstraints(
            "output",
            expectedTool,
            entry.result,
            expectedBinding.payloadConstraints.output,
          );
        }
      } catch {
        throw new RuntimeFailure(
          "durable effect journal contains a non-restorable historical result",
          {},
          "DurableResumeCheckpointIncompatible",
        );
      }
    }
    effectIds.add(entry.effect_id);
    effectIndexes.add(entry.effect_index);
    entriesByEffectIndex.set(entry.effect_index, entry);
    greatestEffectIndex = Math.max(greatestEffectIndex, entry.effect_index);
    totalJournalAttempts += entry.attempt_count;
    if (!Number.isSafeInteger(totalJournalAttempts)) {
      throw new RuntimeFailure(
        "durable effect journal attempt total is invalid",
        {},
        "DurableResumeCheckpointIncompatible",
      );
    }

    if (entry.last_call_id !== undefined) {
      if (!entry.last_call_id.startsWith(callPrefix)) {
        throw new RuntimeFailure(
          "durable effect journal call identity conflicts with the current run",
          {},
          "DurableResumeCheckpointIncompatible",
        );
      }
      const callIndex = Number(entry.last_call_id.slice(callPrefix.length));
      if (
        !Number.isSafeInteger(callIndex)
        || callIndex <= 0
        || entry.last_call_id !== `${callPrefix}${callIndex}`
        || callIndexes.has(callIndex)
      ) {
        throw new RuntimeFailure(
          "durable effect journal call ordinal is invalid",
          {},
          "DurableResumeCheckpointIncompatible",
        );
      }
      if (entry.attempt_count > callIndex) {
        throw new RuntimeFailure(
          "durable effect journal attempt count exceeds its call ordinal",
          {},
          "DurableResumeCheckpointIncompatible",
        );
      }
      callIndexes.add(callIndex);
      lastCallIndexByEffect.set(entry.effect_index, callIndex);
      greatestCallIndex = Math.max(greatestCallIndex, callIndex);
    } else if (entry.attempt_count > 0) {
      throw new RuntimeFailure(
        "durable effect journal attempts require a call identity",
        {},
        "DurableResumeCheckpointIncompatible",
      );
    }
  }

  if (greatestCallIndex === Number.MAX_SAFE_INTEGER) {
    throw new RuntimeFailure(
      "durable effect journal call ordinal cannot advance",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
  const repairedCallIndex = Math.max(context.nextCallIndex, greatestCallIndex + 1);
  const orderedEffectIndexes = [...effectIndexes].sort((left, right) => left - right);
  if (orderedEffectIndexes.some((effectIndex, index) => effectIndex !== index + 1)) {
    throw new RuntimeFailure(
      "durable effect journal scope contains an ordinal gap",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
  let priorEffectLastCallIndex = 0;
  for (const effectIndex of orderedEffectIndexes) {
    const lastCallIndex = lastCallIndexByEffect.get(effectIndex);
    if (lastCallIndex === undefined) continue;
    if (lastCallIndex <= priorEffectLastCallIndex) {
      throw new RuntimeFailure(
        "durable effect journal call ordinals do not follow effect order",
        {},
        "DurableResumeCheckpointIncompatible",
      );
    }
    priorEffectLastCallIndex = lastCallIndex;
  }
  if (
    greatestEffectIndex >= context.effectState.nextEffectIndex
  ) {
    throw new RuntimeFailure(
      "durable effect journal is ahead of the checkpoint without a correlated pending dispatch",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
  const pending = context.executionDurability.pendingDispatch;
  let pendingJournalRelation = null;
  let repaired = false;
  let requiredHistoricalEffectIndex = context.effectState.nextEffectIndex - 1;
  if (pending?.effect_contract_kind === "external_write") {
    const journalEntry = entriesByEffectIndex.get(pending.effect_index);
    if (
      journalEntry
      && (
        journalEntry.effect_id !== pending.effect_id
        || journalEntry.request_digest !== pending.request_digest
        || journalEntry.tool_ref !== pending.tool_ref
        || journalEntry.retry_mode !== pending.retry_mode
      )
    ) {
      throw new RuntimeFailure(
        "durable effect journal does not match the pending checkpoint dispatch",
        {},
        "DurableResumeCheckpointIncompatible",
      );
    }
    pendingJournalRelation = validateDurablePendingJournalState(pending, journalEntry);
    if (
      pending.phase === "reserved"
      && pendingJournalRelation !== "current"
      && context.budgetState.counters.toolCalls
        - context.effectState.externalToolDispatches !== 1
    ) {
      throw new RuntimeFailure(
        "durable retry reservation is not reflected in dispatch counters",
        {},
        "DurableResumeCheckpointIncompatible",
      );
    }
    if (pending.phase === "reserved" && pendingJournalRelation === "current") {
      pending.phase = "dispatched";
      if (
        context.effectState.externalToolDispatches
        < context.budgetState.counters.toolCalls
      ) {
        recordExternalToolDispatch(context);
      }
      repaired = true;
    }
    if (!journalEntry && pending.phase === "reserved") {
      requiredHistoricalEffectIndex -= 1;
    }
  }
  for (const entry of entriesByEffectIndex.values()) {
    const isPendingEffect = pending?.effect_contract_kind === "external_write"
      && entry.effect_index === pending.effect_index;
    if (
      (!isPendingEffect && (entry.state !== "applied" || !Object.hasOwn(entry, "result")))
      || (entry.state === "applied" && !Object.hasOwn(entry, "result"))
      || (
        pending
        && !isPendingEffect
        && entry.last_call_id === pending.call_id
      )
    ) {
      throw new RuntimeFailure(
        "durable effect journal does not prove a restorable linear history",
        {},
        "DurableResumeCheckpointIncompatible",
      );
    }
  }
  if (greatestEffectIndex < requiredHistoricalEffectIndex) {
    throw new RuntimeFailure(
      "durable effect journal does not prove the complete checkpoint history",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
  if (totalJournalAttempts > context.effectState.externalToolDispatches) {
    throw new RuntimeFailure(
      "durable effect journal attempts exceed checkpoint dispatch consumption",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
  if (repairedCallIndex !== context.nextCallIndex) {
    throw new RuntimeFailure(
      "durable effect journal call high-water conflicts with checkpoint budgets",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
  return repaired;
}

function durableStaticRequestDigest(graph, node, context) {
  const argumentRefs = node.arguments ?? [];
  const stable = argumentRefs.every((argumentRef) => (
    typeof argumentRef === "string"
    && (
      argumentRef.startsWith("literal:")
      || argumentRef.startsWith("constant:")
    )
  ));
  if (!stable) return null;
  const toolRef = requiredTarget(node);
  const tool = context.indexes.tools.get(toolRef);
  if (!tool) return null;
  const argumentValues = resolveCallArguments(graph, node, context) ?? [];
  const inputs = tool.signature?.inputs ?? [];
  if (argumentValues.length !== inputs.length) return null;
  const argumentsByName = Object.fromEntries(
    inputs.map((input, index) => [input.name, argumentValues[index]]),
  );
  return deriveEffectRequestDigest({
    airDigest: airDocumentDigest(context.trace.airDocument),
    toolRef,
    arguments: argumentsByName,
    resourceBindings: resourceBindingsForTool(tool, context),
    ...(context.compensation
      ? { controlContext: context.compensation.config.envelope }
      : {}),
  });
}

function validateDurablePendingJournalState(pending, journalEntry) {
  if (!journalEntry) {
    if (pending.phase === "reserved" && pending.attempt_index === 1) return "absent";
    throw new RuntimeFailure(
      "durable pending dispatch is missing its required journal evidence",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
  const currentAttemptStates = new Set([
    "dispatched",
    "applied",
    "not_applied",
    "unknown",
  ]);
  const currentAttemptMatches = currentAttemptStates.has(journalEntry.state)
    && journalEntry.attempt_count === pending.attempt_index
    && journalEntry.last_call_id === pending.call_id;
  if (pending.phase === "dispatched") {
    if (currentAttemptMatches) return "current";
    throw new RuntimeFailure(
      "durable dispatched checkpoint conflicts with its effect journal attempt",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }

  const previousAttemptIndex = pending.attempt_index - 1;
  const preparedAttemptMatches = journalEntry.state === "prepared"
    && journalEntry.attempt_count === previousAttemptIndex
    && (
      previousAttemptIndex === 0
        ? journalEntry.last_call_id === undefined
        : journalEntry.last_call_id !== undefined
          && journalEntry.last_call_id !== pending.call_id
    );
  const retryReservationMatches = ["unknown", "not_applied"].includes(journalEntry.state)
    && journalEntry.attempt_count === previousAttemptIndex
    && journalEntry.last_call_id !== undefined
    && journalEntry.last_call_id !== pending.call_id;
  if (currentAttemptMatches) return "current";
  if (preparedAttemptMatches || retryReservationMatches) return "previous";
  throw new RuntimeFailure(
    "durable reserved checkpoint conflicts with its effect journal attempt",
    {},
    "DurableResumeCheckpointIncompatible",
  );
}

function directEntryGraph(entryRef, context) {
  let definition;
  let graphRef;
  if (entryRef.startsWith("function:")) {
    definition = context.indexes.functions.get(entryRef);
    graphRef = definition?.body_graph_ref;
  } else if (entryRef.startsWith("skill:")) {
    definition = context.indexes.skills.get(entryRef);
    graphRef = definition?.flow_graph_ref;
  } else if (entryRef.startsWith("strategy:")) {
    definition = context.indexes.strategies.get(entryRef);
    graphRef = definition?.flow_graph_ref;
  }
  if (!definition || typeof graphRef !== "string") {
    throw durableUnsupported(null, null, "entry_does_not_own_a_graph");
  }
  const graph = context.indexes.graphs.get(graphRef);
  if (!graph || graph.owner_ref !== entryRef) {
    throw durableUnsupported(graphRef, null, "entry_does_not_directly_own_graph");
  }
  return { definition, graphRef };
}

function validateDurableGraphClosure(graph, entryRef, context) {
  if (Array.isArray(graph.failure_paths) && graph.failure_paths.length > 0) {
    throw durableUnsupported(graph.id, graph.failure_paths[0]?.trigger_node_id, "failure_path");
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  const predecessors = new Map();
  for (const edge of graph.edges) {
    if (edge.role !== "next") continue;
    const targets = outgoing.get(edge.from_node_id) ?? [];
    targets.push(edge.to_node_id);
    outgoing.set(edge.from_node_id, targets);
    predecessors.set(edge.to_node_id, (predecessors.get(edge.to_node_id) ?? 0) + 1);
  }

  const visited = new Set();
  let nodeId = graph.entry_node_id;
  let terminalCount = 0;
  while (nodeId) {
    if (visited.has(nodeId)) {
      throw durableUnsupported(graph.id, nodeId, "cycle");
    }
    visited.add(nodeId);
    const node = nodes.get(nodeId);
    if (!node) throw durableUnsupported(graph.id, nodeId, "missing_node");
    if ((predecessors.get(nodeId) ?? 0) > 1) {
      throw durableUnsupported(graph.id, nodeId, "multiple_predecessors");
    }
    if (!["bind", "call_tool", "human_approval", "give", "stop"].includes(node.kind)) {
      throw durableUnsupported(graph.id, nodeId, `unsupported_node_${node.kind}`);
    }
    const allOutgoing = graph.edges.filter((edge) => edge.from_node_id === nodeId);
    if (allOutgoing.some((edge) => edge.role !== "next")) {
      throw durableUnsupported(graph.id, nodeId, "non_linear_edge");
    }
    const next = outgoing.get(nodeId) ?? [];
    if (next.length > 1) {
      throw durableUnsupported(graph.id, nodeId, "multiple_successors");
    }
    if (node.kind === "give" || node.kind === "stop") {
      terminalCount += 1;
      if (next.length !== 0) {
        throw durableUnsupported(graph.id, nodeId, "terminal_has_successor");
      }
      nodeId = null;
      continue;
    }
    if (next.length !== 1) {
      throw durableUnsupported(graph.id, nodeId, "non_terminal_without_successor");
    }
    if (node.kind === "call_tool") {
      validateDurableToolNode(graph, node, context);
    } else if (node.kind === "human_approval") {
      validateDurableHumanDecision(graph, node, context);
    }
    nodeId = next[0];
  }
  if (terminalCount !== 1) {
    throw durableUnsupported(graph.id, null, "terminal_count");
  }
  const reachableEdges = graph.edges.filter(
    (edge) => visited.has(edge.from_node_id) || visited.has(edge.to_node_id),
  );
  if (reachableEdges.some((edge) => !visited.has(edge.from_node_id) || !visited.has(edge.to_node_id))) {
    throw durableUnsupported(graph.id, null, "edge_leaves_reachable_closure");
  }
  if (graph.owner_ref !== entryRef) {
    throw durableUnsupported(graph.id, null, "graph_owner_mismatch");
  }
}

function durableLinearNodes(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const ordered = [];
  let nodeId = graph.entry_node_id;
  while (nodeId) {
    const node = nodes.get(nodeId);
    if (!node) break;
    ordered.push(node);
    nodeId = graph.edges.find(
      (edge) => edge.from_node_id === node.id && edge.role === "next",
    )?.to_node_id ?? null;
  }
  return ordered;
}

function validateDurableToolNode(graph, node, context) {
  const toolRef = requiredTarget(node);
  const tool = context.indexes.tools.get(toolRef);
  const manifest = context.toolBindingManifest;
  const binding = manifest?.bindings.get(toolRef);
  if (
    !tool
    || ![TOOL_BINDING_MANIFEST_V2, TOOL_BINDING_MANIFEST_V3].includes(manifest?.version)
    || !binding?.effectContract
  ) {
    throw durableUnsupported(graph.id, node.id, "manifest_v2_effect_contract_required");
  }
  if (context.toolHandlers[toolRef]) {
    throw durableUnsupported(graph.id, node.id, "in_process_handler_not_resumable");
  }
  const missingCapabilities = (tool.required_capabilities ?? [])
    .filter((capability) => !binding.grantSet.has(capability));
  const missingSecrets = (tool.required_secrets ?? [])
    .filter((secret) => !binding.secretSet.has(secret));
  const refusedSecrets = (tool.required_secrets ?? [])
    .filter((secret) => !context.secretStore || context.secretStore.refusalFor(
      secret,
      context.runState.now(),
    ) !== null);
  if (missingCapabilities.length || missingSecrets.length || refusedSecrets.length) {
    throw new RuntimeFailure(
      "durable execution authority is not currently available",
      {
        toolRef,
        missingCapabilities,
        missingSecrets,
        secretHandlesRefused: refusedSecrets,
      },
      "DurableResumeAuthorityRefused",
    );
  }
}

function validateDurableHumanDecision(graph, node, context) {
  const decisionRef = node.approval_ref ?? `approval:${graph.id}:${node.id}`;
  const decision = context.humanApprovalDecisions.get(decisionRef);
  const transition = classifyHumanApprovalDecision(decision);
  if (!transition.valid) {
    if (context.executionDurability.resumeCheckpoint) {
      throw new RuntimeFailure(
        "a consumed human decision is no longer available",
        { decisionRef },
        "DurableResumeAuthorityRefused",
      );
    }
    throw durableUnsupported(graph.id, node.id, "preavailable_human_decision_required");
  }
}

function durableCompatibility(document, graph, context) {
  const evidence = context.executionDurability.compatibilityEvidence;
  const manifestProjection = durableManifestProjection(context.toolBindingManifest);
  const resourceProjection = durableResourceBindingsProjection(context.resourceBindings);
  const manifestDigest = manifestProjection === null ? null : canonicalDigest(manifestProjection);
  const resourceBindingsDigest = resourceProjection === null
    ? null
    : canonicalDigest(resourceProjection);
  const runPlanDigest = optionalArtifactDigest(
    evidence.run_plan_digest ?? evidence.runPlanDigest ?? evidence.run_plan ?? null,
  );
  const supplyChainLockDigest = optionalArtifactDigest(
    evidence.supply_chain_lock_digest
      ?? evidence.supplyChainLockDigest
      ?? evidence.supply_chain_lock
      ?? null,
  );
  const hardenedProfileDigest = optionalArtifactDigest(
    evidence.hardened_profile_digest
      ?? evidence.hardenedProfileDigest
      ?? evidence.hardened_profile
      ?? null,
  );
  const compatibility = {
    air_schema_version: document.air_schema_version,
    air_digest: airDocumentDigest(document),
    manifest_schema_version: context.toolBindingManifest?.version ?? null,
    manifest_digest: manifestDigest,
    run_plan_digest: runPlanDigest,
    resource_bindings_digest: resourceBindingsDigest,
    supply_chain_lock_digest: supplyChainLockDigest,
    hardened_profile_digest: hardenedProfileDigest,
    authority_artifacts_digest: "",
  };
  compatibility.authority_artifacts_digest = canonicalDigest({
    entry_ref: context.entryRef,
    graph_ref: graph.id,
    ...(context.compensation
      ? { compensation_plan_digest: context.compensation.config.envelope.plan_digest }
      : {}),
    manifest_digest: manifestDigest,
    resource_bindings_digest: resourceBindingsDigest,
    run_plan_digest: runPlanDigest,
    supply_chain_lock_digest: supplyChainLockDigest,
    hardened_profile_digest: hardenedProfileDigest,
    decisions: durableDecisionProjection(graph, context),
  });
  return compatibility;
}

function optionalArtifactDigest(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)) return value;
  return canonicalDigest(value);
}

function durableManifestProjection(manifest) {
  if (!manifest) return null;
  return jsonPortableProjection({
    manifest_schema_version: manifest.version,
    bindings: Object.fromEntries([...manifest.bindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([toolRef, binding]) => [toolRef, {
        handler: { ...binding.handler },
        sandbox: { ...binding.sandbox },
        grants: [...binding.grants],
        secrets: [...binding.secrets],
        memories: binding.memories.map((memory) => ({ ...memory })),
        limits: { ...binding.limits },
        payload_constraints: {
          input: binding.payloadConstraints.input.map((rule) => ({ ...rule })),
          output: binding.payloadConstraints.output.map((rule) => ({ ...rule })),
        },
        effect_contract: binding.effectContract
          ? {
            ...binding.effectContract,
            ...(binding.effectContract.compensation
              ? { compensation: { ...binding.effectContract.compensation } }
              : {}),
          }
          : null,
      }])),
    triggers: Object.fromEntries([...manifest.triggers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([triggerRef, trigger]) => [triggerRef, trigger])),
    run_limits: Object.fromEntries([...manifest.runLimits.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, limit]) => [kind, limit.value])),
    agent_secret_scopes: Object.fromEntries([...manifest.agentSecretScopes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agentRef, secrets]) => [agentRef, [...secrets].sort()])),
  });
}

function durableResourceBindingsProjection(resourceBindings) {
  if (!resourceBindings) return null;
  return jsonPortableProjection(Object.fromEntries([...resourceBindings.bindings.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resourceRef, binding]) => [resourceRef, publicResourceBindingView(binding)])));
}

function jsonPortableProjection(value) {
  return JSON.parse(JSON.stringify(value));
}

function durableDecisionProjection(graph, context) {
  return graph.nodes
    .filter((node) => node.kind === "human_approval")
    .map((node) => {
      const decisionRef = node.approval_ref ?? `approval:${graph.id}:${node.id}`;
      return { decision_ref: decisionRef, result: context.humanApprovalDecisions.get(decisionRef) };
    })
    .sort((left, right) => left.decision_ref.localeCompare(right.decision_ref));
}

function validateDurableResumeCompatibility(document, graph, linearNodes, context) {
  const durable = context.executionDurability;
  const checkpoint = durable.resumeCheckpoint;
  const identityMatches = checkpoint.operation_id === durable.operationId
    && checkpoint.run_id === durable.runId
    && checkpoint.effect_scope_id === durable.effectScopeId
    && checkpoint.entry_ref === context.entryRef
    && checkpoint.module_ref === document.module.id
    && checkpoint.graph_ref === graph.id;
  if (!identityMatches) {
    throw new RuntimeFailure(
      "durable execution checkpoint identity does not match the requested run",
      { revision: checkpoint.revision },
      "DurableResumeCheckpointIncompatible",
    );
  }
  const cursorIndex = checkpoint.cursor.phase === "completed"
    ? linearNodes.length
    : linearNodes.findIndex((candidate) => candidate.id === checkpoint.cursor.node_id);
  const node = cursorIndex >= 0 && cursorIndex < linearNodes.length
    ? linearNodes[cursorIndex]
    : null;
  if (checkpoint.cursor.phase !== "completed" && !node) {
    throw new RuntimeFailure(
      "durable execution checkpoint cursor is absent from the graph",
      { nodeId: checkpoint.cursor.node_id },
      "DurableResumeCheckpointIncompatible",
    );
  }
  validateDurableCheckpointProgress(graph, linearNodes, cursorIndex, checkpoint, context);
  for (const consumed of checkpoint.decisions_consumed) {
    const current = context.humanApprovalDecisions.get(consumed.decision_ref);
    if (
      !classifyHumanApprovalDecision(current).valid
      || current !== consumed.result
      || canonicalDigest({ decision_ref: consumed.decision_ref, result: current })
        !== consumed.decision_digest
    ) {
      throw new RuntimeFailure(
        "a consumed human decision is no longer valid",
        { decisionRef: consumed.decision_ref },
        "DurableResumeAuthorityRefused",
      );
    }
  }
  if (canonicalDigest(checkpoint.compatibility) !== canonicalDigest(durable.compatibility)) {
    throw new RuntimeFailure(
      "durable execution artifacts changed since the checkpoint",
      { revision: checkpoint.revision },
      "DurableResumeCheckpointIncompatible",
    );
  }
  if (
    checkpoint.pending_dispatch
    && (
      checkpoint.cursor.phase !== "started"
      || checkpoint.pending_dispatch.node_id !== checkpoint.cursor.node_id
    )
  ) {
    throw new RuntimeFailure(
      "durable execution pending dispatch does not match the active cursor",
      { nodeId: checkpoint.cursor.node_id },
      "DurableResumeCheckpointIncompatible",
    );
  }
  if (checkpoint.pending_dispatch) {
    const toolRef = node?.kind === "call_tool" ? requiredTarget(node) : null;
    const binding = toolRef === null
      ? null
      : context.toolBindingManifest?.bindings.get(toolRef);
    const expectedKind = binding?.effectContract?.kind ?? null;
    const expectedRetryMode = expectedKind === "external_write"
      ? binding.effectContract.retryMode
      : null;
    const pendingMatchesCurrentTool = toolRef !== null
      && checkpoint.pending_dispatch.tool_ref === toolRef
      && checkpoint.pending_dispatch.effect_contract_kind === expectedKind
      && checkpoint.pending_dispatch.retry_mode === expectedRetryMode
      && checkpoint.pending_dispatch.timeout_ms === binding?.limits?.timeout_ms;
    if (!pendingMatchesCurrentTool) {
      throw new RuntimeFailure(
        "durable pending dispatch does not match the current tool contract",
        { nodeId: checkpoint.cursor.node_id, toolRef },
        "DurableResumeCheckpointIncompatible",
      );
    }
  }
}

function validateDurableCheckpointProgress(graph, linearNodes, cursorIndex, checkpoint, context) {
  const completedNodeCount = checkpoint.cursor.phase === "completed"
    ? linearNodes.length
    : cursorIndex;
  const expectedSteps = completedNodeCount
    + (checkpoint.cursor.phase === "started" ? 1 : 0);
  const counters = checkpoint.runtime_state.budget_counters;
  if (counters.steps !== expectedSteps) {
    throw new RuntimeFailure(
      "durable checkpoint step counter does not match its linear cursor",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }

  const expectedDecisionRefs = linearNodes
    .slice(0, completedNodeCount)
    .filter((node) => node.kind === "human_approval")
    .map((node) => node.approval_ref ?? `approval:${graph.id}:${node.id}`);
  const actualDecisionRefs = checkpoint.decisions_consumed
    .map((decision) => decision.decision_ref);
  if (
    actualDecisionRefs.length !== expectedDecisionRefs.length
    || actualDecisionRefs.some((decisionRef, index) => decisionRef !== expectedDecisionRefs[index])
  ) {
    throw new RuntimeFailure(
      "durable decision ledger does not match the linear cursor",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }

  const toolCalls = counters.tool_calls;
  const externalDispatches = checkpoint.runtime_state.external_tool_dispatches;
  const pending = checkpoint.pending_dispatch;
  const dispatchGap = toolCalls - externalDispatches;
  const completedToolCalls = linearNodes
    .slice(0, completedNodeCount)
    .filter((node) => node.kind === "call_tool")
    .length;
  const currentToolReservation = checkpoint.cursor.phase === "started" && pending !== null
    ? 1
    : 0;
  const currentToolDispatch = checkpoint.cursor.phase === "started"
    && pending?.phase === "dispatched"
    ? 1
    : 0;
  const callCountersMatch = checkpoint.runtime_state.next_call_index === toolCalls + 1
    && counters.agent_invocations === 0
    && counters.provider_calls === 0
    && toolCalls >= completedToolCalls + currentToolReservation
    && externalDispatches >= completedToolCalls + currentToolDispatch
    && externalDispatches <= toolCalls
    && (
      pending === null
        ? dispatchGap === 0
        : pending.phase === "dispatched"
          ? dispatchGap === 0
          : [0, 1].includes(dispatchGap)
    )
    && (!pending || pending.call_index === toolCalls)
    && !(
      pending?.phase === "reserved"
      && pending.effect_contract_kind === "none"
      && dispatchGap !== 1
    );
  if (!callCountersMatch) {
    throw new RuntimeFailure(
      "durable checkpoint call counters do not match its dispatch state",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }

  const completedExternalWrites = linearNodes
    .slice(0, completedNodeCount)
    .filter((node) => durableNodeEffectKind(node, context) === "external_write")
    .length;
  const currentExternalWriteReserved = checkpoint.cursor.phase === "started"
    && pending?.effect_contract_kind === "external_write"
    ? 1
    : 0;
  if (
    checkpoint.runtime_state.next_effect_index
    !== completedExternalWrites + currentExternalWriteReserved + 1
  ) {
    throw new RuntimeFailure(
      "durable checkpoint effect counter does not match its linear cursor",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
}

function durableNodeEffectKind(node, context) {
  if (node?.kind !== "call_tool") return null;
  const toolRef = requiredTarget(node);
  return context.toolBindingManifest?.bindings.get(toolRef)?.effectContract?.kind ?? null;
}

function durableUnsupported(graphRef, nodeId, reason) {
  return new RuntimeFailure(
    "entry graph is outside the RESUME-1 closure",
    compactPayload({ graphRef, nodeId, reason }),
    "DurableResumeUnsupportedGraph",
  );
}

async function executeHumanApprovalResumeCheckpoint(document, entryRef, context) {
  const checkpoint = context.humanApprovalResumeCheckpoint;
  if (!checkpoint) {
    throw new RuntimeFailure(
      "human approval resume checkpoint is required",
      { entryRef },
      "HumanApprovalResumeCheckpointRequired",
    );
  }
  if (checkpoint.kind === "agent_human_review") {
    return executeAgentHumanReviewResumeCheckpoint(document, entryRef, context, checkpoint);
  }
  validateHumanApprovalResumeCheckpoint(document, entryRef, context, checkpoint);
  applyHumanApprovalResumeCheckpoint(context, checkpoint);
  context.trace.push("human_approval_checkpoint_loaded", {
    payload: compactPayload({
      checkpoint_schema_version: checkpoint.checkpoint_schema_version,
      kind: checkpoint.kind,
      approval_ref: checkpoint.approval_ref,
      graph_ref: checkpoint.graph_ref,
      node_id: checkpoint.node_id,
      resume_target_ref: checkpoint.resume_target_ref,
      checkpoint_run_id: checkpoint.run_id,
      trace_prefix_digest: checkpoint.trace_prefix_digest,
      external_tool_dispatches: checkpoint.effect_state?.external_tool_dispatches,
    }),
  });
  return executeGraph(checkpoint.graph_ref, context, {
    startNodeId: checkpoint.node_id, loopState: context.loopState,
  });
}

function validateHumanApprovalResumeCheckpoint(document, entryRef, context, checkpoint) {
  if (checkpoint.kind !== "human_approval") {
    throw new RuntimeFailure(
      "human approval checkpoint kind is invalid",
      { entryRef, checkpointKind: checkpoint.kind },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  validateHumanApprovalCheckpointCompatibility(document, entryRef, checkpoint, {
    expectedScope: "entry_graph",
  });

  const graph = context.indexes.graphs.get(checkpoint.graph_ref);
  const node = graph?.nodes?.find((candidate) => candidate.id === checkpoint.node_id);
  if (!graph || !node || node.kind !== "human_approval") {
    throw new RuntimeFailure(
      "human approval checkpoint target is invalid",
      {
        entryRef,
        approvalRef: checkpoint.approval_ref,
        graphRef: checkpoint.graph_ref,
        nodeId: checkpoint.node_id,
      },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  const approvalRef = node.approval_ref ?? `approval:${graph.id}:${node.id}`;
  const resumeTargetRef = nextNodeId(graph, node.id, successEdgeRole(graph, node.id));
  if (
    checkpoint.approval_ref !== approvalRef
    || checkpoint.resume_target_ref !== resumeTargetRef
    || checkpoint.decision_binding !== node.result_binding
  ) {
    throw new RuntimeFailure(
      "human approval checkpoint target does not match AIR",
      {
        entryRef,
        approvalRef: checkpoint.approval_ref,
        graphRef: checkpoint.graph_ref,
        nodeId: checkpoint.node_id,
      },
      "HumanApprovalCheckpointIncompatible",
    );
  }
  if (!context.humanApprovalDecisions.has(checkpoint.approval_ref)) {
    throw new RuntimeFailure(
      "human approval resume requires an explicit decision",
      { entryRef, approvalRef: checkpoint.approval_ref },
      "HumanApprovalResumeDecisionRequired",
    );
  }
}

function applyHumanApprovalResumeCheckpoint(context, checkpoint) {
  context.loopState = graphLoopStateFromHumanCheckpoint(context, checkpoint);
  context.values = mapFromCheckpointObject(checkpoint.values, "values");
  context.inputValueKeys = new Set(checkpointStringArray(checkpoint.input_value_keys, "input_value_keys"));
  context.valueTypes = mapFromCheckpointObject(checkpoint.value_types ?? {}, "value_types");
  context.budgetState.counters = {
    steps: checkpoint.budget_counters?.steps ?? 0,
    toolCalls: checkpoint.budget_counters?.tool_calls ?? 0,
    agentInvocations: checkpoint.budget_counters?.agent_invocations ?? 0,
    providerCalls: checkpoint.budget_counters?.provider_calls ?? 0,
  };
  context.effectState.externalToolDispatches = checkpoint.effect_state?.external_tool_dispatches ?? 0;
  context.effectState.nextEffectIndex = checkpoint.effect_state?.next_effect_index ?? 1;
  context.nextCallIndex = checkpoint.next_call_index ?? 1;
  context.activeAgentRef = checkpoint.active_agent_ref ?? null;
  context.activeCallerRef = checkpoint.active_caller_ref ?? null;
}

function graphLoopStateFromHumanCheckpoint(context, checkpoint) {
  const graphRef = checkpoint.kind === "human_approval"
    ? checkpoint.graph_ref : checkpoint.call_frame?.graph_ref;
  const graph = graphRef ? context.indexes.graphs.get(graphRef) : null;
  const loopKeys = new Set((graph?.nodes ?? [])
    .filter(node => node.kind === "loop").map(node => `${graph.id}:${node.id}`));
  // Legacy checkpoints are still usable for loop-free graphs. A cursor cannot
  // be reconstructed safely for an older checkpoint of a graph containing loops.
  if (checkpoint.loop_state === undefined && loopKeys.size > 0) {
    throw new RuntimeFailure("human approval checkpoint is missing graph loop cursors",
      { graphRef }, "HumanApprovalCheckpointIncompatible");
  }
  const states = mapFromCheckpointObject(checkpoint.loop_state ?? {}, "loop_state");
  for (const [key, state] of states) {
    if (!loopKeys.has(key) || !state || typeof state !== "object" || Array.isArray(state)
      || Object.keys(state).length !== 1 || !Object.hasOwn(state, "index")) {
      throw new RuntimeFailure("human approval checkpoint loop cursor does not match AIR",
        { graphRef, loopKey: key }, "InvalidHumanApprovalCheckpoint");
    }
    checkpointNonNegativeSafeInteger(state.index, `loop_state.${key}.index`);
  }
  return states;
}

async function executeAgentHumanReviewResumeCheckpoint(document, entryRef, context, checkpoint) {
  validateAgentHumanReviewResumeCheckpoint(document, entryRef, context, checkpoint);
  applyHumanApprovalResumeCheckpoint(context, checkpoint);
  const loopState = agentLoopStateFromCheckpoint(checkpoint);
  context.trace.push("human_approval_checkpoint_loaded", {
    payload: compactPayload({
      checkpoint_schema_version: checkpoint.checkpoint_schema_version,
      kind: checkpoint.kind,
      approval_ref: checkpoint.approval_ref,
      agent_ref: checkpoint.agent_ref,
      step_index: loopState.stepIndex,
      next_step_index: loopState.nextStepIndex,
      checkpoint_run_id: checkpoint.run_id,
      trace_prefix_digest: checkpoint.trace_prefix_digest,
      external_tool_dispatches: checkpoint.effect_state?.external_tool_dispatches,
      observation_count: loopState.observations.length,
      call_frame_present: checkpoint.call_frame !== undefined && checkpoint.call_frame !== null,
    }),
  });

  const agent = requireDefinition(context.indexes.agents, checkpoint.agent_ref);
  const capabilityRefs = Array.isArray(agent.uses) ? [...agent.uses] : [];
  const reviewResult = resumeAgentHumanReviewDecision(agent, checkpoint, context, loopState.stepIndex);
  const observations = [
    ...loopState.observations,
    {
      step_index: loopState.stepIndex,
      action: "request_human_review",
      result_type: "human_review_decision",
      value: reviewResult,
    },
  ];
  const agentResult = await executeAgentDecisionLoop(agent, capabilityRefs, context, {
    startStepIndex: loopState.nextStepIndex,
    observations,
  });

  return resumeAgentHumanReviewCaller(context, checkpoint, agent, agentResult);
}

function validateAgentHumanReviewResumeCheckpoint(document, entryRef, context, checkpoint) {
  validateHumanApprovalCheckpointCompatibility(document, entryRef, checkpoint, {
    expectedScope: "agent_decision_loop",
  });
  if (checkpoint.kind !== "agent_human_review") {
    throw new RuntimeFailure(
      "human approval checkpoint kind is invalid",
      { entryRef, checkpointKind: checkpoint.kind },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  const agentRef = checkpoint.agent_ref;
  const agent = context.indexes.agents.get(agentRef);
  if (!agent) {
    throw new RuntimeFailure(
      "agent human review checkpoint target agent is invalid",
      { entryRef, approvalRef: checkpoint.approval_ref, agentRef },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  const loopState = agentLoopStateFromCheckpoint(checkpoint);
  const capabilityRefs = Array.isArray(agent.uses) ? [...agent.uses] : [];
  if (
    loopState.agentRef !== agentRef
    || checkpoint.approval_ref !== agentHumanReviewApprovalRef(agentRef, loopState.stepIndex)
    || !stringArraysEqual(loopState.capabilityRefs, capabilityRefs)
  ) {
    throw new RuntimeFailure(
      "agent human review checkpoint target does not match AIR",
      {
        entryRef,
        approvalRef: checkpoint.approval_ref,
        agentRef,
      },
      "HumanApprovalCheckpointIncompatible",
    );
  }
  if (!context.humanApprovalDecisions.has(checkpoint.approval_ref)) {
    throw new RuntimeFailure(
      "human approval resume requires an explicit decision",
      { entryRef, approvalRef: checkpoint.approval_ref },
      "HumanApprovalResumeDecisionRequired",
    );
  }
  validateAgentHumanReviewCallFrame(context, checkpoint, agentRef);
}

function agentLoopStateFromCheckpoint(checkpoint) {
  const loopState = checkpoint.agent_loop_state;
  if (!loopState || typeof loopState !== "object" || Array.isArray(loopState)) {
    throw new RuntimeFailure(
      "agent human review checkpoint agent_loop_state must be an object",
      { approvalRef: checkpoint.approval_ref },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  const agentRef = checkpointString(loopState.agent_ref, "agent_loop_state.agent_ref");
  const stepIndex = checkpointNonNegativeSafeInteger(loopState.step_index, "agent_loop_state.step_index");
  const nextStepIndex = checkpointNonNegativeSafeInteger(loopState.next_step_index, "agent_loop_state.next_step_index");
  if (nextStepIndex !== stepIndex + 1) {
    throw new RuntimeFailure(
      "agent human review checkpoint next_step_index must follow step_index",
      { approvalRef: checkpoint.approval_ref, stepIndex, nextStepIndex },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  const observations = checkpointJsonClone(
    checkpointArray(loopState.observations, "agent_loop_state.observations"),
    "agent_loop_state.observations",
  );
  const capabilityRefs = checkpointStringArray(loopState.capability_refs, "agent_loop_state.capability_refs");
  return {
    agentRef,
    stepIndex,
    nextStepIndex,
    observations,
    capabilityRefs,
  };
}

function validateAgentHumanReviewCallFrame(context, checkpoint, agentRef) {
  if (checkpoint.call_frame === undefined || checkpoint.call_frame === null) {
    if (checkpoint.entry_ref === agentRef) {
      return;
    }
    throw new RuntimeFailure(
      "agent human review checkpoint has no resumable caller frame",
      { approvalRef: checkpoint.approval_ref, agentRef },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  const frame = checkpoint.call_frame;
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new RuntimeFailure(
      "agent human review checkpoint call_frame must be an object",
      { approvalRef: checkpoint.approval_ref, agentRef },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  const graphRef = checkpointString(frame.graph_ref, "call_frame.graph_ref");
  const nodeId = checkpointString(frame.node_id, "call_frame.node_id");
  const graph = context.indexes.graphs.get(graphRef);
  const node = graph?.nodes?.find((candidate) => candidate.id === nodeId);
  const expectedResumeTargetRef = graph && node ? nextNodeId(graph, node.id, successEdgeRole(graph, node.id)) : undefined;
  if (
    !graph
    || !node
    || node.kind !== "call_agent"
    || node.target_ref !== agentRef
    || graph.owner_ref !== checkpoint.entry_ref
    || frame.caller_ref !== graph.owner_ref
    || frame.target_ref !== agentRef
    || frame.result_binding !== node.result_binding
    || frame.resume_target_ref !== expectedResumeTargetRef
  ) {
    throw new RuntimeFailure(
      "agent human review checkpoint caller frame does not match AIR",
      {
        approvalRef: checkpoint.approval_ref,
        agentRef,
        graphRef,
        nodeId,
      },
      "HumanApprovalCheckpointIncompatible",
    );
  }
}

function resumeAgentHumanReviewDecision(agent, checkpoint, context, stepIndex) {
  const approvalRef = checkpoint.approval_ref;
  const humanDecision = context.humanApprovalDecisions.get(approvalRef);
  const transition = classifyHumanApprovalDecision(humanDecision);
  if (!transition.valid) {
    const error = new RuntimeFailure(
      `invalid human approval decision ${humanDecision} for ${approvalRef}`,
      { approvalRef, decision: humanDecision, agentRef: agent.id },
      "InvalidHumanApprovalDecision",
    );
    context.trace.push("failure_detected", {
      payload: compactPayload({
        failure_mode: "human_approval",
        runtime_error_code: error.code,
        approval_ref: approvalRef,
        agent_ref: agent.id,
        step_index: stepIndex,
      }),
      message: error.message,
    });
    throw error;
  }

  context.trace.push("human_approval_decided", {
    payload: {
      approval_ref: approvalRef,
      decision: humanDecision,
      agent_ref: agent.id,
      step_index: stepIndex,
    },
  });

  if (transition.approved) {
    context.trace.push("human_approval_resumed", {
      payload: {
        approval_ref: approvalRef,
        decision: humanDecision,
        agent_ref: agent.id,
        step_index: stepIndex,
      },
    });
    return {
      approval_ref: approvalRef,
      decision: humanDecision,
    };
  }

  context.trace.push(transition.terminalEvent, {
    payload: {
      approval_ref: approvalRef,
      decision: humanDecision,
      agent_ref: agent.id,
      step_index: stepIndex,
    },
  });
  throw new RuntimeStop(`agent human review ${humanDecision}`, {
    approvalRef,
    agentRef: agent.id,
    decision: humanDecision,
  });
}

async function resumeAgentHumanReviewCaller(context, checkpoint, agent, agentResult) {
  if (checkpoint.call_frame === undefined || checkpoint.call_frame === null) {
    return agentResult;
  }
  const graph = requireDefinition(context.indexes.graphs, checkpoint.call_frame.graph_ref);
  const node = graph.nodes.find((candidate) => candidate.id === checkpoint.call_frame.node_id);
  if (!node) {
    throw new RuntimeFailure(
      "agent human review checkpoint caller node is missing",
      {
        approvalRef: checkpoint.approval_ref,
        agentRef: agent.id,
        graphRef: checkpoint.call_frame.graph_ref,
        nodeId: checkpoint.call_frame.node_id,
      },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  if (node.result_binding) {
    const bindingHandle = valueHandle(node.result_binding);
    context.values.set(bindingHandle, agentResult);
    const outputType = targetOutputType(agent.id, context);
    if (outputType) {
      context.valueTypes.set(bindingHandle, outputType);
    }
  }
  context.trace.push("call_completed", {
    airRef: airRefForNode(graph, node),
    payload: compactPayload({
      target_ref: agent.id,
      caller_ref: graph.owner_ref,
      agent_ref: context.activeAgentRef,
      result_binding: node.result_binding,
      resumed_from_checkpoint: true,
    }),
  });
  const resumeTargetRef = checkpoint.call_frame.resume_target_ref;
  if (resumeTargetRef) {
    return executeGraph(graph.id, context, {
      startNodeId: resumeTargetRef, loopState: context.loopState,
    });
  }
  context.trace.push("scope_exited", {
    airRef: {
      flow_graph_ref: graph.id,
      owner_ref: graph.owner_ref,
      node_id: node.id,
    },
    payload: {
      status: "success",
    },
  });
  return agentResult;
}

function createHumanApprovalCheckpoint(context, graph, node, payload) {
  const values = checkpointObjectFromMap(context.values, "values");
  assertCheckpointHasNoResolvedSecret(values, context, payload.approval_ref);
  const valueTypes = checkpointObjectFromMap(context.valueTypes, "value_types");
  const tracePrefixDigest = `sha256:${sha256Json(context.trace.document())}`;
  const checkpoint = {
    checkpoint_schema_version: HUMAN_APPROVAL_CHECKPOINT_VERSION,
    kind: "human_approval",
    scope: "entry_graph",
    run_id: context.trace.runId,
    entry_ref: context.entryRef,
    module_ref: context.trace.airDocument.module.id,
    air_schema_version: context.trace.airDocument.air_schema_version,
    air_digest: airDocumentDigest(context.trace.airDocument),
    approval_ref: payload.approval_ref,
    mode: payload.mode,
    graph_ref: graph.id,
    node_id: node.id,
    resume_target_ref: payload.resume_target_ref,
    decision_binding: node.result_binding,
    context_refs: payload.context_refs ?? [],
    loop_state: checkpointObjectFromMap(context.loopState, "loop_state"),
    caller_ref: payload.caller_ref,
    agent_ref: payload.agent_ref,
    requester_ref: payload.requester_ref,
    required_by_ref: payload.required_by_ref,
    values,
    input_value_keys: [...context.inputValueKeys],
    value_types: valueTypes,
    budget_counters: {
      steps: context.budgetState.counters.steps,
      tool_calls: context.budgetState.counters.toolCalls,
      agent_invocations: context.budgetState.counters.agentInvocations,
      provider_calls: context.budgetState.counters.providerCalls,
    },
    effect_state: {
      external_tool_dispatches: context.effectState.externalToolDispatches,
      next_effect_index: context.effectState.nextEffectIndex,
    },
    next_call_index: context.nextCallIndex,
    active_agent_ref: context.activeAgentRef,
    active_caller_ref: context.activeCallerRef,
    trace_prefix_digest: tracePrefixDigest,
  };
  context.pendingHumanApprovalCheckpoint = checkpoint;
  context.trace.push("human_approval_checkpoint_created", {
    airRef: airRefForNode(graph, node),
    payload: compactPayload({
      checkpoint_schema_version: HUMAN_APPROVAL_CHECKPOINT_VERSION,
      approval_ref: payload.approval_ref,
      graph_ref: graph.id,
      node_id: node.id,
      resume_target_ref: payload.resume_target_ref,
      trace_prefix_digest: tracePrefixDigest,
      external_tool_dispatches: context.effectState.externalToolDispatches,
    }),
  });
  return checkpoint;
}

function createAgentHumanReviewCheckpoint(context, agent, decision, stepIndex, observations, payload, callFrame) {
  const values = checkpointObjectFromMap(context.values, "values");
  assertCheckpointHasNoResolvedSecret(values, context, payload.approval_ref);
  const checkpointObservations = checkpointJsonClone(observations, "agent_loop_state.observations");
  assertCheckpointHasNoResolvedSecret(checkpointObservations, context, payload.approval_ref);
  const valueTypes = checkpointObjectFromMap(context.valueTypes, "value_types");
  const tracePrefixDigest = `sha256:${sha256Json(context.trace.document())}`;
  const capabilityRefs = Array.isArray(agent.uses) ? [...agent.uses] : [];
  const checkpoint = {
    checkpoint_schema_version: HUMAN_APPROVAL_CHECKPOINT_VERSION,
    kind: "agent_human_review",
    scope: "agent_decision_loop",
    run_id: context.trace.runId,
    entry_ref: context.entryRef,
    module_ref: context.trace.airDocument.module.id,
    air_schema_version: context.trace.airDocument.air_schema_version,
    air_digest: airDocumentDigest(context.trace.airDocument),
    approval_ref: payload.approval_ref,
    mode: payload.mode,
    agent_ref: agent.id,
    caller_ref: payload.caller_ref,
    requester_ref: payload.requester_ref,
    review_prompt: decision.reviewPrompt ?? "Review the requested agent decision.",
    review_reason: decision.reason ?? "Human review requested by the agent.",
    step_index: stepIndex,
    agent_loop_state: {
      agent_ref: agent.id,
      step_index: stepIndex,
      next_step_index: stepIndex + 1,
      capability_refs: capabilityRefs,
      observations: checkpointObservations,
      consumed_decisions: [
        ...checkpointObservations.map((observation) => compactPayload({
          step_index: observation.step_index,
          action: observation.action,
          target_ref: observation.target_ref,
        })),
        compactPayload({
          step_index: stepIndex,
          action: "request_human_review",
          decision_source: decision.source,
          reason: decision.reason,
          review_prompt_present: decision.reviewPrompt !== undefined,
        }),
      ],
    },
    call_frame: callFrame,
    loop_state: checkpointObjectFromMap(context.loopState, "loop_state"),
    values,
    input_value_keys: [...context.inputValueKeys],
    value_types: valueTypes,
    budget_counters: {
      steps: context.budgetState.counters.steps,
      tool_calls: context.budgetState.counters.toolCalls,
      agent_invocations: context.budgetState.counters.agentInvocations,
      provider_calls: context.budgetState.counters.providerCalls,
    },
    effect_state: {
      external_tool_dispatches: context.effectState.externalToolDispatches,
      next_effect_index: context.effectState.nextEffectIndex,
    },
    next_call_index: context.nextCallIndex,
    active_agent_ref: context.activeAgentRef,
    active_caller_ref: context.activeCallerRef,
    trace_prefix_digest: tracePrefixDigest,
  };
  context.pendingHumanApprovalCheckpoint = checkpoint;
  context.trace.push("human_approval_checkpoint_created", {
    payload: compactPayload({
      checkpoint_schema_version: HUMAN_APPROVAL_CHECKPOINT_VERSION,
      kind: checkpoint.kind,
      approval_ref: payload.approval_ref,
      agent_ref: agent.id,
      step_index: stepIndex,
      next_step_index: stepIndex + 1,
      trace_prefix_digest: tracePrefixDigest,
      external_tool_dispatches: context.effectState.externalToolDispatches,
      observation_count: checkpointObservations.length,
      call_frame_present: callFrame !== undefined && callFrame !== null,
    }),
  });
  return checkpoint;
}

function canCreateHumanApprovalCheckpoint(context, graph) {
  if (context.durableHumanApprovals !== true) {
    return false;
  }
  if (graph.owner_ref === context.entryRef) {
    return true;
  }
  const entryTrigger = context.indexes.triggers.get(context.entryRef);
  return entryTrigger?.target_kind === "strategy"
    && entryTrigger.target_ref === graph.owner_ref;
}

function agentHumanReviewCheckpointSupport(context, agentRef) {
  if (context.durableHumanApprovals !== true) {
    return {
      supported: false,
      reason: "durable_human_approvals_disabled",
      callFrame: null,
    };
  }
  if (context.entryRef === agentRef) {
    return {
      supported: true,
      callFrame: null,
    };
  }
  const frame = context.callStack.at(-1);
  if (!frame || frame.kind !== "call_agent" || frame.target_ref !== agentRef) {
    return {
      supported: false,
      reason: "agent_review_call_frame_unavailable",
      callFrame: null,
    };
  }
  if (frame.graph_owner_ref !== context.entryRef) {
    return {
      supported: false,
      reason: "nested_caller_graph_requires_call_stack_checkpoint",
      callFrame: frame,
    };
  }
  return {
    supported: true,
    callFrame: frame,
  };
}

function refuseAgentHumanReviewCheckpointUnavailable(context, payload, support) {
  const reason = support.reason ?? "agent_human_review_checkpoint_unavailable";
  context.trace.push("human_approval_pause_refused", {
    payload: compactPayload({
      approval_ref: payload.approval_ref,
      mode: payload.mode,
      caller_ref: payload.caller_ref,
      agent_ref: payload.agent_ref,
      reason,
      external_tool_dispatches: context.effectState.externalToolDispatches,
      runtime_error_code: "HumanApprovalCheckpointUnsupported",
    }),
  });
  const error = new RuntimeFailure(
    "agent human review checkpoint is not available for this call shape",
    {
      approvalRef: payload.approval_ref,
      mode: payload.mode,
      callerRef: payload.caller_ref,
      agentRef: payload.agent_ref,
      externalToolDispatches: context.effectState.externalToolDispatches,
      reason,
    },
    "HumanApprovalCheckpointUnsupported",
  );
  context.trace.push("failure_detected", {
    payload: compactPayload({
      failure_mode: "human_approval_pause",
      runtime_error_code: error.code,
      approval_ref: payload.approval_ref,
      caller_ref: payload.caller_ref,
      agent_ref: payload.agent_ref,
      external_tool_dispatches: context.effectState.externalToolDispatches,
      reason,
    }),
    message: error.message,
  });
  throw error;
}

function callFrameForNode(graph, node, targetRef) {
  const edgeRole = successEdgeRole(graph, node.id);
  return compactPayload({
    kind: node.kind,
    graph_ref: graph.id,
    graph_owner_ref: graph.owner_ref,
    node_id: node.id,
    caller_ref: graph.owner_ref,
    target_ref: targetRef,
    result_binding: node.result_binding,
    success_edge_role: edgeRole,
    resume_target_ref: nextNodeId(graph, node.id, edgeRole),
  });
}

function defaultEntryRef(document) {
  const strategy = document.definitions.strategies?.[0];
  if (strategy) {
    return strategy.id;
  }
  const skill = document.definitions.skills?.[0];
  if (skill) {
    return skill.id;
  }
  const fn = document.definitions.functions?.[0];
  if (fn) {
    return fn.id;
  }
  throw new ToubaRuntimeError("MissingEntry", "no strategy, skill or function entry is available");
}

async function executeNormalizedTriggerEvent(triggerEvent, context) {
  const { trace } = context;
  const triggerRef = triggerEvent.triggerRef;
  const sourceKind = triggerEvent.sourceKind;
  const eventId = triggerEvent.eventId;

  trace.push("trigger_event_received", {
    payload: compactPayload({
      trigger_ref: triggerRef,
      event_id: eventId,
      source_kind: sourceKind,
      arguments_present: triggerEvent.arguments ? true : undefined,
    }),
  });

  if (context.runState.cancelRequested) {
    refuseTriggerAfterCancel(context, triggerRef, eventId, sourceKind);
  }

  if (!triggerRef || !eventId || !sourceKind) {
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerPayloadInvalid",
      reason: !eventId ? "missing_event_id" : "invalid_trigger_event",
      sourceKind,
    });
  }

  const trigger = context.indexes.triggers.get(triggerRef);
  if (!trigger) {
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerUnknown",
      reason: "trigger_unknown",
      sourceKind,
    });
  }

  if (trigger.target_kind !== "strategy") {
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerTargetKindUnsupported",
      reason: "target_kind_unsupported",
      sourceKind,
      targetRef: trigger.target_ref,
    });
  }

  const target = context.indexes.strategies.get(trigger.target_ref);
  if (!target) {
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerTargetMissing",
      reason: "target_missing",
      sourceKind,
      targetRef: trigger.target_ref,
    });
  }

  const manifestTrigger = triggerManifestEntry(context, triggerRef, eventId, sourceKind);
  const triggerEventKind = trigger.event?.kind;
  if (sourceKind !== triggerEventKind) {
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerSourceMismatch",
      reason: "event_source_mismatch",
      sourceKind,
      expectedSourceKind: triggerEventKind,
      targetRef: trigger.target_ref,
    });
  }

  const manifestSourceKind = manifestTrigger.source?.kind;
  if (manifestSourceKind !== triggerEventKind) {
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerSourceMismatch",
      reason: "manifest_source_mismatch",
      sourceKind,
      manifestSourceKind,
      expectedSourceKind: triggerEventKind,
      targetRef: trigger.target_ref,
    });
  }

  const effectiveLimits = effectiveTriggerLimits(trigger, manifestTrigger, context, {
    triggerRef,
    eventId,
    sourceKind,
    targetRef: trigger.target_ref,
  });
  const observedCount = context.triggerRunCounts.get(triggerRef) ?? 0;
  if (observedCount >= effectiveLimits.max_runs_per_day) {
    trace.push("trigger_rate_limited", {
      payload: {
        trigger_ref: triggerRef,
        event_id: eventId,
        limit_ref: "max_runs_per_day",
        limit_value: effectiveLimits.max_runs_per_day,
        observed_count: observedCount,
      },
    });
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerRateLimited",
      reason: "max_runs_per_day_reached",
      sourceKind,
      targetRef: trigger.target_ref,
      limitRef: "max_runs_per_day",
    });
  }

  let callArguments;
  try {
    callArguments = triggerCallArguments(trigger, target, context, triggerEvent);
  } catch (error) {
    if (error instanceof RuntimeFailure) {
      refuseTriggerForRuntimeFailure(context, triggerRef, eventId, sourceKind, trigger.target_ref, error, "payload_invalid");
    }
    throw error;
  }

  trace.push("trigger_event_accepted", {
    payload: {
      trigger_ref: triggerRef,
      target_ref: trigger.target_ref,
      source_kind: sourceKind,
      limits: { ...effectiveLimits },
      arguments_source: triggerEvent.arguments ? "event" : "trigger",
    },
  });
  context.triggerRunCounts.set(triggerRef, observedCount + 1);

  trace.push("trigger_execution_started", {
    payload: {
      trigger_ref: triggerRef,
      target_ref: trigger.target_ref,
      run_id: trace.runId,
    },
  });

  try {
    const result = await withTriggerTimeout(
      executeTarget(trigger.target_ref, context, callArguments, {
        inputValueArguments: true,
      }),
      effectiveLimits.timeout_ms,
      triggerRef,
    );
    trace.push("trigger_execution_completed", {
      payload: {
        trigger_ref: triggerRef,
        target_ref: trigger.target_ref,
        status: "success",
      },
    });
    return result;
  } catch (error) {
    if (error instanceof RuntimeStop) {
      trace.push("trigger_execution_completed", {
        payload: {
          trigger_ref: triggerRef,
          target_ref: trigger.target_ref,
          status: "stopped",
        },
      });
      throw error;
    }
    if (error instanceof RuntimeFailure) {
      trace.push("trigger_execution_failed", {
        payload: compactPayload({
          trigger_ref: triggerRef,
          target_ref: trigger.target_ref,
          runtime_error_code: error.code,
        }),
        message: error.message,
      });
      throw error;
    }
    throw error;
  }
}

function normalizeTriggerEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return {
      triggerRef: null,
      eventId: null,
      sourceKind: null,
      arguments: null,
      argumentsInvalid: false,
    };
  }
  const args = event.arguments ?? event.args;
  const argumentsInvalid = args !== undefined && (
    !args
    || typeof args !== "object"
    || Array.isArray(args)
  );
  return {
    triggerRef: normalizeOptionalNonEmptyString(event.trigger_ref ?? event.triggerRef),
    eventId: normalizeOptionalNonEmptyString(event.event_id ?? event.eventId),
    sourceKind: normalizeOptionalNonEmptyString(event.source_kind ?? event.sourceKind ?? event.kind),
    arguments: argumentsInvalid || args === undefined ? null : { ...args },
    argumentsInvalid,
  };
}

function normalizeOptionalNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function triggerManifestEntry(context, triggerRef, eventId, sourceKind) {
  const manifest = context.toolBindingManifest;
  if (!manifest) {
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerDisabled",
      reason: "manifest_missing",
      sourceKind,
    });
  }
  const entry = manifest.triggers.get(triggerRef);
  if (!entry) {
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerDisabled",
      reason: "trigger_not_enabled",
      sourceKind,
    });
  }
  if (entry.enabled !== true) {
    refuseTrigger(context, triggerRef, eventId, {
      code: "TriggerDisabled",
      reason: "trigger_disabled",
      sourceKind,
    });
  }
  return entry;
}

function effectiveTriggerLimits(trigger, manifestTrigger, context, details) {
  const airLimits = trigger.limits;
  if (
    !airLimits
    || !Number.isSafeInteger(airLimits.max_runs_per_day)
    || airLimits.max_runs_per_day <= 0
    || !Number.isSafeInteger(airLimits.timeout_ms)
    || airLimits.timeout_ms <= 0
  ) {
    refuseTrigger(context, details.triggerRef, details.eventId, {
      ...details,
      code: "TriggerLimitExceeded",
      reason: "air_limits_invalid",
    });
  }

  const manifestLimits = manifestTrigger.limits ?? {};
  const maxRunsPerDay = manifestLimits.max_runs_per_day ?? airLimits.max_runs_per_day;
  const timeoutMs = manifestLimits.timeout_ms ?? airLimits.timeout_ms;
  if (maxRunsPerDay > airLimits.max_runs_per_day || timeoutMs > airLimits.timeout_ms) {
    refuseTrigger(context, details.triggerRef, details.eventId, {
      ...details,
      code: "TriggerLimitExceeded",
      reason: "manifest_limit_exceeds_air",
      limits: {
        air: {
          max_runs_per_day: airLimits.max_runs_per_day,
          timeout_ms: airLimits.timeout_ms,
        },
        manifest: {
          max_runs_per_day: maxRunsPerDay,
          timeout_ms: timeoutMs,
        },
      },
    });
  }

  return {
    max_runs_per_day: maxRunsPerDay,
    timeout_ms: timeoutMs,
  };
}

function triggerCallArguments(trigger, target, context, triggerEvent) {
  const inputs = target.signature?.inputs ?? [];
  const argumentsByInput = new Map(
    (trigger.arguments ?? []).map((argument) => [argument.input, argument.value_ref]),
  );
  const eventArguments = triggerEvent.arguments;
  if (triggerEvent.argumentsInvalid) {
    throw new RuntimeFailure(
      `trigger ${trigger.id} received invalid runtime arguments`,
      {
        triggerRef: trigger.id,
        targetRef: trigger.target_ref,
      },
      "TriggerPayloadInvalid",
    );
  }
  if (inputs.length === 0) {
    if (eventArguments && Object.keys(eventArguments).length > 0) {
      throw new RuntimeFailure(
        `trigger ${trigger.id} received arguments for target without inputs`,
        {
          triggerRef: trigger.id,
          targetRef: trigger.target_ref,
          unknownFields: Object.keys(eventArguments),
        },
        "TriggerPayloadInvalid",
      );
    }
    return null;
  }
  const expectedNames = inputs.map((input) => input.name);
  const eventArgumentKeys = eventArguments ? Object.keys(eventArguments) : [];
  const unknownEventArguments = eventArgumentKeys.filter((key) => !expectedNames.includes(key));
  if (unknownEventArguments.length > 0) {
    throw new RuntimeFailure(
      `trigger ${trigger.id} received unknown runtime arguments`,
      {
        triggerRef: trigger.id,
        targetRef: trigger.target_ref,
        unknownFields: unknownEventArguments,
      },
      "TriggerPayloadInvalid",
    );
  }
  return inputs.map((input) => {
    if (eventArguments && Object.hasOwn(eventArguments, input.name)) {
      const value = eventArguments[input.name];
      validateTriggerArgumentValue(input, value, context, trigger);
      assertNoSecretValueInTriggerArgument(trigger, input.name, value, context);
      return value;
    }
    const valueRef = argumentsByInput.get(input.name);
    if (!valueRef) {
      throw new RuntimeFailure(
        `trigger ${trigger.id} is missing runtime argument ${input.name}`,
        {
          triggerRef: trigger.id,
          targetRef: trigger.target_ref,
          input: input.name,
        },
        "TriggerPayloadInvalid",
      );
    }
    return resolveHandle(valueRef, context, null);
  });
}

function validateTriggerArgumentValue(input, value, context, trigger) {
  if (!isValueCompatibleWithType(value, input.type_ref, context)) {
    throw new RuntimeFailure(
      `trigger ${trigger.id} runtime argument ${input.name} does not match ${input.type_ref}`,
      {
        triggerRef: trigger.id,
        targetRef: trigger.target_ref,
        input: input.name,
        expectedTypeRef: input.type_ref,
        valueKind: payloadValueKind(value),
      },
      "TriggerPayloadInvalid",
    );
  }
}

function isValueCompatibleWithType(value, typeRef, context) {
  if (typeRef === BUILTIN_TEXT) {
    return typeof value === "string";
  }
  if (typeRef === BUILTIN_BOOLEAN) {
    return typeof value === "boolean";
  }
  if (typeRef === BUILTIN_INT) {
    return Number.isSafeInteger(value);
  }
  if (typeRef === BUILTIN_FLOAT) {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (typeof typeRef === "string" && typeRef.startsWith("list:")) {
    return Array.isArray(value)
      && value.every((item) => isValueCompatibleWithType(item, typeRef.slice("list:".length), context));
  }
  const type = context.indexes.types.get(typeRef);
  if (!type || !Array.isArray(type.fields)) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const expectedFields = type.fields.map((field) => field.name);
  const keys = Object.keys(value);
  if (keys.some((key) => !expectedFields.includes(key))) {
    return false;
  }
  return type.fields.every((field) =>
    Object.hasOwn(value, field.name)
    && isValueCompatibleWithType(value[field.name], field.type_ref, context)
  );
}

function assertNoSecretValueInTriggerArgument(trigger, inputName, value, context) {
  const serialized = JSON.stringify(value);
  const leakedSecrets = secretEntriesInSerializedValue(serialized, context);
  if (leakedSecrets.length === 0) {
    return;
  }
  throw new RuntimeFailure(
    `trigger argument contains a resolved secret value ${trigger.id}`,
    {
      triggerRef: trigger.id,
      targetRef: trigger.target_ref,
      input: inputName,
      secretHandlesRefused: leakedSecrets.map((entry) => entry.handle),
    },
    "SecretValueInTriggerArgument",
  );
}

function withTriggerTimeout(promise, timeoutMs, triggerRef) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new RuntimeFailure(
        `trigger execution timed out ${triggerRef}`,
        { triggerRef, timeoutMs },
        "TriggerLimitExceeded",
      ));
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function refuseTrigger(context, triggerRef, eventId, details) {
  context.trace.push("trigger_event_refused", {
    payload: compactPayload({
      trigger_ref: triggerRef,
      event_id: eventId,
      source_kind: details.sourceKind,
      reason: details.reason,
      runtime_error_code: details.code,
      target_ref: details.targetRef,
      expected_source_kind: details.expectedSourceKind,
      manifest_source_kind: details.manifestSourceKind,
      limit_ref: details.limitRef,
      limits: details.limits,
    }),
  });
  throw new RuntimeFailure(
    `trigger refused ${triggerRef ?? "trigger:unknown"}: ${details.reason}`,
    {
      triggerRef,
      eventId,
      sourceKind: details.sourceKind,
      targetRef: details.targetRef,
      reason: details.reason,
    },
    details.code,
  );
}

function refuseTriggerForRuntimeFailure(context, triggerRef, eventId, sourceKind, targetRef, error, reason) {
  context.trace.push("trigger_event_refused", {
    payload: compactPayload({
      trigger_ref: triggerRef,
      event_id: eventId,
      source_kind: sourceKind,
      reason,
      runtime_error_code: error.code,
      target_ref: targetRef,
      unknown_fields: error.details?.unknownFields,
      expected_type_ref: error.details?.expectedTypeRef,
      value_kind: error.details?.valueKind,
      secret_handles_refused: error.details?.secretHandlesRefused,
    }),
  });
}

function refuseTriggerAfterCancel(context, triggerRef, eventId, sourceKind) {
  context.trace.push("trigger_event_refused", {
    payload: compactPayload({
      trigger_ref: triggerRef,
      event_id: eventId,
      source_kind: sourceKind,
      reason: context.runState.cancelReason ?? "cancel_requested",
      runtime_error_code: "RuntimeCancelled",
    }),
  });
  throw new RuntimeCancelled("trigger refused after run cancellation", {
    targetRef: triggerRef,
    authoritySource: context.runState.cancelAuthoritySource,
    reason: context.runState.cancelReason,
  });
}

async function executeTarget(targetRef, context, callArguments = null, options = {}) {
  if (!options.dispatchAlreadyChecked) {
    assertRunCanDispatch(context, { targetRef });
  }
  if (targetRef.startsWith("function:")) {
    const fn = requireDefinition(context.indexes.functions, targetRef);
    return withBoundArguments(
      fn.signature,
      callArguments,
      context,
      () => executeGraph(fn.body_graph_ref, context),
      { markInputValues: options.inputValueArguments === true },
    );
  }
  if (targetRef.startsWith("skill:")) {
    const skill = requireDefinition(context.indexes.skills, targetRef);
    return withBoundArguments(
      skill.signature,
      callArguments,
      context,
      () => executeGraph(skill.flow_graph_ref, context),
      { markInputValues: options.inputValueArguments === true },
    );
  }
  if (targetRef.startsWith("agent:")) {
    const agent = requireDefinition(context.indexes.agents, targetRef);
    return executeAgentInterface(agent, callArguments, context, async () => {
      const capabilityRefs = Array.isArray(agent.uses) ? [...agent.uses] : [];
      const capabilities = capabilityRefs.map((capabilityRef) =>
        agentCapabilityDescriptor(capabilityRef, context)
      );
      assertNoSecretValueInAgentCapabilityDescriptors(capabilities, context, agent.id);
      context.trace.push("agent_capabilities_listed", {
        payload: {
          agent_ref: agent.id,
          authority_source: "uses",
          capability_refs: capabilityRefs,
          capabilities,
        },
      });

      if (context.agentDecisionProvider && !context.agentDecisions.has(agent.id)) {
        return executeAgentDecisionLoop(agent, capabilityRefs, context);
      }

      const decision = await resolveAgentDecision(agent, capabilityRefs, context);
      if (decision) {
        context.trace.push("agent_decision_recorded", {
          payload: compactPayload({
            agent_ref: agent.id,
            action: decision.action,
            selected_ref: decision.targetRef,
            decision_source: decision.source,
            reason: decision.reason,
            arguments_present: decision.arguments !== undefined ? true : undefined,
          }),
        });

        if (decision.action === "answer_directly") {
          validateAgentFinalResult(agent, decision.result, context);
          context.trace.push("agent_direct_answer_returned", {
            payload: compactPayload({
              agent_ref: agent.id,
              decision_source: decision.source,
              reason: decision.reason,
            }),
          });
          return decision.result;
        }

        assertAgentDecisionDoesNotExecuteSkillPack(decision, agent, capabilityRefs, context);
        if (!capabilityRefs.includes(decision.targetRef)) {
          context.trace.push("agent_capability_refused", {
            payload: {
              agent_ref: agent.id,
              selected_ref: decision.targetRef,
              allowed_refs: capabilityRefs,
              reason: "capability_not_declared_in_uses",
            },
          });
          throw new RuntimeFailure(
            `agent capability refused: ${decision.targetRef} is not declared in ${agent.id} uses`,
            {
              targetRef: decision.targetRef,
              agentRef: agent.id,
              allowedRefs: capabilityRefs,
              reason: "capability_not_declared_in_uses",
            },
            "AgentCapabilityNotAllowed",
          );
        }

        context.trace.push("agent_capability_selected", {
          payload: compactPayload({
            agent_ref: agent.id,
            selected_ref: decision.targetRef,
            authority_source: "uses",
            decision_source: decision.source,
            reason: decision.reason,
          }),
        });

        const previousAgentRef = context.activeAgentRef;
        const previousCallerRef = context.activeCallerRef;
        const selectedCallArguments = callArgumentsForAgentDecision(decision, context);
        if (decision.targetRef.startsWith("agent:")) {
          authorizeAgentInvocationByCaller(agent.id, decision.targetRef, context);
        }
        context.activeAgentRef = agent.id;
        context.activeCallerRef = agent.id;
        try {
          return await executeTarget(decision.targetRef, context, selectedCallArguments);
        } finally {
          context.activeAgentRef = previousAgentRef;
          context.activeCallerRef = previousCallerRef;
        }
      }

      throw new RuntimeFailure(
        `agent decision required for ${agent.id}`,
        {
          agentRef: agent.id,
          allowedRefs: capabilityRefs,
        },
        "AgentDecisionRequired",
      );
    }, { markInputValues: options.inputValueArguments === true });
  }
  if (targetRef.startsWith("strategy:")) {
    const strategy = requireDefinition(context.indexes.strategies, targetRef);
    return withBoundArguments(
      strategy.signature,
      callArguments,
      context,
      () => executeGraph(strategy.flow_graph_ref, context),
      { markInputValues: options.inputValueArguments === true },
    );
  }
  if (targetRef.startsWith("tool:")) {
    const tool = requireDefinition(context.indexes.tools, targetRef);
    return withBoundArguments(
      tool.signature,
      callArguments,
      context,
      () => executeTool(tool, context),
      { markInputValues: options.inputValueArguments === true },
    );
  }
  throw new RuntimeFailure(`unsupported AIR target ${targetRef}`, { targetRef });
}

async function executeAgentInterface(agent, callArguments, context, execute) {
  const signature = agent.signature;
  if (!signature) {
    if (callArguments !== null) {
      refuseAgentInterface(
        context,
        agent,
        "interface_missing",
        "AgentInterfaceRequired",
        `agent ${agent.id} has no declared takes/gives interface`,
      );
    }
    return execute();
  }

  const inputs = Array.isArray(signature.inputs) ? signature.inputs : [];
  let boundArguments = callArguments;
  if (boundArguments === null) {
    if (context.callStack.length > 0 && inputs.length > 0) {
      refuseAgentInterface(
        context,
        agent,
        "explicit_arguments_required",
        "AgentInterfaceInputRequired",
        `agent ${agent.id} requires explicit call arguments`,
      );
    }
    boundArguments = inputs.map((input) => {
      const handle = valueHandle(input.name);
      if (!context.values.has(handle)) {
        refuseAgentInterface(
          context,
          agent,
          "input_missing",
          "AgentInterfaceInputRequired",
          `agent ${agent.id} is missing interface input ${input.name}`,
          { input: input.name, expectedTypeRef: input.type_ref },
        );
      }
      return context.values.get(handle);
    });
  }

  if (boundArguments.length !== inputs.length) {
    refuseAgentInterface(
      context,
      agent,
      "input_count_mismatch",
      "AgentInterfaceInputRequired",
      `agent ${agent.id} interface argument count does not match takes`,
      { expected: inputs.length, actual: boundArguments.length },
    );
  }
  for (let index = 0; index < inputs.length; index += 1) {
    if (!isValueCompatibleWithType(boundArguments[index], inputs[index].type_ref, context)) {
      refuseAgentInterface(
        context,
        agent,
        "input_type_mismatch",
        "AgentInterfaceInputTypeMismatch",
        `agent ${agent.id} interface input ${inputs[index].name} does not match ${inputs[index].type_ref}`,
        {
          input: inputs[index].name,
          expectedTypeRef: inputs[index].type_ref,
          valueKind: payloadValueKind(boundArguments[index]),
        },
      );
    }
  }

  context.trace.push("agent_interface_entered", {
    payload: compactPayload({
      agent_ref: agent.id,
      caller_ref: context.activeCallerRef,
      input_count: inputs.length,
      output_type: signature.output_type,
    }),
  });
  const result = await withBoundArguments(
    signature,
    boundArguments,
    context,
    execute,
    { markInputValues: true },
  );
  validateAgentFinalResult(agent, result, context);
  context.trace.push("agent_interface_result_returned", {
    payload: compactPayload({
      agent_ref: agent.id,
      caller_ref: context.activeCallerRef,
      output_type: signature.output_type,
      result_type: payloadValueKind(result),
    }),
  });
  return result;
}

function validateAgentFinalResult(agent, result, context) {
  const expectedTypeRef = agent.signature?.output_type;
  if (!expectedTypeRef || isValueCompatibleWithType(result, expectedTypeRef, context)) {
    return result;
  }
  refuseAgentInterface(
    context,
    agent,
    "result_type_mismatch",
    "AgentInterfaceResultTypeMismatch",
    `agent ${agent.id} final result does not match ${expectedTypeRef}`,
    {
      expectedTypeRef,
      valueKind: payloadValueKind(result),
    },
  );
}

function refuseAgentInterface(context, agent, reason, code, message, details = {}) {
  context.trace.push("agent_interface_refused", {
    payload: compactPayload({
      agent_ref: agent.id,
      caller_ref: context.activeCallerRef,
      reason,
      runtime_error_code: code,
      input: details.input,
      expected_type_ref: details.expectedTypeRef,
      value_kind: details.valueKind,
      expected_count: details.expected,
      actual_count: details.actual,
    }),
  });
  throw new RuntimeFailure(message, {
    agentRef: agent.id,
    callerRef: context.activeCallerRef,
    reason,
    ...details,
  }, code);
}

async function executeAgentDecisionLoop(agent, capabilityRefs, context, options = {}) {
  return runAgentDecisionLoop(
    agent,
    capabilityRefs,
    context,
    {
      resolveAgentDecision,
      executeAgentHumanReview,
      assertAgentDecisionDoesNotExecuteSkillPack,
      callArgumentsForAgentDecision,
      argumentsForAgentObservation,
      authorizeAgentInvocationByCaller,
      executeTarget,
      validateAgentFinalResult,
    },
    options,
  );
}

function executeAgentHumanReview(agent, decision, context, stepIndex, observations = []) {
  const approvalRef = agentHumanReviewApprovalRef(agent.id, stepIndex);
  const basePayload = compactPayload({
    approval_ref: approvalRef,
    mode: "agent_review",
    caller_ref: agent.id,
    agent_ref: agent.id,
    requester_ref: agent.id,
    step_index: stepIndex,
    reason: decision.reason,
    review_prompt_present: decision.reviewPrompt !== undefined,
  });

  context.trace.push("agent_human_review_requested", {
    payload: basePayload,
  });
  context.trace.push("human_approval_requested", {
    payload: basePayload,
  });

  const humanDecision = context.humanApprovalDecisions.get(approvalRef);
  if (!humanDecision) {
    const checkpointSupport = agentHumanReviewCheckpointSupport(context, agent.id);
    if (
      context.durableHumanApprovals === true
      && checkpointSupport.supported !== true
      && context.effectState.externalToolDispatches > 0
    ) {
      refuseAgentHumanReviewCheckpointUnavailable(context, basePayload, checkpointSupport);
    }
    assertHumanApprovalCanPause(context, basePayload, undefined, {
      durableResumeAvailable: checkpointSupport.supported === true,
    });
    if (checkpointSupport.supported === true) {
      createAgentHumanReviewCheckpoint(
        context,
        agent,
        decision,
        stepIndex,
        observations,
        basePayload,
        checkpointSupport.callFrame,
      );
    }
    context.trace.push("human_approval_paused", {
      payload: basePayload,
    });
    if (context.runState.cancelOnPause) {
      requestRunCancel(context, {
        authoritySource: "host",
        reason: "cancel_requested",
        scope: context.runState.killSwitchScope,
      });
      throw new RuntimeCancelled("agent human review cancelled while paused", {
        approvalRef,
        agentRef: agent.id,
        authoritySource: "host",
        reason: "cancel_requested",
      });
    }
    throw new RuntimeStop("agent human review paused", { approvalRef, agentRef: agent.id });
  }
  context.trace.push("human_approval_paused", {
    payload: basePayload,
  });
  const transition = classifyHumanApprovalDecision(humanDecision);
  if (!transition.valid) {
    throw new RuntimeFailure(
      `invalid human approval decision ${humanDecision} for ${approvalRef}`,
      { approvalRef, decision: humanDecision, agentRef: agent.id },
      "InvalidHumanApprovalDecision",
    );
  }

  context.trace.push("human_approval_decided", {
    payload: {
      approval_ref: approvalRef,
      decision: humanDecision,
    },
  });

  if (transition.approved) {
    context.trace.push("human_approval_resumed", {
      payload: {
        approval_ref: approvalRef,
        decision: humanDecision,
      },
    });
    return {
      approval_ref: approvalRef,
      decision: humanDecision,
    };
  }

  context.trace.push(transition.terminalEvent, {
    payload: {
      approval_ref: approvalRef,
      decision: humanDecision,
    },
  });
  throw new RuntimeStop(`agent human review ${humanDecision}`, {
    approvalRef,
    agentRef: agent.id,
    decision: humanDecision,
  });
}

function requireDefinition(index, id) {
  const item = index.get(id);
  if (!item) {
    throw new RuntimeFailure(`unknown AIR reference ${id}`, { id });
  }
  return item;
}

function targetOutputType(targetRef, context) {
  if (targetRef.startsWith("agent:")) {
    return context.indexes.agents.get(targetRef)?.signature?.output_type ?? null;
  }
  if (targetRef.startsWith("function:")) {
    return context.indexes.functions.get(targetRef)?.signature?.output_type ?? null;
  }
  if (targetRef.startsWith("skill:")) {
    return context.indexes.skills.get(targetRef)?.signature?.output_type ?? null;
  }
  if (targetRef.startsWith("tool:")) {
    return context.indexes.tools.get(targetRef)?.signature?.output_type ?? null;
  }
  if (targetRef.startsWith("strategy:")) {
    return context.indexes.strategies.get(targetRef)?.signature?.output_type ?? null;
  }
  return null;
}

function agentCapabilityDescriptor(targetRef, context) {
  const kind = callerKindFromRef(targetRef);
  const definition = definitionForCapability(targetRef, context);
  const signature = signatureDescriptor(definition?.signature, context);
  const nestedUses = Array.isArray(definition?.uses) ? definition.uses : [];
  const descriptionRecord = capabilityDescriptionRecord(targetRef, kind, definition, signature, nestedUses);
  const selectionKeywords = capabilitySelectionKeywords(definition?.name, descriptionRecord.text);
  return compactPayload({
    target_ref: targetRef,
    kind,
    name: definition?.name,
    description: descriptionRecord.text,
    description_source: descriptionRecord.source,
    source_description_present: descriptionRecord.source === "source",
    selection_keywords: selectionKeywords.length > 0 ? selectionKeywords : undefined,
    responsibility: kind === "agent" ? definition?.responsibility : undefined,
    input_count: signature?.inputs?.length,
    output_type: signature?.output_type,
    signature,
    uses: nestedUses,
    uses_count: nestedUses.length > 0 ? nestedUses.length : undefined,
    uses_kinds: nestedUses.length > 0 ? uniqueKinds(nestedUses) : undefined,
    callable_by: kind === "agent" ? callableByDescriptor(definition?.callable_by) : undefined,
    required_capabilities: definition?.required_capabilities,
    required_secret_handles: definition?.required_secrets,
    memory_accesses: memoryAccessesForTrace(normalizeAirMemoryAccesses(definition?.memory_accesses ?? [], targetRef)),
  });
}

function capabilitySummaryDescriptor(descriptor) {
  return compactPayload({
    target_ref: descriptor.target_ref,
    kind: descriptor.kind,
    name: descriptor.name,
    description: descriptor.description,
    description_source: descriptor.description_source,
    source_description_present: descriptor.source_description_present,
    selection_keywords: descriptor.selection_keywords,
  });
}

function capabilityDescriptionQuality(capabilities) {
  const counts = {
    source: 0,
    responsibility: 0,
    generated: 0,
    absent: 0,
  };
  const missingSourceDescriptionRefs = [];
  for (const capability of capabilities) {
    const source = capability.description_source ?? "absent";
    counts[source] = (counts[source] ?? 0) + 1;
    if (source !== "source") {
      missingSourceDescriptionRefs.push(capability.target_ref);
    }
  }
  return compactPayload({
    capability_count: capabilities.length,
    source_description_count: counts.source,
    generated_description_count: counts.generated,
    responsibility_description_count: counts.responsibility,
    absent_description_count: counts.absent,
    missing_source_description_count: missingSourceDescriptionRefs.length,
    missing_source_description_refs: missingSourceDescriptionRefs.length > 0
      ? missingSourceDescriptionRefs
      : undefined,
    production_recommendation: missingSourceDescriptionRefs.length > 0
      ? "add_source_descriptions_for_agentic_selection"
      : "source_descriptions_complete",
  });
}

function traceCapabilityDescriptionQuality(context, agent, providerMode, capabilities) {
  const quality = capabilityDescriptionQuality(capabilities);
  context.trace.push("agent_capability_descriptions_diagnosed", {
    payload: compactPayload({
      agent_ref: agent.id,
      provider_mode: providerMode,
      ...quality,
    }),
  });
}

function assertSourceDescriptionsForAgentCapabilities(agent, providerMode, capabilities) {
  const quality = capabilityDescriptionQuality(capabilities);
  if ((quality.missing_source_description_count ?? 0) === 0) {
    return;
  }
  throw new RuntimeFailure(
    `agent ${agent.id} exposes capabilities without source descriptions`,
    {
      agentRef: agent.id,
      providerMode,
      missingSourceDescriptionRefs: quality.missing_source_description_refs ?? [],
      missingSourceDescriptionCount: quality.missing_source_description_count,
    },
    "AgentCapabilityDescriptionRequired",
  );
}

function capabilityDescriptionRecord(targetRef, kind, definition, signature, nestedUses) {
  const explicit = normalizeCapabilityDescription(definition?.description);
  if (explicit) {
    return { text: explicit, source: "source" };
  }
  const responsibility = kind === "agent" ? normalizeCapabilityDescription(definition?.responsibility) : null;
  if (responsibility && responsibility !== definition?.name) {
    return { text: responsibility, source: "responsibility" };
  }
  const name = typeof definition?.name === "string" && definition.name.trim() !== ""
    ? definition.name.trim()
    : String(targetRef).split("/").at(-1);
  const phrase = identifierPhrase(name);
  if (!phrase) {
    return { text: undefined, source: "absent" };
  }
  const inputNames = Array.isArray(signature?.inputs)
    ? signature.inputs.map((input) => input.name).filter(Boolean)
    : [];
  const inputText = inputNames.length > 0
    ? `inputs: ${inputNames.join(", ")}`
    : "inputs: none";
  const outputText = signature?.output_type ? `output: ${signature.output_type}` : null;
  const usesText = nestedUses.length > 0 ? `nested uses: ${nestedUses.length}` : null;
  const generated = [
    `${kind ?? "capability"} ${name}: ${phrase}`,
    inputText,
    outputText,
    usesText,
  ].filter(Boolean).join("; ");
  return { text: generated, source: "generated" };
}

function normalizeCapabilityDescription(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed.length > 1000 ? trimmed.slice(0, 1000) : trimmed;
}

function capabilitySelectionKeywords(name, description) {
  const words = new Set([
    ...identifierWords(name),
    ...identifierWords(description),
  ]);
  return [...words].filter((word) => word.length > 1).slice(0, 16);
}

function identifierPhrase(value) {
  const words = identifierWords(value);
  return words.length > 0 ? words.join(" ") : null;
}

function identifierWords(value) {
  if (typeof value !== "string") {
    return [];
  }
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .trim();
  if (spaced === "") {
    return [];
  }
  return [...new Set(spaced.split(/\s+/).filter(Boolean))];
}

function signatureDescriptor(signature, context) {
  if (!signature || typeof signature !== "object") {
    return null;
  }
  return compactPayload({
    inputs: (signature.inputs ?? []).map((input) => parameterDescriptor(input, context)),
    output_type: signature.output_type,
    output_fields: typeFieldsDescriptor(signature.output_type, context),
  });
}

function parameterDescriptor(parameter, context) {
  return compactPayload({
    name: parameter.name,
    type_ref: parameter.type_ref,
    fields: typeFieldsDescriptor(parameter.type_ref, context),
  });
}

function typeFieldsDescriptor(typeRef, context, ancestors = new Set()) {
  if (typeof typeRef !== "string" || typeRef.trim() === "") {
    return undefined;
  }
  if (typeRef.startsWith("list:")) {
    return typeFieldsDescriptor(typeRef.slice("list:".length), context, ancestors);
  }
  if (ancestors.has(typeRef)) {
    return undefined;
  }
  const type = context.indexes.types.get(typeRef);
  if (!type || !Array.isArray(type.fields) || type.fields.length === 0) {
    return undefined;
  }
  const nestedAncestors = new Set([...ancestors, typeRef]);
  return type.fields.map((field) => compactPayload({
    name: field.name,
    type_ref: field.type_ref,
    fields: typeFieldsDescriptor(field.type_ref, context, nestedAncestors),
  }));
}

function uniqueKinds(refs) {
  return [...new Set(refs.map((ref) => callerKindFromRef(ref)).filter(Boolean))].sort();
}

function callableByDescriptor(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return undefined;
  }
  return rules.map((rule) => compactPayload({
    caller_ref: rule.caller_ref,
    caller_kind: rule.caller_kind,
  }));
}

function definitionForCapability(targetRef, context) {
  if (targetRef.startsWith("function:")) {
    return context.indexes.functions.get(targetRef) ?? null;
  }
  if (targetRef.startsWith("skill:")) {
    return context.indexes.skills.get(targetRef) ?? null;
  }
  if (targetRef.startsWith("tool:")) {
    return context.indexes.tools.get(targetRef) ?? null;
  }
  if (targetRef.startsWith("strategy:")) {
    return context.indexes.strategies.get(targetRef) ?? null;
  }
  if (targetRef.startsWith("agent:")) {
    return context.indexes.agents.get(targetRef) ?? null;
  }
  return null;
}

async function resolveAgentDecision(agent, capabilityRefs, context, loopState = null) {
  const explicitDecision = context.agentDecisions.get(agent.id);
  if (explicitDecision) {
    return explicitDecision;
  }

  if (context.agentDecisionProvider) {
    return requestAgentDecisionFromProvider(agent, capabilityRefs, context, loopState);
  }

  if (capabilityRefs.length === 1) {
    return {
      targetRef: capabilityRefs[0],
      source: "uses_single_capability",
      reason: "single declared capability",
    };
  }

  return null;
}

async function requestAgentDecisionFromProvider(agent, capabilityRefs, context, loopState = null) {
  if (loopState?.phase === "finalization") {
    const finalizationRequest = agentDecisionProviderRequest(
      agent,
      capabilityRefs,
      context,
      "finalization",
      loopState,
    );
    context.trace.push("agent_decision_requested", {
      payload: agentDecisionRequestTracePayload(finalizationRequest),
    });
    return callAgentDecisionProvider(finalizationRequest, context);
  }

  if (
    context.agentDecisionProviderInitialMode === "capabilities"
    && (loopState?.observations?.length ?? 0) === 0
  ) {
    const catalogRequest = agentDecisionProviderRequest(agent, capabilityRefs, context, "capabilities", loopState);
    context.trace.push("agent_decision_requested", {
      payload: agentDecisionRequestTracePayload(catalogRequest),
    });
    const selected = await callAgentDecisionProvider(catalogRequest, context);
    if (selected.action === "request_capabilities") {
      throw new RuntimeFailure(
        `agent decision provider did not select a capability for ${agent.id}`,
        { agentRef: agent.id, allowedRefs: capabilityRefs },
        "AgentDecisionProviderNoSelection",
      );
    }
    return selected;
  }

  const summaryRequest = agentDecisionProviderRequest(agent, capabilityRefs, context, "summary", loopState);
  context.trace.push("agent_decision_requested", {
    payload: agentDecisionRequestTracePayload(summaryRequest),
  });

  const firstResponse = await callAgentDecisionProvider(summaryRequest, context);
  if (firstResponse.action === "request_capabilities") {
    context.trace.push("agent_decision_catalog_requested", {
      payload: compactPayload({
        agent_ref: agent.id,
        reason: firstResponse.reason,
        capability_count: capabilityRefs.length,
      }),
    });

    const catalogRequest = agentDecisionProviderRequest(agent, capabilityRefs, context, "capabilities", loopState);
    context.trace.push("agent_decision_requested", {
      payload: agentDecisionRequestTracePayload(catalogRequest),
    });
    const selected = await callAgentDecisionProvider(catalogRequest, context);
    if (selected.action === "request_capabilities") {
      throw new RuntimeFailure(
        `agent decision provider did not select a capability for ${agent.id}`,
        { agentRef: agent.id, allowedRefs: capabilityRefs },
        "AgentDecisionProviderNoSelection",
      );
    }
    return selected;
  }

  return firstResponse;
}

function agentDecisionProviderRequest(agent, capabilityRefs, context, mode, loopState = null) {
  const rawInputs = publicInputValuesForAgentDecision(context);
  const providerContent = agentDecisionProviderContent(rawInputs, loopState?.observations ?? [], context);
  assertAgentProviderObservationsBudget(context, agent, mode, providerContent);
  const capabilities = capabilityRefs.map((capabilityRef) => agentCapabilityDescriptor(capabilityRef, context));
  traceCapabilityDescriptionQuality(context, agent, mode, capabilities);
  assertSourceDescriptionsForAgentCapabilities(agent, mode, capabilities);
  const modelInput = agentModelInput(agent, capabilityRefs, capabilities, rawInputs, mode, loopState, context, providerContent);
  const request = {
    protocol: AGENT_DECISION_PROTOCOL_VERSION,
    mode,
    run_id: context.trace.runId,
    agent_ref: agent.id,
    agent_name: agent.name,
    agent_signature: signatureDescriptor(agent.signature, context),
    responsibility: agent.responsibility,
    input_keys: Object.keys(rawInputs),
    inputs: providerContent.inputs,
    content_mode: providerContent.mode,
    content_refs: providerContent.refs,
    external_content_access: providerContent.externalContentAccess,
    step_index: loopState?.stepIndex,
    observations: providerContent.observations,
    provider_metadata: context.agentDecisionProvider?.metadata ?? undefined,
    capability_count: capabilityRefs.length,
    capability_refs: capabilityRefs,
    model_input: modelInput,
    capabilities:
      mode === "capabilities"
        ? capabilities
        : null,
  };
  assertNoSecretValueInAgentDecisionRequest(request, context, agent.id);
  return request;
}

function agentModelInput(
  agent,
  capabilityRefs,
  capabilities,
  inputs,
  mode,
  loopState = null,
  context = null,
  providerContent = null,
) {
  const orientationMode = mode === "summary";
  const finalizationMode = mode === "finalization";
  const catalogMode = mode === "capabilities";
  const observations = loopState?.observations ?? [];
  const skillPackContext = prepareSkillPackModelContext(context, agent, mode, capabilityRefs);
  const content = providerContent ?? agentDecisionProviderContent(inputs, observations, context);
  const inputEntries = content.inputEntries;
  const observationEntries = content.observations;
  const resourceKinds = uniqueKinds(capabilityRefs);
  const descriptionQuality = capabilityDescriptionQuality(capabilities);
  const usedCapabilityRefs = [...new Set(observations
    .filter((observation) => observation?.action === "select_capability" && typeof observation.target_ref === "string")
    .map((observation) => observation.target_ref))];
  const developerInstruction = {
    source: "air_agent_responsibility",
    authority: "developer",
    text: agent.responsibility,
  };
  const modelInput = compactPayload({
    protocol: AGENT_MODEL_INPUT_PROTOCOL_VERSION,
    mode: finalizationMode
      ? "finalization"
      : orientationMode
        ? "orientation"
        : "capability_catalog",
    agent: {
      agent_ref: agent.id,
      name: agent.name,
      responsibility: agent.responsibility,
      signature: signatureDescriptor(agent.signature, context),
    },
    agent_state: {
      step_index: loopState?.stepIndex ?? 0,
      phase: finalizationMode ? "finalization" : "execution",
      execution_budget_exhausted: finalizationMode,
      observation_count: observations.length,
      observations: observationEntries,
      used_capability_refs: usedCapabilityRefs,
      available_capability_refs: finalizationMode ? [] : capabilityRefs,
      observation_budget: agentProviderObservationBudgetReport(context, content),
    },
    instructions: [
      developerInstruction,
    ],
    developer_instruction: {
      source: developerInstruction.source,
      text: developerInstruction.text,
    },
    content_boundary: {
      developer_instruction_authority: "instruction",
      user_input_authority: "domain_data_only",
      external_content_authority: "untrusted_content",
      capability_catalog_authority: "runtime_contracts_only",
      provider_content_mode: content.mode,
      raw_external_content_in_request: content.mode === "inline",
    },
    input_layers: {
      developer_instructions: [
        developerInstruction,
      ],
      conversation_history: [],
      user_request: {
        category: "runtime_inputs",
        items: inputEntries,
      },
      external_content: inputEntries,
      runtime_observations: observationEntries,
    },
    user_input: {
      category: "domain_data",
      keys: Object.keys(inputs),
      value: content.inputs,
      value_mode: content.mode,
    },
    external_content_access: content.externalContentAccess,
    resources_hint: {
      capabilities_available: !finalizationMode && capabilityRefs.length > 0,
      capability_count: capabilityRefs.length,
      capability_refs: orientationMode ? capabilityRefs : undefined,
      capability_summaries: orientationMode ? capabilities.map(capabilitySummaryDescriptor) : undefined,
      capability_kinds: resourceKinds,
      catalog_available_on_request: orientationMode,
      catalog_presented: catalogMode,
      description_quality: descriptionQuality,
      skill_pack_hints_available: skillPackContext.hints.length > 0,
      skill_pack_hint_count: skillPackContext.hints.length,
      active_skill_pack_count: skillPackContext.active.length,
    },
    skill_pack_hints: skillPackContext.hints,
    active_skill_packs: skillPackContext.active.length > 0 ? skillPackContext.active : undefined,
    skill_pack_budgets: skillPackContext.budgets,
    resource_interface: {
      catalog_policy: finalizationMode
        ? "unavailable_during_finalization"
        : orientationMode
          ? "available_on_request"
          : "presented",
      resource_kinds: skillPackContext.hints.length > 0 ? [...resourceKinds, "skill_pack"] : resourceKinds,
      includes: finalizationMode
        ? ["used_capability_refs", "runtime_observations"]
        : orientationMode
        ? ["capability_refs", "capability_count", "capability_kinds", "skill_pack_hints"]
        : ["capability_descriptors", "signatures", "requirements", "nested_uses", "skill_pack_hints", "active_skill_packs"],
    },
	    decision_policy: finalizationMode
	      ? {
	        no_additional_capability_execution: true,
	        answer_directly_only_if_goal_satisfied: true,
	        declare_incomplete_if_goal_not_satisfied: true,
	      }
	      : orientationMode
	      ? {
	        answer_directly_requires_no_capability_call: true,
	        request_capabilities_when_execution_is_needed: true,
	        request_capabilities_when_human_review_is_needed: true,
	        planned_capability_use_is_not_completion: true,
	        answer_directly_must_not_replace_required_human_review: true,
	        after_observation_answer_directly_only_if_goal_satisfied: true,
	        request_capabilities_if_authorized_work_is_needed: true,
	        prior_use_does_not_exhaust_capability: true,
	      }
	      : {
	        select_exactly_one_catalog_capability_when_execution_is_needed: true,
	        request_human_review_only_when_no_catalog_capability_suffices: true,
	        request_human_review_when_goal_requires_human_judgment: true,
	        select_by_task_need_not_usage_history: true,
	        prior_use_does_not_exhaust_capability: true,
	      },
	    human_interaction: {
	      request_present: false,
	      review_available: !finalizationMode,
	      review_access: finalizationMode
	        ? "unavailable_during_finalization"
	        : orientationMode ? "request_capabilities_first" : "direct_catalog_action",
	      available_actions: finalizationMode
	        ? []
	        : orientationMode
	        ? ["request_capabilities_for_human_review"]
	        : ["request_human_review"],
	    },
    allowed_actions: finalizationMode
      ? ["answer_directly", "cannot_complete"]
      : orientationMode
      ? ["answer_directly", "request_capabilities"]
      : ["select_capability", "request_human_review"],
    capabilities: catalogMode ? capabilities : undefined,
    output_contract: finalizationMode
      ? {
        action: {
          enum: ["answer_directly", "cannot_complete"],
        },
        direct_answer: {
          type: "JSON",
          description: "Final answer grounded in observations, only when the goal is satisfied.",
        },
        reason: {
          type: "Text",
          description: "Brief reason for completion or inability to complete.",
        },
      }
      : orientationMode
      ? {
        action: {
          enum: ["answer_directly", "request_capabilities"],
        },
	        direct_answer: {
	          type: "JSON",
	          description: "Direct answer when no capability or human review is needed.",
	        },
        reason: {
          type: "Text",
          description: "Brief reason for the direct answer or catalogue request.",
        },
      }
      : {
        action: {
          enum: ["select_capability", "request_human_review"],
        },
        target_ref: {
          enum_source: "capabilities[].target_ref",
        },
        reason: {
          type: "Text",
          description: "Brief reason for the capability selection.",
        },
        arguments: {
          type: "Object",
          description: "Object keyed by the input names of the selected signature.",
        },
        human_review: {
          type: "Object",
          description: "Agent-initiated human-review request when no capability is sufficient.",
        },
      },
  });
  assertSkillPackBudget(context, "model_input", estimateJsonBytes(modelInput), context?.skillPackBudgets?.modelInputMaxBytes ?? null, {
    agent_ref: agent.id,
    provider_mode: mode,
    skill_pack_hint_count: skillPackContext.hints.length,
    active_skill_pack_count: skillPackContext.active.length,
  });
  return modelInput;
}

function assertAgentProviderObservationsBudget(context, agent, providerMode, providerContent) {
  const maxBytes = context?.agentProviderObservationsMaxBytes ?? null;
  if (maxBytes === null || providerContent.observationsBytes <= maxBytes) {
    return;
  }
  context.trace.push("agent_observations_budget_refused", {
    payload: compactPayload({
      agent_ref: agent.id,
      provider_mode: providerMode,
      content_mode: providerContent.mode,
      observation_count: providerContent.observations.length,
      consumed_bytes: providerContent.observationsBytes,
      budget_max_bytes: maxBytes,
      runtime_error_code: "AgentProviderObservationsBudgetExceeded",
    }),
  });
  throw new RuntimeFailure(
    `agent provider observations budget exceeded for ${agent.id}`,
    {
      agentRef: agent.id,
      providerMode,
      contentMode: providerContent.mode,
      observationCount: providerContent.observations.length,
      consumedBytes: providerContent.observationsBytes,
      maxBytes,
    },
    "AgentProviderObservationsBudgetExceeded",
  );
}

function prepareSkillPackModelContext(context, agent, providerMode, capabilityRefs = []) {
  if (!context || context.skillPacks.length === 0) {
    return {
      hints: [],
      active: [],
      budgets: skillPackBudgetReport(context),
    };
  }

  const hints = context.skillPacks.map((pack) => skillPackHint(pack));
  const hintBytes = estimateJsonBytes(hints);
  assertSkillPackBudget(context, "discovery", hintBytes, context.skillPackBudgets.discoveryMaxBytes, {
    agent_ref: agent.id,
    provider_mode: providerMode,
    skill_pack_count: hints.length,
  });
  context.trace.push("skill_pack_discovery_listed", {
    payload: compactPayload({
      agent_ref: agent.id,
      provider_mode: providerMode,
      skill_pack_count: hints.length,
      skill_pack_refs: hints.map((hint) => hint.ref),
      approx_size_bytes: hintBytes,
      budget_max_bytes: context.skillPackBudgets.discoveryMaxBytes,
    }),
  });

  const active = [];
  for (const pack of context.skillPacks) {
    if (!context.activeSkillPackRefs.has(pack.ref)) {
      continue;
    }
    const reason = context.skillPackActivationReasons.get(pack.ref) ?? "host_policy";
    const activePack = activeSkillPackRecord(context, pack, reason, agent, providerMode, capabilityRefs);
    const activeBytes = estimateJsonBytes(activePack);
    assertSkillPackBudget(context, "activation", activeBytes, context.skillPackBudgets.activationMaxBytes, {
      agent_ref: agent.id,
      provider_mode: providerMode,
      skill_pack_ref: pack.ref,
      skill_pack_version: pack.version,
      skill_pack_digest: pack.digest,
      source: pack.source,
      reason,
    });
    active.push(activePack);
    context.trace.push("skill_pack_activated", {
      payload: compactPayload({
        agent_ref: agent.id,
        provider_mode: providerMode,
        skill_pack_ref: pack.ref,
        version: pack.version,
        digest: pack.digest,
        source: pack.source,
        reason,
        approx_size_bytes: activeBytes,
        budget_max_bytes: context.skillPackBudgets.activationMaxBytes,
      }),
    });
  }

  const activeBytes = estimateJsonBytes(active);
  assertSkillPackBudget(context, "active_skill_packs", activeBytes, context.skillPackBudgets.modelInputMaxBytes, {
    agent_ref: agent.id,
    provider_mode: providerMode,
    active_skill_pack_count: active.length,
  });

  return {
    hints,
    active,
    budgets: skillPackBudgetReport(context),
  };
}

function skillPackHint(pack) {
  return compactPayload({
    ref: pack.ref,
    name: pack.name,
    description: pack.description,
    version: pack.version,
    tags: pack.tags,
    source: pack.source,
    digest: pack.digest,
    activation: pack.activation,
    resource_count: pack.resources.length,
    execution_link_count: pack.executionLinks.length,
  });
}

function activeSkillPackRecord(context, pack, reason, agent, providerMode, capabilityRefs) {
  const resources = pack.resources.map((resource) =>
    activeSkillPackResourceRecord(context, pack, resource, agent, providerMode)
  );
  const executionLinks = pack.executionLinks.map((link) =>
    validatedSkillPackExecutionLink(context, pack, link, agent, providerMode, capabilityRefs)
  );
  return compactPayload({
    ref: pack.ref,
    name: pack.name,
    description: pack.description,
    version: pack.version,
    source: pack.source,
    digest: pack.digest,
    activation_reason: reason,
    resources,
    execution_links: executionLinks,
  });
}

function activeSkillPackResourceRecord(context, pack, resource, agent, providerMode) {
  const base = compactPayload({
    ref: resource.ref,
    kind: resource.kind,
    path: resource.path,
    digest: resource.digest,
    loadable_as_context: resource.loadableAsContext,
    executable_by_pack: false,
  });

  if (resource.kind === "script") {
    context.trace.push("skill_pack_resource_refused", {
      payload: compactPayload({
        agent_ref: agent.id,
        provider_mode: providerMode,
        skill_pack_ref: pack.ref,
        resource_ref: resource.ref,
        resource_kind: resource.kind,
        reason: "script_content_not_loaded",
        runtime_error_code: "SkillPackScriptExecutionForbidden",
      }),
    });
    return base;
  }

  if (resource.loadableAsContext !== true || resource.content === undefined) {
    return base;
  }

  assertSkillPackResourceHasNoResolvedSecret(context, pack, resource, agent, providerMode);
  const approxSizeBytes = Buffer.byteLength(resource.content, "utf8");
  context.trace.push("skill_pack_resource_loaded", {
    payload: compactPayload({
      agent_ref: agent.id,
      provider_mode: providerMode,
      skill_pack_ref: pack.ref,
      resource_ref: resource.ref,
      resource_kind: resource.kind,
      digest: resource.digest,
      approx_size_bytes: approxSizeBytes,
    }),
  });
  return compactPayload({
    ...base,
    content: resource.content,
  });
}

function assertSkillPackResourceHasNoResolvedSecret(context, pack, resource, agent, providerMode) {
  const leakedSecrets = resolvedSecretEntries(context.secretStore)
    .filter((entry) => entry.value.length > 0 && String(resource.content).includes(entry.value));
  if (leakedSecrets.length === 0) {
    return;
  }
  context.trace.push("skill_pack_resource_refused", {
    payload: compactPayload({
      agent_ref: agent.id,
      provider_mode: providerMode,
      skill_pack_ref: pack.ref,
      resource_ref: resource.ref,
      resource_kind: resource.kind,
      reason: "resolved_secret_value_detected",
      runtime_error_code: "SkillPackSensitiveContentForbidden",
      secret_handles_refused: leakedSecrets.map((entry) => entry.handle),
    }),
  });
  throw new RuntimeFailure(
    `skill pack resource ${resource.ref} contains a resolved secret value`,
    {
      agentRef: agent.id,
      providerMode,
      skillPackRef: pack.ref,
      resourceRef: resource.ref,
      resourceKind: resource.kind,
      secretHandlesRefused: leakedSecrets.map((entry) => entry.handle),
    },
    "SkillPackSensitiveContentForbidden",
  );
}

function validatedSkillPackExecutionLink(context, pack, link, agent, providerMode, capabilityRefs) {
  if (!capabilityRefs.includes(link.target_ref)) {
    context.trace.push("skill_pack_resource_refused", {
      payload: compactPayload({
        agent_ref: agent.id,
        provider_mode: providerMode,
        skill_pack_ref: pack.ref,
        target_ref: link.target_ref,
        reason: "execution_link_not_declared_in_agent_uses",
        runtime_error_code: "SkillPackExecutionLinkUnauthorized",
      }),
    });
    throw new RuntimeFailure(
      `skill pack execution link ${link.target_ref} is not declared in ${agent.id} uses`,
      {
        agentRef: agent.id,
        skillPackRef: pack.ref,
        targetRef: link.target_ref,
        allowedRefs: capabilityRefs,
      },
      "SkillPackExecutionLinkUnauthorized",
    );
  }
  return compactPayload({
    label: link.label,
    target_ref: link.target_ref,
    description: link.description,
    authority: "informative_only",
  });
}

function assertAgentDecisionDoesNotExecuteSkillPack(decision, agent, capabilityRefs, context, stepIndex) {
  if (!decision.targetRef?.startsWith?.("skill_pack:")) {
    return;
  }
  context.trace.push("agent_capability_refused", {
    payload: compactPayload({
      agent_ref: agent.id,
      step_index: stepIndex,
      selected_ref: decision.targetRef,
      allowed_refs: capabilityRefs,
      reason: "skill_pack_is_not_executable",
      runtime_error_code: "SkillPackExecutableConfusion",
    }),
  });
  throw new RuntimeFailure(
    `skill pack ${decision.targetRef} is procedural context, not an executable capability`,
    {
      targetRef: decision.targetRef,
      agentRef: agent.id,
      allowedRefs: capabilityRefs,
      reason: "skill_pack_is_not_executable",
    },
    "SkillPackExecutableConfusion",
  );
}

function assertSkillPackBudget(context, phase, consumedBytes, maxBytes, details = {}) {
  if (maxBytes === null || consumedBytes <= maxBytes) {
    return;
  }
  context.trace.push("skill_pack_activation_refused", {
    payload: compactPayload({
      ...details,
      phase,
      reason: "budget_exceeded",
      consumed_bytes: consumedBytes,
      budget_max_bytes: maxBytes,
      runtime_error_code: "SkillPackBudgetExceeded",
    }),
  });
  throw new RuntimeFailure(
    `skill pack ${phase} budget exceeded`,
    {
      ...details,
      phase,
      consumedBytes,
      maxBytes,
    },
    "SkillPackBudgetExceeded",
  );
}

function skillPackBudgetReport(context) {
  if (!context?.skillPackBudgets) {
    return {
      discovery_max_bytes: null,
      activation_max_bytes: null,
      model_input_max_bytes: null,
    };
  }
  return {
    discovery_max_bytes: context.skillPackBudgets.discoveryMaxBytes,
    activation_max_bytes: context.skillPackBudgets.activationMaxBytes,
    model_input_max_bytes: context.skillPackBudgets.modelInputMaxBytes,
  };
}

function estimateJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function agentDecisionRequestTracePayload(request) {
  const redactedEvidence = agentDecisionRequestRedactedEvidence(request);
  return compactPayload({
    agent_ref: request.agent_ref,
    protocol: request.protocol,
    mode: request.mode,
    step_index: request.step_index,
    provider_metadata: request.provider_metadata,
    request_digest: sha256Json(redactedEvidence),
    content_mode: request.content_mode,
    external_content_access: request.external_content_access,
    model_input_protocol: request.model_input?.protocol,
    model_input_mode: request.model_input?.mode,
    capability_count: request.capability_count,
    observation_count: Array.isArray(request.observations) ? request.observations.length : undefined,
    capability_refs: request.mode === "summary" ? request.capability_refs : undefined,
    catalog_presented: request.mode === "capabilities" ? true : undefined,
    skill_pack_hint_count: request.model_input?.skill_pack_hints?.length > 0
      ? request.model_input.skill_pack_hints.length
      : undefined,
    active_skill_pack_count: request.model_input?.active_skill_packs?.length > 0
      ? request.model_input.active_skill_packs.length
      : undefined,
    input_keys: request.input_keys,
  });
}

async function callAgentDecisionProvider(request, context) {
  const maxRetries = context.agentDecisionProviderMaxRetries;
  let attemptIndex = 0;
  let lastProviderError = null;

  while (attemptIndex <= maxRetries) {
    try {
      return await callAgentDecisionProviderAttempt(request, context, attemptIndex);
    } catch (error) {
      if (!(error instanceof RuntimeFailure) || !agentProviderErrorCanRetry(error)) {
        throw error;
      }
      lastProviderError = error;
      if (attemptIndex >= maxRetries) {
        if (maxRetries > 0) {
          throw new RuntimeFailure(
            `agent decision provider retry limit exceeded for ${request.agent_ref}`,
            {
              agentRef: request.agent_ref,
              providerMode: request.mode,
              providerAttempt: attemptIndex,
              retryLimit: maxRetries,
              providerCauseCode: error.code,
              provider_metadata: request.provider_metadata,
            },
            "AgentDecisionProviderRetryLimitExceeded",
          );
        }
        throw error;
      }
      context.trace.push("agent_decision_provider_retry_scheduled", {
        payload: compactPayload({
          agent_ref: request.agent_ref,
          mode: request.mode,
          provider_attempt: attemptIndex,
          next_provider_attempt: attemptIndex + 1,
          retry_limit: maxRetries,
          reason: error.code,
          provider_metadata: request.provider_metadata,
        }),
      });
      attemptIndex += 1;
    }
  }

  throw lastProviderError;
}

async function callAgentDecisionProviderAttempt(request, context, attemptIndex) {
  consumeProviderBudget(context, {
    agentRef: request.agent_ref,
    targetRef: request.agent_ref,
    providerMode: request.mode,
    providerAttempt: attemptIndex,
  });
  context.trace.push("agent_decision_provider_call_attempted", {
    payload: compactPayload({
      agent_ref: request.agent_ref,
      mode: request.mode,
      provider_attempt: attemptIndex,
      timeout_ms: context.agentDecisionProviderTimeoutMs,
      provider_metadata: request.provider_metadata,
      request_digest: sha256Json(agentDecisionRequestRedactedEvidence(request)),
    }),
  });
  try {
    const response = await withAgentDecisionProviderTimeout(
      context.agentDecisionProvider.decide(request),
      context.agentDecisionProviderTimeoutMs,
      request,
    );
    const decision = normalizeAgentDecisionProviderResponse(request.agent_ref, response);
    if (decision.action === "cannot_complete" && request.mode !== "finalization") {
      throw new RuntimeFailure(
        `agent decision provider cannot_complete is only valid during finalization for ${request.agent_ref}`,
        {
          agentRef: request.agent_ref,
          providerMode: request.mode,
          providerAttempt: attemptIndex,
          provider_metadata: request.provider_metadata,
        },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    if (decision.action === "request_human_review" && request.mode !== "capabilities") {
      throw new RuntimeFailure(
        `agent decision provider human review is only valid after catalog for ${request.agent_ref}`,
        {
          agentRef: request.agent_ref,
          providerMode: request.mode,
          providerAttempt: attemptIndex,
          provider_metadata: request.provider_metadata,
        },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    context.trace.push("agent_decision_provider_returned", {
      payload: compactPayload({
        agent_ref: request.agent_ref,
        mode: request.mode,
        provider_attempt: attemptIndex,
        action: decision.action,
        selected_ref: decision.targetRef,
        decision_source: decision.source,
        reason: decision.reason,
        arguments_present: decision.arguments !== undefined ? true : undefined,
        provider_metadata: request.provider_metadata,
      }),
    });
    return decision;
  } catch (error) {
    if (error instanceof RuntimeFailure) {
      throw error;
    }
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      secretValuesForRedaction(context.secretStore),
    );
    throw new RuntimeFailure(
      `agent decision provider failed for ${request.agent_ref}: ${message}`,
      {
        agentRef: request.agent_ref,
        providerMode: request.mode,
        providerAttempt: attemptIndex,
        cause: message,
        provider_metadata: request.provider_metadata,
      },
      "AgentDecisionProviderUnavailable",
    );
  }
}

function normalizeAgentDecisionProviderResponse(agentRef, response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new RuntimeFailure(
      `agent decision provider response must be an object for ${agentRef}`,
      { agentRef },
      "AgentDecisionProviderSchemaViolation",
    );
  }
  if (response.action === "request_capabilities") {
    const reason = response.reason;
    if (reason !== undefined && typeof reason !== "string") {
      throw new RuntimeFailure(
        `agent decision provider catalog reason must be a string for ${agentRef}`,
        { agentRef },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    return {
      action: "request_capabilities",
      reason,
    };
  }
  if (response.action === "cannot_complete") {
    const reason = response.reason;
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new RuntimeFailure(
        `agent decision provider incomplete result must include a reason for ${agentRef}`,
        { agentRef },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    const source = response.source === undefined ? "decision_provider" : response.source;
    if (typeof source !== "string" || source.trim() === "") {
      throw new RuntimeFailure(
        `agent decision provider incomplete result source must be a string for ${agentRef}`,
        { agentRef },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    return {
      action: "cannot_complete",
      source,
      reason,
    };
  }
  if (response.action === "answer_directly") {
    const reason = response.reason;
    if (reason !== undefined && typeof reason !== "string") {
      throw new RuntimeFailure(
        `agent decision provider direct answer reason must be a string for ${agentRef}`,
        { agentRef },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    const source = response.source === undefined ? "decision_provider" : response.source;
    if (typeof source !== "string" || source.trim() === "") {
      throw new RuntimeFailure(
        `agent decision provider direct answer source must be a string for ${agentRef}`,
        { agentRef },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    if (!Object.hasOwn(response, "result") && !Object.hasOwn(response, "direct_answer")) {
      throw new RuntimeFailure(
        `agent decision provider direct answer must include result for ${agentRef}`,
        { agentRef },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    return {
      action: "answer_directly",
      source,
      reason,
      result: Object.hasOwn(response, "result") ? response.result : response.direct_answer,
    };
  }
  if (response.action === "request_human_review") {
    const reason = response.reason;
    if (reason !== undefined && typeof reason !== "string") {
      throw new RuntimeFailure(
        `agent decision provider human review reason must be a string for ${agentRef}`,
        { agentRef },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    const source = response.source === undefined ? "decision_provider" : response.source;
    if (typeof source !== "string" || source.trim() === "") {
      throw new RuntimeFailure(
        `agent decision provider human review source must be a string for ${agentRef}`,
        { agentRef },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    const reviewPrompt = response.review_prompt ?? response.prompt ?? response.context;
    if (
      reviewPrompt !== undefined
      && typeof reviewPrompt !== "string"
      && (typeof reviewPrompt !== "object" || Array.isArray(reviewPrompt))
    ) {
      throw new RuntimeFailure(
        `agent decision provider human review prompt must be a string or object for ${agentRef}`,
        { agentRef },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    return {
      action: "request_human_review",
      source,
      reason,
      reviewPrompt,
    };
  }
  try {
    return normalizeAgentDecisionRecord(agentRef, response, {
      defaultSource: "decision_provider",
    });
  } catch (error) {
    if (error instanceof ToubaRuntimeError) {
      throw new RuntimeFailure(
        error.message,
        { agentRef, causeCode: error.code },
        "AgentDecisionProviderSchemaViolation",
      );
    }
    throw error;
  }
}

function agentProviderErrorCanRetry(error) {
  return error.code === "AgentDecisionProviderUnavailable"
    || error.code === "AgentDecisionProviderTimeout";
}

function withAgentDecisionProviderTimeout(promise, timeoutMs, request) {
  if (timeoutMs === null) {
    return Promise.resolve(promise);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new RuntimeFailure(
        `agent decision provider timed out for ${request.agent_ref}`,
        {
          agentRef: request.agent_ref,
          providerMode: request.mode,
          timeoutMs,
          provider_metadata: request.provider_metadata,
        },
        "AgentDecisionProviderTimeout",
      ));
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function agentDecisionRequestRedactedEvidence(request) {
  return compactPayload({
    protocol: request.protocol,
    mode: request.mode,
    agent_ref: request.agent_ref,
    step_index: request.step_index,
    observation_count: Array.isArray(request.observations) ? request.observations.length : undefined,
    input_keys: request.input_keys,
    capability_refs: request.mode === "summary" ? request.capability_refs : undefined,
    capability_count: request.capability_count,
    catalog_presented: request.mode === "capabilities" ? true : undefined,
    provider_metadata: request.provider_metadata,
    model_input_protocol: request.model_input?.protocol,
    model_input_mode: request.model_input?.mode,
  });
}

function publicInputValuesForAgentDecision(context) {
  return Object.fromEntries(
    [...context.values.entries()]
      .filter(([handle]) => context.inputValueKeys.has(handle))
      .map(([handle, value]) => [
        handle.startsWith("value:") ? handle.slice("value:".length) : handle,
        value,
      ]),
  );
}

function assertNoSecretValueInAgentDecisionRequest(request, context, agentRef) {
  const serialized = JSON.stringify({
    inputs: request.inputs,
    model_input: request.model_input,
    observations: request.observations,
  });
  const leakedSecrets = secretEntriesInSerializedValue(serialized, context);
  if (leakedSecrets.length === 0) {
    return;
  }
  throw new RuntimeFailure(
    `agent decision provider request contains a resolved secret value for ${agentRef}`,
    {
      agentRef,
      secretHandlesRefused: leakedSecrets.map((entry) => entry.handle),
    },
    "SecretValueInAgentDecisionRequest",
  );
}

function assertNoSecretValueInAgentCapabilityDescriptors(capabilities, context, agentRef) {
  // Descriptions are whitespace-normalized and truncated for presentation.
  // Check their source text too so these transformations cannot hide a known
  // secret from the descriptor guard before either provider or trace exposure.
  const sourceDescriptions = capabilities.map((capability) => {
    const definition = definitionForCapability(capability.target_ref, context);
    return {
      description: definition?.description,
      responsibility: capability.kind === "agent" ? definition?.responsibility : undefined,
    };
  });
  const serialized = JSON.stringify({ capabilities, source_descriptions: sourceDescriptions });
  const leakedSecrets = secretEntriesInSerializedValue(serialized, context);
  if (leakedSecrets.length === 0) {
    return;
  }
  throw new RuntimeFailure(
    `agent capability descriptors contain a resolved secret value for ${agentRef}`,
    {
      agentRef,
      secretHandlesRefused: leakedSecrets.map((entry) => entry.handle),
    },
    "SecretValueInAgentCapabilityDescriptor",
  );
}

function secretEntriesInSerializedValue(serialized, context) {
  if (typeof serialized !== "string") {
    return [];
  }
  return resolvedSecretEntries(context.secretStore)
    .filter((entry) => {
      if (entry.value.length === 0) {
        return false;
      }
      // JSON escaping does not declassify a resolved secret. Keep the existing
      // raw substring guard and also match its representation inside a JSON
      // string, including quotes, backslashes and control characters. The
      // serialized container already covers nested objects and arrays.
      const escapedValue = JSON.stringify(entry.value).slice(1, -1);
      return serialized.includes(entry.value) || serialized.includes(escapedValue);
    });
}

function callArgumentsForAgentDecision(decision, context) {
  const definition = definitionForCapability(decision.targetRef, context);
  const inputs = definition?.signature?.inputs ?? [];
  if (decision.arguments === undefined) {
    // The legacy implicit-binding route may reuse named runtime inputs, but
    // omission must not bypass the same value checks as explicit arguments.
    const missingFields = inputs.filter((input) => !context.values.has(valueHandle(input.name)))
      .map((input) => input.name);
    if (missingFields.length > 0) {
      throw new RuntimeFailure(
        `agent decision is missing arguments for ${decision.targetRef}`,
        { targetRef: decision.targetRef, missingFields },
        "AgentCapabilityArgumentsInvalid",
      );
    }
    validateAgentCapabilityArgumentValues(
      decision.targetRef, inputs, inputs.map((input) => context.values.get(valueHandle(input.name))), context,
    );
    return null;
  }

  const args = decision.arguments;
  if (Array.isArray(args)) {
    if (args.length !== inputs.length) {
      throw new RuntimeFailure(
        `agent decision arguments do not match ${decision.targetRef} signature`,
        {
          targetRef: decision.targetRef,
          expected: inputs.length,
          actual: args.length,
        },
        "AgentCapabilityArgumentsInvalid",
      );
    }
    return validateAgentCapabilityArgumentValues(decision.targetRef, inputs, args, context);
  }

  if (!args || typeof args !== "object") {
    throw new RuntimeFailure(
      `agent decision arguments must be an object or array for ${decision.targetRef}`,
      { targetRef: decision.targetRef },
      "AgentCapabilityArgumentsInvalid",
    );
  }

  const keys = Object.keys(args);
  if (inputs.length === 0) {
    if (keys.length === 0) {
      return null;
    }
    throw new RuntimeFailure(
      `agent decision provided arguments for target without inputs ${decision.targetRef}`,
      {
        targetRef: decision.targetRef,
        unknownFields: keys,
      },
      "AgentCapabilityArgumentsInvalid",
    );
  }

  const expectedNames = inputs.map((input) => input.name);
  const unknownFields = keys.filter((key) => !expectedNames.includes(key));
  const missingFields = expectedNames.filter((name) => !Object.hasOwn(args, name));
  if (unknownFields.length > 0 || missingFields.length > 0) {
    throw new RuntimeFailure(
      `agent decision arguments are invalid for ${decision.targetRef}`,
      {
        targetRef: decision.targetRef,
        missingFields,
        unknownFields,
      },
      "AgentCapabilityArgumentsInvalid",
    );
  }

  return validateAgentCapabilityArgumentValues(
    decision.targetRef, inputs, inputs.map((input) => args[input.name]), context,
  );
}

function argumentsForAgentObservation(targetRef, callArguments, context) {
  const inputs = definitionForCapability(targetRef, context)?.signature?.inputs ?? [];
  return structuredClone(Object.fromEntries(inputs.map((input, index) => [
    input.name,
    callArguments === null ? context.values.get(valueHandle(input.name)) : callArguments[index],
  ])));
}

function validateAgentCapabilityArgumentValues(targetRef, inputs, values, context) {
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (!isValueCompatibleWithType(values[index], input.type_ref, context)) {
      throw new RuntimeFailure(
        `agent decision argument ${input.name} does not match ${targetRef} signature`,
        {
          targetRef,
          input: input.name,
          expectedTypeRef: input.type_ref,
          valueKind: payloadValueKind(values[index]),
        },
        "AgentCapabilityArgumentsInvalid",
      );
    }
  }
  return values;
}

async function executeTool(tool, context) {
  const toolRef = tool.id;
  const binding = validateToolBinding(tool, context);
  if (binding) {
    context.trace.push("tool_binding_authorized", {
      payload: toolBindingTracePayload(tool, binding, context),
    });
  }
  const toolArguments = argumentObject(tool.signature, context);
  validateToolInputPayload(tool, toolArguments, context);
  validateToolPayloadConstraints("input", tool, toolArguments, binding?.payloadConstraints?.input ?? []);
  assertNoSecretValueInToolArguments(tool, binding, toolArguments, context);
  const handler = context.toolHandlers[toolRef];
  const resourceBindings = resourceBindingsForTool(tool, context);
  if (binding?.effectContract?.kind === "external_write") {
    if (handler) {
      throw new RuntimeFailure(
        `external write binding cannot use an in-process tool handler ${toolRef}`,
        { toolRef },
        "EffectContextRequired",
      );
    }
    return executeEffectfulProcessTool(
      tool,
      binding,
      toolArguments,
      resourceBindings,
      context,
    );
  }
  if (!handler) {
    if (binding) {
      const durableReservation = context.executionDurability.enabled
        ? await reserveDurableToolDispatch(tool, binding, context)
        : null;
      const secretHandles = tool.required_secrets ?? [];
      const handlerRequest = {
        protocol: TOOL_HANDLER_PROTOCOL_VERSION,
        tool_ref: tool.id,
        call_id: durableReservation?.call_id
          ?? `call:${context.trace.runId}:${context.nextCallIndex}`,
        arguments: toolArguments,
        grants: [...binding.grants],
        memory_accesses: memoryAccessesForTrace(tool.memory_accesses ?? []),
        resource_bindings: resourceBindings,
        secret_handles: [...secretHandles],
        limits: { ...binding.limits },
      };
      if (!durableReservation) context.nextCallIndex += 1;
      const handlerResponse = await runProcessToolHandler({
        toolRef: tool.id,
        binding,
        request: handlerRequest,
        secretHandles,
        secretStore: context.secretStore,
        beforeDispatch: context.executionDurability.enabled
          ? () => markDurableToolDispatchStarted(context)
          : () => recordExternalToolDispatch(context),
        beforeSpawn: context.executionDurability.enabled
          ? () => assertDurableToolCanSpawn(tool, binding, context)
          : undefined,
      });
      observeToolMemoryMetadata(tool, handlerResponse.memoryMetadata, context);
      const value = handlerResponse.value;
      validateToolOutputPayload(tool, value, context);
      validateToolPayloadConstraints("output", tool, value, binding.payloadConstraints.output);
      return value;
    }
    throw new RuntimeFailure(`missing tool binding ${toolRef}`, { toolRef }, "ToolBindingMissing");
  }
  try {
    recordExternalToolDispatch(context);
    const value = await handler({
      toolRef,
      arguments: toolArguments,
      values: Object.fromEntries(context.values),
      binding: binding ? bindingPublicView(binding) : undefined,
      resourceBindings,
    });
    validateToolOutputPayload(tool, value, context);
    validateToolPayloadConstraints("output", tool, value, binding?.payloadConstraints?.output ?? []);
    return value;
  } catch (error) {
    if (error instanceof RuntimeFailure) {
      throw error;
    }
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      secretValuesForRedaction(context.secretStore),
    );
    throw new RuntimeFailure(`tool handler failed ${toolRef}: ${message}`, {
      toolRef,
      cause: message,
    }, "ToolHandlerFailed");
  }
}

async function executeEffectfulProcessTool(
  tool,
  binding,
  toolArguments,
  resourceBindings,
  context,
) {
  const toolRef = tool.id;
  const effectScopeId = context.effectScopeId;
  if (typeof effectScopeId !== "string" || effectScopeId.trim() === "") {
    throw new RuntimeFailure(
      `external write requires effect_scope_id ${toolRef}`,
      { toolRef },
      "EffectContextRequired",
    );
  }
  assertNoResolvedSecretInEffectArtifact(
    effectScopeId,
    toolRef,
    "effect_scope_id",
    context.secretStore,
  );
  const effectJournal = requireEffectJournalAdapter(context.effectJournal);
  const durablePending = context.executionDurability.enabled
    ? context.executionDurability.pendingDispatch
    : null;
  const resumedEffect = durablePending
    && durablePending.node_id === context.executionDurability.cursor?.node_id
    && durablePending.tool_ref === toolRef
    && durablePending.effect_contract_kind === "external_write";
  const effectIndex = resumedEffect
    ? durablePending.effect_index
    : context.effectState.nextEffectIndex;
  if (!resumedEffect) context.effectState.nextEffectIndex += 1;
  const airDigest = airDocumentDigest(context.trace.airDocument);
  const effectId = deriveEffectId({
    effectScopeId,
    airDigest,
    entryRef: context.entryRef,
    effectIndex,
  });
  const requestDigest = deriveEffectRequestDigest({
    airDigest,
    toolRef,
    arguments: toolArguments,
    resourceBindings,
    ...(context.compensation
      ? { controlContext: context.compensation.config.envelope }
      : {}),
  });
  const retryMode = binding.effectContract.retryMode;
  if (resumedEffect) {
    const pendingMatches = durablePending.effect_id === effectId
      && durablePending.request_digest === requestDigest
      && durablePending.retry_mode === retryMode;
    if (!pendingMatches) {
      throw new RuntimeFailure(
        "durable pending effect identity does not match the current request",
        { toolRef, effectId },
        "DurableResumeCheckpointIncompatible",
      );
    }
  }
  let journalEntry = await readEffectJournalEntry(effectJournal, effectId);
  const journalStateAtRead = journalEntry?.state ?? null;
  if (journalEntry) {
    assertNoResolvedSecretInEffectArtifact(
      journalEntry,
      toolRef,
      "journal_entry",
      context.secretStore,
    );
    assertEffectJournalRequestMatches(journalEntry, {
      effectId,
      effectScopeId,
      airDigest,
      entryRef: context.entryRef,
      effectIndex,
      requestDigest,
      toolRef,
      retryMode,
    });
    if (resumedEffect) validateDurablePendingJournalState(durablePending, journalEntry);
    await repairDurableNextCallIndexFromJournal(context, journalEntry);
    await repairDurableDispatchEvidenceFromJournal(context, journalEntry);
    if (journalEntry.state === "dispatched") {
      journalEntry = await writeEffectJournalEntry(effectJournal, {
        ...journalEntry,
        state: "unknown",
      });
    }
    if (journalEntry.state === "applied") {
      return restoreAppliedEffectResult(tool, binding, journalEntry, context);
    }
    assertEffectCanRetry(journalEntry);
  } else if (resumedEffect) {
    validateDurablePendingJournalState(durablePending, undefined);
  }

  const previousAttemptCount = journalEntry?.attempt_count ?? 0;
  if (previousAttemptCount >= Number.MAX_SAFE_INTEGER) {
    throw new RuntimeFailure(
      `effect attempt counter cannot advance ${effectId}`,
      { toolRef, effectId, requestDigest, state: journalEntry?.state },
      "EffectOutcomeUnknown",
    );
  }
  const attemptIndex = previousAttemptCount + 1;
  const preparedEntry = {
    effect_id: effectId,
    effect_scope_id: effectScopeId,
    air_digest: airDigest,
    entry_ref: context.entryRef,
    effect_index: effectIndex,
    request_digest: requestDigest,
    tool_ref: toolRef,
    retry_mode: retryMode,
    state: "prepared",
    attempt_count: journalEntry?.attempt_count ?? 0,
    ...(journalEntry?.last_call_id !== undefined
      ? { last_call_id: journalEntry.last_call_id }
      : {}),
  };
  if (!context.executionDurability.enabled) {
    journalEntry = await writeEffectJournalEntry(effectJournal, preparedEntry);
  }

  if (
    context.executionDurability.enabled
    && resumedEffect
    && durablePending.phase === "reserved"
    && ![null, "prepared"].includes(journalStateAtRead)
    && !(
      durablePending.attempt_index === previousAttemptCount + 1
      && durablePending.call_id !== journalEntry?.last_call_id
    )
  ) {
    context.executionDurability.pendingDispatch = {
      ...durablePending,
      phase: "dispatched",
    };
  }
  if (context.compensation) {
    const expected = context.compensation.config;
    if (
      context.entryRef !== expected.inverse_entry_ref
      || toolRef !== expected.inverse_tool_ref
      || effectId !== expected.inverse_effect_id
    ) {
      throw new RuntimeFailure(
        "compensation inverse identity does not match its sealed plan",
        {},
        "CompensationCheckpointIncompatible",
      );
    }
    context.compensation.lastAttempt = {
      inverseEffectId: effectId,
      attemptIndex,
      result: null,
      blockerCode: null,
    };
    enrichActiveCompensationCallTrace(context, effectId, attemptIndex);
  }
  const durableReservation = context.executionDurability.enabled
    ? await reserveDurableToolDispatch(tool, binding, context, {
      effectIndex,
      effectId,
      requestDigest,
      retryMode,
      attemptIndex,
    })
    : null;
  const callId = durableReservation?.call_id
    ?? `call:${context.trace.runId}:${context.nextCallIndex}`;
  if (!durableReservation) context.nextCallIndex += 1;
  assertNoResolvedSecretInEffectArtifact(callId, toolRef, "call_id", context.secretStore);
  if (context.executionDurability.enabled) {
    journalEntry = await writeEffectJournalEntry(effectJournal, preparedEntry);
    const reservedElapsedMs = durablePendingReservationElapsed(context, { targetRef: toolRef });
    context.executionDurability.pendingReservedElapsedMs = reservedElapsedMs;
    await persistDurableExecutionCheckpoint(context, {
      activeElapsedMs: reservedElapsedMs,
    });
  }
  const secretHandles = tool.required_secrets ?? [];
  const effect = Object.freeze({
    effect_id: effectId,
    attempt_index: attemptIndex,
    request_digest: requestDigest,
  });
  const handlerRequest = {
    protocol: context.compensation
      ? COMPENSATION_HANDLER_PROTOCOL_VERSION
      : EFFECT_HANDLER_PROTOCOL_VERSION,
    tool_ref: toolRef,
    call_id: callId,
    arguments: toolArguments,
    grants: [...binding.grants],
    memory_accesses: memoryAccessesForTrace(tool.memory_accesses ?? []),
    resource_bindings: resourceBindings,
    secret_handles: [...secretHandles],
    limits: { ...binding.limits },
    effect,
    ...(context.compensation
      ? { compensation: context.compensation.config.envelope }
      : {}),
  };
  let dispatched = false;
  let handlerResponse;
  try {
    handlerResponse = await runProcessToolHandler({
      toolRef,
      binding,
      request: handlerRequest,
      secretHandles,
      secretStore: context.secretStore,
      beforeDispatch: async () => {
        const reservedElapsedMs = context.executionDurability.enabled
          ? durablePendingReservationElapsed(context, { targetRef: toolRef })
          : null;
        if (context.compensation) {
          await assertDurableToolCanSpawn(tool, binding, context);
          await context.compensation.config.pre_spawn_guard({
            effect_id: effectId,
            attempt_index: attemptIndex,
            request_digest: requestDigest,
          });
        }
        journalEntry = await writeEffectJournalEntry(effectJournal, {
          ...preparedEntry,
          state: "dispatched",
          attempt_count: attemptIndex,
          last_call_id: callId,
        });
        dispatched = true;
        if (context.executionDurability.enabled) {
          await markDurableToolDispatchStarted(context, reservedElapsedMs);
        } else {
          recordExternalToolDispatch(context);
        }
      },
      beforeSpawn: context.executionDurability.enabled && !context.compensation
        ? () => assertDurableToolCanSpawn(tool, binding, context)
        : undefined,
    });
  } catch (error) {
    if (!dispatched) {
      if (context.compensation && error instanceof RuntimeFailure) {
        context.compensation.blockerCode = error.code;
        context.compensation.lastAttempt.blockerCode = error.code;
      }
      throw error;
    }
    const receipt = effectReceiptFromRuntimeError(error, effect, context);
    if (receipt) {
      await writeEffectJournalEntry(effectJournal, {
        ...preparedEntry,
        state: receipt.outcome,
        attempt_count: attemptIndex,
        last_call_id: callId,
        receipt,
      });
    } else {
      await writeEffectJournalEntry(effectJournal, {
        ...preparedEntry,
        state: "unknown",
        attempt_count: attemptIndex,
        last_call_id: callId,
      });
    }
    if (context.compensation) {
      const result = receipt?.outcome === "not_applied" ? "failed" : "unknown";
      context.compensation.outcome = result;
      context.compensation.blockerCode = error instanceof RuntimeFailure
        ? error.code
        : "EffectOutcomeUnknown";
      context.compensation.lastAttempt.result = result;
      context.compensation.lastAttempt.blockerCode = context.compensation.blockerCode;
    }
    throw error;
  }

  const receipt = validateEffectReceipt(handlerResponse.effectReceipt, {
    effectId,
    requestDigest,
    secretValues: secretValuesForRedaction(context.secretStore),
  });
  if (receipt.outcome === "applied") {
    try {
      validateToolOutputPayload(tool, handlerResponse.value, context);
      validateToolPayloadConstraints(
        "output",
        tool,
        handlerResponse.value,
        binding.payloadConstraints.output,
      );
      assertJsonPortable(handlerResponse.value, "EffectResultUnavailable");
      assertNoResolvedSecretInEffectArtifact(
        handlerResponse.value,
        toolRef,
        "result",
        context.secretStore,
      );
      observeToolMemoryMetadata(tool, handlerResponse.memoryMetadata, context);
    } catch (error) {
      await writeEffectJournalEntry(effectJournal, {
        ...preparedEntry,
        state: "applied",
        attempt_count: attemptIndex,
        last_call_id: callId,
        receipt,
      });
      throw error;
    }
    const persistedResult = context.compensation
      ? compensationEffectResultEnvelope(handlerResponse, context, effectId)
      : structuredClone(handlerResponse.value);
    await writeEffectJournalEntry(effectJournal, {
      ...preparedEntry,
      state: "applied",
      attempt_count: attemptIndex,
      last_call_id: callId,
      receipt,
      result: persistedResult,
    });
    if (context.compensation) {
      context.compensation.outcome = handlerResponse.compensationReceipt.result;
      context.compensation.lastAttempt.result = handlerResponse.compensationReceipt.result;
    }
    return handlerResponse.value;
  }

  await writeEffectJournalEntry(effectJournal, {
    ...preparedEntry,
    state: receipt.outcome,
    attempt_count: attemptIndex,
    last_call_id: callId,
    receipt,
  });
  if (receipt.outcome === "unknown") {
    if (context.compensation) {
      context.compensation.outcome = "unknown";
      context.compensation.blockerCode = "EffectOutcomeUnknown";
      context.compensation.lastAttempt.result = "unknown";
      context.compensation.lastAttempt.blockerCode = "EffectOutcomeUnknown";
    }
    throw effectUnknownFailure(retryMode, effectId, requestDigest, toolRef);
  }
  if (context.compensation) {
    context.compensation.outcome = "failed";
    context.compensation.blockerCode = "EffectNotApplied";
    context.compensation.lastAttempt.result = "failed";
    context.compensation.lastAttempt.blockerCode = "EffectNotApplied";
  }
  throw new RuntimeFailure(
    `external effect was not applied ${toolRef}`,
    { toolRef, effectId, requestDigest },
    "EffectNotApplied",
  );
}

function assertEffectJournalRequestMatches(entry, expected) {
  const matches =
    entry.effect_id === expected.effectId
    && entry.effect_scope_id === expected.effectScopeId
    && entry.air_digest === expected.airDigest
    && entry.entry_ref === expected.entryRef
    && entry.effect_index === expected.effectIndex
    && entry.request_digest === expected.requestDigest
    && entry.tool_ref === expected.toolRef
    && entry.retry_mode === expected.retryMode;
  if (matches) return;
  throw new RuntimeFailure(
    `effect identity is already bound to a different request ${expected.effectId}`,
    {
      toolRef: expected.toolRef,
      effectId: expected.effectId,
      requestDigest: expected.requestDigest,
      existingRequestDigest: entry.request_digest,
    },
    "EffectRequestConflict",
  );
}

function enrichActiveCompensationCallTrace(context, inverseEffectId, attemptIndex) {
  const events = context.trace.document().events;
  const event = [...events].reverse().find((candidate) => candidate.kind === "call_started");
  if (!event) return;
  event.payload = {
    ...event.payload,
    compensation_id: context.compensation.config.envelope.compensation_id,
    compensates_effect_id: context.compensation.config.envelope.compensates_effect_id,
    inverse_effect_id: inverseEffectId,
    attempt_index: attemptIndex,
  };
}

function compensationEffectResultEnvelope(handlerResponse, context, inverseEffectId) {
  const receipt = handlerResponse.compensationReceipt;
  const envelope = context.compensation.config.envelope;
  if (
    !receipt
    || receipt.compensation_id !== envelope.compensation_id
    || receipt.compensates_effect_id !== envelope.compensates_effect_id
    || receipt.inverse_effect_id !== inverseEffectId
    || !["completed", "partial"].includes(receipt.result)
  ) {
    throw new RuntimeFailure(
      "compensation receipt does not match the sealed execution context",
      { effectId: inverseEffectId },
      "CompensationReceiptInvalid",
    );
  }
  return {
    schema_version: "touba-compensation-effect-result-v1",
    value: structuredClone(handlerResponse.value),
    compensation_receipt: structuredClone(receipt),
  };
}

function assertEffectCanRetry(entry) {
  if (entry.state === "prepared" || entry.state === "not_applied") return;
  if (entry.state === "unknown" && entry.retry_mode === "idempotency_key") return;
  if (entry.state === "unknown") {
    throw effectUnknownFailure(
      entry.retry_mode,
      entry.effect_id,
      entry.request_digest,
      entry.tool_ref,
    );
  }
  throw new RuntimeFailure(
    `effect journal state cannot be retried ${entry.effect_id}`,
    { toolRef: entry.tool_ref, effectId: entry.effect_id, state: entry.state },
    "EffectOutcomeUnknown",
  );
}

function effectUnknownFailure(retryMode, effectId, requestDigest, toolRef) {
  if (retryMode === "reconcile") {
    return new RuntimeFailure(
      `external effect requires reconciliation ${toolRef}`,
      { toolRef, effectId, requestDigest, retryMode },
      "EffectReconciliationRequired",
    );
  }
  return new RuntimeFailure(
    `external effect outcome is unknown ${toolRef}`,
    { toolRef, effectId, requestDigest, retryMode },
    "EffectOutcomeUnknown",
  );
}

function restoreAppliedEffectResult(tool, binding, entry, context) {
  if (!Object.hasOwn(entry, "result")) {
    throw new RuntimeFailure(
      `applied effect result is unavailable ${tool.id}`,
      { toolRef: tool.id, effectId: entry.effect_id, requestDigest: entry.request_digest },
      "EffectResultUnavailable",
    );
  }
  if (context.compensation) {
    return restoreCompensationEffectResult(tool, binding, entry, context);
  }
  if (entry.result?.schema_version === "touba-compensation-effect-result-v1") {
    throw new RuntimeFailure(
      `reserved compensation result cannot be restored outside COMP-1 ${tool.id}`,
      { toolRef: tool.id, effectId: entry.effect_id },
      "EffectResultUnavailable",
    );
  }
  try {
    assertJsonPortable(entry.result, "EffectResultUnavailable");
    assertNoResolvedSecretInEffectArtifact(
      entry.result,
      tool.id,
      "result",
      context.secretStore,
    );
    validateToolOutputPayload(tool, entry.result, context);
    validateToolPayloadConstraints("output", tool, entry.result, binding.payloadConstraints.output);
  } catch (error) {
    if (error instanceof RuntimeFailure && error.code === "EffectResultUnavailable") throw error;
    throw new RuntimeFailure(
      `applied effect result is not restorable ${tool.id}`,
      { toolRef: tool.id, effectId: entry.effect_id, cause: error instanceof Error ? error.message : String(error) },
      "EffectResultUnavailable",
    );
  }
  return structuredClone(entry.result);
}

function restoreCompensationEffectResult(tool, binding, entry, context) {
  const value = entry.result;
  const expected = context.compensation.config.envelope;
  try {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).sort().join("|") !== "compensation_receipt|schema_version|value"
      || value.schema_version !== "touba-compensation-effect-result-v1"
    ) {
      throw new TypeError("invalid compensation result envelope");
    }
    const receipt = value.compensation_receipt;
    if (
      !receipt
      || typeof receipt !== "object"
      || Array.isArray(receipt)
      || Object.keys(receipt).sort().join("|")
        !== "compensates_effect_id|compensation_id|inverse_effect_id|result"
      || receipt.compensation_id !== expected.compensation_id
      || receipt.compensates_effect_id !== expected.compensates_effect_id
      || receipt.inverse_effect_id !== entry.effect_id
      || !["completed", "partial"].includes(receipt.result)
    ) {
      throw new TypeError("invalid compensation receipt");
    }
    assertJsonPortable(value, "CompensationEffectResultInvalid");
    assertNoResolvedSecretInEffectArtifact(value, tool.id, "result", context.secretStore);
    validateToolOutputPayload(tool, value.value, context);
    validateToolPayloadConstraints("output", tool, value.value, binding.payloadConstraints.output);
    context.compensation.outcome = receipt.result;
    context.compensation.lastAttempt = {
      inverseEffectId: entry.effect_id,
      attemptIndex: entry.attempt_count,
      result: receipt.result,
      blockerCode: null,
    };
    return structuredClone(value.value);
  } catch (error) {
    if (error instanceof RuntimeFailure && error.code === "CompensationEffectResultInvalid") {
      throw error;
    }
    throw new RuntimeFailure(
      `applied compensation result is not restorable ${tool.id}`,
      { toolRef: tool.id, effectId: entry.effect_id },
      "CompensationEffectResultInvalid",
    );
  }
}

function effectReceiptFromRuntimeError(error, effect, context) {
  const value = error instanceof RuntimeFailure ? error.details?.effectReceipt : undefined;
  if (value === undefined) return null;
  return validateEffectReceipt(value, {
    effectId: effect.effect_id,
    requestDigest: effect.request_digest,
    secretValues: secretValuesForRedaction(context.secretStore),
  });
}

function assertNoResolvedSecretInEffectArtifact(value, toolRef, field, secretStore) {
  const secretEntries = resolvedSecretEntries(secretStore);
  if (!containsResolvedSecretValue(value, secretEntries.map((entry) => entry.value))) return;
  const refused = secretEntries
    .filter((entry) => containsResolvedSecretValue(value, [entry.value]))
    .map((entry) => entry.handle);
  if (refused.length === 0) return;
  throw new RuntimeFailure(
    `effect ${field} contains a resolved secret value ${toolRef}`,
    { toolRef, secretHandlesRefused: refused },
    "SecretValueInEffectArtifact",
  );
}

function recordExternalToolDispatch(context) {
  context.effectState.externalToolDispatches += 1;
}

async function reserveDurableToolDispatch(tool, binding, context, effect = null) {
  const durable = context.executionDurability;
  const nodeId = durable.cursor?.node_id;
  const existing = durable.pendingDispatch;
  const expectedKind = binding.effectContract.kind;
  const sameReservation = existing
    && existing.node_id === nodeId
    && existing.tool_ref === tool.id
    && existing.phase === "reserved"
    && existing.effect_contract_kind === expectedKind
    && (expectedKind === "none"
      || (
        existing.effect_index === effect?.effectIndex
        && existing.effect_id === effect?.effectId
        && existing.request_digest === effect?.requestDigest
        && existing.retry_mode === effect?.retryMode
        && existing.attempt_index === effect?.attemptIndex
      ));
  if (sameReservation) {
    durable.pendingReservationRetained = true;
    durable.pendingReservedElapsedMs = durablePendingReservationElapsed(context, {
      targetRef: tool.id,
    });
    // A reservation restored from a checkpoint is already consumed active
    // time. A crash must never turn that conservative timeout back into
    // available budget when the same prepared call eventually dispatches.
    return existing;
  }

  const timeoutMs = binding.limits.timeout_ms;
  const reservedElapsedMs = reserveDurableActiveTime(context, timeoutMs, {
    targetRef: tool.id,
  });
  assertRunCanDispatch(context, { targetRef: tool.id });
  const callIndex = context.nextCallIndex;
  const callId = `call:${context.trace.runId}:${callIndex}`;
  context.nextCallIndex += 1;
  assertNoResolvedSecretInEffectArtifact(
    callId,
    tool.id,
    "call_id",
    context.secretStore,
  );
  durable.pendingDispatch = {
    node_id: nodeId,
    tool_ref: tool.id,
    call_id: callId,
    call_index: callIndex,
    effect_index: effect?.effectIndex ?? null,
    effect_id: effect?.effectId ?? null,
    request_digest: effect?.requestDigest ?? null,
    effect_contract_kind: expectedKind,
    retry_mode: effect?.retryMode ?? null,
    attempt_index: effect?.attemptIndex ?? (existing?.attempt_index ?? 0) + 1,
    phase: "reserved",
    timeout_ms: timeoutMs,
    budget_reserved: {
      tool_calls: 1,
      active_ms: timeoutMs,
    },
  };
  durable.pendingReservationRetained = false;
  durable.pendingReservedElapsedMs = reservedElapsedMs;
  await persistDurableExecutionCheckpoint(context, { activeElapsedMs: reservedElapsedMs });
  return durable.pendingDispatch;
}

async function markDurableToolDispatchStarted(context, reservedElapsedMs = null) {
  const durable = context.executionDurability;
  if (!durable.pendingDispatch || durable.pendingDispatch.phase !== "reserved") {
    throw new RuntimeFailure(
      "durable handler dispatch has no persisted reservation",
      {},
      "DurableResumeCheckpointIncompatible",
    );
  }
  durable.pendingDispatch = {
    ...durable.pendingDispatch,
    phase: "dispatched",
  };
  recordExternalToolDispatch(context);
  const checkpointElapsedMs = reservedElapsedMs
    ?? durablePendingReservationElapsed(context, {
      targetRef: durable.pendingDispatch.tool_ref,
    });
  durable.pendingReservedElapsedMs = checkpointElapsedMs;
  await persistDurableExecutionCheckpoint(context, {
    activeElapsedMs: checkpointElapsedMs,
  });
  rebaseActiveElapsedClock(context);
}

function durablePendingReservationElapsed(context, details = {}) {
  const durable = context.executionDurability;
  const pending = durable.pendingDispatch;
  if (!pending) return activeElapsedMilliseconds(context);
  if (durable.pendingReservationRetained) {
    observeRunTimeBudget(context, details);
    return activeElapsedMilliseconds(context);
  }
  return reserveDurableActiveTime(context, pending.budget_reserved.active_ms, details);
}

function rebaseActiveElapsedClock(context) {
  const nowMs = context.runState.now();
  context.runState.activeElapsedBaseMs += Math.max(
    0,
    nowMs - context.runState.startedAtMs,
  );
  context.runState.startedAtMs = nowMs;
}

function reserveDurableActiveTime(context, timeoutMs, details = {}) {
  const current = activeElapsedMilliseconds(context);
  const reserved = current + timeoutMs;
  const limit = context.budgetState.effectiveLimits.get("max_run_ms");
  if (limit && reserved >= limit.value) {
    traceBudgetExceeded(context, "max_run_ms", limit, reserved, {
      ...details,
      dispatch: true,
    });
    throw new RuntimeFailure(
      "max_run_ms exceeded",
      budgetFailureDetails("max_run_ms", limit, reserved, details),
      "RunTimeBudgetExceeded",
    );
  }
  return reserved;
}

async function repairDurableNextCallIndexFromJournal(context, journalEntry) {
  if (!context.executionDurability.enabled || !journalEntry?.last_call_id) return;
  const prefix = `call:${context.trace.runId}:`;
  if (!journalEntry.last_call_id.startsWith(prefix)) {
    if (context.executionDurability.resumeCheckpoint) {
      throw new RuntimeFailure(
        "effect journal call identity is incompatible with the resumed run",
        { effectId: journalEntry.effect_id },
        "DurableResumeCheckpointIncompatible",
      );
    }
    return;
  }
  const index = Number(journalEntry.last_call_id.slice(prefix.length));
  if (!Number.isSafeInteger(index) || index <= 0) {
    throw new RuntimeFailure(
      "effect journal call identity is invalid",
      { effectId: journalEntry.effect_id },
      "DurableResumeCheckpointIncompatible",
    );
  }
  if (context.nextCallIndex <= index) {
    throw new RuntimeFailure(
      "effect journal call high-water exceeds the durable checkpoint reservation",
      { effectId: journalEntry.effect_id },
      "DurableResumeCheckpointIncompatible",
    );
  }
}

async function repairDurableDispatchEvidenceFromJournal(context, journalEntry) {
  const durable = context.executionDurability;
  const pending = durable.pendingDispatch;
  if (
    !durable.enabled
    || !pending
    || pending.phase !== "reserved"
    || journalEntry.state === "prepared"
    || journalEntry.last_call_id !== pending.call_id
    || journalEntry.attempt_count < pending.attempt_index
  ) {
    return;
  }
  pending.phase = "dispatched";
  if (
    context.effectState.externalToolDispatches
    < context.budgetState.counters.toolCalls
  ) {
    recordExternalToolDispatch(context);
  }
  durable.pendingReservationRetained = true;
  durable.pendingReservedElapsedMs = durablePendingReservationElapsed(context, {
    targetRef: pending.tool_ref,
  });
  await persistDurableExecutionCheckpoint(context, {
    activeElapsedMs: durable.pendingReservedElapsedMs,
  });
}

function assertHumanApprovalCanPause(context, payload, airRef = undefined, options = {}) {
  const externalToolDispatches = context.effectState.externalToolDispatches;
  if (externalToolDispatches === 0) {
    return;
  }
  if (options.durableResumeAvailable === true) {
    return;
  }

  context.trace.push("human_approval_pause_refused", {
    airRef,
    payload: compactPayload({
      approval_ref: payload.approval_ref,
      mode: payload.mode,
      caller_ref: payload.caller_ref,
      agent_ref: payload.agent_ref,
      reason: "durable_resume_required_after_external_effect",
      external_tool_dispatches: externalToolDispatches,
    }),
  });
  const error = new RuntimeFailure(
    "human approval pause after external tool dispatch requires durable resume",
    {
      approvalRef: payload.approval_ref,
      mode: payload.mode,
      callerRef: payload.caller_ref,
      agentRef: payload.agent_ref,
      externalToolDispatches,
      reason: "durable_resume_required_after_external_effect",
    },
    "HumanApprovalPauseRequiresDurableResume",
  );
  context.trace.push("failure_detected", {
    airRef,
    payload: compactPayload({
      failure_mode: "human_approval_pause",
      runtime_error_code: error.code,
      approval_ref: payload.approval_ref,
      caller_ref: payload.caller_ref,
      agent_ref: payload.agent_ref,
      external_tool_dispatches: externalToolDispatches,
    }),
    message: error.message,
  });
  throw error;
}

function assertNoSecretValueInToolArguments(tool, binding, toolArguments, context) {
  const leakedSecrets = resolvedSecretEntries(context.secretStore)
    .filter((entry) => (
      entry.value.length > 0
      && containsResolvedSecretValue(toolArguments, [entry.value])
    ));

  if (leakedSecrets.length === 0) {
    return;
  }

  const refused = leakedSecrets.map((entry) => entry.handle);
  throw new RuntimeFailure(
    `tool arguments contain resolved secret value ${tool.id}`,
    {
      toolRef: tool.id,
      requiredSecrets: tool.required_secrets ?? [],
      grantedSecrets: binding?.secrets ? [...binding.secrets] : [],
      secretHandlesRefused: refused,
    },
    "SecretValueInToolArguments",
  );
}

function toolBindingTracePayload(tool, binding, context) {
  const requiredSecrets = tool.required_secrets ?? [];
  const requiredMemoryAccesses = normalizeAirMemoryAccesses(tool.memory_accesses ?? [], tool.id);
  return compactPayload({
    tool_ref: tool.id,
    caller_ref: context.activeCallerRef,
    agent_ref: context.activeAgentRef,
    required_capabilities: tool.required_capabilities ?? [],
    granted_capabilities: [...binding.grants],
    memory_accesses_required: memoryAccessesForTrace(requiredMemoryAccesses),
    memory_accesses_granted: binding.memories
      .filter((granted) => hasMemoryAccess(requiredMemoryAccesses, granted.ref, granted.access))
      .map((granted) => ({ memory_ref: granted.ref, access: granted.access })),
    secret_handles_required: [...requiredSecrets],
    secret_handles_granted: binding.secrets.filter((secret) => requiredSecrets.includes(secret)),
    secret_handles_used: [...requiredSecrets],
    handler_kind: binding.handler.kind,
    effect_contract_kind: binding.effectContract?.kind,
    effect_retry_mode: binding.effectContract?.retryMode,
    timeout_ms: binding.limits.timeout_ms,
    max_payload_bytes: binding.limits.max_payload_bytes,
    payload_constraints: payloadConstraintsForTrace(binding.payloadConstraints),
    resource_bindings: resourceBindingsForTrace(tool, context),
  });
}

function resourceBindingsForTool(tool, context) {
  if (!context.resourceBindings) {
    return [];
  }
  const resourceRefs = new Set((tool.memory_accesses ?? []).map((access) => access.memory_ref));
  return [...resourceRefs]
    .map((resourceRef) => context.resourceBindings.bindings.get(resourceRef))
    .filter((binding) => binding !== undefined)
    .map(publicResourceBindingView);
}

function publicResourceBindingView(binding) {
  return compactPayload({
    resource_ref: binding.resourceRef,
    kind: binding.kind,
    provider: binding.provider,
    grants: [...binding.grants],
    secret_handles: [...binding.secrets],
    required_secret_handles: [...binding.requiredSecrets],
    config: binding.config,
    limits: binding.limits,
  });
}

function resourceBindingsForTrace(tool, context) {
  const bindings = resourceBindingsForTool(tool, context);
  if (bindings.length === 0) {
    return undefined;
  }
  return bindings.map((resourceBinding) => ({
    resource_ref: resourceBinding.resource_ref,
    kind: resourceBinding.kind,
    provider: resourceBinding.provider,
  }));
}

function payloadConstraintsForTrace(payloadConstraints) {
  if (!payloadConstraints) {
    return undefined;
  }
  const input = payloadConstraintRulesForTrace(payloadConstraints.input);
  const output = payloadConstraintRulesForTrace(payloadConstraints.output);
  if (Object.keys(input).length === 0 && Object.keys(output).length === 0) {
    return undefined;
  }
  return compactPayload({
    input,
    output,
  });
}

function payloadConstraintRulesForTrace(rules) {
  return Object.fromEntries(
    (rules ?? []).map((rule) => [
      rule.path,
      compactPayload({
        non_empty: rule.non_empty,
        max_length: rule.max_length,
        min: rule.min,
        max: rule.max,
        allowed_values_count: rule.allowed_values?.length,
        min_items: rule.min_items,
        max_items: rule.max_items,
      }),
    ]),
  );
}

function validateToolBinding(tool, context, { traceAuthorizations = true } = {}) {
  const requiredCapabilities = tool.required_capabilities ?? [];
  const requiredSecrets = tool.required_secrets ?? [];
  const requiredMemoryAccesses = normalizeAirMemoryAccesses(tool.memory_accesses ?? [], tool.id);
  const requiresManifest =
    requiredCapabilities.length > 0 || requiredSecrets.length > 0 || requiredMemoryAccesses.length > 0;

  if (!requiresManifest && !context.toolBindingManifest) {
    return null;
  }

  if (!context.toolBindingManifest) {
    traceSecretHandleRefusals(tool, requiredSecrets, context, "manifest_missing");
    traceMemoryAccessRefusals(tool, requiredMemoryAccesses, context, "manifest_missing");
    throw new RuntimeFailure(
      `missing tool binding manifest for ${tool.id}`,
      {
        toolRef: tool.id,
        requiredCapabilities,
        requiredSecrets,
        requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
      },
      requiredMemoryAccesses.length > 0 ? "MemoryBindingMissing" : "ToolBindingManifestMissing",
    );
  }

  const binding = context.toolBindingManifest.bindings.get(tool.id);
  if (!binding) {
    traceSecretHandleRefusals(tool, requiredSecrets, context, "binding_missing");
    traceMemoryAccessRefusals(tool, requiredMemoryAccesses, context, "binding_missing");
    throw new RuntimeFailure(
      `missing manifest binding ${tool.id}`,
      {
        toolRef: tool.id,
        requiredCapabilities,
        requiredSecrets,
        requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
      },
      requiredMemoryAccesses.length > 0 ? "MemoryBindingMissing" : "ToolBindingMissing",
    );
  }

  for (const memoryAccess of requiredMemoryAccesses) {
    const capability = MEMORY_ACCESS_TO_CAPABILITY[memoryAccess.access];
    if (!binding.grantSet.has(capability)) {
      traceMemoryAccessRefused(tool, memoryAccess, context, "grant_missing");
      throw new RuntimeFailure(
        `memory grant ${capability} missing for ${tool.id}`,
        {
          toolRef: tool.id,
          memoryRef: memoryAccess.memory_ref,
          memoryAccess: memoryAccess.access,
          missingCapability: capability,
          requiredCapabilities,
          requiredSecrets,
          requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
          grantedCapabilities: [...binding.grants],
          grantedSecrets: [...binding.secrets],
          grantedMemoryAccesses: manifestMemoriesForTrace(binding.memories),
          ownerMemoryScopes: memoryScopesForTrace(context),
        },
        "MemoryGrantMissing",
      );
    }
  }

  if (requiredSecrets.length > 0 && !binding.grantSet.has("secret_read")) {
    traceSecretHandleRefusals(tool, requiredSecrets, context, "grant_missing");
    throw new RuntimeFailure(
      `secret_read grant missing for ${tool.id}`,
      {
        toolRef: tool.id,
        missingCapability: "secret_read",
        requiredCapabilities,
        requiredSecrets,
        grantedCapabilities: [...binding.grants],
        grantedSecrets: [...binding.secrets],
      },
      "SecretReadGrantMissing",
    );
  }

  const missingBindingMemoryAccesses = requiredMemoryAccesses.filter(
    (memoryAccess) => !binding.memorySet.has(memoryAccessKey(memoryAccess.memory_ref, memoryAccess.access)),
  );
  if (missingBindingMemoryAccesses.length > 0) {
    traceMemoryAccessRefusals(tool, missingBindingMemoryAccesses, context, "binding_memory_missing");
    throw new RuntimeFailure(
      `tool binding ${tool.id} is missing required memory accesses ${memoryAccessSummary(missingBindingMemoryAccesses)}`,
      {
        toolRef: tool.id,
        missingMemoryAccesses: memoryAccessesForTrace(missingBindingMemoryAccesses),
        requiredCapabilities,
        requiredSecrets,
        requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
        grantedCapabilities: [...binding.grants],
        grantedSecrets: [...binding.secrets],
        grantedMemoryAccesses: manifestMemoriesForTrace(binding.memories),
        ownerMemoryScopes: memoryScopesForTrace(context),
      },
      "MemoryNotGrantedToBinding",
    );
  }

  const missingOwnerMemoryAccesses = requiredMemoryAccesses.filter(
    (memoryAccess) => !memoryAuthorityForAccess(memoryAccess, context),
  );
  if (missingOwnerMemoryAccesses.length > 0) {
    traceMemoryAccessRefusals(tool, missingOwnerMemoryAccesses, context, "owner_scope_missing");
    throw new RuntimeFailure(
      `active owner is missing required memory scopes for ${tool.id}: ${memoryAccessSummary(missingOwnerMemoryAccesses)}`,
      {
        toolRef: tool.id,
        missingMemoryAccesses: memoryAccessesForTrace(missingOwnerMemoryAccesses),
        requiredCapabilities,
        requiredSecrets,
        requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
        grantedCapabilities: [...binding.grants],
        grantedSecrets: [...binding.secrets],
        grantedMemoryAccesses: manifestMemoriesForTrace(binding.memories),
        ownerMemoryScopes: memoryScopesForTrace(context),
      },
      "MemoryNotGrantedToOwner",
    );
  }

  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !binding.grantSet.has(capability),
  );
  if (missingCapabilities.length > 0) {
    throw new RuntimeFailure(
      `tool binding ${tool.id} is missing required capabilities ${missingCapabilities.join(", ")}`,
      {
        toolRef: tool.id,
        missingCapabilities,
        requiredCapabilities,
        requiredSecrets,
        requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
        grantedCapabilities: [...binding.grants],
        grantedSecrets: [...binding.secrets],
        grantedMemoryAccesses: manifestMemoriesForTrace(binding.memories),
      },
      "ToolCapabilityNotGranted",
    );
  }

  const missingBindingSecrets = requiredSecrets.filter((secret) => !binding.secretSet.has(secret));
  if (missingBindingSecrets.length > 0) {
    traceSecretHandleRefusals(tool, missingBindingSecrets, context, "binding_secret_missing");
    throw new RuntimeFailure(
      `tool binding ${tool.id} is missing required secret handles ${missingBindingSecrets.join(", ")}`,
      {
        toolRef: tool.id,
        missingSecrets: missingBindingSecrets,
        requiredCapabilities,
        requiredSecrets,
        requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
        grantedCapabilities: [...binding.grants],
        grantedSecrets: [...binding.secrets],
        grantedMemoryAccesses: manifestMemoriesForTrace(binding.memories),
      },
      "SecretRequiredButNotBound",
    );
  }

  if (requiredSecrets.length > 0 && !context.secretStore) {
    traceSecretHandleRefusals(tool, requiredSecrets, context, "profile_missing");
    throw new RuntimeFailure(
      `secrets file is required for ${tool.id}`,
      {
        toolRef: tool.id,
        missingSecrets: requiredSecrets,
        requiredCapabilities,
        requiredSecrets,
        requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
        grantedCapabilities: [...binding.grants],
        grantedSecrets: [...binding.secrets],
        grantedMemoryAccesses: manifestMemoriesForTrace(binding.memories),
      },
      "SecretNotResolved",
    );
  }

  const secretRefusals = requiredSecrets
    .map((secret) => ({
      handle: secret,
      refusal: context.secretStore.refusalFor(secret, context.runState.now()),
    }))
    .filter((entry) => entry.refusal !== null);
  if (secretRefusals.length > 0) {
    for (const entry of secretRefusals) {
      traceSecretHandleRefused(tool, entry.handle, context, entry.refusal.reason);
    }
    const refusedSecrets = secretRefusals.map((entry) => entry.handle);
    const runtimeCode = secretRefusals[0]?.refusal?.code ?? "SecretNotResolved";
    throw new RuntimeFailure(
      `required secret handles are not usable for ${tool.id}: ${refusedSecrets.join(", ")}`,
      {
        toolRef: tool.id,
        missingSecrets: refusedSecrets,
        requiredCapabilities,
        requiredSecrets,
        requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
        grantedCapabilities: [...binding.grants],
        grantedSecrets: [...binding.secrets],
        grantedMemoryAccesses: manifestMemoriesForTrace(binding.memories),
        secretHandlesRefused: refusedSecrets,
        secretRefusalReasons: Object.fromEntries(
          secretRefusals.map((entry) => [entry.handle, entry.refusal.reason]),
        ),
      },
      runtimeCode,
    );
  }

  if (context.activeAgentRef) {
    const agentSecrets =
      context.toolBindingManifest.agentSecretScopes.get(context.activeAgentRef) ?? new Set();
    const missingAgentSecrets = requiredSecrets.filter((secret) => !agentSecrets.has(secret));
    if (missingAgentSecrets.length > 0) {
      traceSecretHandleRefusals(tool, missingAgentSecrets, context, "agent_scope_missing");
      throw new RuntimeFailure(
        `agent ${context.activeAgentRef} is not granted required secret handles ${missingAgentSecrets.join(", ")}`,
        {
          toolRef: tool.id,
          agentRef: context.activeAgentRef,
          missingSecrets: missingAgentSecrets,
          requiredCapabilities,
          requiredSecrets,
          requiredMemoryAccesses: memoryAccessesForTrace(requiredMemoryAccesses),
          grantedCapabilities: [...binding.grants],
          grantedSecrets: [...binding.secrets],
          grantedMemoryAccesses: manifestMemoriesForTrace(binding.memories),
        },
        "SecretNotGrantedToAgent",
      );
    }
  }

  if (traceAuthorizations) {
    for (const memoryAccess of requiredMemoryAccesses) {
      traceMemoryAccessAuthorized(tool, memoryAccess, context);
    }
    for (const secret of requiredSecrets) {
      traceSecretHandleAuthorized(tool, secret, context);
    }
  }

  return binding;
}

function traceSecretHandleAuthorized(tool, secretHandle, context) {
  context.trace.push("secret_handle_authorized", {
    payload: compactPayload({
      caller_ref: context.activeCallerRef,
      agent_ref: context.activeAgentRef,
      tool_ref: tool.id,
      secret_handle: secretHandle,
      authority_source: context.activeAgentRef ? "binding_and_agent_secret_scope" : "binding_secret_scope",
    }),
  });
}

function traceSecretHandleRefusals(tool, secretHandles, context, reason) {
  for (const secretHandle of secretHandles) {
    traceSecretHandleRefused(tool, secretHandle, context, reason);
  }
}

function traceSecretHandleRefused(tool, secretHandle, context, reason) {
  context.trace.push("secret_handle_refused", {
    payload: compactPayload({
      caller_ref: context.activeCallerRef,
      agent_ref: context.activeAgentRef,
      tool_ref: tool.id,
      secret_handle: secretHandle,
      reason,
    }),
  });
}

function normalizeAirMemoryAccesses(memoryAccesses, toolRef) {
  if (!Array.isArray(memoryAccesses)) {
    throw new RuntimeFailure(
      `tool memory_accesses must be an array ${toolRef}`,
      { toolRef },
      "MemoryAccessUnsupported",
    );
  }
  return memoryAccesses.map((memoryAccess) => {
    if (!memoryAccess || typeof memoryAccess !== "object" || Array.isArray(memoryAccess)) {
      throw new RuntimeFailure(
        `tool memory_accesses entries must be objects ${toolRef}`,
        { toolRef },
        "MemoryAccessUnsupported",
      );
    }
    const memoryRef = memoryAccess.memory_ref;
    const access = memoryAccess.access;
    if (typeof memoryRef !== "string" || !memoryRef.startsWith("memory:")) {
      throw new RuntimeFailure(
        `tool memory_accesses entry has invalid memory_ref ${toolRef}`,
        { toolRef, memoryRef },
        "MemoryAccessUnsupported",
      );
    }
    if (!MEMORY_ACCESS_VALUES.has(access)) {
      throw new RuntimeFailure(
        `tool memory_accesses entry has unsupported access ${access}`,
        { toolRef, memoryRef, memoryAccess: access },
        "MemoryAccessUnsupported",
      );
    }
    return Object.freeze({
      memory_ref: memoryRef,
      access,
    });
  });
}

function normalizeOwnerMemoryScopes(scopes, ownerRef) {
  if (!Array.isArray(scopes)) {
    throw new RuntimeFailure(
      `owner memory_scopes must be an array ${ownerRef}`,
      { ownerRef },
      "MemoryAccessUnsupported",
    );
  }
  return scopes.map((scope) => {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      throw new RuntimeFailure(
        `owner memory_scopes entries must be objects ${ownerRef}`,
        { ownerRef },
        "MemoryAccessUnsupported",
      );
    }
    const memoryRef = scope.memory_ref;
    const access = scope.access;
    if (typeof memoryRef !== "string" || !memoryRef.startsWith("memory:")) {
      throw new RuntimeFailure(
        `owner memory_scopes entry has invalid memory_ref ${ownerRef}`,
        { ownerRef, memoryRef },
        "MemoryAccessUnsupported",
      );
    }
    if (!MEMORY_ACCESS_VALUES.has(access)) {
      throw new RuntimeFailure(
        `owner memory_scopes entry has unsupported access ${access}`,
        { ownerRef, memoryRef, memoryAccess: access },
        "MemoryAccessUnsupported",
      );
    }
    return Object.freeze({
      owner_ref: ownerRef,
      memory_ref: memoryRef,
      access,
    });
  });
}

function traceMemoryAccessAuthorized(tool, memoryAccess, context) {
  const authority = memoryAuthorityForAccess(memoryAccess, context);
  context.trace.push("memory_access_authorized", {
    payload: compactPayload({
      owner_ref: authority?.ownerRef,
      caller_ref: context.activeCallerRef,
      agent_ref: context.activeAgentRef,
      tool_ref: tool.id,
      memory_ref: memoryAccess.memory_ref,
      access: memoryAccess.access,
      authority_source: authority?.authoritySource ?? "memory_scope",
    }),
  });
}

function traceMemoryAccessRefusals(tool, memoryAccesses, context, reason) {
  for (const memoryAccess of memoryAccesses) {
    traceMemoryAccessRefused(tool, memoryAccess, context, reason);
  }
}

function traceMemoryAccessRefused(tool, memoryAccess, context, reason) {
  context.trace.push("memory_access_refused", {
    payload: compactPayload({
      owner_ref: context.activeAgentRef ?? context.activeCallerRef,
      caller_ref: context.activeCallerRef,
      agent_ref: context.activeAgentRef,
      tool_ref: tool.id,
      memory_ref: memoryAccess.memory_ref,
      access: memoryAccess.access,
      reason,
    }),
  });
}

function observeToolMemoryMetadata(tool, memoryMetadata, context) {
  if (memoryMetadata === undefined) {
    return;
  }

  if (!Array.isArray(memoryMetadata)) {
    throwMemoryMetadataFailure(tool, context, {
      code: "MemoryMetadataInvalid",
      reason: "invalid_metadata",
      schemaPath: "memory_metadata",
    });
  }

  const requiredMemoryAccesses = normalizeAirMemoryAccesses(tool.memory_accesses ?? [], tool.id);
  for (let index = 0; index < memoryMetadata.length; index += 1) {
    const path = `memory_metadata[${index}]`;
    const entry = normalizeMemoryMetadataEntry(memoryMetadata[index], tool, context, {
      path,
      requiredMemoryAccesses,
    });
    traceMemoryMetadataObserved(tool, entry, context);
  }
}

function normalizeMemoryMetadataEntry(entry, tool, context, details) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throwMemoryMetadataFailure(tool, context, {
      code: "MemoryMetadataInvalid",
      reason: "invalid_metadata",
      schemaPath: details.path,
    });
  }

  const leakedSecretHandles = secretHandlesLeakedByMetadata(entry, context);
  if (leakedSecretHandles.length > 0) {
    throwMemoryMetadataFailure(tool, context, {
      code: "MemoryMetadataLeakDetected",
      reason: "metadata_leak_detected",
      schemaPath: details.path,
      secretHandlesRefused: leakedSecretHandles,
    });
  }

  for (const field of Object.keys(entry)) {
    if (MEMORY_METADATA_LEAK_FIELDS.has(field)) {
      throwMemoryMetadataFailure(tool, context, {
        code: "MemoryMetadataLeakDetected",
        reason: "metadata_leak_detected",
        schemaPath: `${details.path}.${field}`,
        field,
      });
    }
    if (MEMORY_METADATA_FORBIDDEN_FIELDS.has(field) || !MEMORY_METADATA_ALLOWED_FIELDS.has(field)) {
      throwMemoryMetadataFailure(tool, context, {
        code: "MemoryMetadataInvalid",
        reason: "invalid_metadata",
        schemaPath: `${details.path}.${field}`,
        field,
      });
    }
  }

  const memoryRef = requireMemoryMetadataString(entry, "memory_ref", tool, context, details.path);
  const operation = requireMemoryMetadataEnum(
    entry,
    "operation",
    MEMORY_ACCESS_VALUES,
    tool,
    context,
    details.path,
  );
  const sourceKind = requireMemoryMetadataEnum(
    entry,
    "source_kind",
    MEMORY_PI1_SOURCE_KINDS,
    tool,
    context,
    details.path,
  );
  const sourceRef = requireMemoryMetadataString(entry, "source_ref", tool, context, details.path);
  const integrityEvidence = requireMemoryMetadataEnum(
    entry,
    "integrity_evidence",
    MEMORY_PI1_INTEGRITY_EVIDENCE,
    tool,
    context,
    details.path,
  );

  if (!memoryRef.startsWith("memory:")) {
    throwMemoryMetadataFailure(tool, context, {
      code: "MemoryMetadataInvalid",
      reason: "invalid_metadata",
      schemaPath: `${details.path}.memory_ref`,
      field: "memory_ref",
    });
  }

  const authorizedAccess = details.requiredMemoryAccesses.find(
    (memoryAccess) => memoryAccess.memory_ref === memoryRef && memoryAccess.access === operation,
  );
  if (!authorizedAccess) {
    throwMemoryMetadataFailure(tool, context, {
      code: "MemoryMetadataUnauthorized",
      reason: "unauthorized_memory_metadata",
      schemaPath: `${details.path}.memory_ref`,
      memoryRef,
      memoryAccess: operation,
    });
  }

  const digest = optionalMemoryMetadataString(entry, "digest", tool, context, details.path);
  const digestKind = optionalMemoryMetadataEnum(
    entry,
    "digest_kind",
    MEMORY_PI1_DIGEST_KINDS,
    tool,
    context,
    details.path,
  );
  if ((digest !== undefined && digestKind === undefined) || (digest === undefined && digestKind !== undefined)) {
    throwMemoryMetadataFailure(tool, context, {
      code: "MemoryMetadataInvalid",
      reason: "invalid_metadata",
      schemaPath: `${details.path}.digest`,
      field: "digest",
      memoryRef,
      memoryAccess: operation,
    });
  }

  const writtenAt = optionalMemoryMetadataString(entry, "written_at", tool, context, details.path);
  if (writtenAt !== undefined && Number.isNaN(Date.parse(writtenAt))) {
    throwMemoryMetadataFailure(tool, context, {
      code: "MemoryMetadataInvalid",
      reason: "invalid_metadata",
      schemaPath: `${details.path}.written_at`,
      field: "written_at",
      memoryRef,
      memoryAccess: operation,
    });
  }

  return Object.freeze({
    memory_ref: memoryRef,
    operation,
    source_kind: sourceKind,
    source_ref: sourceRef,
    integrity_evidence: integrityEvidence,
    writer_ref: optionalMemoryMetadataString(entry, "writer_ref", tool, context, details.path),
    written_at: writtenAt,
    digest_kind: digestKind,
    digest,
    schema_ref: optionalMemoryMetadataString(entry, "schema_ref", tool, context, details.path),
    version_ref: optionalMemoryMetadataString(entry, "version_ref", tool, context, details.path),
  });
}

function requireMemoryMetadataString(entry, field, tool, context, path) {
  const value = entry[field];
  if (typeof value !== "string" || value.trim() === "") {
    throwMemoryMetadataFailure(tool, context, {
      code: "MemoryMetadataInvalid",
      reason: "invalid_metadata",
      schemaPath: `${path}.${field}`,
      field,
    });
  }
  return value.trim();
}

function optionalMemoryMetadataString(entry, field, tool, context, path) {
  if (entry[field] === undefined) {
    return undefined;
  }
  return requireMemoryMetadataString(entry, field, tool, context, path);
}

function requireMemoryMetadataEnum(entry, field, values, tool, context, path) {
  const value = requireMemoryMetadataString(entry, field, tool, context, path);
  if (!values.has(value)) {
    throwMemoryMetadataFailure(tool, context, {
      code: "MemoryMetadataInvalid",
      reason: "invalid_metadata",
      schemaPath: `${path}.${field}`,
      field,
    });
  }
  return value;
}

function optionalMemoryMetadataEnum(entry, field, values, tool, context, path) {
  if (entry[field] === undefined) {
    return undefined;
  }
  return requireMemoryMetadataEnum(entry, field, values, tool, context, path);
}

function secretHandlesLeakedByMetadata(entry, context) {
  return resolvedSecretEntries(context.secretStore)
    .filter((secret) => (
      secret.value.length > 0
      && containsResolvedSecretValue(entry, [secret.value])
    ))
    .map((secret) => secret.handle);
}

function traceMemoryMetadataObserved(tool, metadata, context) {
  const memoryAccess = {
    memory_ref: metadata.memory_ref,
    access: metadata.operation,
  };
  const authority = memoryAuthorityForAccess(memoryAccess, context);
  const common = compactPayload({
    owner_ref: authority?.ownerRef,
    caller_ref: context.activeCallerRef,
    agent_ref: context.activeAgentRef,
    memory_ref: metadata.memory_ref,
    operation: metadata.operation,
    tool_ref: tool.id,
  });

  context.trace.push("memory_provenance_observed", {
    payload: compactPayload({
      ...common,
      source_kind: metadata.source_kind,
      source_ref: metadata.source_ref,
      writer_ref: metadata.writer_ref,
      written_at: metadata.written_at,
      integrity_evidence: metadata.integrity_evidence,
    }),
  });

  if (
    metadata.integrity_evidence !== "none"
    || metadata.digest_kind !== undefined
    || metadata.digest !== undefined
    || metadata.schema_ref !== undefined
    || metadata.version_ref !== undefined
  ) {
    context.trace.push("memory_integrity_observed", {
      payload: compactPayload({
        ...common,
        integrity_evidence: metadata.integrity_evidence,
        digest_kind: metadata.digest_kind,
        digest: metadata.digest,
        schema_ref: metadata.schema_ref,
        version_ref: metadata.version_ref,
      }),
    });
  }
}

function throwMemoryMetadataFailure(tool, context, details) {
  const payload = compactPayload({
    tool_ref: tool.id,
    memory_ref: details.memoryRef,
    operation: details.memoryAccess,
    owner_ref: context.activeAgentRef ?? context.activeCallerRef,
    caller_ref: context.activeCallerRef,
    agent_ref: context.activeAgentRef,
    reason: details.reason,
    runtime_error_code: details.code,
    schema_path: details.schemaPath,
    field: details.field,
    integrity_evidence: details.integrityEvidence,
  });
  context.trace.push(
    details.code === "MemoryIntegrityRefused" ? "memory_integrity_refused" : "memory_metadata_refused",
    { payload },
  );
  throw new RuntimeFailure(
    `memory metadata refused for ${tool.id} at ${details.schemaPath}: ${details.reason}`,
    {
      toolRef: tool.id,
      memoryRef: details.memoryRef,
      memoryAccess: details.memoryAccess,
      schemaPath: details.schemaPath,
      field: details.field,
      integrityEvidence: details.integrityEvidence,
      secretHandlesRefused: details.secretHandlesRefused,
    },
    details.code,
  );
}

function memoryAuthorityForAccess(memoryAccess, context) {
  if (context.activeAgentRef) {
    const agentCandidate = { ownerRef: context.activeAgentRef, authoritySource: "agent_memory_scope" };
    return ownerHasMemoryScope(memoryAccess, context, agentCandidate) ? agentCandidate : null;
  }

  if (context.activeCallerRef) {
    const callerCandidate = { ownerRef: context.activeCallerRef, authoritySource: "memory_scope" };
    return ownerHasMemoryScope(memoryAccess, context, callerCandidate) ? callerCandidate : null;
  }
  return null;
}

function ownerHasMemoryScope(memoryAccess, context, candidate) {
  const owner = definitionForOwnerRef(context, candidate.ownerRef);
  const scopes = normalizeOwnerMemoryScopes(owner?.memory_scopes ?? [], candidate.ownerRef);
  return scopes.some((scope) =>
    scope.memory_ref === memoryAccess.memory_ref && scope.access === memoryAccess.access
  );
}

function definitionForOwnerRef(context, ownerRef) {
  if (typeof ownerRef !== "string") {
    return null;
  }
  if (ownerRef.startsWith("agent:")) {
    return context.indexes.agents.get(ownerRef) ?? null;
  }
  if (ownerRef.startsWith("strategy:")) {
    return context.indexes.strategies.get(ownerRef) ?? null;
  }
  if (ownerRef.startsWith("skill:")) {
    return context.indexes.skills.get(ownerRef) ?? null;
  }
  if (ownerRef.startsWith("function:")) {
    return context.indexes.functions.get(ownerRef) ?? null;
  }
  return null;
}

function memoryScopesForTrace(context) {
  const ownerRefs = [...new Set([context.activeAgentRef, context.activeCallerRef].filter(Boolean))];
  return ownerRefs.flatMap((ownerRef) => {
    const owner = definitionForOwnerRef(context, ownerRef);
    return normalizeOwnerMemoryScopes(owner?.memory_scopes ?? [], ownerRef).map((scope) => ({
      owner_ref: ownerRef,
      memory_ref: scope.memory_ref,
      access: scope.access,
    }));
  });
}

function hasMemoryAccess(memoryAccesses, memoryRef, access) {
  return memoryAccesses.some(
    (memoryAccess) => memoryAccess.memory_ref === memoryRef && memoryAccess.access === access,
  );
}

function memoryAccessesForTrace(memoryAccesses) {
  return memoryAccesses.map((memoryAccess) => ({
    memory_ref: memoryAccess.memory_ref,
    access: memoryAccess.access,
  }));
}

function manifestMemoriesForTrace(memories) {
  return memories.map((memory) => ({
    memory_ref: memory.ref,
    access: memory.access,
  }));
}

function memoryAccessSummary(memoryAccesses) {
  return memoryAccesses
    .map((memoryAccess) => `${memoryAccess.memory_ref}:${memoryAccess.access}`)
    .join(", ");
}

function memoryAccessKey(memoryRef, access) {
  return `${memoryRef}\u0000${access}`;
}

function normalizeOptionalToolBindingManifest(manifest) {
  if (manifest === undefined || manifest === null) {
    return null;
  }
  return normalizeToolBindingManifest(manifest);
}

function normalizeToolBindingManifest(manifest) {
  if (
    manifest !== null
    && typeof manifest === "object"
    && NORMALIZED_TOOL_BINDING_MANIFESTS.has(manifest)
  ) {
    return manifest;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "manifest must be an object");
  }
  if (!TOOL_BINDING_MANIFEST_VERSIONS.has(manifest.manifest_version)) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      `manifest_version must be ${TOOL_BINDING_MANIFEST_V1}, ${TOOL_BINDING_MANIFEST_V2} or ${TOOL_BINDING_MANIFEST_V3}`,
      { actual: manifest.manifest_version },
    );
  }
  if (
    manifest.bindings !== undefined
    && (
      !manifest.bindings
      || typeof manifest.bindings !== "object"
      || Array.isArray(manifest.bindings)
    )
  ) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "manifest bindings must be an object");
  }
  if (
    manifest.triggers !== undefined
    && (
      !manifest.triggers
      || typeof manifest.triggers !== "object"
      || Array.isArray(manifest.triggers)
    )
  ) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "manifest triggers must be an object");
  }

  const bindings = new Map();
  for (const [toolRef, binding] of Object.entries(manifest.bindings ?? {})) {
    bindings.set(toolRef, normalizeManifestBinding(toolRef, binding, manifest.manifest_version));
  }
  const triggers = new Map();
  for (const [triggerRef, trigger] of Object.entries(manifest.triggers ?? {})) {
    triggers.set(triggerRef, normalizeManifestTrigger(triggerRef, trigger));
  }

  const normalized = Object.freeze({
    version: manifest.manifest_version,
    bindings,
    triggers,
    runLimits: normalizeManifestRunLimits(manifest.run_limits),
    agentSecretScopes: normalizeAgentSecretScopes(manifest.agent_secret_scopes),
  });
  NORMALIZED_TOOL_BINDING_MANIFESTS.add(normalized);
  return normalized;
}

function normalizeManifestRunLimits(limits) {
  if (limits === undefined) {
    return new Map();
  }
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "run_limits must be an object");
  }
  const normalized = new Map();
  for (const [budgetKind, value] of Object.entries(limits)) {
    if (!RUN_BUDGET_KIND_SET.has(budgetKind)) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "run_limits contains unknown budget kind", {
        budgetKind,
      });
    }
    assertPositiveInteger(value, budgetKind, "run_limits");
    normalized.set(budgetKind, Object.freeze({
      value,
      authoritySource: "manifest",
    }));
  }
  return normalized;
}

function normalizeManifestTrigger(triggerRef, trigger) {
  if (!triggerRef.startsWith("trigger:")) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger key must be an AirTrigger.id", {
      triggerRef,
    });
  }
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger entry must be an object", {
      triggerRef,
    });
  }
  if (trigger.enabled !== true && trigger.enabled !== false) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger enabled must be boolean", {
      triggerRef,
    });
  }
  if (!trigger.source || typeof trigger.source !== "object" || Array.isArray(trigger.source)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger source must be an object", {
      triggerRef,
    });
  }
  if (typeof trigger.source.kind !== "string" || trigger.source.kind.trim() === "") {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger source.kind is required", {
      triggerRef,
    });
  }
  return Object.freeze({
    triggerRef,
    enabled: trigger.enabled,
    source: Object.freeze({
      kind: trigger.source.kind.trim(),
      timezone: typeof trigger.source.timezone === "string" ? trigger.source.timezone : undefined,
    }),
    limits: normalizeManifestTriggerLimits(trigger.limits, triggerRef),
    payload: normalizeManifestTriggerPayload(trigger.payload, triggerRef),
  });
}

function normalizeManifestTriggerPayload(payload, triggerRef) {
  if (payload === undefined) {
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger payload must be an object", {
      triggerRef,
    });
  }
  const format = payload.format ?? "json";
  if (format !== "json") {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger payload.format must be json", {
      triggerRef,
      actual: format,
    });
  }
  const maxBytes = payload.max_bytes ?? 65536;
  assertPositiveInteger(maxBytes, "payload.max_bytes", triggerRef);
  if (maxBytes > 65536) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger payload.max_bytes must be <= 65536", {
      triggerRef,
      actual: maxBytes,
    });
  }
  const contentTypes = payload.content_types === undefined
    ? ["application/json"]
    : payload.content_types;
  if (
    !Array.isArray(contentTypes)
    || contentTypes.length === 0
    || contentTypes.some((contentType) => typeof contentType !== "string" || contentType.trim() === "")
  ) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger payload.content_types must be a non-empty string array", {
      triggerRef,
    });
  }
  if (!payload.map || typeof payload.map !== "object" || Array.isArray(payload.map)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger payload.map must be an object", {
      triggerRef,
    });
  }
  const mapped = {};
  for (const [inputName, jsonPath] of Object.entries(payload.map)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(inputName)) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger payload.map keys must be input names", {
        triggerRef,
        inputName,
      });
    }
    if (typeof jsonPath !== "string" || !/^\$(\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(jsonPath)) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger payload.map values must be JSON paths like $.field", {
        triggerRef,
        inputName,
      });
    }
    mapped[inputName] = jsonPath;
  }
  return Object.freeze({
    format,
    maxBytes,
    contentTypes: Object.freeze(contentTypes.map((contentType) => contentType.trim().toLowerCase())),
    map: Object.freeze(mapped),
  });
}

function normalizeManifestTriggerLimits(limits, triggerRef) {
  if (limits === undefined) {
    return Object.freeze({});
  }
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "trigger limits must be an object", {
      triggerRef,
    });
  }
  const normalized = {};
  if (limits.max_runs_per_day !== undefined) {
    assertPositiveInteger(limits.max_runs_per_day, "max_runs_per_day", triggerRef);
    normalized.max_runs_per_day = limits.max_runs_per_day;
  }
  if (limits.timeout_ms !== undefined) {
    assertPositiveInteger(limits.timeout_ms, "timeout_ms", triggerRef);
    normalized.timeout_ms = limits.timeout_ms;
  }
  return Object.freeze(normalized);
}

function normalizeManifestBinding(toolRef, binding, manifestVersion) {
  if (!toolRef.startsWith("tool:")) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding key must be an AirTool.id", {
      toolRef,
    });
  }
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding entry must be an object", {
      toolRef,
    });
  }
  const effectContract = normalizeManifestEffectContract(toolRef, binding, manifestVersion);
  if (!binding.handler || typeof binding.handler !== "object" || Array.isArray(binding.handler)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding handler must be an object", {
      toolRef,
    });
  }
  if (binding.handler.kind !== "process") {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "handler.kind must be process", {
      toolRef,
      actual: binding.handler.kind,
    });
  }
  if (typeof binding.handler.command !== "string" || binding.handler.command.trim() === "") {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "handler.command is required", {
      toolRef,
    });
  }
  if (!Array.isArray(binding.handler.args)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "handler.args must be an array", {
      toolRef,
    });
  }
  for (const argument of binding.handler.args) {
    if (typeof argument !== "string") {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "handler.args must contain strings", {
        toolRef,
      });
    }
  }
  if (binding.handler.cwd !== undefined && typeof binding.handler.cwd !== "string") {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "handler.cwd must be a string", {
      toolRef,
    });
  }
  if (!Array.isArray(binding.grants)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding grants must be an array", {
      toolRef,
    });
  }
  if (binding.secrets !== undefined && !Array.isArray(binding.secrets)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding secrets must be an array", {
      toolRef,
    });
  }
  if (binding.memories !== undefined && !Array.isArray(binding.memories)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding memories must be an array", {
      toolRef,
    });
  }
  const sandbox = normalizeManifestBindingSandbox(toolRef, binding.sandbox);
  assertPositiveInteger(binding.timeout_ms, "timeout_ms", toolRef);
  assertPositiveInteger(binding.max_payload_bytes, "max_payload_bytes", toolRef);

  const grants = normalizeStringArray(binding.grants, "grants", toolRef);
  const secrets = normalizeSecretHandleArray(binding.secrets ?? [], "secrets", toolRef);
  const memories = normalizeManifestMemories(binding.memories ?? [], toolRef);
  const payloadConstraints = normalizePayloadConstraints(binding.payload_constraints, toolRef);
  return Object.freeze({
    toolRef,
    handler: Object.freeze({
      kind: binding.handler.kind,
      command: binding.handler.command,
      args: Object.freeze([...binding.handler.args]),
      cwd: binding.handler.cwd,
    }),
    sandbox,
    grants: Object.freeze(grants),
    grantSet: new Set(grants),
    secrets: Object.freeze(secrets),
    secretSet: new Set(secrets),
    memories: Object.freeze(memories),
    memorySet: new Set(memories.map((memory) => memoryAccessKey(memory.ref, memory.access))),
    limits: Object.freeze({
      timeout_ms: binding.timeout_ms,
      max_payload_bytes: binding.max_payload_bytes,
    }),
    payloadConstraints,
    effectContract,
  });
}

function normalizeManifestEffectContract(toolRef, binding, manifestVersion) {
  const hasContract = Object.hasOwn(binding, "effect_contract");
  if (manifestVersion === TOOL_BINDING_MANIFEST_V1) {
    if (hasContract) {
      throw new ToubaRuntimeError(
        "InvalidToolBindingManifest",
        "effect_contract is forbidden in touba-manifest-v1",
        { toolRef },
      );
    }
    return null;
  }
  if (!hasContract) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "effect_contract is required for every explicit-effect manifest binding",
      { toolRef },
    );
  }
  const contract = binding.effect_contract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "effect_contract must be an object",
      { toolRef },
    );
  }
  const allowedFields = new Set(["kind", "retry_mode", "compensation"]);
  const unknownFields = Object.keys(contract).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "effect_contract contains unknown fields",
      { toolRef, unknownFields: unknownFields.sort() },
    );
  }
  if (contract.kind === "none") {
    if (Object.hasOwn(contract, "retry_mode")) {
      throw new ToubaRuntimeError(
        "InvalidToolBindingManifest",
        "effect_contract.retry_mode is forbidden when kind is none",
        { toolRef },
      );
    }
    if (Object.hasOwn(contract, "compensation")) {
      throw new ToubaRuntimeError(
        "InvalidToolBindingManifest",
        "effect_contract.compensation is forbidden when kind is none",
        { toolRef },
      );
    }
    return Object.freeze({ kind: "none" });
  }
  if (contract.kind !== "external_write") {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "effect_contract.kind is unsupported",
      { toolRef, actual: contract.kind },
    );
  }
  const retryModes = new Set(["idempotency_key", "reconcile", "none"]);
  if (!retryModes.has(contract.retry_mode)) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "effect_contract.retry_mode is required and must be idempotency_key, reconcile or none",
      { toolRef, actual: contract.retry_mode },
    );
  }
  const compensation = normalizeManifestCompensation(
    toolRef,
    contract.compensation,
    manifestVersion,
  );
  return Object.freeze({
    kind: "external_write",
    retryMode: contract.retry_mode,
    ...(compensation === null ? {} : { compensation }),
  });
}

function normalizeManifestCompensation(toolRef, value, manifestVersion) {
  if (value === undefined) return null;
  if (manifestVersion !== TOOL_BINDING_MANIFEST_V3) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "effect_contract.compensation requires touba-manifest-v3",
      { toolRef },
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "effect_contract.compensation must be an object",
      { toolRef },
    );
  }
  if (Object.keys(value).some((field) => field !== "entry_ref")) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "effect_contract.compensation contains unknown fields",
      { toolRef },
    );
  }
  if (
    typeof value.entry_ref !== "string"
    || value.entry_ref.length > 256
    || !COMPENSATION_ENTRY_REF_PATTERN.test(value.entry_ref)
  ) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "effect_contract.compensation.entry_ref is invalid",
      { toolRef },
    );
  }
  return Object.freeze({ entryRef: value.entry_ref });
}

function normalizeManifestBindingSandbox(toolRef, sandbox) {
  if (sandbox === undefined) {
    return Object.freeze({
      required: false,
      profile: "default",
      box_name: "ToubaHandler",
    });
  }
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding sandbox must be an object", {
      toolRef,
    });
  }
  const allowed = new Set(["required", "profile", "box_name"]);
  for (const key of Object.keys(sandbox)) {
    if (!allowed.has(key)) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding sandbox contains unknown fields", {
        toolRef,
        field: key,
      });
    }
  }
  if (sandbox.required !== undefined && typeof sandbox.required !== "boolean") {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding sandbox.required must be boolean", {
      toolRef,
    });
  }
  if (sandbox.profile !== undefined && (typeof sandbox.profile !== "string" || sandbox.profile.trim() === "")) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding sandbox.profile must be a non-empty string", {
      toolRef,
    });
  }
  if (sandbox.box_name !== undefined && (typeof sandbox.box_name !== "string" || sandbox.box_name.trim() === "")) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "binding sandbox.box_name must be a non-empty string", {
      toolRef,
    });
  }
  return Object.freeze({
    required: sandbox.required === true,
    profile: sandbox.profile ?? "default",
    box_name: sandbox.box_name ?? "ToubaHandler",
  });
}

function normalizePayloadConstraints(payloadConstraints, toolRef) {
  if (payloadConstraints === undefined) {
    return Object.freeze({
      input: Object.freeze([]),
      output: Object.freeze([]),
    });
  }
  if (!payloadConstraints || typeof payloadConstraints !== "object" || Array.isArray(payloadConstraints)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload_constraints must be an object", {
      toolRef,
    });
  }
  return Object.freeze({
    input: Object.freeze(normalizePayloadConstraintDirection(payloadConstraints.input, toolRef, "input")),
    output: Object.freeze(normalizePayloadConstraintDirection(payloadConstraints.output, toolRef, "output")),
  });
}

function normalizePayloadConstraintDirection(constraints, toolRef, direction) {
  if (constraints === undefined) {
    return [];
  }
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", `payload_constraints.${direction} must be an object`, {
      toolRef,
    });
  }

  return Object.entries(constraints).map(([path, constraint]) => {
    if (typeof path !== "string" || !PAYLOAD_CONSTRAINT_PATH_PATTERN.test(path)) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload constraint path is invalid", {
        toolRef,
        direction,
        path,
      });
    }
    if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload constraint entry must be an object", {
        toolRef,
        direction,
        path,
      });
    }

    const unknownOperators = Object.keys(constraint).filter((operator) => !PAYLOAD_CONSTRAINT_OPERATORS.has(operator));
    if (unknownOperators.length > 0) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload constraint contains unknown operators", {
        toolRef,
        direction,
        path,
        unknownOperators,
      });
    }
    if (Object.keys(constraint).length === 0) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload constraint entry must contain an operator", {
        toolRef,
        direction,
        path,
      });
    }

    const normalized = {
      path,
      segments: Object.freeze(path === "$" ? [] : path.split(".")),
    };
    if (constraint.non_empty !== undefined) {
      if (typeof constraint.non_empty !== "boolean") {
        throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload constraint non_empty must be boolean", {
          toolRef,
          direction,
          path,
        });
      }
      normalized.non_empty = constraint.non_empty;
    }
    if (constraint.max_length !== undefined) {
      assertPositiveInteger(constraint.max_length, "payload_constraints.max_length", toolRef);
      normalized.max_length = constraint.max_length;
    }
    if (constraint.min !== undefined) {
      assertFiniteNumber(constraint.min, "payload_constraints.min", toolRef);
      normalized.min = constraint.min;
    }
    if (constraint.max !== undefined) {
      assertFiniteNumber(constraint.max, "payload_constraints.max", toolRef);
      normalized.max = constraint.max;
    }
    if (constraint.allowed_values !== undefined) {
      normalized.allowed_values = Object.freeze(
        normalizePayloadAllowedValues(constraint.allowed_values, toolRef, direction, path),
      );
    }
    if (constraint.min_items !== undefined) {
      assertNonNegativeInteger(constraint.min_items, "payload_constraints.min_items", toolRef);
      normalized.min_items = constraint.min_items;
    }
    if (constraint.max_items !== undefined) {
      assertNonNegativeInteger(constraint.max_items, "payload_constraints.max_items", toolRef);
      normalized.max_items = constraint.max_items;
    }
    if (normalized.min !== undefined && normalized.max !== undefined && normalized.min > normalized.max) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload constraint min must not exceed max", {
        toolRef,
        direction,
        path,
      });
    }
    if (
      normalized.min_items !== undefined
      && normalized.max_items !== undefined
      && normalized.min_items > normalized.max_items
    ) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload constraint min_items must not exceed max_items", {
        toolRef,
        direction,
        path,
      });
    }
    return Object.freeze(normalized);
  });
}

function normalizePayloadAllowedValues(values, toolRef, direction, path) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload constraint allowed_values must be a non-empty array", {
      toolRef,
      direction,
      path,
    });
  }
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    if (!isPortablePayloadConstraintScalar(value)) {
      throw new ToubaRuntimeError(
        "InvalidToolBindingManifest",
        "payload constraint allowed_values must contain only Text, Boolean, Int or Float JSON scalars",
        {
          toolRef,
          direction,
          path,
        },
      );
    }
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) {
      throw new ToubaRuntimeError("InvalidToolBindingManifest", "payload constraint allowed_values must not contain duplicates", {
        toolRef,
        direction,
        path,
      });
    }
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

function normalizeAgentSecretScopes(scopes) {
  if (scopes === undefined) {
    return new Map();
  }
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      "agent_secret_scopes must be an object",
    );
  }
  const normalized = new Map();
  for (const [agentRef, secrets] of Object.entries(scopes)) {
    if (!agentRef.startsWith("agent:")) {
      throw new ToubaRuntimeError(
        "InvalidToolBindingManifest",
        "agent_secret_scopes keys must be agent refs",
        { agentRef },
      );
    }
    normalized.set(agentRef, new Set(normalizeSecretHandleArray(secrets, "agent_secret_scopes", agentRef)));
  }
  return normalized;
}

function normalizeOptionalSecretStore(secretStore) {
  if (secretStore === undefined || secretStore === null) {
    return null;
  }
  if (secretStore?.__toubaSecretStore === true) {
    return secretStore;
  }
  return normalizeSecretStore(secretStore);
}

function normalizeOptionalResourceBindings(resourceBindings) {
  if (resourceBindings === undefined || resourceBindings === null) {
    return null;
  }
  if (resourceBindings?.__toubaResourceBindings === true) {
    return resourceBindings;
  }
  return normalizeResourceBindings(resourceBindings);
}

function normalizeResourceBindings(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ToubaRuntimeError("InvalidResourceBindings", "resource bindings must be an object");
  }
  if (document.resource_bindings_schema_version !== RESOURCE_BINDINGS_SCHEMA_VERSION) {
    throw new ToubaRuntimeError(
      "InvalidResourceBindings",
      `resource_bindings_schema_version must be ${RESOURCE_BINDINGS_SCHEMA_VERSION}`,
      { actual: document.resource_bindings_schema_version },
    );
  }
  const forbiddenField = findForbiddenResourceBindingPayloadField(document);
  if (forbiddenField !== null) {
    throw new ToubaRuntimeError(
      "InvalidResourceBindings",
      `resource binding cannot contain payload or secret value field ${forbiddenField}`,
      { field: forbiddenField },
    );
  }
  if (!document.resources || typeof document.resources !== "object" || Array.isArray(document.resources)) {
    throw new ToubaRuntimeError("InvalidResourceBindings", "resource bindings resources must be an object");
  }

  const bindings = new Map();
  for (const [resourceRef, binding] of Object.entries(document.resources)) {
    if (binding?.active === false) {
      continue;
    }
    bindings.set(resourceRef, normalizeResourceBindingEntry(resourceRef, binding));
  }

  return Object.freeze({
    __toubaResourceBindings: true,
    bindings,
  });
}

function normalizeResourceBindingEntry(resourceRef, binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new ToubaRuntimeError("InvalidResourceBindings", `resource binding ${resourceRef} must be an object`, {
      resourceRef,
    });
  }
  if (typeof binding.kind !== "string" || binding.kind.trim() === "") {
    throw new ToubaRuntimeError("InvalidResourceBindings", `resource binding ${resourceRef} kind must be a non-empty string`, {
      resourceRef,
    });
  }
  if (typeof binding.provider !== "string" || binding.provider.trim() === "") {
    throw new ToubaRuntimeError("InvalidResourceBindings", `resource binding ${resourceRef} provider must be a non-empty string`, {
      resourceRef,
    });
  }
  return Object.freeze({
    resourceRef,
    kind: binding.kind,
    provider: binding.provider,
    grants: Object.freeze(normalizeStringArray(binding.grants ?? [], "resource_binding.grants", resourceRef)),
    secrets: Object.freeze(normalizeSecretHandleArray(binding.secrets ?? [], "resource_binding.secrets", resourceRef)),
    requiredSecrets: Object.freeze(
      normalizeSecretHandleArray(binding.required_secrets ?? [], "resource_binding.required_secrets", resourceRef),
    ),
    config: normalizeResourceBindingConfig(binding.config, resourceRef),
    limits: normalizeResourceBindingLimits(binding.limits, resourceRef),
  });
}

function normalizeResourceBindingConfig(config, resourceRef) {
  if (config === undefined) {
    return undefined;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ToubaRuntimeError("InvalidResourceBindings", `resource binding ${resourceRef} config must be an object`, {
      resourceRef,
    });
  }
  return Object.freeze(structuredClone(config));
}

function normalizeResourceBindingLimits(limits, resourceRef) {
  if (limits === undefined) {
    return undefined;
  }
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new ToubaRuntimeError("InvalidResourceBindings", `resource binding ${resourceRef} limits must be an object`, {
      resourceRef,
    });
  }
  const normalized = {};
  if (limits.max_payload_bytes !== undefined) {
    assertPositiveInteger(limits.max_payload_bytes, "resource_binding.limits.max_payload_bytes", resourceRef);
    normalized.max_payload_bytes = limits.max_payload_bytes;
  }
  return Object.freeze(normalized);
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

function normalizeSecretStore(document, options = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ToubaRuntimeError("InvalidSecretsFile", "secrets file must be an object");
  }
  if (document.secrets_version !== TOUBA_SECRETS_VERSION) {
    throw new ToubaRuntimeError(
      "InvalidSecretsFile",
      `secrets_version must be ${TOUBA_SECRETS_VERSION}`,
      { actual: document.secrets_version },
    );
  }
  if (!document.secrets || typeof document.secrets !== "object" || Array.isArray(document.secrets)) {
    throw new ToubaRuntimeError("InvalidSecretsFile", "secrets must be an object");
  }

  const env = options.env ?? process.env;
  const baseDir = options.baseDir ?? process.cwd();
  const readTextFile = options.readTextFile ?? ((path) => readFileSync(path, "utf8"));
  const fileExists = options.fileExists ?? ((path) => existsSync(path));
  const records = new Map();
  const resolved = new Map();
  const dotenvCache = new Map();
  const toubaStoreCache = new Map();
  for (const [handle, record] of Object.entries(document.secrets)) {
    assertSecretHandle(handle, "secrets", handle, "InvalidSecretsFile");
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new ToubaRuntimeError("InvalidSecretsFile", "secret record must be an object", {
        secretHandle: handle,
      });
    }
    const source = normalizeSecretSource(record.source, handle);
    const name = normalizeSecretRecordName(record.name, source, handle);
    const status = normalizeSecretRecordStatus(record.status, handle);
    const expiresAt = normalizeSecretRecordExpiresAt(record.expires_at, handle);
    const normalizedRecord = {
      source,
      name,
      status,
      expires_at: expiresAt?.value,
      expires_at_ms: expiresAt?.ms,
    };
    if (source === "env") {
      records.set(handle, Object.freeze(normalizedRecord));
      if (Object.hasOwn(env, name) && env[name] !== undefined) {
        resolved.set(handle, String(env[name]));
      }
      continue;
    }

    const sourcePath = normalizeSecretRecordPath(record.path, source, handle, baseDir);
    normalizedRecord.path = sourcePath;
    records.set(handle, Object.freeze(normalizedRecord));
    if (!fileExists(sourcePath)) {
      continue;
    }

    if (source === "dotenv") {
      let dotenvEntries = dotenvCache.get(sourcePath);
      if (!dotenvEntries) {
        dotenvEntries = parseDotenvFile(readTextFile(sourcePath), sourcePath);
        dotenvCache.set(sourcePath, dotenvEntries);
      }
      if (dotenvEntries.has(name)) {
        resolved.set(handle, dotenvEntries.get(name));
      }
      continue;
    }

    let toubaStore = toubaStoreCache.get(sourcePath);
    if (!toubaStore) {
      toubaStore = parseToubaLocalSecretStore(readTextFile(sourcePath), sourcePath);
      toubaStoreCache.set(sourcePath, toubaStore);
    }
    if (toubaStore.has(name)) {
      resolved.set(handle, toubaStore.get(name));
    }
  }

  return Object.freeze({
    __toubaSecretStore: true,
    version: document.secrets_version,
    records,
    has(handle, nowMs = Date.now()) {
      return secretRecordRefusal(records.get(handle), resolved, handle, nowMs) === null;
    },
    valueFor(handle) {
      return resolved.get(handle);
    },
    refusalFor(handle, nowMs = Date.now()) {
      return secretRecordRefusal(records.get(handle), resolved, handle, nowMs);
    },
    resolvedSecretEntries() {
      return [...resolved.entries()].map(([handle, value]) => ({ handle, value }));
    },
  });
}

function secretRecordRefusal(record, resolved, handle, nowMs) {
  if (!record) {
    return { code: "SecretNotResolved", reason: "profile_missing" };
  }
  if (record.status === "revoked") {
    return { code: "SecretHandleRevoked", reason: "revoked" };
  }
  if (record.expires_at_ms !== undefined && nowMs >= record.expires_at_ms) {
    return { code: "SecretHandleExpired", reason: "expired" };
  }
  if (!resolved.has(handle)) {
    return { code: "SecretNotResolved", reason: "unresolved" };
  }
  return null;
}

function normalizeSecretSource(source, handle) {
  if (!["env", "dotenv", "touba_store"].includes(source)) {
    throw new ToubaRuntimeError(
      "InvalidSecretsFile",
      "secret source must be one of: env, dotenv, touba_store",
      { secretHandle: handle, source },
    );
  }
  return source;
}

function normalizeSecretRecordStatus(status, handle) {
  if (status === undefined) {
    return "active";
  }
  if (typeof status !== "string" || !SECRET_RECORD_STATUS_VALUES.has(status)) {
    throw new ToubaRuntimeError("InvalidSecretsFile", "secret status must be active or revoked", {
      secretHandle: handle,
      status,
    });
  }
  return status;
}

function normalizeSecretRecordExpiresAt(expiresAt, handle) {
  if (expiresAt === undefined) {
    return undefined;
  }
  if (typeof expiresAt !== "string" || expiresAt.trim() === "") {
    throw new ToubaRuntimeError("InvalidSecretsFile", "secret expires_at must be a non-empty string", {
      secretHandle: handle,
    });
  }
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) {
    throw new ToubaRuntimeError("InvalidSecretsFile", "secret expires_at must be parseable as an instant", {
      secretHandle: handle,
    });
  }
  return { value: expiresAt, ms };
}

function normalizeSecretRecordName(name, source, handle) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ToubaRuntimeError("InvalidSecretsFile", `${source} secret name is required`, {
      secretHandle: handle,
    });
  }
  const trimmed = name.trim();
  if ((source === "dotenv" || source === "env") && !DOTENV_NAME_PATTERN.test(trimmed)) {
    throw new ToubaRuntimeError("InvalidSecretsFile", `${source} secret name is invalid`, {
      secretHandle: handle,
      name: trimmed,
    });
  }
  return trimmed;
}

function normalizeSecretRecordPath(path, source, handle, baseDir) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new ToubaRuntimeError("InvalidSecretsFile", `${source} secret path is required`, {
      secretHandle: handle,
    });
  }
  const trimmed = path.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(baseDir, trimmed);
}

function parseDotenvFile(raw, path) {
  const entries = new Map();
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const originalLine = lines[index];
    const line = originalLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) {
      throw new ToubaRuntimeError("InvalidSecretsFile", "dotenv line must use KEY=value", {
        path,
        line: index + 1,
      });
    }
    const name = withoutExport.slice(0, separator).trim();
    if (!DOTENV_NAME_PATTERN.test(name)) {
      throw new ToubaRuntimeError("InvalidSecretsFile", "dotenv key is invalid", {
        path,
        line: index + 1,
        name,
      });
    }
    entries.set(name, parseDotenvValue(withoutExport.slice(separator + 1).trim()));
  }
  return entries;
}

function parseDotenvValue(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll("\\t", "\t")
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const commentIndex = value.search(/\s#/u);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

function parseToubaLocalSecretStore(raw, path) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new ToubaRuntimeError("InvalidSecretsFile", "touba_store JSON is invalid", {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ToubaRuntimeError("InvalidSecretsFile", "touba_store must be an object", { path });
  }
  if (document.store_version !== TOUBA_LOCAL_SECRET_STORE_VERSION) {
    throw new ToubaRuntimeError(
      "InvalidSecretsFile",
      `touba_store store_version must be ${TOUBA_LOCAL_SECRET_STORE_VERSION}`,
      { path, actual: document.store_version },
    );
  }
  if (!document.secrets || typeof document.secrets !== "object" || Array.isArray(document.secrets)) {
    throw new ToubaRuntimeError("InvalidSecretsFile", "touba_store secrets must be an object", {
      path,
    });
  }
  const entries = new Map();
  for (const [name, value] of Object.entries(document.secrets)) {
    if (!SECRET_HANDLE_PATTERN.test(name)) {
      throw new ToubaRuntimeError("InvalidSecretsFile", "touba_store key is invalid", {
        path,
        name,
      });
    }
    if (typeof value !== "string") {
      throw new ToubaRuntimeError("InvalidSecretsFile", "touba_store values must be strings", {
        path,
        name,
      });
    }
    entries.set(name, value);
  }
  return entries;
}

function bindingPublicView(binding) {
  return {
    grants: [...binding.grants],
    memories: manifestMemoriesForTrace(binding.memories),
    secretHandles: [...binding.secrets],
    limits: { ...binding.limits },
    payloadConstraints: payloadConstraintsForTrace(binding.payloadConstraints),
    handler: { ...binding.handler },
    ...(binding.effectContract
      ? {
        effectContract: {
          ...binding.effectContract,
          ...(binding.effectContract.compensation
            ? { compensation: { ...binding.effectContract.compensation } }
            : {}),
        },
      }
      : {}),
  };
}

function assertPositiveInteger(value, fieldName, toolRef) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      `${fieldName} must be a positive integer`,
      { toolRef, fieldName },
    );
  }
}

function assertNonNegativeInteger(value, fieldName, toolRef) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      `${fieldName} must be a non-negative integer`,
      { toolRef, fieldName },
    );
  }
}

function assertFiniteNumber(value, fieldName, toolRef) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      `${fieldName} must be a finite number`,
      { toolRef, fieldName },
    );
  }
}

function normalizeStringArray(values, fieldName, ref) {
  return values.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ToubaRuntimeError(
        "InvalidToolBindingManifest",
        `${fieldName} must contain non-empty strings`,
        { ref },
      );
    }
    return value;
  });
}

function normalizeManifestMemories(memories, toolRef) {
  return memories.map((memory) => {
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
      throw new ToubaRuntimeError(
        "InvalidToolBindingManifest",
        "memories entries must be objects",
        { toolRef },
      );
    }
    if (typeof memory.ref !== "string" || !memory.ref.startsWith("memory:")) {
      throw new ToubaRuntimeError(
        "InvalidToolBindingManifest",
        "memories entries must contain a memory ref",
        { toolRef, memoryRef: memory.ref },
      );
    }
    if (!MEMORY_ACCESS_VALUES.has(memory.access)) {
      throw new ToubaRuntimeError(
        "InvalidToolBindingManifest",
        "memories entries must use access read or write",
        { toolRef, memoryRef: memory.ref, access: memory.access },
      );
    }
    return Object.freeze({
      ref: memory.ref,
      access: memory.access,
    });
  });
}

function normalizeSecretHandleArray(values, fieldName, ref) {
  if (!Array.isArray(values)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", `${fieldName} must be an array`, {
      ref,
    });
  }
  return values.map((value) => {
    assertSecretHandle(value, fieldName, ref, "InvalidToolBindingManifest");
    return value;
  });
}

function assertSecretHandle(value, fieldName, ref, code) {
  if (typeof value !== "string" || !SECRET_HANDLE_PATTERN.test(value)) {
    throw new ToubaRuntimeError(code, `${fieldName} contains invalid secret handle`, {
      ref,
      secretHandle: value,
    });
  }
}

async function executeGraph(graphRef, context, options = {}) {
  const durable = context.executionDurability.enabled;
  // A loop cursor belongs to this invocation, not to the declaration. In
  // particular an early return must not advance a later call to the same graph.
  const callerLoopState = context.loopState;
  context.loopState = options.loopState ?? new Map();
  try {
    return await executeGraphTraversal(
      graphRef,
      context,
      {
        requireGraph: (ref) => requireDefinition(context.indexes.graphs, ref),
        isDispatchNode,
        assertRunCanContinue,
        consumeStepBudget,
        airRefForNode,
        executeNode,
        nextNodeId,
        ...(durable
          ? {
            beforeNode: beforeDurableNode,
            afterNode: afterDurableNode,
          }
          : {}),
      },
      options,
    );
  } finally {
    context.loopState = callerLoopState;
  }
}

async function beforeDurableNode(graph, node, context) {
  const durable = context.executionDurability;
  if (durable.graphRef !== graph.id || durable.cursor?.node_id !== node.id) {
    throw new RuntimeFailure(
      "durable execution cursor diverged from graph traversal",
      { graphRef: graph.id, nodeId: node.id, cursorNodeId: durable.cursor?.node_id },
      "DurableResumeCheckpointIncompatible",
    );
  }
  assertRunCanContinue(context);
  if (durable.cursor.phase === "ready") {
    consumeStepBudget(context, {
      airRef: airRefForNode(graph, node),
      targetRef: node.target_ref,
    });
    durable.cursor = { node_id: node.id, phase: "started" };
    await persistDurableExecutionCheckpoint(context);
    return;
  }
  if (durable.cursor.phase !== "started") {
    throw new RuntimeFailure(
      "durable execution cursor phase cannot execute a node",
      { graphRef: graph.id, nodeId: node.id, phase: durable.cursor.phase },
      "DurableResumeCheckpointIncompatible",
    );
  }
}

async function afterDurableNode(graph, node, context, step, nextNode) {
  const durable = context.executionDurability;
  if (step.done) {
    // The host commits the terminal result atomically with its operation
    // record. Keeping the last durable cursor on the already-consumed pure
    // terminal node lets a crash before that commit reconstruct give/stop
    // without a handler dispatch or a second step consumption.
    return;
  }
  durable.pendingDispatch = null;
  durable.pendingReservedElapsedMs = null;
  durable.pendingReservationRetained = false;
  durable.cursor = { node_id: nextNode, phase: "ready" };
  await persistDurableExecutionCheckpoint(context);
}

async function persistDurableExecutionCheckpoint(context, options = {}) {
  const durable = context.executionDurability;
  if (!durable.enabled) return null;
  const traceDocument = context.trace.document();
  let prefixDigest = durable.tracePrefixDigest;
  if (traceDocument.events.length > durable.traceEventOffset || prefixDigest === null) {
    prefixDigest = tracePrefixDigest(
      durable.tracePrefixDigest,
      traceDocument,
      durable.traceEventOffset,
    );
  }
  const activeElapsedMs = options.activeElapsedMs
    ?? activeElapsedMilliseconds(context);
  const checkpoint = sealExecutionCheckpoint({
    checkpoint_schema_version: EXECUTION_CHECKPOINT_VERSION,
    revision: durable.revision + 1,
    previous_checkpoint_digest: durable.previousCheckpointDigest,
    operation_id: durable.operationId,
    run_id: durable.runId,
    effect_scope_id: durable.effectScopeId,
    entry_ref: context.entryRef,
    module_ref: context.trace.airDocument.module.id,
    graph_ref: durable.graphRef,
    compatibility: durable.compatibility,
    cursor: durable.cursor,
    runtime_state: {
      values: checkpointObjectFromMap(context.values, "runtime_state.values"),
      value_types: checkpointObjectFromMap(context.valueTypes, "runtime_state.value_types"),
      input_keys: [...context.inputValueKeys].sort(),
      budget_counters: {
        steps: context.budgetState.counters.steps,
        tool_calls: context.budgetState.counters.toolCalls,
        agent_invocations: context.budgetState.counters.agentInvocations,
        provider_calls: context.budgetState.counters.providerCalls,
      },
      effective_limits: Object.fromEntries([...context.budgetState.effectiveLimits.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, limit]) => [kind, limit.value])),
      active_elapsed_ms: Math.ceil(activeElapsedMs),
      next_call_index: context.nextCallIndex,
      next_effect_index: context.effectState.nextEffectIndex,
      external_tool_dispatches: context.effectState.externalToolDispatches,
    },
    pending_dispatch: durable.pendingDispatch,
    decisions_consumed: durable.decisionsConsumed,
    trace_state: {
      prefix_digest: prefixDigest,
      next_sequence_index: context.trace.nextSequenceIndex(),
    },
  });
  assertExecutionCheckpointHasNoResolvedSecret(
    checkpoint,
    secretValuesForRedaction(context.secretStore),
  );
  await durable.observer({
    checkpoint: structuredClone(checkpoint),
    trace: structuredClone(traceDocument),
  });
  durable.revision = checkpoint.revision;
  durable.previousCheckpointDigest = checkpoint.checkpoint_digest;
  durable.tracePrefixDigest = prefixDigest;
  durable.traceEventOffset = traceDocument.events.length;
  durable.lastCheckpoint = checkpoint;
  return checkpoint;
}

function activeElapsedMilliseconds(context) {
  return context.runState.activeElapsedBaseMs
    + Math.max(0, context.runState.now() - context.runState.startedAtMs);
}

async function executeNode(graph, node, context) {
  switch (node.kind) {
    case "call_function":
    case "call_tool":
    case "call_skill":
    case "call_agent":
      return executeCallNode(graph, node, context);
    case "bind":
      return executeBindNode(graph, node, context);
    case "human_approval":
      return executeHumanApprovalNode(graph, node, context);
    case "user_interaction":
      return executeUserInteractionNode(graph, node, context);
    case "branch":
      return executeBranchNode(graph, node, context);
    case "loop":
      return executeLoopNode(graph, node, context);
    case "give":
      return {
        done: true,
        status: "success",
        result: node.arguments?.length ? resolveHandle(node.arguments[0], context, graph) : undefined,
      };
    case "stop":
      return {
        done: true,
        status: "stopped",
      };
    case "fallback":
      return {
        edgeRole: "next",
        result: await executeTarget(requiredTarget(node), context),
      };
    default:
      throw new RuntimeFailure(`unsupported AIR node kind ${node.kind}`, {
        graphRef: graph.id,
        nodeId: node.id,
      });
  }
}

function executeBindNode(graph, node, context) {
  const valueRef = node.arguments?.[0];
  if (!valueRef || !node.result_binding) {
    throw new RuntimeFailure(`bind node ${node.id} is incomplete`, {
      graphRef: graph.id,
      nodeId: node.id,
    }, "InvalidBindNode");
  }
  const value = resolveHandle(valueRef, context, graph);
  const bindingHandle = valueHandle(node.result_binding);
  context.values.set(bindingHandle, value);
  const bindingType = resolveHandleType(valueRef, context, graph);
  if (bindingType) {
    context.valueTypes.set(bindingHandle, bindingType);
  }
  context.trace.push("binding_created", {
    airRef: airRefForNode(graph, node),
    payload: compactPayload({
      binding: node.result_binding,
      value_ref: valueRef,
      caller_ref: graph.owner_ref,
      agent_ref: context.activeAgentRef,
    }),
  });
  return {
    edgeRole: successEdgeRole(graph, node.id),
    result: value,
  };
}

function executeHumanApprovalNode(graph, node, context) {
  const approvalRef = node.approval_ref ?? `approval:${graph.id}:${node.id}`;
  const mode = requiredApprovalMode(node);
  const contextRefs = node.context_refs ?? [];
  const resumeTargetRef = nextNodeId(graph, node.id, successEdgeRole(graph, node.id));
  const basePayload = compactPayload({
    approval_ref: approvalRef,
    mode,
    context_refs: contextRefs,
    caller_ref: graph.owner_ref,
    agent_ref: context.activeAgentRef,
    requester_ref: mode === "agent_review" ? context.activeAgentRef ?? graph.owner_ref : undefined,
    required_by_ref: mode === "required_approval" ? graph.owner_ref : undefined,
  });

  context.trace.push("human_approval_requested", {
    airRef: airRefForNode(graph, node),
    payload: basePayload,
  });

  const decision = context.humanApprovalDecisions.get(approvalRef);
  if (!decision) {
    const pausePayload = compactPayload({
      ...basePayload,
      resume_target_ref: resumeTargetRef,
    });
    const durableResumeAvailable = canCreateHumanApprovalCheckpoint(context, graph);
    assertHumanApprovalCanPause(context, pausePayload, airRefForNode(graph, node), {
      durableResumeAvailable,
    });
    if (durableResumeAvailable) {
      createHumanApprovalCheckpoint(context, graph, node, pausePayload);
    }
    context.trace.push("human_approval_paused", {
      airRef: airRefForNode(graph, node),
      payload: pausePayload,
    });
    if (context.runState.cancelOnPause) {
      requestRunCancel(context, {
        authoritySource: "host",
        reason: "cancel_requested",
        scope: context.runState.killSwitchScope,
      });
      throw new RuntimeCancelled("human approval cancelled while paused", {
        approvalRef,
        authoritySource: "host",
        reason: "cancel_requested",
      });
    }
    return {
      done: true,
      status: "stopped",
    };
  }
  context.trace.push("human_approval_paused", {
    airRef: airRefForNode(graph, node),
    payload: compactPayload({
      ...basePayload,
      resume_target_ref: resumeTargetRef,
    }),
  });
  const transition = classifyHumanApprovalDecision(decision);
  if (!transition.valid) {
    const error = new RuntimeFailure(
      `invalid human approval decision ${decision} for ${approvalRef}`,
      { approvalRef, decision },
      "InvalidHumanApprovalDecision",
    );
    traceHumanApprovalFailure(graph, node, context, error);
    throw error;
  }

  if (context.executionDurability.enabled) {
    const decisionDigest = canonicalDigest({ decision_ref: approvalRef, result: decision });
    const previous = context.executionDurability.decisionsConsumed
      .find((item) => item.decision_ref === approvalRef);
    if (previous && (previous.result !== decision || previous.decision_digest !== decisionDigest)) {
      throw new RuntimeFailure(
        "human decision changed during durable execution",
        { decisionRef: approvalRef },
        "DurableResumeAuthorityRefused",
      );
    }
    if (!previous) {
      context.executionDurability.decisionsConsumed.push({
        decision_ref: approvalRef,
        result: decision,
        decision_digest: decisionDigest,
      });
    }
  }

  if (!node.result_binding) {
    const error = new RuntimeFailure(
      `human approval node ${node.id} has no decision binding`,
      { approvalRef },
      "InvalidHumanApprovalNode",
    );
    traceHumanApprovalFailure(graph, node, context, error);
    throw error;
  }

  context.trace.push("human_approval_decided", {
    airRef: airRefForNode(graph, node),
    payload: {
      approval_ref: approvalRef,
      decision,
    },
  });

  if (transition.approved) {
    context.values.set(valueHandle(node.result_binding), decision);
    context.trace.push("human_approval_resumed", {
      airRef: airRefForNode(graph, node),
      payload: compactPayload({
        approval_ref: approvalRef,
        resume_target_ref: resumeTargetRef,
        decision_binding: node.result_binding,
      }),
    });
    return {
      edgeRole: successEdgeRole(graph, node.id),
      result: decision,
    };
  }

  context.trace.push(transition.terminalEvent, {
    airRef: airRefForNode(graph, node),
    payload: {
      approval_ref: approvalRef,
      decision,
    },
  });
  return {
    done: true,
    status: "stopped",
  };
}

function traceHumanApprovalFailure(graph, node, context, error) {
  context.trace.push("failure_detected", {
    airRef: airRefForNode(graph, node),
    payload: compactPayload({
      failure_mode: "human_approval",
      runtime_error_code: error.code,
      approval_ref: error.details?.approvalRef,
      caller_ref: graph.owner_ref,
      agent_ref: context.activeAgentRef,
    }),
    message: error.message,
  });
}

async function executeUserInteractionNode(graph, node, context) {
  const interactionRef = node.interaction_ref ?? `interaction:${graph.id}:${node.id}`;
  const mode = requiredUserInteractionMode(node);
  const argumentRef = (node.arguments ?? [])[0];
  if (!argumentRef) {
    const error = new RuntimeFailure(
      `user interaction node ${node.id} has no ${mode === "show" ? "message" : "prompt"} argument`,
      { interactionRef, mode },
      "InvalidUserInteractionNode",
    );
    traceUserInteractionFailure(graph, node, context, error);
    throw error;
  }

  const text = resolveTextInteractionArgument(argumentRef, graph, node, context, interactionRef, mode);
  try {
    assertNoSecretValueInUserInteraction(text, context, interactionRef, mode);
  } catch (error) {
    traceUserInteractionFailure(graph, node, context, error);
    throw error;
  }

  if (mode === "show") {
    context.trace.push("user_interaction_shown", {
      airRef: airRefForNode(graph, node),
      payload: compactPayload({
        interaction_ref: interactionRef,
        mode,
        message_ref: argumentRef,
        message: text,
        caller_ref: graph.owner_ref,
        agent_ref: context.activeAgentRef,
      }),
    });
    return {
      edgeRole: "next",
    };
  }

  if (mode !== "ask") {
    const error = new RuntimeFailure(
      `unsupported user interaction mode ${mode}`,
      { interactionRef, mode },
      "UnsupportedUserInteractionMode",
    );
    traceUserInteractionFailure(graph, node, context, error);
    throw error;
  }

  context.trace.push("user_interaction_requested", {
    airRef: airRefForNode(graph, node),
    payload: compactPayload({
      interaction_ref: interactionRef,
      mode,
      prompt_ref: argumentRef,
      prompt: text,
      caller_ref: graph.owner_ref,
      agent_ref: context.activeAgentRef,
    }),
  });
  context.trace.push("user_interaction_paused", {
    airRef: airRefForNode(graph, node),
    payload: compactPayload({
      interaction_ref: interactionRef,
      mode,
      prompt_ref: argumentRef,
      caller_ref: graph.owner_ref,
      agent_ref: context.activeAgentRef,
      resume_target_ref: nextNodeId(graph, node.id, "next"),
    }),
  });

  if (!context.userInputs.has(interactionRef) && context.userInputProvider) {
    let providedValue;
    try {
      providedValue = await context.userInputProvider({
        interactionRef,
        mode,
        prompt: text,
        promptRef: argumentRef,
        callerRef: graph.owner_ref,
        agentRef: context.activeAgentRef,
        airRef: airRefForNode(graph, node),
      });
    } catch (error) {
      const failure = new RuntimeFailure(
        `user input provider failed for ${interactionRef}: ${error instanceof Error ? error.message : String(error)}`,
        { interactionRef, mode },
        "UserInputProviderFailed",
      );
      traceUserInteractionFailure(graph, node, context, failure);
      throw failure;
    }
    if (providedValue !== undefined) {
      context.userInputs.set(interactionRef, providedValue);
    }
  }

  if (!context.userInputs.has(interactionRef)) {
    if (context.runState.cancelOnPause) {
      requestRunCancel(context, {
        authoritySource: "host",
        reason: "cancel_requested",
        scope: context.runState.killSwitchScope,
      });
      throw new RuntimeCancelled("user interaction cancelled while paused", {
        interactionRef,
        authoritySource: "host",
        reason: "cancel_requested",
      });
    }
    return {
      done: true,
      status: "stopped",
    };
  }
  if (!node.result_binding) {
    const error = new RuntimeFailure(
      `ask node ${node.id} has no result binding`,
      { interactionRef, mode },
      "InvalidUserInteractionNode",
    );
    traceUserInteractionFailure(graph, node, context, error);
    throw error;
  }

  const value = context.userInputs.get(interactionRef);
  if (typeof value !== "string") {
    const error = new RuntimeFailure(
      `ask input for ${interactionRef} must be Text`,
      { interactionRef, mode },
      "InvalidUserInput",
    );
    traceUserInteractionFailure(graph, node, context, error);
    throw error;
  }

  const bindingHandle = valueHandle(node.result_binding);
  context.values.set(bindingHandle, value);
  context.valueTypes.set(bindingHandle, BUILTIN_TEXT);
  context.trace.push("user_interaction_answered", {
    airRef: airRefForNode(graph, node),
    payload: compactPayload({
      interaction_ref: interactionRef,
      mode,
      result_binding: node.result_binding,
      caller_ref: graph.owner_ref,
      agent_ref: context.activeAgentRef,
    }),
  });

  return {
    edgeRole: "next",
    result: value,
  };
}

function resolveTextInteractionArgument(argumentRef, graph, node, context, interactionRef, mode) {
  const value = resolveHandle(argumentRef, context, graph);
  if (typeof value !== "string") {
    const error = new RuntimeFailure(
      `user interaction ${mode} argument must resolve to Text`,
      { interactionRef, mode },
      "InvalidUserInteractionArgument",
    );
    traceUserInteractionFailure(graph, node, context, error);
    throw error;
  }
  return value;
}

function assertNoSecretValueInUserInteraction(value, context, interactionRef, mode) {
  const leakedSecrets = resolvedSecretEntries(context.secretStore)
    .filter((entry) => entry.value.length > 0 && String(value).includes(entry.value));
  if (leakedSecrets.length === 0) {
    return;
  }
  throw new RuntimeFailure(
    `user interaction ${mode} contains a resolved secret value`,
    {
      interactionRef,
      mode,
      secretHandlesRefused: leakedSecrets.map((entry) => entry.handle),
    },
    "SecretValueInUserInteraction",
  );
}

function traceUserInteractionFailure(graph, node, context, error) {
  context.trace.push("failure_detected", {
    airRef: airRefForNode(graph, node),
    payload: compactPayload({
      failure_mode: "user_interaction",
      runtime_error_code: error.code,
      interaction_ref: error.details?.interactionRef,
      mode: error.details?.mode,
      caller_ref: graph.owner_ref,
      agent_ref: context.activeAgentRef,
      secret_handles_refused: error.details?.secretHandlesRefused,
    }),
    message: error.message,
  });
}

async function executeCallNode(graph, node, context) {
  const targetRef = requiredTarget(node);
  if (!context.executionDurability.enabled) {
    assertRunCanDispatch(context, { targetRef, airRef: airRefForNode(graph, node) });
    consumeStepBudget(context, {
      airRef: airRefForNode(graph, node),
      targetRef,
    });
  }
  const callArguments = resolveCallArguments(graph, node, context);
  context.trace.push("call_started", {
    airRef: airRefForNode(graph, node),
    payload: {
      target_ref: targetRef,
      caller_ref: graph.owner_ref,
      agent_ref: context.activeAgentRef,
      argument_count: callArguments?.length,
    },
  });

  try {
    if (node.kind === "call_agent") {
      authorizeAgentInvocation(graph, node, targetRef, context);
    }

    const previousCallerRef = context.activeCallerRef;
    const callFrame = callFrameForNode(graph, node, targetRef);
    context.activeCallerRef = graph.owner_ref;
    context.callStack.push(callFrame);
    let result;
    try {
      result = await executeTarget(targetRef, context, callArguments, {
        dispatchAlreadyChecked: true,
      });
    } finally {
      context.callStack.pop();
      context.activeCallerRef = previousCallerRef;
    }
    if (node.result_binding) {
      const bindingHandle = valueHandle(node.result_binding);
      context.values.set(bindingHandle, result);
      const outputType = targetOutputType(targetRef, context);
      if (outputType) {
        context.valueTypes.set(bindingHandle, outputType);
      }
    }
    context.trace.push("call_completed", {
      airRef: airRefForNode(graph, node),
      payload: compactPayload({
        target_ref: targetRef,
        caller_ref: graph.owner_ref,
        agent_ref: context.activeAgentRef,
        result_binding: node.result_binding,
        ...(context.compensation?.lastAttempt
          ? {
            compensation_id: context.compensation.config.envelope.compensation_id,
            compensates_effect_id:
              context.compensation.config.envelope.compensates_effect_id,
            inverse_effect_id: context.compensation.lastAttempt.inverseEffectId,
            attempt_index: context.compensation.lastAttempt.attemptIndex,
            result: context.compensation.lastAttempt.result,
          }
          : {}),
      }),
    });
    return {
      edgeRole: successEdgeRole(graph, node.id),
      result,
    };
  } catch (error) {
    if (!(error instanceof RuntimeFailure)) {
      throw error;
    }
    const declaredFailurePath = failurePathForNode(graph, node.id);
    const failureFamily = runtimeFailureFamily(error);
    const failurePath = declaredFailurePath?.failure_family === failureFamily
      ? declaredFailurePath
      : undefined;
    context.trace.push("failure_detected", {
      airRef: airRefForNode(graph, node),
      payload: compactPayload({
        failure_path_ref: declaredFailurePath?.id,
        failure_mode: failurePath?.mode ?? "unhandled_family",
        failure_family: failureFamily,
        declared_failure_family: declaredFailurePath?.failure_family,
        ...runtimeFailureTracePayload(error, {
          fallbackTargetRef: targetRef,
          callerRef: graph.owner_ref,
          agentRef: context.activeAgentRef,
          compensation: context.compensation,
        }),
      }),
      message: error.message,
    });
    if (!failurePath) {
      throw error;
    }
    if (failurePath.mode === "stop") {
      return {
        edgeRole: "failure",
      };
    }
    context.trace.push("fallback_selected", {
      airRef: {
        flow_graph_ref: graph.id,
        owner_ref: graph.owner_ref,
      },
      payload: {
        failure_path_ref: failurePath.id,
        target_node_id: failurePath.target_node_id,
      },
    });
    return {
      edgeRole: "fallback",
    };
  }
}

function isDispatchNode(node) {
  return ["call_function", "call_tool", "call_skill", "call_agent"].includes(node.kind);
}

function initializeRunControls(context) {
  initializeRuntimeRunControls(context, {
    initializeBudgetControls: () => initializeBudgetControls(context),
  });
}

function assertRunCanContinue(context) {
  assertRuntimeRunCanContinue(context, {
    observeRunTimeBudget: () => observeRunTimeBudget(context),
  });
}

function assertRunCanDispatch(context, details) {
  assertRuntimeRunCanDispatch(context, details, {
    observeRunTimeBudget: () => observeRunTimeBudget(context, details),
    consumeDispatchBudget: () => consumeDispatchBudget(context, details),
  });
}

function assertRunCanDispatchFinal(context, details) {
  assertRuntimeRunCanDispatch(context, details, {
    observeRunTimeBudget: () => {
      assertDurableBudgetCountersWithinLimits(context, {
        ...details,
        dispatch: true,
      });
      context.executionDurability.pendingReservedElapsedMs = durablePendingReservationElapsed(
        context,
        details,
      );
    },
    consumeDispatchBudget: () => {},
  });
}

function assertDurableBudgetCountersWithinLimits(context, details = {}) {
  for (const [budgetKind, counterName] of Object.entries(RUN_BUDGET_COUNTERS)) {
    const limit = context.budgetState.effectiveLimits.get(budgetKind);
    const consumedValue = context.budgetState.counters[counterName];
    if (!limit || consumedValue <= limit.value) continue;
    traceBudgetExceeded(context, budgetKind, limit, consumedValue, details);
    throw new RuntimeFailure(
      `${budgetKind} exceeded`,
      budgetFailureDetails(budgetKind, limit, consumedValue, details),
      RUN_BUDGET_ERROR_CODES[budgetKind] ?? "BudgetExceeded",
    );
  }
}

async function assertDurableToolCanSpawn(tool, reservedBinding, context) {
  assertRunCanDispatchFinal(context, { targetRef: tool.id });
  await assertDurableDispatchAuthority(tool, reservedBinding, context);
  assertRunCanDispatchFinal(context, { targetRef: tool.id });
  const currentBinding = validateToolBinding(tool, context, { traceAuthorizations: false });
  if (currentBinding !== reservedBinding) {
    throw new RuntimeFailure(
      "tool binding authority changed before durable handler spawn",
      { toolRef: tool.id },
      "DurableResumeAuthorityRefused",
    );
  }
}

async function assertDurableDispatchAuthority(tool, binding, context) {
  const provider = context.dispatchAuthorityProvider;
  if (provider === null) return;
  const durable = context.executionDurability;
  const pending = durable.pendingDispatch;
  const request = Object.freeze(compactPayload({
    operation_id: durable.operationId,
    run_id: durable.runId,
    effect_scope_id: durable.effectScopeId,
    entry_ref: context.entryRef,
    node_id: durable.cursor?.node_id,
    tool_ref: tool.id,
    call_id: pending?.call_id,
    effect_contract_kind: pending?.effect_contract_kind,
    effect_id: pending?.effect_id ?? undefined,
    attempt_index: pending?.attempt_index,
  }));
  const timeoutMs = context.dispatchAuthorityProviderTimeoutMs ?? binding.limits.timeout_ms;
  let authorized;
  try {
    authorized = await withDispatchAuthorityTimeout(
      Promise.resolve().then(() => provider(request)),
      timeoutMs,
    );
  } catch {
    throw new RuntimeFailure(
      "current host authority refused durable tool dispatch",
      { toolRef: tool.id },
      "DurableResumeAuthorityRefused",
    );
  }
  if (authorized !== true) {
    throw new RuntimeFailure(
      "current host authority refused durable tool dispatch",
      { toolRef: tool.id },
      "DurableResumeAuthorityRefused",
    );
  }
}

function withDispatchAuthorityTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("dispatch authority timeout"));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function initializeBudgetControls(context) {
  const state = context.budgetState;
  if (state.initialized) {
    return;
  }
  state.initialized = true;

  for (const limit of state.effectiveLimits.values()) {
    context.trace.push("budget_limit_checked", {
      payload: budgetLimitPayload(limit),
    });
  }

  if (state.manifestWideningErrors.length > 0) {
    const error = state.manifestWideningErrors[0];
    context.trace.push("budget_limit_exceeded", {
      payload: compactPayload({
        budget_kind: error.budgetKind,
        limit_value: error.airValue,
        attempted_value: error.manifestValue,
        authority_source: "manifest",
        reason: "manifest_limit_exceeds_air",
      }),
    });
    throw new RuntimeFailure(
      `manifest run_limits.${error.budgetKind} exceeds AIR budget`,
      {
        budgetKind: error.budgetKind,
        limitValue: error.airValue,
        attemptedValue: error.manifestValue,
        authoritySource: "manifest",
        reason: "manifest_limit_exceeds_air",
      },
      "BudgetExceeded",
    );
  }
}

function consumeDispatchBudget(context, details = {}) {
  const targetRef = details.targetRef;
  if (targetRef?.startsWith("tool:")) {
    consumeRunBudget(context, "max_tool_calls", 1, {
      ...details,
      dispatch: true,
    });
  }
  if (targetRef?.startsWith("agent:")) {
    consumeRunBudget(context, "max_agent_invocations", 1, {
      ...details,
      dispatch: true,
    });
  }
}

function consumeStepBudget(context, details = {}) {
  consumeRunBudget(context, "max_steps", 1, details);
}

function consumeProviderBudget(context, details = {}) {
  consumeRunBudget(context, "max_provider_calls", 1, {
    ...details,
    provider: true,
  });
}

function consumeRunBudget(context, budgetKind, amount, details = {}) {
  const limit = context.budgetState.effectiveLimits.get(budgetKind);
  const counterName = RUN_BUDGET_COUNTERS[budgetKind];
  if (!counterName) {
    return;
  }
  const consumedValue = context.budgetState.counters[counterName];
  const nextValue = consumedValue + amount;
  if (!limit) {
    if (context.executionDurability.enabled) {
      context.budgetState.counters[counterName] = nextValue;
    }
    return;
  }
  if (nextValue > limit.value) {
    traceBudgetExceeded(context, budgetKind, limit, consumedValue, details);
    throw new RuntimeFailure(
      `${budgetKind} exceeded`,
      budgetFailureDetails(budgetKind, limit, consumedValue, details),
      RUN_BUDGET_ERROR_CODES[budgetKind] ?? "BudgetExceeded",
    );
  }
  context.budgetState.counters[counterName] = nextValue;
  context.trace.push("budget_consumed", {
    airRef: details.airRef,
    payload: compactPayload({
      budget_kind: budgetKind,
      consumed_value: nextValue,
      limit_value: limit.value,
      authority_source: limit.authoritySource,
      target_ref: details.targetRef,
      caller_ref: context.activeCallerRef,
      agent_ref: context.activeAgentRef,
      provider_mode: details.providerMode,
      provider_attempt: details.providerAttempt,
    }),
  });
}

function observeRunTimeBudget(context, details = {}) {
  const limit = context.budgetState.effectiveLimits.get("max_run_ms");
  if (!limit) {
    return;
  }
  const elapsedMs = activeElapsedMilliseconds(context);
  if (elapsedMs < limit.value) {
    return;
  }
  traceBudgetExceeded(context, "max_run_ms", limit, elapsedMs, details);
  throw new RuntimeFailure(
    "max_run_ms exceeded",
    budgetFailureDetails("max_run_ms", limit, elapsedMs, details),
    "RunTimeBudgetExceeded",
  );
}

function traceBudgetExceeded(context, budgetKind, limit, consumedValue, details = {}) {
  context.trace.push("budget_limit_exceeded", {
    airRef: details.airRef,
    payload: compactPayload({
      budget_kind: budgetKind,
      limit_value: limit.value,
      consumed_value: consumedValue,
      authority_source: limit.authoritySource,
      target_ref: details.targetRef,
      caller_ref: context.activeCallerRef,
      agent_ref: context.activeAgentRef,
      reason: "budget_limit_exceeded",
    }),
  });
  if (details.dispatch) {
    context.trace.push("dispatch_refused_budget_exceeded", {
      airRef: details.airRef,
      payload: compactPayload({
        budget_kind: budgetKind,
        limit_value: limit.value,
        consumed_value: consumedValue,
        target_ref: details.targetRef,
        tool_ref: details.targetRef?.startsWith("tool:") ? details.targetRef : undefined,
        agent_ref: details.targetRef?.startsWith("agent:") ? details.targetRef : context.activeAgentRef,
        caller_ref: context.activeCallerRef,
        provider_mode: details.providerMode,
        provider_attempt: details.providerAttempt,
        runtime_error_code: RUN_BUDGET_ERROR_CODES[budgetKind] ?? "BudgetExceeded",
      }),
    });
  }
}

function budgetFailureDetails(budgetKind, limit, consumedValue, details = {}) {
  return {
    budgetKind,
    limitValue: limit.value,
    consumedValue,
    authoritySource: limit.authoritySource,
    targetRef: details.targetRef,
    agentRef: details.targetRef?.startsWith("agent:") ? details.targetRef : details.agentRef,
    providerMode: details.providerMode,
    providerAttempt: details.providerAttempt,
    reason: "budget_limit_exceeded",
  };
}

function budgetLimitPayload(limit) {
  return compactPayload({
    budget_kind: limit.budgetKind,
    limit_value: limit.value,
    authority_source: limit.authoritySource,
    candidates: limit.candidates,
  });
}

function authorizeAgentInvocation(graph, node, targetRef, context) {
  authorizeAgentInvocationByCaller(
    graph.owner_ref,
    targetRef,
    context,
    airRefForNode(graph, node),
  );
}

function authorizeAgentInvocationByCaller(callerRef, targetRef, context, airRef = undefined) {
  const agent = requireDefinition(context.indexes.agents, targetRef);
  const authority = evaluateAgentInvocationAuthority(callerRef, agent);

  if (authority.authorized) {
    context.trace.push("agent_invocation_authorized", {
      airRef,
      payload: {
        caller_ref: callerRef,
        agent_ref: targetRef,
        authority_source: "callable_by",
      },
    });
    return;
  }

  const reason = authority.reason;
  context.trace.push("agent_invocation_refused", {
    airRef,
    payload: {
      caller_ref: callerRef,
      agent_ref: targetRef,
      reason,
    },
  });
  throw new RuntimeFailure(
    `agent invocation refused: ${callerRef} is not authorized to invoke ${targetRef}`,
    {
      targetRef,
      agentRef: targetRef,
      callerRef,
      reason,
    },
    "UnauthorizedAgentInvocation",
  );
}

function executeBranchNode(graph, node, context) {
  const conditionResult = Boolean(resolveHandle(requiredCondition(node), context, graph));
  const edgeRole = conditionResult ? "true" : "false";
  context.trace.push("branch_evaluated", {
    airRef: airRefForNode(graph, node),
    payload: {
      condition_result: conditionResult,
      selected_edge_role: edgeRole,
      condition_ref: node.condition_ref,
    },
  });
  return { edgeRole };
}

function executeLoopNode(graph, node, context) {
  const loopKey = `${graph.id}:${node.id}`;
  const state = context.loopState.get(loopKey) ?? { index: 0 };
  const collectionRef = node.arguments?.[0];
  const itemRef = node.arguments?.[1];
  let conditionResult;

  if (collectionRef && itemRef) {
    const collection = resolveHandle(collectionRef, context, graph);
    if (!Array.isArray(collection)) {
      throw new RuntimeFailure(`loop collection ${collectionRef} is not an array`, {
        graphRef: graph.id,
        nodeId: node.id,
      });
    }
    conditionResult = state.index < collection.length;
    if (conditionResult) {
      context.values.set(itemRef, collection[state.index]);
      const collectionType = resolveHandleType(collectionRef, context, graph);
      if (collectionType?.startsWith("list:")) {
        context.valueTypes.set(itemRef, collectionType.slice("list:".length));
      }
    }
  } else {
    conditionResult = Boolean(resolveHandle(requiredCondition(node), context, graph));
  }

  if (state.index >= context.maxLoopIterations) {
    throw new RuntimeFailure("loop exceeded runtime iteration limit", {
      graphRef: graph.id,
      nodeId: node.id,
      maxLoopIterations: context.maxLoopIterations,
    }, "LoopIterationLimitExceeded");
  }

  const edgeRole = conditionResult ? "loop_next" : "loop_exit";
  context.trace.push("loop_evaluated", {
    airRef: airRefForNode(graph, node),
    payload: {
      condition_result: conditionResult,
      selected_edge_role: edgeRole,
      iteration_index: state.index,
      condition_ref: node.condition_ref,
    },
  });

  context.loopState.set(loopKey, {
    index: conditionResult ? state.index + 1 : 0,
  });
  return { edgeRole };
}

function resolveHandle(handle, context, graph) {
  if (handle.startsWith("expr:")) {
    return evaluateExpression(resolveExpressionHandle(handle, graph), context, graph);
  }
  if (handle.startsWith("constant:")) {
    const legacyConstantRef = handle.slice("constant:".length);
    const constant =
      context.indexes.constants.get(handle) ?? requireDefinition(context.indexes.constants, legacyConstantRef);
    return decodeAirConstant(constant);
  }
  if (handle.startsWith("literal:bool:")) {
    return handle === "literal:bool:true";
  }
  if (handle.startsWith("literal:string:")) {
    return handle.slice("literal:string:".length);
  }
  if (handle.startsWith("literal:int:")) {
    return parseToubaIntLiteral(handle.slice("literal:int:".length), { handle });
  }
  if (handle.startsWith("literal:float:")) {
    return parseToubaFloatLiteral(handle.slice("literal:float:".length), { handle });
  }
  if (handle.startsWith("literal:number:")) {
    return Number(handle.slice("literal:number:".length));
  }
  if (handle.startsWith("value:")) {
    if (!context.values.has(handle)) {
      throw new RuntimeFailure(`missing runtime value ${handle}`, { handle });
    }
    return context.values.get(handle);
  }
  return handle;
}

function decodeAirConstant(constant) {
  if (Object.hasOwn(constant, "literal_text")) {
    return constant.literal_text;
  }
  if (Object.hasOwn(constant, "literal_boolean")) {
    return Boolean(constant.literal_boolean);
  }
  if (Object.hasOwn(constant, "literal_int")) {
    return parseToubaIntLiteral(constant.literal_int, { constantRef: constant.id });
  }
  if (Object.hasOwn(constant, "literal_float")) {
    return parseToubaFloatLiteral(constant.literal_float, { constantRef: constant.id });
  }
  throw new RuntimeFailure(`constant ${constant.id} has no supported literal`, {
    constantRef: constant.id,
  }, "InvalidAirConstant");
}

function resolveExpressionHandle(handle, graph) {
  if (!graph) {
    throw new RuntimeFailure(`expression handle ${handle} requires a graph context`, { handle });
  }
  const expressionId = handle.slice("expr:".length);
  const expression = (graph.expressions ?? []).find((candidate) => candidate.id === expressionId);
  if (!expression) {
    throw new RuntimeFailure(`unknown AIR expression ${expressionId}`, {
      graphRef: graph.id,
      expressionId,
    });
  }
  return expression;
}

function resolveHandleType(handle, context, graph) {
  if (handle.startsWith("expr:")) {
    return resolveExpressionHandle(handle, graph).type_ref ?? null;
  }
  if (handle.startsWith("constant:")) {
    const legacyConstantRef = handle.slice("constant:".length);
    const constant =
      context.indexes.constants.get(handle) ?? context.indexes.constants.get(legacyConstantRef);
    return constant?.type_ref ?? null;
  }
  if (handle.startsWith("literal:bool:")) {
    return BUILTIN_BOOLEAN;
  }
  if (handle.startsWith("literal:string:")) {
    return BUILTIN_TEXT;
  }
  if (handle.startsWith("literal:int:")) {
    return BUILTIN_INT;
  }
  if (handle.startsWith("literal:float:") || handle.startsWith("literal:number:")) {
    return BUILTIN_FLOAT;
  }
  if (handle.startsWith("value:")) {
    return context.valueTypes.get(handle) ?? null;
  }
  return null;
}

function evaluateExpression(expression, context, graph) {
  switch (expression.kind) {
    case "value_ref":
      return resolveHandle(requiredExpressionField(expression, "value_ref"), context, graph);
    case "literal_text":
      return requiredExpressionField(expression, "literal_text");
    case "literal_boolean":
      return Boolean(requiredExpressionField(expression, "literal_boolean"));
    case "literal_int":
      return parseToubaIntLiteral(requiredExpressionField(expression, "literal_int"), {
        expressionId: expression.id,
      });
    case "literal_float":
      return parseToubaFloatLiteral(requiredExpressionField(expression, "literal_float"), {
        expressionId: expression.id,
      });
    case "text_conversion":
      return evaluateTextConversion(expression, context, graph);
    case "field_access":
      return evaluateFieldAccess(expression, context, graph);
    case "construct_record":
      return evaluateRecordExpression(expression, context, graph);
    case "unary_op":
      return evaluateUnaryExpression(expression, context, graph);
    case "binary_op":
      return evaluateBinaryExpression(expression, context, graph);
    default:
      throw new RuntimeFailure(`unsupported AIR expression kind ${expression.kind}`, {
        expressionId: expression.id,
        kind: expression.kind,
      });
  }
}

function evaluateRecordExpression(expression, context, graph) {
  if (typeof expression.type_ref !== "string" || !Array.isArray(expression.record_fields)) {
    throw new RuntimeFailure("construct_record requires type_ref and record_fields", {
      expressionId: expression.id,
    });
  }
  const result = {};
  let previousName = null;
  for (const field of expression.record_fields) {
    if (
      !field
      || typeof field.name !== "string"
      || field.name.length === 0
      || typeof field.value_ref !== "string"
      || field.value_ref.length === 0
      || (previousName !== null && field.name <= previousName)
    ) {
      throw new RuntimeFailure("construct_record fields must be unique and canonically ordered", {
        expressionId: expression.id,
      });
    }
    Object.defineProperty(result, field.name, {
      configurable: true,
      enumerable: true,
      value: resolveHandle(field.value_ref, context, graph),
      writable: true,
    });
    previousName = field.name;
  }
  return result;
}

function evaluateFieldAccess(expression, context, graph) {
  const [targetHandle] = expression.operands ?? [];
  if (!targetHandle) {
    throw new RuntimeFailure("field_access expression requires a target operand", {
      expressionId: expression.id,
    });
  }
  const target = resolveHandle(targetHandle, context, graph);
  const fieldName = requiredExpressionField(expression, "field_name");
  if (target === null || typeof target !== "object" || !Object.hasOwn(target, fieldName)) {
    throw new RuntimeFailure(`runtime value does not contain field ${fieldName}`, {
      expressionId: expression.id,
      fieldName,
    });
  }
  return target[fieldName];
}

function evaluateTextConversion(expression, context, graph) {
  const [operandHandle] = expression.operands ?? [];
  if (!operandHandle) {
    throw new RuntimeFailure("text_conversion expression requires one operand", {
      expressionId: expression.id,
    });
  }
  const value = resolveHandle(operandHandle, context, graph);
  const typeRef = resolveHandleType(operandHandle, context, graph);
  if (typeRef === BUILTIN_TEXT) {
    return requireText(value, expression, "text");
  }
  if (typeRef === BUILTIN_BOOLEAN) {
    return requireBoolean(value, expression, "text") ? "true" : "false";
  }
  if (typeRef === BUILTIN_INT) {
    return String(validateIntResult(requireInteger(value, expression, "text"), expression));
  }
  if (typeRef === BUILTIN_FLOAT) {
    return String(validateFloatResult(requireNumber(value, expression, "text"), expression));
  }
  throw new RuntimeFailure("text(...) accepts only Text, Boolean, Int or Float values", {
    expressionId: expression.id,
    typeRef,
  });
}

function evaluateUnaryExpression(expression, context, graph) {
  const operator = requiredExpressionField(expression, "operator");
  const [operandHandle] = expression.operands ?? [];
  if (!operandHandle) {
    throw new RuntimeFailure("unary expression requires one operand", {
      expressionId: expression.id,
    });
  }
  const operand = resolveHandle(operandHandle, context, graph);
  switch (operator) {
    case "not":
      return !requireBoolean(operand, expression, operator);
    default:
      throw new RuntimeFailure(`unsupported unary operator ${operator}`, {
        expressionId: expression.id,
        operator,
      });
  }
}

function evaluateBinaryExpression(expression, context, graph) {
  const operator = requiredExpressionField(expression, "operator");
  const operands = expression.operands ?? [];
  if (operands.length !== 2) {
    throw new RuntimeFailure("binary expression requires two operands", {
      expressionId: expression.id,
      operandCount: operands.length,
    });
  }

  if (operator === "and") {
    const left = requireBoolean(resolveHandle(operands[0], context, graph), expression, operator);
    return left && requireBoolean(resolveHandle(operands[1], context, graph), expression, operator);
  }
  if (operator === "or") {
    const left = requireBoolean(resolveHandle(operands[0], context, graph), expression, operator);
    return left || requireBoolean(resolveHandle(operands[1], context, graph), expression, operator);
  }

  const left = resolveHandle(operands[0], context, graph);
  const right = resolveHandle(operands[1], context, graph);

  switch (operator) {
    case "add":
      return validateNumericResult(
        requireNumber(left, expression, operator) + requireNumber(right, expression, operator),
        expression,
      );
    case "subtract":
      return validateNumericResult(
        requireNumber(left, expression, operator) - requireNumber(right, expression, operator),
        expression,
      );
    case "multiply":
      return validateNumericResult(
        requireNumber(left, expression, operator) * requireNumber(right, expression, operator),
        expression,
      );
    case "divide": {
      const divisor = requireNumber(right, expression, operator);
      if (divisor === 0) {
        throw new RuntimeFailure("division by zero", { expressionId: expression.id });
      }
      return validateFloatResult(requireNumber(left, expression, operator) / divisor, expression);
    }
    case "modulo": {
      const dividend = requireInteger(left, expression, operator);
      const divisor = requireInteger(right, expression, operator);
      if (divisor === 0) {
        throw new RuntimeFailure("modulo by zero", { expressionId: expression.id });
      }
      return validateIntResult(dividend % divisor, expression);
    }
    case "text_concat":
      return `${requireText(left, expression, operator)}${requireText(right, expression, operator)}`;
    case "equal":
      return left === right;
    case "not_equal":
      return left !== right;
    case "less_than":
      return requireNumber(left, expression, operator) < requireNumber(right, expression, operator);
    case "greater_than":
      return requireNumber(left, expression, operator) > requireNumber(right, expression, operator);
    case "less_than_or_equal":
      return requireNumber(left, expression, operator) <= requireNumber(right, expression, operator);
    case "greater_than_or_equal":
      return requireNumber(left, expression, operator) >= requireNumber(right, expression, operator);
    default:
      throw new RuntimeFailure(`unsupported binary operator ${operator}`, {
        expressionId: expression.id,
        operator,
      });
  }
}

function resolveCallArguments(graph, node, context) {
  const argumentRefs = node.arguments ?? [];
  if (argumentRefs.length === 0) {
    return null;
  }
  return argumentRefs.map((argumentRef) => resolveHandle(argumentRef, context, graph));
}

function requiredExpressionField(expression, fieldName) {
  if (expression[fieldName] === undefined || expression[fieldName] === null) {
    throw new RuntimeFailure(`AIR expression ${expression.id} is missing ${fieldName}`, {
      expressionId: expression.id,
      fieldName,
    });
  }
  return expression[fieldName];
}

function parseToubaIntLiteral(value, details = {}) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new RuntimeFailure(`invalid Int literal ${value}`, details);
  }
  const parsed = BigInt(value);
  if (parsed < -TOUBA_MAX_SAFE_INT || parsed > TOUBA_MAX_SAFE_INT) {
    throw new RuntimeFailure(`Int literal ${value} is outside the V1 domain`, details);
  }
  return Number(parsed);
}

function parseToubaFloatLiteral(value, details = {}) {
  const parsed = Number(value);
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(parsed)) {
    throw new RuntimeFailure(`Float literal ${value} is not finite`, details);
  }
  return parsed;
}

function requireBoolean(value, expression, operator) {
  if (typeof value !== "boolean") {
    throw new RuntimeFailure(`operator ${operator} expects Boolean operands`, {
      expressionId: expression.id,
      operator,
    });
  }
  return value;
}

function requireText(value, expression, operator) {
  if (typeof value !== "string") {
    throw new RuntimeFailure(`operator ${operator} expects Text operands`, {
      expressionId: expression.id,
      operator,
    });
  }
  return value;
}

function requireNumber(value, expression, operator) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RuntimeFailure(`operator ${operator} expects finite numeric operands`, {
      expressionId: expression.id,
      operator,
    });
  }
  return value;
}

function requireInteger(value, expression, operator) {
  const number = requireNumber(value, expression, operator);
  if (!Number.isInteger(number)) {
    throw new RuntimeFailure(`operator ${operator} expects Int operands`, {
      expressionId: expression.id,
      operator,
    });
  }
  return number;
}

function validateNumericResult(value, expression) {
  if (expression.type_ref === BUILTIN_INT) {
    return validateIntResult(value, expression);
  }
  if (expression.type_ref === BUILTIN_FLOAT) {
    return validateFloatResult(value, expression);
  }
  if (!Number.isFinite(value)) {
    throw new RuntimeFailure("numeric expression produced a non-finite result", {
      expressionId: expression.id,
    });
  }
  return value;
}

function validateIntResult(value, expression) {
  if (!Number.isSafeInteger(value)) {
    throw new RuntimeFailure("Int expression result is outside the V1 domain", {
      expressionId: expression.id,
      result: value,
    });
  }
  return value;
}

function validateFloatResult(value, expression) {
  if (!Number.isFinite(value)) {
    throw new RuntimeFailure("Float expression produced a non-finite result", {
      expressionId: expression.id,
      result: value,
    });
  }
  return value;
}

async function withBoundArguments(
  signature,
  argumentValues,
  context,
  execute,
  { markInputValues = false } = {},
) {
  const inputs = signature?.inputs ?? [];
  if (argumentValues !== null && inputs.length !== argumentValues.length) {
    throw new RuntimeFailure("AIR call argument count does not match target signature", {
      expected: inputs.length,
      actual: argumentValues.length,
    });
  }

  const previousValues = [];
  const previousTypes = [];
  const previousInputValueMembership = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const handle = valueHandle(inputs[index].name);
    previousTypes.push({
      handle,
      existed: context.valueTypes.has(handle),
      typeRef: context.valueTypes.get(handle),
    });
    if (inputs[index].type_ref) {
      context.valueTypes.set(handle, inputs[index].type_ref);
    }
    if (argumentValues !== null) {
      previousValues.push({
        handle,
        existed: context.values.has(handle),
        value: context.values.get(handle),
      });
      context.values.set(handle, argumentValues[index]);
      if (markInputValues) {
        previousInputValueMembership.push({
          handle,
          existed: context.inputValueKeys.has(handle),
        });
        context.inputValueKeys.add(handle);
      }
    }
  }

  try {
    return await execute();
  } finally {
    for (const previous of previousValues.reverse()) {
      if (previous.existed) {
        context.values.set(previous.handle, previous.value);
      } else {
        context.values.delete(previous.handle);
      }
    }
    for (const previous of previousTypes.reverse()) {
      if (previous.existed) {
        context.valueTypes.set(previous.handle, previous.typeRef);
      } else {
        context.valueTypes.delete(previous.handle);
      }
    }
    for (const previous of previousInputValueMembership.reverse()) {
      if (!previous.existed) {
        context.inputValueKeys.delete(previous.handle);
      }
    }
  }
}

function argumentObject(signature, context) {
  return Object.fromEntries(
    (signature?.inputs ?? []).map((input) => {
      const handle = valueHandle(input.name);
      return [input.name, context.values.get(handle)];
    }),
  );
}

function valueHandle(nameOrHandle) {
  return nameOrHandle.startsWith("value:") ? nameOrHandle : `value:${nameOrHandle}`;
}

function nextNodeId(graph, nodeId, role) {
  const edge = graph.edges.find(
    (candidate) => candidate.from_node_id === nodeId && candidate.role === role,
  );
  return edge?.to_node_id;
}

function successEdgeRole(graph, nodeId) {
  if (graph.edges.some((edge) => edge.from_node_id === nodeId && edge.role === "next")) {
    return "next";
  }
  if (graph.edges.some((edge) => edge.from_node_id === nodeId && edge.role === "loop_next")) {
    return "loop_next";
  }
  return "next";
}

function failurePathForNode(graph, nodeId) {
  return (graph.failure_paths ?? []).find((failurePath) => failurePath.trigger_node_id === nodeId);
}

function requiredTarget(node) {
  if (!node.target_ref) {
    throw new RuntimeFailure(`AIR node ${node.id} has no target_ref`, { nodeId: node.id });
  }
  return node.target_ref;
}

function requiredApprovalMode(node) {
  if (!node.approval_mode) {
    throw new RuntimeFailure(`AIR node ${node.id} has no approval_mode`, { nodeId: node.id });
  }
  return node.approval_mode;
}

function requiredUserInteractionMode(node) {
  if (!node.interaction_mode) {
    throw new RuntimeFailure(`AIR node ${node.id} has no interaction_mode`, { nodeId: node.id });
  }
  return node.interaction_mode;
}

function requiredCondition(node) {
  if (!node.condition_ref) {
    throw new RuntimeFailure(`AIR node ${node.id} has no condition_ref`, { nodeId: node.id });
  }
  return node.condition_ref;
}

function normalizeAgentDecisions(decisions) {
  if (decisions instanceof Map) {
    return new Map(
      [...decisions.entries()].map(([agentRef, decision]) => [
        agentRef,
        normalizeAgentDecisionRecord(agentRef, decision),
      ]),
    );
  }
  if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
    throw new ToubaRuntimeError(
      "InvalidAgentDecisions",
      "agent decisions must be an object keyed by agent_ref",
    );
  }
  const normalized = new Map();
  for (const [agentRef, decision] of Object.entries(decisions)) {
    normalized.set(agentRef, normalizeAgentDecisionRecord(agentRef, decision));
  }
  return normalized;
}

function normalizeAgentDecisionRecord(agentRef, decision, options = {}) {
  if (typeof agentRef !== "string" || agentRef.trim() === "" || !agentRef.startsWith("agent:")) {
    throw new ToubaRuntimeError(
      "InvalidAgentDecisions",
      "agent decision key must be a non-empty agent_ref",
      { agentRef },
    );
  }

  const record = typeof decision === "string"
    ? { target_ref: decision }
    : decision;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new ToubaRuntimeError(
      "InvalidAgentDecisions",
      "agent decision must be a target ref string or an object with target_ref",
      { agentRef },
    );
  }

  const targetRef = record.target_ref ?? record.capability_ref ?? record.use_ref;
  if (typeof targetRef !== "string" || targetRef.trim() === "") {
    throw new ToubaRuntimeError(
      "InvalidAgentDecisions",
      "agent decision target_ref must be a non-empty string",
      { agentRef },
    );
  }
  const source = record.source === undefined
    ? options.defaultSource ?? "host_decision"
    : record.source;
  if (typeof source !== "string" || source.trim() === "") {
    throw new ToubaRuntimeError(
      "InvalidAgentDecisions",
      "agent decision source must be a non-empty string",
      { agentRef },
    );
  }
  const reason = record.reason;
  if (reason !== undefined && typeof reason !== "string") {
    throw new ToubaRuntimeError(
      "InvalidAgentDecisions",
      "agent decision reason must be a string when present",
      { agentRef },
    );
  }
  const args = record.arguments;
  if (
    args !== undefined
    && (!args || typeof args !== "object")
  ) {
    throw new ToubaRuntimeError(
      "InvalidAgentDecisions",
      "agent decision arguments must be an object or array when present",
      { agentRef },
    );
  }

  return {
    targetRef,
    source,
    reason,
    arguments: args,
  };
}

function normalizeHumanApprovalDecisions(decisions) {
  if (decisions instanceof Map) {
    return new Map(decisions);
  }
  if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
    throw new ToubaRuntimeError(
      "InvalidHumanApprovalDecisions",
      "human approval decisions must be an object keyed by approval_ref",
    );
  }
  const normalized = new Map();
  for (const [approvalRef, record] of Object.entries(decisions)) {
    if (typeof approvalRef !== "string" || approvalRef.trim() === "") {
      throw new ToubaRuntimeError(
        "InvalidHumanApprovalDecisions",
        "human approval decision key must be a non-empty approval_ref",
      );
    }
    const decision = typeof record === "string" ? record : record?.decision;
    if (typeof decision !== "string" || decision.trim() === "") {
      throw new ToubaRuntimeError(
        "InvalidHumanApprovalDecisions",
        "human approval decision must be a non-empty string or object with decision",
        { approvalRef },
      );
    }
    normalized.set(approvalRef, decision);
  }
  return normalized;
}

function normalizeUserInputs(inputs) {
  if (inputs instanceof Map) {
    return new Map(inputs);
  }
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new ToubaRuntimeError(
      "InvalidUserInputs",
      "user inputs must be an object keyed by interaction_ref",
    );
  }
  const normalized = new Map();
  for (const [interactionRef, value] of Object.entries(inputs)) {
    if (typeof interactionRef !== "string" || interactionRef.trim() === "") {
      throw new ToubaRuntimeError(
        "InvalidUserInputs",
        "user input key must be a non-empty interaction_ref",
      );
    }
    normalized.set(interactionRef, value);
  }
  return normalized;
}

function normalizeUserInputProvider(provider) {
  if (provider === undefined || provider === null) {
    return null;
  }
  if (typeof provider !== "function") {
    throw new ToubaRuntimeError("InvalidUserInputProvider", "userInputProvider must be a function");
  }
  return provider;
}

function normalizeDispatchAuthorityProvider(provider) {
  if (provider === undefined || provider === null) return null;
  if (typeof provider !== "function") {
    throw new ToubaRuntimeError(
      "InvalidRuntimeOption",
      "dispatchAuthorityProvider must be a function",
    );
  }
  return provider;
}

function createRunState(options) {
  const now = normalizeNowProvider(options.now);
  const startedAtMs = now();
  const runTimeoutMs = normalizeOptionalPositiveRuntimeInteger(
    options.runTimeoutMs ?? options.run_timeout_ms ?? null,
    "runTimeoutMs",
  );
  return {
    initialized: false,
    status: "created",
    cancelRequested: false,
    cancelCompleted: false,
    cancelAuthoritySource: null,
    cancelReason: null,
    cancelEventId: null,
    timeoutExceeded: false,
    runTimeoutMs,
    startedAtMs,
    activeElapsedBaseMs: 0,
    now,
    cancelRequestedProvider: normalizeCancelRequestedProvider(
      options.cancelRequestedProvider ?? options.cancel_requested_provider,
    ),
    initialCancelRequested: options.cancelRequested === true || options.cancel_requested === true,
    initialCancelAuthoritySource: normalizeCancelAuthoritySource(
      options.cancelAuthoritySource ?? options.cancel_authority_source ?? "host",
    ),
    cancelOnPause: options.cancelOnPause === true || options.cancel_on_pause === true,
    killSwitchInitiallyEnabled:
      options.killSwitchEnabled === true || options.kill_switch_enabled === true,
    killSwitchScope: normalizeKillSwitchScope(
      options.killSwitchScope ?? options.kill_switch_scope ?? "runtime",
    ),
  };
}

function normalizeTraceEventObserver(observer) {
  if (observer === undefined || observer === null) return null;
  if (typeof observer !== "function") {
    throw new ToubaRuntimeError("InvalidRuntimeOption", "traceEventObserver must be a function");
  }
  return observer;
}

function normalizeCancelRequestedProvider(provider) {
  if (provider === undefined || provider === null) return null;
  if (typeof provider !== "function") {
    throw new ToubaRuntimeError("InvalidRuntimeOption", "cancelRequestedProvider must be a function");
  }
  return provider;
}

function normalizeNowProvider(now) {
  if (now === undefined || now === null) {
    return () => Date.now();
  }
  if (typeof now !== "function") {
    throw new ToubaRuntimeError("InvalidRuntimeOption", "now must be a function");
  }
  return () => {
    const value = now();
    if (!Number.isFinite(value)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", "now must return a finite number");
    }
    return value;
  };
}

function normalizeCancelAuthoritySource(value) {
  if (["cli", "host", "human", "timeout", "kill_switch"].includes(value)) {
    return value;
  }
  throw new ToubaRuntimeError("InvalidRuntimeOption", "cancelAuthoritySource is invalid", {
    authoritySource: value,
  });
}

function normalizeKillSwitchScope(value) {
  if (["runtime", "project"].includes(value)) {
    return value;
  }
  throw new ToubaRuntimeError("InvalidRuntimeOption", "killSwitchScope is invalid", {
    scope: value,
  });
}

function normalizeTriggerRunCounts(counts) {
  if (counts instanceof Map) {
    return new Map(
      [...counts.entries()].map(([triggerRef, count]) => [
        normalizeTriggerRunCountKey(triggerRef),
        normalizeNonNegativeRuntimeInteger(count, "triggerRunCounts"),
      ]),
    );
  }
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new ToubaRuntimeError(
      "InvalidRuntimeOption",
      "triggerRunCounts must be an object keyed by trigger_ref",
    );
  }
  const normalized = new Map();
  for (const [triggerRef, count] of Object.entries(counts)) {
    normalized.set(
      normalizeTriggerRunCountKey(triggerRef),
      normalizeNonNegativeRuntimeInteger(count, "triggerRunCounts"),
    );
  }
  return normalized;
}

function normalizeTriggerRunCountKey(triggerRef) {
  if (typeof triggerRef !== "string" || !triggerRef.startsWith("trigger:")) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", "triggerRunCounts keys must be trigger refs", {
      triggerRef,
    });
  }
  return triggerRef;
}

function normalizeInputs(inputs) {
  const values = new Map();
  for (const [key, value] of Object.entries(inputs)) {
    values.set(key.startsWith("value:") ? key : `value:${key}`, value);
  }
  return values;
}

function normalizeAgentDecisionProviderVisibleInputKeys(keys) {
  if (!Array.isArray(keys)) {
    throw new ToubaRuntimeError(
      "InvalidRuntimeOption",
      "agentDecisionProviderVisibleInputKeys must be an array",
    );
  }
  return keys.map((key) => {
    if (typeof key !== "string" || key.trim() === "") {
      throw new ToubaRuntimeError(
        "InvalidRuntimeOption",
        "agentDecisionProviderVisibleInputKeys must contain non-empty strings",
      );
    }
    return key.trim();
  });
}

function normalizeAgentDecisionProviderInitialMode(value) {
  if (value === "summary" || value === "capabilities") {
    return value;
  }
  throw new ToubaRuntimeError(
    "InvalidRuntimeOption",
    "agentDecisionProviderInitialMode must be summary or capabilities",
  );
}

function airRefForNode(graph, node) {
  return compactPayload({
    flow_graph_ref: graph.id,
    owner_ref: graph.owner_ref,
    node_id: node.id,
    source_ref: node.source_ref,
  });
}

function runtimeFailureTracePayload(error, context) {
  return compactPayload({
    runtime_error_code: error.code,
    target_ref: context.fallbackTargetRef,
    selected_ref: error.details?.targetRef,
    allowed_refs: error.details?.allowedRefs,
    tool_ref: error.details?.toolRef,
    effect_id: error.details?.effectId,
    request_digest: error.details?.requestDigest,
    effect_state: error.details?.state,
    effect_retry_mode: error.details?.retryMode,
    caller_ref: context.callerRef,
    agent_ref: error.details?.agentRef ?? context.agentRef,
    provider_mode: error.details?.providerMode,
    provider_attempt: error.details?.providerAttempt,
    provider_timeout_ms: error.details?.timeoutMs,
    provider_cause: error.details?.cause,
    provider_cause_code: error.details?.providerCauseCode ?? error.details?.causeCode,
    provider_metadata: error.details?.provider_metadata,
    retry_limit: error.details?.retryLimit,
    missing_capability: error.details?.missingCapability,
    missing_capabilities: error.details?.missingCapabilities,
    memory_ref: error.details?.memoryRef,
    memory_access: error.details?.memoryAccess,
    field: error.details?.field,
    integrity_evidence: error.details?.integrityEvidence,
    interaction_ref: error.details?.interactionRef,
    mode: error.details?.mode,
    missing_memory_accesses: error.details?.missingMemoryAccesses,
    required_memory_accesses: error.details?.requiredMemoryAccesses,
    granted_memory_accesses: error.details?.grantedMemoryAccesses,
    owner_memory_scopes: error.details?.ownerMemoryScopes,
    missing_secret_handles: error.details?.missingSecrets,
    schema_path: error.details?.schemaPath,
    expected_type_ref: error.details?.expectedTypeRef,
    actual_type: error.details?.actualType,
    constraint_path: error.details?.constraintPath,
    payload_constraint: error.details?.constraint,
    payload_constraint_limit_value: error.details?.constraintLimitValue,
    allowed_values_count: error.details?.allowedValuesCount,
    observed_length: error.details?.observedLength,
    missing_fields: error.details?.missingFields,
    unknown_fields: error.details?.unknownFields,
    max_agent_steps: error.details?.maxAgentSteps,
    budget_kind: error.details?.budgetKind,
    budget_limit_value: error.details?.limitValue,
    budget_consumed_value: error.details?.consumedValue,
    budget_authority_source: error.details?.authoritySource,
    required_capabilities: error.details?.requiredCapabilities,
    granted_capabilities: error.details?.grantedCapabilities,
    secret_handles_required: error.details?.requiredSecrets,
    secret_handles_granted: error.details?.grantedSecrets,
    secret_handles_refused: error.details?.secretHandlesRefused ?? error.details?.missingSecrets,
    secret_refusal_reasons: error.details?.secretRefusalReasons,
    compensation_id: context.compensation?.config.envelope.compensation_id,
    compensates_effect_id:
      context.compensation?.config.envelope.compensates_effect_id,
    inverse_effect_id: context.compensation?.lastAttempt?.inverseEffectId
      ?? context.compensation?.config.inverse_effect_id,
    attempt_index: context.compensation?.lastAttempt?.attemptIndex,
    result: context.compensation?.lastAttempt?.result ?? context.compensation?.outcome,
    blocker_code: context.compensation?.lastAttempt?.blockerCode
      ?? context.compensation?.blockerCode,
  });
}

function runtimeFailureFamily(error) {
  return failureFamilyForRuntimeCode(error?.code ?? error?.details?.runtime_error_code);
}

function traceUnhandledRuntimeFailure(context, error) {
  const events = context.trace.document().events ?? [];
  const alreadyTraced = events.some((event) =>
    event.kind === "failure_detected"
    && event.payload?.runtime_error_code === error.code
  );
  if (alreadyTraced) return;
  context.trace.push("failure_detected", {
    payload: compactPayload({
      failure_mode: "run",
      failure_family: runtimeFailureFamily(error),
      ...runtimeFailureTracePayload(error, {
        fallbackTargetRef: context.entryRef,
        callerRef: context.activeCallerRef,
        agentRef: context.activeAgentRef,
        compensation: context.compensation,
      }),
    }),
    message: error.message,
  });
}
