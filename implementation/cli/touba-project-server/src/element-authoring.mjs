import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { effectContractToJson, normalizeEffectContract } from "../../touba-manifest/src/effect-contract.mjs";

export const ELEMENT_AUTHORING_SCHEMA_VERSION = "touba-element-authoring-request-v1";

const ELEMENT_KINDS = new Set([
  "memory",
  "function",
  "tool",
  "skill",
  "agent",
  "strategy",
  "trigger",
]);
const CAPABILITY_KINDS = new Set(["function", "tool", "skill", "agent", "strategy"]);
const REQUIREMENTS = new Set([
  "network",
  "filesystem_read",
  "filesystem_write",
  "secret_read",
  "memory_read",
  "memory_write",
]);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/u;
const MODULE_REF = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;
const TYPE_REF = /^[A-Za-z][A-Za-z0-9_.]*$/u;
const SECRET_REF = /^[A-Z][A-Z0-9_]*$/u;
const DECLARATION = /^(memory|function|tool|skill|agent|strategy|trigger)\s+([A-Za-z][A-Za-z0-9_]*)\b/gmu;
const MODULE_LINE = /^module\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*$/mu;

export function buildElementAuthoringChangeSet({ projectRoot, request }) {
  const normalized = normalizeElementAuthoringRequest(request);
  const source = findModuleSource(projectRoot, normalized.module_ref);
  const declarations = declaredElements(source.content, normalized.module_ref);
  const elementRef = `${normalized.element.kind}:${normalized.module_ref}/${normalized.element.name}`;
  if (declarations.has(elementRef)) {
    throw authoringError("ToubaServeElementAlreadyExists", `${elementRef} already exists`);
  }
  validateElementReferences(normalized, declarations);

  const sourceContent = appendSourceBlock(
    source.content,
    renderElementSource(normalized.element, normalized.module_ref),
  );
  const changes = [{
    path: source.path,
    content: sourceContent,
    role: "source",
  }];

  if (normalized.element.kind === "tool") {
    const handlerPath = handlerRelativePath(normalized.module_ref, normalized.element.name);
    changes.push({
      path: "touba.manifest.json",
      content: renderManifest({
        projectRoot,
        moduleRef: normalized.module_ref,
        element: normalized.element,
        handlerPath,
      }),
      role: "manifest",
    });
    changes.push({
      path: handlerPath,
      content: renderHandlerStub({
        moduleRef: normalized.module_ref,
        name: normalized.element.name,
      }),
      role: "handler_stub",
    });
  }

  if (normalized.element.kind === "trigger") {
    changes.push({
      path: "touba.manifest.json",
      content: renderTriggerManifest({
        projectRoot,
        moduleRef: normalized.module_ref,
        element: normalized.element,
      }),
      role: "manifest",
    });
  }

  return {
    proposal_id: normalized.proposal_id,
    requested_by: normalized.requested_by,
    reason: normalized.reason,
    element_ref: elementRef,
    preview_digest: normalized.preview_digest,
    changes,
  };
}

