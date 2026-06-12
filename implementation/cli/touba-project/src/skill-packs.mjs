import crypto from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TOUBA_SKILL_PACK_SCHEMA_VERSION = "touba-skill-pack-v0.1";
export const DEFAULT_SKILLS_ROOT = "skills";

const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SKILL_PACK_REF_PATTERN = /^skill_pack:[a-z][a-z0-9_.-]*\/[a-z][a-z0-9-]*$/;
const RESOURCE_REF_PATTERN = /^resource:[a-z][a-z0-9-]*\/[a-z][a-z0-9_.-]*$/;
const EXECUTION_TARGET_REF_PATTERN = /^(tool|skill):[A-Za-z0-9_.-]+\/[A-Za-z][A-Za-z0-9_]*$/;
const SEMVER_LIKE_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RESOURCE_KINDS = new Set(["procedure", "reference", "example", "template", "sample", "script", "fixture"]);
const TOP_LEVEL_FIELDS = new Set([
  "skill_pack_schema_version",
  "ref",
  "name",
  "description",
  "version",
  "tags",
  "source",
  "activation",
  "resources",
  "execution_links",
]);
const ACTIVATION_FIELDS = new Set(["model_invocable", "user_invocable"]);
const RESOURCE_FIELDS = new Set([
  "ref",
  "path",
  "kind",
  "description",
  "loadable_as_context",
  "executable_by_pack",
  "digest",
]);
const EXECUTION_LINK_FIELDS = new Set(["label", "target_ref", "description"]);
const AUTHORITY_FIELDS = new Set([
  "authority",
  "backend",
  "binding",
  "bindings",
  "callable_by",
  "capability",
  "capabilities",
  "command",
  "grant",
  "grants",
  "handler",
  "handlers",
  "manifest",
  "memory_scope",
  "memory_scopes",
  "permission",
  "permissions",
  "provider",
  "scope",
  "scopes",
  "secret",
  "secret_values",
  "secrets",
]);

export function newSkillPack(skillId, options = {}) {
  assertSkillId(skillId);
  const root = resolve(options.root ?? process.cwd());
  const packPath = resolve(root, DEFAULT_SKILLS_ROOT, skillId);
  if (existsSync(packPath) && options.force !== true) {
    throw new Error(`skill pack already exists: ${packPath}`);
  }

  const created = [];
  const preserved = [];
  for (const dir of [
    packPath,
    join(packPath, "resources"),
    join(packPath, "resources", "references"),
    join(packPath, "resources", "examples"),
    join(packPath, "resources", "templates"),
    join(packPath, "resources", "samples"),
    join(packPath, "scripts"),
    join(packPath, "tests"),
    join(packPath, "tests", "fixtures"),
  ]) {
    ensureDirectory(dir, created, preserved);
  }

  const skillMdPath = join(packPath, "SKILL.md");
  const skillMd = defaultSkillMarkdown(skillId);
  writeSkillPackFile(skillMdPath, skillMd, options.force, created, preserved);

  const descriptorPath = join(packPath, "skill.json");
  const descriptor = defaultSkillDescriptor(skillId, digestFile(skillMdPath));
  writeSkillPackFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, options.force, created, preserved);

  return {
    workflow_version: "touba-project-workflow-v1",
    command: "skill new",
    status: "success",
    root,
    skill_pack_ref: descriptor.ref,
    skill_pack_path: packPath,
    descriptor_path: descriptorPath,
    created,
    preserved,
    notes: [
      "A skill pack is procedural context, not runtime authority.",
      "Scripts inside scripts/ are resources until exposed through a governed Touba tool.",
    ],
  };
}

export function validateSkillPacks(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const packPaths = resolveSkillPackTargets(root, options.target);
  const diagnostics = [];
  const skillPacks = [];

  for (const packPath of packPaths) {
    const result = validateSkillPack(packPath);
    diagnostics.push(...result.diagnostics);
    if (result.skill_pack !== null) {
      skillPacks.push(result.skill_pack);
    }
  }

  const notes = [];
  if (packPaths.length === 0) {
    notes.push("No skill pack directory found under skills/.");
  }

  return {
    workflow_version: "touba-project-workflow-v1",
    command: "skill validate",
    status: diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "success",
    root,
    skill_packs: skillPacks,
    diagnostics,
    notes,
  };
}

export function loadSkillPack(packPath) {
  const result = validateSkillPack(packPath);
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    const first = result.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    throw new Error(`${first.code}: ${first.message}`);
  }
  return result.skill_pack;
}

