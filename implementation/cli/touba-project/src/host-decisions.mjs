import { isDeepStrictEqual } from "node:util";
import { effectContractToJson, normalizeEffectContract } from "../../touba-manifest/src/effect-contract.mjs";

const fields = new Set(["grants", "secrets", "memories", "effect_contract", "timeout_ms", "max_payload_bytes"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireObject = value => { if (!object(value)) fail("HostDecisionInvalid"); };
const knownKeys = (value, allowed) => {
  requireObject(value);
  if (Object.keys(value).some(key => !allowed.has(key))) fail("HostDecisionFieldUnknown");
};

function selection(value, required) {
  if (!Array.isArray(value) || value.some(item => !required.some(candidate => isDeepStrictEqual(candidate, item)))
      || value.some((item, index) => value.slice(0, index).some(previous => isDeepStrictEqual(previous, item)))) fail("HostDecisionSelectionInvalid");
  return structuredClone(value);
}

function normalizeField(field, value, required) {
  if (["grants", "secrets", "memories"].includes(field)) return selection(value, required[field] ?? []);
  if (field === "effect_contract") {
    try { return effectContractToJson(normalizeEffectContract(value)); }
    catch { fail("HostDecisionEffectInvalid"); }
  }
  if (!Number.isSafeInteger(value) || value <= 0) fail("HostDecisionLimitInvalid");
  return value;
}

// Pure, atomic proposal. No input is persisted, executed or treated as a secret value.
export function applyHostDecisions(manifest, decisions, requirements, fragmentToolRefs = new Set()) {
  if (decisions === undefined) return { manifest, changes: [] };
  knownKeys(decisions, new Set(["bindings", "agent_secret_scopes"]));
  const proposed = structuredClone(manifest);
  const changes = [];
  const change = (targetRef, field, holder, value, required, normalize, reportField = field) => {
    const before = holder[field];
    if (isDeepStrictEqual(before, value)) return;
    let safeBefore = null;
    if (before !== undefined && before !== null) {
      try { safeBefore = normalize(before); } catch { safeBefore = { invalid: true }; }
    }
    changes.push({ target_ref: targetRef, field: reportField, before: safeBefore, after: value,
      ...(required === undefined ? {} : { source_required: structuredClone(required) }) });
    holder[field] = value;
  };
  if (decisions.bindings !== undefined) {
    requireObject(decisions.bindings);
    for (const [ref, patch] of Object.entries(decisions.bindings)) {
      if (!Object.hasOwn(requirements.bindings, ref)) fail("HostDecisionTargetUnknown");
      if (fragmentToolRefs.has(ref)) fail("HostDecisionFragmentConflict");
      knownKeys(patch, fields);
      for (const [field, value] of Object.entries(patch)) {
        const required = requirements.bindings[ref];
        const normalize = candidate => normalizeField(field, candidate, required);
        change(ref, field, proposed.bindings[ref], normalize(value),
          ["grants", "secrets", "memories"].includes(field) ? required[field] ?? [] : undefined, normalize);
      }
    }
  }
  if (decisions.agent_secret_scopes !== undefined) {
    requireObject(decisions.agent_secret_scopes);
    for (const [ref, value] of Object.entries(decisions.agent_secret_scopes)) {
      if (!Object.hasOwn(requirements.agent_secret_scopes ?? {}, ref)) fail("HostDecisionTargetUnknown");
      const required = requirements.agent_secret_scopes[ref];
      proposed.agent_secret_scopes ??= {};
      const normalize = candidate => selection(candidate, required);
      change(ref, ref, proposed.agent_secret_scopes, normalize(value), required, normalize, "agent_secret_scopes");
    }
  }
  return { manifest: proposed, changes };
}
