import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  agentDecisionProviderContent,
  agentProviderObservationBudgetReport,
} from "./agent-provider-content.mjs";
import {
  runProcessToolHandler,
  TOOL_HANDLER_PROTOCOL_VERSION,
} from "./handler-protocol.mjs";
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
  normalizeAirRunLimits,
} from "./runtime-budgets.mjs";
import {
  RuntimeCancelled,
  RuntimeFailure,
  RuntimeStop,
  ToubaRuntimeError,
} from "./runtime-errors.mjs";
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

export const AIR_SCHEMA_VERSION = "air-minimal-v0.1";
export const AIR_JSON_PROFILE = "air-json-v0.1";
const TOUBA_MAX_SAFE_INT = 9007199254740991n;
const BUILTIN_TEXT = "builtin:Text";
const BUILTIN_BOOLEAN = "builtin:Boolean";
const BUILTIN_INT = "builtin:Int";
const BUILTIN_FLOAT = "builtin:Float";
const TOOL_BINDING_MANIFEST_VERSION = "touba-manifest-v1";
const TOUBA_SECRETS_VERSION = "touba-secrets-v1";
const RESOURCE_BINDINGS_SCHEMA_VERSION = "touba-resource-bindings-v0.1";
const HUMAN_APPROVAL_CHECKPOINT_VERSION = "touba-run-checkpoint-v0.1";
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
const AIR_DEFINITION_COLLECTIONS = Object.freeze([
  "types",
  "constants",
  "functions",
  "tools",
  "memories",
  "skills",
  "agents",
  "strategies",
  "triggers",
]);

