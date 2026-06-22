#!/usr/bin/env node

import crypto from "node:crypto";
import {
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TRACE_AUDIT_SCHEMA_VERSION = "trace-audit-v0.1";
export const TRACE_AUDIT_VALIDATION_SCHEMA_VERSION = "trace-audit-validation-v0.1";
export const TRACE_AUDIT_EXPORT_SCHEMA_VERSION = "trace-audit-export-v0.1-local";
export const TRACE_TIMELINE_SCHEMA_VERSION = "touba-trace-timeline-v1";

const TRACE_PROTOCOL_VERSION = "trace-minimal-v0.1";
const AIR_SCHEMA_VERSION = "air-minimal-v0.1";
const MANIFEST_VERSION = "touba-manifest-v1";
const DIGEST_KIND = "sha256";
const RUNTIME_NAME = "touba-audit";
const RUNTIME_VERSION = "0.1.0";
const TRACE_AUDIT_REPORT_SUFFIX = ".trace-audit-report.json";
const TRACE_TIMELINE_SUFFIX = ".trace-timeline.json";

const RETENTION_CLASSES = new Set([
  "local_debug",
  "project_audit",
  "security_review",
  "regulated_export",
]);
const REDACTION_POLICIES = new Set([
  "no_secrets",
  "no_secrets_no_raw_prompts",
  "no_secrets_no_raw_prompts_no_memory_content",
]);

const ARTIFACT_DIGEST_FIELDS = {
  trace: "trace_digest",
  air: "air_digest",
  source: "source_digest",
  manifest: "manifest_digest",
};

const SECRET_KEYS = new Set([
  "secret_value",
  "resolved_secret",
  "api_key",
  "token",
  "password",
  "credential",
  "credentials",
  "connection_string",
  "database_url",
]);
const PROMPT_KEYS = new Set([
  "raw_prompt",
  "prompt_text",
  "model_prompt",
  "raw_messages",
  "messages",
]);
const MEMORY_CONTENT_KEYS = new Set([
  "memory_content",
  "raw_memory_content",
  "document_content",
  "sql_row",
  "raw_row",
]);
const HOST_PATH_KEYS = new Set(["host_path", "workspace_path", "home_path"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const implementationDir = path.resolve(__dirname, "../../..");

const defaultFs = {
  existsSync: defaultExistsSync,
  mkdirSync: defaultMkdirSync,
  readFileSync: defaultReadFileSync,
  writeFileSync: defaultWriteFileSync,
};

export function loadTraceAuditArtifacts(paths, options = {}) {
  const fs = fsAdapter(options);
  const artifacts = {};
  if (paths.trace) {
    artifacts.trace = readJsonArtifact(paths.trace, "trace", fs);
  }
  if (paths.air) {
    artifacts.air = readJsonArtifact(paths.air, "air", fs);
  }
  if (paths.source) {
    artifacts.source = readTextArtifact(paths.source, "source", fs);
  }
  if (paths.manifest) {
    artifacts.manifest = readJsonArtifact(paths.manifest, "manifest", fs);
  }
  if (paths.auditManifest) {
    artifacts.auditManifest = readJsonArtifact(paths.auditManifest, "audit_manifest", fs);
  }
  return artifacts;
}

export function createTraceAuditManifest(artifacts, options = {}) {
  const runId = artifacts.trace?.json?.run?.run_id || options.runId || "run:absent";
  const artifactDigests = {};
  for (const [artifactName, digestField] of Object.entries(ARTIFACT_DIGEST_FIELDS)) {
    const artifact = artifacts[artifactName];
    if (artifact) {
      artifactDigests[digestField] = {
        kind: DIGEST_KIND,
        value: artifact.digest,
      };
    }
  }

  return {
    trace_audit_schema_version: TRACE_AUDIT_SCHEMA_VERSION,
    trace_ref: `trace:${runId}`,
    run_id: runId,
    created_at: options.createdAt || new Date().toISOString(),
    runtime: {
      name: options.runtimeName || RUNTIME_NAME,
      version: options.runtimeVersion || RUNTIME_VERSION,
    },
    artifacts: artifactDigests,
    retention: {
      class: options.retentionClass || "local_debug",
      delete_after: options.deleteAfter ?? null,
    },
    redaction: {
      policy: options.redactionPolicy || "no_secrets_no_raw_prompts_no_memory_content",
    },
  };
}

export function validateTraceAuditArtifacts(artifacts, options = {}) {
  const diagnostics = [];
  const manifestProvided = Boolean(artifacts.auditManifest);
  const auditManifest = manifestProvided
    ? artifacts.auditManifest.json
    : createTraceAuditManifest(artifacts, options);

  validateAuditManifestShape(auditManifest, diagnostics);
  validateRuntimeArtifactVersions(artifacts, diagnostics);
  validateRunCoherence(auditManifest, artifacts.trace?.json, diagnostics);
  validateDigests(auditManifest, artifacts, manifestProvided, diagnostics);
  validateTraceAirCoherence(artifacts.trace?.json, artifacts.air?.json, diagnostics);
  validateSourceRefs(artifacts, diagnostics);
  validateRedaction(artifacts, auditManifest, diagnostics);

  const status = diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? "failed"
    : diagnostics.some((diagnostic) => diagnostic.severity === "warning")
      ? "warning"
      : "ok";

  const report = {
    trace_audit_validation_schema_version: TRACE_AUDIT_VALIDATION_SCHEMA_VERSION,
    trace_audit_schema_version: auditManifest?.trace_audit_schema_version,
    status,
    checked: {
      trace_schema: Boolean(artifacts.trace),
      trace_air_coherence: Boolean(artifacts.trace && artifacts.air),
      source_refs: Boolean(artifacts.source && (artifacts.trace || artifacts.air)),
      digests: true,
      redaction: true,
    },
    diagnostics,
  };

  return {
    traceAuditManifest: auditManifest,
    validationReport: report,
  };
}

export function createTraceAuditExport(artifacts, validation) {
  const exportDocument = {
    trace_audit_export_schema_version: TRACE_AUDIT_EXPORT_SCHEMA_VERSION,
    trace_audit_manifest: validation.traceAuditManifest,
    validation_report: validation.validationReport,
    artifacts: {},
  };
  if (artifacts.trace) {
    exportDocument.artifacts.trace = artifacts.trace.json;
  }
  if (artifacts.air) {
    exportDocument.artifacts.air = artifacts.air.json;
  }
  if (artifacts.source) {
    exportDocument.artifacts.source = {
      source_id: artifacts.source.path,
      text: artifacts.source.text,
    };
  }
  if (artifacts.manifest) {
    exportDocument.artifacts.manifest = artifacts.manifest.json;
  }
  return exportDocument;
}

export function createTraceTimeline(trace, options = {}) {
  if (!trace || trace.trace_protocol_version !== TRACE_PROTOCOL_VERSION) {
    throw new Error(`expected ${TRACE_PROTOCOL_VERSION} trace for timeline export`);
  }
  const runId = trace.run?.run_id || options.runId || "run:absent";
  const events = Array.isArray(trace.events) ? trace.events : [];
  return {
    schema_version: TRACE_TIMELINE_SCHEMA_VERSION,
    run_id: runId,
    trace_ref: options.traceRef || `trace:${runId}`,
    events: events.map((event, arrayIndex) => timelineEvent(event, trace, arrayIndex)),
  };
}

export function renderTraceAuditValidation(validation) {
  const report = validation.validationReport;
  const manifest = validation.traceAuditManifest;
  const digestNames = Object.keys(manifest?.artifacts || {});
  const lines = [
    `Touba Trace Audit ${TRACE_AUDIT_VALIDATION_SCHEMA_VERSION}`,
    `Status ${report.status}`,
    `Run ${manifest?.run_id || "absent"}`,
    `Retention ${manifest?.retention?.class || "absent"}`,
    `Redaction ${manifest?.redaction?.policy || "absent"}`,
    `Digests ${digestNames.length > 0 ? digestNames.join(", ") : "absent"}`,
  ];

  if (report.diagnostics.length === 0) {
    lines.push("Diagnostics ok");
  } else {
    lines.push("Diagnostics:");
    for (const diagnostic of report.diagnostics) {
      lines.push(
        `- ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${diagnostic.artifact ? ` [${diagnostic.artifact}]` : ""}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function timelineEvent(event, trace, arrayIndex) {
  const index = Number.isInteger(event?.sequence_index) ? event.sequence_index : arrayIndex;
  const payload = isPlainObject(event?.payload) ? event.payload : {};
  return {
    index,
    type: timelineEventType(event?.kind),
    timestamp: timelineTimestamp(event, payload, index),
    severity: timelineSeverity(event, payload),
    summary: timelineSummary(event, payload, trace),
    source_ref: timelineSourceRef(event, payload),
    redaction: timelineRedaction(event, payload),
  };
}

function timelineEventType(kind) {
  return typeof kind === "string" && kind.trim() !== ""
    ? kind.replaceAll("_", ".")
    : "event.unknown";
}

function timelineTimestamp(event, payload, index) {
  for (const value of [
    event?.timestamp,
    event?.observed_at,
    event?.created_at,
    payload.observed_at,
    payload.received_at,
    payload.started_at,
    payload.completed_at,
  ]) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return `sequence:${index}`;
}

function timelineSeverity(event, payload) {
  const kind = typeof event?.kind === "string" ? event.kind : "";
  const status = safeToken(payload.status);
  if (
    payload.runtime_error_code
    || payload.error_code
    || status === "failure"
    || /(failed|exceeded|invalid|error|denied|rejected)/u.test(kind)
  ) {
    return "error";
  }
  if (status === "cancelled" || /(refused|cancelled|timeout|paused)/u.test(kind)) {
    return "warning";
  }
  return "info";
}

function timelineSummary(event, payload, trace) {
  const kind = typeof event?.kind === "string" ? event.kind : "unknown";
  const targetRef = firstSafeToken(
    payload.target_ref,
    payload.tool_ref,
    payload.skill_ref,
    payload.agent_ref,
    payload.trigger_ref,
    payload.capability_ref,
    payload.selected_ref,
    payload.memory_ref,
    payload.resource_ref,
  );
  const status = safeToken(payload.status);
  const code = firstSafeToken(payload.runtime_error_code, payload.error_code);
  const runEntry = safeToken(trace?.run?.entry_ref);

  if (kind === "run_started") {
    return runEntry ? `Run started for ${runEntry}.` : "Run started.";
  }
  if (kind === "run_completed") {
    return status ? `Run completed with status ${status}.` : "Run completed.";
  }
  if (kind === "call_started") {
    return targetRef ? `Capability ${targetRef} started.` : "Capability call started.";
  }
  if (kind === "call_completed") {
    return targetRef ? `Capability ${targetRef} completed.` : "Capability call completed.";
  }
  if (kind === "call_failed") {
    return code
      ? `Capability call failed with ${code}.`
      : targetRef
        ? `Capability ${targetRef} failed.`
        : "Capability call failed.";
  }
  if (kind === "trigger_event_received") {
    return targetRef ? `Trigger event received for ${targetRef}.` : "Trigger event received.";
  }
  if (kind === "trigger_event_accepted") {
    return targetRef ? `Trigger event accepted for ${targetRef}.` : "Trigger event accepted.";
  }
  if (kind === "trigger_event_refused") {
    return code
      ? `Trigger event refused with ${code}.`
      : targetRef
        ? `Trigger event refused for ${targetRef}.`
        : "Trigger event refused.";
  }
  if (kind === "trigger_execution_completed") {
    return status ? `Trigger execution completed with status ${status}.` : "Trigger execution completed.";
  }
  if (kind === "human_approval_requested" || kind === "human_review_requested") {
    return targetRef ? `Human review requested for ${targetRef}.` : "Human review requested.";
  }
  if (kind === "human_approval_paused" || kind === "human_review_paused") {
    return targetRef ? `Run paused for human review of ${targetRef}.` : "Run paused for human review.";
  }
  if (kind === "human_approval_resolved" || kind === "human_review_resolved") {
    return status ? `Human review resolved with status ${status}.` : "Human review resolved.";
  }
  if (kind === "agent_decision_requested") {
    const mode = safeToken(payload.mode);
    return mode
      ? `Agent decision requested in ${mode} mode.`
      : "Agent decision requested.";
  }
  if (kind === "agent_capability_selected") {
    return targetRef ? `Agent selected ${targetRef}.` : "Agent selected a capability.";
  }
  if (kind === "agent_decision_failed") {
    return code ? `Agent decision failed with ${code}.` : "Agent decision failed.";
  }
  if (kind === "budget_limit_exceeded" || kind === "dispatch_refused_budget_exceeded") {
    const budgetKind = safeToken(payload.budget_kind);
    return budgetKind ? `Budget ${budgetKind} exceeded.` : "Budget exceeded.";
  }
  if (kind === "run_cancel_requested") {
    return "Run cancellation requested.";
  }
  if (kind === "run_cancelled") {
    return "Run cancelled.";
  }
  if (kind === "run_timeout_exceeded") {
    return "Run timeout exceeded.";
  }
  if (kind === "kill_switch_enabled") {
    return "Kill switch enabled.";
  }
  if (kind === "dispatch_refused_cancelled") {
    return targetRef ? `Dispatch refused after cancellation for ${targetRef}.` : "Dispatch refused after cancellation.";
  }
  if (kind === "memory_access_authorized") {
    return targetRef ? `Memory access authorized for ${targetRef}.` : "Memory access authorized.";
  }
  if (kind === "memory_access_refused") {
    return targetRef ? `Memory access refused for ${targetRef}.` : "Memory access refused.";
  }
  if (kind === "tool_binding_authorized") {
    return targetRef ? `Tool binding authorized for ${targetRef}.` : "Tool binding authorized.";
  }
  if (kind === "tool_binding_refused") {
    return targetRef ? `Tool binding refused for ${targetRef}.` : "Tool binding refused.";
  }
  if (code) {
    return `${timelineEventType(kind)} recorded with ${code}.`;
  }
  return `${timelineEventType(kind)} recorded.`;
}

function timelineSourceRef(event, payload) {
  return firstSafeToken(
    payload.target_ref,
    payload.tool_ref,
    payload.skill_ref,
    payload.agent_ref,
    payload.trigger_ref,
    payload.capability_ref,
    payload.selected_ref,
    payload.memory_ref,
    payload.resource_ref,
    event?.air_ref?.owner_ref,
    event?.air_ref?.node_id,
  ) || null;
}

function timelineRedaction(event, payload) {
  if (containsSensitiveKey(event) || containsSensitiveKey(payload)) {
    return "secrets_redacted";
  }
  if (
    payload.content_mode === "opaque_refs"
    || payload.external_content_count !== undefined
    || payload.payload_sha256 !== undefined
    || payload.payload_bytes !== undefined
    || payload.approx_size_bytes !== undefined
    || payload.input_ref !== undefined
  ) {
    return "payload_minimized";
  }
  return "none";
}

function containsSensitiveKey(value) {
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveKey(item));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      SECRET_KEYS.has(normalized)
      || PROMPT_KEYS.has(normalized)
      || MEMORY_CONTENT_KEYS.has(normalized)
      || /secret|credential|password|token|api[_-]?key/u.test(normalized)
    ) {
      return true;
    }
    if (containsSensitiveKey(nested)) {
      return true;
    }
  }
  return false;
}

function firstSafeToken(...values) {
  for (const value of values) {
    const token = safeToken(value);
    if (token) {
      return token;
    }
  }
  return undefined;
}

function safeToken(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9_./:@-]{1,160}$/u.test(trimmed) ? trimmed : undefined;
}

function validateAuditManifestShape(manifest, diagnostics) {
  if (!isPlainObject(manifest)) {
    diagnostics.push(error("TraceAuditManifestInvalid", "audit manifest must be an object"));
    return;
  }
  if (manifest.trace_audit_schema_version !== TRACE_AUDIT_SCHEMA_VERSION) {
    diagnostics.push(error("TraceAuditSchemaMismatch", "unsupported trace audit schema", "audit_manifest"));
  }
  if (!isPlainObject(manifest.artifacts)) {
    diagnostics.push(error("TraceAuditManifestInvalid", "artifacts must be an object", "audit_manifest", "artifacts"));
  }
  if (!RETENTION_CLASSES.has(manifest.retention?.class)) {
    diagnostics.push(
      error("TraceAuditRetentionClassUnsupported", "unsupported retention class", "audit_manifest", "retention.class"),
    );
  }
  if (!REDACTION_POLICIES.has(manifest.redaction?.policy)) {
    diagnostics.push(
      error("TraceAuditRedactionPolicyUnsupported", "unsupported redaction policy", "audit_manifest", "redaction.policy"),
    );
  }
  for (const [field, digest] of Object.entries(manifest.artifacts || {})) {
    validateDigestShape(field, digest, diagnostics);
  }
  scanUnsupportedClaims(manifest, "audit_manifest", diagnostics);
}

function validateRuntimeArtifactVersions(artifacts, diagnostics) {
  if (artifacts.trace?.json?.trace_protocol_version !== TRACE_PROTOCOL_VERSION) {
    diagnostics.push(error("TraceAuditManifestInvalid", "unsupported trace protocol", "trace"));
  }
  if (artifacts.air && artifacts.air.json?.air_schema_version !== AIR_SCHEMA_VERSION) {
    diagnostics.push(error("TraceAuditManifestInvalid", "unsupported AIR schema", "air"));
  }
  if (artifacts.manifest && artifacts.manifest.json?.manifest_version !== MANIFEST_VERSION) {
    diagnostics.push(error("TraceAuditManifestInvalid", "unsupported runtime manifest schema", "manifest"));
  }
}

function validateRunCoherence(auditManifest, trace, diagnostics) {
  if (!trace || !auditManifest) {
    return;
  }
  if (auditManifest.run_id !== trace.run?.run_id) {
    diagnostics.push(error("TraceAuditRunMismatch", "audit manifest run_id does not match trace", "trace"));
  }
}

function validateDigests(auditManifest, artifacts, manifestProvided, diagnostics) {
  if (!isPlainObject(auditManifest?.artifacts)) {
    return;
  }
  for (const [artifactName, digestField] of Object.entries(ARTIFACT_DIGEST_FIELDS)) {
    const artifact = artifacts[artifactName];
    if (!artifact) {
      continue;
    }
    const digest = auditManifest.artifacts[digestField];
    if (!digest) {
      if (manifestProvided) {
        diagnostics.push(error("TraceAuditDigestMissing", "digest missing for provided artifact", artifactName, digestField));
      }
      continue;
    }
    if (digest.kind !== DIGEST_KIND) {
      diagnostics.push(error("TraceAuditDigestUnsupported", "unsupported digest kind", artifactName, digestField));
      continue;
    }
    if (!isSha256Hex(digest.value)) {
      diagnostics.push(error("TraceAuditDigestInvalid", "invalid digest value", artifactName, digestField));
      continue;
    }
    if (digest.value !== artifact.digest) {
      diagnostics.push(error("TraceAuditDigestMismatch", "artifact digest does not match", artifactName, digestField));
    }
  }
}

function validateDigestShape(field, digest, diagnostics) {
  if (!isPlainObject(digest)) {
    diagnostics.push(error("TraceAuditDigestInvalid", "digest must be an object", "audit_manifest", field));
    return;
  }
  if (digest.kind !== DIGEST_KIND) {
    diagnostics.push(error("TraceAuditDigestUnsupported", "unsupported digest kind", "audit_manifest", field));
  }
  if (!isSha256Hex(digest.value)) {
    diagnostics.push(error("TraceAuditDigestInvalid", "invalid digest value", "audit_manifest", field));
  }
}

function validateTraceAirCoherence(trace, air, diagnostics) {
  if (!trace) {
    return;
  }
  validateTraceSequence(trace, diagnostics);

  if (!air) {
    return;
  }
  if (trace.run?.module_ref !== air.module?.id) {
    diagnostics.push(error("TraceAirModuleMismatch", "trace module_ref does not match AIR module id", "air"));
  }

  const entryRefs = collectAirEntryRefs(air);
  if (trace.run?.entry_ref && !entryRefs.has(trace.run.entry_ref)) {
    diagnostics.push(error("TraceAirEntryMissing", "trace entry_ref is absent from AIR", "air"));
  }

  const graphIndex = new Map();
  for (const graph of Array.isArray(air.execution_graphs) ? air.execution_graphs : []) {
    graphIndex.set(
      graph.id,
      new Set((Array.isArray(graph.nodes) ? graph.nodes : []).map((node) => node.id)),
    );
  }

  for (const event of Array.isArray(trace.events) ? trace.events : []) {
    const airRef = event.air_ref;
    if (!airRef?.flow_graph_ref) {
      continue;
    }
    const nodeIds = graphIndex.get(airRef.flow_graph_ref);
    if (!nodeIds) {
      diagnostics.push(
        error("TraceAirRefMissing", "trace event references an AIR graph absent from AIR", "air", "air_ref.flow_graph_ref", event.event_id),
      );
      continue;
    }
    if (airRef.node_id && !nodeIds.has(airRef.node_id)) {
      diagnostics.push(
        error("TraceAirRefMissing", "trace event references an AIR node absent from AIR", "air", "air_ref.node_id", event.event_id),
      );
    }
  }
}

function validateTraceSequence(trace, diagnostics) {
  const events = Array.isArray(trace.events) ? trace.events : [];
  let previous = -1;
  const seen = new Set();
  for (const event of events) {
    const index = event.sequence_index;
    if (!Number.isInteger(index) || index <= previous || seen.has(index)) {
      diagnostics.push(error("TraceSequenceInvalid", "trace sequence_index must be strictly increasing", "trace", "sequence_index", event.event_id));
      return;
    }
    seen.add(index);
    previous = index;
  }
}

function validateSourceRefs(artifacts, diagnostics) {
  if (!artifacts.source) {
    return;
  }
  const expectedSourceId = path.resolve(artifacts.source.path);
  for (const { sourceRef, artifact } of collectSourceRefs(artifacts)) {
    if (!sourceIdMatchesPath(sourceRef.source_id, expectedSourceId)) {
      diagnostics.push(error("SourceRefMismatch", "source_ref does not match explicit source artifact", artifact, "source_ref"));
      return;
    }
  }
}

function sourceIdMatchesPath(sourceId, expectedSourceId) {
  const value = String(sourceId);
  return [
    path.resolve(value),
    path.resolve(implementationDir, value),
  ].some((candidate) => candidate === expectedSourceId);
}

function validateRedaction(artifacts, auditManifest, diagnostics) {
  scanSensitiveContent(auditManifest, "audit_manifest", diagnostics);
  for (const artifactName of ["trace", "air", "manifest"]) {
    if (artifacts[artifactName]) {
      scanSensitiveContent(artifacts[artifactName].json, artifactName, diagnostics);
    }
  }
  if (artifacts.source) {
    scanSensitiveContent(artifacts.source.text, "source", diagnostics);
  }
}

function scanSensitiveContent(value, artifact, diagnostics, state = {}) {
  if (Array.isArray(value)) {
    for (const item of value) {
      scanSensitiveContent(item, artifact, diagnostics, state);
    }
    return;
  }
  if (isPlainObject(value)) {
    const eventKind = typeof value.kind === "string" ? value.kind : state.eventKind;
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      if (SECRET_KEYS.has(normalized)) {
        diagnostics.push(error("TraceAuditSecretLeakDetected", "sensitive secret-shaped field detected", artifact, key));
      } else if (PROMPT_KEYS.has(normalized)) {
        diagnostics.push(error("TraceAuditPromptLeakDetected", "raw prompt-shaped field detected", artifact, key));
      } else if (MEMORY_CONTENT_KEYS.has(normalized)) {
        diagnostics.push(error("TraceAuditMemoryContentLeakDetected", "raw memory-shaped field detected", artifact, key));
      } else if (HOST_PATH_KEYS.has(normalized)) {
        diagnostics.push(error("TraceAuditHostPathLeakDetected", "host path field detected", artifact, key));
      } else if (eventKind === "user_interaction_answered" && ["answer", "value", "response"].includes(normalized)) {
        diagnostics.push(error("TraceAuditUserInputLeakDetected", "raw user input field detected", artifact, key));
      }
      scanSensitiveContent(nested, artifact, diagnostics, { eventKind });
    }
    scanUnsupportedClaims(value, artifact, diagnostics);
    return;
  }
  if (typeof value === "string") {
    if (/TOUBA_SHOULD_NOT_LEAK|secret value|sk-live-|DATABASE_URL=/i.test(value)) {
      diagnostics.push(error("TraceAuditSecretLeakDetected", "sensitive string marker detected", artifact));
    }
    if (value === "Verified" || value === "Unverified") {
      diagnostics.push(error("TraceAuditVerifiedClaimUnsupported", "Verified/Unverified claim unsupported", artifact));
    }
  }
}

function scanUnsupportedClaims(value, artifact, diagnostics) {
  if (!isPlainObject(value)) {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(value, "compliant")) {
    diagnostics.push(error("TraceAuditComplianceClaimUnsupported", "compliance claim unsupported", artifact, "compliant"));
  }
  if (Object.prototype.hasOwnProperty.call(value, "legally_valid")) {
    diagnostics.push(error("TraceAuditComplianceClaimUnsupported", "legal validity claim unsupported", artifact, "legally_valid"));
  }
  if (Object.prototype.hasOwnProperty.call(value, "signature_valid")) {
    diagnostics.push(error("TraceAuditSignatureClaimUnsupported", "signature claim unsupported", artifact, "signature_valid"));
  }
  if (value.verification_status === "Verified" || value.verification_status === "Unverified") {
    diagnostics.push(error("TraceAuditVerifiedClaimUnsupported", "Verified/Unverified claim unsupported", artifact, "verification_status"));
  }
}

function collectAirEntryRefs(air) {
  const refs = new Set();
  for (const group of Object.values(air.definitions || {})) {
    if (Array.isArray(group)) {
      for (const declaration of group) {
        if (typeof declaration.id === "string") {
          refs.add(declaration.id);
        }
      }
    }
  }
  for (const graph of Array.isArray(air.execution_graphs) ? air.execution_graphs : []) {
    if (typeof graph.owner_ref === "string") {
      refs.add(graph.owner_ref);
    }
  }
  return refs;
}

function collectSourceRefs(artifacts) {
  const refs = [];
  for (const artifactName of ["trace", "air"]) {
    const artifact = artifacts[artifactName];
    if (artifact) {
      collectSourceRefsFromValue(artifact.json, artifactName, refs);
    }
  }
  return refs;
}

function collectSourceRefsFromValue(value, artifact, refs) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSourceRefsFromValue(item, artifact, refs);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  if (isPlainObject(value.source_ref) && typeof value.source_ref.source_id === "string") {
    refs.push({ sourceRef: value.source_ref, artifact });
  }
  for (const nested of Object.values(value)) {
    collectSourceRefsFromValue(nested, artifact, refs);
  }
}

function readJsonArtifact(filePath, kind, fs) {
  const textArtifact = readTextArtifact(filePath, kind, fs);
  try {
    return {
      ...textArtifact,
      json: JSON.parse(textArtifact.text),
    };
  } catch (error_) {
    throw new Error(`invalid JSON for ${kind}: ${error_.message}`);
  }
}

function readTextArtifact(filePath, kind, fs) {
  const resolved = path.resolve(filePath);
  assertExistingFile(resolved, fs);
  const text = fs.readFileSync(resolved, "utf8");
  return {
    kind,
    path: resolved,
    text,
    digest: sha256(text),
  };
}

function writeJsonFile(filePath, document, fs) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function writeTraceAuditReport(filePath, validation, fs) {
  assertReportOutputPath(filePath, TRACE_AUDIT_REPORT_SUFFIX);
  if (validation?.validationReport?.trace_audit_validation_schema_version !== TRACE_AUDIT_VALIDATION_SCHEMA_VERSION) {
    throw new Error("trace audit report must contain trace-audit-validation-v0.1");
  }
  writeJsonFile(filePath, validation, fs);
}

function assertReportOutputPath(filePath, suffix) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("--report-out requires a non-empty path");
  }
  if (!path.basename(path.resolve(filePath)).endsWith(suffix)) {
    throw new Error(`--report-out path must end with ${suffix}`);
  }
}

function assertTimelineOutputPath(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("--timeline-out requires a non-empty path");
  }
  if (!path.basename(path.resolve(filePath)).endsWith(TRACE_TIMELINE_SUFFIX)) {
    throw new Error(`--timeline-out path must end with ${TRACE_TIMELINE_SUFFIX}`);
  }
}

function assertExistingFile(filePath, fs) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing file ${filePath}`);
  }
}

function fsAdapter(options) {
  return options.fs || defaultFs;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function error(code, message, artifact, field, eventId) {
  const diagnostic = {
    severity: "error",
    code,
    message,
  };
  if (artifact) {
    diagnostic.artifact = artifact;
  }
  if (field) {
    diagnostic.field = field;
  }
  if (eventId) {
    diagnostic.event_id = eventId;
  }
  return diagnostic;
}

function parseArgs(argv) {
  const options = {
    output: "text",
    retentionClass: "local_debug",
    redactionPolicy: "no_secrets_no_raw_prompts_no_memory_content",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`missing value for ${arg}`);
      }
      return argv[index];
    };
    if (arg === "--trace") {
      options.trace = next();
    } else if (arg === "--air") {
      options.air = next();
    } else if (arg === "--source") {
      options.source = next();
    } else if (arg === "--manifest") {
      options.manifest = next();
    } else if (arg === "--audit-manifest") {
      options.auditManifest = next();
    } else if (arg === "--retention-class") {
      options.retentionClass = next();
    } else if (arg === "--redaction-policy") {
      options.redactionPolicy = next();
    } else if (arg === "--export") {
      options.exportPath = next();
    } else if (arg === "--report-out") {
      options.reportOutPath = next();
    } else if (arg === "--timeline-out") {
      options.timelineOutPath = next();
    } else if (arg === "--output") {
      options.output = next();
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function renderUsage() {
  return `Usage: touba-audit --trace <trace.json> [--air <air.json>] [--source <file.tb>] [--manifest <touba.manifest.json>] [--audit-manifest <trace-audit.json>] [--export <export.json>] [--report-out <report.trace-audit-report.json>] [--timeline-out <timeline.trace-timeline.json>] [--output text|json]\n`;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(renderUsage());
    return 0;
  }
  if (!options.trace) {
    throw new Error("missing required --trace");
  }
  if (!["text", "json"].includes(options.output)) {
    throw new Error("--output must be text or json");
  }

  const artifacts = loadTraceAuditArtifacts(options);
  const validation = validateTraceAuditArtifacts(artifacts, {
    retentionClass: options.retentionClass,
    redactionPolicy: options.redactionPolicy,
  });

  if (options.exportPath && validation.validationReport.status === "ok") {
    writeJsonFile(options.exportPath, createTraceAuditExport(artifacts, validation), defaultFs);
  }
  if (options.timelineOutPath && validation.validationReport.status === "ok") {
    assertTimelineOutputPath(options.timelineOutPath);
    writeJsonFile(options.timelineOutPath, createTraceTimeline(artifacts.trace.json), defaultFs);
  }
  if (options.reportOutPath) {
    writeTraceAuditReport(options.reportOutPath, validation, defaultFs);
  }

  if (options.output === "json") {
    process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  } else {
    process.stdout.write(renderTraceAuditValidation(validation));
  }

  return validation.validationReport.status === "ok" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error_) {
    process.stderr.write(`trace audit error: ${error_.message}\n`);
    process.stderr.write(renderUsage());
    process.exitCode = 2;
  }
}
