// Value contract shared by AIR admission, manifests, runtime options and CLI.
export const RUN_BUDGET_KINDS = Object.freeze([
  "max_run_ms", "max_steps", "max_tool_calls", "max_agent_invocations", "max_provider_calls",
]);

export const ZERO_CALL_BUDGET_KINDS = Object.freeze([
  "max_tool_calls", "max_agent_invocations", "max_provider_calls",
]);

/** @param {string} kind */
export function runBudgetMinimum(kind) {
  return ZERO_CALL_BUDGET_KINDS.includes(kind) ? 0 : 1;
}

/** @param {string} kind @param {unknown} value */
export function isRunBudgetValue(kind, value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= runBudgetMinimum(kind);
}
