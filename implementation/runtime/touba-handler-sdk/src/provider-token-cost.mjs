import { costFail, validMicros, validateCostQuote } from "./provider-cost-contract.mjs";

const protocols = new Set(["openai-responses", "openai-chat", "anthropic-messages", "google-generate-content"]);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const count = value => {
  if (!Number.isSafeInteger(value) || value < 0) costFail("ProviderCostUsageInvalid", "token counts must be non-negative safe integers");
  return BigInt(value);
};
const boundFail = () => costFail("ProviderCostBoundUnavailable", "request is outside the configured token tariff contract");
const usageFail = () => costFail("ProviderCostUsageInvalid", "provider usage is incomplete or outside the configured tariff contract");
const ceilMicros = amount => (amount + 999999n) / 1000000n;
const fields = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));

/** Host tariff, never model-generated prices. inputTokenBound must justify an
 * upper bound on the COMPLETE request, not an approximate tokenizer count.
 * This adapter deliberately refuses remotely executed tools and non-token fees.
 */
export function createProviderTokenCostAdapter({ protocol, model, tariff, inputTokenBound,
  maxBodyBytes = 8388608 } = {}) {
  if (!protocols.has(protocol) || typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(model)
      || typeof inputTokenBound !== "function" || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1
      || !plain(tariff) || !plain(tariff.rates)) {
    costFail("InvalidProviderBudgetOptions", "a protocol, exact model, host tariff and input token upper-bound callback are required");
  }
  const rates = Object.freeze({ ...tariff.rates });
  if (!validMicros(rates.input) || !validMicros(rates.output)
      || Object.keys(rates).some(key => !["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"].includes(key))
      || Object.values(rates).some(value => !validMicros(value))) {
    costFail("InvalidProviderBudgetOptions", "tariff rates must be integer micro-units per million tokens");
  }
  const base = validateCostQuote({ basis: "upper_bound", maxCostMicros: 0n,
    currency: tariff.currency, tariffId: tariff.id, tariffDate: tariff.date }, tariff.currency);
  async function json(message) {
    // Bound the read, including chunked bodies without Content-Length.
    const reader = message.body?.getReader();
    if (!reader) boundFail();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBodyBytes) { void reader.cancel().catch(() => {}); boundFail(); }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { reader.releaseLock(); }
  }
  const rate = (key, tokens) => {
    if (tokens === 0n) return 0n;
    if (!validMicros(rates[key])) usageFail();
    return rates[key] * tokens;
  };
  return Object.freeze({
    async quote(request) {
      if (request.method !== "POST") boundFail();
      const url = new URL(request.url), body = await json(request.clone());
      const output = validateRequest(protocol, model, url, body, rates);
      const input = await inputTokenBound(request.clone());
      if (!plain(input) || input.basis !== "upper_bound" || !Number.isSafeInteger(input.tokens) || input.tokens < 0) boundFail();
      // At reservation time cache hits are uncertain. Reserve the most
      // expensive declared input category, never the anticipated cache hit.
      const highestInputRate = [rates.input, rates.cacheRead, rates.cacheWrite5m, rates.cacheWrite1h]
        .filter(value => value !== undefined).reduce((a, b) => a > b ? a : b);
      return { ...base, maxCostMicros: ceilMicros(BigInt(input.tokens) * highestInputRate + output * rates.output) };
    },
    async readUsage(response, quote) {
      if (!response.ok) return { kind: "unknown" };
      if (quote.currency !== base.currency || quote.tariffId !== base.tariffId || quote.tariffDate !== base.tariffDate) usageFail();
      const body = await json(response);
      const usage = protocol === "google-generate-content" ? body.usageMetadata : body.usage;
      if (!plain(usage)) usageFail();
      let input, output, cached = 0n, written5 = 0n, written1 = 0n;
      if (protocol.startsWith("openai-")) {
        input = count(protocol === "openai-chat" ? usage.prompt_tokens : usage.input_tokens);
        output = count(protocol === "openai-chat" ? usage.completion_tokens : usage.output_tokens);
        const details = protocol === "openai-chat" ? usage.prompt_tokens_details : usage.input_tokens_details;
        cached = count(details?.cached_tokens ?? 0);
        if (cached > input || count(details?.cache_write_tokens ?? 0) !== 0n
          || count(details?.audio_tokens ?? 0) !== 0n || count(usage.output_tokens_details?.audio_tokens ?? usage.completion_tokens_details?.audio_tokens ?? 0) !== 0n) usageFail();
        if (usage.total_tokens !== undefined && count(usage.total_tokens) !== input + output) usageFail();
        if (body.service_tier != null && body.service_tier !== "default") usageFail();
        input -= cached;
      } else if (protocol === "anthropic-messages") {
        input = count(usage.input_tokens); output = count(usage.output_tokens);
        cached = count(usage.cache_read_input_tokens ?? 0);
        const created = count(usage.cache_creation_input_tokens ?? 0);
        written1 = count(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
        written5 = count(usage.cache_creation?.ephemeral_5m_input_tokens ?? 0);
        if (created !== written5 + written1) usageFail();
        if (usage.server_tool_use && Object.values(usage.server_tool_use).some(value => value !== 0)) usageFail();
        if (usage.iterations?.length || (usage.service_tier != null && usage.service_tier !== "standard")) usageFail();
      } else {
        input = count(usage.promptTokenCount);
        output = count(usage.candidatesTokenCount ?? 0) + count(usage.thoughtsTokenCount ?? 0);
        cached = count(usage.cachedContentTokenCount ?? 0);
        if (cached > input || count(usage.toolUsePromptTokenCount ?? 0) !== 0n
          || count(usage.totalTokenCount) !== input + output) usageFail();
        for (const key of ["promptTokensDetails", "cacheTokensDetails", "candidatesTokensDetails"]) {
          if (usage[key]?.some(item => item.modality !== "TEXT")) usageFail();
        }
        if (usage.serviceTier != null && usage.serviceTier !== "STANDARD") usageFail();
        input -= cached;
      }
      return { kind: "reported", costMicros: ceilMicros(rate("input", input) + rate("output", output)
        + rate("cacheRead", cached) + rate("cacheWrite5m", written5) + rate("cacheWrite1h", written1)) };
    },
  });
}

