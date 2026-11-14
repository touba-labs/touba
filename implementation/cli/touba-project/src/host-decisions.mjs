import { isDeepStrictEqual } from "node:util";
import { openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { effectContractToJson, normalizeEffectContract } from "../../touba-manifest/src/effect-contract.mjs";
import { normalizeHandlerConfiguration } from '../../../runtime/touba-handler-sdk/src/handler-configuration.mjs';

const fields = new Set(["grants", "secrets", "memories", "effect_contract", "timeout_ms", "max_payload_bytes", "package_handler", "handler", "sandbox", "configuration"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const diagnosticKey = value => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : "[invalid key]";
const requireObject = value => { if (!object(value)) fail("HostDecisionInvalid"); };
const knownKeys = (value, allowed, path = "host_decisions") => {
  requireObject(value);
  const key = Object.keys(value).find(key => !allowed.has(key));
  if (key !== undefined) fail("HostDecisionFieldUnknown", { field: diagnosticKey(key), path });
};

export function readHostDecisionsFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) fail("HostDecisionFileInvalid");
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 65536) fail("HostDecisionFileInvalid");
    const document = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    requireObject(document);
    return document;
  } catch { fail("HostDecisionFileInvalid"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function expandModuleDecisions(decisions, requirements) {
  if (decisions.modules === undefined) return decisions;
  requireObject(decisions.modules);
  if (decisions.bindings !== undefined) requireObject(decisions.bindings);
  const bindings = Object.create(null);
  for (const [module, defaults] of Object.entries(decisions.modules)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(module)) fail("HostDecisionModuleInvalid");
    knownKeys(defaults, new Set(["grants", "secrets", "timeout_ms", "max_payload_bytes"]), `modules.${module}`);
    const entries = Object.entries(requirements.bindings).filter(([ref]) => ref.startsWith(`tool:${module}/`));
    if (entries.length === 0) fail("HostDecisionTargetUnknown", { target_ref: module, path: "modules" });
    for (const [field, value] of Object.entries(defaults)) {
      const union = [...new Set(entries.flatMap(([, required]) => required[field] ?? []))];
      normalizeField(field, value, { [field]: union });
    }
    for (const [ref, required] of entries) {
      bindings[ref] = Object.fromEntries(Object.entries(defaults).map(([field, value]) => [field,
        ["grants", "secrets"].includes(field) ? value.filter(item => (required[field] ?? []).includes(item)) : value]));
    }
  }
  for (const [ref, patch] of Object.entries(decisions.bindings ?? {})) {
    requireObject(patch);
    bindings[ref] = { ...(bindings[ref] ?? {}), ...patch };
  }
  return { ...decisions, bindings };
}

function selection(value, required) {
  if (!Array.isArray(value) || value.some(item => !required.some(candidate => isDeepStrictEqual(candidate, item)))
      || value.some((item, index) => value.slice(0, index).some(previous => isDeepStrictEqual(previous, item)))) fail("HostDecisionSelectionInvalid");
  return structuredClone(value);
}

function normalizeField(field, value, required) {
  if (field === "handler") {
    knownKeys(value, new Set(["kind", "command", "args", "cwd"]), "handler");
    const text = item => typeof item === "string" && !item.includes("\0");
    if (value.kind !== "process" || !text(value.command) || !value.command.trim()
        || !Array.isArray(value.args) || value.args.some(arg => !text(arg))
        || value.cwd !== undefined && (!text(value.cwd) || !value.cwd.trim())) fail("HostDecisionHandlerInvalid");
    return structuredClone(value);
  }
  if (field === "sandbox") {
    knownKeys(value, new Set(["required", "profile", "code_paths", "read_paths", "write_paths", "local_sockets"]), "sandbox");
    if (value.required !== undefined && typeof value.required !== "boolean"
        || value.profile !== undefined && value.profile !== "default") fail("HostDecisionSandboxInvalid");
    for (const key of ["code_paths", "read_paths", "write_paths", "local_sockets"]) {
      if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 4096
        || value[key].some(path => typeof path !== "string" || !path || path.length > 4096 || path.includes("\0")))) fail("HostDecisionSandboxInvalid");
    }
    return structuredClone(value);
  }
  if (["grants", "secrets", "memories"].includes(field)) return selection(value, required[field] ?? []);
  if (field === "effect_contract") {
    try { return effectContractToJson(normalizeEffectContract(value)); }
    catch { fail("HostDecisionEffectInvalid"); }
  }
  if (!Number.isSafeInteger(value) || value <= 0) fail("HostDecisionLimitInvalid");
  return value;
}

