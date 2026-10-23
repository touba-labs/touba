import { ToubaAgentDecisionProviderError } from "./decision-contract.mjs";

// Only this pre-generation refusal may trigger history compaction. A provider
// response, HTTP failure or caller-supplied lookalike must never trigger replay.
const preflightErrors = new WeakSet();
const fail = (code, message, details) => { throw new ToubaAgentDecisionProviderError(code, message, details); };
const positive = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) fail("InvalidDecisionProviderOptions", `${name} must be a positive integer`);
  return value;
};
const pick = (body, keys) => Object.fromEntries(Object.entries(body).filter(([key]) => keys.includes(key)));

export function contextPreflightError(error) {
  const visited = new Set(), pending = [error];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || visited.has(item)) continue;
    if (preflightErrors.has(item)) return item;
    visited.add(item);
    pending.push(item.cause, item.lastError, ...(Array.isArray(item.errors) ? item.errors : []));
  }
  return null;
}

/** Wrap the HTTP transport, not abstract messages: the actual provider schema,
 * signed metadata and system instructions participate in the count. The caller
 * supplies the verified model window. No model request is sent on count failure.
 * This is a context guard, not a cost ledger or a business-memory mechanism.
 */
export function createProviderContextFetch({ provider, contextWindowTokens,
  safetyMarginTokens = 512, inputTokenMultiplier = 1.2, fetch: fetchImpl = globalThis.fetch,
  countFetch = fetchImpl, onEvent, timeoutMs = 30000 } = {}) {
  positive(contextWindowTokens, "contextWindowTokens"); positive(timeoutMs, "timeoutMs");
  if (!Number.isSafeInteger(safetyMarginTokens) || safetyMarginTokens < 0
    || !Number.isFinite(inputTokenMultiplier) || inputTokenMultiplier < 1
    || !["openai", "anthropic", "google"].includes(provider)
    || typeof fetchImpl !== "function" || typeof countFetch !== "function"
    || (onEvent !== undefined && typeof onEvent !== "function")) {
    fail("InvalidDecisionProviderOptions", "invalid provider context guard options");
  }
  return async (input, init) => {
    let body, url, headers;
    try {
      url = new URL(input instanceof Request ? input.url : input);
      headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      body = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch { fail("ProviderContextCountUnavailable", "provider request cannot be counted safely"); }
    let endpoint, payload, outputTokens;
    if (provider === "openai" && url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
      if (body.input === undefined || body.previous_response_id || body.conversation || body.truncation === "auto"
        || body.context_management) fail("ProviderContextCountUnavailable", "context guard requires explicit, untruncated Responses input");
      endpoint = new URL("/v1/responses/input_tokens", url.origin);
      payload = pick(body, ["model", "input", "instructions", "reasoning", "text", "tools", "tool_choice", "truncation", "parallel_tool_calls"]);
      outputTokens = body.max_output_tokens;
    } else if (provider === "anthropic" && url.origin === "https://api.anthropic.com" && url.pathname === "/v1/messages") {
      endpoint = new URL("/v1/messages/count_tokens", url.origin);
      // Preserve beta feature flags as well as original authentication headers.
      endpoint.search = url.search;
      payload = pick(body, ["model", "messages", "system", "tools", "tool_choice", "thinking", "output_config"]);
      outputTokens = body.max_tokens;
    } else if (provider === "google" && url.origin === "https://generativelanguage.googleapis.com"
      && /^\/v1beta\/models\/[^/]+:generateContent$/.test(url.pathname)) {
      if (body.cachedContent) fail("ProviderContextCountUnavailable", "context guard requires explicit Gemini content, without external cache state");
      endpoint = new URL(url);
      endpoint.pathname = url.pathname.replace(":generateContent", ":countTokens");
      payload = { generateContentRequest: { ...body, model: url.pathname.slice("/v1beta/".length).replace(":generateContent", "") } };
      outputTokens = body.generationConfig?.maxOutputTokens;
    } else fail("ProviderContextCountUnavailable", "unsupported endpoint for provider context counting");
    positive(outputTokens, "provider max output tokens");
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    headers.delete("accept");
    let counted, httpStatus;
    try {
      const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await countFetch(endpoint.href, { method: "POST", headers, body: JSON.stringify(payload),
        redirect: "error", signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout });
      httpStatus = response.status;
      if (!response.ok) throw new Error();
      const result = await response.json();
      counted = result.input_tokens ?? result.totalTokens;
      if (!Number.isSafeInteger(counted) || counted < 0) throw new Error();
    } catch {
      // Status is sufficient to distinguish credentials, rate limits, missing
      // models and service errors. Never echo provider bodies or auth headers.
      const status = Number.isInteger(httpStatus) ? httpStatus : undefined;
      fail("ProviderContextCountUnavailable",
        `provider input token count unavailable${status === undefined ? "" : ` (HTTP ${status})`}; generation was not sent`,
        { provider, http_status: status });
    }
    const reservedInputTokens = Math.ceil(counted * inputTokenMultiplier) + safetyMarginTokens;
    const details = { input_tokens: counted, reserved_input_tokens: reservedInputTokens,
      output_tokens: outputTokens, context_window_tokens: contextWindowTokens };
    const fits = reservedInputTokens + outputTokens <= contextWindowTokens;
    await onEvent?.({ kind: "provider_context_count", provider, ...details, fits });
    if (!fits) {
      const error = new ToubaAgentDecisionProviderError("ProviderContextWindowExceeded",
        "provider input and reserved output exceed the configured context window", details);
      preflightErrors.add(error);
      throw error;
    }
    return fetchImpl(input, init);
  };
}
