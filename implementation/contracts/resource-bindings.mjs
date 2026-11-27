// Host requirements are explicit. Logical memory does not imply a backend;
// provider identifiers belong to host adapters, not to a language allowlist.
export function requiredResourceReferences(document) {
  const refs = document?.required_resources ?? [];
  if (!Array.isArray(refs) || refs.some(ref => typeof ref !== "string" || !/^(memory|trigger|agent):[^\s]+$/u.test(ref))
      || new Set(refs).size !== refs.length) {
    const error = new Error("required_resources must contain unique memory, trigger or agent references");
    error.code = "ResourceBindingsSchemaMismatch";
    throw error;
  }
  return refs;
}

const RESOURCE_BINDING_PAYLOAD_FORBIDDEN_FIELDS = new Set([
  "api_key",
  "connection_string",
  "database_url",
  "dsn",
  "payload",
  "payload_raw",
  "raw_payload",
  "secret_value",
  "secret_values",
  "token",
  "value",
]);

export function findForbiddenResourceBindingPayloadField(value, path = []) {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (RESOURCE_BINDING_PAYLOAD_FORBIDDEN_FIELDS.has(key)) return [...path, key].join(".");
    const nested = findForbiddenResourceBindingPayloadField(child, [...path, key]);
    if (nested !== null) return nested;
  }
  return null;
}

export function buildResourceInventory(airDocuments) {
  const knownResourceRefs = new Set();
  const requiredResourceRefs = new Set();
  const requiredGrantsByResource = new Map();
  const ownersByRef = new Map();
  const toolsByRef = new Map();
  const graphOwners = [];

  for (const document of airDocuments) {
    for (const memory of document.definitions?.memories ?? []) {
      knownResourceRefs.add(memory.id);
    }
    for (const trigger of document.definitions?.triggers ?? []) {
      knownResourceRefs.add(trigger.id);
      requiredResourceRefs.add(trigger.id);
    }
    for (const agent of document.definitions?.agents ?? []) {
      knownResourceRefs.add(agent.id);
    }
    for (const collection of ["skills", "agents", "strategies", "functions"]) {
      for (const owner of document.definitions?.[collection] ?? []) {
        ownersByRef.set(owner.id, owner);
      }
    }
    for (const tool of document.definitions?.tools ?? []) {
      toolsByRef.set(tool.id, tool);
      for (const access of tool.memory_accesses ?? []) {
        requiredResourceRefs.add(access.memory_ref);
        const grants = requiredGrantsByResource.get(access.memory_ref) ?? new Set();
        grants.add(access.access === "write" ? "memory.write" : "memory.read");
        requiredGrantsByResource.set(access.memory_ref, grants);
      }
    }
    for (const graph of document.execution_graphs ?? []) {
      graphOwners.push(graph);
    }
  }

  return { knownResourceRefs, requiredResourceRefs, requiredGrantsByResource, ownersByRef, toolsByRef, graphOwners };
}

export function* missingResourceMemoryScopes(inventory) {
  for (const graph of inventory.graphOwners) {
    const scopes = inventory.ownersByRef.get(graph.owner_ref)?.memory_scopes ?? [];
    for (const node of graph.nodes ?? []) {
      if (node.kind !== "call_tool") continue;
      const tool = inventory.toolsByRef.get(node.target_ref);
      for (const access of tool?.memory_accesses ?? []) {
        if (!scopes.some(scope => scope.memory_ref === access.memory_ref && scope.access === access.access)) {
          yield { ownerRef: graph.owner_ref, memoryRef: access.memory_ref, access: access.access };
        }
      }
    }
  }
}
