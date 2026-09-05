// @ts-check

import { spawnSync } from "node:child_process";
import { ToubaRuntimeError } from "./runtime-errors.mjs";

export const HARDENED_EXECUTION_PROFILE_VERSION = "touba-hardened-execution-profile-v1";
const REQUIRED_BUDGETS = ["max_run_ms", "max_steps", "max_tool_calls", "max_agent_invocations"];
const PROFILE_FIELDS = new Set(["schema_version", "controls"]);
const CONTROL_FIELDS = new Set([
  "sandbox", "provider_content_mode", "require_supply_chain_lock", "require_budgets",
  "require_redaction", "require_durable_checkpoints", "secrets_policy",
]);

/**
 * Enforce explicit host/profile evidence before execution. Returns the runtime
 * options that the profile owns; callers must merge them over development
 * defaults.
 * @param {Record<string, any>} document
 * @param {Record<string, any>} options
 * @returns {Record<string, any>}
 */
export function enforceHardenedExecutionProfile(document, options) {
  const profile = options.hardenedExecutionProfile ?? options.hardened_execution_profile;
  if (profile === undefined || profile === null) return {};
  validateProfile(profile);
  const controls = profile.controls;

  if (controls.require_supply_chain_lock && options.supplyChainValidated !== true) {
    fail("HardenedSupplyChainEvidenceRequired", "a validated supply-chain lock is required");
  }
  if (controls.require_redaction && options.redactionEnabled !== true) {
    fail("HardenedRedactionEvidenceRequired", "runtime redaction evidence is required");
  }
  if (controls.require_durable_checkpoints && options.durableHumanApprovals !== true) {
    fail("HardenedDurableCheckpointRequired", "durable human checkpoints are required");
  }
  if (controls.secrets_policy !== "handles_only") {
    fail("HardenedSecretsPolicyInvalid", "secrets_policy must be handles_only");
  }
  if (controls.provider_content_mode !== "opaque_refs") {
    fail("HardenedProviderModeInvalid", "provider_content_mode must be opaque_refs");
  }
  for (const budget of controls.require_budgets) {
    const entry = document.budgets?.run?.[budget];
    if (!entry || !Number.isSafeInteger(entry.value) || entry.value <= 0) {
      fail("HardenedBudgetRequired", `AIR budget ${budget} is required`, { budget });
    }
  }

  const tools = document.definitions?.tools ?? [];
  if (tools.length > 0 && controls.sandbox.required === true) {
    const bindings = normalizedBindings(options.toolBindingManifest);
    for (const tool of tools) {
      const binding = bindings.get(tool.id);
      if (!binding || binding.sandbox?.required !== true) {
        fail("HardenedSandboxBindingRequired", `sandbox is required for ${tool.id}`, { toolRef: tool.id });
      }
    }
    const probe = typeof options.hardenedSandboxProbe === "function"
      ? options.hardenedSandboxProbe({ platform: options.platform ?? process.platform, controls })
      : probeHostSandbox({ platform: options.platform ?? process.platform, env: options.env ?? process.env });
    if (!probe.available) fail("HardenedSandboxUnavailable", "required host sandbox is unavailable", probe);
    const minimum = controls.sandbox.minimum_versions?.[probe.mechanism];
    if (minimum && compareVersions(probe.version, minimum) < 0) {
      fail("HardenedSandboxVersionUnsupported", `sandbox ${probe.mechanism} ${probe.version} is older than ${minimum}`, probe);
    }
  }
  return { agentDecisionProviderContentMode: "opaque_refs", hardenedExecutionProfileActive: true };
}

/** @param {{platform?: string, env?: Record<string, string | undefined>}} [input] */
export function probeHostSandbox({ platform = process.platform, env = process.env } = {}) {
  const candidates = platform === "linux"
    ? [{ mechanism: "bubblewrap", command: env.TOUBA_BWRAP_COMMAND || "bwrap", args: ["--version"] }]
    : platform === "darwin"
      ? [{ mechanism: "sandbox-exec", command: env.TOUBA_SANDBOX_EXEC_COMMAND || "/usr/bin/sandbox-exec", args: ["-h"] }]
      : platform === "win32"
        ? [{ mechanism: "sandboxie-plus", command: env.TOUBA_SANDBOXIE_START_COMMAND || "Start.exe", args: ["/version"] }]
        : [];
  if (candidates.length === 0) return { available: false, platform, mechanism: "unsupported", version: "0" };
  const candidate = candidates[0];
  const result = spawnSync(candidate.command, candidate.args, { encoding: "utf8", timeout: 2000, windowsHide: true });
  const text = `${result.stdout ?? ""} ${result.stderr ?? ""}`;
  const version = text.match(/\d+(?:\.\d+){0,3}/u)?.[0] ?? (result.status === 0 ? "1" : "0");
  return { available: result.status === 0, platform, mechanism: candidate.mechanism, version, command: candidate.command };
}

/** @param {Record<string, any>} profile */
function validateProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) fail("HardenedProfileInvalid", "profile must be an object");
  rejectUnknown(profile, PROFILE_FIELDS, "profile");
  if (profile.schema_version !== HARDENED_EXECUTION_PROFILE_VERSION) fail("HardenedProfileVersionUnsupported", `expected ${HARDENED_EXECUTION_PROFILE_VERSION}`);
  const controls = profile.controls;
  if (!controls || typeof controls !== "object" || Array.isArray(controls)) fail("HardenedProfileInvalid", "controls must be an object");
  rejectUnknown(controls, CONTROL_FIELDS, "controls");
  for (const flag of ["require_supply_chain_lock", "require_redaction", "require_durable_checkpoints"]) {
    if (controls[flag] !== true) fail("HardenedControlRequired", `${flag} must be true`, { control: flag });
  }
  if (!Array.isArray(controls.require_budgets)
    || REQUIRED_BUDGETS.some((budget) => !controls.require_budgets.includes(budget))) {
    fail("HardenedControlRequired", `require_budgets must include ${REQUIRED_BUDGETS.join(", ")}`);
  }
  if (!controls.sandbox || controls.sandbox.required !== true
    || !controls.sandbox.minimum_versions || typeof controls.sandbox.minimum_versions !== "object") {
    fail("HardenedControlRequired", "sandbox.required and minimum_versions are required");
  }
}

/** @param {any} manifest @returns {Map<string, any>} */
function normalizedBindings(manifest) {
  if (manifest?.bindings instanceof Map) return manifest.bindings;
  return new Map(Object.entries(manifest?.bindings ?? {}));
}

/** @param {unknown} actual @param {unknown} minimum */
function compareVersions(actual, minimum) {
  const left = String(actual).split(".").map(Number);
  const right = String(minimum).split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** @param {Record<string, any>} value @param {Set<string>} allowed @param {string} path */
function rejectUnknown(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail("HardenedProfileExtensionUnknown", `${path} contains unknown fields`, { fields: unknown });
}

/** @returns {never} @param {string} code @param {string} message @param {Record<string, any>} [details] */
function fail(code, message, details = {}) {
  throw new ToubaRuntimeError(code, message, details);
}
