import { join } from "node:path";
export function toolNameToHandlerFile(toolName, extension = "mjs") {
  const normalizedExtension = String(extension).replace(/^\./, "");
  const snake = String(toolName)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  if (snake === "") {
    throw new Error("tool name cannot be converted to a handler file name");
  }

  return `${snake}.handler.${normalizedExtension}`;
}
const toPosixPath = (value) => value.replaceAll("\\", "/");

export function assertDistinctHandlerPaths(files) {
  const toolByPath = new Map();
  for (const { path, toolRef } of files) {
    const previousTool = toolByPath.get(path);
    if (previousTool !== undefined) {
      throw Object.assign(new Error(`handler stub collision: ${previousTool} and ${toolRef} map to ${path}`), {
        code: "HandlerStubPathCollision",
      });
    }
    toolByPath.set(path, toolRef);
  }
}

export function buildManifestRequirements(airDocuments, options = {}) {
  const bindings = {};
  for (const document of airDocuments) for (const tool of document.definitions.tools ?? []) bindings[tool.id] = bindingRequirementsForTool(tool, options);
  const scopes = inferAgentSecretScopes(airDocuments);
  return { manifest_version: "touba-manifest-v1", bindings: Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b))), ...(Object.keys(scopes).length ? { agent_secret_scopes: scopes } : {}) };
}

export function unapprovedManifest(requirements) {
  const draft = structuredClone(requirements);
  for (const binding of Object.values(draft.bindings)) {
    binding.grants = [];
    if (binding.secrets) binding.secrets = [];
    if (binding.memories) binding.memories = [];
  }
  if (draft.agent_secret_scopes) draft.agent_secret_scopes = {};
  return draft;
}

function inferAgentSecretScopes(airDocuments) {
  const toolSecrets = new Map();
  const usesByRef = new Map();
  const agents = [];

  for (const document of airDocuments) {
    for (const tool of document.definitions.tools ?? []) {
      const secrets = normalizeStringArray(tool.required_secrets);
      toolSecrets.set(tool.id, secrets);
    }
    for (const collection of ["functions", "tools", "skills", "strategies", "agents"]) {
      for (const definition of document.definitions?.[collection] ?? []) {
        if (typeof definition.id === "string") {
          usesByRef.set(definition.id, normalizeUseRefs(definition));
        }
      }
    }
    for (const agent of document.definitions?.agents ?? []) {
      if (typeof agent.id === "string") {
        agents.push(agent);
      }
    }
  }

  const scopes = {};
  for (const agent of agents) {
    const secrets = collectReachableToolSecrets(agent.id, usesByRef, toolSecrets);
    if (secrets.length > 0) {
      scopes[agent.id] = secrets;
    }
  }
  return Object.fromEntries(Object.entries(scopes).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeUseRefs(definition) {
  const refs = [];
  for (const ref of normalizeStringArray(definition.uses)) {
    refs.push(ref);
  }
  if (Array.isArray(definition.use_refs)) {
    for (const record of definition.use_refs) {
      if (record && typeof record === "object" && typeof record.target_ref === "string") {
        refs.push(record.target_ref);
      }
    }
  }
  return [...new Set(refs)].sort();
}

function collectReachableToolSecrets(rootRef, usesByRef, toolSecrets) {
  const pending = [...(usesByRef.get(rootRef) ?? [])];
  const visited = new Set([rootRef]);
  const secrets = new Set();

  while (pending.length > 0) {
    const ref = pending.shift();
    if (typeof ref !== "string" || visited.has(ref)) {
      continue;
    }
    visited.add(ref);

    // Delegation activates the callee agent's own scope, not the caller's.
    if (ref.startsWith("agent:")) continue;

    for (const secret of toolSecrets.get(ref) ?? []) {
      secrets.add(secret);
    }
    for (const nextRef of usesByRef.get(ref) ?? []) {
      if (!visited.has(nextRef)) {
        pending.push(nextRef);
      }
    }
  }

  return [...secrets].sort();
}

export function bindingRequirementsForTool(tool, options) {
  const handlerPath = handlerRelativePathForTool(tool, options);
  const binding = {
    handler: {
      kind: "process",
      command: options.handlerCommand,
      args: [handlerPath],
      cwd: options.handlerCwd ?? ".",
    },
    effect_contract: null,
    grants: normalizeStringArray(tool.required_capabilities),
    timeout_ms: options.timeoutMs,
    max_payload_bytes: options.maxPayloadBytes,
  };
  const secrets = normalizeStringArray(tool.required_secrets);
  if (secrets.length > 0) {
    binding.secrets = secrets;
  }
  const memories = normalizeMemoryAccesses(tool.memory_accesses);
  if (memories.length > 0) {
    binding.memories = memories;
  }
  return binding;
}

export function handlerRelativePathForTool(tool, options) {
  const { moduleName, toolName } = parseToolRef(tool.id);
  const handlerRoot = options.handlerRoot ?? "handlers";
  const extension = options.handlerExtension ?? "mjs";
  return toPosixPath(join(
    handlerRoot,
    ...moduleName.split("."),
    toolNameToHandlerFile(tool.name ?? toolName, extension),
  ));
}

function parseToolRef(toolRef) {
  const match = /^tool:([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(toolRef);
  if (!match) {
    throw new Error(`invalid tool ref: ${toolRef}`);
  }
  return { moduleName: match[1], toolName: match[2] };
}

function normalizeStringArray(values) {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error("AIR tool list field must be an array when present");
  }
  return values.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error("AIR tool list entries must be non-empty strings");
    }
    return value;
  });
}

function normalizeMemoryAccesses(values) {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error("AIR tool memory_accesses must be an array when present");
  }
  return values.map((memory) => ({
    ref: memory.memory_ref,
    access: memory.access,
  }));
}
