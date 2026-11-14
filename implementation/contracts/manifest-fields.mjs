// Shared closed configuration vocabulary. Semantic validators remain authoritative.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safe = value => /^[A-Za-z0-9_.$:/-]{1,160}$/.test(value) ? value : "[invalid key]";
export function assertKnownFields(value, keys, path) {
  if (!object(value)) return; // Shape errors belong to the calling validator.
  const unknown = Object.keys(value).find(key => !keys.includes(key));
  if (unknown !== undefined) {
    const field = `${path}.${safe(unknown)}`.slice(0, 512);
    throw Object.assign(new Error(`unknown configuration field: ${field}`), { code: "ManifestFieldUnknown", details: { field } });
  }
}
export function assertBindingFields(binding, path = "binding") {
  assertKnownFields(binding, ["handler", "configuration", "grants", "secrets", "memories", "effect_contract", "timeout_ms", "max_payload_bytes", "payload_constraints", "sandbox", "approval_policy"], path);
  if (!object(binding)) return;
  assertKnownFields(binding.handler, ["kind", "command", "args", "cwd"], `${path}.handler`);
  for (const [index, memory] of (Array.isArray(binding.memories) ? binding.memories : []).entries()) assertKnownFields(memory, ["ref", "access"], `${path}.memories.${index}`);
  assertKnownFields(binding.sandbox, ["required", "profile", "code_paths", "read_paths", "write_paths", "local_sockets"], `${path}.sandbox`);
  assertKnownFields(binding.effect_contract, ["kind", "retry_mode", "compensation"], `${path}.effect_contract`);
  assertKnownFields(binding.effect_contract?.compensation, ["entry_ref"], `${path}.effect_contract.compensation`);
  assertKnownFields(binding.payload_constraints, ["input", "output"], `${path}.payload_constraints`);
  for (const direction of ["input", "output"]) {
    for (const [key, rule] of Object.entries(binding.payload_constraints?.[direction] ?? {})) {
      assertKnownFields(rule, ["non_empty", "max_length", "min", "max", "allowed_values", "min_items", "max_items"], `${path}.payload_constraints.${direction}.${safe(key)}`);
    }
  }
}
export function assertTriggerFields(trigger, path = "trigger") {
  assertKnownFields(trigger, ["enabled", "source", "limits", "payload"], path);
  if (!object(trigger)) return;
  assertKnownFields(trigger.source, ["kind", "timezone"], `${path}.source`);
  assertKnownFields(trigger.limits, ["max_runs_per_day", "timeout_ms"], `${path}.limits`);
  assertKnownFields(trigger.payload, ["format", "max_bytes", "content_types", "map"], `${path}.payload`);
}
export function assertManifestFields(manifest) {
  assertKnownFields(manifest, ["manifest_version", "bindings", "triggers", "agent_secret_scopes", "run_limits"], "manifest");
  assertKnownFields(manifest?.run_limits, ["max_run_ms", "max_steps", "max_tool_calls", "max_agent_invocations", "max_provider_calls"], "manifest.run_limits");
  for (const [ref, binding] of Object.entries(manifest?.bindings ?? {})) assertBindingFields(binding, `bindings.${safe(ref)}`);
  for (const [ref, trigger] of Object.entries(manifest?.triggers ?? {})) assertTriggerFields(trigger, `triggers.${safe(ref)}`);
}
