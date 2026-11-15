import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isAuthoringTypeReference } from "../../../contracts/product-surfaces/input-contracts.mjs";
import { effectContractToJson, normalizeEffectContract } from "../../touba-manifest/src/effect-contract.mjs";
import { generateHandlerStubFromAirTool } from "../../touba-manifest/src/stub.mjs";
import { handlerRelativePathForTool } from "../../touba-manifest/src/requirements.mjs";
import { projectPythonCommand } from "../../touba-manifest/src/python-sdk-dependency.mjs";
import { compileProposedSources } from "./source-validation.mjs";
import { readPreparedProject } from "./prepared-project.mjs";
import { parseTriggerRunnerSchedule } from '../../../contracts/trigger-schedule.mjs';
import { elementRemovalChanges } from './element-removal.mjs';

export const ELEMENT_AUTHORING_SCHEMA_VERSION = "touba-element-authoring-request-v1";

const ELEMENT_KINDS = new Set([
  "module",
  "type",
  "enum",
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
// The same lexical input contract is consumed by client; compilation resolves types.
const SECRET_REF = /^[A-Z][A-Z0-9_]*$/u;
const DECLARATION = /^(type|enum|memory|function|tool|skill|agent|strategy|trigger)\s+([A-Za-z][A-Za-z0-9_]*)\b/gmu;
const MODULE_LINE = /^module\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*$/mu;

export function buildElementAuthoringChangeSet({ projectRoot, request }) {
  if (request?.source_remove !== undefined) {
    assertKnownKeys(request, ['schema_version','proposal_id','module_ref','element','requested_by','reason','preview_digest','source_remove'], 'request');
    assertKnownKeys(request.element, ['kind','name','description'], 'element');
    assertKnownKeys(request.source_remove, ['base_digest'], 'source_remove');
    if (request.schema_version !== ELEMENT_AUTHORING_SCHEMA_VERSION || !['tool','trigger'].includes(request.element?.kind))
      throw authoringError('ToubaServeElementAuthoringInvalid', 'removal requires a local tool or trigger');
    const ref = `${request.element.kind}:${request.module_ref}/${request.element.name}`;
    const current = readElementSource({projectRoot,elementRef:ref});
    if (current.base_digest !== request.source_remove.base_digest) throw authoringError('ToubaServeElementPreviewStale', 'source changed since removal was opened');
    return {proposal_id:nonEmptyString(request.proposal_id,'proposal_id'),requested_by:normalizeActor(request.requested_by),
      reason:nonEmptyString(request.reason,'reason'),preview_digest:request.preview_digest ?? null,element_ref:ref,
      changes:elementRemovalChanges({projectRoot,current})};
  }
  if (request?.source_update !== undefined) return buildSourceUpdate({ projectRoot, request });
  const normalized = normalizeElementAuthoringRequest(request);
  if (normalized.element.kind === "module") {
    const path = `src/${normalized.module_ref.replaceAll(".", "/")}.tb`;
    const existing = walkToubaSources(projectRoot).some(name => readFileSync(join(projectRoot, name), "utf8").match(MODULE_LINE)?.[1] === normalized.module_ref);
    if (existing || existsSync(join(projectRoot, path))) throw authoringError("ToubaServeElementAlreadyExists", `module ${normalized.module_ref} already exists`);
    return { ...normalized, element_ref: `module:${normalized.module_ref}`,
      changes: [{ path, content: `module ${normalized.module_ref}\n`, role: "source" }] };
  }
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
    const compiled = compileProposedSources({ projectRoot, targets: changes });
    const tool = compiled.air?.definitions?.tools?.find(item => item.id === elementRef);
    if (!tool) throw Object.assign(authoringError("ToubaServeChangeValidationFailed", "tool declaration failed project compilation"), { diagnostics: compiled.diagnostics });
    const configPath = join(projectRoot, "touba.project.json");
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null;
    const language = config?.language ?? "javascript";
    if (!["javascript", "python"].includes(language)) throw authoringError("ToubaServeElementAuthoringInvalid", "project SDK language is unsupported");
    const handlerPath = handlerRelativePathForTool(tool, { handlerExtension: language === "python" ? "py" : "mjs" });
    const binding = renderToolBinding({
        projectRoot,
        moduleRef: normalized.module_ref,
        element: normalized.element,
        handlerPath,
        language,
        cwd: config ? "../../.." : ".",
    });
    if (config) {
      changes.push(...persistentToolBinding({ projectRoot, config, toolRef: elementRef, binding }));
    } else {
      const manifest = readManifest(projectRoot);
      if (Object.hasOwn(manifest.bindings, elementRef)) throw authoringError("ToubaServeElementAlreadyExists", `${elementRef} already has a manifest binding`);
      manifest.bindings[elementRef] = binding;
      changes.push({ path: "touba.manifest.json", content: stableJson(manifest), role: "manifest" });
    }
    changes.push({
      path: handlerPath,
      content: generateHandlerStubFromAirTool(tool, { language }),
      role: "handler_stub",
    });
  }

  // Modern preparation derives disabled trigger entries from the compiled source.
  // Do not write a second root manifest that canonical prepare never reads.
  if (normalized.element.kind === "trigger" && !existsSync(join(projectRoot, "touba.project.json"))) {
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

  if (normalized.element.entrypoint) {
    const path = "touba.project.json";
    const configChange = changes.find(item => item.path === path);
    const config = configChange ? JSON.parse(configChange.content) : JSON.parse(readFileSync(join(projectRoot, path), "utf8"));
    config.entrypoints = [...new Set([...(config.entrypoints ?? []), ...(config.entry ? [config.entry] : []), elementRef])];
    if (!config.entry) config.entry = elementRef;
    if (configChange) configChange.content = stableJson(config);
    else changes.push({ path, content: stableJson(config), role: "manifest" });
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

const sourceDigest = content => `sha256:${createHash('sha256').update(content).digest('hex')}`;

export function readElementSource({ projectRoot, elementRef }) {
  const match = /^(module|type|enum|memory|function|tool|skill|agent|strategy|trigger):([a-z][a-z0-9_.]*)(?:\/([A-Za-z][A-Za-z0-9_]*))?$/.exec(elementRef ?? '');
  if (!match || (match[1] === 'module') !== !match[3]) throw authoringError('ToubaServeElementReferenceInvalid', 'an existing local declaration is required');
  const [, kind, moduleRef, name] = match;
  const source = findModuleSource(projectRoot, moduleRef);
  if (kind !== 'module' && !new RegExp(`^${kind}\\s+${name}\\b`, 'm').test(source.content)) {
    throw authoringError('ToubaServeElementReferenceInvalid', 'the declaration is not defined in this local module');
  }
  if (Buffer.byteLength(source.content) > 65536) throw authoringError('ToubaServeChangeTooLarge', 'source editing is limited to 64 KiB');
  return { schema_version: 'touba-element-source-v1', element_ref: elementRef, module_ref: moduleRef,
    kind, name: name ?? moduleRef, path: source.path, content: source.content, base_digest: sourceDigest(source.content) };
}

function buildSourceUpdate({ projectRoot, request }) {
  if (request.schema_version !== ELEMENT_AUTHORING_SCHEMA_VERSION) throw authoringError('ToubaServeElementAuthoringInvalid', 'invalid source edit schema');
  assertKnownKeys(request, ['schema_version', 'proposal_id', 'module_ref', 'element', 'requested_by', 'reason', 'preview_digest', 'source_update'], 'request');
  assertKnownKeys(request.element, ['kind', 'name', 'description'], 'element');
  assertKnownKeys(request.source_update, ['content', 'base_digest'], 'source_update');
  const { kind, name } = request.element;
  const ref = kind === 'module' ? `module:${request.module_ref}` : `${kind}:${request.module_ref}/${name}`;
  const current = readElementSource({ projectRoot, elementRef: ref });
  if (current.base_digest !== request.source_update.base_digest) throw authoringError('ToubaServeElementPreviewStale', 'source changed since the editor was opened');
  const content = request.source_update.content;
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > 65536) throw authoringError('ToubaServeChangeTooLarge', 'source editing requires bounded UTF-8 text');
  if (content.match(MODULE_LINE)?.[1] !== current.module_ref) throw authoringError('ToubaServeElementReferenceInvalid', 'the edited module identity must remain unchanged');
  return { proposal_id: nonEmptyString(request.proposal_id, 'proposal_id'), element_ref: ref,
    requested_by: normalizeActor(request.requested_by), reason: nonEmptyString(request.reason, 'reason'),
    preview_digest: request.preview_digest ?? null,
    changes: [{ path: current.path, content, role: 'source' }] };
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
      "fields", "variants", "body", "approval_policy", "entrypoint",
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
  const fields = normalizeTakes(request.element.fields);
  const variants = uniqueStrings(request.element.variants, "element.variants").map(value => identifier(value, "enum variant"));
  if (variants.length > 256 || fields.length > 64) throw authoringError("ToubaServeElementAuthoringInvalid", "declaration exceeds the field or variant limit");
  if (kind === "type" ? !fields.length : fields.length) throw authoringError("ToubaServeElementAuthoringInvalid", "fields are required for types only");
  if (kind === "enum" ? !variants.length : variants.length) throw authoringError("ToubaServeElementAuthoringInvalid", "variants are required for enums only");
  if (["module", "type", "enum"].includes(kind) && (takes.length || gives !== null || uses.length)) throw authoringError("ToubaServeElementAuthoringInvalid", "data declarations cannot define signatures or uses");
  const body = normalizeBody(request.element.body, kind);
  const approvalPolicy = normalizeApprovalPolicy(request.element.approval_policy, kind);
  if (request.element.entrypoint !== undefined && (typeof request.element.entrypoint !== "boolean"
    || !["tool", "skill", "strategy", "function", "trigger"].includes(kind))) throw authoringError("ToubaServeElementAuthoringInvalid", "entrypoint is valid only for executable declarations");
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
      fields, variants, body, approval_policy: approvalPolicy, entrypoint: request.element.entrypoint === true,
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
  if (element.kind === "type") return [...lines, ...element.fields.map(field => `    ${field.name} is ${field.type_ref}`)].join("\n");
  if (element.kind === "enum") return [...lines, ...element.variants.map(name => `    ${name}`)].join("\n");
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
    lines.push(`    ${element.kind === "tool" ? "uses " : ""}memory ${localRefName(memory.ref, moduleRef)} ${memory.access}`);
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
  if (element.approval_policy) {
    lines.push("    human.approve");
    for (const [key, value] of Object.entries(element.approval_policy)) lines.push(`        with ${key} as ${JSON.stringify(value)}`);
  }

  if (element.kind === "function" || element.kind === "skill" || element.kind === "strategy") {
    if (element.body) lines.push("    do", ...element.body.map(line => `        ${line}`));
    else renderIdentityBody(lines, element);
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
  for (const [inputName, value] of Object.entries(trigger.arguments)) lines.push(`    with ${inputName} as ${JSON.stringify(value)}`);
  lines.push("    limits");
  lines.push(`        max_runs_per_day as ${trigger.max_runs_per_day}`);
  lines.push(`        timeout_ms as ${trigger.timeout_ms}`);
}

function renderToolBinding({ projectRoot, moduleRef, element, handlerPath, language, cwd }) {
  if (language === 'python' && element.handler.sandbox_required) {
    // Inventorying an interpreter executes a host binary. Source preview must
    // not run project code or silently grant access to Python installation files.
    throw authoringError('ToubaServeElementSandboxInventoryRequired',
      'A confined Python handler requires a reviewed interpreter and code inventory. Prepare its binding with touba sdk sandbox python --handler <file>, then add it through a binding fragment. No project file was changed.');
  }
  const binding = {
    handler: {
      kind: "process",
      command: language === "python" ? projectPythonCommand(projectRoot) : process.execPath,
      args: [handlerPath],
      cwd,
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
  return binding;
}

function persistentToolBinding({ projectRoot, config, toolRef, binding }) {
  const path = "touba.bindings.json";
  const fragments = config.configuration?.binding_fragments ?? [];
  // Preserve previously reviewed bindings when adding the first explicit fragment.
  // Stale preparation must be reconciled first, not copied into new authority.
  const prepared = readPreparedProject(projectRoot);
  const manifestInput = prepared?.inputs.find(item => item.kind === "manifest");
  const previous = fragments.length === 0 && manifestInput
    ? JSON.parse(readFileSync(join(projectRoot, manifestInput.path), "utf8")).bindings : {};
  const fragment = existsSync(join(projectRoot, path))
    ? JSON.parse(readFileSync(join(projectRoot, path), "utf8"))
    : { fragment_schema_version: "touba-binding-fragment-v1", source: { kind: "project" }, bindings: previous };
  if (fragment.fragment_schema_version !== "touba-binding-fragment-v1" || fragment.source?.kind !== "project" || !isRecord(fragment.bindings)) {
    throw authoringError("ToubaServeElementManifestInvalid", `${path} must be a project binding fragment`);
  }
  if (Object.hasOwn(fragment.bindings, toolRef)) throw authoringError("ToubaServeElementAlreadyExists", `${toolRef} already has a fragment binding`);
  fragment.bindings[toolRef] = binding;
  return [
    { path, content: stableJson(fragment), role: "manifest" },
    { path: "touba.project.json", content: stableJson({ ...config, configuration: { ...config.configuration,
      binding_fragments: [...new Set([...fragments, path])] } }), role: "manifest" },
  ];
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
      throw authoringError("ToubaServeElementReferenceUnknown", `${canonical} is not declared or imported in ${moduleRef}`);
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
  const sourceRelative = relative(realpathSync(projectRoot), realpathSync(sourceRoot));
  if (isAbsolute(sourceRelative) || sourceRelative === '..' || sourceRelative.replaceAll('\\', '/').startsWith('../')) throw authoringError('ToubaServeElementReferenceInvalid', 'source root must belong to the project');
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
  for (const match of content.matchAll(/^import\s+(function|tool|skill|agent|strategy)\s+([A-Za-z][A-Za-z0-9_]*)\s+from\s+([a-z][a-z0-9_.]*)\s*$/gmu)) {
    refs.add(`${match[1]}:${match[3]}/${match[2]}`);
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
  assertKnownKeys(value, ["event_kind", "method", "path", "schedule", "target_ref", "payload_map", "arguments", "max_runs_per_day", "timeout_ms"], "element.trigger");
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
    if (!parseTriggerRunnerSchedule(schedule).ok) {
      throw authoringError('TriggerScheduleUnsupported', 'element.trigger.schedule: use every Ns, every Nm, every Nh or every Nd, up to 2147483647 ms');
    }
    if (value.payload_map !== undefined && Object.keys(value.payload_map).length > 0) {
      throw authoringError("ToubaServeElementAuthoringInvalid", "schedule triggers cannot map request payloads");
    }
  }
  const args = value.arguments ?? {};
  if (!isRecord(args) || Object.keys(args).length > 64) throw authoringError("ToubaServeElementAuthoringInvalid", "trigger arguments must be a bounded object");
  for (const [name, literal] of Object.entries(args)) {
    identifier(name, "trigger argument");
    if (Object.hasOwn(payloadMap, name) || !["string", "number", "boolean"].includes(typeof literal)
      || (typeof literal === "number" && !Number.isFinite(literal))
      || (typeof literal === "string" && (literal.length > 4096 || /[\r\n\u0000]/u.test(literal)))) throw authoringError("ToubaServeElementAuthoringInvalid", "trigger argument must be one distinct finite scalar literal");
  }
  return {
    event_kind: eventKind,
    method,
    path,
    schedule,
    target_ref: nonEmptyString(value.target_ref, "element.trigger.target_ref"),
    payload_map: payloadMap,
    arguments: args,
    max_runs_per_day: boundedInteger(value.max_runs_per_day, "element.trigger.max_runs_per_day", 1, 100000),
    timeout_ms: boundedInteger(value.timeout_ms, "element.trigger.timeout_ms", 1, 3600000),
  };
}

function normalizeBody(value, kind) {
  if (value === undefined) return null;
  if (!["function", "skill", "strategy"].includes(kind) || !Array.isArray(value)
    || value.length < 1 || value.length > 256 || value.some(line => typeof line !== "string" || /[\r\n\t\u0000]/u.test(line))
    || Buffer.byteLength(value.join("\n")) > 65536 || !value.some(line => line.trim())) {
    throw authoringError("ToubaServeElementAuthoringInvalid", "body must contain 1 to 256 Touba lines without control characters");
  }
  // Every line remains inside do. The canonical compiler checks references,
  // types and authority in the full project before a proposal can be applied.
  return value;
}

function normalizeApprovalPolicy(value, kind) {
  if (value === undefined) return null;
  if (kind !== "tool" || !isRecord(value)) throw authoringError("ToubaServeElementAuthoringInvalid", "approval_policy is valid only for tools");
  assertKnownKeys(value, ["role", "timeout_ms", "distinct_from"], "approval_policy");
  const role = nonEmptyString(value.role, "approval_policy.role");
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(role)) throw authoringError("ToubaServeElementAuthoringInvalid", "invalid approval role");
  const timeout = boundedInteger(value.timeout_ms, "approval_policy.timeout_ms", 1, 2592000000);
  if (value.distinct_from !== undefined && !["initiator", "previous", "initiator_and_previous"].includes(value.distinct_from)) throw authoringError("ToubaServeElementAuthoringInvalid", "invalid approval separation");
  return { role, timeout_ms: timeout, ...(value.distinct_from ? { distinct_from: value.distinct_from } : {}) };
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

function appendSourceBlock(content, block) {
  return `${content.trimEnd()}\n\n${block}\n`;
}

function stableJson(value) {
  // Preserve reviewed key order. Digests bind the exact proposed bytes.
  return `${JSON.stringify(value, null, 2)}\n`;
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
  if (!isAuthoringTypeReference(normalized)) {
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
  if (!isRecord(value)) throw authoringError('ToubaServeElementAuthoringInvalid', `${field} must be an object`);
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
