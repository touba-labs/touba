import { mkdirSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { canonicalDigest } from "@touba/runtime";
import { validateTraceAuditArtifacts } from "../../touba-audit/src/audit.mjs";

export const NATIVE_TRACE_SCHEMA = "touba-run-trace-export-v1";
export const NATIVE_TRACE_LIMITS = Object.freeze({ runs: 1024, bytes: 128 * 1024 * 1024, runBytes: 8 * 1024 * 1024, segments: 256 });
const PHASES = ["initial", "human_resume", "execution_resume", "human_terminal"];
const STATES = ["recording", "paused", "terminal", "unavailable"];
const REASONS = [null, "not_completed", "runtime_rejected", "trace_rejected", "storage_limit"];
const active = new Set();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function io(action) {
  try { return action(); }
  catch (error) {
    if (error.code?.startsWith("ToubaServeNativeTrace")) throw error;
    fail("ToubaServeNativeTraceStorageUnavailable");
  }
}
function directory(projectRoot, create = true) {
  const path = join(projectRoot, ".touba", "native-traces");
  io(() => {
    if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
    try { if (!lstatSync(path).isDirectory()) fail("ToubaServeNativeTraceStoreInvalid"); }
    catch (error) { if (create || error.code !== "ENOENT") throw error; }
  });
  return path;
}
function filePath(root, runId) {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 256) fail("ToubaServeNativeTraceRunInvalid");
  return join(root, `${createHash("sha256").update(runId).digest("hex")}.json`);
}
function size(path) {
  const stat = lstatSync(path);
  if (!stat.isFile()) fail("ToubaServeNativeTraceStoreInvalid");
  return stat.size;
}
function usage(root) {
  return io(() => {
    let bytes = 0;
    let runs = 0;
    for (const name of readdirSync(root)) {
      if (!/^[a-f0-9]{64}\.json(?:\.[a-f0-9]{16}\.tmp)?$/u.test(name)) fail("ToubaServeNativeTraceStoreInvalid");
      bytes += size(join(root, name));
      if (name.endsWith(".json")) runs += 1;
    }
    return { bytes, runs };
  });
}
function read(path) {
  try {
    if (size(path) > NATIVE_TRACE_LIMITS.runBytes) fail("ToubaServeNativeTraceStoreInvalid");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("ToubaServeNativeTraceStoreInvalid");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("ToubaServeNativeTraceStoreInvalid");
  }
}
function save(path, value) {
  return io(() => {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  });
}
function seal(segment) {
  const { digest: ignored, ...body } = segment;
  return { ...body, digest: canonicalDigest(body) };
}
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
      const current = canonicalDigest(segment.trace.run);
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
  const value = read(filePath(directory(projectRoot, false), runId));
  if (value === null) return null;
  if (value.run_id !== runId) fail("ToubaServeNativeTraceStoreInvalid");
  return validateNativeTraceExport(value);
}

// This wrapper records runtime documents, never UI events or checkpoint contents.
// Its open marker survives a process death. It intentionally cannot claim a
// complete trace for a process that died before returning its native document.
export async function withNativeTrace({ projectRoot, runId, phase, secretValues = [] }, execute) {
  const key = filePath(directory(projectRoot), runId);
  if (active.has(key)) fail("ToubaServeNativeTraceRunConflict");
  active.add(key);
  try { return await record({ projectRoot, runId, phase, secretValues }, execute); }
  finally { active.delete(key); }
}

async function record({ projectRoot, runId, phase, secretValues }, execute) {
  if (!PHASES.includes(phase)) fail("ToubaServeNativeTracePhaseInvalid");
  const root = directory(projectRoot);
  const path = filePath(root, runId);
  const stored = read(path);
  const previous = stored === null ? null : validateNativeTraceExport(stored);
  if (previous && previous.run_id !== runId) fail("ToubaServeNativeTraceStoreInvalid");
  const value = previous ?? { schema_version: NATIVE_TRACE_SCHEMA, run_id: runId, complete: false, segments: [] };
  if (phase === "initial" && previous !== null) fail("ToubaServeNativeTraceRunConflict");
  const current = usage(root);
  const beforeBytes = previous === null ? 0 : size(path);
  if ((previous === null && current.runs >= NATIVE_TRACE_LIMITS.runs)
    || value.segments.length >= NATIVE_TRACE_LIMITS.segments
    || beforeBytes + 2048 > NATIVE_TRACE_LIMITS.runBytes
    || current.bytes + 2048 > NATIVE_TRACE_LIMITS.bytes) fail("ToubaServeNativeTraceStorageFull");
  const index = value.segments.length;
  value.complete = false;
  value.segments.push(seal({ index, phase, state: "recording", reason: "not_completed", previous_digest: value.segments.at(-1)?.digest ?? null, trace: null }));
  save(path, value);
  let result;
  try { result = await execute(); }
  catch (error) {
    value.segments[index] = seal({ ...value.segments[index], state: "unavailable", reason: "runtime_rejected" });
    save(path, value);
    throw error;
  }
  // Reload: other runs may have completed concurrently, but a run itself is
  // serialized by serve's operation/decision arbiter.
  const latest = read(path);
  if (latest?.segments?.[index]?.digest !== value.segments[index].digest || latest.segments.length !== index + 1) fail("ToubaServeNativeTraceRunConflict");
  let trace = result.trace;
  let reason = null;
  try {
    auditTrace(trace, runId);
    const first = value.segments.find(segment => segment.trace !== null)?.trace;
    if (first && canonicalDigest(first.run) !== canonicalDigest(trace.run)) fail("ToubaServeNativeTraceRejected");
    const raw = JSON.stringify(trace);
    if (secretValues.some(secret => typeof secret === "string" && secret.length > 0 && raw.includes(JSON.stringify(secret).slice(1, -1)))) fail("ToubaServeNativeTraceRejected");
  } catch { trace = null; reason = "trace_rejected"; }
  value.segments[index] = seal({ ...value.segments[index], state: trace === null ? "unavailable" : result.checkpoint ? "paused" : "terminal", reason, trace });
  value.complete = value.segments[0].phase === "initial" && value.segments.every(segment => ["paused", "terminal"].includes(segment.state)) && value.segments.at(-1).state === "terminal";
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > NATIVE_TRACE_LIMITS.runBytes || usage(root).bytes - size(path) + bytes > NATIVE_TRACE_LIMITS.bytes) {
    value.segments[index] = seal({ ...value.segments[index], state: "unavailable", reason: "storage_limit", trace: null });
    value.complete = false;
  }
  save(path, value);
  return result;
}
