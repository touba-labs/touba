import { isDeepStrictEqual } from "node:util";
const answer = result => ({ action: "answer_directly", source: "custom_provider",
  reason: "The declared deterministic business rule has produced the typed result.", result });
export function decideAgentCapability(request) {
  if (request.agent_ref === "agent:examples.incident_remediation/TriageAgent") {
    const incident = request.inputs.request;
    if (!incident.service.trim() || incident.urgency < 1 || incident.urgency > 5)
      throw new Error("Service and urgency between one and five are required.");
    return answer({ service: incident.service, priority: incident.urgency >= 4 ? "high" : "normal" });
  }
  if (request.agent_ref === "agent:examples.incident_remediation/PlanningAgent") {
    const assessment = request.inputs.assessment;
    return answer({ service: assessment.service,
      action: assessment.priority === "high" ? "Review immediately with the on-call engineer" : "Schedule a diagnostic review" });
  }
  if (request.agent_ref !== "agent:examples.incident_remediation/ExecutionAgent") throw new Error("Unknown agent");
  const target = "tool:examples.incident_remediation/RecordRemediation";
  const args = { plan: request.inputs.plan };
  const observed = request.observations?.findLast(item => item.target_ref === target
    && isDeepStrictEqual(item.arguments, args) && typeof item.value?.receipt === "string");
  if (observed) return answer(observed.value);
  if (request.mode === "finalization") return { action: "cannot_complete", source: "custom_provider",
    reason: "No acquired ledger receipt is available within the execution budget." };
  if (request.mode === "summary") return { action: "request_capabilities", source: "custom_provider",
    reason: "The approved plan requires the authorized ledger write." };
  if (!request.capability_refs.includes(target)) throw new Error("Ledger capability unavailable");
  return { target_ref: target, arguments: args, source: "custom_provider",
    reason: "Record the approved plan and obtain its actual receipt." };
}
