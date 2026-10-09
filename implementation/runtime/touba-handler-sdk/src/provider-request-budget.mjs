import { Buffer } from "node:buffer";
import { ToubaAgentDecisionProviderError } from "./decision-contract.mjs";

/** Validate only the host option; an absent option preserves the existing
 * transport. This module has no public package export. */
export function validateProviderRequestBudget(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ToubaAgentDecisionProviderError("InvalidDecisionProviderOptions", "decision provider options must be an object");
  }
  const value = options.maxProviderRequestBytes;
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new ToubaAgentDecisionProviderError("InvalidDecisionProviderOptions", "maxProviderRequestBytes must be a positive safe integer", {
      fieldName: "maxProviderRequestBytes",
    });
  }
  return value;
}

function effectiveRequestBudget(options, request) {
  const hostLimit = validateProviderRequestBudget(options);
  const runtimeLimit = options.decisionInterface === "native"
    ? request?.model_input?.skill_pack_budgets?.model_input_max_bytes
    : undefined;
  if (runtimeLimit !== undefined && runtimeLimit !== null && (!Number.isSafeInteger(runtimeLimit) || runtimeLimit <= 0)) {
    throw new ToubaAgentDecisionProviderError("InvalidAgentDecisionRequest", "runtime model-input byte budget must be a positive safe integer", {
      fieldName: "model_input.skill_pack_budgets.model_input_max_bytes",
    });
  }
  if (hostLimit === undefined) return runtimeLimit ?? undefined;
  return runtimeLimit == null ? hostLimit : Math.min(hostLimit, runtimeLimit);
}

export function providerBudgetFetch(options = {}, request) {
  const maxBytes = effectiveRequestBudget(options, request);
  if (maxBytes === undefined) return options.fetch;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ToubaAgentDecisionProviderError("InvalidDecisionProviderOptions", "fetch must be a function when a provider request budget is configured");
  }
  return async function fetchWithinProviderRequestBudget(input, init) {
    let bytes;
    try {
      const body = init?.body;
      if (typeof body === "string") bytes = Buffer.byteLength(body, "utf8");
      else if (body instanceof Uint8Array) bytes = body.byteLength;
      else if (body == null && input instanceof Request) {
        // Read a clone, never consume the Request passed to fetch. Decode-free
        // measurement includes BOM and invalid UTF-8 bytes without alteration.
        bytes = (await input.clone().arrayBuffer()).byteLength;
      } else throw new Error("unmeasurable provider request body");
    } catch {
      // No cause/message from a body reader is copied: it may contain payloads.
      throw new ToubaAgentDecisionProviderError("ProviderRequestBodyUnavailable", "provider request body cannot be measured safely");
    }
    if (bytes > maxBytes) {
      throw new ToubaAgentDecisionProviderError("ProviderRequestBudgetExceeded", "provider request body exceeds the configured byte budget", {
        max_bytes: maxBytes, actual_bytes: bytes,
      });
    }
    return fetchImpl(input, init);
  };
}
