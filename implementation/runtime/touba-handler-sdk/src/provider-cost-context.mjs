import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { costFail, providerCostError } from "./provider-cost-contract.mjs";

const calls = new AsyncLocalStorage();

// Invocation-local, including concurrent agents. Never attached to the request
// serialized for a model. The runtime alone owns the trace callback.
export function bindProviderCostContext(decide) {
  return (request, execution) => calls.run({ request, execution }, async () => {
    try { return await decide(request); }
    catch (error) { throw providerCostError(error) ?? error; }
  });
}

export function providerCostCorrelation() {
  const request = calls.getStore()?.request;
  if (!request) return undefined;
  // Direct SDK calls need not belong to a runtime invocation. Never invent an
  // execution identity for them; a runtime request always supplies both IDs.
  if (request.run_id === undefined && request.invocation_id === undefined) return undefined;
  return { run_id: request.run_id, invocation_id: request.invocation_id,
    agent_ref: request.agent_ref, step_index: request.step_index ?? 0 };
}

export async function emitProviderModel(model, policy = {}) {
  const observer = calls.getStore()?.execution?.recordProviderMetadata;
  if (!observer || typeof model?.modelId !== "string" || typeof model?.provider !== "string") return;
  const accepted = await observer({ provider_kind: "ai_sdk", provider_name: model.provider, model_id: model.modelId, ...policy });
  if (accepted === false) costFail("ProviderRequestAborted", "provider invocation is no longer active");
}

export async function emitProviderCost(budget, attemptId) {
  const observer = calls.getStore()?.execution?.recordProviderCost;
  if (!observer) return;
  if (typeof budget.attempt !== "function" || typeof budget.snapshot !== "function") {
    costFail("InvalidProviderBudgetOptions", "runtime cost evidence requires an inspectable budget ledger");
  }
  const attempt = budget.attempt(attemptId), snapshot = budget.snapshot();
  const accepted = await observer({ attempt_id: attempt.id,
    budget_ref: `sha256:${createHash("sha256").update(snapshot.budgetId).digest("hex")}`,
    status: attempt.status, currency: snapshot.currency,
    reserved_micros: String(attempt.reservedMicros), cost_micros: attempt.costMicros === null ? null : String(attempt.costMicros),
    tariff_id: attempt.tariffId, tariff_date: attempt.tariffDate });
  if (accepted === false) costFail("ProviderRequestAborted", "provider invocation is no longer active");
}
