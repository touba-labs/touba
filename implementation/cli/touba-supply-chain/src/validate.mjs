#!/usr/bin/env node

import crypto from "node:crypto";
import {
  existsSync as defaultExistsSync,
  accessSync as defaultAccessSync,
  constants,
  realpathSync as defaultRealpathSync,
  statSync as defaultStatSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pythonModuleEntrypoint } from "./python-module.mjs";
import { PACKAGE_LOCK, readPackageWorkspace, verifyInstalledPackages } from "../../touba-project/src/package-store.mjs";

import {
  TOUBA_MANIFEST_V1,
  validateManifestEffectContracts,
} from "../../touba-manifest/src/effect-contract.mjs";

export const SUPPLY_CHAIN_LOCK_SCHEMA_VERSION = "touba-lock-v1";
export const SUPPLY_CHAIN_VALIDATION_SCHEMA_VERSION = "touba-supply-chain-validation-v1";

const AIR_SCHEMA_VERSION = "touba-air-v1";
const MANIFEST_VERSIONS = new Set([TOUBA_MANIFEST_V1]);
const DIGEST_KIND = "sha256";
const EXPECTED_HANDLER_SDK_NAMES = new Set(["@touba/sdk", "touba-sdk"]);
const HANDLER_SDK_PROTOCOL_V1 = "touba-tool-handler-v1";
// These releases share the v1 handler contract. Keep the list explicit: a
// future SDK version must be qualified before strict admission accepts it.
const SUPPORTED_HANDLER_SDK_VERSIONS = new Set(["1.0.0", "1.1.0", "1.2.0"]);
const SUPPORTED_HANDLER_PACKAGE_KINDS = new Set(["local"]);
const SUPPLY_CHAIN_REPORT_SUFFIX = ".supply-chain-report.json";

const AUTHORITY_KEYS = new Set([
  "grants",
  "secrets",
  "memory_scopes",
  "callable_by",
  "trigger_limits",
  "policy",
  "permissions",
  "approval",
]);

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

const CONTENT_KEYS = new Set([
  "handler_source",
  "source_code",
  "raw_prompt",
  "prompt_text",
  "payload",
  "raw_payload",
  "answer",
  "memory_content",
  "raw_memory_content",
]);

const DEPENDENCY_AUDIT_CLAIM_KEYS = new Set([
  "dependency_audit",
  "dependency_audit_status",
  "dependencies_audited",
  "vulnerability_audit",
  "vulnerability_audit_status",
]);

const TRUST_CLAIM_KEYS = new Set([
  "compliance",
  "compliance_status",
  "verified",
  "verification_status",
  "trust",
  "trust_level",
]);

