import { costFail, validateCostQuote, validateCostUsage } from "./provider-cost-contract.mjs";
import { emitProviderCost, providerCostCorrelation } from "./provider-cost-context.mjs";

/** Install at the innermost fetch boundary, including SDK retries and any paid
 * counting requests. quote/readUsage are trusted HOST adapters, never model
 * callbacks. This wrapper neither knows tariffs nor assumes a token bound.
 */
export function createProviderCostFetch({ budget, quote, readUsage, fetch: fetchImpl = globalThis.fetch,
  usageTimeoutMs = 5000 } = {}) {
  if (typeof budget?.reserve !== "function" || typeof budget?.settle !== "function"
      || typeof quote !== "function" || typeof readUsage !== "function" || typeof fetchImpl !== "function"
      || !Number.isSafeInteger(usageTimeoutMs) || usageTimeoutMs < 1) {
    costFail("InvalidProviderBudgetOptions", "a budget, host cost adapters and a transport are required");
  }
  return async function fetchWithinProviderCostBudget(input, init) {
    let request;
    try { request = new Request(input, { ...init, redirect: "error" }); }
    catch { costFail("ProviderCostBoundUnavailable", "provider request cannot be quoted safely"); }
    if (request.signal.aborted) costFail("ProviderRequestAborted", "provider request was cancelled before reservation");
    let bound;
    try { bound = validateCostQuote(await quote(request.clone()), budget.currency); }
    catch { costFail("ProviderCostBoundUnavailable", "host adapter did not provide a valid upper cost bound"); }
    if (request.signal.aborted) costFail("ProviderRequestAborted", "provider request was cancelled before reservation");
    const attemptId = budget.reserve(bound, providerCostCorrelation());
    await emitProviderCost(budget, attemptId);
    let response;
    try { response = await fetchImpl(request); }
    catch {
      budget.settle(attemptId, { kind: "unknown" });
      await emitProviderCost(budget, attemptId);
      costFail("ProviderTransportFailed", "provider transport failed; its monetary reservation is retained");
    }
    let usage = { kind: "unknown" }, timer;
    try {
      // Streaming usage requires an adapter at stream completion. Never buffer
      // an unbounded SSE stream here; keep its reservation instead.
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        usage = validateCostUsage(await Promise.race([
          Promise.resolve().then(() => readUsage(response.clone(), bound)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("usage timeout")), usageTimeoutMs); }),
        ]));
      }
    } catch { usage = { kind: "unknown" }; }
    finally { clearTimeout(timer); }
    // validateCostUsage normalizes unknown to null; settle expects absence.
    try { budget.settle(attemptId, usage.kind === "unknown" ? { kind: "unknown" } : usage); }
    catch (error) {
      // Preserve the durable settlement error (especially a bound violation),
      // even when the invocation has timed out in the meantime.
      try { await emitProviderCost(budget, attemptId); } catch { /* primary error wins */ }
      throw error;
    }
    await emitProviderCost(budget, attemptId);
    return response;
  };
}
