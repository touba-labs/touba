// @ts-check

import {
  executeAirDocument,
  loadToolBindingManifestFromJson,
} from "./index.mjs";
import { indexAirDocument, validateAirDocument } from "./air-runtime-profile.mjs";
import { issueCompensationExecutionContext } from "./compensation-context.mjs";
import {
  COMPENSATION_RESULTS,
  compensationRecordDigest,
  requireCompensationStoreAdapter,
  sealCompensationRecord,
  validateCompensationRecord,
} from "./compensation-store.mjs";
import {
  deriveEffectId,
  readEffectJournalEntry,
  requireEffectJournalAdapter,
  validateEffectReceipt,
} from "./effect-contract.mjs";
import {
  canonicalDigest,
  sealExecutionCheckpoint,
  tracePrefixDigest,
} from "./execution-checkpoints.mjs";
import { airDocumentDigest } from "./human-approval-checkpoints.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";
import { TraceBuilder } from "./trace-builder.mjs";

export { COMPENSATION_RESULTS };

const COMPENSATION_ID = /^compensation:sha256:[0-9a-f]{64}$/u;
const EFFECT_ID = /^effect:sha256:[0-9a-f]{64}$/u;
const COMMAND_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_AUTHORITY_TIMEOUT_MS = 5000;
const ACTIVE_BY_STORE = new WeakMap();

/**
 * Create and, when eligible, execute one explicit COMP-1 operation.
 *
 * @param {Record<string, any>} command
 * @param {Record<string, any>} options
 */
export async function createCompensation(command, options) {
  const host = normalizeHost(options);
  const minimal = normalizeCreateCommandForLookup(command);
  const compensationId = deriveCompensationId(minimal.compensates_effect_id);
  await checkAuthority(host, {
    phase: "lookup",
    requesterRef: minimal.requester_ref,
    journalScopeRef: minimal.journal_scope_ref,
    compensationId,
    compensatesEffectId: minimal.compensates_effect_id,
    record: null,
    approval: null,
    requiresSpawn: false,
  });
  const normalized = normalizeCreateCommand(command);
  const evidenceDigest = normalized.approval_evidence === null
    ? null
    : canonicalDigest(normalized.approval_evidence);
  const creationCommandDigest = canonicalDigest({
    compensates_effect_id: normalized.compensates_effect_id,
    approval_evidence_digest: evidenceDigest,
  });

  const existing = await readRecord(host.store, compensationId);
  if (existing) {
    if (
      existing.compensation_request_id === normalized.compensation_request_id
      && existing.creation_command_digest === creationCommandDigest
    ) return pureReplay(existing);
    requestConflict();
  }

  return withProgressLock(host.store, compensationId, async () => {
    const raced = await readRecord(host.store, compensationId);
    if (raced) {
      if (
        raced.compensation_request_id === normalized.compensation_request_id
        && raced.creation_command_digest === creationCommandDigest
      ) return pureReplay(raced);
      requestConflict();
    }
    const original = await readEffectJournalEntry(host.effectJournal, normalized.compensates_effect_id);
    if (!original) {
      throw new RuntimeFailure(
        "compensation target is not available",
        {},
        "CompensationOriginalEffectNotFound",
      );
    }
    const prepared = prepareRecord({
      command: normalized,
      host,
      compensationId,
      creationCommandDigest,
      original,
    });
    let record = prepared.record;
    const localTrace = prepared.localTrace;
    await checkAuthority(host, {
      phase: "resume",
      requesterRef: normalized.requester_ref,
      journalScopeRef: normalized.journal_scope_ref,
      compensationId,
      compensatesEffectId: normalized.compensates_effect_id,
      record,
      recordRevision: 0,
      approval: record.approval,
      requiresSpawn: record.state === "ready",
    });
    record = await createRecord(host.store, record);
    publishEvents(host.traceEventObserver, localTrace?.events ?? []);
    if (record.state !== "ready") return { record, trace: localTrace };
    return progressCompensation(record, normalized, host);
  });
}

/**
 * Resume one existing COMP-1 operation with an exact CAS claim.
 *
 * @param {Record<string, any>} command
 * @param {Record<string, any>} options
 */
