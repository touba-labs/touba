import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const keys = ["schema_version", "segment_id", "run_id", "start_index", "event_count", "header_digest", "trace_digest", "terminal"];
/** @param {any} value */
export const traceJsonDigest = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
/** @param {any} value @param {string[]} fields */
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
/** @param {any} value */
export function validateTraceReference(value) {
  const end = value?.start_index + value?.event_count - 1;
  if (!exact(value, keys) || value.schema_version !== "touba-trace-reference-v1"
    || typeof value.segment_id !== "string" || !UUID.test(value.segment_id) || typeof value.run_id !== "string" || !value.run_id
    || !Number.isSafeInteger(value.start_index) || value.start_index < 0
    || !Number.isSafeInteger(value.event_count) || value.event_count < 2 || !Number.isSafeInteger(end + 1)
    || typeof value.header_digest !== "string" || !SHA.test(value.header_digest)
    || typeof value.trace_digest !== "string" || !SHA.test(value.trace_digest)
    || !exact(value.terminal, ["event_id", "digest", "status", "reason"])
    || ![`event:${value.run_id}:${end + 1}`, `event:${value.run_id}:${value.segment_id}:${end + 1}`].includes(value.terminal.event_id)
    || typeof value.terminal.digest !== "string" || !SHA.test(value.terminal.digest)
    || !["success", "stopped", "cancelled", "failure"].includes(value.terminal.status)
    || typeof value.terminal.reason !== "string" || !value.terminal.reason
    || Buffer.byteLength(JSON.stringify(value)) > 32768) {
    throw Object.assign(new TypeError("invalid trace reference"), { code: "TraceReferenceInvalid" });
  }
  return value;
}

/** @param {any} reader */
export function createTraceReference(reader) {
  if (!reader?.segmentId || !reader.complete) throw new TypeError("trace references require a completed durable segment");
  const header = reader.header;
  const hash = createHash("sha256").update(JSON.stringify(header).slice(0, -1) + ',"events":[');
  let terminal, count = 0;
  for (const event of reader.events()) {
    hash.update(count++ ? "," : "").update(JSON.stringify(event)); terminal = event;
  }
  if (count !== reader.eventCount || terminal?.kind !== "run_completed") throw new TypeError("trace segment has no matching terminal");
  return validateTraceReference({
    schema_version: "touba-trace-reference-v1", segment_id: reader.segmentId,
    run_id: header.run.run_id, start_index: reader.startIndex, event_count: count,
    header_digest: traceJsonDigest(header), trace_digest: `sha256:${hash.update("]}").digest("hex")}`,
    terminal: { event_id: terminal.event_id, digest: traceJsonDigest(terminal),
      status: terminal.payload.status, reason: terminal.payload.reason },
  });
}

// Validate the transport envelope independently of whole-trace validation.
// The journal checks persisted content; a page proves only its bounded slice.
/** @param {any} page @param {any} reference @param {number} after @param {number} [limit] */
export function validateTracePage(page, reference, after, limit = 1000) {
  validateTraceReference(reference);
  const end = reference.start_index + reference.event_count - 1;
  if (!Number.isSafeInteger(after) || after < reference.start_index - 1 || after > end
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
    || !exact(page, ["schema_version", "reference", "header", "events", "next", "done"])
    || page.schema_version !== "touba-trace-page-v1" || !isDeepStrictEqual(page.reference, reference)
    || traceJsonDigest(page.header) !== reference.header_digest || page.header?.run?.run_id !== reference.run_id
    || (page.header.run.segment_id !== undefined && page.header.run.segment_id !== reference.segment_id)
    || !Array.isArray(page.events) || page.events.length > limit
    || page.next !== after + page.events.length || page.next > end || page.done !== (page.next === end)
    || (!page.done && !page.events.length)) throw new TypeError("InvalidTracePage");
  for (const [index, event] of page.events.entries()) {
    const sequence = after + index + 1;
    if (event?.sequence_index !== sequence || event.run_id !== reference.run_id
      || event.event_id !== `event:${reference.run_id}:${page.header.run.segment_id ? `${page.header.run.segment_id}:` : ""}${sequence + 1}`
      || (sequence === reference.start_index && event.kind !== "run_started")
      || (sequence !== end && event.kind === "run_completed")) throw new TypeError("InvalidTracePage");
    if (sequence === end && (event.kind !== "run_completed" || traceJsonDigest(event) !== reference.terminal.digest
      || event.payload?.status !== reference.terminal.status || event.payload?.reason !== reference.terminal.reason)) throw new TypeError("InvalidTracePage");
  }
  return page;
}
