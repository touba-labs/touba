import { createOpenAiDecisionProvider } from "../../../runtime/touba-handler-sdk/src/index.mjs";
import { appendFileSync } from "node:fs";

export const decideAgentCapability = createOpenAiDecisionProvider({
  source: "openai_structured_output",
  model: process.env.TOUBA_OPENAI_MODEL ?? "gpt-4.1-nano",
  maxRetries: 0,
  fetch: async (url, init) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
    if (process.env.TOUBA_CYCLE_USAGE_LOG) {
      const body = await response.clone().json();
      appendFileSync(process.env.TOUBA_CYCLE_USAGE_LOG, JSON.stringify({
        model: body.model, status: body.status, http_status: response.status, usage: body.usage,
      }) + "\n");
    }
    return response;
  },
});
