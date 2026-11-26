export const multiAgentSource = `module review.multi

skill Echo
    description "Return the request without an external effect."
    takes request as Text
    gives Text
    do
        give request

agent Specialist
    description "Check a request through the pure Echo capability."
    takes request as Text
    gives Text
    responsibility "Check the request using the declared pure capability."
    uses Echo
    callable_by agent Coordinator
    callable_by strategy Run
    callable_by strategy Partial

agent Coordinator
    takes request as Text
    gives Text
    responsibility "Delegate the request to the declared specialist."
    uses Specialist
    callable_by strategy Run

agent Reviewer
    takes request as Text
    gives Text
    responsibility "Return the supplied reviewed result."
    callable_by strategy Run

strategy Run
    takes request as Text
    gives Text
    uses Coordinator
    uses Specialist
    uses Reviewer
    do
        Coordinator
            with request as request
            into prepared
        parallel Specialist
            each item in [request, prepared]
            with request as item
            max_concurrency 2
            max_items 2
            into checked
        Reviewer
            with request as join(checked, ", ")
            into result
        give result

strategy Partial
    takes request as Text
    gives Text
    uses Specialist
    do
        parallel Specialist
            each item in [request, "fixture-failure"]
            with request as item
            max_concurrency 2
            max_items 2
            into checked
        give join(checked, ", ")
`;

// Scripted protocol fixture, not a model benchmark. All capabilities are pure.
export function multiAgentProvider(calls = []) {
  return async request => {
    calls.push(request);
    const observations = request.observations ?? [], value = request.inputs.request;
    if (value === "fixture-failure") {
      // Let the peer complete, then propose an invalid typed final result.
      await new Promise(resolve => setTimeout(resolve, 300));
      return { action: "answer_directly", result: 42, reason: "Exercise an invalid typed result." };
    }
    const specialist = request.agent_ref.endsWith("/Specialist"), coordinator = request.agent_ref.endsWith("/Coordinator");
    if ((specialist && observations.length < 2) || (coordinator && !observations.length)) return {
      action: "select_capability", target_ref: `${specialist ? "skill" : "agent"}:review.multi/${specialist ? "Echo" : "Specialist"}`,
      arguments: { request: value }, reason: "Exercise the declared capability." };
    return { action: "answer_directly", result: value, reason: "Return the checked request." };
  };
}