export function normalizeElementAuthoringRequest(request) {
  if (!isRecord(request) || request.schema_version !== ELEMENT_AUTHORING_SCHEMA_VERSION) {
    throw authoringError(
      "ToubaServeElementAuthoringInvalid",
      `element authoring request must use ${ELEMENT_AUTHORING_SCHEMA_VERSION}`,
    );
  }
  assertKnownKeys(
    request,
    ["schema_version", "proposal_id", "module_ref", "element", "requested_by", "reason", "preview_digest"],
    "request",
  );
  const proposalId = nonEmptyString(request.proposal_id, "proposal_id");
  const moduleRef = nonEmptyString(request.module_ref, "module_ref");
  if (!MODULE_REF.test(moduleRef)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "module_ref is not a valid Touba module reference");
  }
  if (!isRecord(request.element) || !ELEMENT_KINDS.has(request.element.kind)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "element.kind is not supported");
  }
  assertKnownKeys(
    request.element,
    [
      "kind",
      "name",
      "description",
      "responsibility",
      "takes",
      "gives",
      "uses",
      "callable_by",
      "memories",
      "requirements",
      "secrets",
      "handler",
      "trigger",
    ],
    "element",
  );
  const kind = request.element.kind;
  const name = identifier(request.element.name, "element.name");
  const description = typeof request.element.description === "string"
    ? request.element.description.trim()
    : "";
  if (CAPABILITY_KINDS.has(kind) && description.length < 12) {
    throw authoringError(
      "ToubaServeElementDescriptionRequired",
      `${kind} descriptions must contain at least 12 characters`,
    );
  }
  if (/[\r\n"]/u.test(description)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "element.description must be a single line without quotes");
  }
  const responsibility = typeof request.element.responsibility === "string"
    ? request.element.responsibility.trim()
    : "";
  if (kind === "agent" && responsibility.length < 12) {
    throw authoringError(
      "ToubaServeElementResponsibilityRequired",
      "agent responsibility must contain at least 12 characters",
    );
  }
  if (/[\r\n"]/u.test(responsibility)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "element.responsibility must be a single line without quotes");
  }
  if (kind !== "agent" && responsibility !== "") {
    throw authoringError("ToubaServeElementAuthoringInvalid", "responsibility is valid only for agents");
  }
  const takes = normalizeTakes(request.element.takes);
  const gives = request.element.gives === undefined || request.element.gives === null
    ? null
    : typeRef(request.element.gives, "element.gives");
  const uses = uniqueStrings(request.element.uses, "element.uses");
  const callableBy = uniqueStrings(request.element.callable_by, "element.callable_by");
  const memories = normalizeMemories(request.element.memories);
  const requirements = uniqueStrings(request.element.requirements, "element.requirements");
  for (const requirement of requirements) {
    if (!REQUIREMENTS.has(requirement)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", `unsupported requirement ${requirement}`);
    }
  }
  const secrets = uniqueStrings(request.element.secrets, "element.secrets");
  for (const secret of secrets) {
    if (!SECRET_REF.test(secret)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", `secret handle ${secret} is invalid`);
    }
  }
  if (secrets.length > 0 && !requirements.includes("secret_read")) {
    throw authoringError(
      "ToubaServeElementAuthoringInvalid",
      "tools declaring secret handles must require secret_read",
    );
  }
  if ((requirements.length > 0 || secrets.length > 0 || request.element.handler !== undefined) && kind !== "tool") {
    throw authoringError(
      "ToubaServeElementAuthoringInvalid",
      "requirements, secrets and handler settings are valid only for tools",
    );
  }
  const handler = normalizeHandler(request.element.handler, kind);
  const trigger = normalizeTrigger(request.element.trigger, kind);
  if (kind === "agent" && uses.length === 0) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "agents must declare at least one governed capability");
  }
  if (kind === "agent" && callableBy.length === 0) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "agents must declare at least one callable_by strategy");
  }
  if (kind !== "agent" && callableBy.length > 0) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "callable_by is valid only for agents");
  }
  if (!["tool", "skill", "agent"].includes(kind) && memories.length > 0) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "memory scopes are not supported for this element kind");
  }
  if (kind === "memory" && (takes.length > 0 || gives !== null || uses.length > 0)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "memory declarations cannot define signatures or uses");
  }
  if (kind === "trigger" && (takes.length > 0 || gives !== null || uses.length > 0)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "trigger signatures are derived from their target strategy");
  }

  return {
    schema_version: ELEMENT_AUTHORING_SCHEMA_VERSION,
    proposal_id: proposalId,
    module_ref: moduleRef,
    element: {
      kind,
      name,
      description,
      responsibility,
      takes,
      gives,
      uses,
      callable_by: callableBy,
      memories,
      requirements,
      secrets,
      handler,
      trigger,
    },
    requested_by: normalizeActor(request.requested_by),
    reason: typeof request.reason === "string" ? request.reason.trim() : "",
    preview_digest: request.preview_digest === undefined
      ? null
      : nonEmptyString(request.preview_digest, "preview_digest"),
  };
}

