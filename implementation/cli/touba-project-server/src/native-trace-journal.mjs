import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalDigest } from "@touba/runtime";
import { canonicalizeMachineValue, validateTraceMachineStream } from "../../../contracts/machine/contracts.mjs";
import { createTraceReference, validateTraceReference } from "../../../contracts/trace-reference.mjs";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { scanSensitiveContent } from "../../touba-audit/src/audit.mjs";
import { indexedStore } from "../../../runtime/touba-runtime/src/sqlite-record-store.mjs";

export const NATIVE_TRACE_SCHEMA = "touba-run-trace-export-v1";
export const NATIVE_TRACE_LIMITS = Object.freeze({ bytes: 128 * 1024 * 1024, runBytes: 8 * 1024 * 1024, segments: 256 });
const INDEX_SCHEMA = "touba-native-trace-index-v1";
const PHASES = ["initial", "human_resume", "execution_resume", "human_terminal"];
const STATES = ["recording", "paused", "terminal", "unavailable"];
const REASONS = [null, "not_completed", "runtime_rejected", "trace_rejected", "storage_limit"];
const active = new Set();
// Segment identity varies on each resume; AIR, entry and run identity must not.
// Each complete header (including segment_id) remains sealed by its reference.
export function logicalRunDigest(run) {
  const { segment_id, ...identity } = run;
  return canonicalDigest(identity);
}
function fail(code) { throw Object.assign(new Error(code), { code }); }
function seal(segment) { const { digest, ...body } = segment; return { ...body, digest: canonicalDigest(body) }; }
function complete(value) { return value.segments[0].phase === "initial" && value.segments.every(s => ["paused", "terminal"].includes(s.state)) && value.segments.at(-1).state === "terminal"; }
function validateIndex(value) {
  if (value?.schema_version !== INDEX_SCHEMA || typeof value.run_id !== "string" || !value.run_id || value.run_id.length > 256
    || !Array.isArray(value.segments) || !value.segments.length || value.segments.length > NATIVE_TRACE_LIMITS.segments
    || Object.keys(value).some(k => !["schema_version", "run_id", "complete", "segments"].includes(k))) fail("ToubaServeNativeTraceStoreInvalid");
  let previous = null;
  for (const [i, segment] of value.segments.entries()) {
    if (segment.index !== i || !PHASES.includes(segment.phase) || (i && segment.phase === "initial")
      || !STATES.includes(segment.state) || !REASONS.includes(segment.reason)
      || segment.previous_digest !== previous || seal(segment).digest !== segment.digest
      || Object.keys(segment).some(k => !["index", "phase", "state", "reason", "previous_digest", "reference", "digest"].includes(k))) fail("ToubaServeNativeTraceStoreInvalid");
    if (["paused", "terminal"].includes(segment.state)) {
      validateTraceReference(segment.reference);
      if (segment.reference.run_id !== value.run_id || segment.reason !== null) fail("ToubaServeNativeTraceStoreInvalid");
    } else if (segment.reference !== null || segment.reason === null
      || (segment.state === "recording") !== (segment.reason === "not_completed")) fail("ToubaServeNativeTraceStoreInvalid");
    previous = segment.digest;
  }
  if (value.complete !== complete(value)) fail("ToubaServeNativeTraceStoreInvalid");
  return value;
}
function indexStore(root) {
  if (existsSync(join(root, ".touba/native-traces"))) fail("ToubaServeStateMigrationRequired");
  // SQLite enforces the physical page quota in the same transaction. A point
  // update must not scan all historical records to recompute a byte total.
  const store = indexedStore({ path: join(root, ".touba/native-traces.sqlite"), schemaVersion: INDEX_SCHEMA,
    keyOf: value => value.run_id, validate: validateIndex, maxBytes: NATIVE_TRACE_LIMITS.bytes });
  return Object.fromEntries(Object.entries(store).map(([name, operation]) => [name, (...args) => {
    try { return operation(...args); }
    catch (error) {
      if (error.code === "ToubaStoreCapacityExceeded" || error.errcode === 13) fail("ToubaServeNativeTraceStorageFull");
      throw error;
    }
  }]));
}
function journal(root, readOnly = true) { return createSqliteTraceStore({ filename: join(root, ".touba/traces.sqlite"), readOnly }); }
export function readNativeTraceIndex(root, runId) { return indexStore(root).read([{ id: runId }])[0] ?? null; }
export function readNativeTracePage(root, runId, segmentIndex, options = {}) {
  const index = readNativeTraceIndex(root, runId);
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) fail("ToubaServeNativeTracePageInvalid");
  const reference = index?.segments[segmentIndex]?.reference;
  if (!reference) return null;
  const store = journal(root);
  try { return store.readReference(reference, options); } finally { store.close(); }
}
function* canonicalTrace(reader) {
  yield '{"events":[';
  let sep = "";
  for (const event of reader.events()) { yield sep + canonicalizeMachineValue(event); sep = ","; }
  yield "]";
  const header = reader.header;
  for (const key of Object.keys(header).sort()) yield "," + JSON.stringify(key) + ":" + canonicalizeMachineValue(header[key]);
  yield "}";
}
function exportSeal(body, reader) {
  const hash = createHash("sha256");
  hash.update(canonicalizeMachineValue(body).slice(0, -1) + ',"trace":');
  if (reader) for (const chunk of canonicalTrace(reader)) hash.update(chunk);
  else hash.update("null");
  return "sha256:" + hash.update("}").digest("hex");
}
// The public export remains trace-v1; the HTTP host awaits every output chunk.
export function* nativeTraceExportChunks(root, runId) {
  const value = readNativeTraceIndex(root, runId);
  if (!value) fail("ToubaServeNativeTraceUnavailable");
  const store = value.segments.some(s => s.reference) ? journal(root) : null;
  try {
    yield JSON.stringify({ schema_version: NATIVE_TRACE_SCHEMA, run_id: runId, complete: value.complete }).slice(0, -1) + ',"segments":[';
    let previous = null, separator = "", identity;
    for (const segment of value.segments) {
      let reader = null;
      if (segment.reference) {
        store.readReference(segment.reference, { limit: 1 });
        reader = store.snapshot(segment.reference.segment_id);
        const current = logicalRunDigest(reader.header.run);
        if (identity && current !== identity) fail("ToubaServeNativeTraceStoreInvalid");
        identity = current;
      }
      const body = { index: segment.index, phase: segment.phase, state: segment.state, reason: segment.reason, previous_digest: previous };
      const digest = exportSeal(body, reader);
      yield separator + JSON.stringify(body).slice(0, -1) + ',"trace":';
      if (reader) yield* reader.json(); else yield "null";
      yield ',"digest":' + JSON.stringify(digest) + "}";
      separator = ","; previous = digest;
    }
    yield "]}";
  } finally { store?.close(); }
}
function validateReader(reader, runId, secrets) {
  if (reader.header.run.run_id !== runId) fail("ToubaServeNativeTraceRejected");
  validateTraceMachineStream(reader.header, reader.events());
  for (const value of (function* () { yield reader.header; yield* reader.events(); })()) {
    const diagnostics = [];
    scanSensitiveContent(value, "trace", diagnostics);
    if (diagnostics.length) fail("ToubaServeNativeTraceRejected");
    const raw = JSON.stringify(value);
    if (secrets.some(s => typeof s === "string" && s && raw.includes(JSON.stringify(s).slice(1, -1)))) fail("ToubaServeNativeTraceRejected");
  }
}
export async function withNativeTrace({ projectRoot, runId, phase, origin, secretValues = [] }, execute) {
  if (!PHASES.includes(phase)) fail("ToubaServeNativeTracePhaseInvalid");
  if (typeof runId !== "string" || !runId || runId.length > 256) fail("ToubaServeNativeTraceRunInvalid");
  const key = JSON.stringify([projectRoot, runId]);
  if (active.has(key)) fail("ToubaServeNativeTraceRunConflict");
  active.add(key);
  try {
    mkdirSync(join(projectRoot, ".touba"), { recursive: true, mode: 0o700 });
    const index = indexStore(projectRoot), records = index.read([{ id: runId }]);
    let value = records[0];
    if (value && phase === "initial") fail("ToubaServeNativeTraceRunConflict");
    if (!value) { value = { schema_version: INDEX_SCHEMA, run_id: runId, complete: false, segments: [] }; records.push(value); }
    if (value.segments.length >= NATIVE_TRACE_LIMITS.segments) fail("ToubaServeNativeTraceStorageFull");
    const number = value.segments.length;
    value.complete = false;
    value.segments.push(seal({ index: number, phase, state: "recording", reason: "not_completed", previous_digest: value.segments.at(-1)?.digest ?? null, reference: null }));
    index.write(records);
    let result;
    try { result = await execute(); }
    catch (error) {
      value.segments[number] = seal({ ...value.segments[number], state: "unavailable", reason: "runtime_rejected" });
      index.write(records); throw error;
    }
    let reference = null, reason = null, store;
    try {
      let reader = result.traceReader;
      if (!reader) { const { events, ...header } = result.trace; reader = { header, events: () => events }; }
      validateReader(reader, runId, secretValues);
      store = journal(projectRoot, false);
      if (phase === 'initial' && origin) store.recordOrigin(runId, origin);
      const previous = value.segments.find(s => s.reference)?.reference;
      if (previous && logicalRunDigest(store.header(previous.segment_id).run) !== logicalRunDigest(reader.header.run)) fail("ToubaServeNativeTraceRejected");
      let stored;
      if (reader.segmentId) {
        try { stored = store.snapshot(reader.segmentId); }
        catch (error) { if (error.code !== "TraceSegmentMissing") throw error; }
      }
      if (!stored) {
        const first = reader.events()[Symbol.iterator]().next().value;
        const id = store.openSegment(reader.header, first.sequence_index);
        let batch = [], bytes = 0;
        for (const event of reader.events()) {
          const size = Buffer.byteLength(JSON.stringify(event));
          if (batch.length && (batch.length === 32 || bytes + size > 64 * 1024)) {
            store.appendBatch(id, batch); batch = []; bytes = 0;
          }
          batch.push(event); bytes += size;
        }
        if (batch.length) store.appendBatch(id, batch);
        stored = store.snapshot(id);
      }
      reference = createTraceReference(stored);
    } catch (error) { reason = error.code === "TraceStorageLimitExceeded" ? "storage_limit" : "trace_rejected"; }
    finally { store?.close(); }
    value.segments[number] = seal({ ...value.segments[number], state: reference ? result.checkpoint ? "paused" : "terminal" : "unavailable", reason, reference });
    value.complete = complete(value); index.write(records);
    return result;
  } finally { active.delete(key); }
}
