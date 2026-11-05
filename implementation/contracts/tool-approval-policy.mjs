// Shared source/host constraint vocabulary. A host may strengthen, never erase,
// a tool's operation approval. No authority is granted by this composition.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const label = value => typeof value === "string" && value.trim() === value && value.length > 0
  && Buffer.byteLength(value, "utf8") <= 128 && !/[\x00-\x1f\x7f]/.test(value);
export function normalizeToolApprovalPolicy(value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some(k => !["role", "timeout_ms", "distinct_from", "exclude_signers"].includes(k))
      || value.role !== undefined && !label(value.role)
      || value.exclude_signers !== undefined && !label(value.exclude_signers)
      || value.timeout_ms !== undefined && (!Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 1 || value.timeout_ms > 2592000000)
      || value.distinct_from !== undefined && !["initiator", "previous", "initiator_and_previous"].includes(value.distinct_from)) fail("ToolApprovalPolicyInvalid");
  return structuredClone(value);
}
export function combineToolApprovalPolicies(source, consumer) {
  source = normalizeToolApprovalPolicy(source); consumer = normalizeToolApprovalPolicy(consumer);
  if (source === undefined) return consumer;
  if (consumer === undefined) return source;
  const result = {};
  for (const key of ["role", "exclude_signers"]) {
    if (source[key] && consumer[key] && source[key] !== consumer[key]) fail("ToolApprovalPolicyConflict");
    if (source[key] || consumer[key]) result[key] = source[key] ?? consumer[key];
  }
  const timeouts = [source.timeout_ms, consumer.timeout_ms].filter(v => v !== undefined);
  if (timeouts.length) result.timeout_ms = Math.min(...timeouts);
  const distinct = [source.distinct_from, consumer.distinct_from].filter(Boolean).join("_");
  if (distinct) result.distinct_from = distinct.includes("initiator") && distinct.includes("previous")
    ? "initiator_and_previous" : distinct.includes("initiator") ? "initiator" : "previous";
  return result;
}