function renderElementSource(element, moduleRef) {
  const lines = [`${element.kind} ${element.name}`];
  if (element.description !== "" && element.kind !== "memory" && element.kind !== "trigger") {
    lines.push(`    description "${element.description}"`);
  }
  if (element.kind === "agent") {
    lines.push(`    responsibility "${element.responsibility}"`);
  }
  for (const input of element.takes) {
    lines.push(`    takes ${input.name} as ${input.type_ref}`);
  }
  if (element.gives !== null) {
    lines.push(`    gives ${element.gives}`);
  }
  for (const use of element.uses) {
    lines.push(`    uses ${localRefName(use, moduleRef)}`);
  }
  for (const memory of element.memories) {
    lines.push(`    memory ${localRefName(memory.ref, moduleRef)} ${memory.access}`);
  }
  for (const caller of element.callable_by) {
    const parsed = parseElementRef(caller, moduleRef);
    lines.push(`    callable_by ${parsed.kind} ${parsed.name}`);
  }
  for (const requirement of element.requirements) {
    lines.push(`    requires ${requirement}`);
  }
  for (const secret of element.secrets) {
    lines.push(`    secrets ${secret}`);
  }

  if (element.kind === "function" || element.kind === "skill" || element.kind === "strategy") {
    renderIdentityBody(lines, element);
  }
  if (element.kind === "trigger") {
    renderTriggerBody(lines, element.trigger, moduleRef);
  }
  return lines.join("\n");
}

function renderIdentityBody(lines, element) {
  lines.push("    do");
  if (element.gives === null) {
    return;
  }
  const matchingInput = element.takes.find((input) => input.type_ref === element.gives);
  if (matchingInput === undefined) {
    throw authoringError(
      "ToubaServeElementAuthoringInvalid",
      `${element.kind} ${element.name} needs an input matching gives ${element.gives} for its generated safe body`,
    );
  }
  lines.push(`        give ${matchingInput.name}`);
}

function renderTriggerBody(lines, trigger, moduleRef) {
  if (trigger.event_kind === "request") {
    lines.push(`    on request ${trigger.method} "${trigger.path}"`);
  } else {
    lines.push(`    on schedule "${trigger.schedule}"`);
  }
  lines.push(`    runs strategy ${localRefName(trigger.target_ref, moduleRef)}`);
  for (const [inputName, jsonPath] of Object.entries(trigger.payload_map)) {
    lines.push(`    with ${inputName} as payload.${jsonPath.slice(2)}`);
  }
  lines.push("    limits");
  lines.push(`        max_runs_per_day as ${trigger.max_runs_per_day}`);
  lines.push(`        timeout_ms as ${trigger.timeout_ms}`);
}

function renderManifest({ projectRoot, moduleRef, element, handlerPath }) {
  const manifest = readManifest(projectRoot);
  const toolRef = `tool:${moduleRef}/${element.name}`;
  if (Object.hasOwn(manifest.bindings, toolRef)) {
    throw authoringError("ToubaServeElementAlreadyExists", `${toolRef} already has a manifest binding`);
  }
  const binding = {
    handler: {
      kind: "process",
      command: "node",
      args: [handlerPath],
      cwd: ".",
    },
    grants: [...element.requirements],
    effect_contract: element.handler.effect_contract,
    timeout_ms: element.handler.timeout_ms,
    max_payload_bytes: element.handler.max_payload_bytes,
  };
  if (element.memories.length > 0) {
    binding.memories = element.memories.map((item) => ({
      ref: canonicalElementRef(item.ref, moduleRef),
      access: item.access,
    }));
  }
  if (element.secrets.length > 0) {
    binding.secrets = [...element.secrets];
  }
  if (element.handler.sandbox_required) {
    binding.sandbox = { required: true };
  }
  manifest.bindings[toolRef] = binding;
  return stableJson(manifest);
}