function validateSkillPack(packPath) {
  const diagnostics = [];
  const resolvedPackPath = resolve(packPath);
  const descriptorPath = join(resolvedPackPath, "skill.json");
  const skillId = basename(resolvedPackPath);

  if (!SKILL_ID_PATTERN.test(skillId)) {
    diagnostics.push(errorDiagnostic("SkillPackRefInvalid", "skill pack folder names must be lowercase kebab-case", {
      skill_pack_path: resolvedPackPath,
      skill_id: skillId,
    }));
  }

  if (!existsSync(resolvedPackPath) || !statSync(resolvedPackPath).isDirectory()) {
    diagnostics.push(errorDiagnostic("SkillPackLayoutInvalid", "skill pack path must be a directory", {
      skill_pack_path: resolvedPackPath,
    }));
    return { skill_pack: null, diagnostics };
  }

  validateStandardLayout(resolvedPackPath, diagnostics);

  if (!existsSync(descriptorPath)) {
    diagnostics.push(errorDiagnostic("SkillPackDescriptorMissing", "skill pack must contain skill.json", {
      skill_pack_path: resolvedPackPath,
      descriptor_path: descriptorPath,
    }));
    return { skill_pack: null, diagnostics };
  }

  let descriptor;
  try {
    descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  } catch (error) {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", error.message, {
      skill_pack_path: resolvedPackPath,
      descriptor_path: descriptorPath,
    }));
    return { skill_pack: null, diagnostics };
  }

  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", "skill.json must be a JSON object", {
      skill_pack_path: resolvedPackPath,
      descriptor_path: descriptorPath,
    }));
    return { skill_pack: null, diagnostics };
  }

  validateForbiddenFields(descriptor, diagnostics, descriptorPath);
  validateAllowedFields(descriptor, TOP_LEVEL_FIELDS, diagnostics, descriptorPath, "skill.json");

  if (descriptor.skill_pack_schema_version !== TOUBA_SKILL_PACK_SCHEMA_VERSION) {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", `skill_pack_schema_version must be ${TOUBA_SKILL_PACK_SCHEMA_VERSION}`, {
      descriptor_path: descriptorPath,
      actual: descriptor.skill_pack_schema_version,
    }));
  }

  if (typeof descriptor.ref !== "string" || !SKILL_PACK_REF_PATTERN.test(descriptor.ref)) {
    diagnostics.push(errorDiagnostic("SkillPackRefInvalid", "skill pack ref must match skill_pack:<namespace>/<skill-id>", {
      descriptor_path: descriptorPath,
      ref: descriptor.ref,
    }));
  } else if (!descriptor.ref.endsWith(`/${skillId}`)) {
    diagnostics.push(errorDiagnostic("SkillPackRefInvalid", "skill pack ref must end with the folder skill-id", {
      descriptor_path: descriptorPath,
      ref: descriptor.ref,
      skill_id: skillId,
    }));
  }

  validateRequiredString(descriptor.name, "name", diagnostics, descriptorPath);
  validateRequiredString(descriptor.description, "description", diagnostics, descriptorPath);
  if (typeof descriptor.version !== "string" || !SEMVER_LIKE_PATTERN.test(descriptor.version)) {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", "skill pack version must be semver-like", {
      descriptor_path: descriptorPath,
      version: descriptor.version,
    }));
  }
  validateStringArray(descriptor.tags, "tags", diagnostics, descriptorPath, { required: true });
  if (descriptor.source !== "project") {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", "skill pack source must be project in this V1", {
      descriptor_path: descriptorPath,
      source: descriptor.source,
    }));
  }

  validateActivation(descriptor.activation, diagnostics, descriptorPath);
  const resources = validateResources(descriptor.resources, resolvedPackPath, diagnostics, descriptorPath);
  validateExecutionLinks(descriptor.execution_links, diagnostics, descriptorPath);

  if (!resources.some((resource) => resource.path === "SKILL.md" && resource.kind === "procedure")) {
    diagnostics.push(errorDiagnostic("SkillPackResourcePathInvalid", "skill pack must declare SKILL.md as a procedure resource", {
      descriptor_path: descriptorPath,
      path: "SKILL.md",
    }));
  }

  return {
    skill_pack: {
      ref: typeof descriptor.ref === "string" ? descriptor.ref : null,
      name: typeof descriptor.name === "string" ? descriptor.name : null,
      version: typeof descriptor.version === "string" ? descriptor.version : null,
      path: resolvedPackPath,
      descriptor_path: descriptorPath,
      resource_count: resources.length,
      execution_link_count: Array.isArray(descriptor.execution_links) ? descriptor.execution_links.length : 0,
    },
    diagnostics,
  };
}

