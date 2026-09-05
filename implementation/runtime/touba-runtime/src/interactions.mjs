// @ts-check

const HUMAN_APPROVAL_DECISIONS = new Set([
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

/**
 * @param {unknown} decision
 * @returns {{valid: false} | {valid: true, approved: true} | {valid: true, approved: false, terminalEvent: string}}
 */
export function classifyHumanApprovalDecision(decision) {
  if (typeof decision !== "string" || !HUMAN_APPROVAL_DECISIONS.has(decision)) {
    return { valid: false };
  }
  if (decision === "approved") {
    return { valid: true, approved: true };
  }
  return {
    valid: true,
    approved: false,
    terminalEvent: `human_approval_${decision}`,
  };
}

/**
 * @param {string} agentRef
 * @param {number} stepIndex
 */
export function agentHumanReviewApprovalRef(agentRef, stepIndex) {
  return `approval:${agentRef}:step-${stepIndex}:human-review`;
}