function renderTriggerManifest({ projectRoot, moduleRef, element }) {
  const manifest = readManifest(projectRoot);
  const triggerRef = `trigger:${moduleRef}/${element.name}`;
  if (Object.hasOwn(manifest.triggers, triggerRef)) {
    throw authoringError("ToubaServeElementAlreadyExists", `${triggerRef} already has a manifest binding`);
  }
  manifest.triggers[triggerRef] = {
    enabled: false,
    source: {
      kind: element.trigger.event_kind,
    },
    limits: {
      max_runs_per_day: element.trigger.max_runs_per_day,
      timeout_ms: element.trigger.timeout_ms,
    },
  };
  return stableJson(manifest);
}

function renderHandlerStub({ moduleRef, name }) {
  return [
    "#!/usr/bin/env node",
    "// Touba generated handler stub v0.1",
    `"use strict";`,
    "",
    `const handlerRef = ${JSON.stringify(`tool:${moduleRef}/${name}`)};`,
    `const error = {`,
    `  schema_version: "touba-handler-error-v1",`,
    `  code: "HandlerStubNotImplemented",`,
    `  message: \`\${handlerRef} has no implementation\`,`,
    `};`,
    `process.stderr.write(\`\${JSON.stringify(error)}\\n\`);`,
    "process.exitCode = 1;",
    "",
  ].join("\n");
}

function validateElementReferences(request, declarations) {
  const { element, module_ref: moduleRef } = request;
  const references = [
    ...element.uses,
    ...element.callable_by,
    ...element.memories.map((item) => item.ref),
  ];
  if (element.trigger !== null) {
    references.push(element.trigger.target_ref);
  }
  for (const reference of references) {
    const canonical = canonicalElementRef(reference, moduleRef);
    if (!declarations.has(canonical)) {
      throw authoringError("ToubaServeElementReferenceUnknown", `${canonical} is not declared in ${moduleRef}`);
    }
  }
  if (element.kind === "agent") {
    for (const reference of element.callable_by) {
      if (parseElementRef(reference, moduleRef).kind !== "strategy") {
        throw authoringError("ToubaServeElementReferenceInvalid", "callable_by accepts strategy references only");
      }
    }
  }
  if (element.trigger !== null && parseElementRef(element.trigger.target_ref, moduleRef).kind !== "strategy") {
    throw authoringError("ToubaServeElementReferenceInvalid", "triggers must target a strategy");
  }
}

function findModuleSource(projectRoot, moduleRef) {
  const matches = [];
  for (const path of walkToubaSources(projectRoot)) {
    const content = readFileSync(join(projectRoot, path), "utf8");
    if (content.match(MODULE_LINE)?.[1] === moduleRef) {
      matches.push({ path, content });
    }
  }
  if (matches.length === 0) {
    throw authoringError("ToubaServeElementModuleNotFound", `module ${moduleRef} is not present in the project`);
  }
  if (matches.length > 1) {
    throw authoringError("ToubaServeElementModuleAmbiguous", `module ${moduleRef} is declared by multiple source files`);
  }
  return matches[0];
}

function walkToubaSources(projectRoot) {
  const sourceRoot = join(projectRoot, "src");
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    return [];
  }
  const paths = [];
  const visit = (directory, depth) => {
    if (depth > 8) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".tb")) {
        paths.push(relative(projectRoot, absolute).replaceAll("\\", "/"));
      }
    }
  };
  visit(sourceRoot, 0);
  return paths.sort();
}

function declaredElements(content, moduleRef) {
  const refs = new Set();
  DECLARATION.lastIndex = 0;
  for (const match of content.matchAll(DECLARATION)) {
    refs.add(`${match[1]}:${moduleRef}/${match[2]}`);
  }
  return refs;
}