function validateStandardLayout(packPath, diagnostics) {
  for (const relativePath of [
    "resources",
    "resources/references",
    "resources/examples",
    "resources/templates",
    "resources/samples",
    "scripts",
    "tests",
    "tests/fixtures",
  ]) {
    const path = join(packPath, relativePath);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      diagnostics.push(errorDiagnostic("SkillPackLayoutInvalid", `skill pack must contain ${relativePath}/`, {
        skill_pack_path: packPath,
        path,
      }));
    }
  }
}

function validateActivation(activation, diagnostics, descriptorPath) {
  if (!activation || typeof activation !== "object" || Array.isArray(activation)) {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", "activation must be an object", {
      descriptor_path: descriptorPath,
      field: "activation",
    }));
    return;
  }
  validateAllowedFields(activation, ACTIVATION_FIELDS, diagnostics, descriptorPath, "activation");
  for (const field of ACTIVATION_FIELDS) {
    if (typeof activation[field] !== "boolean") {
      diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", `activation.${field} must be boolean`, {
        descriptor_path: descriptorPath,
        field: `activation.${field}`,
      }));
    }
  }
}

function validateResources(resources, packPath, diagnostics, descriptorPath) {
  if (!Array.isArray(resources)) {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", "resources must be an array", {
      descriptor_path: descriptorPath,
      field: "resources",
    }));
    return [];
  }

  const normalized = [];
  const refs = new Set();
  const paths = new Set();
  for (const [index, resource] of resources.entries()) {
    const profile = `resources[${index}]`;
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", `${profile} must be an object`, {
        descriptor_path: descriptorPath,
        field: profile,
      }));
      continue;
    }
    validateAllowedFields(resource, RESOURCE_FIELDS, diagnostics, descriptorPath, profile);
    if (typeof resource.ref !== "string" || !RESOURCE_REF_PATTERN.test(resource.ref)) {
      diagnostics.push(errorDiagnostic("SkillPackRefInvalid", `${profile}.ref must match resource:<skill-id>/<name>`, {
        descriptor_path: descriptorPath,
        field: `${profile}.ref`,
        ref: resource.ref,
      }));
    } else if (refs.has(resource.ref)) {
      diagnostics.push(errorDiagnostic("SkillPackRefInvalid", `duplicate resource ref ${resource.ref}`, {
        descriptor_path: descriptorPath,
        ref: resource.ref,
      }));
    } else {
      refs.add(resource.ref);
    }

    if (typeof resource.kind !== "string" || !RESOURCE_KINDS.has(resource.kind)) {
      diagnostics.push(errorDiagnostic("SkillPackResourceKindInvalid", `${profile}.kind is not supported`, {
        descriptor_path: descriptorPath,
        field: `${profile}.kind`,
        kind: resource.kind,
      }));
    }
    if (typeof resource.loadable_as_context !== "boolean") {
      diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", `${profile}.loadable_as_context must be boolean`, {
        descriptor_path: descriptorPath,
        field: `${profile}.loadable_as_context`,
      }));
    }
    if (resource.kind === "script" && resource.executable_by_pack === true) {
      diagnostics.push(errorDiagnostic("SkillPackScriptExecutionForbidden", "scripts cannot be executable by a skill pack", {
        descriptor_path: descriptorPath,
        field: `${profile}.executable_by_pack`,
      }));
    }

    const pathOk = validateResourcePath(resource.path, packPath, diagnostics, descriptorPath, profile);
    if (pathOk) {
      if (paths.has(resource.path)) {
        diagnostics.push(errorDiagnostic("SkillPackResourcePathInvalid", `duplicate resource path ${resource.path}`, {
          descriptor_path: descriptorPath,
          path: resource.path,
        }));
      } else {
        paths.add(resource.path);
      }
      validateResourceDigest(resource, packPath, diagnostics, descriptorPath, profile);
    }

    if (typeof resource.path === "string" && typeof resource.kind === "string") {
      normalized.push({ path: resource.path, kind: resource.kind, ref: resource.ref });
    }
  }
  return normalized;
}