export const RUNTIME_CAPABILITIES = Object.freeze([
  AIR_SCHEMA_VERSION,
  AIR_JSON_PROFILE,
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
  const context = createExecutionContext(document, entryRef, options);
  const { trace } = context;

  trace.push("run_started", {
    payload: {
      entry_ref: entryRef,
    },
  });

  let status = "success";
  let result;
  try {
    initializeRunControls(context);
    result = context.humanApprovalResumeCheckpoint
      ? await executeHumanApprovalResumeCheckpoint(document, entryRef, context)
      : await executeTarget(entryRef, context);
  } catch (error) {
    if (error instanceof RuntimeStop) {
      status = "stopped";
    } else if (error instanceof RuntimeCancelled) {
      status = "cancelled";
      traceRunCancelled(context, error.details);
    } else if (error instanceof RuntimeFailure) {
      status = "failure";
    } else {
      throw error;
    }
  }

  trace.push("run_completed", {
    payload: {
      status,
    },
  });

  const response = {
    status,
    result,
    trace: trace.document(),
  };
  if (context.pendingHumanApprovalCheckpoint) {
    response.checkpoint = context.pendingHumanApprovalCheckpoint;
  }
  return response;
}

export async function executeTriggerEvent(document, event, options = {}) {
  validateAirDocument(document);

  const triggerEvent = normalizeTriggerEvent(event);
  const entryRef = triggerEvent.triggerRef ?? "trigger:unknown";
  const context = createExecutionContext(document, entryRef, options);
  const { trace } = context;

  trace.push("run_started", {
    payload: {
      entry_ref: entryRef,
    },
  });

  let status = "success";
  let result;
  try {
    initializeRunControls(context);
    result = await executeNormalizedTriggerEvent(triggerEvent, context);
  } catch (error) {
    if (error instanceof RuntimeStop) {
      status = "stopped";
    } else if (error instanceof RuntimeCancelled) {
      status = "cancelled";
      traceRunCancelled(context, error.details);
    } else if (error instanceof RuntimeFailure) {
      status = "failure";
    } else {
      throw error;
    }
  }

  trace.push("run_completed", {
    payload: {
      status,
    },
  });

  return {
    status,
    result,
    trace: trace.document(),
  };
}

function createExecutionContext(document, entryRef, options = {}) {
  const indexes = indexAirDocument(document);
  const trace = new TraceBuilder(document, entryRef, options.runId ?? "run-1");
  const initialValues = normalizeInputs(options.inputs ?? {});
  const skillPacks = normalizeSkillPacks(options.skillPacks ?? options.skill_packs ?? []);
  const activeSkillPackRefs = normalizeStringSet(
    options.activeSkillPackRefs ?? options.active_skill_pack_refs ?? [],
    "activeSkillPackRefs",
  );
  validateActiveSkillPackRefs(skillPacks, activeSkillPackRefs);
  return {
    indexes,
    entryRef,
    trace,
    toolHandlers: options.toolHandlers ?? {},
    toolBindingManifest: normalizeOptionalToolBindingManifest(options.toolBindingManifest),
    resourceBindings: normalizeOptionalResourceBindings(options.resourceBindings),
    secretStore: normalizeOptionalSecretStore(options.secretStore),
    values: new Map(initialValues),
    inputValueKeys: new Set(initialValues.keys()),
    valueTypes: new Map(),
    humanApprovalDecisions: normalizeHumanApprovalDecisions(
      options.humanApprovalDecisions ?? options.humanApprovals ?? {},
    ),
    userInputs: normalizeUserInputs(options.userInputs ?? options.interactionInputs ?? {}),
    userInputProvider: normalizeUserInputProvider(options.userInputProvider),
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
    budgetState: createBudgetState(document, normalizeOptionalToolBindingManifest(options.toolBindingManifest), options),
    maxAgentSteps: normalizePositiveRuntimeInteger(
      options.maxAgentSteps ?? options.maxAgentDecisionSteps ?? 8,
      "maxAgentSteps",
    ),
    triggerRunCounts: normalizeTriggerRunCounts(options.triggerRunCounts ?? {}),
    effectState: createEffectState(),
    durableHumanApprovals: options.durableHumanApprovals === true
      || options.durable_human_approvals === true,
    humanApprovalResumeCheckpoint: normalizeOptionalHumanApprovalCheckpoint(
      options.humanApprovalResumeCheckpoint ?? options.human_approval_resume_checkpoint,
    ),
    pendingHumanApprovalCheckpoint: null,
    callStack: [],
    loopState: new Map(),
    maxLoopIterations: options.maxLoopIterations ?? 100,
    activeAgentRef: null,
    activeCallerRef: null,
    nextCallIndex: 1,
  };
}

function createEffectState() {
  return {
    externalToolDispatches: 0,
  };
}

function normalizeOptionalHumanApprovalCheckpoint(checkpoint) {
  if (checkpoint === undefined || checkpoint === null) {
    return null;
  }
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new ToubaRuntimeError("InvalidHumanApprovalCheckpoint", "human approval checkpoint must be an object");
  }
  if (checkpoint.checkpoint_schema_version !== HUMAN_APPROVAL_CHECKPOINT_VERSION) {
    throw new ToubaRuntimeError(
      "InvalidHumanApprovalCheckpoint",
      `checkpoint_schema_version must be ${HUMAN_APPROVAL_CHECKPOINT_VERSION}`,
      { actual: checkpoint.checkpoint_schema_version },
    );
  }
  return checkpoint;
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
  return executeGraph(checkpoint.graph_ref, context, { startNodeId: checkpoint.node_id });
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
  const resumeTargetRef = nextNodeId(graph, node.id, "next");
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

function validateHumanApprovalCheckpointCompatibility(document, entryRef, checkpoint, options = {}) {
  const expectedDigest = airDocumentDigest(document);
  const compatibilityErrors = [];
  if (checkpoint.air_schema_version !== document.air_schema_version) {
    compatibilityErrors.push("air_schema_version");
  }
  if (checkpoint.module_ref !== document.module.id) {
    compatibilityErrors.push("module_ref");
  }
  if (checkpoint.entry_ref !== entryRef) {
    compatibilityErrors.push("entry_ref");
  }
  if (checkpoint.air_digest !== expectedDigest) {
    compatibilityErrors.push("air_digest");
  }
  if (options.expectedScope !== undefined && checkpoint.scope !== options.expectedScope) {
    compatibilityErrors.push("scope");
  }
  if (compatibilityErrors.length > 0) {
    throw new RuntimeFailure(
      "human approval checkpoint is not compatible with this run",
      {
        entryRef,
        approvalRef: checkpoint.approval_ref,
        compatibilityErrors,
      },
      "HumanApprovalCheckpointIncompatible",
    );
  }
}

function applyHumanApprovalResumeCheckpoint(context, checkpoint) {
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
  context.nextCallIndex = checkpoint.next_call_index ?? 1;
  context.activeAgentRef = checkpoint.active_agent_ref ?? null;
  context.activeCallerRef = checkpoint.active_caller_ref ?? null;
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
  if (!["approved", "rejected", "expired", "cancelled"].includes(humanDecision)) {
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

  if (humanDecision === "approved") {
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

  const terminalKind = {
    rejected: "human_approval_rejected",
    expired: "human_approval_expired",
    cancelled: "human_approval_cancelled",
  }[humanDecision];
  context.trace.push(terminalKind, {
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
    return executeGraph(graph.id, context, { startNodeId: resumeTargetRef });
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
  return context.durableHumanApprovals === true && graph.owner_ref === context.entryRef;
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

function checkpointObjectFromMap(map, label) {
  const value = Object.fromEntries(map.entries());
  return checkpointJsonClone(value, label);
}

function mapFromCheckpointObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be an object`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return new Map(Object.entries(checkpointJsonClone(value, label)));
}

function checkpointStringArray(value, label) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be an array of strings`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return value;
}

function checkpointString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be a non-empty string`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return value;
}

function checkpointArray(value, label) {
  if (!Array.isArray(value)) {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be an array`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return value;
}

function checkpointNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeFailure(
      `human approval checkpoint ${label} must be a non-negative safe integer`,
      { label },
      "InvalidHumanApprovalCheckpoint",
    );
  }
  return value;
}

function checkpointJsonClone(value, path) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RuntimeFailure(
        `human approval checkpoint ${path} contains a non-finite number`,
        { path },
        "HumanApprovalCheckpointValueNotPortable",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => checkpointJsonClone(entry, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    const clone = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        throw new RuntimeFailure(
          `human approval checkpoint ${path}.${key} contains undefined`,
          { path: `${path}.${key}` },
          "HumanApprovalCheckpointValueNotPortable",
        );
      }
      clone[key] = checkpointJsonClone(child, `${path}.${key}`);
    }
    return clone;
  }
  throw new RuntimeFailure(
    `human approval checkpoint ${path} contains a non-JSON value`,
    { path, valueKind: payloadValueKind(value) },
    "HumanApprovalCheckpointValueNotPortable",
  );
}

function stringArraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function assertCheckpointHasNoResolvedSecret(values, context, approvalRef) {
  const serialized = JSON.stringify(values);
  if (typeof serialized !== "string") {
    return;
  }
  const leakedSecrets = resolvedSecretEntries(context.secretStore)
    .filter((entry) => entry.value.length > 0 && serialized.includes(entry.value));
  if (leakedSecrets.length === 0) {
    return;
  }
  throw new RuntimeFailure(
    `human approval checkpoint contains a resolved secret value ${approvalRef}`,
    {
      approvalRef,
      secretHandlesRefused: leakedSecrets.map((entry) => entry.handle),
    },
    "SecretValueInHumanApprovalCheckpoint",
  );
}

function airDocumentDigest(document) {
  return `sha256:${sha256Json(document)}`;
}

function validateAirDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR JSON must decode to an object");
  }
  if (document.air_schema_version !== AIR_SCHEMA_VERSION) {
    throw new ToubaRuntimeError(
      "UnsupportedAirSchemaVersion",
      `expected ${AIR_SCHEMA_VERSION}`,
      { actual: document.air_schema_version },
    );
  }
  if (typeof document.module?.id !== "string" || document.module.id.trim() === "") {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR module id is required");
  }
  if (!document.definitions || typeof document.definitions !== "object") {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR definitions are required");
  }
  validateAirDefinitionCollections(document.definitions);
  if (!Array.isArray(document.execution_graphs)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR execution_graphs must be an array");
  }
  if (!Array.isArray(document.trace_points)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR trace_points must be an array");
  }
  validateAirBudgets(document.budgets);
}

function validateAirDefinitionCollections(definitions) {
  if (Array.isArray(definitions)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR definitions must be an object");
  }
  for (const collection of AIR_DEFINITION_COLLECTIONS) {
    if (definitions[collection] !== undefined && !Array.isArray(definitions[collection])) {
      throw new ToubaRuntimeError(
        "InvalidAirDocument",
        `AIR definitions.${collection} must be an array`,
        { collection },
      );
    }
  }
}

function validateAirBudgets(budgets) {
  if (budgets === undefined) {
    return;
  }
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR budgets must be an object");
  }
  const keys = Object.keys(budgets);
  const unknownTopLevel = keys.filter((key) => key !== "run");
  if (unknownTopLevel.length > 0) {
    throw new ToubaRuntimeError("InvalidAirDocument", "AIR budgets contains unknown sections", {
      unknownBudgetSections: unknownTopLevel,
    });
  }
  normalizeAirRunLimits(budgets.run, "AIR budgets.run");
}

