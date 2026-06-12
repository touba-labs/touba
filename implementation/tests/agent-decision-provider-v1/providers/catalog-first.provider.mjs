export function decideAgentCapability(request) {
  if (request.protocol !== "touba-agent-decision-v1") {
    throw new Error(`unexpected protocol ${request.protocol}`);
  }
  if (request.mode === "summary") {
    if (request.capabilities !== null) {
      throw new Error("summary request must not include the full capability catalog");
    }
    if (request.observations?.length > 0) {
      return {
        action: "answer_directly",
        reason: "capability result observed",
        result: request.observations[0].value,
      };
    }
    return {
      action: "request_capabilities",
      reason: "need capability contracts before selection",
    };
  }
  if (request.mode !== "capabilities") {
    throw new Error(`unexpected mode ${request.mode}`);
  }
  if (!Array.isArray(request.capabilities) || request.capabilities.length !== 2) {
    throw new Error("capabilities request must include the authorized catalog");
  }
  return {
    target_ref: "skill:examples.agent_decision_provider_v1/BuildBrief",
    reason: "BuildBrief accepts the research request and returns a bounded text brief.",
    arguments: {
      request: request.inputs.request,
    },
  };
}
