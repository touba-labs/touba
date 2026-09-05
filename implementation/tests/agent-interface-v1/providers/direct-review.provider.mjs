export default function decide(request) {
  if (request.agent_ref !== "agent:examples.agent_interface/Reviewer") {
    throw new Error(`unexpected agent ${request.agent_ref}`);
  }
  if (request.inputs?.request?.summary !== "Review fixture") {
    throw new Error("the provider did not receive the declared agent input");
  }
  return {
    action: "answer_directly",
    source: "fixture_provider",
    result: { verdict: "approved" },
  };
}
