// @ts-check

import { createHash } from "node:crypto";
import { ToubaRuntimeError } from "./runtime-errors.mjs";

export const AGENT_PROVIDER_OBSERVATIONS_DEFAULT_MAX_BYTES = 32768;
const AGENT_DECISION_PROVIDER_METADATA_FIELDS = Object.freeze([
  "provider_kind",
  "provider_name",
  "provider_version",
  "model_family",
  "model_id",
  "prompt_template_id",
  "decision_schema_version",
]);
const AGENT_DECISION_PROVIDER_METADATA_FIELD_SET = new Set(AGENT_DECISION_PROVIDER_METADATA_FIELDS);
const AGENT_DECISION_PROVIDER_METADATA_MAX_LENGTH = 200;
const SKILL_PACK_REF_PATTERN = /^skill_pack:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SKILL_PACK_RESOURCE_REF_PATTERN = /^resource:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SKILL_PACK_EXECUTION_TARGET_PATTERN = /^(tool|skill):[A-Za-z0-9_.-]+\/[A-Za-z][A-Za-z0-9_]*$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SKILL_PACK_RESOURCE_KINDS = new Set(["procedure", "reference", "example", "template", "sample", "script", "fixture"]);
const SKILL_PACK_BUDGET_FIELDS = Object.freeze({
  discoveryMaxBytes: "skillPackDiscoveryMaxBytes",
  activationMaxBytes: "skillPackActivationMaxBytes",
  modelInputMaxBytes: "agentModelInputMaxBytes",
});

/**
 * @typedef {"inline" | "opaque_refs"} AgentDecisionProviderContentMode
 *
 * @typedef {Record<string, any>} RuntimeOptionRecord
 *
 * @typedef {object} NormalizedAgentDecisionProvider
 * @property {(request: any, execution?: any) => unknown | Promise<unknown>} decide
 * @property {Readonly<Record<string, string>> | null} metadata
 * @property {Readonly<Record<string, string>>} initialModes
 *
 * @typedef {object} NormalizedSkillPackResource
 * @property {string} ref
 * @property {string} path
 * @property {string} kind
 * @property {string | null} digest
 * @property {boolean} loadableAsContext
 * @property {string=} content
 *
 * @typedef {object} NormalizedSkillPackExecutionLink
 * @property {string} label
 * @property {string} target_ref
 * @property {string=} description
 *
 * @typedef {object} NormalizedSkillPack
 * @property {string} ref
 * @property {string} name
 * @property {string} description
 * @property {string} version
 * @property {string[]} tags
 * @property {string} source
 * @property {string} digest
 * @property {{ model_invocable: boolean, user_invocable: boolean }} activation
 * @property {ReadonlyArray<NormalizedSkillPackResource>} resources
 * @property {ReadonlyArray<NormalizedSkillPackExecutionLink>} executionLinks
 *
 * @typedef {object} SkillPackBudgets
 * @property {number | null} discoveryMaxBytes
 * @property {number | null} activationMaxBytes
 * @property {number | null} modelInputMaxBytes
 */

/**
 * @param {unknown} provider
 * @param {{ metadata?: unknown }} [options]
 * @returns {Readonly<NormalizedAgentDecisionProvider> | null}
 */
export function normalizeAgentDecisionProvider(provider, options = {}) {
  if (provider === undefined || provider === null) {
    return null;
  }
  const metadataOverride = normalizeAgentDecisionProviderMetadata(
    options.metadata,
    "agentDecisionProviderMetadata",
    { optional: true },
  );
  if (typeof provider === "function") {
    const providerRecord = /** @type {RuntimeOptionRecord} */ (provider);
    return Object.freeze({
      decide: /** @type {(request: any, execution?: any) => unknown | Promise<unknown>} */ (provider),
      initialModes: normalizeInitialModes(providerRecord.initialModes),
      metadata: metadataOverride
        ?? normalizeAgentDecisionProviderMetadata(providerRecord.metadata, "agentDecisionProvider.metadata", { optional: true }),
    });
  }
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw invalidAgentDecisionProvider();
  }

  const providerRecord = /** @type {RuntimeOptionRecord} */ (provider);
  if (typeof providerRecord.decideAgentCapability === "function") {
    return Object.freeze({
      decide: providerRecord.decideAgentCapability.bind(provider),
      initialModes: normalizeInitialModes(providerRecord.initialModes),
      metadata: metadataOverride
        ?? normalizeAgentDecisionProviderMetadata(
          providerRecord.provider_metadata ?? providerRecord.providerMetadata ?? providerRecord.metadata,
          "agentDecisionProvider.metadata",
          { optional: true },
        ),
    });
  }
  if (typeof providerRecord.decide === "function") {
    return Object.freeze({
      decide: providerRecord.decide.bind(provider),
      initialModes: normalizeInitialModes(providerRecord.initialModes),
      metadata: metadataOverride
        ?? normalizeAgentDecisionProviderMetadata(
          providerRecord.provider_metadata ?? providerRecord.providerMetadata ?? providerRecord.metadata,
          "agentDecisionProvider.metadata",
          { optional: true },
        ),
    });
  }
  throw invalidAgentDecisionProvider();
}