export async function resumeCompensation(command, options) {
  const host = normalizeHost(options);
  const normalized = normalizeResumeCommand(command);
  if (deriveCompensationId(normalized.compensates_effect_id) !== normalized.compensation_id) {
    requestInvalid();
  }
  await checkAuthority(host, {
    phase: "lookup",
    requesterRef: normalized.requester_ref,
    journalScopeRef: normalized.journal_scope_ref,
    compensationId: normalized.compensation_id,
    compensatesEffectId: normalized.compensates_effect_id,
    record: null,
    approval: null,
    requiresSpawn: false,
  });
  const evidenceDigest = normalized.approval_evidence === null
    ? null
    : canonicalDigest(normalized.approval_evidence);
  const resumeDigest = canonicalDigest({
    compensation_id: normalized.compensation_id,
    compensates_effect_id: normalized.compensates_effect_id,
    expected_revision: normalized.expected_revision,
    expected_record_digest: normalized.expected_record_digest,
    approval_evidence_digest: evidenceDigest,
  });
  const visible = await readRecord(host.store, normalized.compensation_id);
  if (!visible) recordNotFound();
  const replay = visible.processed_resume_requests.find(
    (item) => item.resume_request_id === normalized.resume_request_id,
  );
  if (replay) {
    if (replay.resume_request_digest !== resumeDigest) requestConflict();
    return pureReplay(visible);
  }

  return withProgressLock(host.store, normalized.compensation_id, async () => {
    let record = await readRecord(host.store, normalized.compensation_id);
    if (!record) recordNotFound();
    const racedReplay = record.processed_resume_requests.find(
      (item) => item.resume_request_id === normalized.resume_request_id,
    );
    if (racedReplay) {
      if (racedReplay.resume_request_digest !== resumeDigest) requestConflict();
      return pureReplay(record);
    }
    if (record.state === "terminal") {
      throw new RuntimeFailure(
        "terminal compensation cannot be resumed",
        {},
        "CompensationNotResumable",
      );
    }
    if (
      record.compensates_effect_id !== normalized.compensates_effect_id
      || record.revision !== normalized.expected_revision
      || record.record_digest !== normalized.expected_record_digest
    ) conflict();
    if (record.processed_resume_requests.length >= 64) {
      throw new RuntimeFailure(
        "compensation resume ledger is full",
        {},
        "CompensationResumeLedgerFull",
      );
    }
    let approval = record.approval;
    if (normalized.approval_evidence !== null) {
      if (approval === null) requestInvalid();
      approval = approvalProjection(
        approval.approval_ref,
        normalized.approval_evidence,
        record.compensation_id,
      );
    }
    record = await replaceRecord(host.store, record, {
      approval,
      processed_resume_requests: [
        ...record.processed_resume_requests,
        {
          resume_request_id: normalized.resume_request_id,
          resume_request_digest: resumeDigest,
        },
      ],
    }, host.now);

    record = await refreshRecordEligibility(record, host);
    if (record.state === "terminal") return { record, trace: null };
    const requiresSpawn = await inverseRequiresSpawn(record, host.effectJournal);
    await checkAuthority(host, {
      phase: "resume",
      requesterRef: normalized.requester_ref,
      journalScopeRef: normalized.journal_scope_ref,
      compensationId: record.compensation_id,
      compensatesEffectId: record.compensates_effect_id,
      record,
      approval: record.approval,
      requiresSpawn,
    }).catch(async (error) => {
      record = await persistLocalOutcome(host, record, {
        result: record.result,
        blockerCode: error.code,
        state: "action_required",
      });
      throw error;
    });
    if (record.state !== "ready" && record.state !== "running" && !requiresSpawn) {
      return progressCompensation(record, normalized, host);
    }
    assertApprovalCanProgress(record, host.now(), requiresSpawn);
    return progressCompensation(record, normalized, host);
  });
}

/** @param {string} compensatesEffectId */
export function deriveCompensationId(compensatesEffectId) {
  if (typeof compensatesEffectId !== "string" || !EFFECT_ID.test(compensatesEffectId)) {
    requestInvalid();
  }
  return `compensation:sha256:${canonicalDigest({
    compensates_effect_id: compensatesEffectId,
  }).slice("sha256:".length)}`;
}

function normalizeHost(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) requestInvalid();
  validateAirDocument(options.airDocument);
  const manifest = loadToolBindingManifestFromJson(JSON.stringify(options.toolBindingManifest));
  if (manifest.version !== "touba-manifest-v3") {
    throw new RuntimeFailure(
      "COMP-1 requires touba-manifest-v3",
      {},
      "CompensationUnsupportedGraph",
    );
  }
  const provider = options.compensationAuthorityProvider;
  if (!provider || typeof provider !== "object" || typeof provider.check !== "function") {
    throw new RuntimeFailure(
      "compensation authority provider is required",
      {},
      "CompensationAuthorityRefused",
    );
  }
  const authorityTimeoutMs = options.compensationAuthorityTimeoutMs ?? 1000;
  if (
    !Number.isSafeInteger(authorityTimeoutMs)
    || authorityTimeoutMs <= 0
    || authorityTimeoutMs > MAX_AUTHORITY_TIMEOUT_MS
  ) {
    throw new RuntimeFailure(
      "compensation authority timeout is invalid",
      {},
      "CompensationAuthorityRefused",
    );
  }
  return {
    ...options,
    manifest,
    store: requireCompensationStoreAdapter(options.compensationStore),
    effectJournal: requireEffectJournalAdapter(options.effectJournal),
    authorityProvider: provider,
    authorityTimeoutMs,
    now: typeof options.now === "function" ? options.now : () => new Date(),
    traceEventObserver: typeof options.traceEventObserver === "function"
      ? options.traceEventObserver
      : null,
  };
}

function normalizeCreateCommandForLookup(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) requestInvalid();
  requireEffectId(command.compensates_effect_id);
  return {
    compensates_effect_id: command.compensates_effect_id,
    requester_ref: requireBounded(command.requester_ref, 512),
    journal_scope_ref: requireBounded(command.journal_scope_ref, 512),
  };
}

