// @ts-check

import { createHash } from "node:crypto";
import { airDocumentDigest } from "./air-identity.mjs";
import {
  TRACE_CAPABILITY_PROFILE,
  TRACE_PROTOCOL_VERSION,
  failureFamilyForRuntimeCode,
} from "../../../contracts/machine/contracts.mjs";

export { TRACE_CAPABILITY_PROFILE, TRACE_PROTOCOL_VERSION };

/**
 * @typedef {object} TraceAirDocument
 * @property {string} air_schema_version
 * @property {{ id: string }} module
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
   */
  constructor(airDocument, entryRef, runId, eventObserver = null, initialSequenceIndex = 0) {
    if (!Number.isSafeInteger(initialSequenceIndex) || initialSequenceIndex < 0) {
      throw new TypeError("initialSequenceIndex must be a non-negative safe integer");
    }
    /** @type {TraceAirDocument} */
    this.airDocument = airDocument;
    this.airDigest = airDocumentDigest(airDocument);
    /** @type {string} */
    this.runId = runId;
    /** @type {string} */
    this.entryRef = entryRef;
    /** @type {TraceEvent[]} */
    this.events = [];
    /** @type {number} */
    this.initialSequenceIndex = initialSequenceIndex;
    /** @type {((event: TraceEvent) => void) | null} */
    this.eventObserver = eventObserver;
  }

  /**
   * @param {string} kind
   * @param {TraceEventOptions} [options]
   * @returns {TraceEvent}
   */
  push(kind, options = {}) {
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
    const payload = rawPayload === undefined
      ? undefined
      : jsonPortableTraceValue(rawPayload);
    const sequenceIndex = this.initialSequenceIndex + this.events.length;
    const event = /** @type {TraceEvent} */ (compactPayload({
      event_id: `event:${this.runId}:${sequenceIndex + 1}`,
      run_id: this.runId,
      sequence_index: sequenceIndex,
      kind,
      air_ref: options.airRef,
      payload,
      message: options.message,
    }));
    this.events.push(event);
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
    return this.initialSequenceIndex + this.events.length;
  }

  /**
   * @returns {{ trace_protocol_version: string, trace_capability_profile: string, run: { run_id: string, air_schema_version: string, air_digest: string, module_ref: string, entry_ref: string }, events: TraceEvent[] }}
   */
  document() {
    return {
      trace_protocol_version: TRACE_PROTOCOL_VERSION,
      trace_capability_profile: TRACE_CAPABILITY_PROFILE,
      run: {
        run_id: this.runId,
        air_schema_version: this.airDocument.air_schema_version,
        air_digest: this.airDigest,
        module_ref: this.airDocument.module.id,
        entry_ref: this.entryRef,
      },
      events: this.events,
    };
  }
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