function validateRequest(protocol, model, url, body, rates) {
  if (!plain(body)) boundFail();
  let limit;
  if (protocol === "openai-responses") {
    if (!url.pathname.endsWith("/responses") || body.model !== model
      || !fields(body, ["model", "input", "instructions", "max_output_tokens", "temperature", "top_p", "text", "tools", "tool_choice",
        "parallel_tool_calls", "reasoning", "store", "stream", "metadata", "user", "safety_identifier", "service_tier", "truncation"])) boundFail();
    if (body.stream || (body.service_tier != null && body.service_tier !== "default") || body.truncation === "auto"
      || body.tools?.some(tool => tool.type !== "function") || !responseInput(body.input)) boundFail();
    limit = count(body.max_output_tokens);
  } else if (protocol === "openai-chat") {
    if (!url.pathname.endsWith("/chat/completions") || body.model !== model
      || !fields(body, ["model", "messages", "max_completion_tokens", "temperature", "top_p", "response_format", "tools", "tool_choice",
        "parallel_tool_calls", "reasoning_effort", "store", "stream", "metadata", "user", "safety_identifier", "service_tier", "n", "seed", "stop"])) boundFail();
    if (body.stream || (body.n ?? 1) !== 1 || (body.service_tier != null && body.service_tier !== "default")
      || body.tools?.some(tool => tool.type !== "function") || !Array.isArray(body.messages)
      || body.messages.some(message => typeof message.content !== "string" && message.content !== null)) boundFail();
    limit = count(body.max_completion_tokens);
  } else if (protocol === "anthropic-messages") {
    if (!url.pathname.endsWith("/messages") || body.model !== model
      || !fields(body, ["model", "messages", "system", "max_tokens", "temperature", "top_p", "top_k", "tools", "tool_choice", "thinking",
        "output_config", "stream", "metadata", "stop_sequences", "service_tier", "cache_control"])) boundFail();
    if (body.stream || (body.service_tier != null && body.service_tier !== "standard_only")
      || body.tools?.some(tool => tool.type !== undefined && tool.type !== "custom")
      || !Array.isArray(body.messages) || !anthropicContent(body.system ?? "", rates)
      || body.messages.some(message => !anthropicContent(message.content, rates))) boundFail();
    // Cache directives may also occur on tools or at the request root.
    const directives = [body, ...(body.tools ?? [])];
    for (const value of directives) validateCacheControl(value.cache_control, rates);
    limit = count(body.max_tokens);
  } else {
    if (!url.pathname.endsWith(`/models/${model}:generateContent`)
      || !fields(body, ["contents", "systemInstruction", "tools", "toolConfig", "generationConfig", "safetySettings"])) boundFail();
    const config = body.generationConfig;
    if (!fields(config, ["maxOutputTokens", "candidateCount", "temperature", "topP", "topK", "seed", "stopSequences", "responseMimeType",
      "responseSchema", "responseJsonSchema", "thinkingConfig", "responseModalities"]) || (config.candidateCount ?? 1) !== 1
      || config.responseModalities?.some(modality => modality !== "TEXT") || !Array.isArray(body.contents)
      || body.tools?.some(tool => !fields(tool, ["functionDeclarations"]))
      || [...body.contents, ...(body.systemInstruction ? [body.systemInstruction] : [])].some(content => !Array.isArray(content.parts)
        || content.parts.some(part => !fields(part, ["text", "functionCall", "functionResponse", "thought", "thoughtSignature"])))) boundFail();
    // Reserve thinking separately, conservatively, even if a model includes it
    // in maxOutputTokens. Dynamic thinking requires a justified custom adapter.
    const thinking = config.thinkingConfig;
    if (!fields(thinking ?? {}, ["thinkingBudget", "includeThoughts"]) || !Number.isSafeInteger(thinking?.thinkingBudget)
      || thinking.thinkingBudget < 0) boundFail();
    limit = count(config.maxOutputTokens) + count(thinking.thinkingBudget);
  }
  if (limit === 0n) boundFail();
  return limit;
}

function responseInput(input) {
  if (typeof input === "string") return true;
  return Array.isArray(input) && input.every(item => plain(item) && (
    (item.type === "function_call" && typeof item.arguments === "string")
    || (item.type === "function_call_output" && typeof item.output === "string")
    || (item.type === "reasoning" && Array.isArray(item.summary))
    || ((!item.type || item.type === "message") && (typeof item.content === "string"
      || (Array.isArray(item.content) && item.content.every(part => ["input_text", "output_text"].includes(part.type) && typeof part.text === "string"))))));
}

function validateCacheControl(value, rates) {
  if (value === undefined) return;
  if (!fields(value, ["type", "ttl"]) || value.type !== "ephemeral"
    || ![undefined, "5m", "1h"].includes(value.ttl) || rates.cacheRead === undefined
    || rates[value.ttl === "1h" ? "cacheWrite1h" : "cacheWrite5m"] === undefined) boundFail();
}

function anthropicContent(content, rates) {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every(part => {
    validateCacheControl(part.cache_control, rates);
    return ["text", "thinking", "redacted_thinking", "tool_use"].includes(part.type)
      || (part.type === "tool_result" && anthropicContent(part.content, rates));
  });
}