function normalizeCreateCommand(command) {
  rejectUnknown(command, new Set([
    "compensation_request_id",
    "compensates_effect_id",
    "requester_ref",
    "journal_scope_ref",
    "approval_evidence",
  ]));
  const minimal = normalizeCreateCommandForLookup(command);
  requireCommandId(command.compensation_request_id);
  return {
    ...minimal,
    compensation_request_id: command.compensation_request_id,
    approval_evidence: command.approval_evidence ?? null,
  };
}

function normalizeResumeCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) requestInvalid();
  rejectUnknown(command, new Set([
    "resume_request_id",
    "compensation_id",
    "compensates_effect_id",
    "expected_revision",
    "expected_record_digest",
    "requester_ref",
    "journal_scope_ref",
    "approval_evidence",
  ]));
  requireCommandId(command.resume_request_id);
  if (typeof command.compensation_id !== "string" || !COMPENSATION_ID.test(command.compensation_id)) {
    requestInvalid();
  }
  requireEffectId(command.compensates_effect_id);
  if (!Number.isSafeInteger(command.expected_revision) || command.expected_revision < 1) {
    requestInvalid();
  }
  if (typeof command.expected_record_digest !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(command.expected_record_digest)) requestInvalid();
  return {
    ...command,
    requester_ref: requireBounded(command.requester_ref, 512),
    journal_scope_ref: requireBounded(command.journal_scope_ref, 512),
    approval_evidence: command.approval_evidence ?? null,
  };
}

function prepareRecord({ command, host, compensationId, creationCommandDigest, original }) {
  const now = host.now().toISOString();
  const runId = `run:${compensationId.slice("compensation:".length)}`;
  const originalSnapshot = originalProjection(original);
  if (typeof original.effect_scope_id === "string" && COMPENSATION_ID.test(original.effect_scope_id)) {
    unsupported();
  }
  const indexes = indexAirDocument(host.airDocument);
  const originalBinding = host.manifest.bindings.get(original.tool_ref);
  if (
    original.air_digest !== airDocumentDigest(host.airDocument)
    || !indexes.tools.has(original.tool_ref)
    || originalBinding?.effectContract?.kind !== "external_write"
  ) checkpointIncompatible();
  const inverseEntryRef = originalBinding?.effectContract?.compensation?.entryRef ?? null;
  const inverseClosure = inverseEntryRef === null
    ? null
    : inspectInverseClosure(inverseEntryRef, indexes, host.manifest);
  if (inverseClosure && inverseClosure.inverseToolRef === original.tool_ref) unsupported();
  if (inverseClosure && host.manifest.bindings.get(inverseClosure.inverseToolRef)?.effectContract?.compensation) {
    unsupported();
  }
  if (inverseClosure?.approvalRef === null && command.approval_evidence !== null) requestInvalid();
  const inverseEffectId = inverseClosure === null
    ? null
    : deriveEffectId({
      effectScopeId: compensationId,
      airDigest: airDocumentDigest(host.airDocument),
      entryRef: inverseEntryRef,
      effectIndex: 1,
    });
  const base = {
    compensation_id: compensationId,
    compensation_request_id: command.compensation_request_id,
    creation_command_digest: creationCommandDigest,
    execution_request_digest: null,
    compatibility_digest: null,
    revision: 1,
    operation_id: compensationId,
    run_id: runId,
    effect_scope_id: compensationId,
    compensates_effect_id: command.compensates_effect_id,
    original: originalSnapshot,
    inverse: inverseClosure === null ? null : {
      entry_ref: inverseEntryRef,
      tool_ref: inverseClosure.inverseToolRef,
      effect_id: inverseEffectId,
      plan_digest: null,
    },
    approval: inverseClosure?.approvalRef
      ? approvalProjection(
        inverseClosure.approvalRef,
        command.approval_evidence,
        compensationId,
      )
      : null,
    state: "ready",
    result: null,
    blocker_code: null,
    pre_checkpoint_trace_state: emptyTraceState(host.airDocument, inverseEntryRef ?? original.entry_ref, runId),
    checkpoint: null,
    processed_resume_requests: [],
    created_at: now,
    updated_at: now,
  };

  if (original.state !== "applied") {
    return localPreparedRecord(base, host, {
      state: "action_required",
      result: "unknown",
      blockerCode: "CompensationOriginalOutcomeUnknown",
    });
  }
  if (!hasUsableOriginalReceipt(original)) {
    return localPreparedRecord(base, host, {
      state: "terminal",
      result: "unavailable",
      blockerCode: "CompensationUnavailable",
    });
  }
  if (inverseClosure === null) {
    return localPreparedRecord(base, host, {
      state: "terminal",
      result: "unavailable",
      blockerCode: "CompensationUnavailable",
    });
  }
  const completed = completePlan(base, host, inverseClosure);
  const approvalBlocker = approvalBlockerCode(completed.approval, host.now());
  if (approvalBlocker !== null) {
    return localPreparedRecord(completed, host, {
      state: "action_required",
      result: null,
      blockerCode: approvalBlocker,
    });
  }
  return { record: sealCompensationRecord(completed), localTrace: null };
}

