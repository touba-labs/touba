import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import semver from "semver";

export const PACKAGE_SCHEMA = "touba-package-v1";
export const PACKAGE_MANIFEST = "touba.package.json";
export const PACKAGE_RUNTIME_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const PACKAGE_LIMITS = Object.freeze({ files: 4096, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, manifestBytes: 1024 * 1024, depth: 32 });
export const EXPORT_KINDS = Object.freeze({ types: "type", defines: "constant", functions: "function", tools: "tool", skills: "skill", agents: "agent", strategies: "strategy", memories: "memory" });
export const PACKAGE_NAME = /^[a-z_][a-z0-9_-]*(\.[a-z_][a-z0-9_-]*)+$/;
const FIELDS = new Set(["package_schema_version", "name", "version", "root", "touba", "exports", "description", "publisher", "license", "readme", "files", "dependencies", "contexts", "handlers", "engines", "provenance", "contract_tests"]);
const CONTEXT_ID = /^[a-z][a-z0-9-]*$/;
const RESOURCE_KINDS = new Set(["procedure", "reference", "example", "template", "sample", "script", "fixture"]);
const AUTHORITY = new Set(["binding", "bindings", "grant", "grants", "handler", "manifest", "secrets", "secret_values", "callable_by", "memory_scopes", "permissions", "authority", "hooks", "postinstall"]);
const SENSITIVE_PATH = /(^|\/)(\.git|\.env(?:\.[^/]*)?|\.ssh|node_modules|\.touba)(\/|$)|(?:^|\/)(?:id_rsa|id_ed25519|credentials)(?:\.|$)|\.(?:pem|key|p12|pfx)$/i;

export function packageError(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }
export function exactPackageVersion(value) { return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) && semver.valid(value) !== null; }
function requireValue(condition, code, message) { if (!condition) throw packageError(code, message); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value) { return typeof value === "string" && value.trim().length > 0; }
function keys(value, allowed, at) {
  requireValue(object(value), "PackageSchemaMismatch", `${at} must be an object`);
  for (const key of Object.keys(value)) requireValue(allowed.includes(key), "PackageSchemaMismatch", `${at}.${key} is not supported`);
}
export function packageDigest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

// Display labels are not ownership credentials. Normalize only what the author
// explicitly supplies. Normalize Latin accents; punctuation is still rejected.
export function packageSlug(value) {
  const slug = typeof value === "string" ? value.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, "-") : "";
  requireValue(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 80, "PackageNameInvalid", "use letters a-z, digits and single hyphens; Latin accents are normalized and spaces become hyphens");
  packagePath(slug);
  requireValue(slug !== "packages", "PackageReservedName", "packages is reserved for managed dependencies");
  return slug;
}
export function packagePath(path) {
  requireValue(typeof path === "string" && path.length > 0 && path.length <= 240 && /^[A-Za-z0-9_./@+ -]+$/.test(path), "PackagePathInvalid", "paths must be portable relative paths");
  const parts = path.split("/");
  requireValue(parts.every(p => p && p !== "." && p !== ".." && !p.endsWith(".") && !p.endsWith(" ") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), "PackagePathInvalid", `unsafe path ${path}`);
  requireValue(!SENSITIVE_PATH.test(path), "PackageSensitivePath", `excluded path ${path}`);
  return path;
}

// Resolve every component, not just the final file: a directory link is also unsafe.
export function packageFile(root, path) {
  packagePath(path);
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw packageError("PackageFileMissing", `declared package resource is missing: ${path}`);
      throw error;
    }
    requireValue(!stat.isSymbolicLink(), "PackageSymlinkForbidden", `symlinks are not package content: ${path}`);
    requireValue(stat.isDirectory() || stat.isFile(), "PackageFileTypeInvalid", `unsupported file type: ${path}`);
  }
  return current;
}

