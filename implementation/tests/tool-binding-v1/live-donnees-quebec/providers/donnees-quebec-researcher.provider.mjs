import { createOpenAiDecisionProvider } from "../../../../runtime/touba-handler-sdk/src/index.mjs";

export const provider_metadata = Object.freeze({
  provider_kind: "sdk_ai",
  provider_name: "donnees-quebec-researcher",
  provider_version: "1.0.0",
  model_family: "openai",
  prompt_template_id: "donnees-quebec-researcher-v1",
  decision_schema_version: "touba-agent-decision-v1",
});

export function createDonneesQuebecDecisionProvider(options = {}) {
  const llmDecisionProvider = createOpenAiDecisionProvider({
    ...options,
    source: "openai_structured_output",
    model: options.model ?? ((request) =>
      request.inputs?.request?.llm_model
      ?? process.env.TOUBA_OPENAI_MODEL
      ?? "gpt-4.1-nano"),
  });

  return async function decideAgentCapability(request) {
    assertToubaDecisionRequest(request);

    if (isDryRunRequest(request)) {
      return dryRunDecision(request);
    }

    return llmDecisionProvider(request);
  };
}

export const decideAgentCapability = createDonneesQuebecDecisionProvider();

function assertToubaDecisionRequest(request) {
  if (request?.protocol !== "touba-agent-decision-v1") {
    throw new Error(`unexpected protocol ${request?.protocol}`);
  }
  if (request.agent_ref !== "agent:examples.donnees_quebec_agent_live/Researcher") {
    throw new Error(`unexpected agent_ref ${request.agent_ref}`);
  }
  if (!["summary", "capabilities", "finalization"].includes(request.mode)) {
    throw new Error(`unexpected decision mode ${request.mode}`);
  }
  if (request.model_input?.protocol !== "touba-agent-model-input-v1") {
    throw new Error("missing touba-agent-model-input-v1 payload");
  }
}

function isDryRunRequest(request) {
  return request.inputs?.request?.dry_run === true;
}

function dryRunDecision(request) {
  if (request.mode === "summary" || request.mode === "finalization") {
    const lastObservation = request.observations?.findLast((item) => item.target_ref === "skill:examples.donnees_quebec_agent_live/BuildDatasetBrief" && item.value?.query === request.inputs.request.query && typeof item.value?.summary === "string");
    if (lastObservation) {
      return {
        action: "answer_directly",
        source: "fixture_dry_run",
        reason: "The matching requested brief is available in the runtime observation.",
        result: lastObservation.value?.summary ?? lastObservation.value,
      };
    }
    if (request.mode === "finalization") return { action: "cannot_complete", reason: "The requested brief is not available." };
    return {
      action: "request_capabilities",
      reason: "dry-run fixture: catalog required before selecting",
    };
  }
  const briefCapability = request.capabilities?.find(
    (capability) => capability.target_ref === "skill:examples.donnees_quebec_agent_live/BuildDatasetBrief",
  );
  if (!briefCapability) {
    throw new Error("BuildDatasetBrief capability is absent from authorized catalog");
  }
  return {
    target_ref: briefCapability.target_ref,
    source: "fixture_dry_run",
    reason: "dry-run fixture selects the brief skill without calling a model",
    arguments: {
      request: request.inputs.request,
    },
  };
}
