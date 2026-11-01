import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const digest = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const sha = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function validateTraceReference(value) {
  const end = value?.start_index + value?.event_count - 1;
  if (!exact(value, ["schema_version", "segment_id", "run_id", "start_index", "event_count", "header_digest", "trace_digest", "terminal"])
    || value.schema_version !== "touba-trace-reference-v1" || typeof value.segment_id !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.segment_id)
    || typeof value.run_id !== "string" || !value.run_id || !Number.isSafeInteger(value.start_index) || value.start_index < 0
    || !Number.isSafeInteger(value.event_count) || value.event_count < 2 || !Number.isSafeInteger(end + 1)
    || !sha(value.header_digest) || !sha(value.trace_digest)
    || !exact(value.terminal, ["event_id", "digest", "status", "reason"])
    || ![`event:${value.run_id}:${end + 1}`, `event:${value.run_id}:${value.segment_id}:${end + 1}`].includes(value.terminal.event_id) || !sha(value.terminal.digest)
    || !["success", "stopped", "cancelled", "failure"].includes(value.terminal.status)
    || typeof value.terminal.reason !== "string" || !value.terminal.reason
    || Buffer.byteLength(JSON.stringify(value)) > 32768) throw new TypeError("InvalidTraceReference");
  return value;
}

export function validateTracePage(page, reference, after, limit) {
  const end = reference.start_index + reference.event_count - 1;
  if (!exact(page, ["schema_version", "reference", "header", "events", "next", "done"])
    || page.schema_version !== "touba-trace-page-v1" || !isDeepStrictEqual(page.reference, reference)
    || digest(page.header) !== reference.header_digest || !Array.isArray(page.events) || page.events.length > limit
    || page.header?.run?.run_id !== reference.run_id
    || (page.header.run.segment_id !== undefined && page.header.run.segment_id !== reference.segment_id)
    || page.next !== after + page.events.length || page.next > end || page.done !== (page.next === end)
    || (!page.done && !page.events.length)) throw new TypeError("InvalidTracePage");
  for (const [index, event] of page.events.entries()) {
    const sequence = after + index + 1;
    if (event?.sequence_index !== sequence || event.run_id !== reference.run_id
      || event.event_id !== `event:${reference.run_id}:${page.header.run.segment_id ? `${page.header.run.segment_id}:` : ""}${sequence + 1}` || typeof event.kind !== "string") throw new TypeError("InvalidTracePage");
    if (sequence !== end && event.kind === "run_completed") throw new TypeError("InvalidTracePage");
    if (sequence === end && (event.kind !== "run_completed" || digest(event) !== reference.terminal.digest
      || event.payload?.status !== reference.terminal.status || event.payload?.reason !== reference.terminal.reason)) throw new TypeError("InvalidTracePage");
  }
  return page;
}
