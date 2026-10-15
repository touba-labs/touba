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