function completePlan(record, host, closure) {
  const originalReceiptDigest = canonicalDigest(record.original.effect_receipt);
  const plan = {
    schema_version: "touba-compensation-plan-v1",
    compensation_id: record.compensation_id,
    compensates_effect_id: record.compensates_effect_id,
    air_schema_version: host.airDocument.air_schema_version,
    air_digest: airDocumentDigest(host.airDocument),
    manifest_schema_version: host.manifest.version,
    manifest_digest: canonicalDigest(manifestProjection(host.manifest)),
    original_entry_ref: record.original.entry_ref,
    original_tool_ref: record.original.tool_ref,
    original_request_digest: record.original.request_digest,
    original_effect_receipt_digest: originalReceiptDigest,
    inverse_entry_ref: record.inverse.entry_ref,
    inverse_tool_ref: record.inverse.tool_ref,
    inverse_effect_id: record.inverse.effect_id,
    approval_ref: closure.approvalRef,
  };
  const planDigest = canonicalDigest(plan);
  const compatibility = compatibilityProjection(host, planDigest);
  const compatibilityDigest = canonicalDigest(compatibility);
  return {
    ...record,
    execution_request_digest: canonicalDigest({
      compensates_effect_id: record.compensates_effect_id,
      original_request_digest: record.original.request_digest,
      original_effect_receipt_digest: originalReceiptDigest,
      plan_digest: planDigest,
      compatibility_digest: compatibilityDigest,
    }),
    compatibility_digest: compatibilityDigest,
    inverse: { ...record.inverse, plan_digest: planDigest },
    state: "ready",
    result: null,
    blocker_code: null,
  };
}

async function refreshRecordEligibility(record, host) {
  const original = await readEffectJournalEntry(host.effectJournal, record.compensates_effect_id);
  if (!original) {
    throw new RuntimeFailure("compensation target is not available", {}, "CompensationOriginalEffectNotFound");
  }
  if (record.execution_request_digest !== null) {
    const indexes = indexAirDocument(host.airDocument);
    const closure = inspectInverseClosure(record.inverse.entry_ref, indexes, host.manifest);
    const candidate = completePlan({
      ...record,
      original: originalProjection(original),
    }, host, closure);
    if (
      candidate.execution_request_digest !== record.execution_request_digest
      || candidate.compatibility_digest !== record.compatibility_digest
      || candidate.inverse.plan_digest !== record.inverse.plan_digest
    ) checkpointIncompatible();
    const blocker = approvalBlockerCode(candidate.approval, host.now());
    if (record.state === "running") return record;
    if (record.state === "ready" && blocker === null) return record;
    return replaceRecord(host.store, record, {
      original: candidate.original,
      state: blocker === null ? "ready" : "action_required",
      result: null,
      blocker_code: blocker,
    }, host.now);
  }
  if (original.state !== "applied") {
    return persistLocalOutcome(host, record, {
      result: "unknown",
      blockerCode: "CompensationOriginalOutcomeUnknown",
      state: "action_required",
      original: originalProjection(original),
    });
  }
  if (!hasUsableOriginalReceipt(original) || record.inverse === null) {
    return persistLocalOutcome(host, record, {
      result: "unavailable",
      blockerCode: "CompensationUnavailable",
      state: "terminal",
      original: originalProjection(original),
    });
  }
  const closure = inspectInverseClosure(
    record.inverse.entry_ref,
    indexAirDocument(host.airDocument),
    host.manifest,
  );
  const planned = completePlan({ ...record, original: originalProjection(original) }, host, closure);
  const blocker = approvalBlockerCode(planned.approval, host.now());
  return replaceRecord(host.store, record, {
    ...planned,
    state: blocker === null ? "ready" : "action_required",
    blocker_code: blocker,
  }, host.now);
}