function readManifest(projectRoot) {
  const path = join(projectRoot, "touba.manifest.json");
  if (!existsSync(path)) {
    return {
      manifest_version: "touba-manifest-v1",
      bindings: {},
      triggers: {},
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw authoringError("ToubaServeElementManifestInvalid", `touba.manifest.json is invalid: ${cause.message}`);
  }
  if (manifest.manifest_version !== "touba-manifest-v1") {
    throw authoringError("ToubaServeElementManifestInvalid", "touba.manifest.json must use touba-manifest-v1");
  }
  if (!isRecord(manifest.bindings) || !isRecord(manifest.triggers)) {
    throw authoringError("ToubaServeElementManifestInvalid", "manifest bindings and triggers must be objects");
  }
  return structuredClone(manifest);
}

function normalizeTrigger(value, kind) {
  if (kind !== "trigger") {
    if (value !== undefined) {
      throw authoringError("ToubaServeElementAuthoringInvalid", "trigger settings are valid only for triggers");
    }
    return null;
  }
  if (!isRecord(value)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "trigger settings are required");
  }
  const eventKind = value.event_kind;
  if (!["request", "schedule"].includes(eventKind)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "trigger event_kind must be request or schedule");
  }
  let method = null;
  let path = null;
  let schedule = null;
  const payloadMap = {};
  if (eventKind === "request") {
    method = nonEmptyString(value.method, "element.trigger.method").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", "unsupported trigger HTTP method");
    }
    path = nonEmptyString(value.path, "element.trigger.path");
    if (!path.startsWith("/") || /\s/u.test(path)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", "trigger path must start with / and contain no spaces");
    }
    if (value.payload_map !== undefined && !isRecord(value.payload_map)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", "trigger payload_map must be an object");
    }
    for (const [name, jsonPath] of Object.entries(value.payload_map ?? {})) {
      identifier(name, "element.trigger.payload_map key");
      if (typeof jsonPath !== "string" || !/^\$\.[A-Za-z][A-Za-z0-9_.]*$/u.test(jsonPath)) {
        throw authoringError("ToubaServeElementAuthoringInvalid", "trigger payload paths must use $.field notation");
      }
      payloadMap[name] = jsonPath;
    }
  } else {
    schedule = nonEmptyString(value.schedule, "element.trigger.schedule");
    if (/[\r\n"]/u.test(schedule)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", "trigger schedule must be a single line without quotes");
    }
    if (value.payload_map !== undefined && Object.keys(value.payload_map).length > 0) {
      throw authoringError("ToubaServeElementAuthoringInvalid", "schedule triggers cannot map request payloads");
    }
  }
  return {
    event_kind: eventKind,
    method,
    path,
    schedule,
    target_ref: nonEmptyString(value.target_ref, "element.trigger.target_ref"),
    payload_map: payloadMap,
    max_runs_per_day: boundedInteger(value.max_runs_per_day, "element.trigger.max_runs_per_day", 1, 100000),
    timeout_ms: boundedInteger(value.timeout_ms, "element.trigger.timeout_ms", 1, 3600000),
  };
}

function normalizeHandler(value, kind) {
  if (kind !== "tool") {
    return null;
  }
  const source = value === undefined ? {} : value;
  if (!isRecord(source)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "element.handler must be an object");
  }
  if (source.effect_contract === undefined) {
    throw authoringError("ToubaServeElementEffectContractRequired", "Choose an explicit effect contract for the tool handler");
  }
  const effectContract = effectContractToJson(normalizeEffectContract(source.effect_contract));
  return {
    effect_contract: effectContract,
    timeout_ms: source.timeout_ms === undefined
      ? 5000
      : boundedInteger(source.timeout_ms, "element.handler.timeout_ms", 1, 3600000),
    max_payload_bytes: source.max_payload_bytes === undefined
      ? 1048576
      : boundedInteger(source.max_payload_bytes, "element.handler.max_payload_bytes", 1, 16777216),
    sandbox_required: source.sandbox_required !== false,
  };
}