// Pure, atomic proposal. No input is persisted, executed or treated as a secret value.
export function applyHostDecisions(manifest, decisions, requirements, fragmentToolRefs = new Set(), packageHandlers = new Map()) {
  if (decisions === undefined) return { manifest, changes: [] };
  knownKeys(decisions, new Set(["bindings", "modules", "agent_secret_scopes", "remove_bindings", "remove_triggers", "triggers", "tool_policies", "review_packages", "review_fragments", "restore_fragments"]));
  decisions = expandModuleDecisions(decisions, requirements);
  const proposed = structuredClone(manifest);
  const changes = [];
  if (decisions.remove_triggers !== undefined) {
    const refs = decisions.remove_triggers;
    if (!Array.isArray(refs) || new Set(refs).size !== refs.length || refs.some(ref => typeof ref !== 'string'
      || !/^trigger:[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(ref))) fail('HostDecisionRemovalInvalid');
    for (const ref of refs) {
      if (Object.hasOwn(requirements.triggers ?? {}, ref) || Object.hasOwn(decisions.triggers ?? {}, ref)) fail('HostDecisionRemovalConflict', { target_ref: ref });
      if (Object.hasOwn(proposed.triggers ?? {}, ref)) {
        delete proposed.triggers[ref];
        changes.push({ target_ref: ref, field: 'remove_trigger', before: true, after: false });
      }
    }
  }
  if (decisions.remove_bindings !== undefined) {
    const refs = decisions.remove_bindings;
    if (!Array.isArray(refs) || new Set(refs).size !== refs.length || refs.some(ref => typeof ref !== "string" || !/^tool:[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(ref))) fail("HostDecisionRemovalInvalid");
    for (const ref of refs) {
      if (Object.hasOwn(requirements.bindings, ref) || fragmentToolRefs.has(ref) || Object.hasOwn(decisions.bindings ?? {}, ref)) {
        fail("HostDecisionRemovalConflict", { target_ref: ref });
      }
      if (Object.hasOwn(proposed.bindings, ref)) {
        delete proposed.bindings[ref];
        changes.push({ target_ref: ref, field: "remove_binding", before: true, after: false });
      }
    }
  }
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
      if (!Object.hasOwn(requirements.bindings, ref)) fail("HostDecisionTargetUnknown", { target_ref: diagnosticKey(ref), path: "bindings" });
      if (fragmentToolRefs.has(ref)) fail("HostDecisionFragmentConflict", { target_ref: diagnosticKey(ref), path: "bindings" });
      knownKeys(patch, fields, `bindings.${diagnosticKey(ref)}`);
      if (Object.hasOwn(patch, "handler") && Object.hasOwn(patch, "package_handler")) {
        fail("HostDecisionHandlerConflict", { target_ref: ref });
      }
      const target = proposed.bindings[ref];
      if (Object.hasOwn(patch, 'handler') && target.configuration !== undefined
          && !isDeepStrictEqual(patch.handler, target.handler) && !Object.hasOwn(patch, 'configuration')) {
        fail('HandlerConfigurationReviewRequired', { target_ref: ref });
      }
      let schema = target.configuration?.schema;
      if (Object.hasOwn(patch, "package_handler")) {
        if (typeof patch.package_handler !== "string" || !packageHandlers.get(ref)?.has(patch.package_handler)) fail("HostDecisionPackageHandlerUnknown", { target_ref: ref });
        const { configuration_schema, ...handler } = packageHandlers.get(ref).get(patch.package_handler);
        if (handler.unsupported) fail("HostDecisionPackageHandlerUnsupported", { target_ref: ref });
        schema = configuration_schema;
        change(ref, "handler", target, structuredClone(handler), undefined, candidate => candidate);
      }
      if (Object.hasOwn(patch, "configuration") || Object.hasOwn(patch, "package_handler")) {
        if (schema === undefined) {
          if (Object.hasOwn(patch, "configuration")) fail("HandlerConfigurationSchemaRequired", { target_ref: ref });
          if (target.configuration !== undefined) {
            change(ref, "configuration", target, null, undefined, candidate => candidate);
            delete target.configuration;
          }
        } else {
          const configuration = normalizeHandlerConfiguration({ schema,
            values: Object.hasOwn(patch, "configuration") ? patch.configuration : target.configuration?.values ?? {} });
          change(ref, "configuration", target, configuration, undefined, normalizeHandlerConfiguration);
        }
      }
      for (const [field, value] of Object.entries(patch)) {
        if (field === "package_handler" || field === "configuration") continue;
        const required = requirements.bindings[ref];
        const normalize = candidate => {
          try { return normalizeField(field, candidate, required); }
          catch (error) { error.details = { ...error.details, target_ref: ref, field }; throw error; }
        };
        const selected = field === "sandbox"
          ? normalize({ ...(proposed.bindings[ref].sandbox ?? {}), ...normalize(value) })
          : normalize(value);
        change(ref, field, proposed.bindings[ref], selected,
          ["grants", "secrets", "memories"].includes(field) ? required[field] ?? [] : undefined, normalize);
      }
    }
  }
  if (decisions.triggers !== undefined) {
    requireObject(decisions.triggers);
    for (const [ref, patch] of Object.entries(decisions.triggers)) {
      if (!Object.hasOwn(requirements.triggers ?? {}, ref)) fail("HostDecisionTargetUnknown", { target_ref: diagnosticKey(ref), path: "triggers" });
      knownKeys(patch, new Set(["enabled", "limits"]), `triggers.${diagnosticKey(ref)}`);
      const target = proposed.triggers[ref];
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== "boolean") fail("HostDecisionTriggerInvalid", { target_ref: ref });
        change(ref, "enabled", target, patch.enabled, undefined, value => typeof value === "boolean" ? value : null);
      }
      if (patch.limits !== undefined) {
        knownKeys(patch.limits, new Set(["max_runs_per_day", "timeout_ms"]), `triggers.${diagnosticKey(ref)}.limits`);
        const normalize = (value, enforceSource = true) => {
          knownKeys(value, new Set(["max_runs_per_day", "timeout_ms"]), `triggers.${diagnosticKey(ref)}.limits`);
          for (const [key, limit] of Object.entries(value)) {
            if (!Number.isSafeInteger(limit) || limit <= 0 || (enforceSource && limit > requirements.triggers[ref].limits[key])) fail("HostDecisionLimitInvalid", { target_ref: ref, field: key });
          }
          return structuredClone(value);
        };
        change(ref, "limits", target, normalize({ ...target.limits, ...patch.limits }), requirements.triggers[ref].limits, value => normalize(value, false));
      }
    }
  }
  if (decisions.agent_secret_scopes !== undefined) {
    requireObject(decisions.agent_secret_scopes);
    for (const [ref, value] of Object.entries(decisions.agent_secret_scopes)) {
      if (!Object.hasOwn(requirements.agent_secret_scopes ?? {}, ref)) fail("HostDecisionTargetUnknown", { target_ref: diagnosticKey(ref), path: "agent_secret_scopes" });
      const required = requirements.agent_secret_scopes[ref];
      proposed.agent_secret_scopes ??= {};
      const normalize = candidate => selection(candidate, required);
      change(ref, ref, proposed.agent_secret_scopes, normalize(value), required, normalize, "agent_secret_scopes");
    }
  }
  return { manifest: proposed, changes };
}
