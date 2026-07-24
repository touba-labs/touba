import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { loadToolBindingManifestFromJson } from "@touba/runtime";

export const DEPLOYMENT_BUNDLE_SCHEMA_VERSION = "touba-deployment-bundle-v0.1";
export const DEPLOYMENT_STATUS_SCHEMA_VERSION = "touba-deployment-status-v0.1";

const COMPILER_PATH = new URL("../../touba-project/src/main.mjs", import.meta.url).pathname;
const MAX_ARTIFACTS = 1000;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".touba",
  "node_modules",
  "build",
  "dist",
  ".next",
  ".turbo",
]);
const ROOT_FILES = new Set([
  "touba.project.json",
  "touba.manifest.json",
  "touba.package.json",
  "touba.ownership.json",
  "touba.resources.json",
  "resources.json",
  "touba.lock.json",
  "touba.run-plan.json",
]);
const SECRET_PATH_PATTERN = /(^|\/)(\.env(?:\.|$)|[^/]*(?:secret|credential)[^/]*)(\/|$)/iu;
const RAW_SECRET_KEYS = new Set([
  "password",
  "credential",
  "connection_string",
  "secret_value",
  "token_value",
  "api_key_value",
]);

export function buildDeploymentBundle({
  projectRoot,
  profile = "prod",
  createdAt = new Date().toISOString(),
  sourceRevision,
} = {}) {
  const root = resolve(projectRoot ?? process.cwd());
  if (!["dev", "prod"].includes(profile)) {
    throw deploymentError("ToubaDeploymentProfileInvalid", "deployment profile must be dev or prod");
  }
  const paths = collectDeploymentPaths(root);
  if (!paths.some((path) => path.endsWith(".tb"))) {
    throw deploymentError("ToubaDeploymentSourceMissing", "deployment requires at least one Touba source file");
  }
  if (!paths.includes("touba.project.json")) {
    throw deploymentError("ToubaDeploymentProjectMetadataMissing", "touba.project.json is required");
  }
  if (profile === "prod" && !paths.includes("touba.lock.json")) {
    throw deploymentError("ToubaDeploymentSupplyChainLockMissing", "prod deployment requires touba.lock.json");
  }

  const artifacts = [];
  let totalBytes = 0;
  for (const path of paths) {
    assertDeployablePath(path);
    const absolute = safeArtifactPath(root, path);
    const content = readFileSync(absolute);
    if (content.length > MAX_ARTIFACT_BYTES) {
      throw deploymentError("ToubaDeploymentArtifactTooLarge", `${path} exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }
    totalBytes += content.length;
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw deploymentError("ToubaDeploymentBundleTooLarge", `bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    }
    validateArtifactContent(path, content);
    artifacts.push({
      path,
      kind: artifactKind(path),
      size_bytes: content.length,
      sha256: sha256(content),
      content_base64: content.toString("base64"),
    });
  }
  validateProjectArtifacts(root, artifacts);

  const revision = sourceRevision ?? readGitRevision(root);
  const unsigned = {
    schema_version: DEPLOYMENT_BUNDLE_SCHEMA_VERSION,
    profile,
    created_at: createdAt,
    source_revision: revision.commit,
    source_dirty: revision.dirty,
    protocols: {
      air: "air-minimal-v0.1",
      manifest: "touba-manifest-v1",
      ownership: "touba-ownership-v0.1",
      supply_chain_lock: "touba-lock-v0.1",
      trace: "trace-minimal-v0.1",
    },
    artifacts,
  };
  const digest = deploymentIdentityDigest(unsigned);
  return {
    ...unsigned,
    bundle_id: `sha256:${digest}`,
    bundle_sha256: digest,
  };
}

export function verifyDeploymentBundle(bundle) {
  if (!isRecord(bundle) || bundle.schema_version !== DEPLOYMENT_BUNDLE_SCHEMA_VERSION) {
    throw deploymentError(
      "ToubaDeploymentBundleInvalid",
      `bundle must use ${DEPLOYMENT_BUNDLE_SCHEMA_VERSION}`,
    );
  }
  if (!["dev", "prod"].includes(bundle.profile) || !Array.isArray(bundle.artifacts)) {
    throw deploymentError("ToubaDeploymentBundleInvalid", "bundle profile or artifacts are invalid");
  }
  if (bundle.artifacts.length < 1 || bundle.artifacts.length > MAX_ARTIFACTS) {
    throw deploymentError("ToubaDeploymentBundleInvalid", "bundle artifact count is invalid");
  }
  const paths = new Set();
  for (const artifact of bundle.artifacts) {
    if (!isRecord(artifact)) {
      throw deploymentError("ToubaDeploymentBundleInvalid", "bundle artifact must be an object");
    }
    const path = assertDeployablePath(artifact.path);
    if (paths.has(path)) {
      throw deploymentError("ToubaDeploymentBundleInvalid", `duplicate artifact ${path}`);
    }
    paths.add(path);
    const content = decodeArtifact(artifact);
    if (content.length !== artifact.size_bytes || sha256(content) !== artifact.sha256) {
      throw deploymentError("ToubaDeploymentArtifactDigestMismatch", `${path} does not match its digest`);
    }
    validateArtifactContent(path, content);
  }
  const { bundle_id: ignoredId, bundle_sha256: ignoredDigest, ...unsigned } = bundle;
  const digest = deploymentIdentityDigest(unsigned);
  if (bundle.bundle_sha256 !== digest || bundle.bundle_id !== `sha256:${digest}`) {
    throw deploymentError("ToubaDeploymentBundleDigestMismatch", "bundle digest is invalid");
  }
  return {
    bundle_id: bundle.bundle_id,
    bundle_sha256: bundle.bundle_sha256,
    artifact_count: bundle.artifacts.length,
    profile: bundle.profile,
  };
}

export function deploymentReadinessChecks(bundle, { targetConfigured = false } = {}) {
  verifyDeploymentBundle(bundle);
  const hasHandlerStub = bundle.artifacts.some((artifact) => (
    artifact.kind === "handler"
    && isGeneratedHandlerStub(decodeArtifact(artifact).toString("utf8"))
  ));
  return [
    {
      code: "ToubaDeploymentBundleVerified",
      status: "passed",
      message: "The immutable deployment bundle passed source, manifest and digest validation.",
    },
    {
      code: "ToubaDeploymentSourceRevision",
      status: bundle.profile === "prod" && bundle.source_dirty ? "blocked" : "passed",
      message: bundle.profile === "prod" && bundle.source_dirty
        ? "Production deployment requires a clean source revision."
        : "The source revision satisfies the selected deployment profile.",
    },
    {
      code: "ToubaDeploymentHandlerImplementation",
      status: bundle.profile === "prod" && hasHandlerStub ? "blocked" : "passed",
      message: bundle.profile === "prod" && hasHandlerStub
        ? "Production deployment requires implemented handlers; generated stubs remain in the bundle."
        : "Every handler satisfies the selected deployment profile.",
    },
    {
      code: "ToubaDeploymentTargetConfigured",
      status: targetConfigured ? "passed" : "blocked",
      message: targetConfigured
        ? "The deployment target is configured."
        : "Configure a deployment target before publication.",
    },
  ];
}

function isGeneratedHandlerStub(content) {
  return content.includes("// Touba generated handler stub v0.1")
    || content.includes("// Touba Studio generated handler stub v0.1");
}

export function createRevisionStore({ storageRoot }) {
  const root = resolve(storageRoot);
  const revisionsRoot = join(root, "revisions");
  const indexPath = join(root, "index.json");
  const currentPath = join(root, "current.json");
  mkdirSync(revisionsRoot, { recursive: true });

  return {
    publish(bundle, { publishedBy = "deployment-client", publishedAt = new Date().toISOString() } = {}) {
      const verified = verifyDeploymentBundle(bundle);
      const revisionId = verified.bundle_sha256;
      const revisionRoot = join(revisionsRoot, revisionId);
      const bundlePath = join(revisionRoot, "bundle.json");
      const index = readRevisionIndex(indexPath);
      const existing = index.revisions.find((item) => item.revision_id === revisionId);
      if (existing !== undefined) {
        if (!existsSync(bundlePath) || sha256(readFileSync(bundlePath)) !== existing.bundle_file_sha256) {
          throw deploymentError("ToubaDeploymentRevisionCorrupt", `revision ${revisionId} is inconsistent`);
        }
        verifyMaterializedArtifacts(revisionRoot, bundle.artifacts);
        return deploymentStatus(index, readCurrent(currentPath), existing, "published");
      }
      try {
        mkdirSync(join(revisionRoot, "artifacts"), { recursive: true });
        for (const artifact of bundle.artifacts) {
          const destination = safeArtifactPath(join(revisionRoot, "artifacts"), artifact.path);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, decodeArtifact(artifact));
        }
        verifyMaterializedArtifacts(revisionRoot, bundle.artifacts);
        const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
        writeFileSync(bundlePath, serialized, "utf8");
        const record = {
          revision_id: revisionId,
          bundle_id: bundle.bundle_id,
          bundle_sha256: bundle.bundle_sha256,
          bundle_file_sha256: sha256(Buffer.from(serialized, "utf8")),
          profile: bundle.profile,
          source_revision: bundle.source_revision,
          source_dirty: bundle.source_dirty,
          artifact_count: bundle.artifacts.length,
          published_at: publishedAt,
          published_by: publishedBy,
          status: "published",
        };
        index.revisions.push(record);
        writeRevisionIndex(indexPath, index);
        return deploymentStatus(index, readCurrent(currentPath), record, "published");
      } catch (cause) {
        rmSync(revisionRoot, { recursive: true, force: true });
        throw cause;
      }
    },

    activate(revisionId, { activatedBy = "deployment-client", activatedAt = new Date().toISOString() } = {}) {
      const index = readRevisionIndex(indexPath);
      const revision = requiredRevision(index, revisionId);
      const previous = readCurrent(currentPath);
      const current = {
        schema_version: "touba-deployment-current-v0.1",
        revision_id: revision.revision_id,
        previous_revision_id: previous?.revision_id ?? null,
        activated_at: activatedAt,
        activated_by: activatedBy,
      };
      writeAtomicJson(currentPath, current);
      revision.status = "active";
      for (const item of index.revisions) {
        if (item.revision_id !== revision.revision_id && item.status === "active") {
          item.status = "superseded";
        }
      }
      index.activations.push({
        revision_id: revision.revision_id,
        previous_revision_id: current.previous_revision_id,
        activated_at: activatedAt,
        activated_by: activatedBy,
        action: "activate",
      });
      writeRevisionIndex(indexPath, index);
      return deploymentStatus(index, current, revision, "active");
    },

    rollback({ rolledBackBy = "deployment-client", rolledBackAt = new Date().toISOString() } = {}) {
      const index = readRevisionIndex(indexPath);
      const current = readCurrent(currentPath);
      if (current === null || current.previous_revision_id === null) {
        throw deploymentError("ToubaDeploymentRollbackUnavailable", "no previous active revision is available");
      }
      const target = requiredRevision(index, current.previous_revision_id);
      const next = {
        schema_version: "touba-deployment-current-v0.1",
        revision_id: target.revision_id,
        previous_revision_id: current.revision_id,
        activated_at: rolledBackAt,
        activated_by: rolledBackBy,
      };
      writeAtomicJson(currentPath, next);
      for (const item of index.revisions) {
        item.status = item.revision_id === target.revision_id ? "active" : "superseded";
      }
      index.activations.push({
        revision_id: target.revision_id,
        previous_revision_id: current.revision_id,
        activated_at: rolledBackAt,
        activated_by: rolledBackBy,
        action: "rollback",
      });
      writeRevisionIndex(indexPath, index);
      return deploymentStatus(index, next, target, "rolled_back");
    },

    list() {
      const index = readRevisionIndex(indexPath);
      return deploymentStatus(index, readCurrent(currentPath), null, "ready");
    },

    readBundle(revisionId) {
      const index = readRevisionIndex(indexPath);
      requiredRevision(index, revisionId);
      return JSON.parse(readFileSync(join(revisionsRoot, revisionId, "bundle.json"), "utf8"));
    },
  };
}

