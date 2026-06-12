export function decideAgentCapability() {
  return {
    target_ref: "skill:examples.agent_decision_provider_v1/BuildBrief",
    reason: "negative fixture provides invalid arguments",
    arguments: {
      unexpected: "value",
    },
  };
}
