import { AsyncLocalStorage } from "node:async_hooks";

// Observability only: no authority, values or executable state is held here.
// Async scopes keep concurrent branches and nested host invocations separate.
const scopes = new AsyncLocalStorage();
/** @template T
 * @param {{spanRoot?: object, allocateSpanId: () => string}} trace
 * @param {string} targetRef
 * @param {{agentInvocationId?: string | null, activeAgentRef?: string | null}} context
 * @param {() => T} callback
 * @param {string} [callEventId]
 * @returns {T}
 */
export function withTraceInvocation(trace, targetRef, context, callback, callEventId) {
  const parent = scopes.getStore();
  const identity = {
    span_id: trace.allocateSpanId(),
    target_ref: targetRef,
    ...(parent?.root === (trace.spanRoot ?? trace) ? { parent_span_id: parent.identity.span_id } : {}),
    ...(callEventId ? { call_event_id: callEventId } : {}),
  };
  return scopes.run({ root: trace.spanRoot ?? trace, identity, context }, callback);
}

/** @param {{spanRoot?: object}} trace */
export function currentTraceInvocation(trace) {
  const scope = scopes.getStore();
  if (!scope || scope.root !== (trace.spanRoot ?? trace)) return undefined;
  return {
    ...scope.identity,
    ...(scope.context.agentInvocationId ? { agent_invocation_id: scope.context.agentInvocationId } : {}),
    ...(scope.context.activeAgentRef ? { agent_ref: scope.context.activeAgentRef } : {}),
  };
}
