// A reviewer may continue their accepted human decision, not start a run or
// recover an interrupted effect. Source/runtime authority remains unchanged.
export function isDecisionContinuationRoute(method, pathname) {
  return method === "POST" && (pathname === "/runs/sandbox/resume"
    || /^\/interactions\/sessions\/[^/]+\/resume$/u.test(pathname));
}

export function decisionContinuationOnly(identity) {
  return identity !== null && !identity.permissions?.includes("*")
    && !identity.permissions?.includes("executions.run");
}

export function assertDecisionContinuation(identity, request, checkpoint) {
  if (!decisionContinuationOnly(identity)) return;
  const id = identity?.user?.id;
  const subject = typeof id === "string" ? (id.startsWith("user:") ? id : `user:${id}`) : null;
  const decision = checkpoint?.human_wait?.resolution?.decision;
  const signer = decision?.schema_version === "touba-human-review-decision-v1"
    ? decision.reviewed_by : decision?.decided_by;
  if (identity?.active !== true || !identity.permissions?.includes("decisions.act")
    || !subject || !request || Object.hasOwn(request, "operation_id")
    || !request.request_id || checkpoint?.record_kind !== "human"
    || request.request_id !== checkpoint.request_id
    || checkpoint.human_wait.resolution?.kind !== "decision"
    || decision?.request_id !== checkpoint.request_id || decision.run_id !== checkpoint.run_id
    || decision.user_ref !== subject || signer !== subject) {
    const error = new Error("a reviewer may only continue their own accepted human decision");
    error.code = "ToubaServeDecisionContinuationDenied";
    throw error;
  }
}