async function progressCompensation(record, command, host) {
  if (record.execution_request_digest === null || record.inverse === null) {
    return { record, trace: null };
  }
  assertApprovalCanProgress(record, host.now(), await inverseRequiresSpawn(record, host.effectJournal));
  record = await replaceRecord(host.store, record, {
    state: "running",
    result: null,
    blocker_code: null,
  }, host.now);
  let current = record;
  let publishedSequence = current.checkpoint?.trace_state.next_sequence_index
    ?? current.pre_checkpoint_trace_state.next_sequence_index;
  const authorityContext = {
    requesterRef: command.requester_ref,
    journalScopeRef: command.journal_scope_ref,
  };
  const internal = issueCompensationExecutionContext({
    envelope: compensationEnvelope(current),
    inverse_entry_ref: current.inverse.entry_ref,
    inverse_tool_ref: current.inverse.tool_ref,
    inverse_effect_id: current.inverse.effect_id,
    trace_state: current.checkpoint?.trace_state ?? current.pre_checkpoint_trace_state,
    pre_spawn_guard: async () => {
      assertApprovalCanProgress(current, host.now(), true);
      await checkAuthority(host, {
        phase: "pre_spawn",
        ...authorityContext,
        compensationId: current.compensation_id,
        compensatesEffectId: current.compensates_effect_id,
        record: current,
        approval: current.approval,
        requiresSpawn: true,
      });
    },
  });
  const humanApprovalDecisions = current.approval === null
    ? {}
    : { [current.approval.approval_ref]: "approved" };
  const response = await executeAirDocument(host.airDocument, {
    ...(host.runtimeOptions ?? {}),
    entryRef: current.inverse.entry_ref,
    runId: current.run_id,
    operationId: current.operation_id,
    effectScopeId: current.effect_scope_id,
    effectJournal: host.effectJournal,
    toolBindingManifest: host.manifest,
    resourceBindings: host.resourceBindings,
    secretStore: host.secretStore,
    humanApprovalDecisions,
    executionResumeCheckpoint: current.checkpoint,
    executionCompatibility: {
      run_plan_digest: optionalArtifactDigest(host.runPlan),
      supply_chain_lock_digest: optionalArtifactDigest(host.supplyChainLock),
      hardened_profile_digest: optionalArtifactDigest(host.hardenedExecutionProfile),
    },
    executionCheckpointObserver: async ({ checkpoint, trace }) => {
      current = await replaceRecord(host.store, current, {
        checkpoint,
        pre_checkpoint_trace_state: null,
      }, host.now);
      publishEvents(
        host.traceEventObserver,
        trace.events.filter((event) => (
          event.sequence_index >= publishedSequence
          && event.sequence_index < checkpoint.trace_state.next_sequence_index
        )),
      );
      publishedSequence = checkpoint.trace_state.next_sequence_index;
    },
    __compensationExecutionContext: internal,
  });

  const conflictEvent = response.trace.events.find(
    (event) => event.payload?.runtime_error_code === "CompensationConflict",
  );
  if (conflictEvent) conflict();
  if (current.checkpoint === null) {
    throw new RuntimeFailure(
      "compensation runtime did not persist its initial checkpoint",
      {},
      "CompensationCheckpointIncompatible",
    );
  }
  const terminalEvents = response.trace.events.filter(
    (event) => event.sequence_index >= current.checkpoint.trace_state.next_sequence_index,
  );
  if (terminalEvents.length > 0) {
    const checkpoint = sealExecutionCheckpoint({
      ...current.checkpoint,
      revision: current.checkpoint.revision + 1,
      previous_checkpoint_digest: current.checkpoint.checkpoint_digest,
      checkpoint_digest: undefined,
      trace_state: {
        prefix_digest: tracePrefixDigest(
          current.checkpoint.trace_state.prefix_digest,
          { ...response.trace, events: terminalEvents },
          0,
        ),
        next_sequence_index: terminalEvents.at(-1).sequence_index + 1,
      },
    });
    current = await replaceRecord(host.store, current, { checkpoint }, host.now);
    publishEvents(host.traceEventObserver, terminalEvents);
  }
  const classification = await classifyRuntimeOutcome(response, current, host.effectJournal);
  current = await replaceRecord(host.store, current, classification, host.now);
  return { record: current, trace: response.trace };
}

async function classifyRuntimeOutcome(response, record, effectJournal) {
  const completed = [...response.trace.events].reverse().find((event) => event.kind === "run_completed");
  const result = completed?.payload?.result;
  if (result === "completed" || result === "partial") {
    return { state: "terminal", result, blocker_code: null };
  }
  const inverse = await readEffectJournalEntry(effectJournal, record.inverse.effect_id);
  if (inverse?.state === "applied") {
    const appliedFailure = [...response.trace.events].reverse().find(
      (event) => event.kind === "failure_detected",
    )?.payload?.runtime_error_code;
    if (["CompensationEffectResultInvalid", "DurableResumeCheckpointIncompatible"].includes(appliedFailure)) {
      return {
        state: "action_required",
        result: "unknown",
        blocker_code: "CompensationEffectResultInvalid",
      };
    }
    const restored = compensationResultFromJournal(inverse.result, record);
    if (restored !== null) {
      return { state: "terminal", result: restored, blocker_code: null };
    }
    return {
      state: "action_required",
      result: "unknown",
      blocker_code: "CompensationEffectResultInvalid",
    };
  }
  if (inverse?.state === "not_applied") {
    return { state: "action_required", result: "failed", blocker_code: "EffectNotApplied" };
  }
  if (["dispatched", "unknown"].includes(inverse?.state)) {
    return { state: "action_required", result: "unknown", blocker_code: "EffectOutcomeUnknown" };
  }
  const failure = [...response.trace.events].reverse().find((event) => event.kind === "failure_detected");
  return {
    state: "action_required",
    result: failure?.payload?.result ?? null,
    blocker_code: failure?.payload?.blocker_code
      ?? failure?.payload?.runtime_error_code
      ?? "CompensationCheckpointIncompatible",
  };
}

function compensationResultFromJournal(value, record) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== "compensation_receipt|schema_version|value"
    || value.schema_version !== "touba-compensation-effect-result-v1"
  ) return null;
  const receipt = value.compensation_receipt;
  if (
    !receipt
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || Object.keys(receipt).sort().join("|")
      !== "compensates_effect_id|compensation_id|inverse_effect_id|result"
    || receipt.compensation_id !== record.compensation_id
    || receipt.compensates_effect_id !== record.compensates_effect_id
    || receipt.inverse_effect_id !== record.inverse.effect_id
    || !["completed", "partial"].includes(receipt.result)
  ) return null;
  return receipt.result;
}