function indexAirDocument(document) {
  const definitions = document.definitions;
  return {
    types: indexById(definitions.types ?? []),
    constants: indexById(definitions.constants ?? []),
    functions: indexById(definitions.functions ?? []),
    tools: indexById(definitions.tools ?? []),
    memories: indexById(definitions.memories ?? []),
    skills: indexById(definitions.skills ?? []),
    agents: indexById(definitions.agents ?? []),
    strategies: indexById(definitions.strategies ?? []),
    triggers: indexById(definitions.triggers ?? []),
    graphs: indexById(document.execution_graphs),
    tracePoints: indexById(document.trace_points),
  };
}

function indexById(items) {
  const index = new Map();
  for (const item of items) {
    if (!item?.id) {
      throw new ToubaRuntimeError("InvalidAirDocument", "AIR item without id");
    }
    if (index.has(item.id)) {
      throw new ToubaRuntimeError("InvalidAirDocument", `duplicate AIR id ${item.id}`);
    }
    index.set(item.id, item);
  }
  return index;
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

  trace.push("trigger_event_accepted", {
    payload: {
      trigger_ref: triggerRef,
      target_ref: trigger.target_ref,
      source_kind: sourceKind,
      limits: { ...effectiveLimits },
    },
  });
  context.triggerRunCounts.set(triggerRef, observedCount + 1);

  const callArguments = triggerCallArguments(trigger, target, context);
  trace.push("trigger_execution_started", {
    payload: {
      trigger_ref: triggerRef,
      target_ref: trigger.target_ref,
      run_id: trace.runId,
    },
  });

  try {
    const result = await withTriggerTimeout(
      executeTarget(trigger.target_ref, context, callArguments),
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
    };
  }
  return {
    triggerRef: normalizeOptionalNonEmptyString(event.trigger_ref ?? event.triggerRef),
    eventId: normalizeOptionalNonEmptyString(event.event_id ?? event.eventId),
    sourceKind: normalizeOptionalNonEmptyString(event.source_kind ?? event.sourceKind ?? event.kind),
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

function triggerCallArguments(trigger, target, context) {
  const inputs = target.signature?.inputs ?? [];
  const argumentsByInput = new Map(
    (trigger.arguments ?? []).map((argument) => [argument.input, argument.value_ref]),
  );
  if (inputs.length === 0) {
    return null;
  }
  return inputs.map((input) => {
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
    return withBoundArguments(fn.signature, callArguments, context, () =>
      executeGraph(fn.body_graph_ref, context),
    );
  }
  if (targetRef.startsWith("skill:")) {
    const skill = requireDefinition(context.indexes.skills, targetRef);
    return withBoundArguments(skill.signature, callArguments, context, () =>
      executeGraph(skill.flow_graph_ref, context),
    );
  }
  if (targetRef.startsWith("agent:")) {
    if (callArguments) {
      throw new RuntimeFailure("call_agent does not accept arguments in anneau 1", { targetRef });
    }
    const agent = requireDefinition(context.indexes.agents, targetRef);
    const capabilityRefs = Array.isArray(agent.uses) ? [...agent.uses] : [];
    context.trace.push("agent_capabilities_listed", {
      payload: {
        agent_ref: agent.id,
        authority_source: "uses",
        capability_refs: capabilityRefs,
        capabilities: capabilityRefs.map((capabilityRef) =>
          agentCapabilityDescriptor(capabilityRef, context)
        ),
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
  }
  if (targetRef.startsWith("strategy:")) {
    const strategy = requireDefinition(context.indexes.strategies, targetRef);
    return withBoundArguments(strategy.signature, callArguments, context, () =>
      executeGraph(strategy.flow_graph_ref, context),
    );
  }
  if (targetRef.startsWith("tool:")) {
    const tool = requireDefinition(context.indexes.tools, targetRef);
    return withBoundArguments(tool.signature, callArguments, context, () =>
      executeTool(tool, context),
    );
  }
  throw new RuntimeFailure(`unsupported AIR target ${targetRef}`, { targetRef });
}

async function executeAgentDecisionLoop(agent, capabilityRefs, context, options = {}) {
  const observations = Array.isArray(options.observations) ? options.observations : [];
  const startStepIndex = Number.isSafeInteger(options.startStepIndex) && options.startStepIndex >= 0
    ? options.startStepIndex
    : 0;

  for (let stepIndex = startStepIndex; stepIndex < context.maxAgentSteps; stepIndex += 1) {
    const loopState = {
      stepIndex,
      observations,
    };
    const decision = await resolveAgentDecision(agent, capabilityRefs, context, loopState);
    if (!decision) {
      throw new RuntimeFailure(
        `agent decision required for ${agent.id}`,
        {
          agentRef: agent.id,
          allowedRefs: capabilityRefs,
        },
        "AgentDecisionRequired",
      );
    }

    context.trace.push("agent_decision_recorded", {
      payload: compactPayload({
        agent_ref: agent.id,
        step_index: stepIndex,
        action: decision.action,
        selected_ref: decision.targetRef,
        decision_source: decision.source,
        reason: decision.reason,
        arguments_present: decision.arguments !== undefined ? true : undefined,
      }),
    });

    if (decision.action === "answer_directly") {
      context.trace.push("agent_direct_answer_returned", {
        payload: compactPayload({
          agent_ref: agent.id,
          step_index: stepIndex,
          decision_source: decision.source,
          reason: decision.reason,
        }),
      });
      return decision.result;
    }

    if (decision.action === "request_human_review") {
      const reviewResult = executeAgentHumanReview(agent, decision, context, stepIndex, observations);
      observations.push({
        step_index: stepIndex,
        action: "request_human_review",
        result_type: "human_review_decision",
        value: reviewResult,
      });
      continue;
    }

    assertAgentDecisionDoesNotExecuteSkillPack(decision, agent, capabilityRefs, context, stepIndex);
    if (!capabilityRefs.includes(decision.targetRef)) {
      context.trace.push("agent_capability_refused", {
        payload: {
          agent_ref: agent.id,
          step_index: stepIndex,
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
        step_index: stepIndex,
        selected_ref: decision.targetRef,
        authority_source: "uses",
        decision_source: decision.source,
        reason: decision.reason,
      }),
    });

    const selectedCallArguments = callArgumentsForAgentDecision(decision, context);
    if (decision.targetRef.startsWith("agent:")) {
      authorizeAgentInvocationByCaller(agent.id, decision.targetRef, context);
    }

    const previousAgentRef = context.activeAgentRef;
    const previousCallerRef = context.activeCallerRef;
    context.activeAgentRef = agent.id;
    context.activeCallerRef = agent.id;
    let result;
    try {
      result = await executeTarget(decision.targetRef, context, selectedCallArguments);
    } finally {
      context.activeAgentRef = previousAgentRef;
      context.activeCallerRef = previousCallerRef;
    }

    const observation = {
      step_index: stepIndex,
      action: "select_capability",
      target_ref: decision.targetRef,
      kind: callerKindFromRef(decision.targetRef),
      result_type: payloadValueKind(result),
      value: result,
    };
    observations.push(observation);
    context.trace.push("agent_capability_result_returned", {
      payload: compactPayload({
        agent_ref: agent.id,
        step_index: stepIndex,
        selected_ref: decision.targetRef,
        result_available: true,
        result_type: observation.result_type,
      }),
    });
  }

  context.trace.push("agent_step_limit_exceeded", {
    payload: {
      agent_ref: agent.id,
      max_agent_steps: context.maxAgentSteps,
    },
  });
  throw new RuntimeFailure(
    `agent step limit exceeded for ${agent.id}`,
    {
      agentRef: agent.id,
      maxAgentSteps: context.maxAgentSteps,
    },
    "AgentStepLimitExceeded",
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
  if (!["approved", "rejected", "expired", "cancelled"].includes(humanDecision)) {
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

  if (humanDecision === "approved") {
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

  const terminalKind = {
    rejected: "human_approval_rejected",
    expired: "human_approval_expired",
    cancelled: "human_approval_cancelled",
  }[humanDecision];
  context.trace.push(terminalKind, {
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

function agentHumanReviewApprovalRef(agentRef, stepIndex) {
  return `approval:${agentRef}:step-${stepIndex}:human-review`;
}

function requireDefinition(index, id) {
  const item = index.get(id);
  if (!item) {
    throw new RuntimeFailure(`unknown AIR reference ${id}`, { id });
  }
  return item;
}

function targetOutputType(targetRef, context) {
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
  return compactPayload({
    target_ref: targetRef,
    kind,
    name: definition?.name,
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

function typeFieldsDescriptor(typeRef, context) {
  if (typeof typeRef !== "string" || typeRef.trim() === "") {
    return undefined;
  }
  const type = context.indexes.types.get(typeRef);
  if (!type || !Array.isArray(type.fields) || type.fields.length === 0) {
    return undefined;
  }
  return type.fields.map((field) => ({
    name: field.name,
    type_ref: field.type_ref,
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
  const modelInput = agentModelInput(agent, capabilityRefs, capabilities, rawInputs, mode, loopState, context, providerContent);
  const request = {
    protocol: AGENT_DECISION_PROTOCOL_VERSION,
    mode,
    run_id: context.trace.runId,
    agent_ref: agent.id,
    agent_name: agent.name,
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
  const observations = loopState?.observations ?? [];
  const skillPackContext = prepareSkillPackModelContext(context, agent, mode, capabilityRefs);
  const content = providerContent ?? agentDecisionProviderContent(inputs, observations, context);
  const inputEntries = content.inputEntries;
  const observationEntries = content.observations;
  const resourceKinds = uniqueKinds(capabilityRefs);
  const developerInstruction = {
    source: "air_agent_responsibility",
    authority: "developer",
    text: agent.responsibility,
  };
  const modelInput = compactPayload({
    protocol: AGENT_MODEL_INPUT_PROTOCOL_VERSION,
    mode: orientationMode ? "orientation" : "capability_catalog",
    agent: {
      agent_ref: agent.id,
      name: agent.name,
      responsibility: agent.responsibility,
    },
    agent_state: {
      step_index: loopState?.stepIndex ?? 0,
      observation_count: observations.length,
      observations: observationEntries,
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
      capabilities_available: capabilityRefs.length > 0,
      capability_count: capabilityRefs.length,
      capability_refs: orientationMode ? capabilityRefs : undefined,
      capability_kinds: resourceKinds,
      catalog_available_on_request: orientationMode,
      catalog_presented: !orientationMode,
      skill_pack_hints_available: skillPackContext.hints.length > 0,
      skill_pack_hint_count: skillPackContext.hints.length,
      active_skill_pack_count: skillPackContext.active.length,
    },
    skill_pack_hints: skillPackContext.hints,
    active_skill_packs: skillPackContext.active.length > 0 ? skillPackContext.active : undefined,
    skill_pack_budgets: skillPackContext.budgets,
    resource_interface: {
      catalog_policy: orientationMode ? "available_on_request" : "presented",
      resource_kinds: skillPackContext.hints.length > 0 ? [...resourceKinds, "skill_pack"] : resourceKinds,
      includes: orientationMode
        ? ["capability_refs", "capability_count", "capability_kinds", "skill_pack_hints"]
        : ["capability_descriptors", "signatures", "requirements", "nested_uses", "skill_pack_hints", "active_skill_packs"],
    },
    human_interaction: {
      request_present: false,
      review_available: !orientationMode,
      available_actions: orientationMode ? [] : ["request_human_review"],
    },
    allowed_actions: orientationMode
      ? ["answer_directly", "request_capabilities"]
      : ["select_capability", "request_human_review"],
    capabilities: orientationMode ? undefined : capabilities,
    output_contract: orientationMode
      ? {
        action: {
          enum: ["answer_directly", "request_capabilities"],
        },
        direct_answer: {
          type: "JSON",
          description: "Réponse directe si aucune capacité n'est nécessaire.",
        },
        reason: {
          type: "Text",
          description: "Courte raison de la réponse directe ou de la demande de catalogue.",
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
          description: "Courte raison du choix de capacité.",
        },
        arguments: {
          type: "Object",
          description: "Objet indexé par les noms d'entrées de la signature choisie.",
        },
        human_review: {
          type: "Object",
          description: "Demande de review humain initiée par agent si aucune capacité ne suffit.",
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
  if (typeof serialized !== "string") {
    return;
  }
  const leakedSecrets = resolvedSecretEntries(context.secretStore)
    .filter((entry) => entry.value.length > 0 && serialized.includes(entry.value));
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

function callArgumentsForAgentDecision(decision, context) {
  if (decision.arguments === undefined) {
    return null;
  }

  const definition = definitionForCapability(decision.targetRef, context);
  const inputs = definition?.signature?.inputs ?? [];
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
    return args;
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

  return inputs.map((input) => args[input.name]);
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
  if (!handler) {
    if (binding) {
      recordExternalToolDispatch(context);
      const secretHandles = tool.required_secrets ?? [];
      const handlerRequest = {
        protocol: TOOL_HANDLER_PROTOCOL_VERSION,
        tool_ref: tool.id,
        call_id: `call:${context.trace.runId}:${context.nextCallIndex}`,
        arguments: toolArguments,
        grants: [...binding.grants],
        memory_accesses: memoryAccessesForTrace(tool.memory_accesses ?? []),
        resource_bindings: resourceBindingsForTool(tool, context),
        secret_handles: [...secretHandles],
        limits: { ...binding.limits },
      };
      context.nextCallIndex += 1;
      const handlerResponse = await runProcessToolHandler({
        toolRef: tool.id,
        binding,
        request: handlerRequest,
        secretHandles,
        secretStore: context.secretStore,
      });
      observeToolMemoryMetadata(tool, handlerResponse.memoryMetadata, context);
      const value = handlerResponse.value;
      validateToolOutputPayload(tool, value, context);
      validateToolPayloadConstraints("output", tool, value, binding.payloadConstraints.output);
      return value;
    }
    throw new RuntimeFailure(`missing tool binding ${toolRef}`, { toolRef });
  }
  try {
    recordExternalToolDispatch(context);
    const value = await handler({
      toolRef,
      arguments: toolArguments,
      values: Object.fromEntries(context.values),
      binding: binding ? bindingPublicView(binding) : undefined,
      resourceBindings: resourceBindingsForTool(tool, context),
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
    });
  }
}

function recordExternalToolDispatch(context) {
  context.effectState.externalToolDispatches += 1;
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
  const serialized = JSON.stringify(toolArguments);
  if (typeof serialized !== "string") {
    return;
  }
  const leakedSecrets = resolvedSecretEntries(context.secretStore)
    .filter((entry) => entry.value.length > 0 && serialized.includes(entry.value));

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

function validateToolBinding(tool, context) {
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

  for (const memoryAccess of requiredMemoryAccesses) {
    traceMemoryAccessAuthorized(tool, memoryAccess, context);
  }
  for (const secret of requiredSecrets) {
    traceSecretHandleAuthorized(tool, secret, context);
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
  const serialized = JSON.stringify(entry);
  if (typeof serialized !== "string") {
    return [];
  }
  return resolvedSecretEntries(context.secretStore)
    .filter((secret) => secret.value.length > 0 && serialized.includes(secret.value))
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
  if (manifest?.__toubaToolBindingManifest === true) {
    return manifest;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ToubaRuntimeError("InvalidToolBindingManifest", "manifest must be an object");
  }
  if (manifest.manifest_version !== TOOL_BINDING_MANIFEST_VERSION) {
    throw new ToubaRuntimeError(
      "InvalidToolBindingManifest",
      `manifest_version must be ${TOOL_BINDING_MANIFEST_VERSION}`,
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
    bindings.set(toolRef, normalizeManifestBinding(toolRef, binding));
  }
  const triggers = new Map();
  for (const [triggerRef, trigger] of Object.entries(manifest.triggers ?? {})) {
    triggers.set(triggerRef, normalizeManifestTrigger(triggerRef, trigger));
  }

  return Object.freeze({
    __toubaToolBindingManifest: true,
    version: manifest.manifest_version,
    bindings,
    triggers,
    runLimits: normalizeManifestRunLimits(manifest.run_limits),
    agentSecretScopes: normalizeAgentSecretScopes(manifest.agent_secret_scopes),
  });
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

function normalizeManifestBinding(toolRef, binding) {
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
  const graph = requireDefinition(context.indexes.graphs, graphRef);
  context.trace.push("scope_entered", {
    airRef: {
      flow_graph_ref: graph.id,
      owner_ref: graph.owner_ref,
    },
  });

  let currentNodeId = options.startNodeId ?? graph.entry_node_id;
  let result;
  while (currentNodeId) {
    const node = graph.nodes.find((candidate) => candidate.id === currentNodeId);
    if (!node) {
      throw new RuntimeFailure(`unknown AIR node ${currentNodeId}`, {
        graphRef: graph.id,
        nodeId: currentNodeId,
      });
    }
    if (!isDispatchNode(node)) {
      assertRunCanContinue(context);
      consumeStepBudget(context, {
        airRef: airRefForNode(graph, node),
        targetRef: node.target_ref,
      });
    }

    const step = await executeNode(graph, node, context);
    if (step.done) {
      context.trace.push("scope_exited", {
        airRef: {
          flow_graph_ref: graph.id,
          owner_ref: graph.owner_ref,
          node_id: node.id,
        },
        payload: {
          status: step.status,
        },
      });
      if (step.status === "stopped") {
        throw new RuntimeStop("AIR stop node reached", { graphRef: graph.id, nodeId: node.id });
      }
      return step.result;
    }

    result = step.result ?? result;
    currentNodeId = nextNodeId(graph, node.id, step.edgeRole);
  }

  context.trace.push("scope_exited", {
    airRef: {
      flow_graph_ref: graph.id,
      owner_ref: graph.owner_ref,
    },
    payload: {
      status: "success",
    },
  });
  return result;
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
    edgeRole: "next",
    result: value,
  };
}

function executeHumanApprovalNode(graph, node, context) {
  const approvalRef = node.approval_ref ?? `approval:${graph.id}:${node.id}`;
  const mode = requiredApprovalMode(node);
  const contextRefs = node.context_refs ?? [];
  const resumeTargetRef = nextNodeId(graph, node.id, "next");
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
  if (!["approved", "rejected", "expired", "cancelled"].includes(decision)) {
    const error = new RuntimeFailure(
      `invalid human approval decision ${decision} for ${approvalRef}`,
      { approvalRef, decision },
      "InvalidHumanApprovalDecision",
    );
    traceHumanApprovalFailure(graph, node, context, error);
    throw error;
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

  if (decision === "approved") {
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
      edgeRole: "next",
      result: decision,
    };
  }

  const terminalKind = {
    rejected: "human_approval_rejected",
    expired: "human_approval_expired",
    cancelled: "human_approval_cancelled",
  }[decision];
  context.trace.push(terminalKind, {
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
  assertRunCanDispatch(context, { targetRef, airRef: airRefForNode(graph, node) });
  consumeStepBudget(context, {
    airRef: airRefForNode(graph, node),
    targetRef,
  });
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
    const failurePath = failurePathForNode(graph, node.id);
    context.trace.push("failure_detected", {
      airRef: airRefForNode(graph, node),
      payload: compactPayload({
        failure_path_ref: failurePath?.id,
        failure_mode: failurePath?.mode ?? "unhandled",
        ...runtimeFailureTracePayload(error, {
          fallbackTargetRef: targetRef,
          callerRef: graph.owner_ref,
          agentRef: context.activeAgentRef,
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
  if (!limit) {
    return;
  }
  const counterName = RUN_BUDGET_COUNTERS[budgetKind];
  if (!counterName) {
    return;
  }
  const consumedValue = context.budgetState.counters[counterName];
  const nextValue = consumedValue + amount;
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
  const elapsedMs = context.runState.now() - context.runState.startedAtMs;
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
  const callerKind = callerKindFromRef(callerRef);
  const authorized = ["strategy", "agent"].includes(callerKind)
    && Array.isArray(agent.callable_by)
    && agent.callable_by.some((rule) =>
      rule?.caller_ref === callerRef && rule?.caller_kind === callerKind
    );

  if (authorized) {
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

  const reason = ["strategy", "agent"].includes(callerKind)
    ? "caller_not_allowed"
    : "invalid_caller_kind";
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

function callerKindFromRef(ref) {
  return typeof ref === "string" && ref.includes(":") ? ref.slice(0, ref.indexOf(":")) : null;
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
    });
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

async function withBoundArguments(signature, argumentValues, context, execute) {
  const inputs = signature?.inputs ?? [];
  if (argumentValues !== null && inputs.length !== argumentValues.length) {
    throw new RuntimeFailure("AIR call argument count does not match target signature", {
      expected: inputs.length,
      actual: argumentValues.length,
    });
  }

  const previousValues = [];
  const previousTypes = [];
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
    now,
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
    caller_ref: context.callerRef,
    agent_ref: error.details?.agentRef ?? context.agentRef,
    provider_mode: error.details?.providerMode,
    provider_attempt: error.details?.providerAttempt,
    provider_timeout_ms: error.details?.timeoutMs,
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
  });
}
