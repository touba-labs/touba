import { ToubaAgentDecisionProviderError } from "./decision-contract.mjs";

const costErrors = new WeakSet();
export const costFail = (code, message) => {
  const error = new ToubaAgentDecisionProviderError(code, message);
  costErrors.add(error); throw error;
};
export function providerCostError(error) {
  const pending = [error], seen = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    if (costErrors.has(item)) return item;
    seen.add(item);
    pending.push(item.cause, item.lastError, ...(Array.isArray(item.errors) ? item.errors : []));
  }
  return null;
}
export const validMicros = value => typeof value === "bigint" && value >= 0n;
export const validCurrency = value => typeof value === "string" && /^[A-Z]{3}$/.test(value);
export const validCostId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

export function validateCostCorrelation(value) {
  if (value === undefined) return null;
  if (!value || Object.keys(value).some(key => !["run_id", "invocation_id", "agent_ref", "step_index"].includes(key))
    || ["run_id", "invocation_id", "agent_ref"].some(key => typeof value[key] !== "string" || !/^[A-Za-z0-9_:/.-]{1,512}$/.test(value[key]))
    || !Number.isSafeInteger(value.step_index) || value.step_index < 0) {
    costFail("InvalidProviderBudgetOptions", "invalid runtime cost correlation");
  }
  return { run_id: value.run_id, invocation_id: value.invocation_id, agent_ref: value.agent_ref, step_index: value.step_index };
}

export function validateCostQuote(quote, currency) {
  if (!quote || quote.basis !== "upper_bound" || !validMicros(quote.maxCostMicros)
      || !validCurrency(quote.currency) || quote.currency !== currency
      || !validCostId(quote.tariffId) || typeof quote.tariffDate !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test(quote.tariffDate)
      || quote.tariffDate.startsWith("0000-")
      || !Number.isFinite(Date.parse(quote.tariffDate))
      || new Date(quote.tariffDate).toISOString().slice(0, 10) !== quote.tariffDate) {
    costFail("ProviderCostBoundUnavailable", "a dated host tariff and a known upper cost bound in the budget currency are required");
  }
  // Do not retain arbitrary host metadata, request bodies or credential fields.
  return Object.freeze({ basis: quote.basis, maxCostMicros: quote.maxCostMicros,
    currency: quote.currency, tariffId: quote.tariffId, tariffDate: quote.tariffDate });
}

export function validateCostUsage(usage) {
  if (!usage || !["reported", "estimated", "unknown"].includes(usage.kind)
      || (usage.kind === "unknown" ? usage.costMicros !== undefined : !validMicros(usage.costMicros))) {
    costFail("ProviderCostUsageInvalid", "usage must distinguish reported, estimated and unknown cost");
  }
  return { kind: usage.kind, costMicros: usage.costMicros ?? null };
}