export function validatePackageDocument(document, { runtimeVersion, publishing = false } = {}) {
  requireValue(object(document), "PackageSchemaMismatch", "manifest must be an object");
  for (const key of Object.keys(document)) {
    requireValue(!["registry", "registries", "registry_url"].includes(key), "PackageRegistryForbidden", "a package cannot choose the consumer's registry");
    requireValue(!AUTHORITY.has(key), "PackageAuthorityFieldForbidden", `${key} cannot grant package authority`);
    requireValue(FIELDS.has(key), "PackageSchemaMismatch", `unknown manifest field ${key}`);
  }
  requireValue(document.package_schema_version === PACKAGE_SCHEMA, "PackageSchemaMismatch", `expected ${PACKAGE_SCHEMA}`);
  requireValue(PACKAGE_NAME.test(document.name ?? ""), "PackageSchemaMismatch", "name must be a qualified lowercase identifier, e.g. acme.billing");
  requireValue(exactPackageVersion(document.version), "PackageSchemaMismatch", "version must be an exact SemVer version");
  requireValue(document.root === undefined || document.root === ".", "PackagePathInvalid", "package root is the manifest directory; root, when present, must be .");
  keys(document.touba, ["air_profile", "runtime_compatibility"], "touba");
  requireValue(document.touba.air_profile === "touba-air-json-canonical-v1", "PackageAirProfileIncompatible", "unsupported AIR profile");
  requireValue(text(document.touba.runtime_compatibility) && semver.validRange(document.touba.runtime_compatibility) !== null, "PackageVersionIncompatible", "invalid runtime compatibility range");
  if (runtimeVersion) requireValue(semver.satisfies(runtimeVersion, document.touba.runtime_compatibility), "PackageVersionIncompatible", `requires Touba ${document.touba.runtime_compatibility}; installed ${runtimeVersion}`);
  keys(document.exports, Object.keys(EXPORT_KINDS), "exports");
  let exportCount = 0;
  for (const [kind, refs] of Object.entries(document.exports)) {
    requireValue(Array.isArray(refs), "PackageSchemaMismatch", `exports.${kind} must be an array`);
    const seen = new Set();
    for (const ref of refs) {
      const match = typeof ref === "string" && /^(\w+):([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+)\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
      requireValue(match && match[1] === EXPORT_KINDS[kind], "PackageExportUnknownRef", `invalid ${kind} export ${ref}`);
      requireValue(!seen.has(ref), "PackageNameConflict", `duplicate export ${ref}`);
      seen.add(ref); exportCount++;
    }
  }
  const contexts = document.contexts ?? [];
  requireValue(Array.isArray(contexts), "PackageSchemaMismatch", "contexts must be an array");
  const contextIds = new Set();
  for (const context of contexts) {
    keys(context, ["id", "description", "procedure", "resources", "activation", "execution_links"], "context");
    requireValue(CONTEXT_ID.test(context.id ?? "") && !contextIds.has(context.id), "PackageContextInvalid", "context ids must be unique lowercase kebab-case identifiers");
    contextIds.add(context.id);
    requireValue(text(context.description), "PackageContextInvalid", `context ${context.id} needs a description`);
    packagePath(context.procedure);
    requireValue(context.procedure.endsWith(".md"), "PackageContextInvalid", "context procedure must be Markdown");
    if (context.activation !== undefined) {
      keys(context.activation, ["model_invocable", "user_invocable"], "context.activation");
      requireValue(Object.values(context.activation).every(v => typeof v === "boolean"), "PackageContextInvalid", "activation values must be boolean");
    }
    requireValue(Array.isArray(context.resources ?? []), "PackageContextInvalid", "resources must be an array");
    const names = new Set(["procedure"]);
    for (const resource of context.resources ?? []) {
      keys(resource, ["name", "path", "kind", "description", "loadable_as_context"], "context.resource");
      requireValue(CONTEXT_ID.test(resource.name ?? "") && !names.has(resource.name), "PackageContextInvalid", "resource names must be unique lowercase kebab-case identifiers");
      names.add(resource.name); packagePath(resource.path);
      requireValue(RESOURCE_KINDS.has(resource.kind) && text(resource.description), "PackageContextInvalid", "resources need a supported kind and description");
      requireValue(resource.loadable_as_context === undefined || typeof resource.loadable_as_context === "boolean", "PackageContextInvalid", "loadable_as_context must be boolean");
      requireValue(resource.kind !== "script" || resource.loadable_as_context !== true, "PackageContextInvalid", "scripts cannot be loaded or executed as context");
    }
    requireValue(Array.isArray(context.execution_links ?? []), "PackageContextInvalid", "execution_links must be an array");
    for (const link of context.execution_links ?? []) {
      keys(link, ["label", "target_ref", "description"], "context.execution_link");
      requireValue(text(link.label) && text(link.description) && /^(tool|skill):[a-z_][a-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(link.target_ref ?? ""), "PackageContextInvalid", "execution links must identify a governed tool or skill");
    }
  }
  requireValue(exportCount + contexts.length > 0, "PackageExportMissing", "export at least one declaration or context");
  if (document.dependencies !== undefined) {
    requireValue(object(document.dependencies), "PackageDependencyInvalid", "dependencies must map package names to exact versions");
    for (const [name, version] of Object.entries(document.dependencies)) requireValue(PACKAGE_NAME.test(name) && name !== document.name && exactPackageVersion(version), "PackageDependencyInvalid", `invalid dependency ${name}; use exact versions`);
  }
  requireValue(document.files === undefined || Array.isArray(document.files), "PackageSchemaMismatch", "files must be an array");
  for (const path of document.files ?? []) packagePath(path);
  requireValue(Array.isArray(document.contract_tests ?? []), "PackageSchemaMismatch", "contract_tests must be an array");
  for (const path of document.contract_tests ?? []) packagePath(path);
  const handlers = document.handlers ?? [];
  requireValue(Array.isArray(handlers), "PackageSchemaMismatch", "handlers must be an array");
  const boundTools = new Set();
  for (const handler of handlers) {
    keys(handler, ["tool", "path", "protocol", "configuration", "documentation"], "handler");
    requireValue(/^tool:[a-z_][a-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(handler.tool ?? "") && !boundTools.has(handler.tool), "PackageHandlerInvalid", "handlers must name distinct tool refs");
    boundTools.add(handler.tool); packagePath(handler.path);
    requireValue(handler.protocol === "touba-tool-handler-v1", "PackageHandlerInvalid", "unsupported handler protocol");
    for (const field of ["configuration", "documentation"]) if (handler[field] !== undefined) packagePath(handler[field]);
  }
  if (document.engines !== undefined) {
    keys(document.engines, ["node", "platforms"], "engines");
    if (document.engines.node !== undefined) requireValue(text(document.engines.node) && semver.validRange(document.engines.node) !== null, "PackageRequirementInvalid", "invalid Node range");
    if (document.engines.platforms !== undefined) requireValue(Array.isArray(document.engines.platforms) && document.engines.platforms.length > 0 && document.engines.platforms.every(p => /^(darwin|linux|win32)-(arm64|x64)$/.test(p)), "PackageRequirementInvalid", "unsupported platform requirement");
  }
  if (publishing) {
    for (const field of ["description", "publisher", "license", "readme"]) requireValue(text(document[field]), "PackagePublicationMetadataMissing", `${field} is required for sharing`);
    packagePath(document.readme);
  }
  if (document.provenance !== undefined) {
    keys(document.provenance, ["kind", "source", "revision"], "provenance");
    requireValue(Object.values(document.provenance).every(text), "PackageSchemaMismatch", "provenance values must be nonempty text");
  }
  for (const field of ["description", "publisher", "license", "readme"]) if (document[field] !== undefined) requireValue(text(document[field]), "PackageSchemaMismatch", `${field} must be nonempty text`);
  if (document.readme) packagePath(document.readme);
  return document;
}

export function packageRequirements(document) {
  const missing = [];
  if (document.engines?.node && !semver.satisfies(process.versions.node, document.engines.node)) missing.push(`Node ${document.engines.node} required; found ${process.versions.node}`);
  if (document.engines?.platforms && !document.engines.platforms.includes(`${process.platform}-${process.arch}`)) missing.push(`platform ${process.platform}-${process.arch} is not supported`);
  return { compatible: missing.length === 0, missing, handlers: document.handlers ?? [], contexts: (document.contexts ?? []).map(c => c.id), authority: "The consuming project authorizes execution; installing a package grants nothing." };
}

export function readPackage(path, options = {}) {
  const input = resolve(path);
  requireValue(!lstatSync(input).isSymbolicLink(), "PackageSymlinkForbidden", "package path cannot be a symlink");
  requireValue(lstatSync(input).isDirectory() || (lstatSync(input).isFile() && basename(input) === PACKAGE_MANIFEST), "PackagePathInvalid", "select a package directory or touba.package.json");
  const root = realpathSync(lstatSync(input).isDirectory() ? input : dirname(input));
  const manifestPath = packageFile(root, PACKAGE_MANIFEST);
  requireValue(lstatSync(manifestPath).size <= PACKAGE_LIMITS.manifestBytes, "PackageTooLarge", "manifest exceeds size limit");
  let document;
  try { document = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { throw packageError("PackageSchemaMismatch", "cannot parse touba.package.json"); }
  validatePackageDocument(document, options);
  const files = new Map();
  const folded = new Map();
  let total = 0;
  function include(path, depth = 0) {
    requireValue(depth <= PACKAGE_LIMITS.depth, "PackageTooLarge", "directory nesting exceeds limit");
    const absolute = packageFile(root, path);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) include(`${path}/${name}`, depth + 1);
      return;
    }
    if (files.has(path)) return;
    requireValue(!folded.has(path.toLowerCase()), "PackagePathCollision", `case-insensitive path collision: ${path}`);
    requireValue(stat.size <= PACKAGE_LIMITS.fileBytes, "PackageTooLarge", `file too large: ${path}`);
    const bytes = readFileSync(absolute);
    total += bytes.length;
    requireValue(total <= PACKAGE_LIMITS.totalBytes && files.size < PACKAGE_LIMITS.files, "PackageTooLarge", "package exceeds size or file count limit");
    folded.set(path.toLowerCase(), path);
    files.set(path, { path, size: bytes.length, digest: packageDigest(bytes) });
  }
  include(PACKAGE_MANIFEST);
  const roots = document.files ?? (Object.values(document.exports).some(refs => refs.length) ? ["src"] : []);
  for (const path of roots) include(path);
  for (const context of document.contexts ?? []) {
    include(context.procedure);
    requireValue(readFileSync(packageFile(root, context.procedure), "utf8").trim().length > 0, "PackageContextInvalid", "context procedure cannot be empty");
    for (const resource of context.resources ?? []) include(resource.path);
  }
  for (const handler of document.handlers ?? []) for (const key of ["path", "configuration", "documentation"]) if (handler[key]) include(handler[key]);
  if (document.readme) include(document.readme);
  for (const path of document.contract_tests ?? []) include(path);
  for (const refs of Object.values(document.exports)) for (const ref of refs) {
    const module = ref.slice(ref.indexOf(":") + 1, ref.indexOf("/"));
    requireValue(files.has(`src/${module.split(".").join("/")}.tb`), "PackageExportMissing", `exported module ${module} must be included under src/`);
  }
  const inventory = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { root, manifestPath, document, files: inventory, digest: packageDigest(JSON.stringify(inventory)), requirements: packageRequirements(document) };
}

export function assertPackageUnchanged(pkg) {
  const current = readPackage(pkg.root);
  requireValue(current.digest === pkg.digest, "PackageIntegrityMismatch", `package ${pkg.document.name} changed during the operation`);
}

export function isWithin(root, path) { const base = resolve(root); const target = resolve(path); return target === base || target.startsWith(base + sep); }
