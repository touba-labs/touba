// @ts-check

import { createHash } from "node:crypto";

/**
 * @typedef {"inline" | "opaque_refs"} AgentDecisionProviderContentMode
 * @typedef {"runtime_input" | "runtime_observation"} ProviderContentCategory
 * @typedef {"external_content" | "user_intent"} ProviderContentTrust
 * @typedef {"string" | "number" | "boolean" | "bigint" | "symbol" | "undefined" | "object" | "function" | "null" | "array"} ValueKind
 *
 * @typedef {object} RuntimeObservation
 * @property {number=} step_index
 * @property {string=} action
 * @property {string=} target_ref
 * @property {string=} kind
 * @property {string=} result_type
 * @property {unknown=} value
 *
 * @typedef {object} OpaqueValueMetadata
 * @property {ValueKind} value_kind
 * @property {string} digest
 * @property {number} approx_size_bytes
 * @property {number=} string_length
 * @property {number=} array_length
 * @property {number=} field_count
 *
 * @typedef {object} RuntimeInputEntry
 * @property {string} name
 * @property {ProviderContentCategory} category
 * @property {ProviderContentTrust} trust
 * @property {unknown=} value
 * @property {string=} ref
 * @property {string=} summary
 * @property {OpaqueValueMetadata=} metadata
 *
	 * @typedef {object} RuntimeObservationEntry
	 * @property {string=} ref
	 * @property {ProviderContentCategory=} category
	 * @property {ProviderContentTrust=} trust
 * @property {number=} step_index
 * @property {string=} action
 * @property {string=} target_ref
 * @property {string=} kind
 * @property {string=} result_type
 * @property {unknown=} value
 * @property {string=} summary
 * @property {OpaqueValueMetadata=} metadata
 *
 * @typedef {object} ContentRef
 * @property {string=} ref
 * @property {string=} name
 * @property {ProviderContentCategory=} category
 * @property {ProviderContentTrust=} trust
 * @property {number=} step_index
 * @property {string=} target_ref
 * @property {string=} result_type
 *
 * @typedef {object} ExternalContentAccess
 * @property {boolean} raw_content_in_provider_request
 * @property {number} content_ref_count
 * @property {string} full_content_request_policy
 * @property {string=} full_content_request_path
 * @property {string[]=} budgeted_by
 * @property {string[]=} traced_by
 *
 * @typedef {object} AgentDecisionProviderContent
 * @property {AgentDecisionProviderContentMode} mode
 * @property {Record<string, unknown> | Record<string, RuntimeInputEntry>} inputs
 * @property {RuntimeInputEntry[]} inputEntries
 * @property {RuntimeObservationEntry[]} observations
 * @property {number} observationsBytes
 * @property {ContentRef[]} refs
 * @property {ExternalContentAccess} externalContentAccess
 */

/**
 * Builds the content boundary shown to an agent decision provider.
 *
 * The `opaque_refs` mode deliberately replaces raw runtime inputs and runtime
 * observations with descriptors. This module is kept small and type-checked
 * because a property typo here can become an authority or data disclosure bug.
 *
 * @param {Record<string, unknown>} inputs
 * @param {RuntimeObservation[]} observations
 * @param {{ agentDecisionProviderContentMode?: AgentDecisionProviderContentMode, agentDecisionProviderVisibleInputKeys?: string[] } | null | undefined} context
 * @returns {AgentDecisionProviderContent}
 */
export function agentDecisionProviderContent(inputs, observations, context) {
  const mode = context?.agentDecisionProviderContentMode ?? "inline";
  if (mode === "opaque_refs") {
    const inputEntries = Object.entries(inputs).map(([name, value], index) =>
      opaqueRuntimeInputDescriptor(name, value, index, isVisibleUserIntentInput(name, value, context)),
    );
    const observationEntries = observations.map((observation, index) =>
      opaqueRuntimeObservationDescriptor(observation, index),
    );
    const refs = [...inputEntries, ...observationEntries].map((entry) => contentRefFromEntry(entry));
    return {
      mode,
      inputs: Object.fromEntries(inputEntries.map((entry) => [entry.name, entry])),
      inputEntries,
      observations: observationEntries,
      observationsBytes: estimateJsonBytes(observationEntries),
      refs,
      externalContentAccess: agentExternalContentAccessPolicy(mode, refs.length),
    };
  }

  const inputEntries = Object.entries(inputs).map(([name, value]) => {
    /** @type {RuntimeInputEntry} */
    const entry = {
      name,
      category: "runtime_input",
      trust: "external_content",
      value,
    };
    return entry;
  });
  const observationEntries = observations.map((observation) => runtimeObservationEntry({
    step_index: observation.step_index,
    action: observation.action,
    target_ref: observation.target_ref,
    kind: observation.kind,
    result_type: observation.result_type,
    value: observation.value,
  }));
  return {
    mode,
    inputs,
    inputEntries,
    observations: observationEntries,
    observationsBytes: estimateJsonBytes(observationEntries),
    refs: [],
    externalContentAccess: agentExternalContentAccessPolicy(mode, 0),
  };
}

/**
 * @param {{ agentProviderObservationsMaxBytes?: number | null } | null | undefined} context
 * @param {AgentDecisionProviderContent} providerContent
 * @returns {{ max_bytes?: number | null, consumed_bytes: number, content_mode: AgentDecisionProviderContentMode }}
 */