function validateResourcePath(resourcePath, packPath, diagnostics, descriptorPath, profile) {
  if (typeof resourcePath !== "string" || resourcePath.trim() === "") {
    diagnostics.push(errorDiagnostic("SkillPackResourcePathInvalid", `${profile}.path must be a non-empty relative path`, {
      descriptor_path: descriptorPath,
      field: `${profile}.path`,
      path: resourcePath,
    }));
    return false;
  }
  if (isAbsolute(resourcePath) || resourcePath.split(/[\\/]+/u).includes("..")) {
    diagnostics.push(errorDiagnostic("SkillPackResourcePathInvalid", `${profile}.path must stay inside the skill pack`, {
      descriptor_path: descriptorPath,
      field: `${profile}.path`,
      path: resourcePath,
    }));
    return false;
  }

  const resolvedPath = resolve(packPath, resourcePath);
  const relativePath = relative(packPath, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    diagnostics.push(errorDiagnostic("SkillPackResourcePathInvalid", `${profile}.path escapes the skill pack`, {
      descriptor_path: descriptorPath,
      field: `${profile}.path`,
      path: resourcePath,
    }));
    return false;
  }
  if (!existsSync(resolvedPath)) {
    diagnostics.push(errorDiagnostic("SkillPackResourcePathInvalid", `${profile}.path does not exist`, {
      descriptor_path: descriptorPath,
      field: `${profile}.path`,
      path: resourcePath,
    }));
    return false;
  }
  const stat = lstatSync(resolvedPath);
  if (stat.isSymbolicLink()) {
    const realPack = realpathSync(packPath);
    const realResource = realpathSync(resolvedPath);
    const realRelative = relative(realPack, realResource);
    if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
      diagnostics.push(errorDiagnostic("SkillPackResourcePathInvalid", `${profile}.path symlink escapes the skill pack`, {
        descriptor_path: descriptorPath,
        field: `${profile}.path`,
        path: resourcePath,
      }));
      return false;
    }
  }
  if (!statSync(resolvedPath).isFile()) {
    diagnostics.push(errorDiagnostic("SkillPackResourcePathInvalid", `${profile}.path must point to a file`, {
      descriptor_path: descriptorPath,
      field: `${profile}.path`,
      path: resourcePath,
    }));
    return false;
  }
  return true;
}

function validateResourceDigest(resource, packPath, diagnostics, descriptorPath, profile) {
  if (typeof resource.digest !== "string" || !SHA256_DIGEST_PATTERN.test(resource.digest)) {
    diagnostics.push(errorDiagnostic("SkillPackDigestMismatch", `${profile}.digest must be sha256:<hex>`, {
      descriptor_path: descriptorPath,
      field: `${profile}.digest`,
      digest: resource.digest,
    }));
    return;
  }
  const actual = digestFile(resolve(packPath, resource.path));
  if (actual !== resource.digest) {
    diagnostics.push(errorDiagnostic("SkillPackDigestMismatch", `${profile}.digest does not match resource content`, {
      descriptor_path: descriptorPath,
      field: `${profile}.digest`,
      expected: resource.digest,
      actual,
    }));
  }
}

function validateExecutionLinks(links, diagnostics, descriptorPath) {
  if (links === undefined) {
    return;
  }
  if (!Array.isArray(links)) {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", "execution_links must be an array", {
      descriptor_path: descriptorPath,
      field: "execution_links",
    }));
    return;
  }
  const targets = new Set();
  for (const [index, link] of links.entries()) {
    const profile = `execution_links[${index}]`;
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", `${profile} must be an object`, {
        descriptor_path: descriptorPath,
        field: profile,
      }));
      continue;
    }
    validateAllowedFields(link, EXECUTION_LINK_FIELDS, diagnostics, descriptorPath, profile);
    validateRequiredString(link.label, `${profile}.label`, diagnostics, descriptorPath);
    if (typeof link.target_ref !== "string" || !EXECUTION_TARGET_REF_PATTERN.test(link.target_ref)) {
      diagnostics.push(errorDiagnostic("SkillPackExecutionLinkUnauthorized", `${profile}.target_ref must point to a Touba tool or skill ref`, {
        descriptor_path: descriptorPath,
        field: `${profile}.target_ref`,
        target_ref: link.target_ref,
      }));
      continue;
    }
    if (targets.has(link.target_ref)) {
      diagnostics.push(errorDiagnostic("SkillPackExecutionLinkUnauthorized", `duplicate execution link target ${link.target_ref}`, {
        descriptor_path: descriptorPath,
        target_ref: link.target_ref,
      }));
    } else {
      targets.add(link.target_ref);
    }
  }
}