function inspectInverseClosure(entryRef, indexes, manifest) {
  const strategy = indexes.strategies.get(entryRef);
  const graph = strategy ? indexes.graphs.get(strategy.flow_graph_ref) : null;
  if (!strategy || !graph || graph.owner_ref !== entryRef || (graph.failure_paths ?? []).length > 0) {
    unsupported();
  }
  if ((strategy.signature?.inputs ?? []).length !== 0) unsupported();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const ordered = [];
  const seen = new Set();
  let nodeId = graph.entry_node_id;
  while (nodeId) {
    if (seen.has(nodeId)) unsupported();
    seen.add(nodeId);
    const node = nodes.get(nodeId);
    if (!node) unsupported();
    ordered.push(node);
    const edges = graph.edges.filter((edge) => edge.from_node_id === nodeId);
    if (edges.some((edge) => edge.role !== "next") || edges.length > 1) unsupported();
    nodeId = edges[0]?.to_node_id ?? null;
  }
  if (seen.size !== graph.nodes.length) unsupported();
  const effectNodes = ordered.filter((node) => node.kind === "call_tool");
  const approvals = ordered.filter((node) => node.kind === "human_approval");
  const effectIndex = ordered.findIndex((node) => node.kind === "call_tool");
  if (
    effectNodes.length !== 1
    || approvals.length > 1
    || effectIndex < 0
    || !["give", "stop"].includes(ordered[effectIndex + 1]?.kind)
    || effectIndex + 2 !== ordered.length
    || ordered.slice(0, effectIndex).some((node) => !["bind", "human_approval"].includes(node.kind))
    || ordered.slice(0, effectIndex).some((node, index) => (
      node.kind === "bind" && ordered.slice(0, index).some((prior) => prior.kind === "human_approval")
    ))
  ) unsupported();
  const inverseToolRef = effectNodes[0].target_ref;
  const binding = manifest.bindings.get(inverseToolRef);
  if (
    !indexes.tools.has(inverseToolRef)
    || binding?.effectContract?.kind !== "external_write"
    || binding.effectContract.compensation
  ) unsupported();
  const approvalRef = approvals.length === 0
    ? null
    : approvals[0].approval_ref ?? `approval:${graph.id}:${approvals[0].id}`;
  return { inverseToolRef, approvalRef };
}

function originalProjection(entry) {
  let effectReceipt = null;
  try {
    if (entry.receipt) {
      const receipt = validateEffectReceipt(entry.receipt, {
        effectId: entry.effect_id,
        requestDigest: entry.request_digest,
      });
      if (
        receipt.outcome === "applied"
        && typeof receipt.receipt_ref === "string"
        && receipt.receipt_ref.length > 0
      ) effectReceipt = structuredClone(receipt);
    }
  } catch {
    effectReceipt = null;
  }
  return {
    tool_ref: entry.tool_ref,
    air_digest: entry.air_digest,
    entry_ref: entry.entry_ref,
    request_digest: entry.request_digest,
    journal_state: entry.state,
    effect_receipt: effectReceipt,
  };
}

function hasUsableOriginalReceipt(entry) {
  if (entry.state !== "applied" || !entry.receipt) return false;
  try {
    const receipt = validateEffectReceipt(entry.receipt, {
      effectId: entry.effect_id,
      requestDigest: entry.request_digest,
    });
    return receipt.outcome === "applied"
      && typeof receipt.receipt_ref === "string"
      && receipt.receipt_ref.length > 0;
  } catch {
    return false;
  }
}

function compensationEnvelope(record) {
  return {
    compensation_id: record.compensation_id,
    compensates_effect_id: record.compensates_effect_id,
    plan_digest: record.inverse.plan_digest,
    execution_request_digest: record.execution_request_digest,
    original_tool_ref: record.original.tool_ref,
    original_request_digest: record.original.request_digest,
    original_effect_receipt_digest: canonicalDigest(record.original.effect_receipt),
    original_effect_receipt: structuredClone(record.original.effect_receipt),
  };
}

function approvalProjection(approvalRef, evidence, compensationId) {
  if (evidence === null || evidence === undefined) {
    return { approval_ref: approvalRef, evidence: null, evidence_digest: null };
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) approvalInvalid();
  const fields = new Set([
    "schema_version", "approval_id", "approval_ref", "subject_ref", "decision", "decided_at", "expires_at",
  ]);
  if (
    Object.keys(evidence).some((key) => !fields.has(key))
    || evidence.schema_version !== "touba-compensation-approval-v1"
    || typeof evidence.approval_id !== "string"
    || evidence.approval_id.length === 0
    || evidence.approval_id.length > 512
    || evidence.approval_ref !== approvalRef
    || evidence.subject_ref !== compensationId
    || evidence.decision !== "approved"
    || !validUtc(evidence.decided_at)
    || !validUtc(evidence.expires_at)
    || Date.parse(evidence.expires_at) <= Date.parse(evidence.decided_at)
    || Buffer.byteLength(JSON.stringify(evidence), "utf8") > 4096
  ) approvalInvalid();
  return {
    approval_ref: approvalRef,
    evidence: structuredClone(evidence),
    evidence_digest: canonicalDigest(evidence),
  };
}