function normalizeTakes(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "element.takes must be an array");
  }
  const names = new Set();
  return value.map((item) => {
    if (!isRecord(item)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", "each input must be an object");
    }
    const name = identifier(item.name, "element.takes.name");
    if (names.has(name)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", `duplicate input ${name}`);
    }
    names.add(name);
    return {
      name,
      type_ref: typeRef(item.type_ref, "element.takes.type_ref"),
    };
  });
}

function normalizeMemories(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "element.memories must be an array");
  }
  const seen = new Set();
  return value.map((item) => {
    if (!isRecord(item) || !["read", "write"].includes(item.access)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", "memory scopes need ref and read/write access");
    }
    const ref = nonEmptyString(item.ref, "element.memories.ref");
    const key = `${ref}:${item.access}`;
    if (seen.has(key)) {
      throw authoringError("ToubaServeElementAuthoringInvalid", `duplicate memory scope ${key}`);
    }
    seen.add(key);
    return { ref, access: item.access };
  });
}

function parseElementRef(value, moduleRef) {
  const raw = nonEmptyString(value, "element reference");
  const qualified = raw.match(/^([a-z_]+):([a-z][a-z0-9_.]*)\/([A-Za-z][A-Za-z0-9_]*)$/u);
  if (qualified !== null) {
    if (qualified[2] !== moduleRef) {
      throw authoringError(
        "ToubaServeElementCrossModuleReferenceRejected",
        "element authoring currently accepts references from the edited module only",
      );
    }
    return { kind: qualified[1], module_ref: qualified[2], name: qualified[3] };
  }
  const local = raw.match(/^([a-z_]+):([A-Za-z][A-Za-z0-9_]*)$/u);
  if (local !== null) {
    return { kind: local[1], module_ref: moduleRef, name: local[2] };
  }
  throw authoringError("ToubaServeElementReferenceInvalid", `${raw} is not a typed Touba element reference`);
}

function canonicalElementRef(value, moduleRef) {
  const parsed = parseElementRef(value, moduleRef);
  return `${parsed.kind}:${parsed.module_ref}/${parsed.name}`;
}

function localRefName(value, moduleRef) {
  return parseElementRef(value, moduleRef).name;
}

function handlerRelativePath(moduleRef, name) {
  return `handlers/${moduleRef.replaceAll(".", "/")}/${snakeCase(name)}.handler.mjs`;
}

function appendSourceBlock(content, block) {
  return `${content.trimEnd()}\n\n${block}\n`;
}

function stableJson(value) {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObject(item)]),
  );
}

function snakeCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

function uniqueStrings(value, field) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", `${field} must be an array`);
  }
  const result = value.map((item) => nonEmptyString(item, field));
  if (new Set(result).size !== result.length) {
    throw authoringError("ToubaServeElementAuthoringInvalid", `${field} contains duplicates`);
  }
  return result;
}

function normalizeActor(value) {
  if (!isRecord(value) || !["studio", "user", "service"].includes(value.kind)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "requested_by.kind is invalid");
  }
  return {
    kind: value.kind,
    id: nonEmptyString(value.id, "requested_by.id"),
  };
}

function identifier(value, field) {
  const normalized = nonEmptyString(value, field);
  if (!IDENTIFIER.test(normalized)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", `${field} is not a valid Touba identifier`);
  }
  return normalized;
}

function typeRef(value, field) {
  const normalized = nonEmptyString(value, field);
  if (!TYPE_REF.test(normalized)) {
    throw authoringError("ToubaServeElementAuthoringInvalid", `${field} is not a valid Touba type reference`);
  }
  return normalized;
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw authoringError("ToubaServeElementAuthoringInvalid", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw authoringError(
      "ToubaServeElementAuthoringInvalid",
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function assertKnownKeys(value, allowed, field) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw authoringError(
      "ToubaServeElementAuthoringInvalid",
      `${field} contains unsupported field(s): ${unknown.join(", ")}`,
    );
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authoringError(code, message) {
  return Object.assign(new Error(message), { code });
}
