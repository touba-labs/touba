// @ts-check

import { createHash } from "node:crypto";
import { airDocumentDigest } from "./air-identity.mjs";
import { currentTraceInvocation, currentTraceApproval } from "./trace-context.mjs";
import {
  TRACE_CAPABILITY_PROFILE,
  TRACE_PROTOCOL_VERSION,
  failureFamilyForRuntimeCode,
  canonicalizeMachineValue,
} from "../../../contracts/machine/contracts.mjs";

export { TRACE_CAPABILITY_PROFILE, TRACE_PROTOCOL_VERSION };

/**
 * @typedef {object} TraceAirDocument
 * @property {string} air_schema_version
 * @property {{ id: string }} module
 * @property {{ id: string, owner_ref: string }[]=} execution_graphs
 *
 * @typedef {object} TraceEventOptions
 * @property {unknown=} airRef
 * @property {Record<string, any>=} payload
 * @property {string=} message
 *
 * @typedef {object} TraceEvent
 * @property {string} event_id
 * @property {string} run_id
 * @property {number} sequence_index
 * @property {string} kind
 * @property {string} observed_at
 * @property {unknown=} air_ref
 * @property {unknown=} payload
 * @property {string=} message
 */

export class TraceBuilder {
  /**
   * @param {TraceAirDocument} airDocument
   * @param {string} entryRef
   * @param {string} runId
   * @param {((event: TraceEvent) => void) | null} [eventObserver]
   * @param {number} [initialSequenceIndex]
   * @param {"full" | "calls"} [pureFunctionDetail]
   * @param {{openSegment: (header: any, start: number) => string, append: (id: string, event: TraceEvent) => unknown, appendBatch?: (id: string, events: TraceEvent[]) => number, maxBatchBytes?: number, document: (id: string) => any, snapshot: (id: string) => any, events?: (id: string) => Iterable<TraceEvent>} | null} [storage]
   * @param {string | null} [segmentId] Unique identity for a resume attempt.
   */
  constructor(airDocument, entryRef, runId, eventObserver = null, initialSequenceIndex = 0, pureFunctionDetail = "full", storage = null, segmentId = null) {
    this.segmentId = segmentId;
    if (!["full", "calls"].includes(pureFunctionDetail)) throw new TypeError("pureFunctionDetail must be full or calls");
    this.pureFunctionDetail = pureFunctionDetail;
    this.pureGraphs = new Map((airDocument.execution_graphs ?? [])
      .filter(graph => graph.owner_ref.startsWith("function:")).map(graph => [graph.id, graph.owner_ref]));
    this.pureFunctions = new Set(this.pureGraphs.values());
    if (!Number.isSafeInteger(initialSequenceIndex) || initialSequenceIndex < 0) {
      throw new TypeError("initialSequenceIndex must be a non-negative safe integer");
    }
    /** @type {TraceAirDocument} */
    this.airDocument = airDocument;
    const definitions = /** @type {any} */ (airDocument).definitions ?? {};
    this.knownReferences = new Set(Object.values(definitions).flatMap(values => Array.isArray(values) ? values.map(value => value.id) : []));
    this.airDigest = airDocumentDigest(airDocument);
    /** @type {string} */
    this.runId = runId;
    /** @type {string} */
    this.entryRef = entryRef;
    /** @type {TraceEvent[]} */
    this.events = [];
    /** @type {TraceEvent[]} */
    this.pendingEvents = [];
    this.pendingBytes = 0;
    this.completed = false;
    this.maxPendingBytes = Math.min(65536, storage?.maxBatchBytes ?? 65536);
    if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes < 1) throw new TypeError("trace batch byte limit must be a positive safe integer");
    this.eventCount = 0;
    this.spanCount = 0;
    this.spanRoot = this;
    /** @type {number} */
    this.initialSequenceIndex = initialSequenceIndex;
    /** @type {((event: TraceEvent) => void) | null} */
    this.eventObserver = eventObserver;
    this.storage = storage;
    this.storageSegment = storage?.openSegment(this.header(), initialSequenceIndex) ?? null;
    if (storage !== null && (typeof this.storageSegment !== "string" || !this.storageSegment)) {
      throw new TypeError("trace storage must synchronously return a segment identifier");
    }
  }

  /**
   * @param {string} kind
   * @param {TraceEventOptions} [options]
   * @returns {TraceEvent | null}
   */
  push(kind, options = {}) {
    const graphRef = /** @type {{ flow_graph_ref?: string } | undefined} */ (options.airRef)?.flow_graph_ref;
    const pureOwner = graphRef === undefined ? undefined : this.pureGraphs.get(graphRef);
    if (this.pureFunctionDetail === "calls" && pureOwner !== undefined) {
      const internal = ["branch_evaluated", "loop_evaluated", "binding_created"].includes(kind);
      const successfulScope = pureOwner !== this.entryRef
        && (kind === "scope_entered" || kind === "scope_exited" && options.payload?.status === "success");
      if (internal || successfulScope) return null;
    }
    const rawPayload = kind === "failure_detected" && options.payload
      ? {
        ...options.payload,
        failure_family: options.payload.failure_family
          ?? failureFamilyForRuntimeCode(
            options.payload.runtime_error_code,
            options.payload.failure_mode,
          ),
      }
      : options.payload;
    // Free model explanations may repeat private business input. Keep their
    // presence, not their text or an attackable public hash. This applies
    // before storage, observers and export, including human-review events.
    const publicPayload = rawPayload === undefined ? undefined : { ...rawPayload };
    const approvalRequestId = currentTraceApproval(this);
    if (publicPayload && approvalRequestId) publicPayload.approval_request_id = approvalRequestId;
    if (publicPayload) {
      delete publicPayload.provider_cause;
      // A rejected provider target may itself contain copied private input.
      if (typeof publicPayload.selected_ref === "string" && !this.knownReferences.has(publicPayload.selected_ref)) {
        delete publicPayload.selected_ref;
        publicPayload.selected_ref_unresolved = true;
      }
      if (publicPayload.request_digest && kind.startsWith("agent_decision_provider")) {
        publicPayload.request_digest_scope = "redacted_metadata";
      }
    }
    if (publicPayload && (["agent_decision_recorded", "agent_direct_answer_returned", "agent_capability_selected",
      "agent_decision_provider_returned", "agent_decision_catalog_requested", "agent_human_review_requested"].includes(kind)
      || (kind.startsWith("human_approval") && publicPayload.mode === "agent_review" && kind !== "human_approval_pause_refused"))) {
      if (publicPayload.reason !== undefined) {
        publicPayload.reason_present = true;
        delete publicPayload.reason;
      }
      for (const key of ["reported_reason", "review_reason", "review_prompt"]) {
        if (publicPayload[key] !== undefined) { publicPayload[`${key}_present`] = true; delete publicPayload[key]; }
      }
    }
    const traceContext = currentTraceInvocation(this);
    const correlatedPayload = traceContext ? { ...publicPayload, trace_context: traceContext } : publicPayload;
    const payload = correlatedPayload === undefined
      ? undefined
      : jsonPortableTraceValue(correlatedPayload);
    const sequenceIndex = this.initialSequenceIndex + this.eventCount;
    if (!Number.isSafeInteger(sequenceIndex + 1)) throw new RangeError("trace sequence index cannot advance safely");
    const event = /** @type {TraceEvent} */ (compactPayload({
      event_id: `event:${this.runId}:${this.segmentId ? `${this.segmentId}:` : ""}${sequenceIndex + 1}`,
      run_id: this.runId,
      sequence_index: sequenceIndex,
      observed_at: new Date().toISOString(),
      kind,
      air_ref: options.airRef,
      payload,
      message: ["AgentCapabilityNotAllowed", "CompositionCapabilityNotAllowed"].includes(publicPayload?.runtime_error_code)
        ? "capability is outside the declared authority" : options.message,
    }));
    if (this.storage !== null && this.storageSegment !== null) {
      const localDetail = graphRef !== undefined
        && ["binding_created", "branch_evaluated", "loop_evaluated"].includes(kind);
      const pureScope = pureOwner !== undefined
        && (kind === "scope_entered" || kind === "scope_exited" && payload?.status === "success");
      const pureCall = (kind === "call_started" || kind === "call_completed")
        && this.pureFunctions.has(payload?.target_ref)
        && payload?.resumed_from_checkpoint !== true && payload?.compensation_id === undefined;
      const batchable = localDetail || pureScope || pureCall;
      const bytes = batchable ? Buffer.byteLength(JSON.stringify(event)) : 0;
      if (batchable && !this.completed && this.storage.appendBatch && bytes <= this.maxPendingBytes) {
        if (this.pendingEvents.length >= 32 || this.pendingBytes + bytes > this.maxPendingBytes) this.flush();
        this.pendingEvents.push(event); this.pendingBytes += bytes;
      } else {
        // Authority, effect and terminal events flush preceding local
        // observations before publishing their own durable evidence.
        this.flush();
        const committed = this.storage.append(this.storageSegment, event);
        if (committed !== true) throw new TypeError("trace storage must synchronously acknowledge a new durable event with true");
        if (kind === "run_completed") this.completed = true;
      }
    } else this.events.push(event);
    this.eventCount += 1;
    if (this.eventObserver !== null) {
      try {
        this.eventObserver(structuredClone(event));
      } catch {
        // Observability must not change runtime semantics.
      }
    }
    return event;
  }

  /** @returns {number} */
  nextSequenceIndex() {
    return this.initialSequenceIndex + this.eventCount;
  }

  allocateSpanId() {
    // Delegating branch traces use Object.create(builder); the allocator must
    // remain on the root builder, not on a shadow object for each branch.
    const root = this.spanRoot ?? this;
    root.spanRoot = root;
    return `span:${root.runId}:${root.segmentId ? `${root.segmentId}:` : ""}${root.initialSequenceIndex}:${++root.spanCount}`;
  }

  flush() {
    if (!this.pendingEvents.length) return;
    if (!this.storage?.appendBatch || this.storageSegment === null) throw new TypeError("trace batch storage is missing");
    const committed = this.storage.appendBatch(this.storageSegment, this.pendingEvents);
    if (committed !== this.pendingEvents.length) throw new TypeError("trace storage must synchronously acknowledge every event in the batch");
    this.pendingEvents = []; this.pendingBytes = 0;
  }

  /** @returns {Iterable<TraceEvent>} */
  *iterateEvents() {
    this.flush();
    if (this.storage !== null && this.storageSegment !== null) {
      if (!this.storage.events) throw new TypeError("trace storage requires a bounded events iterator");
      yield* this.storage.events(this.storageSegment);
    } else yield* this.events;
  }

  /** @param {boolean} [canonical] JSON digest without materializing the document. */
  digest(canonical = false) {
    const header = this.header();
    const digest = createHash("sha256").update(canonical ? '{"events":[' : JSON.stringify(header).slice(0, -1) + ',"events":[');
    let separator = "";
    for (const event of this.iterateEvents()) {
      digest.update(separator).update(canonical ? canonicalizeMachineValue(event) : JSON.stringify(event)); separator = ",";
    }
    digest.update("]");
    if (canonical) {
      for (const key of Object.keys(header).sort()) {
        digest.update("," + JSON.stringify(key) + ":" + canonicalizeMachineValue(/** @type {Record<string, unknown>} */ (header)[key]));
      }
    }
    return digest.update("}").digest("hex");
  }

  /**
   * @returns {{ trace_protocol_version: string, trace_capability_profile: string, run: { run_id: string, air_schema_version: string, air_digest: string, module_ref: string, entry_ref: string, pure_function_detail?: string }, events: TraceEvent[] }}
   */
  document() {
    this.flush();
    if (this.storage !== null && this.storageSegment !== null) return this.storage.document(this.storageSegment);
    return { ...this.header(), events: this.events };
  }

  /** Fixed prefix for checkpoint/result consumers. The host keeps storage open. */
  snapshot() {
    this.flush();
    if (this.storage !== null && this.storageSegment !== null) return this.storage.snapshot(this.storageSegment);
    const document = structuredClone(this.document());
    const startIndex = this.initialSequenceIndex;
    return Object.freeze({
      segmentId: null, startIndex, eventCount: document.events.length,
      nextSequenceIndex: startIndex + document.events.length,
      header: this.header(),
      *events({ after = startIndex - 1 } = {}) {
        for (const event of document.events) if (event.sequence_index > after) yield structuredClone(event);
      },
      *json() { yield JSON.stringify(document); },
      document() { return structuredClone(document); },
    });
  }

  /** Preserve the JSON trace field while making bounded reads available to hosts.
   * @param {Record<string, any>} envelope
   * @param {any} [reader]
   */
  attach(envelope, reader = this.snapshot()) {
    return attachTraceReader(envelope, reader, this.storage === null);
  }

  header() {
    return {
      trace_protocol_version: TRACE_PROTOCOL_VERSION,
      trace_capability_profile: TRACE_CAPABILITY_PROFILE,
      run: {
        run_id: this.runId,
        ...(this.segmentId ? { segment_id: this.segmentId } : {}),
        air_schema_version: this.airDocument.air_schema_version,
        air_digest: this.airDigest,
        module_ref: this.airDocument.module.id,
        entry_ref: this.entryRef,
        ...(this.pureFunctionDetail === "calls" ? { pure_function_detail: "calls" } : {}),
      },
    };
  }
}

/** Attach a fixed reader without copying its event history.
 * @param {Record<string, any>} envelope
 * @param {any} reader
 * @param {boolean} [materialize]
 */
export function attachTraceReader(envelope, reader, materialize = false) {
  Object.defineProperties(envelope, {
    trace: materialize
      ? { enumerable: true, value: reader.document(), writable: true }
      : { enumerable: true, get: () => reader.document() },
    traceReader: { enumerable: false, value: reader },
  });
  return envelope;
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
export function compactPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null),
  );
}

/**
 * Trace events are hashed before durable dispatch. Normalize the same nested
 * `undefined` values that JSON serialization would otherwise silently drop so
 * the in-memory trace is already canonical and its digest is stable.
 *
 * @param {unknown} value
 * @returns {any}
 */
function jsonPortableTraceValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : jsonPortableTraceValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, jsonPortableTraceValue(item)]),
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function sha256Json(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