export function agentProviderObservationBudgetReport(context, providerContent) {
  return /** @type {{ max_bytes?: number | null, consumed_bytes: number, content_mode: AgentDecisionProviderContentMode }} */ (compactPayload({
    max_bytes: context?.agentProviderObservationsMaxBytes ?? null,
    consumed_bytes: providerContent.observationsBytes,
    content_mode: providerContent.mode,
  }));
}

/**
 * @param {RuntimeInputEntry | RuntimeObservationEntry} entry
 * @returns {ContentRef}
 */
function contentRefFromEntry(entry) {
  return /** @type {ContentRef} */ (compactPayload({
    ref: entry.ref,
    name: "name" in entry ? entry.name : undefined,
    category: entry.category,
    trust: entry.trust,
    step_index: "step_index" in entry ? entry.step_index : undefined,
    target_ref: "target_ref" in entry ? entry.target_ref : undefined,
    result_type: "result_type" in entry ? entry.result_type : undefined,
  }));
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {RuntimeObservationEntry}
 */
function runtimeObservationEntry(payload) {
  return /** @type {RuntimeObservationEntry} */ (compactPayload(payload));
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} index
 * @param {boolean=} visibleUserIntent
 * @returns {RuntimeInputEntry}
 */
function opaqueRuntimeInputDescriptor(name, value, index, visibleUserIntent = false) {
  const valueShape = opaqueValueShape(value);
  if (visibleUserIntent) {
    return /** @type {RuntimeInputEntry} */ (compactPayload({
      name,
      ref: `visible:runtime_input/${opaqueRefSegment(name, `input-${index}`)}`,
      category: "runtime_input",
      trust: "user_intent",
      value,
      summary: `visible user intent; ${opaqueValueSummary(valueShape)}`,
      metadata: valueShape,
    }));
  }
  return /** @type {RuntimeInputEntry} */ (compactPayload({
    name,
    ref: `opaque:runtime_input/${opaqueRefSegment(name, `input-${index}`)}`,
    category: "runtime_input",
    trust: "external_content",
    summary: opaqueValueSummary(valueShape),
    metadata: valueShape,
  }));
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {{ agentDecisionProviderVisibleInputKeys?: string[] } | null | undefined} context
 * @returns {boolean}
 */
function isVisibleUserIntentInput(name, value, context) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) {
    return false;
  }
  const configuredKeys = Array.isArray(context?.agentDecisionProviderVisibleInputKeys)
    ? context.agentDecisionProviderVisibleInputKeys
    : [];
  const visibleKeys = new Set([
    "user_goal",
    "goal",
    "user_request",
    "request",
    "task",
    "objective",
    ...configuredKeys,
  ]);
  return visibleKeys.has(name);
}

/**
 * @param {RuntimeObservation} observation
 * @param {number} index
 * @returns {RuntimeObservationEntry}
 */
function opaqueRuntimeObservationDescriptor(observation, index) {
  const valueShape = opaqueValueShape(observation.value);
  const stepIndex = observation.step_index ?? index;
  return /** @type {RuntimeObservationEntry} */ (compactPayload({
    ref: `opaque:runtime_observation/${opaqueRefSegment(stepIndex, `observation-${index}`)}`,
    category: "runtime_observation",
    trust: "external_content",
    step_index: observation.step_index,
    action: observation.action,
    target_ref: observation.target_ref,
    kind: observation.kind,
    result_type: observation.result_type,
    summary: opaqueValueSummary(valueShape),
    metadata: valueShape,
  }));
}

/**
 * @param {unknown} value
 * @returns {OpaqueValueMetadata}
 */
function opaqueValueShape(value) {
  const kind = valueKind(value);
  return /** @type {OpaqueValueMetadata} */ (compactPayload({
    value_kind: kind,
    digest: `sha256:${sha256Json(value ?? null)}`,
    approx_size_bytes: estimateJsonBytes(value),
    string_length: typeof value === "string" ? value.length : undefined,
    array_length: Array.isArray(value) ? value.length : undefined,
    field_count: isPlainObject(value) ? Object.keys(value).length : undefined,
  }));
}

/**
 * @param {OpaqueValueMetadata} shape
 * @returns {string}
 */
function opaqueValueSummary(shape) {
  return `${shape.value_kind}; ${shape.approx_size_bytes} bytes`;
}

/**
 * @param {unknown} value
 * @returns {ValueKind}
 */
function valueKind(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function opaqueRefSegment(value, fallback) {
  const segment = String(value)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return segment.length > 0 ? segment : fallback;
}

/**
 * @param {AgentDecisionProviderContentMode} mode
 * @param {number} refCount
 * @returns {ExternalContentAccess}
 */
function agentExternalContentAccessPolicy(mode, refCount) {
  if (mode === "opaque_refs") {
    return {
      raw_content_in_provider_request: false,
      content_ref_count: refCount,
      full_content_request_policy: "explicit_authorized_capability_required",
      full_content_request_path: "select_capability_with_content_ref",
      budgeted_by: ["max_provider_calls", "max_agent_steps", "run_limits", "tool_binding_limits"],
      traced_by: ["agent_decision_requested", "agent_capability_selected", "agent_capability_result_returned"],
    };
  }
  return {
    raw_content_in_provider_request: true,
    content_ref_count: refCount,
    full_content_request_policy: "inline_provider_request",
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function estimateJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
function compactPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null),
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sha256Json(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
