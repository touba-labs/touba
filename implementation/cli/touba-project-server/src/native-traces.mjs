import { createHash } from "node:crypto";
import { canonicalDigest } from "@touba/runtime";
import { validateTraceAuditArtifacts } from "../../touba-audit/src/audit.mjs";
import { NATIVE_TRACE_SCHEMA, NATIVE_TRACE_LIMITS, readNativeTraceIndex, nativeTraceExportChunks, logicalRunDigest } from "./native-trace-journal.mjs";
export { NATIVE_TRACE_SCHEMA, NATIVE_TRACE_LIMITS, withNativeTrace, readNativeTraceIndex, readNativeTracePage, nativeTraceExportChunks } from "./native-trace-journal.mjs";
const PHASES = ["initial", "human_resume", "execution_resume", "human_terminal"];
const STATES = ["recording", "paused", "terminal", "unavailable"];
const REASONS = [null, "not_completed", "runtime_rejected", "trace_rejected", "storage_limit"];
function fail(code) { throw Object.assign(new Error(code), { code }); }
function seal(segment) { const { digest, ...body } = segment; return { ...body, digest: canonicalDigest(body) }; }
function auditTrace(trace, runId) {
  if (trace?.run?.run_id !== runId) fail("ToubaServeNativeTraceStoreInvalid");
  const digest = createHash("sha256").update(JSON.stringify(trace)).digest("hex");
  let validation;
  try { validation = validateTraceAuditArtifacts({ trace: { json: trace, digest } }); }
  catch { fail("ToubaServeNativeTraceRejected"); }
  if (validation.validationReport.status !== "ok") fail("ToubaServeNativeTraceRejected");
}

export function validateNativeTraceExport(value) {
  if (value?.schema_version !== NATIVE_TRACE_SCHEMA || typeof value.run_id !== "string" || !value.run_id.length || value.run_id.length > 256
    || !Array.isArray(value.segments) || value.segments.length === 0 || value.segments.length > NATIVE_TRACE_LIMITS.segments
    || Object.keys(value).some(key => !["schema_version", "run_id", "complete", "segments"].includes(key))) fail("ToubaServeNativeTraceStoreInvalid");
  let previous = null;
  let identity = null;
  for (const [index, segment] of value.segments.entries()) {
    if (!segment || segment.index !== index || !PHASES.includes(segment.phase) || !STATES.includes(segment.state)
      || !REASONS.includes(segment.reason) || (index > 0 && segment.phase === "initial")
      || segment.previous_digest !== previous || seal(segment).digest !== segment.digest
      || Object.keys(segment).some(key => !["index", "phase", "state", "reason", "previous_digest", "trace", "digest"].includes(key))) fail("ToubaServeNativeTraceStoreInvalid");
    if (["paused", "terminal"].includes(segment.state)) {
      if (segment.reason !== null) fail("ToubaServeNativeTraceStoreInvalid");
      auditTrace(segment.trace, value.run_id);
      const current = logicalRunDigest(segment.trace.run);
      if (identity !== null && current !== identity) fail("ToubaServeNativeTraceStoreInvalid");
      identity = current;
    } else if (segment.trace !== null || segment.reason === null
      || (segment.state === "recording" && segment.reason !== "not_completed")
      || (segment.state === "unavailable" && segment.reason === "not_completed")) fail("ToubaServeNativeTraceStoreInvalid");
    previous = segment.digest;
  }
  const complete = value.segments[0].phase === "initial"
    && value.segments.every(segment => ["paused", "terminal"].includes(segment.state))
    && value.segments.at(-1).state === "terminal";
  if (value.complete !== complete) fail("ToubaServeNativeTraceStoreInvalid");
  return value;
}

export function readNativeTraceExport(projectRoot, runId) {
  if (!readNativeTraceIndex(projectRoot, runId)) return null;
  const chunks = []; let bytes = 0;
  for (const chunk of nativeTraceExportChunks(projectRoot, runId)) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > NATIVE_TRACE_LIMITS.runBytes) fail("TraceMaterializationLimitExceeded");
    chunks.push(chunk);
  }
  return validateNativeTraceExport(JSON.parse(chunks.join("")));
}
