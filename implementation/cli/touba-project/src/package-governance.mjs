import { isDeepStrictEqual } from "node:util";
import { normalizeToolApprovalPolicy, combineToolApprovalPolicies } from "../../../contracts/tool-approval-policy.mjs";
import { PACKAGE_NAME } from "./package-contract.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const toolRef = /^tool:[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/;
const digest = /^sha256:[a-f0-9]{64}$/;

function boundedMap(value) {
  if (!object(value) || Object.keys(value).length > 4096 || Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) fail("PackageGovernanceInvalid");
  return value;
}
export function normalizeConsumerPolicies(value = {}) {
  const out = {};
  for (const [ref, policy] of Object.entries(boundedMap(value))) {
    if (!toolRef.test(ref)) fail("PackageGovernanceInvalid");
    out[ref] = policy === null ? null : normalizeToolApprovalPolicy(policy);
  }
  return out;
}
export function normalizePackageContracts(value = {}) {
  for (const [name, contract] of Object.entries(boundedMap(value))) {
    if (!PACKAGE_NAME.test(name) || !object(contract) || Object.keys(contract).some(k => !["version", "digest", "tools"].includes(k))
        || typeof contract.version !== "string" || contract.version.length > 100 || !digest.test(contract.digest)) fail("PackageGovernanceInvalid");
    for (const [ref, definition] of Object.entries(boundedMap(contract.tools))) {
      if (!toolRef.test(ref) || !object(definition) || Object.keys(definition).some(k => !["approval_policy", "required_capabilities", "required_secrets", "memory_accesses", "signature"].includes(k))) fail("PackageGovernanceInvalid");
      if (Object.hasOwn(definition, "approval_policy")) normalizeToolApprovalPolicy(definition.approval_policy);
      for (const key of ["required_capabilities", "required_secrets"]) if (!Array.isArray(definition[key]) || definition[key].some(v => typeof v !== "string" || v.length > 256)) fail("PackageGovernanceInvalid");
      if (!Array.isArray(definition.memory_accesses) || !object(definition.signature)) fail("PackageGovernanceInvalid");
    }
  }
  return structuredClone(value);
}
function withoutSource(value) {
  if (Array.isArray(value)) return value.map(withoutSource);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "source_ref").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, withoutSource(v)]));
}
export function toolContract(tool) {
  return { ...(Object.hasOwn(tool, "approval_policy") ? { approval_policy: normalizeToolApprovalPolicy(tool.approval_policy) } : {}),
    required_capabilities: [...(tool.required_capabilities ?? [])].sort(), required_secrets: [...(tool.required_secrets ?? [])].sort(),
    memory_accesses: withoutSource(tool.memory_accesses ?? []).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    signature: withoutSource(tool.signature ?? {}) };
}

// Pure proposal. Baselines and consumer requirements live in author-owned
// project configuration, never in a dependency or a disposable build directory.
export function proposePackageGovernance({ configuration = {}, packages = [], entries = [], previous = [], decisions = {}, mode }) {
  const contracts = normalizePackageContracts(configuration.package_contracts);
  const policies = normalizeConsumerPolicies(configuration.tool_policies);
  const changes = [], diagnostics = [];
  const reviews = boundedMap(decisions.review_packages ?? {});
  const overrides = normalizeConsumerPolicies(decisions.tool_policies);
  const known = new Set(packages.map(pkg => pkg.name));
  for (const [name, selected] of Object.entries(reviews)) if (!known.has(name) || !digest.test(selected)) fail("PackageGovernanceInvalid");
  const oldTools = previous.flatMap(document => document.definitions?.tools ?? []);
  for (const pkg of packages) {
    const tools = Object.fromEntries(entries.filter(entry => entry.packageName === pkg.name)
      .flatMap(entry => (entry.document.definitions?.tools ?? []).filter(tool => !entry.document.module?.name || tool.id.startsWith(`tool:${entry.document.module.name}/`)))
      .map(tool => [tool.id, toolContract(tool)]).sort(([a], [b]) => a.localeCompare(b)));
    const next = { version: pkg.version, digest: pkg.digest, tools };
    const before = contracts[pkg.name];
    if (reviews[pkg.name] !== undefined && reviews[pkg.name] !== pkg.digest) fail("PackageGovernanceStale");
    const previousTools = before?.tools ?? Object.fromEntries(oldTools.filter(tool => Object.hasOwn(tools, tool.id)).map(tool => [tool.id, toolContract(tool)]));
    const changed = before ? !isDeepStrictEqual(before.tools, tools)
      : Object.entries(previousTools).some(([ref, contract]) => !isDeepStrictEqual(contract, tools[ref]));
    if (!before || changed) changes.push({ kind: before ? "review_package_contract" : "adopt_package_contract", package: pkg.name,
      digest: pkg.digest, before: before ?? (Object.keys(previousTools).length ? { tools: previousTools } : null), after: next,
      reviewed: reviews[pkg.name] === pkg.digest });
    if (changed && reviews[pkg.name] !== pkg.digest) diagnostics.push({ severity: "error", code: "PackageGovernanceReviewRequired",
      message: `review the changed contract of ${pkg.name} and select its exact digest in host decisions`, package: pkg.name });
    // Preserve the accepted minimum, including migration from an existing AIR.
    for (const [ref, contract] of Object.entries({ ...tools, ...previousTools })) {
      if (!Object.hasOwn(policies, ref) && Object.hasOwn(contract, "approval_policy")) policies[ref] = structuredClone(contract.approval_policy);
    }
    contracts[pkg.name] = next;
  }
  for (const [ref, policy] of Object.entries(overrides)) {
    const exists = entries.some(entry => entry.document.definitions?.tools?.some(tool => tool.id === ref)) || Object.hasOwn(policies, ref);
    if (!exists) fail("PackageGovernanceInvalid");
    if (!isDeepStrictEqual(policies[ref], policy)) changes.push({ kind: "configure_consumer_approval", tool_ref: ref, before: policies[ref] ?? null, after: policy });
    policies[ref] = policy;
  }
  const nextConfiguration = { ...configuration,
    ...(Object.keys(contracts).length ? { package_contracts: contracts } : {}),
    ...(Object.keys(policies).length ? { tool_policies: policies } : {}) };
  // Enforce output bounds on first adoption as well as on later reads.
  boundedMap(contracts); boundedMap(policies);
  const changed = !isDeepStrictEqual(configuration, nextConfiguration);
  if (mode === "check" && changed) diagnostics.push({ severity: "error", code: "PackageGovernanceStale", message: "review and write the project governance configuration before running" });
  return { configuration: nextConfiguration, policies, changes, diagnostics, changed };
}

export function applyConsumerPolicies(manifest, requirements, policies, documents = []) {
  for (const [ref, binding] of Object.entries(manifest.bindings)) {
    const policy = combineToolApprovalPolicies(requirements.bindings[ref]?.approval_policy, policies[ref] ?? undefined);
    if (policy === undefined) delete binding.approval_policy;
    else binding.approval_policy = policy;
  }
  for (const document of documents) for (const tool of document.definitions?.tools ?? []) {
    combineToolApprovalPolicies(tool.approval_policy, manifest.bindings[tool.id]?.approval_policy);
  }
}