/** @param {unknown} value @returns {Readonly<Record<string, string>>} */
function normalizeInitialModes(value) {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 1024) throw invalidAgentDecisionProvider();
  const result = Object.create(null);
  for (const [ref, mode] of Object.entries(value)) {
    if (!/^agent:[A-Za-z0-9_.-]+\/[A-Za-z][A-Za-z0-9_]*$/u.test(ref) || !["summary", "capabilities"].includes(mode)) throw invalidAgentDecisionProvider();
    result[ref] = mode;
  }
  return Object.freeze(result);
}

/**
 * @param {unknown} mode
 * @returns {AgentDecisionProviderContentMode}
 */
export function normalizeAgentDecisionProviderContentMode(mode) {
  if (mode === "inline" || mode === "opaque_refs") {
    return mode;
  }
  throw new ToubaRuntimeError(
    "InvalidRuntimeOption",
    "agentDecisionProviderContentMode must be inline or opaque_refs",
    { mode },
  );
}

/**
 * @param {unknown} metadata
 * @param {string} fieldName
 * @param {{ optional?: boolean }} [options]
 * @returns {Readonly<Record<string, string>> | null}
 */
export function normalizeAgentDecisionProviderMetadata(metadata, fieldName, options = {}) {
  if (metadata === undefined || metadata === null) {
    return options.optional ? null : {};
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ToubaRuntimeError("InvalidAgentDecisionProvider", `${fieldName} must be an object`);
  }
  /** @type {Record<string, string>} */
  const normalized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!AGENT_DECISION_PROVIDER_METADATA_FIELD_SET.has(key)) {
      throw new ToubaRuntimeError("InvalidAgentDecisionProvider", `${fieldName} contains unsupported field`, {
        field: key,
      });
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new ToubaRuntimeError("InvalidAgentDecisionProvider", `${fieldName}.${key} must be a non-empty string`, {
        field: key,
      });
    }
    if (value.length > AGENT_DECISION_PROVIDER_METADATA_MAX_LENGTH) {
      throw new ToubaRuntimeError("InvalidAgentDecisionProvider", `${fieldName}.${key} is too long`, {
        field: key,
      });
    }
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? Object.freeze(normalized) : null;
}

/**
 * @param {unknown} skillPacks
 * @returns {ReadonlyArray<Readonly<NormalizedSkillPack>>}
 */