function approvalBlockerCode(approval, now) {
  if (approval === null) return null;
  if (approval.evidence === null) return "CompensationApprovalRequired";
  return Date.parse(approval.evidence.decided_at) <= now.getTime()
    && now.getTime() < Date.parse(approval.evidence.expires_at)
    ? null
    : "CompensationApprovalExpired";
}

function assertApprovalCanProgress(record, now, requiresSpawn) {
  if (!requiresSpawn || record.approval === null) return;
  const blocker = approvalBlockerCode(record.approval, now);
  if (blocker !== null) {
    throw new RuntimeFailure(
      "compensation approval is not currently valid",
      {},
      blocker,
    );
  }
}

async function inverseRequiresSpawn(record, journal) {
  if (!record.inverse) return false;
  const inverse = await readEffectJournalEntry(journal, record.inverse.effect_id);
  return inverse?.state !== "applied";
}

async function checkAuthority(host, input) {
  const request = {
    schema_version: "touba-compensation-authority-request-v1",
    phase: input.phase,
    requester_ref: input.requesterRef,
    journal_scope_ref: input.journalScopeRef,
    compensation_id: input.compensationId,
    compensates_effect_id: input.compensatesEffectId,
    record_revision: input.recordRevision ?? input.record?.revision ?? null,
    plan_digest: input.record?.inverse?.plan_digest ?? null,
    approval: input.approval === null
      ? null
      : {
        approval_ref: input.approval.approval_ref,
        evidence: input.approval.evidence,
        evidence_digest: input.approval.evidence_digest,
      },
    requires_spawn: input.requiresSpawn,
    observed_at: host.now().toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 8192) authorityRefused();
  let timer;
  let answer;
  try {
    answer = await Promise.race([
      Promise.resolve(host.authorityProvider.check(structuredClone(request))),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(Symbol("timeout")), host.authorityTimeoutMs);
      }),
    ]);
  } catch {
    authorityRefused();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (answer !== true) authorityRefused();
}

function localPreparedRecord(base, host, outcome) {
  const trace = localOutcomeTrace(base, outcome, host.airDocument);
  const next = {
    ...base,
    state: outcome.state,
    result: outcome.result,
    blocker_code: outcome.blockerCode,
    pre_checkpoint_trace_state: {
      prefix_digest: tracePrefixDigest(
        base.pre_checkpoint_trace_state.prefix_digest,
        trace,
        0,
      ),
      next_sequence_index: trace.events.at(-1).sequence_index + 1,
    },
  };
  return { record: sealCompensationRecord(next), localTrace: trace };
}

async function persistLocalOutcome(host, record, outcome) {
  const baseTraceState = record.checkpoint?.trace_state ?? record.pre_checkpoint_trace_state;
  const trace = localOutcomeTrace(
    record,
    outcome,
    host.airDocument,
    baseTraceState.next_sequence_index,
  );
  if (record.checkpoint) {
    const checkpoint = sealExecutionCheckpoint({
      ...record.checkpoint,
      revision: record.checkpoint.revision + 1,
      previous_checkpoint_digest: record.checkpoint.checkpoint_digest,
      checkpoint_digest: undefined,
      trace_state: {
        prefix_digest: tracePrefixDigest(baseTraceState.prefix_digest, trace, 0),
        next_sequence_index: trace.events.at(-1).sequence_index + 1,
      },
    });
    record = await replaceRecord(host.store, record, { checkpoint }, host.now);
  } else {
    record = await replaceRecord(host.store, record, {
      pre_checkpoint_trace_state: {
        prefix_digest: tracePrefixDigest(baseTraceState.prefix_digest, trace, 0),
        next_sequence_index: trace.events.at(-1).sequence_index + 1,
      },
    }, host.now);
  }
  publishEvents(host.traceEventObserver, trace.events);
  return replaceRecord(host.store, record, {
    ...(outcome.original ? { original: outcome.original } : {}),
    state: outcome.state,
    result: outcome.result,
    blocker_code: outcome.blockerCode,
  }, host.now);
}

function localOutcomeTrace(record, outcome, airDocument, initialSequence = 0) {
  const entryRef = record.inverse?.entry_ref ?? record.original.entry_ref;
  const builder = new TraceBuilder(
    airDocument,
    entryRef,
    record.run_id,
    null,
    initialSequence,
  );
  builder.push("run_started", { payload: { entry_ref: entryRef } });
  if (outcome.state === "action_required") {
    builder.push("failure_detected", {
      payload: {
        failure_mode: "run",
        compensation_id: record.compensation_id,
        compensates_effect_id: record.compensates_effect_id,
        inverse_effect_id: record.inverse?.effect_id ?? null,
        ...(outcome.result === null ? {} : { result: outcome.result }),
        blocker_code: outcome.blockerCode,
        runtime_error_code: outcome.blockerCode,
      },
    });
  }
  builder.push("run_completed", {
    payload: {
      status: outcome.state === "terminal" ? "success" : "failure",
      compensation_id: record.compensation_id,
      compensates_effect_id: record.compensates_effect_id,
      inverse_effect_id: record.inverse?.effect_id ?? null,
      ...(outcome.result === null ? {} : { result: outcome.result }),
      ...(outcome.state === "action_required" ? { blocker_code: outcome.blockerCode } : {}),
    },
  });
  return builder.document();
}

