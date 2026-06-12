export function decideAgentCapability(request) {
  if (request.protocol !== "touba-agent-decision-v1") {
    throw new Error(`unexpected protocol ${request.protocol}`);
  }

  if (request.mode === "summary") {
    if (request.observations?.length > 0) {
      return {
        action: "answer_directly",
        reason: "PostgreSQL memory operation completed.",
        result: request.observations[0].value,
      };
    }
    return {
      action: "request_capabilities",
      reason: "Need the authorized memory capability contract before selection.",
    };
  }

  if (request.mode !== "capabilities") {
    throw new Error(`unexpected provider mode ${request.mode}`);
  }
  if (!Array.isArray(request.capabilities) || request.capabilities.length !== 1) {
    throw new Error("expected one authorized memory capability");
  }
  const targetRef = request.capabilities[0].target_ref;

  return {
    target_ref: targetRef,
    reason: "The sole authorized memory skill is selected through the governed catalog.",
    arguments: {
      request: request.inputs.request,
    },
  };
}