function validateForbiddenFields(value, diagnostics, descriptorPath, path = []) {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const fieldPath = [...path, key].join(".");
    if (AUTHORITY_FIELDS.has(key)) {
      diagnostics.push(errorDiagnostic("SkillPackAuthorityFieldForbidden", `skill packs cannot declare runtime authority field ${fieldPath}`, {
        descriptor_path: descriptorPath,
        field: fieldPath,
      }));
    }
    validateForbiddenFields(child, diagnostics, descriptorPath, [...path, key]);
  }
}

function validateAllowedFields(value, allowedFields, diagnostics, descriptorPath, profile) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", `${profile} contains unknown field ${key}`, {
        descriptor_path: descriptorPath,
        field: profile === "skill.json" ? key : `${profile}.${key}`,
      }));
    }
  }
}

function validateRequiredString(value, field, diagnostics, descriptorPath) {
  if (typeof value !== "string" || value.trim() === "") {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", `${field} must be a non-empty string`, {
      descriptor_path: descriptorPath,
      field,
    }));
  }
}

function validateStringArray(value, field, diagnostics, descriptorPath, options = {}) {
  if (value === undefined && options.required !== true) {
    return;
  }
  if (!Array.isArray(value)) {
    diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", `${field} must be an array`, {
      descriptor_path: descriptorPath,
      field,
    }));
    return;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      diagnostics.push(errorDiagnostic("SkillPackSchemaMismatch", `${field}[${index}] must be a non-empty string`, {
        descriptor_path: descriptorPath,
        field: `${field}[${index}]`,
      }));
    }
  }
}

function resolveSkillPackTargets(root, target) {
  if (target !== undefined) {
    if (SKILL_ID_PATTERN.test(target)) {
      return [resolve(root, DEFAULT_SKILLS_ROOT, target)];
    }
    return [resolve(root, target)];
  }
  const skillsRoot = resolve(root, DEFAULT_SKILLS_ROOT);
  if (!existsSync(skillsRoot)) {
    return [];
  }
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsRoot, entry.name))
    .sort();
}

function assertSkillId(skillId) {
  if (typeof skillId !== "string" || !SKILL_ID_PATTERN.test(skillId)) {
    throw new Error("skill ids must be lowercase kebab-case, for example research-review");
  }
}

function defaultSkillDescriptor(skillId, skillMdDigest) {
  return {
    skill_pack_schema_version: TOUBA_SKILL_PACK_SCHEMA_VERSION,
    ref: `skill_pack:project/${skillId}`,
    name: titleFromSkillId(skillId),
    description: `Procedure and context for ${titleFromSkillId(skillId)}.`,
    version: "0.1.0",
    tags: [],
    source: "project",
    activation: {
      model_invocable: true,
      user_invocable: true,
    },
    resources: [
      {
        ref: `resource:${skillId}/procedure`,
        path: "SKILL.md",
        kind: "procedure",
        loadable_as_context: true,
        digest: skillMdDigest,
      },
    ],
    execution_links: [],
  };
}

function defaultSkillMarkdown(skillId) {
  const title = titleFromSkillId(skillId);
  return [
    `# ${title}`,
    "",
    "## Purpose",
    "",
    "Describe when this skill pack should help a model reason or prepare work.",
    "",
    "## Procedure",
    "",
    "1. Clarify the user goal and the expected output.",
    "2. Use declared resources only when they are relevant.",
    "3. Ask for a governed Touba tool or skill when execution is required.",
    "",
    "## Boundaries",
    "",
    "- This pack provides procedural context only.",
    "- It does not grant runtime authority, secrets, handlers, memory scopes or permissions.",
    "- Scripts in scripts/ are resources until exposed through a governed Touba tool.",
    "",
  ].join("\n");
}

function titleFromSkillId(skillId) {
  return skillId
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function ensureDirectory(path, created, preserved) {
  if (existsSync(path)) {
    preserved.push(path);
    return;
  }
  mkdirSync(path, { recursive: true });
  created.push(path);
}

function writeSkillPackFile(path, content, force, created, preserved) {
  if (existsSync(path) && force !== true) {
    preserved.push(path);
    return;
  }
  writeFileSync(path, content, "utf8");
  created.push(path);
}

function digestFile(path) {
  const hash = crypto.createHash("sha256");
  hash.update(readFileSync(path));
  return `sha256:${hash.digest("hex")}`;
}

function errorDiagnostic(code, message, extra = {}) {
  return { severity: "error", code, message, ...extra };
}

export function toPosixPath(path) {
  return path.split(sep).join("/");
}