export function normalizeSkillPacks(skillPacks) {
  if (skillPacks === undefined || skillPacks === null) {
    return [];
  }
  if (!Array.isArray(skillPacks)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", "skillPacks must be an array");
  }
  const refs = new Set();
  return skillPacks.map((pack, index) => {
    const fieldName = `skillPacks[${index}]`;
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be an object`);
    }
    const packRecord = /** @type {RuntimeOptionRecord} */ (pack);
    const ref = normalizeSkillPackRef(packRecord.ref, `${fieldName}.ref`);
    if (refs.has(ref)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", "skillPacks cannot contain duplicate refs", { ref });
    }
    refs.add(ref);
    const resources = normalizeSkillPackResources(packRecord.resources ?? [], `${fieldName}.resources`);
    const executionLinks = normalizeSkillPackExecutionLinks(
      packRecord.execution_links ?? packRecord.executionLinks ?? [],
      `${fieldName}.execution_links`,
    );
    const rawVersion = packRecord.version;
    const version = normalizeNonEmptyRuntimeString(rawVersion ?? "0.0.0", `${fieldName}.version`);
    return Object.freeze({
      ref,
      name: normalizeNonEmptyRuntimeString(packRecord.name, `${fieldName}.name`),
      description: normalizeNonEmptyRuntimeString(packRecord.description, `${fieldName}.description`),
      version,
      tags: normalizeRuntimeStringArray(packRecord.tags ?? [], `${fieldName}.tags`),
      source: normalizeNonEmptyRuntimeString(packRecord.source ?? "project", `${fieldName}.source`),
      digest: normalizeOptionalSha256Digest(packRecord.digest, `${fieldName}.digest`)
        ?? digestSkillPackEvidence(ref, rawVersion, resources),
      activation: normalizeSkillPackActivation(packRecord.activation ?? {}, `${fieldName}.activation`),
      resources,
      executionLinks,
    });
  });
}

/**
 * @param {RuntimeOptionRecord} options
 * @returns {Readonly<SkillPackBudgets>}
 */
export function normalizeSkillPackBudgets(options) {
  return Object.freeze({
    discoveryMaxBytes: normalizeOptionalPositiveRuntimeInteger(
      options.skillPackDiscoveryMaxBytes
        ?? options.skill_pack_discovery_max_bytes
        ?? null,
      SKILL_PACK_BUDGET_FIELDS.discoveryMaxBytes,
    ),
    activationMaxBytes: normalizeOptionalPositiveRuntimeInteger(
      options.skillPackActivationMaxBytes
        ?? options.skill_pack_activation_max_bytes
        ?? null,
      SKILL_PACK_BUDGET_FIELDS.activationMaxBytes,
    ),
    modelInputMaxBytes: normalizeOptionalPositiveRuntimeInteger(
      options.agentModelInputMaxBytes
        ?? options.agent_model_input_max_bytes
        ?? null,
      SKILL_PACK_BUDGET_FIELDS.modelInputMaxBytes,
    ),
  });
}

/**
 * @param {unknown} reasons
 * @returns {Map<string, string>}
 */
export function normalizeSkillPackActivationReasons(reasons) {
  if (reasons instanceof Map) {
    return new Map(
      [...reasons.entries()].map(([ref, reason]) => [
        normalizeSkillPackRef(ref, "skillPackActivationReasons key"),
        normalizeNonEmptyRuntimeString(reason, `skillPackActivationReasons.${ref}`),
      ]),
    );
  }
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", "skillPackActivationReasons must be an object");
  }
  const normalized = new Map();
  for (const [ref, reason] of Object.entries(reasons)) {
    normalized.set(
      normalizeSkillPackRef(ref, "skillPackActivationReasons key"),
      normalizeNonEmptyRuntimeString(reason, `skillPackActivationReasons.${ref}`),
    );
  }
  return normalized;
}

/**
 * @param {unknown} values
 * @param {string} fieldName
 * @returns {Set<string>}
 */
export function normalizeStringSet(values, fieldName) {
  if (values instanceof Set) {
    values = [...values];
  }
  if (!Array.isArray(values)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be an array`);
  }
  const normalized = new Set();
  for (const value of values) {
    normalized.add(normalizeSkillPackRef(value, `${fieldName}[]`));
  }
  return normalized;
}

/**
 * @param {ReadonlyArray<{ ref: string }>} skillPacks
 * @param {Set<string>} activeRefs
 */
export function validateActiveSkillPackRefs(skillPacks, activeRefs) {
  const knownRefs = new Set(skillPacks.map((pack) => pack.ref));
  for (const ref of activeRefs) {
    if (!knownRefs.has(ref)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", "activeSkillPackRefs contains an unknown skill pack ref", {
        ref,
      });
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number | null}
 */
export function normalizeOptionalPositiveRuntimeInteger(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizePositiveRuntimeInteger(value, fieldName);
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number | null}
 */
export function normalizeOptionalNonNegativeRuntimeInteger(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeNonNegativeRuntimeInteger(value, fieldName);
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number}
 */
export function normalizePositiveRuntimeInteger(value, fieldName) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ToubaRuntimeError(
      "InvalidRuntimeOption",
      `${fieldName} must be a positive integer`,
      { fieldName },
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number}
 */
export function normalizeNonNegativeRuntimeInteger(value, fieldName) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ToubaRuntimeError(
      "InvalidRuntimeOption",
      `${fieldName} values must be non-negative integers`,
      { fieldName },
    );
  }
  return value;
}

/**
 * @param {unknown} resources
 * @param {string} fieldName
 * @returns {ReadonlyArray<Readonly<NormalizedSkillPackResource>>}
 */
