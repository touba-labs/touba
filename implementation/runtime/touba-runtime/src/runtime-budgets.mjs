// @ts-check

import { ToubaRuntimeError } from "./runtime-errors.mjs";
import { isRunBudgetValue, runBudgetMinimum } from "../../../contracts/run-budget-values.mjs";

import { RUN_BUDGET_KINDS } from "../../../contracts/run-budget-values.mjs";
export { RUN_BUDGET_KINDS };
export const RUN_BUDGET_KIND_SET = new Set(RUN_BUDGET_KINDS);
export const RUN_BUDGET_ERROR_CODES = Object.freeze({
  max_run_ms: "RunTimeBudgetExceeded",
  max_steps: "StepBudgetExceeded",
  max_tool_calls: "ToolCallBudgetExceeded",
  max_agent_invocations: "AgentInvocationBudgetExceeded",
  max_provider_calls: "AgentDecisionProviderBudgetExceeded",
});
export const RUN_BUDGET_COUNTERS = Object.freeze({
  max_steps: "steps",
  max_tool_calls: "toolCalls",
  max_agent_invocations: "agentInvocations",
  max_provider_calls: "providerCalls",
});

/**
 * @typedef {Record<string, any>} RuntimeBudgetRecord
 *
 * @typedef {object} RunLimit
 * @property {number} value
 * @property {string} authoritySource
 * @property {unknown=} sourceRef
 *
 * @typedef {object} EffectiveRunLimit
 * @property {string} budgetKind
 * @property {number} value
 * @property {string} authoritySource
 * @property {{ authority_source: string, value: number }[]} candidates
 *
 * @typedef {object} ManifestWideningError
 * @property {string} budgetKind
 * @property {number} airValue
 * @property {number} manifestValue
 */

/**
 * @param {{ budgets?: { run?: unknown } }} document
 * @param {{ runLimits?: Map<string, RunLimit> } | null | undefined} manifest
 * @param {RuntimeBudgetRecord} [options]
 */
export function createBudgetState(document, manifest, options = {}) {
  const airRunLimits = normalizeAirRunLimits(document.budgets?.run, "AIR budgets.run");
  const manifestRunLimits = manifest?.runLimits ?? new Map();
  const hostRunLimits = normalizeRunLimitMap(
    options.runLimits ?? options.run_limits,
    "runLimits",
    "host_policy",
  );
  const runtimeDefaultLimits = normalizeRunLimitMap(
    options.runtimeDefaultRunLimits ?? options.runtime_default_run_limits,
    "runtimeDefaultRunLimits",
    "runtime_default",
  );
  const { effectiveLimits, manifestWideningErrors } = effectiveRunBudgetLimits({
    airRunLimits,
    manifestRunLimits,
    hostRunLimits,
    runtimeDefaultLimits,
  });

  return {
    initialized: false,
    airRunLimits,
    manifestRunLimits,
    hostRunLimits,
    runtimeDefaultLimits,
    effectiveLimits,
    manifestWideningErrors,
    counters: {
      steps: 0,
      toolCalls: 0,
      agentInvocations: 0,
      providerCalls: 0,
    },
  };
}

/**
 * @param {unknown} limits
 * @param {string} fieldName
 * @returns {Map<string, Readonly<RunLimit>>}
 */