export async function deploymentTargetRequest({
  targetUrl,
  token,
  method = "GET",
  path,
  body,
  fetchImpl = fetch,
}) {
  const base = new URL(targetUrl);
  if (base.protocol !== "https:" && !isLoopbackHost(base.hostname)) {
    throw deploymentError("ToubaDeploymentInsecureTargetRejected", "remote deployment targets require HTTPS");
  }
  if (typeof token !== "string" || token.length < 32) {
    throw deploymentError("ToubaDeploymentTokenInvalid", "deployment target token must contain at least 32 characters");
  }
  let response;
  try {
    response = await fetchImpl(new URL(path, base), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw deploymentError(
      "ToubaDeploymentTargetUnavailable",
      `deployment target is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw deploymentError(
      payload.code ?? "ToubaDeploymentTargetRequestFailed",
      payload.message ?? `deployment target returned HTTP ${response.status}`,
    );
  }
  return payload;
}

function collectDeploymentPaths(root) {
  const paths = [];
  const visit = (directory, depth) => {
    if (depth > 12) {
      throw deploymentError("ToubaDeploymentTreeTooDeep", "project artifact tree exceeds 12 levels");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        const path = relative(root, absolute).replaceAll("\\", "/");
        if (isDeploymentArtifact(path)) {
          paths.push(path);
        }
      }
      if (paths.length > MAX_ARTIFACTS) {
        throw deploymentError("ToubaDeploymentArtifactCountExceeded", `deployment exceeds ${MAX_ARTIFACTS} artifacts`);
      }
    }
  };
  visit(root, 0);
  return paths.sort();
}

function isDeploymentArtifact(path) {
  if (SECRET_PATH_PATTERN.test(path)) {
    return false;
  }
  if (path.startsWith("src/") && path.endsWith(".tb")) {
    return true;
  }
  if (path.startsWith("handlers/") && (path.endsWith(".mjs") || path.endsWith(".js"))) {
    return true;
  }
  if (path.startsWith("packages/") && (
    path.endsWith(".tb")
    || path.endsWith(".json")
    || path.endsWith(".mjs")
    || path.endsWith(".js")
  )) {
    return true;
  }
  if (path.endsWith(".air.json")) {
    return true;
  }
  return !path.includes("/") && ROOT_FILES.has(path);
}

function validateProjectArtifacts(root, artifacts) {
  for (const artifact of artifacts.filter((item) => item.path.endsWith(".tb"))) {
    const sourcePath = join(root, artifact.path);
    const result = spawnSync(process.execPath, [COMPILER_PATH, "compile", sourcePath, "--stdout"], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    if (result.status !== 0) {
      throw deploymentError(
        "ToubaDeploymentCompileFailed",
        `${artifact.path}: ${String(result.stderr || result.stdout).trim().split(/\r?\n/u)[0]}`,
      );
    }
  }
  const manifest = artifacts.find((item) => item.path === "touba.manifest.json");
  if (manifest !== undefined) {
    try {
      loadToolBindingManifestFromJson(decodeArtifact(manifest).toString("utf8"));
    } catch (cause) {
      throw deploymentError("ToubaDeploymentManifestInvalid", cause.message);
    }
  }
}

function validateArtifactContent(path, content) {
  if (!path.endsWith(".json")) {
    return;
  }
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch (cause) {
    throw deploymentError("ToubaDeploymentJsonInvalid", `${path}: ${cause.message}`);
  }
  const visit = (item, keyPath) => {
    if (Array.isArray(item)) {
      item.forEach((value, index) => visit(value, `${keyPath}[${index}]`));
      return;
    }
    if (!isRecord(item)) {
      return;
    }
    for (const [key, value] of Object.entries(item)) {
      if (RAW_SECRET_KEYS.has(key.toLowerCase()) && typeof value === "string" && value !== "") {
        throw deploymentError(
          "ToubaDeploymentRawSecretRejected",
          `${path}:${keyPath}.${key} contains a raw secret-like value`,
        );
      }
      visit(value, `${keyPath}.${key}`);
    }
  };
  visit(value, "$");
}

function decodeArtifact(artifact) {
  if (typeof artifact.content_base64 !== "string") {
    throw deploymentError("ToubaDeploymentBundleInvalid", `${artifact.path} content is missing`);
  }
  return Buffer.from(artifact.content_base64, "base64");
}

function assertDeployablePath(path) {
  if (
    typeof path !== "string"
    || path.trim() === ""
    || path.includes("\0")
    || isAbsolute(path)
    || path.split("/").includes("..")
    || SECRET_PATH_PATTERN.test(path)
  ) {
    throw deploymentError("ToubaDeploymentArtifactPathRejected", "bundle artifact path is unsafe");
  }
  return path.replaceAll("\\", "/");
}

function safeArtifactPath(root, path) {
  const normalized = assertDeployablePath(path);
  const absolute = resolve(root, normalized);
  const relativePath = relative(root, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)) {
    throw deploymentError("ToubaDeploymentArtifactPathRejected", "bundle artifact escapes its root");
  }
  return absolute;
}

function verifyMaterializedArtifacts(revisionRoot, artifacts) {
  const artifactsRoot = join(revisionRoot, "artifacts");
  for (const artifact of artifacts) {
    const materializedPath = safeArtifactPath(artifactsRoot, artifact.path);
    if (!existsSync(materializedPath) || sha256(readFileSync(materializedPath)) !== artifact.sha256) {
      throw deploymentError(
        "ToubaDeploymentRevisionCorrupt",
        `materialized artifact ${artifact.path} does not match its digest`,
      );
    }
  }
}

function artifactKind(path) {
  if (path.endsWith(".tb")) return "source";
  if (path.endsWith(".air.json")) return "air";
  if (path.startsWith("handlers/")) return "handler";
  if (basename(path) === "touba.manifest.json") return "manifest";
  if (basename(path) === "touba.lock.json") return "supply_chain_lock";
  if (basename(path) === "touba.ownership.json") return "ownership";
  if (basename(path) === "touba.run-plan.json") return "run_plan";
  return "metadata";
}

function readGitRevision(root) {
  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const statusResult = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  return {
    commit: commitResult.status === 0 ? commitResult.stdout.trim() : "unversioned",
    dirty: statusResult.status !== 0 || statusResult.stdout.trim() !== "",
  };
}

function readRevisionIndex(path) {
  if (!existsSync(path)) {
    return {
      schema_version: "touba-deployment-index-v0.1",
      revisions: [],
      activations: [],
    };
  }
  const index = JSON.parse(readFileSync(path, "utf8"));
  if (
    index.schema_version !== "touba-deployment-index-v0.1"
    || !Array.isArray(index.revisions)
    || !Array.isArray(index.activations)
  ) {
    throw deploymentError("ToubaDeploymentIndexInvalid", "deployment revision index is invalid");
  }
  return index;
}

function writeRevisionIndex(path, index) {
  writeAtomicJson(path, index);
}

function readCurrent(path) {
  if (!existsSync(path)) {
    return null;
  }
  const current = JSON.parse(readFileSync(path, "utf8"));
  if (current.schema_version !== "touba-deployment-current-v0.1") {
    throw deploymentError("ToubaDeploymentCurrentInvalid", "current deployment pointer is invalid");
  }
  return current;
}

function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  replaceFileFromTemp(temp, path);
}

function replaceFileFromTemp(temp, destination) {
  try {
    renameSync(temp, destination);
  } catch (error) {
    if (
      process.platform !== "win32"
      || !["EEXIST", "EPERM"].includes(error?.code)
      || !existsSync(destination)
    ) {
      rmSync(temp, { force: true });
      throw error;
    }
    rmSync(destination, { force: true });
    renameSync(temp, destination);
  }
}

function requiredRevision(index, revisionId) {
  const revision = index.revisions.find((item) => item.revision_id === revisionId);
  if (revision === undefined) {
    throw deploymentError("ToubaDeploymentRevisionNotFound", `revision ${revisionId} is unknown`);
  }
  return revision;
}

function deploymentStatus(index, current, revision, action) {
  return {
    schema_version: DEPLOYMENT_STATUS_SCHEMA_VERSION,
    status: "ok",
    action,
    current_revision_id: current?.revision_id ?? null,
    previous_revision_id: current?.previous_revision_id ?? null,
    revision: revision === null ? null : publicRevision(revision),
    revisions: [...index.revisions]
      .sort((left, right) => right.published_at.localeCompare(left.published_at))
      .map(publicRevision),
  };
}

function publicRevision(revision) {
  const {
    bundle_file_sha256: ignored,
    ...publicRecord
  } = revision;
  return publicRecord;
}

function canonicalJson(value) {
  return JSON.stringify(sortObject(value));
}

function deploymentIdentityDigest(bundle) {
  const {
    created_at: ignoredCreatedAt,
    ...deployableIdentity
  } = bundle;
  return sha256(Buffer.from(canonicalJson(deployableIdentity), "utf8"));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObject(item)]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deploymentError(code, message) {
  return Object.assign(new Error(message), { code });
}