const PROVENANCE_ACTOR_KINDS = new Set(["human", "ci", "tool"]);
const PROVENANCE_SOURCE_KINDS = new Set(["git", "archive", "workspace"]);
const REVIEW_STATUSES = new Set(["approved", "pending", "rejected"]);
const REVIEW_EVIDENCE_KINDS = new Set(["validation_report", "review_note", "change_request"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const implementationDir = path.resolve(__dirname, "../../..");

const defaultFs = {
  accessSync: defaultAccessSync,
  realpathSync: defaultRealpathSync,
  statSync: defaultStatSync,
  existsSync: defaultExistsSync,
  mkdirSync: defaultMkdirSync,
  readFileSync: defaultReadFileSync,
  writeFileSync: defaultWriteFileSync,
};

export function loadSupplyChainArtifacts(paths, options = {}) {
  const fs = fsAdapter(options);
  const artifacts = {};
  if (paths.lock) {
    artifacts.lock = readJsonArtifact(paths.lock, "lock", fs);
  }
  if (paths.air) {
    artifacts.air = readJsonArtifact(paths.air, "air", fs);
  }
  if (paths.manifest) {
    artifacts.manifest = readJsonArtifact(paths.manifest, "manifest", fs);
  }
  return artifacts;
}

export function validateSupplyChainArtifacts(artifacts, options = {}) {
  const fs = fsAdapter(options);
  const requireReview = Boolean(options.requireReview);
  const diagnostics = [];
  const lock = artifacts.lock?.json;

  validateLockShape(lock, diagnostics);
  validateArtifactVersions(artifacts, diagnostics);
  scanLockForForbiddenData(lock, diagnostics);
  const provenanceReport = validateSupplyChainProvenance(lock?.provenance, diagnostics);
  const reviewReport = validateSupplyChainReview(lock?.review, artifacts, fs, diagnostics, requireReview);
  const packageInstallationChecked = validatePackageInstallation(artifacts, fs, diagnostics);

  const artifactStatus = {
    air: { drift_status: "unknown" },
    manifest: { drift_status: "unknown" },
  };
  const handlerReports = [];

  // Each entry AIR remains executable on its own. All project AIR artifacts
  // are pinned and checked, so a shared manifest never admits an unpinned tool.
  const projectAir = validateProjectAir(artifacts, fs, diagnostics);
  const selectedAir = projectAir.find(item => artifacts.air && sameFilePath(item.path, artifacts.air.path, fs));

  for (const kind of ["air", "manifest"]) {
    if (!lock?.[kind] || !artifacts[kind]) continue;
    const relative = kind === "air" && selectedAir ? selectedAir.record.path : lock[kind].path;
    const root = path.dirname(artifacts.lock.path);
    const declaredPath = typeof relative === "string" ? path.resolve(root, relative) : root;
    if (typeof relative !== "string" || path.isAbsolute(relative) || hasUnsafeRelativeSegments(relative)
      || !safeContainedFile(root, declaredPath, fs)
      || !sameFilePath(declaredPath, artifacts[kind].path, fs)) {
      diagnostics.push(error("SupplyChainArtifactPathMismatch", `${kind} path must identify the supplied artifact inside the lock directory`, kind, "path"));
    }
  }

  if (lock?.air && artifacts.air) {
    artifactStatus.air.drift_status = validateArtifactDigest("air", selectedAir?.record.digest ?? lock.air.digest, artifacts.air.digest, diagnostics)
      ? "ok"
      : "changed";
  } else if (lock?.air) {
    artifactStatus.air.drift_status = "missing";
    diagnostics.push(error("AirChanged", "explicit AIR artifact is missing", "air"));
  }

  if (lock?.manifest && artifacts.manifest) {
    artifactStatus.manifest.drift_status = validateArtifactDigest(
      "manifest",
      lock.manifest.digest,
      artifacts.manifest.digest,
      diagnostics,
    )
      ? "ok"
      : "changed";
  } else if (lock?.manifest) {
    artifactStatus.manifest.drift_status = "missing";
    diagnostics.push(error("ManifestChanged", "explicit manifest artifact is missing", "manifest"));
  }

  const airToolRefs = collectAirToolRefs(artifacts.air?.json);
  for (const item of projectAir) for (const ref of collectAirToolRefs(item.json)) airToolRefs.add(ref);
  const manifestBindings = bindingsFromManifest(artifacts.manifest?.json);
  collectCompensationInverseToolRefs(
    artifacts.manifest?.json,
    artifacts.air?.json,
    diagnostics,
  );
  const handlers = Array.isArray(lock?.handlers) ? lock.handlers : [];
  const handlerRefs = new Set();

  for (const handler of handlers) {
    if (!isPlainObject(handler)) {
      diagnostics.push(error("HandlerLockEntryInvalid", "handler lock entry must be an object", "handler"));
      continue;
    }
    const toolRef = handler.tool_ref;
    const report = {
      tool_ref: typeof toolRef === "string" ? toolRef : "tool:unknown",
      drift_status: "unknown",
      ...sdkReportFields(handler.sdk, diagnostics, toolRef),
      ...handlerPackageReportFields(handler.handler_package),
      diagnostics: [],
    };
    handlerReports.push(report);
    const packageDiagnostics = validateHandlerPackage(handler, report, artifacts, fs);
    for (const diagnostic of packageDiagnostics) {
      addHandlerDiagnostic(report, diagnostics, diagnostic);
    }

    if (typeof toolRef !== "string" || toolRef.trim() === "") {
      addHandlerDiagnostic(report, diagnostics, error("HandlerEntryUnknownTool", "handler tool_ref is missing", "handler", undefined, toolRef));
      continue;
    }
    if (handlerRefs.has(toolRef)) {
      addHandlerDiagnostic(report, diagnostics, error("HandlerEntryDuplicate", "duplicate handler lock entry", "handler", undefined, toolRef));
      continue;
    }
    handlerRefs.add(toolRef);

    if (artifacts.air && !airToolRefs.has(toolRef)) {
      addHandlerDiagnostic(report, diagnostics, error("HandlerEntryUnknownTool", "handler tool_ref absent from AIR", "air", undefined, toolRef));
    }

    const binding = manifestBindings.get(toolRef);
    if (artifacts.manifest && !binding) {
      addHandlerDiagnostic(report, diagnostics, error("HandlerEntryUnknownTool", "handler tool_ref absent from manifest", "manifest", undefined, toolRef));
    }
    if (binding) {
      compareHandlerCommand(handler, binding.handler, report, diagnostics);
      validateExecutableIdentity(handler, binding.handler, artifacts, fs, report, diagnostics);
    }

    const handlerPath = resolveHandlerPath(handler, artifacts);
    if (!safeContainedFile(path.dirname(artifacts.lock.path), handlerPath, fs)) {
      report.drift_status = "missing";
      addHandlerDiagnostic(report, diagnostics, error("HandlerMissing", "handler file missing", "handler", undefined, toolRef));
      continue;
    }

    const handlerText = fs.readFileSync(handlerPath);
    const observedDigest = sha256Text(handlerText);
    if (!validateArtifactDigest("handler", handler.digest, observedDigest, diagnostics, toolRef)) {
      report.drift_status = "changed";
      addHandlerDiagnostic(report, diagnostics, error("HandlerChanged", "handler digest changed", "handler", undefined, toolRef));
      continue;
    }
    report.drift_status = report.drift_status === "unknown" ? "ok" : report.drift_status;
  }

  for (const toolRef of manifestBindings.keys()) {
    if (!handlerRefs.has(toolRef)) {
      diagnostics.push(error("HandlerLockEntryMissing", "manifest binding is absent from lock handlers", "manifest", undefined, toolRef));
    }
  }

  const status = diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? "error"
    : diagnostics.some((diagnostic) => diagnostic.severity === "warning")
      ? "warning"
      : "ok";

  return {
    supply_chain_validation_schema_version: SUPPLY_CHAIN_VALIDATION_SCHEMA_VERSION,
    lock_schema_version: lock?.lock_schema_version,
    status,
    checked: {
      air_digest: Boolean(lock?.air),
      manifest_digest: Boolean(lock?.manifest),
      handler_digests: handlers.length > 0,
      handler_commands: Boolean(artifacts.manifest && handlers.length > 0),
      sdk_metadata: handlers.length > 0,
      handler_packages: handlers.length > 0,
      handler_package_files: handlers.some((handler) => Array.isArray(handler?.handler_package?.files)),
      handler_dependency_artifacts: handlers.some((handler) => Array.isArray(handler?.handler_package?.dependency_artifacts)),
      package_installation: packageInstallationChecked,
      effect_contracts: Boolean(artifacts.manifest),
      provenance_metadata: provenanceReport.status !== "unknown",
      review_metadata: reviewReport.status !== "unknown",
      review_evidence: reviewReport.evidence_status !== "unknown",
      review_required: requireReview,
      redaction: true,
    },
    artifacts: artifactStatus,
    provenance: provenanceReport,
    review: reviewReport,
    handlers: handlerReports,
    diagnostics,
  };
}

export function renderSupplyChainValidation(report) {
  const lines = [
    `Touba Supply Chain ${SUPPLY_CHAIN_VALIDATION_SCHEMA_VERSION}`,
    `Status ${report.status}`,
    `Lock ${report.lock_schema_version || "absent"}`,
    `AIR ${report.artifacts?.air?.drift_status || "absent"}`,
    `Manifest ${report.artifacts?.manifest?.drift_status || "absent"}`,
    `Provenance ${report.provenance?.status || "unknown"}`,
    `Review ${report.review?.status || "unknown"} evidence=${report.review?.evidence_status || "unknown"} required=${report.review?.required ? "yes" : "no"}`,
    `Handlers ${Array.isArray(report.handlers) ? report.handlers.length : 0}`,
  ];
  for (const handler of report.handlers || []) {
    lines.push(
      `- ${handler.tool_ref} drift=${handler.drift_status} sdk=${handler.sdk_status} package=${handler.handler_package_status} package_files=${handler.handler_package_files_status} dependencies=${handler.handler_dependency_artifacts_status}`,
    );
  }
  if (!report.diagnostics || report.diagnostics.length === 0) {
    lines.push("Diagnostics ok");
  } else {
    lines.push("Diagnostics:");
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${diagnostic.tool_ref ? ` [${diagnostic.tool_ref}]` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function sha256Text(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function validateSupplyChainProvenance(provenance, diagnostics) {
  const report = {
    status: "unknown",
  };
  if (provenance === undefined || provenance === null) {
    return report;
  }
  if (!isPlainObject(provenance)) {
    diagnostics.push(error("SupplyChainProvenanceInvalid", "provenance must be an object", "lock", "provenance"));
    return {
      status: "invalid",
    };
  }

  let status = "ok";
  const preparedBy = provenance.prepared_by;
  const source = provenance.source;
  if (preparedBy === undefined && source === undefined && provenance.prepared_at === undefined) {
    diagnostics.push(error("SupplyChainProvenanceInvalid", "provenance must declare prepared_by, prepared_at or source", "lock", "provenance"));
    status = "invalid";
  }

  if (preparedBy !== undefined) {
    const actorStatus = validateActorRef({
      actor: preparedBy,
      allowedKinds: PROVENANCE_ACTOR_KINDS,
      artifact: "lock",
      fieldPrefix: "provenance.prepared_by",
      invalidCode: "SupplyChainProvenanceInvalid",
      diagnostics,
    });
    status = worstMetadataStatus(status, actorStatus);
    if (actorStatus === "ok") {
      report.prepared_by_kind = preparedBy.kind;
      report.prepared_by_id = preparedBy.id;
    }
  }

  if (provenance.prepared_at !== undefined) {
    if (!isIsoUtcTimestamp(provenance.prepared_at)) {
      diagnostics.push(error("SupplyChainProvenanceInvalid", "provenance.prepared_at must be an ISO UTC timestamp", "lock", "provenance.prepared_at"));
      status = worstMetadataStatus(status, "invalid");
    } else {
      report.prepared_at = provenance.prepared_at;
    }
  }

  if (source !== undefined) {
    const sourceStatus = validateProvenanceSource(source, report, diagnostics);
    status = worstMetadataStatus(status, sourceStatus);
  }

  report.status = status;
  return report;
}

function validateProvenanceSource(source, report, diagnostics) {
  if (!isPlainObject(source)) {
    diagnostics.push(error("SupplyChainProvenanceInvalid", "provenance.source must be an object", "lock", "provenance.source"));
    return "invalid";
  }
  let status = "ok";
  if (!PROVENANCE_SOURCE_KINDS.has(source.kind)) {
    diagnostics.push(error("SupplyChainProvenanceInvalid", "provenance.source.kind is unsupported", "lock", "provenance.source.kind"));
    status = "invalid";
  } else {
    report.source_kind = source.kind;
  }
  if (typeof source.ref !== "string" || source.ref.trim() === "") {
    diagnostics.push(error("SupplyChainProvenanceInvalid", "provenance.source.ref is required", "lock", "provenance.source.ref"));
    status = "invalid";
  } else {
    report.source_ref = source.ref;
  }
  if (source.commit !== undefined) {
    if (typeof source.commit !== "string" || source.commit.trim() === "") {
      diagnostics.push(error("SupplyChainProvenanceInvalid", "provenance.source.commit must be a non-empty string", "lock", "provenance.source.commit"));
      status = "invalid";
    } else {
      report.source_commit = source.commit;
    }
  }
  return status;
}

function validateSupplyChainReview(review, artifacts, fs, diagnostics, requireReview) {
  const report = {
    status: "unknown",
    evidence_status: "unknown",
    required: requireReview,
  };
  if (review === undefined || review === null) {
    if (requireReview) {
      diagnostics.push(error("SupplyChainReviewMissing", "review metadata is required", "lock", "review"));
      return {
        ...report,
        status: "missing",
      };
    }
    return report;
  }
  if (!isPlainObject(review)) {
    diagnostics.push(error("SupplyChainReviewInvalid", "review must be an object", "lock", "review"));
    return {
      ...report,
      status: "invalid",
    };
  }

  let status = "ok";
  if (!REVIEW_STATUSES.has(review.status)) {
    diagnostics.push(error("SupplyChainReviewInvalid", "review.status must be approved, pending or rejected", "lock", "review.status"));
    status = "invalid";
  } else {
    report.status = review.status;
  }

  if (review.status === "rejected") {
    diagnostics.push(error("SupplyChainReviewRejected", "review status is rejected", "lock", "review.status"));
    status = worstMetadataStatus(status, "invalid");
  }

  if (review.status === "pending") {
    const diagnostic = requireReview
      ? error("SupplyChainReviewNotApproved", "review status is pending but an approved review is required", "lock", "review.status")
      : warning("SupplyChainReviewNotApproved", "review status is pending", "lock", "review.status");
    diagnostics.push(diagnostic);
    status = worstMetadataStatus(status, requireReview ? "invalid" : "warning");
  }

  if (requireReview && review.status !== "approved") {
    diagnostics.push(error("SupplyChainReviewNotApproved", "approved review is required", "lock", "review.status"));
    status = worstMetadataStatus(status, "invalid");
  }

  if (review.reviewed_at !== undefined) {
    if (!isIsoUtcTimestamp(review.reviewed_at)) {
      diagnostics.push(error("SupplyChainReviewInvalid", "review.reviewed_at must be an ISO UTC timestamp", "lock", "review.reviewed_at"));
      status = worstMetadataStatus(status, "invalid");
    } else {
      report.reviewed_at = review.reviewed_at;
    }
  } else if (review.status === "approved" || review.status === "rejected" || requireReview) {
    diagnostics.push(error("SupplyChainReviewInvalid", "review.reviewed_at is required for approved or rejected reviews", "lock", "review.reviewed_at"));
    status = worstMetadataStatus(status, "invalid");
  }

  const reviewerStatus = validateReviewers(review.reviewers, diagnostics, review.status, requireReview);
  status = worstMetadataStatus(status, reviewerStatus);
  if (Array.isArray(review.reviewers)) {
    report.reviewers = review.reviewers.length;
  }

  const evidenceStatus = validateReviewEvidence(review.evidence, artifacts, fs, diagnostics);
  report.evidence_status = evidenceStatus;
  status = worstMetadataStatus(status, evidenceStatus === "ok" || evidenceStatus === "unknown" ? "ok" : "invalid");
  if (Array.isArray(review.evidence)) {
    report.evidence = review.evidence.length;
  }

  if (status !== "ok") {
    report.status = status === "warning" && review.status === "pending" ? "pending" : status;
  }
  return report;
}

function validateReviewers(reviewers, diagnostics, reviewStatus, requireReview) {
  const required = reviewStatus === "approved" || reviewStatus === "rejected" || requireReview;
  if (reviewers === undefined || reviewers === null) {
    if (required) {
      diagnostics.push(error("SupplyChainReviewInvalid", "review.reviewers is required for approved or rejected reviews", "lock", "review.reviewers"));
      return "invalid";
    }
    return "ok";
  }
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    diagnostics.push(error("SupplyChainReviewInvalid", "review.reviewers must be a non-empty array", "lock", "review.reviewers"));
    return "invalid";
  }
  let status = "ok";
  reviewers.forEach((reviewer, index) => {
    const reviewerStatus = validateActorRef({
      actor: reviewer,
      allowedKinds: PROVENANCE_ACTOR_KINDS,
      artifact: "lock",
      fieldPrefix: `review.reviewers[${index}]`,
      invalidCode: "SupplyChainReviewInvalid",
      diagnostics,
    });
    status = worstMetadataStatus(status, reviewerStatus);
    if (reviewerStatus === "ok" && reviewer.role !== undefined && (typeof reviewer.role !== "string" || reviewer.role.trim() === "")) {
      diagnostics.push(error("SupplyChainReviewInvalid", `review.reviewers[${index}].role must be a non-empty string`, "lock", `review.reviewers[${index}].role`));
      status = "invalid";
    }
  });
  return status;
}

function validateActorRef(options) {
  const {
    actor,
    allowedKinds,
    artifact,
    fieldPrefix,
    invalidCode,
    diagnostics,
  } = options;
  if (!isPlainObject(actor)) {
    diagnostics.push(error(invalidCode, `${fieldPrefix} must be an object`, artifact, fieldPrefix));
    return "invalid";
  }
  let status = "ok";
  if (!allowedKinds.has(actor.kind)) {
    diagnostics.push(error(invalidCode, `${fieldPrefix}.kind is unsupported`, artifact, `${fieldPrefix}.kind`));
    status = "invalid";
  }
  if (typeof actor.id !== "string" || actor.id.trim() === "") {
    diagnostics.push(error(invalidCode, `${fieldPrefix}.id is required`, artifact, `${fieldPrefix}.id`));
    status = "invalid";
  }
  return status;
}

function validateReviewEvidence(evidence, artifacts, fs, diagnostics) {
  if (evidence === undefined || evidence === null) {
    return "unknown";
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    diagnostics.push(error("SupplyChainReviewEvidenceInvalid", "review.evidence must be a non-empty array", "lock", "review.evidence"));
    return "invalid";
  }

  const lockDir = artifacts.lock ? path.dirname(artifacts.lock.path) : process.cwd();
  let status = "ok";
  evidence.forEach((entry, index) => {
    const field = `review.evidence[${index}]`;
    if (!isPlainObject(entry)) {
      diagnostics.push(error("SupplyChainReviewEvidenceInvalid", `${field} must be an object`, "lock", field));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    if (!REVIEW_EVIDENCE_KINDS.has(entry.kind)) {
      diagnostics.push(error("SupplyChainReviewEvidenceInvalid", `${field}.kind is unsupported`, "lock", `${field}.kind`));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    if (typeof entry.path !== "string" || entry.path.trim() === "") {
      diagnostics.push(error("SupplyChainReviewEvidenceInvalid", `${field}.path is required`, "lock", `${field}.path`));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    if (path.isAbsolute(entry.path) || hasUnsafeRelativeSegments(entry.path)) {
      diagnostics.push(error("SupplyChainReviewEvidenceInvalid", `${field}.path must be a safe relative path`, "lock", `${field}.path`));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    if (!isPlainObject(entry.digest) || entry.digest.kind !== DIGEST_KIND || !isSha256Hex(entry.digest.value)) {
      diagnostics.push(error("SupplyChainDigestMissing", `${field}.digest must be a sha256 digest`, "lock", `${field}.digest`));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    const evidencePath = path.resolve(lockDir, entry.path);
    if (!isPathInside(lockDir, evidencePath)) {
      diagnostics.push(error("SupplyChainReviewEvidenceInvalid", `${field}.path must remain inside the lock directory`, "lock", `${field}.path`));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    if (!fs.existsSync(evidencePath)) {
      diagnostics.push(error("SupplyChainReviewEvidenceMissing", "review evidence file missing", "lock", `${field}.path`));
      status = worstDeclaredArtifactStatus(status, "missing");
      return;
    }
    if (!safeContainedFile(lockDir, evidencePath, fs)) {
      diagnostics.push(error("SupplyChainReviewEvidenceInvalid", `${field}.path escapes the lock directory or is not a regular file`, "lock", `${field}.path`));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    const observedDigest = sha256Text(fs.readFileSync(evidencePath));
    if (entry.digest.value !== observedDigest) {
      diagnostics.push(error("SupplyChainReviewEvidenceChanged", "review evidence digest changed", "lock", `${field}.digest`));
      status = worstDeclaredArtifactStatus(status, "changed");
    }
  });
  return status;
}

function worstMetadataStatus(current, next) {
  const order = new Map([
    ["ok", 0],
    ["warning", 1],
    ["invalid", 2],
    ["missing", 2],
    ["changed", 2],
  ]);
  return (order.get(next) ?? 2) > (order.get(current) ?? 2) ? next : current;
}

function validateProjectAir(artifacts, fs, diagnostics) {
  const lock = artifacts.lock?.json;
  if (!Array.isArray(lock?.additional_air) || lock.additional_air.length === 0) return [];
  const root = path.dirname(artifacts.lock.path);
  const documents = [];
  const paths = new Set();
  for (const record of [lock.air, ...lock.additional_air]) {
    if (!isPlainObject(record) || typeof record.path !== "string") continue;
    const absolutePath = path.resolve(root, record.path);
    if (path.isAbsolute(record.path) || hasUnsafeRelativeSegments(record.path)
      || !safeContainedFile(root, absolutePath, fs)) {
      diagnostics.push(error("SupplyChainArtifactPathMismatch", "project AIR must be a regular file confined to the lock directory", "air"));
      continue;
    }
    const physicalPath = fs.realpathSync(absolutePath);
    if (paths.has(physicalPath)) {
      diagnostics.push(error("SupplyChainLockSchemaMismatch", "duplicate project AIR path", "air"));
      continue;
    }
    paths.add(physicalPath);
    try {
      const artifact = readJsonArtifact(absolutePath, "air", fs);
      validateArtifactVersions({ air: artifact }, diagnostics);
      if (!validateArtifactDigest("air", record.digest, artifact.digest, diagnostics)) continue;
      documents.push({ ...artifact, record });
    } catch {
      diagnostics.push(error("AirChanged", "project AIR is missing or invalid", "air"));
    }
  }
  return documents;
}

function validatePackageInstallation(artifacts, fs, diagnostics) {
  if (!artifacts.lock) return false;
  const record = artifacts.lock.json?.package_installation;
  const root = path.dirname(artifacts.lock.path);
  if (record === undefined) {
    if (fs.existsSync(path.join(root, PACKAGE_LOCK))) diagnostics.push(error("SupplyChainPackageInstallationMissing", "the installation lock must be pinned in the supply-chain lock", "lock", "package_installation"));
    return false;
  }
  const file = typeof record?.path === "string" ? path.resolve(root, record.path) : root;
  if (typeof record?.path !== "string" || path.isAbsolute(record.path) || hasUnsafeRelativeSegments(record.path)
    || path.basename(file) !== PACKAGE_LOCK || !safeContainedFile(root, file, fs)) {
    diagnostics.push(error("SupplyChainPackageInstallationInvalid", "package_installation must identify an installation lock inside the lock directory", "lock", "package_installation"));
    return false;
  }
  if (!validateArtifactDigest("lock", record.digest, sha256Text(fs.readFileSync(file)), diagnostics)) return false;
  try {
    const workspace = readPackageWorkspace(path.dirname(file));
    verifyInstalledPackages(path.dirname(file), workspace.records);
    return true;
  } catch (failure) {
    diagnostics.push(error("SupplyChainPackageInstallationChanged", `installed packages failed integrity validation (${failure.code ?? "invalid"})`, "lock", "package_installation"));
    return false;
  }
}

function validateLockShape(lock, diagnostics) {
  if (!isPlainObject(lock)) {
    diagnostics.push(error("SupplyChainLockSchemaMismatch", "lock must be an object", "lock"));
    return;
  }
  if (lock.lock_schema_version !== SUPPLY_CHAIN_LOCK_SCHEMA_VERSION) {
    diagnostics.push(error("SupplyChainLockSchemaMismatch", "unsupported supply chain lock schema", "lock"));
  }
  if (lock.lock_kind !== "supply_chain") {
    diagnostics.push(error("SupplyChainLockSchemaMismatch", "lock_kind must be supply_chain", "lock"));
  }
  validateLockArtifact("air", lock.air, true, diagnostics);
  if (lock.additional_air !== undefined && !Array.isArray(lock.additional_air)) {
    diagnostics.push(error("SupplyChainLockSchemaMismatch", "additional_air must be an array", "lock"));
  }
  for (const artifact of Array.isArray(lock.additional_air) ? lock.additional_air : []) {
    validateLockArtifact("air", artifact, true, diagnostics);
  }
  validateLockArtifact("manifest", lock.manifest, false, diagnostics);
  validateLockArtifact("package_installation", lock.package_installation, false, diagnostics);
  if (!Array.isArray(lock.handlers)) {
    diagnostics.push(error("SupplyChainLockSchemaMismatch", "handlers must be an array", "lock", "handlers"));
  }
  for (const handler of Array.isArray(lock.handlers) ? lock.handlers : []) {
    validateHandlerShape(handler, diagnostics);
  }
}

function validateLockArtifact(kind, artifact, required, diagnostics) {
  if (artifact === undefined || artifact === null) {
    if (required) {
      diagnostics.push(error("SupplyChainLockSchemaMismatch", `${kind} artifact is required`, "lock", kind));
    }
    return;
  }
  if (!isPlainObject(artifact)) {
    diagnostics.push(error("SupplyChainLockSchemaMismatch", `${kind} artifact must be an object`, "lock", kind));
    return;
  }
  if (typeof artifact.path !== "string" || artifact.path.trim() === "") {
    diagnostics.push(error("SupplyChainLockSchemaMismatch", `${kind} path is required`, "lock", `${kind}.path`));
  }
  validateDigestShape(kind, artifact.digest, diagnostics);
}

function validateHandlerShape(handler, diagnostics) {
  if (!isPlainObject(handler)) {
    diagnostics.push(error("HandlerLockEntryInvalid", "handler entry must be an object", "handler"));
    return;
  }
  for (const field of ["tool_ref", "path", "command", "cwd"]) {
    if (typeof handler[field] !== "string" || handler[field].trim() === "") {
      diagnostics.push(error("HandlerLockEntryInvalid", `${field} is required`, "handler", field, handler.tool_ref));
    }
  }
  if (!Array.isArray(handler.args) || !handler.args.every((value) => typeof value === "string")) {
    diagnostics.push(error("HandlerLockEntryInvalid", "args must be an array of strings", "handler", "args", handler.tool_ref));
  }
  validateDigestShape("handler", handler.digest, diagnostics, handler.tool_ref);
}

function validateDigestShape(kind, digest, diagnostics, toolRef) {
  if (!isPlainObject(digest)) {
    diagnostics.push(error("SupplyChainDigestMissing", "digest must be an object", kind, "digest", toolRef));
    return;
  }
  if (digest.kind !== DIGEST_KIND) {
    diagnostics.push(error("SupplyChainDigestUnsupported", "unsupported digest kind", kind, "digest.kind", toolRef));
  }
  if (!isSha256Hex(digest.value)) {
    diagnostics.push(error("SupplyChainDigestMissing", "digest value must be a sha256 hex string", kind, "digest.value", toolRef));
  }
}

function validateArtifactVersions(artifacts, diagnostics) {
  if (artifacts.air && artifacts.air.json?.air_schema_version !== AIR_SCHEMA_VERSION) {
    diagnostics.push(error("SupplyChainLockSchemaMismatch", "unsupported AIR schema", "air"));
  }
  if (artifacts.manifest && !MANIFEST_VERSIONS.has(artifacts.manifest.json?.manifest_version)) {
    diagnostics.push(error("SupplyChainLockSchemaMismatch", "unsupported manifest schema", "manifest"));
    return;
  }
  if (artifacts.manifest) {
    try {
      validateManifestEffectContracts(artifacts.manifest.json);
    } catch (cause) {
      diagnostics.push(error(
        typeof cause?.code === "string" ? cause.code : "EffectContractInvalid",
        cause instanceof Error ? cause.message : String(cause),
        "manifest",
        "effect_contract",
        cause?.details?.tool_ref,
      ));
    }
  }
}

function validateArtifactDigest(kind, expectedDigest, observedDigest, diagnostics, toolRef) {
  if (!isPlainObject(expectedDigest) || expectedDigest.kind !== DIGEST_KIND || !isSha256Hex(expectedDigest.value)) {
    diagnostics.push(error("SupplyChainDigestMissing", "expected digest is invalid", kind, "digest", toolRef));
    return false;
  }
  if (expectedDigest.value !== observedDigest) {
    diagnostics.push(error("SupplyChainDigestMismatch", `${kind} digest does not match`, kind, "digest", toolRef));
    return false;
  }
  return true;
}

function compareHandlerCommand(handler, manifestHandler, report, diagnostics) {
  if (!isPlainObject(manifestHandler)) {
    addHandlerDiagnostic(report, diagnostics, error("HandlerCommandChanged", "manifest handler is missing", "manifest", "handler", handler.tool_ref));
    report.drift_status = "changed";
    return;
  }
  if (handler.command !== manifestHandler.command) {
    addHandlerDiagnostic(report, diagnostics, error("HandlerCommandChanged", "handler command changed", "manifest", "handler.command", handler.tool_ref));
    report.drift_status = "changed";
  }
  const manifestCwd = manifestHandler.cwd ?? ".";
  if (handler.cwd !== manifestCwd) {
    addHandlerDiagnostic(report, diagnostics, error("HandlerCwdChanged", "handler cwd changed", "manifest", "handler.cwd", handler.tool_ref));
    report.drift_status = "changed";
  }
  const manifestArgs = Array.isArray(manifestHandler.args) ? manifestHandler.args : [];
  if (JSON.stringify(handler.args) !== JSON.stringify(manifestArgs)) {
    addHandlerDiagnostic(report, diagnostics, error("HandlerArgsChanged", "handler args changed", "manifest", "handler.args", handler.tool_ref));
    report.drift_status = "changed";
  }
}

// Resolve without executing the command. PATH is an environment input, not a
// promise that an interpreter will execute every argument as source code.
export function resolveExecutable(command, cwd, fs = defaultFs) {
  if (typeof command !== "string" || !command.trim()) return null;
  // Match handler-protocol.mjs: Node aliases use the running Node binary.
  // Other commands are spawned without a parent PATH on POSIX.
  if (command === "node" || command === "node.exe") command = process.execPath;
  const env = process.platform === "win32" ? process.env : { PATH: "/usr/bin:/bin" };
  const candidates = command.includes("/") || command.includes("\\")
    ? [path.resolve(cwd, command)]
    : (env.PATH ?? "").split(path.delimiter).flatMap((directory) => {
      const extensions = process.platform === "win32" && !path.extname(command)
        ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
      return extensions.map((extension) => path.resolve(directory || cwd, command + extension));
    });
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

function validateExecutableIdentity(handler, manifestHandler, artifacts, fs, report, diagnostics) {
  const manifestDir = path.dirname(artifacts.manifest.path);
  const cwd = path.resolve(manifestDir, manifestHandler.cwd ?? ".");
  const executable = resolveExecutable(manifestHandler.command, cwd, fs);
  if (!executable) {
    addHandlerDiagnostic(report, diagnostics, error("HandlerCommandUnavailable", "handler command is missing or not executable", "handler", "command", handler.tool_ref));
  }
  const declared = resolveHandlerPath(handler, artifacts);
  const arguments_ = Array.isArray(manifestHandler.args) ? manifestHandler.args : [];
  const candidates = arguments_.filter((arg) => typeof arg === "string" && !arg.startsWith("-"))
    .map((arg) => path.resolve(cwd, arg));
  try {
    const module = pythonModuleEntrypoint(executable ?? manifestHandler.command, arguments_, cwd, fs);
    if (module) candidates.push(module.entrypoint);
  } catch {
    addHandlerDiagnostic(report, diagnostics, error("HandlerPathMismatch", "Python module entrypoint cannot be resolved locally", "handler", "path", handler.tool_ref));
  }
  if (executable) candidates.push(executable);
  if (!candidates.some((candidate) => sameFilePath(candidate, declared, fs))) {
    addHandlerDiagnostic(report, diagnostics, error("HandlerPathMismatch", "lock handler path is neither the executable nor an explicit manifest argument path", "handler", "path", handler.tool_ref));
  }
  const root = path.dirname(artifacts.lock.path);
  if (!safeContainedFile(root, declared, fs)) {
    addHandlerDiagnostic(report, diagnostics, error("HandlerPathInvalid", "handler must be a regular file confined to the lock directory, including symlinks", "handler", "path", handler.tool_ref));
  }
}

function collectCompensationInverseToolRefs(manifest, air, diagnostics) {
  const refs = new Set();
  if (!isPlainObject(manifest?.bindings)) return refs;
  const graphs = Array.isArray(air?.execution_graphs) ? air.execution_graphs : [];
  const graphByOwner = new Map(graphs.map((graph) => [graph?.owner_ref, graph]));
  for (const [toolRef, binding] of Object.entries(manifest.bindings)) {
    const entryRef = binding?.effect_contract?.compensation?.entry_ref;
    if (typeof entryRef !== "string") continue;
    const graph = graphByOwner.get(entryRef);
    const callTools = Array.isArray(graph?.nodes)
      ? graph.nodes.filter((node) => node?.kind === "call_tool" && typeof node.target_ref === "string")
      : [];
    if (callTools.length !== 1) {
      diagnostics.push(error(
        "CompensationEntryUnresolved",
        "compensation entry must resolve to exactly one tool call",
        "air",
        "execution_graphs",
        toolRef,
      ));
      continue;
    }
    refs.add(callTools[0].target_ref);
  }
  return refs;
}

function sdkStatus(sdk, diagnostics, toolRef) {
  if (!isPlainObject(sdk) || sdk.status === undefined || sdk.status === "unknown") {
    diagnostics.push(warning("HandlerSdkUnknown", "handler SDK metadata unknown", "handler", "sdk", toolRef));
    return "unknown";
  }
  if (!["ok", "missing", "unknown", "unsupported"].includes(sdk.status)) {
    diagnostics.push(warning("HandlerSdkUnsupported", "handler SDK status unsupported", "handler", "sdk.status", toolRef));
    return "unsupported";
  }
  if (sdk.status !== "ok") {
    diagnostics.push(warning("HandlerSdkUnsupported", `handler SDK status ${sdk.status}`, "handler", "sdk.status", toolRef));
    return "unsupported";
  }
  const unsupportedReasons = [];
  if (!EXPECTED_HANDLER_SDK_NAMES.has(sdk.name)) {
    unsupportedReasons.push("name");
  }
  if (sdk.protocol !== HANDLER_SDK_PROTOCOL_V1 || Object.hasOwn(sdk, "protocols")) {
    unsupportedReasons.push("protocol");
  }
  if (typeof sdk.version !== "string" || !SUPPORTED_HANDLER_SDK_VERSIONS.has(sdk.version)) {
    unsupportedReasons.push("version");
  }
  if (unsupportedReasons.length > 0) {
    diagnostics.push(warning(
      "HandlerSdkUnsupported",
      `handler SDK metadata incompatible: ${unsupportedReasons.join(", ")}`,
      "handler",
      "sdk",
      toolRef,
    ));
    return "unsupported";
  }
  return sdk.status;
}

function sdkReportFields(sdk, diagnostics, toolRef) {
  return {
    sdk_status: sdkStatus(sdk, diagnostics, toolRef),
    sdk_name: typeof sdk?.name === "string" ? sdk.name : undefined,
    sdk_version: typeof sdk?.version === "string" ? sdk.version : undefined,
    sdk_protocol: typeof sdk?.protocol === "string" ? sdk.protocol : undefined,
  };
}

function handlerPackageReportFields(handlerPackage) {
  return {
    handler_package_status: initialHandlerPackageStatus(handlerPackage),
    handler_package_kind: typeof handlerPackage?.kind === "string" ? handlerPackage.kind : undefined,
    handler_package_name: typeof handlerPackage?.name === "string" ? handlerPackage.name : undefined,
    handler_package_version: typeof handlerPackage?.version === "string" ? handlerPackage.version : undefined,
    handler_package_entrypoint: typeof handlerPackage?.entrypoint === "string" ? handlerPackage.entrypoint : undefined,
    handler_package_root: typeof handlerPackage?.package_root === "string" ? handlerPackage.package_root : undefined,
    handler_package_files_status: initialDeclaredArtifactStatus(handlerPackage?.files),
    handler_dependency_artifacts_status: initialDeclaredArtifactStatus(handlerPackage?.dependency_artifacts),
  };
}

function initialDeclaredArtifactStatus(artifacts) {
  if (artifacts === undefined || artifacts === null) {
    return "unknown";
  }
  return Array.isArray(artifacts) && artifacts.length > 0 ? "ok" : "invalid";
}

function initialHandlerPackageStatus(handlerPackage) {
  if (handlerPackage === undefined || handlerPackage === null) {
    return "unknown";
  }
  if (!isPlainObject(handlerPackage)) {
    return "invalid";
  }
  if (!SUPPORTED_HANDLER_PACKAGE_KINDS.has(handlerPackage.kind)) {
    return "unsupported";
  }
  return "ok";
}

function validateHandlerPackage(handler, report, artifacts, fs) {
  const handlerPackage = handler.handler_package;
  const toolRef = handler.tool_ref;
  if (handlerPackage === undefined || handlerPackage === null) {
    return [warning("HandlerPackageUnknown", "handler package metadata unknown", "handler", "handler_package", toolRef)];
  }
  if (!isPlainObject(handlerPackage)) {
    report.handler_package_status = "invalid";
    return [error("HandlerPackageInvalid", "handler_package must be an object", "handler", "handler_package", toolRef)];
  }

  const diagnostics = [];
  if (!SUPPORTED_HANDLER_PACKAGE_KINDS.has(handlerPackage.kind)) {
    report.handler_package_status = "unsupported";
    diagnostics.push(error("HandlerPackageUnsupported", "handler package kind unsupported", "handler", "handler_package.kind", toolRef));
  }
  for (const field of ["name", "version", "entrypoint"]) {
    if (typeof handlerPackage[field] !== "string" || handlerPackage[field].trim() === "") {
      report.handler_package_status = "invalid";
      diagnostics.push(error("HandlerPackageInvalid", `handler_package.${field} is required`, "handler", `handler_package.${field}`, toolRef));
    }
  }

  const entrypoint = handlerPackage.entrypoint;
  if (typeof entrypoint === "string" && entrypoint.trim() !== "") {
    const root = resolveHandlerPackageRoot(handlerPackage, artifacts, report, diagnostics, toolRef, fs);
    if (!root || path.isAbsolute(entrypoint) || hasUnsafeRelativeSegments(entrypoint)
      || path.resolve(root, entrypoint) !== resolveHandlerPath(handler, artifacts)) {
      report.handler_package_status = "mismatch";
      report.drift_status = "changed";
      diagnostics.push(error(
        "HandlerPackageEntrypointMismatch",
        "handler package entrypoint does not match executed handler",
        "handler",
        "handler_package.entrypoint",
        toolRef,
      ));
    }
    if (!Array.isArray(handlerPackage.files) || !handlerPackage.files.some((file) => file.path === entrypoint)) {
      diagnostics.push(error("HandlerPackageEntrypointUntracked", "handler package files must include its entrypoint", "handler", "handler_package.files", toolRef));
    }
  }

  diagnostics.push(...validateHandlerPackageArtifacts(handlerPackage, report, artifacts, fs, toolRef));

  return diagnostics;
}

function validateHandlerPackageArtifacts(handlerPackage, report, artifacts, fs, toolRef) {
  const diagnostics = [];
  const hasPackageFiles = handlerPackage.files !== undefined;
  const hasDependencyArtifacts = handlerPackage.dependency_artifacts !== undefined;
  if (!hasPackageFiles && !hasDependencyArtifacts) {
    return diagnostics;
  }

  const packageRoot = resolveHandlerPackageRoot(handlerPackage, artifacts, report, diagnostics, toolRef, fs);
  if (!packageRoot) {
    if (hasPackageFiles) {
      report.handler_package_files_status = "invalid";
    }
    if (hasDependencyArtifacts) {
      report.handler_dependency_artifacts_status = "invalid";
    }
    return diagnostics;
  }

  if (hasPackageFiles) {
    report.handler_package_files_status = validateDeclaredArtifactGroup({
      entries: handlerPackage.files,
      rootPath: packageRoot,
      fs,
      report,
      diagnostics,
      toolRef,
      statusField: "handler_package_files_status",
      invalidCode: "HandlerPackageFileInvalid",
      missingCode: "HandlerPackageFileMissing",
      changedCode: "HandlerPackageFileChanged",
      artifactKind: "handler_package",
      fieldPrefix: "handler_package.files",
      missingMessage: "handler package file missing",
      changedMessage: "handler package file digest changed",
    });
  }

  if (hasDependencyArtifacts) {
    report.handler_dependency_artifacts_status = validateDeclaredArtifactGroup({
      entries: handlerPackage.dependency_artifacts,
      rootPath: packageRoot,
      fs,
      report,
      diagnostics,
      toolRef,
      statusField: "handler_dependency_artifacts_status",
      invalidCode: "HandlerDependencyArtifactInvalid",
      missingCode: "HandlerDependencyArtifactMissing",
      changedCode: "HandlerDependencyArtifactChanged",
      artifactKind: "handler_dependency_artifact",
      fieldPrefix: "handler_package.dependency_artifacts",
      missingMessage: "handler dependency artifact missing",
      changedMessage: "handler dependency artifact digest changed",
    });
  }

  return diagnostics;
}

function resolveHandlerPackageRoot(handlerPackage, artifacts, report, diagnostics, toolRef, fs) {
  if (typeof handlerPackage.package_root !== "string" || handlerPackage.package_root.trim() === "") {
    diagnostics.push(error(
      "HandlerPackageRootMissing",
      "handler_package.package_root is required when files or dependency_artifacts are declared",
      "handler_package",
      "handler_package.package_root",
      toolRef,
    ));
    report.handler_package_status = "invalid";
    return undefined;
  }

  const root = handlerPackage.package_root;
  if (path.isAbsolute(root) || hasUnsafeRelativeSegments(root)) {
    diagnostics.push(error(
      "HandlerPackageRootInvalid",
      "handler_package.package_root must be a safe relative path",
      "handler_package",
      "handler_package.package_root",
      toolRef,
    ));
    report.handler_package_status = "invalid";
    return undefined;
  }

  const lockDir = artifacts.lock ? path.dirname(artifacts.lock.path) : process.cwd();
  const packageRoot = path.resolve(lockDir, root);
  try {
    if (!isPathInside(fs.realpathSync(lockDir), fs.realpathSync(packageRoot))) {
      diagnostics.push(error("HandlerPackageRootInvalid", "package root escapes lock directory through a symlink", "handler_package", "handler_package.package_root", toolRef));
      return undefined;
    }
  } catch {
    diagnostics.push(error("HandlerPackageRootInvalid", "package root does not exist", "handler_package", "handler_package.package_root", toolRef));
    return undefined;
  }
  return packageRoot;
}

function validateDeclaredArtifactGroup(options) {
  const {
    entries,
    rootPath,
    fs,
    diagnostics,
    toolRef,
    invalidCode,
    missingCode,
    changedCode,
    artifactKind,
    fieldPrefix,
    missingMessage,
    changedMessage,
  } = options;

  if (!Array.isArray(entries) || entries.length === 0) {
    diagnostics.push(error(invalidCode, `${fieldPrefix} must be a non-empty array`, artifactKind, fieldPrefix, toolRef));
    return "invalid";
  }

  let status = "ok";
  entries.forEach((entry, index) => {
    const field = `${fieldPrefix}[${index}]`;
    if (!isPlainObject(entry)) {
      diagnostics.push(error(invalidCode, `${field} must be an object`, artifactKind, field, toolRef));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    if (typeof entry.path !== "string" || entry.path.trim() === "") {
      diagnostics.push(error(invalidCode, `${field}.path is required`, artifactKind, `${field}.path`, toolRef));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    if (path.isAbsolute(entry.path) || hasUnsafeRelativeSegments(entry.path)) {
      diagnostics.push(error(invalidCode, `${field}.path must be a safe relative path`, artifactKind, `${field}.path`, toolRef));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    if (!isPlainObject(entry.digest) || entry.digest.kind !== DIGEST_KIND || !isSha256Hex(entry.digest.value)) {
      diagnostics.push(error("SupplyChainDigestMissing", `${field}.digest must be a sha256 digest`, artifactKind, `${field}.digest`, toolRef));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }

    const artifactPath = path.resolve(rootPath, entry.path);
    if (!isPathInside(rootPath, artifactPath)) {
      diagnostics.push(error(invalidCode, `${field}.path must remain inside handler_package.package_root`, artifactKind, `${field}.path`, toolRef));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    if (!fs.existsSync(artifactPath)) {
      diagnostics.push(error(missingCode, missingMessage, artifactKind, `${field}.path`, toolRef));
      status = worstDeclaredArtifactStatus(status, "missing");
      return;
    }

    if (!safeContainedFile(rootPath, artifactPath, fs)) {
      diagnostics.push(error(invalidCode, `${field}.path escapes its root through a symlink or is not a regular file`, artifactKind, `${field}.path`, toolRef));
      status = worstDeclaredArtifactStatus(status, "invalid");
      return;
    }
    const text = fs.readFileSync(artifactPath);
    const observedDigest = sha256Text(text);
    if (entry.digest.value !== observedDigest) {
      diagnostics.push(error(changedCode, changedMessage, artifactKind, `${field}.digest`, toolRef));
      status = worstDeclaredArtifactStatus(status, "changed");
    }
  });

  return status;
}

function worstDeclaredArtifactStatus(current, next) {
  const order = new Map([
    ["ok", 0],
    ["changed", 1],
    ["missing", 2],
    ["invalid", 3],
  ]);
  return (order.get(next) ?? 3) > (order.get(current) ?? 3) ? next : current;
}

function hasUnsafeRelativeSegments(value) {
  const normalized = path.normalize(value);
  return normalized === ".." || normalized.startsWith(`..${path.sep}`);
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeContainedFile(root, file, fs) {
  try {
    return isPathInside(root, file) && fs.statSync(file).isFile()
      && isPathInside(fs.realpathSync(root), fs.realpathSync(file));
  } catch { return false; }
}

function sameFilePath(left, right, fs) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); }
  catch { return false; }
}

function addHandlerDiagnostic(report, diagnostics, diagnostic) {
  report.diagnostics.push({
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
  });
  diagnostics.push(diagnostic);
}

function resolveHandlerPath(handler, artifacts) {
  const lockDir = artifacts.lock ? path.dirname(artifacts.lock.path) : process.cwd();
  return path.resolve(lockDir, typeof handler.path === "string" ? handler.path : ".");
}

function collectAirToolRefs(air) {
  const refs = new Set();
  for (const tool of Array.isArray(air?.definitions?.tools) ? air.definitions.tools : []) {
    if (typeof tool.id === "string") {
      refs.add(tool.id);
    }
  }
  return refs;
}

function bindingsFromManifest(manifest) {
  if (!isPlainObject(manifest?.bindings)) {
    return new Map();
  }
  return new Map(Object.entries(manifest.bindings));
}

function scanLockForForbiddenData(value, diagnostics, pathLabel = "lock") {
  if (Array.isArray(value)) {
    for (const item of value) {
      scanLockForForbiddenData(item, diagnostics, pathLabel);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      if (AUTHORITY_KEYS.has(normalized)) {
        diagnostics.push(error("SupplyChainAuthorityFieldForbidden", "authority field forbidden in supply chain lock", "lock", key));
      } else if (SECRET_KEYS.has(normalized)) {
        diagnostics.push(error("SupplyChainSecretLeakDetected", "secret-shaped field forbidden in supply chain lock", "lock", key));
      } else if (CONTENT_KEYS.has(normalized)) {
        diagnostics.push(error("SupplyChainHandlerContentLeakDetected", "raw content field forbidden in supply chain lock", "lock", key));
      } else if (["signature_valid", "signed_by"].includes(normalized)) {
        diagnostics.push(error("SupplyChainSignatureClaimUnsupported", "signature claim unsupported", "lock", key));
      } else if (["registry", "package", "package_ref"].includes(normalized)) {
        diagnostics.push(error("SupplyChainRegistryUnsupported", "registry or package authority unsupported", "lock", key));
      } else if (DEPENDENCY_AUDIT_CLAIM_KEYS.has(normalized)) {
        diagnostics.push(error("DependencyAuditUnsupported", "dependency vulnerability audit claim unsupported", "lock", key));
      } else if (TRUST_CLAIM_KEYS.has(normalized)) {
        diagnostics.push(error("SupplyChainUnsupportedTrustClaim", "trust or compliance claim unsupported", "lock", key));
      }
      scanLockForForbiddenData(nested, diagnostics, `${pathLabel}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    if (/TOUBA_SHOULD_NOT_LEAK|secret value|sk-live-|DATABASE_URL=/i.test(value)) {
      diagnostics.push(error("SupplyChainSecretLeakDetected", "sensitive string marker detected", "lock"));
    }
    if (value === "Verified" || value === "Unverified" || value === "trusted" || value === "compliant") {
      diagnostics.push(error("SupplyChainUnsupportedTrustClaim", "trust or compliance claim unsupported", "lock"));
    }
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
  if (!fs.existsSync(resolved)) {
    throw new Error(`missing file ${resolved}`);
  }
  const text = fs.readFileSync(resolved, "utf8");
  return {
    kind,
    path: resolved,
    text,
    digest: sha256Text(text),
  };
}

function fsAdapter(options) {
  return options.fs || defaultFs;
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isIsoUtcTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && !Number.isNaN(Date.parse(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function error(code, message, artifact, field, toolRef) {
  const diagnostic = {
    severity: "error",
    code,
    message,
  };
  if (artifact) {
    diagnostic.artifact_kind = artifact;
  }
  if (field) {
    diagnostic.field = field;
  }
  if (toolRef) {
    diagnostic.tool_ref = toolRef;
  }
  return diagnostic;
}

function warning(code, message, artifact, field, toolRef) {
  return {
    ...error(code, message, artifact, field, toolRef),
    severity: "warning",
  };
}

function parseArgs(argv) {
  const options = {
    output: "text",
    strict: false,
    requireReview: false,
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
    if (arg === "--lock") {
      options.lock = next();
    } else if (arg === "--air") {
      options.air = next();
    } else if (arg === "--manifest") {
      options.manifest = next();
    } else if (arg === "--report-out") {
      options.reportOutPath = next();
    } else if (arg === "--output") {
      options.output = next();
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--require-review") {
      options.requireReview = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function renderUsage() {
  return "Usage: touba-supply-chain --lock <touba.lock.json> --air <program.air.json> [--manifest <touba.manifest.json>] [--report-out <report.supply-chain-report.json>] [--output text|json] [--strict] [--require-review]\n";
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(renderUsage());
    return 0;
  }
  if (!options.lock) {
    throw new Error("missing required --lock");
  }
  if (!options.air) {
    throw new Error("missing required --air");
  }
  if (!["text", "json"].includes(options.output)) {
    throw new Error("--output must be text or json");
  }

  const artifacts = loadSupplyChainArtifacts(options);
  const report = validateSupplyChainArtifacts(artifacts, { requireReview: options.requireReview });
  if (options.reportOutPath) {
    writeSupplyChainReport(options.reportOutPath, report, defaultFs);
  }
  if (options.output === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderSupplyChainValidation(report));
  }
  if (report.status === "error") {
    return 1;
  }
  if (options.strict && report.status === "warning") {
    return 1;
  }
  return 0;
}

function writeSupplyChainReport(filePath, report, fs) {
  assertReportOutputPath(filePath, SUPPLY_CHAIN_REPORT_SUFFIX);
  if (report?.supply_chain_validation_schema_version !== SUPPLY_CHAIN_VALIDATION_SCHEMA_VERSION) {
    throw new Error("supply chain report must contain touba-supply-chain-validation-v1");
  }
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function assertReportOutputPath(filePath, suffix) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("--report-out requires a non-empty path");
  }
  if (!path.basename(path.resolve(filePath)).endsWith(suffix)) {
    throw new Error(`--report-out path must end with ${suffix}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error_) {
    process.stderr.write(`supply chain error: ${error_.message}\n`);
    process.stderr.write(renderUsage());
    process.exitCode = 2;
  }
}