function emptyTraceState(air, entryRef, runId) {
  const trace = new TraceBuilder(air, entryRef, runId).document();
  return { prefix_digest: tracePrefixDigest(null, trace, 0), next_sequence_index: 0 };
}

function compatibilityProjection(host, planDigest) {
  return {
    schema_version: "touba-compensation-compatibility-v1",
    air_schema_version: host.airDocument.air_schema_version,
    air_digest: airDocumentDigest(host.airDocument),
    manifest_schema_version: host.manifest.version,
    manifest_digest: canonicalDigest(manifestProjection(host.manifest)),
    plan_digest: planDigest,
    run_plan_digest: optionalArtifactDigest(host.runPlan),
    resource_bindings_digest: optionalArtifactDigest(host.resourceBindings),
    supply_chain_lock_digest: optionalArtifactDigest(host.supplyChainLock),
    hardened_profile_digest: optionalArtifactDigest(host.hardenedExecutionProfile),
  };
}

function manifestProjection(manifest) {
  return JSON.parse(JSON.stringify({
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
        effect_contract: {
          ...binding.effectContract,
          ...(binding.effectContract?.compensation
            ? { compensation: { ...binding.effectContract.compensation } }
            : {}),
        },
      }])),
    triggers: Object.fromEntries([...manifest.triggers.entries()]),
    run_limits: Object.fromEntries([...manifest.runLimits.entries()].map(([key, item]) => [key, item.value])),
    agent_secret_scopes: Object.fromEntries([...manifest.agentSecretScopes.entries()]
      .map(([key, item]) => [key, [...item].sort()])),
  }));
}

function optionalArtifactDigest(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)) return value;
  return canonicalDigest(value);
}

async function readRecord(store, compensationId) {
  let raw;
  try {
    raw = await store.read(compensationId);
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    throw new RuntimeFailure("compensation record read failed", {}, "CompensationRecordInvalid");
  }
  return raw === null || raw === undefined ? null : validateCompensationRecord(raw);
}

async function createRecord(store, record) {
  let value;
  try {
    value = await store.createIfAbsent(record);
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    conflict();
  }
  const normalized = validateCompensationRecord(value);
  if (normalized.record_digest !== record.record_digest) conflict();
  return normalized;
}

async function replaceRecord(store, current, changes, now = () => new Date()) {
  const next = sealCompensationRecord({
    ...current,
    ...changes,
    revision: current.revision + 1,
    updated_at: now().toISOString(),
    record_digest: undefined,
  });
  let value;
  try {
    value = await store.compareAndSwap(
      current.compensation_id,
      current.revision,
      current.record_digest,
      next,
    );
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    conflict();
  }
  return validateCompensationRecord(value);
}

async function withProgressLock(store, compensationId, execute) {
  let active = ACTIVE_BY_STORE.get(store);
  if (!active) {
    active = new Set();
    ACTIVE_BY_STORE.set(store, active);
  }
  if (active.has(compensationId)) conflict();
  active.add(compensationId);
  try {
    return await execute();
  } finally {
    active.delete(compensationId);
  }
}

function publishEvents(observer, events) {
  if (observer === null) return;
  for (const event of events) {
    try { observer(structuredClone(event)); } catch { /* observation is non-authoritative */ }
  }
}

function pureReplay(record) {
  return { record: structuredClone(record), trace: null };
}

function requireEffectId(value) {
  if (typeof value !== "string" || !EFFECT_ID.test(value)) requestInvalid();
}

function requireCommandId(value) {
  if (typeof value !== "string" || !COMMAND_ID.test(value)) requestInvalid();
}

function requireBounded(value, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) requestInvalid();
  return value;
}

function rejectUnknown(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.has(key))) requestInvalid();
}

function validUtc(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function requestInvalid() {
  throw new RuntimeFailure("compensation request is invalid", {}, "CompensationRequestInvalid");
}

function requestConflict() {
  throw new RuntimeFailure("compensation request conflicts with existing state", {}, "CompensationRequestConflict");
}

function recordNotFound() {
  throw new RuntimeFailure("compensation record was not found", {}, "CompensationRecordNotFound");
}

function conflict() {
  throw new RuntimeFailure("compensation record changed concurrently", {}, "CompensationConflict");
}

function authorityRefused() {
  throw new RuntimeFailure("compensation authority refused", {}, "CompensationAuthorityRefused");
}

function unsupported() {
  throw new RuntimeFailure("compensation graph is unsupported", {}, "CompensationUnsupportedGraph");
}

function approvalInvalid() {
  throw new RuntimeFailure("compensation approval evidence is invalid", {}, "CompensationApprovalInvalid");
}

function checkpointIncompatible() {
  throw new RuntimeFailure("compensation plan or artifacts changed", {}, "CompensationCheckpointIncompatible");
}
