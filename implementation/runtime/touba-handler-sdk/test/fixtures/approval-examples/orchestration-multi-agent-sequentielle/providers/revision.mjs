export function decideAgentCapability(request) {
  if (request.agent_ref !== "agent:agent.revision/Reviewer") throw new Error("Unexpected agent");
  const text = request.inputs.draft.text;
  const accepted = text.endsWith(" [reviewed]");
  return { action: "answer_directly", source: "custom_provider",
    reason: "The deterministic revision rule produced the next typed draft.",
    result: { text: accepted ? text : text + " [reviewed]", accepted } };
}