function normalizeSkillPackResources(resources, fieldName) {
  if (!Array.isArray(resources)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be an array`);
  }
  const refs = new Set();
  return resources.map((resource, index) => {
    const entryField = `${fieldName}[${index}]`;
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", `${entryField} must be an object`);
    }
    const resourceRecord = /** @type {RuntimeOptionRecord} */ (resource);
    const ref = normalizeSkillPackResourceRef(resourceRecord.ref, `${entryField}.ref`);
    if (refs.has(ref)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} cannot contain duplicate resource refs`, { ref });
    }
    refs.add(ref);
    const kind = normalizeNonEmptyRuntimeString(resourceRecord.kind, `${entryField}.kind`);
    if (!SKILL_PACK_RESOURCE_KINDS.has(kind)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", `${entryField}.kind is not supported`, { kind });
    }
    if (resourceRecord.executable_by_pack === true || resourceRecord.executableByPack === true) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", "skill pack scripts cannot be executable by the pack", {
        fieldName: entryField,
      });
    }
    const loadableAsContext = resourceRecord.loadable_as_context ?? resourceRecord.loadableAsContext ?? false;
    if (typeof loadableAsContext !== "boolean") {
      throw new ToubaRuntimeError("InvalidRuntimeOption", `${entryField}.loadable_as_context must be boolean`);
    }
    return Object.freeze({
      ref,
      path: normalizeNonEmptyRuntimeString(resourceRecord.path, `${entryField}.path`),
      kind,
      digest: normalizeOptionalSha256Digest(resourceRecord.digest, `${entryField}.digest`),
      loadableAsContext,
      content: normalizeOptionalRuntimeString(resourceRecord.content, `${entryField}.content`),
    });
  });
}

/**
 * @param {unknown} links
 * @param {string} fieldName
 * @returns {ReadonlyArray<Readonly<NormalizedSkillPackExecutionLink>>}
 */
function normalizeSkillPackExecutionLinks(links, fieldName) {
  if (!Array.isArray(links)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be an array`);
  }
  return links.map((link, index) => {
    const entryField = `${fieldName}[${index}]`;
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", `${entryField} must be an object`);
    }
    const linkRecord = /** @type {RuntimeOptionRecord} */ (link);
    return Object.freeze({
      label: normalizeNonEmptyRuntimeString(linkRecord.label, `${entryField}.label`),
      target_ref: normalizeSkillPackExecutionTargetRef(linkRecord.target_ref ?? linkRecord.targetRef, `${entryField}.target_ref`),
      description: normalizeOptionalRuntimeString(linkRecord.description, `${entryField}.description`),
    });
  });
}

/**
 * @param {unknown} activation
 * @param {string} fieldName
 * @returns {{ model_invocable: boolean, user_invocable: boolean }}
 */
function normalizeSkillPackActivation(activation, fieldName) {
  if (!activation || typeof activation !== "object" || Array.isArray(activation)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be an object`);
  }
  const activationRecord = /** @type {RuntimeOptionRecord} */ (activation);
  return Object.freeze({
    model_invocable: activationRecord.model_invocable !== false,
    user_invocable: activationRecord.user_invocable !== false,
  });
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function normalizeSkillPackRef(value, fieldName) {
  const ref = normalizeNonEmptyRuntimeString(value, fieldName);
  if (!SKILL_PACK_REF_PATTERN.test(ref)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be a skill_pack ref`, { ref });
  }
  return ref;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function normalizeSkillPackResourceRef(value, fieldName) {
  const ref = normalizeNonEmptyRuntimeString(value, fieldName);
  if (!SKILL_PACK_RESOURCE_REF_PATTERN.test(ref)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be a resource ref`, { ref });
  }
  return ref;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function normalizeSkillPackExecutionTargetRef(value, fieldName) {
  const ref = normalizeNonEmptyRuntimeString(value, fieldName);
  if (!SKILL_PACK_EXECUTION_TARGET_PATTERN.test(ref)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be a tool or skill ref`, { ref });
  }
  return ref;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string | null}
 */
function normalizeOptionalSha256Digest(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  const digest = normalizeNonEmptyRuntimeString(value, fieldName);
  if (!SHA256_DIGEST_PATTERN.test(digest)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be sha256:<hex>`);
  }
  return digest;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
function normalizeNonEmptyRuntimeString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string | undefined}
 */
function normalizeOptionalRuntimeString(value, fieldName) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizeNonEmptyRuntimeString(value, fieldName);
}

/**
 * @param {unknown} values
 * @param {string} fieldName
 * @returns {string[]}
 */
function normalizeRuntimeStringArray(values, fieldName) {
  if (!Array.isArray(values)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be an array`);
  }
  return values.map((value, index) => normalizeNonEmptyRuntimeString(value, `${fieldName}[${index}]`));
}

/**
 * @param {string} ref
 * @param {unknown} version
 * @param {ReadonlyArray<NormalizedSkillPackResource>} resources
 * @returns {string}
 */
function digestSkillPackEvidence(ref, version, resources) {
  return `sha256:${sha256Json({
    ref,
    version,
    resources: resources.map((resource) => ({
      ref: resource.ref,
      digest: resource.digest,
      path: resource.path,
      kind: resource.kind,
    })),
  })}`;
}

/**
 * @returns {ToubaRuntimeError}
 */
function invalidAgentDecisionProvider() {
  return new ToubaRuntimeError(
    "InvalidAgentDecisionProvider",
    "agentDecisionProvider must be a function or an object exposing decideAgentCapability",
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
