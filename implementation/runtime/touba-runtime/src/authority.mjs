// @ts-check

/**
 * @param {unknown} ref
 * @returns {string | null}
 */
export function callerKindFromRef(ref) {
  return typeof ref === "string" && ref.includes(":")
    ? ref.slice(0, ref.indexOf(":"))
    : null;
}

/**
 * Evaluate `callable_by` without producing traces or mutating runtime state.
 *
 * @param {string | null} callerRef
 * @param {{callable_by?: Array<{caller_ref?: string, caller_kind?: string}>}} agent
 * @returns {{authorized: boolean, callerKind: string | null, reason?: string}}
 */
export function evaluateAgentInvocationAuthority(callerRef, agent) {
  const callerKind = callerKindFromRef(callerRef);
  const validCallerKind = callerKind === "strategy" || callerKind === "agent";
  const authorized = validCallerKind
    && Array.isArray(agent.callable_by)
    && agent.callable_by.some((rule) =>
      rule?.caller_ref === callerRef && rule?.caller_kind === callerKind
    );

  if (authorized) {
    return { authorized: true, callerKind };
  }
  return {
    authorized: false,
    callerKind,
    reason: callerRef === null || callerRef === "" ? "missing_caller_ref"
      : validCallerKind ? "caller_not_allowed" : "invalid_caller_kind",
  };
}
