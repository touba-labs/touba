import crypto from "node:crypto";
import { readPackageBytes } from "./package-fetch.mjs";
import { readSignedRegistry, readSignedRegistryStatus } from "./registry-trust.mjs";
import semver from "semver";
import { PACKAGE_NAME, exactPackageVersion, packageFile, packagePath } from "./package-contract.mjs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_SCHEMA_VERSION = "touba-registry-index-v1";
const PACKAGE_SCHEMA_VERSION = "touba-registry-package-v1";
const LOCK_SCHEMA_VERSION = "touba-static-registry-lock-v1";

const STATUSES = new Set(["draft", "reviewed", "validated", "deprecated", "yanked"]);
const PACKAGE_KINDS = new Set(["touba_package"]);
const SUPPORTED_PROTOCOLS = new Set([
  "touba-skill-pack-v1",
  "touba-package-v1",
  "touba-package-v2",
  "budget-bq1-v1",
  "memory-pi1-v1",
  "touba-tool-handler-v1",
  "touba-agent-decision-v1",
  "touba-agent-model-input-v1",
]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

const readIndex = (ref, trust, readBytes) => /^https?:\/\//.test(ref)
  ? readSignedRegistry(ref, trust, undefined, readBytes) : readJsonRef(ref, "RegistryIndexSchemaInvalid");

/** Explicit status lookup. Fetches the catalogue, never sends a project inventory. */
export async function registryPackageStates({ registry, trust, readBytes, offline = false } = {}) {
  const location = registryLocation(requiredOption(registry, 'registry'));
  const remote = /^https?:\/\//.test(location.indexRef);
  if (offline && !remote) fail('RegistryStatusCacheUnavailable', 'offline status requires a cached signed remote registry');
  const document = remote
    ? await readSignedRegistryStatus(location.indexRef, trust, readBytes, { offline })
    : await readIndex(location.indexRef, trust, readBytes);
  validateIndex(document.value, document.ref);
  return { registry: location.publicIndexRef, revision: document.revision ?? null,
    index_digest: document.digest ?? digestBuffer(document.bytes), verified_signature: Boolean(document.signingKey),
    ...(remote ? { source: document.source, freshness: document.expired ? 'expired' : offline ? 'cached' : 'current',
      issued_at: new Date(document.issued_at * 1000).toISOString(), expires_at: new Date(document.expires_at * 1000).toISOString(),
      collected_at: new Date(document.collected_at * 1000).toISOString() } : {}),
    checked_at: new Date().toISOString(), packages: document.value.packages.map(entry => ({
      name: entry.package_ref.slice(4), version: entry.version, status: entry.status,
      ...(entry.withdrawal ? { withdrawal: { ...entry.withdrawal, reason: registryNoticeText(entry.withdrawal.reason) } } : {}),
    })) };
}

export async function listRegistryPackages({ registry, trust, readBytes, query = '', exact = false, offset = 0, limit = 50, includeWithdrawn = false, includeMetadataPath = false } = {}) {
  if (typeof query !== 'string' || query.length > 160 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000
    || !Number.isInteger(limit) || limit < 1 || limit > 100 || typeof includeWithdrawn !== 'boolean') fail('RegistryIndexSchemaInvalid', 'invalid catalogue query');
  const location = registryLocation(requiredOption(registry, 'registry'));
  const document = await readIndex(location.indexRef, trust, readBytes);
  validateIndex(document.value, document.ref);
  const entries = document.value.packages.filter(item => (includeWithdrawn || ['validated', 'deprecated'].includes(item.status))
    && (exact ? item.package_ref === `pkg:${query}` : item.package_ref.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => a.package_ref.localeCompare(b.package_ref) || semver.rcompare(a.version, b.version));
  return { items: entries.slice(offset, offset + limit).map(item => ({ name: item.package_ref.slice(4), version: item.version, status: item.status,
    ...(includeMetadataPath ? { metadata_path: item.metadata_path } : {}) })),
    total: entries.length, next_offset: offset + limit < entries.length ? offset + limit : null,
    revision: document.revision ?? null, index_digest: document.digest ?? digestBuffer(document.bytes),
    checked_at: new Date().toISOString(), source: location.publicIndexRef,
    verified_signature: Boolean(document.signingKey),
    expires_at: document.expires_at ? new Date(document.expires_at * 1000).toISOString() : null };
}

export async function resolveRegistryPackage(options = {}) {
  const packageRef = requiredOption(options.packageRef, "package");
  const version = requiredOption(options.version, "version");
  const registry = registryLocation(requiredOption(options.registry, "registry"));

  const indexDocument = await readIndex(registry.indexRef, options.trust, options.readBytes);
  validateIndex(indexDocument.value, indexDocument.ref);
  const indexEntry = findIndexEntry(indexDocument.value, packageRef, version);
  const metadataRef = resolveRegistryChild(registry.rootRef, indexEntry.metadata_path);
  const metadataDocument = await readJsonRef(metadataRef, "RegistryPackageSchemaInvalid", options.readBytes);
  const actualMetadataDigest = digestBuffer(metadataDocument.bytes);
  if (actualMetadataDigest !== indexEntry.metadata_digest) {
    fail("RegistryMetadataDigestMismatch", `${packageRef}@${version} metadata digest does not match index`, indexEntry.metadata_path);
  }

  const metadata = metadataDocument.value;
  validateMetadata(metadata, metadataDocument.ref);
  if (metadata.package_ref !== packageRef || metadata.version !== version) {
    fail("RegistryMetadataIdentityMismatch", `${packageRef}@${version} metadata identity does not match index`, indexEntry.metadata_path);
  }
  if (metadata.kind !== indexEntry.kind || metadata.status !== indexEntry.status) {
    fail("RegistryMetadataStatusMismatch", `${packageRef}@${version} kind/status does not match index`, indexEntry.metadata_path);
  }
  if (indexEntry.withdrawal && canonicalJson(indexEntry.withdrawal) !== canonicalJson(metadata.withdrawal)) {
    fail('RegistryMetadataStatusMismatch', 'withdrawal differs from the index', indexEntry.metadata_path);
  }
  if (options.validationOnly !== true) enforceStatus(metadata.status, options, metadata.withdrawal);
  enforceProtocols(metadata.compatibility?.protocols ?? [], metadataDocument.ref);

  const artifacts = verifyArtifacts(metadata.artifacts ?? [], options.sourceRoot);
  return {
    lock_schema_version: LOCK_SCHEMA_VERSION,
    generated_on: options.generatedOn ?? new Date().toISOString().slice(0, 10),
    registry: {
      mode: registry.kind,
      index_ref: registry.publicIndexRef,
      index_schema_version: indexDocument.value.index_schema_version,
      ...(indexDocument.signingKey ? { signing_key: indexDocument.signingKey, revision: indexDocument.revision, index_digest: indexDocument.digest } : {}),
    },
    package: {
      package_ref: metadata.package_ref,
      version: metadata.version,
      kind: metadata.kind,
      status: metadata.status,
      ...(metadata.withdrawal ? { withdrawal: metadata.withdrawal } : {}),
      metadata_path: indexEntry.metadata_path,
      metadata_digest: indexEntry.metadata_digest,
      source: metadata.source,
    },
    compatibility: metadata.compatibility,
    artifacts,
    limits: [
      "No package content is installed and no script is executed.",
      indexDocument.signingKey ? "The remote index signature was verified against the selected local trust file." : "Local registry metadata was checked against its recorded digests.",
      "Package installation and runtime permissions remain separate operations.",
    ],
  };
}

export function renderRegistryResolution(lock) {
  const lines = [
    `Registry lock ${lock.lock_schema_version}`,
    `Package ${lock.package.package_ref}@${lock.package.version} status=${lock.package.status}`,
    `Metadata ${lock.package.metadata_path} digest=${lock.package.metadata_digest}`,
  ];
  for (const artifact of lock.artifacts) {
    lines.push(`Artifact ${artifact.kind} ${artifact.path} verified=${artifact.verified}`);
  }
  lines.push("No package content was installed or executed.");
  return `${lines.join("\n")}\n`;
}

export async function checkRegistry(options = {}) {
  const location = registryLocation(requiredOption(options.registry, "registry"));
  const document = await readIndex(location.indexRef, options.trust);
  validateIndex(document.value, document.ref);
  const diagnostics = [];
  for (const entry of document.value.packages) {
    try {
      await resolveRegistryPackage({ ...options, packageRef: entry.package_ref, version: entry.version, validationOnly: true });
    } catch (error) { diagnostics.push({ package: entry.package_ref, version: entry.version, message: error.message }); }
  }
  let preserved = 0;
  if (options.previous) {
    const priorLocation = registryLocation(options.previous);
    const prior = await readIndex(priorLocation.indexRef, options.trust);
    validateIndex(prior.value, prior.ref);
    for (const entry of prior.value.packages) {
      try {
        await resolveRegistryPackage({ registry: options.previous, trust: options.trust, packageRef: entry.package_ref, version: entry.version, validationOnly: true });
        const current = document.value.packages.find(item => item.package_ref === entry.package_ref && item.version === entry.version);
        if (!current) fail("RegistryPublishedIdentityImmutable", `cannot remove or rename ${entry.package_ref}@${entry.version}; retain it with an explicit status`, entry.metadata_path);
        const oldMeta = (await readJsonRef(resolveRegistryChild(priorLocation.rootRef, entry.metadata_path), "RegistryPackageSchemaInvalid")).value;
        const newMeta = (await readJsonRef(resolveRegistryChild(location.rootRef, current.metadata_path), "RegistryPackageSchemaInvalid")).value;
        const { status: oldStatus, withdrawal: oldWithdrawal, ...oldContent } = oldMeta;
        const { status: newStatus, withdrawal: newWithdrawal, ...newContent } = newMeta;
        if (canonicalJson(oldContent) !== canonicalJson(newContent) || current.metadata_path !== entry.metadata_path) fail("RegistryPublishedVersionImmutable", `published content is immutable: ${entry.package_ref}@${entry.version}; publish a new version`, entry.metadata_path);
        preserved++;
      } catch (error) { diagnostics.push({ package: entry.package_ref, version: entry.version, message: error.message }); }
    }
  }
  return { status: diagnostics.length ? "error" : "success", packages: document.value.packages.length, continuity: { checked: Boolean(options.previous), preserved }, diagnostics };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function validateIndex(index, ref) {
  if (!isPlainObject(index) || index.index_schema_version !== INDEX_SCHEMA_VERSION || !Array.isArray(index.packages) || index.packages.length > 10000) {
    fail("RegistryIndexSchemaInvalid", `index must use ${INDEX_SCHEMA_VERSION}`, ref);
  }
  const seen = new Set();
  for (const entry of index.packages) {
    if (!isPlainObject(entry)) {
      fail("RegistryIndexSchemaInvalid", "index package entry must be an object", ref);
    }
    requireString(entry.package_ref, "package_ref", ref, "RegistryIndexSchemaInvalid");
    requireString(entry.version, "version", ref, "RegistryIndexSchemaInvalid");
    requireString(entry.kind, "kind", ref, "RegistryIndexSchemaInvalid");
    requireString(entry.status, "status", ref, "RegistryIndexSchemaInvalid");
    requireString(entry.metadata_path, "metadata_path", ref, "RegistryIndexSchemaInvalid");
    requireDigest(entry.metadata_digest, "metadata_digest", ref, "RegistryIndexSchemaInvalid");
    if (!PACKAGE_KINDS.has(entry.kind) || !STATUSES.has(entry.status)) {
      fail("RegistryIndexSchemaInvalid", "index package entry kind/status is invalid", ref);
    }
    if (!entry.package_ref.startsWith("pkg:") || !PACKAGE_NAME.test(entry.package_ref.slice(4)) || !exactPackageVersion(entry.version)) fail("RegistryIndexSchemaInvalid", "use a qualified package name and exact SemVer", ref);
    const identity = `${entry.package_ref}@${entry.version}`;
    if (seen.has(identity)) fail("RegistryIndexSchemaInvalid", "duplicate package version", ref);
    seen.add(identity);
    validateWithdrawal(entry, ref, 'RegistryIndexSchemaInvalid');
  }
}

function validateMetadata(metadata, ref) {
  if (!isPlainObject(metadata) || metadata.schema_version !== PACKAGE_SCHEMA_VERSION) {
    fail("RegistryPackageSchemaInvalid", `metadata must use ${PACKAGE_SCHEMA_VERSION}`, ref);
  }
  requireString(metadata.package_ref, "package_ref", ref, "RegistryPackageSchemaInvalid");
  requireString(metadata.namespace, "namespace", ref, "RegistryPackageSchemaInvalid");
  requireString(metadata.name, "name", ref, "RegistryPackageSchemaInvalid");
  requireString(metadata.version, "version", ref, "RegistryPackageSchemaInvalid");
  requireString(metadata.kind, "kind", ref, "RegistryPackageSchemaInvalid");
  requireString(metadata.status, "status", ref, "RegistryPackageSchemaInvalid");
  requireString(metadata.summary, "summary", ref, "RegistryPackageSchemaInvalid");
  validateWithdrawal(metadata, ref, 'RegistryPackageSchemaInvalid');
  if (!PACKAGE_KINDS.has(metadata.kind) || !STATUSES.has(metadata.status)) {
    fail("RegistryPackageSchemaInvalid", "metadata kind/status is invalid", ref);
  }
  if (!isPlainObject(metadata.source)) {
    fail("RegistryPackageSchemaInvalid", "metadata source must be an object", ref);
  }
  requireString(metadata.source.type, "source.type", ref, "RegistryPackageSchemaInvalid");
  requireString(metadata.source.url, "source.url", ref, "RegistryPackageSchemaInvalid");
  requireString(metadata.source.path, "source.path", ref, "RegistryPackageSchemaInvalid");
  requireString(metadata.source.revision, "source.revision", ref, "RegistryPackageSchemaInvalid");
  if (!isPlainObject(metadata.compatibility) || !Array.isArray(metadata.compatibility.protocols)) {
    fail("RegistryPackageSchemaInvalid", "metadata compatibility.protocols must be an array", ref);
  }
  requireString(metadata.compatibility.touba, "compatibility.touba", ref, "RegistryPackageSchemaInvalid");
  if (!semver.validRange(metadata.compatibility.touba) || !exactPackageVersion(metadata.version)) fail("RegistryPackageSchemaInvalid", "invalid SemVer compatibility or version", ref);
  if (metadata.package_ref !== `pkg:${metadata.namespace}.${metadata.name}`) fail("RegistryPackageSchemaInvalid", "metadata identity fields disagree", ref);
  if (!Array.isArray(metadata.artifacts) || metadata.artifacts.length === 0) {
    fail("RegistryPackageSchemaInvalid", "metadata artifacts must be a non-empty array", ref);
  }
  for (const artifact of metadata.artifacts) {
    if (!isPlainObject(artifact)) {
      fail("RegistryPackageSchemaInvalid", "artifact must be an object", ref);
    }
    requireString(artifact.kind, "artifact.kind", ref, "RegistryPackageSchemaInvalid");
    requireString(artifact.path, "artifact.path", ref, "RegistryPackageSchemaInvalid");
    requireDigest(artifact.digest, "artifact.digest", ref, "RegistryPackageSchemaInvalid");
    assertRelativePath(artifact.path, "artifact.path");
  }
}

function findIndexEntry(index, packageRef, version) {
  const samePackage = index.packages.filter((entry) => entry.package_ref === packageRef);
  const entry = samePackage.find((item) => item.version === version);
  if (entry) {
    return entry;
  }
  if (samePackage.length > 0) {
    fail("RegistryPackageVersionMissing", `${packageRef}@${version} is not listed`, "index.json");
  }
  fail("RegistryPackageNotFound", `${packageRef} is not listed`, "index.json");
}

function validateWithdrawal(value, ref, code) {
  if (value.withdrawal === undefined) return;
  const event = value.withdrawal;
  if (value.status !== 'yanked' || !isPlainObject(event) || Object.keys(event).sort().join(',') !== 'changed_at,reason'
    || typeof event.reason !== 'string' || !event.reason.trim() || [...event.reason].length > 500
    || typeof event.changed_at !== 'string' || event.changed_at.length > 40 || !Number.isFinite(Date.parse(event.changed_at))) {
    fail(code, 'invalid withdrawal event', ref);
  }
}

export function registryNoticeText(value) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
}

function enforceStatus(status, options, withdrawal) {
  if (status === "draft" && options.allowDraft !== true) {
    fail("RegistryPackageDraft", "draft packages require --allow-draft", status);
  }
  if (status === "deprecated" && options.allowDeprecated !== true) {
    fail("RegistryPackageDeprecated", "deprecated packages require --allow-deprecated", status);
  }
  if (status === "yanked") {
    const withdrawalReason = withdrawal ? registryNoticeText(withdrawal.reason) : undefined;
    throw Object.assign(new Error(`RegistryPackageYanked: yanked packages cannot be resolved${withdrawalReason ? ': ' + withdrawalReason : ''}`),
      { code: 'RegistryPackageYanked', path: status, withdrawalReason });
  }
}

function enforceProtocols(protocols, ref) {
  if (!Array.isArray(protocols) || protocols.some((item) => typeof item !== "string" || item.trim() === "")) {
    fail("RegistryProtocolIncompatible", "metadata protocols must be non-empty strings", ref);
  }
  const unsupported = protocols.filter((protocol) => !SUPPORTED_PROTOCOLS.has(protocol));
  if (unsupported.length > 0) {
    fail("RegistryProtocolIncompatible", `unsupported protocol ${unsupported[0]}`, ref);
  }
}

function verifyArtifacts(artifacts, sourceRoot) {
  const resolvedSourceRoot = sourceRoot ? resolve(sourceRoot) : null;
  return artifacts.map((artifact) => {
    if (!resolvedSourceRoot) {
      return {
        kind: artifact.kind,
        path: artifact.path,
        digest: artifact.digest,
        verified: false,
      };
    }
    const artifactPath = resolveInside(resolvedSourceRoot, artifact.path, "artifact.path");
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
      fail("RegistryArtifactMissing", `${artifact.path} does not exist in source root`, artifact.path);
    }
    const actualDigest = digestFile(artifactPath);
    if (actualDigest !== artifact.digest) {
      fail("RegistryArtifactDigestMismatch", `${artifact.path} digest does not match source artifact`, artifact.path);
    }
    return {
      kind: artifact.kind,
      path: artifact.path,
      digest: artifact.digest,
      verified: true,
    };
  });
}

function registryLocation(input) {
  if (isHttpUrl(input)) {
    const url = new URL(input);
    if (url.pathname.endsWith("/index.json")) {
      return {
        kind: "url",
        indexRef: url.href,
        publicIndexRef: url.href,
        rootRef: new URL("./", url).href,
      };
    }
    const rootUrl = ensureTrailingSlash(url);
    const indexUrl = new URL("index.json", rootUrl);
    return {
      kind: "url",
      indexRef: indexUrl.href,
      publicIndexRef: indexUrl.href,
      rootRef: rootUrl.href,
    };
  }

  const filePath = input.startsWith("file://") ? fileURLToPath(input) : input;
  const resolved = resolve(filePath);
  const inputIsDirectory = existsSync(resolved) && statSync(resolved).isDirectory();
  const indexPath = inputIsDirectory
    ? resolve(resolved, "index.json")
    : resolved;
  const publicIndexRef = inputIsDirectory
    ? `${toPosix(input).replace(/\/$/u, "")}/index.json`
    : input;
  return {
    kind: "file",
    indexRef: indexPath,
    publicIndexRef,
    rootRef: dirname(indexPath),
  };
}

function resolveRegistryChild(rootRef, path) {
  assertRelativePath(path, "metadata_path");
  if (isHttpUrl(rootRef)) {
    return new URL(path, rootRef).href;
  }
  return resolveInside(rootRef, path, "metadata_path");
}

function resolveInside(root, path, label) {
  assertRelativePath(path, label);
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    fail("RegistryPathInvalid", `${label} escapes its root`, path);
  }
  if (existsSync(resolved)) {
    try { return packageFile(resolve(root), path); }
    catch { fail("RegistryPathInvalid", `${label} must not traverse a link or special file`, path); }
  }
  return resolved;
}

function assertRelativePath(path, label) {
  try { packagePath(path); }
  catch { fail("RegistryPathInvalid", `${label} must be a portable relative path inside its root`, label); }
}

async function readJsonRef(ref, schemaCode, readBytes = readPackageBytes) {
  const bytes = await readBytes(ref, 1024 * 1024);
  try {
    return {
      ref,
      bytes,
      value: JSON.parse(bytes.toString("utf8")),
    };
  } catch (error) {
    fail(schemaCode, error.message, ref);
  }
}

function requiredOption(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("RegistryOptionMissing", `--${name} is required`, name);
  }
  return value;
}

function requireString(value, field, ref, code) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${field} must be a non-empty string`, ref);
  }
}

function requireDigest(value, field, ref, code) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} must be sha256:<hex>`, ref);
  }
}

function digestFile(path) {
  return digestBuffer(readFileSync(path));
}

function digestBuffer(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function ensureTrailingSlash(url) {
  const next = new URL(url.href);
  if (!next.pathname.endsWith("/")) {
    next.pathname = `${next.pathname}/`;
  }
  return next;
}

function fail(code, message, path) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.path = path;
  throw error;
}

function toPosix(path) {
  return String(path).split(sep).join("/");
}
