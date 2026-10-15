export const TOUBA_MANIFEST_V1 = "touba-manifest-v1";

const EFFECT_KINDS = new Set(["none", "external_write"]);
const EXTERNAL_WRITE_RETRY_MODES = new Set(["idempotency_key", "reconcile", "none"]);
const COMPENSATION_ENTRY_REF_PATTERN = /^strategy:[A-Za-z0-9_.-]+\/[A-Za-z][A-Za-z0-9_]*$/u;

export class EffectContractValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EffectContractValidationError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeEffectContract(contract, options = {}) {
  const label = options.label ?? "effect_contract";
  if (!isPlainObject(contract)) {
    fail("EffectContractInvalid", `${label} must be an object`, { label });
  }

  const unknownFields = Object.keys(contract).filter(
    (field) => !["kind", "retry_mode", "compensation"].includes(field),
  );
  if (unknownFields.length > 0) {
    fail("EffectContractFieldUnknown", `${label} contains unknown fields`, {
      label,
      unknown_fields: unknownFields.sort(),
    });
  }

  if (!EFFECT_KINDS.has(contract.kind)) {
    fail("EffectContractKindUnsupported", `${label}.kind is unsupported`, {
      label,
      actual: contract.kind,
    });
  }

  if (contract.kind === "none") {
    if (Object.hasOwn(contract, "retry_mode")) {
      fail("EffectRetryModeForbidden", `${label}.retry_mode is forbidden when kind is none`, {
        label,
        actual: contract.retry_mode,
      });
    }
    if (Object.hasOwn(contract, "compensation")) {
      fail("EffectCompensationForbidden", `${label}.compensation is forbidden when kind is none`, {
        label,
      });
    }
    return Object.freeze({ kind: "none" });
  }

  if (!Object.hasOwn(contract, "retry_mode")) {
    fail("EffectRetryModeRequired", `${label}.retry_mode is required for external_write`, { label });
  }
  if (!EXTERNAL_WRITE_RETRY_MODES.has(contract.retry_mode)) {
    fail("EffectRetryModeUnsupported", `${label}.retry_mode is unsupported`, {
      label,
      actual: contract.retry_mode,
    });
  }

  const compensation = normalizeOptionalCompensation(contract.compensation, {
    label: `${label}.compensation`,
    manifestVersion: options.manifestVersion,
  });
  return Object.freeze({
    kind: "external_write",
    retryMode: contract.retry_mode,
    ...(compensation === null ? {} : { compensation }),
  });
}

export function validateManifestEffectContracts(manifest) {
  if (!isPlainObject(manifest)) {
    fail("ManifestInvalid", "manifest must be an object");
  }
  if (manifest.manifest_version !== TOUBA_MANIFEST_V1) {
    fail("ManifestVersionUnsupported", "manifest_version is unsupported", {
      actual: manifest.manifest_version,
    });
  }
  if (!isPlainObject(manifest.bindings)) {
    fail("ManifestBindingsInvalid", "manifest bindings must be an object");
  }

  const normalized = new Map();
  for (const [toolRef, binding] of Object.entries(manifest.bindings)) {
    if (!isPlainObject(binding)) {
      fail("ManifestBindingInvalid", `manifest binding ${toolRef} must be an object`, { tool_ref: toolRef });
    }
    const hasContract = Object.hasOwn(binding, "effect_contract");
    if (!hasContract) {
      fail("EffectContractMissing", `manifest binding ${toolRef} must declare effect_contract`, {
        tool_ref: toolRef,
      });
    }
    normalized.set(toolRef, normalizeEffectContract(binding.effect_contract, {
      label: `bindings.${toolRef}.effect_contract`,
      manifestVersion: manifest.manifest_version,
    }));
  }
  return Object.freeze({
    manifestVersion: manifest.manifest_version,
    effectContracts: normalized,
  });
}

export function effectContractToJson(contract) {
  if (contract.kind === "none") {
    return { kind: "none" };
  }
  return {
    kind: "external_write",
    retry_mode: contract.retryMode,
    ...(contract.compensation === undefined
      ? {}
      : { compensation: { entry_ref: contract.compensation.entryRef } }),
  };
}

function normalizeOptionalCompensation(value, options) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    fail("EffectCompensationInvalid", `${options.label} must be an object`, { label: options.label });
  }
  const unknownFields = Object.keys(value).filter((field) => field !== "entry_ref");
  if (unknownFields.length > 0) {
    fail("EffectCompensationFieldUnknown", `${options.label} contains unknown fields`, {
      label: options.label,
      unknown_fields: unknownFields.sort(),
    });
  }
  if (
    typeof value.entry_ref !== "string"
    || value.entry_ref.length > 256
    || !COMPENSATION_ENTRY_REF_PATTERN.test(value.entry_ref)
  ) {
    fail("EffectCompensationEntryRefInvalid", `${options.label}.entry_ref is invalid`, {
      label: options.label,
    });
  }
  return Object.freeze({ entryRef: value.entry_ref });
}

function fail(code, message, details = {}) {
  throw new EffectContractValidationError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