export function normalizeAirRunLimits(limits, fieldName) {
  if (limits === undefined) {
    return new Map();
  }
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new ToubaRuntimeError("InvalidAirDocument", `${fieldName} must be an object`);
  }
  const normalized = new Map();
  for (const [budgetKind, entry] of Object.entries(limits)) {
    if (!RUN_BUDGET_KIND_SET.has(budgetKind)) {
      throw new ToubaRuntimeError("InvalidAirDocument", `${fieldName} contains unknown budget kind`, {
        budgetKind,
      });
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ToubaRuntimeError("InvalidAirDocument", `${fieldName}.${budgetKind} must be an object`, {
        budgetKind,
      });
    }
    const record = /** @type {RuntimeBudgetRecord} */ (entry);
    if (Object.keys(record).some(key => key !== "value" && key !== "source_ref")) {
      throw new ToubaRuntimeError("InvalidAirDocument", `${fieldName}.${budgetKind} contains unknown fields`, { budgetKind });
    }
    if (!isRunBudgetValue(budgetKind, record.value)) {
      throw new ToubaRuntimeError("InvalidAirDocument", `${fieldName}.${budgetKind}.value must be a safe integer >= ${runBudgetMinimum(budgetKind)}`, {
        budgetKind,
      });
    }
    if (!record.source_ref || typeof record.source_ref !== "object" || Array.isArray(record.source_ref)) {
      throw new ToubaRuntimeError("InvalidAirDocument", `${fieldName}.${budgetKind}.source_ref is required`, {
        budgetKind,
      });
    }
    normalized.set(budgetKind, Object.freeze({
      value: record.value,
      authoritySource: "air",
      sourceRef: record.source_ref,
    }));
  }
  return normalized;
}

/**
 * @param {unknown} limits
 * @param {string} fieldName
 * @param {string} authoritySource
 * @returns {Map<string, Readonly<RunLimit>>}
 */
export function normalizeRunLimitMap(limits, fieldName, authoritySource) {
  if (limits === undefined || limits === null) {
    return new Map();
  }
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} must be an object`);
  }
  const normalized = new Map();
  for (const [budgetKind, value] of Object.entries(limits)) {
    if (!RUN_BUDGET_KIND_SET.has(budgetKind)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName} contains unknown budget kind`, {
        budgetKind,
      });
    }
    if (!isRunBudgetValue(budgetKind, value)) {
      throw new ToubaRuntimeError("InvalidRuntimeOption", `${fieldName}.${budgetKind} must be a safe integer >= ${runBudgetMinimum(budgetKind)}`);
    }
    normalized.set(budgetKind, Object.freeze({
      value,
      authoritySource,
    }));
  }
  return normalized;
}

/**
 * @param {{ airRunLimits: Map<string, RunLimit>, manifestRunLimits: Map<string, RunLimit>, hostRunLimits: Map<string, RunLimit>, runtimeDefaultLimits: Map<string, RunLimit> }} limits
 * @returns {{ effectiveLimits: Map<string, Readonly<EffectiveRunLimit>>, manifestWideningErrors: ManifestWideningError[] }}
 */
export function effectiveRunBudgetLimits({
  airRunLimits,
  manifestRunLimits,
  hostRunLimits,
  runtimeDefaultLimits,
}) {
  const effectiveLimits = new Map();
  /** @type {ManifestWideningError[]} */
  const manifestWideningErrors = [];
  for (const budgetKind of RUN_BUDGET_KINDS) {
    const air = airRunLimits.get(budgetKind);
    const manifest = manifestRunLimits.get(budgetKind);
    if (air && manifest && manifest.value > air.value) {
      manifestWideningErrors.push({
        budgetKind,
        airValue: air.value,
        manifestValue: manifest.value,
      });
    }
    const candidates = /** @type {RunLimit[]} */ ([
      air,
      manifest,
      hostRunLimits.get(budgetKind),
      runtimeDefaultLimits.get(budgetKind),
    ].filter(Boolean));
    if (candidates.length === 0) {
      continue;
    }
    let effective = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (candidate.value < effective.value) {
        effective = candidate;
      }
    }
    effectiveLimits.set(budgetKind, Object.freeze({
      budgetKind,
      value: effective.value,
      authoritySource: effective.authoritySource,
      candidates: candidates.map((candidate) => ({
        authority_source: candidate.authoritySource,
        value: candidate.value,
      })),
    }));
  }
  return {
    effectiveLimits,
    manifestWideningErrors,
  };
}
