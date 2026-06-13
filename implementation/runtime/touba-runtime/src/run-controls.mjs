// @ts-check

import { RuntimeCancelled } from "./runtime-errors.mjs";
import { compactPayload } from "./trace-builder.mjs";

/**
 * @typedef {Record<string, any>} RuntimeControlContext
 * @typedef {Record<string, any>} RuntimeControlDetails
 * @typedef {() => void} RuntimeControlHook
 */

/**
 * @param {RuntimeControlContext} context
 * @param {{ initializeBudgetControls?: RuntimeControlHook }} [hooks]
 */
export function initializeRunControls(context, hooks = {}) {
  const state = context.runState;
  if (state.initialized) {
    return;
  }
  state.initialized = true;
  state.status = "running";
  hooks.initializeBudgetControls?.();

  if (state.killSwitchInitiallyEnabled) {
    context.trace.push("kill_switch_enabled", {
      payload: compactPayload({
        scope: state.killSwitchScope,
        authority_source: "host",
        reason: "kill_switch_enabled",
      }),
    });
    requestRunCancel(context, {
      authoritySource: "kill_switch",
      reason: "kill_switch_enabled",
      scope: state.killSwitchScope,
    });
  }

  if (state.initialCancelRequested) {
    requestRunCancel(context, {
      authoritySource: state.initialCancelAuthoritySource,
      reason: "cancel_requested",
      scope: state.killSwitchScope,
    });
  }
}

/**
 * @param {RuntimeControlContext} context
 * @param {{ observeRunTimeBudget?: RuntimeControlHook }} [hooks]
 */
export function assertRunCanContinue(context, hooks = {}) {
  observeRunTimeout(context);
  if (context.runState.cancelRequested) {
    throw new RuntimeCancelled("run cancellation requested", {
      authoritySource: context.runState.cancelAuthoritySource,
      reason: context.runState.cancelReason,
    });
  }
  hooks.observeRunTimeBudget?.();
}

/**
 * @param {RuntimeControlContext} context
 * @param {RuntimeControlDetails} details
 * @param {{ observeRunTimeBudget?: () => void, consumeDispatchBudget?: () => void }} [hooks]
 */
export function assertRunCanDispatch(context, details, hooks = {}) {
  observeRunTimeout(context);
  if (!context.runState.cancelRequested) {
    hooks.observeRunTimeBudget?.();
    hooks.consumeDispatchBudget?.();
    return;
  }
  context.trace.push("dispatch_refused_cancelled", {
    airRef: details.airRef,
    payload: compactPayload({
      target_ref: details.targetRef,
      reason: context.runState.cancelReason ?? "cancel_requested",
      tool_ref: details.targetRef?.startsWith("tool:") ? details.targetRef : undefined,
      caller_ref: context.activeCallerRef,
      agent_ref: context.activeAgentRef,
      trigger_ref: details.targetRef?.startsWith("trigger:") ? details.targetRef : undefined,
    }),
  });
  throw new RuntimeCancelled("dispatch refused after run cancellation", {
    targetRef: details.targetRef,
    authoritySource: context.runState.cancelAuthoritySource,
    reason: context.runState.cancelReason,
  });
}

/**
 * @param {RuntimeControlContext} context
 */
export function observeRunTimeout(context) {
  const state = context.runState;
  if (state.cancelRequested || state.timeoutExceeded || state.runTimeoutMs === null) {
    return;
  }
  const elapsedMs = state.now() - state.startedAtMs;
  if (elapsedMs < state.runTimeoutMs) {
    return;
  }
  state.timeoutExceeded = true;
  context.trace.push("run_timeout_exceeded", {
    payload: compactPayload({
      timeout_ms: state.runTimeoutMs,
      authority_source: "timeout",
      elapsed_ms: elapsedMs,
      scope: state.killSwitchScope,
      reason: "global_timeout_exceeded",
    }),
  });
  requestRunCancel(context, {
    authoritySource: "timeout",
    reason: "global_timeout_exceeded",
    scope: state.killSwitchScope,
  });
}

/**
 * @param {RuntimeControlContext} context
 * @param {RuntimeControlDetails} [details]
 */
export function requestRunCancel(context, details = {}) {
  const state = context.runState;
  if (state.cancelRequested) {
    return;
  }
  state.status = "cancel_requested";
  state.cancelRequested = true;
  state.cancelAuthoritySource = details.authoritySource ?? "host";
  state.cancelReason = details.reason ?? "cancel_requested";
  const event = context.trace.push("run_cancel_requested", {
    payload: compactPayload({
      authority_source: state.cancelAuthoritySource,
      reason: state.cancelReason,
      scope: details.scope,
      target_ref: details.targetRef,
      trigger_ref: details.triggerRef,
      caller_ref: details.callerRef,
      agent_ref: details.agentRef,
    }),
  });
  state.cancelEventId = event.event_id;
}

/**
 * @param {RuntimeControlContext} context
 * @param {RuntimeControlDetails} [details]
 */
export function traceRunCancelled(context, details = {}) {
  const state = context.runState;
  if (state.cancelCompleted) {
    return;
  }
  if (!state.cancelRequested) {
    requestRunCancel(context, {
      authoritySource: details.authoritySource ?? "host",
      reason: details.reason ?? "cancel_requested",
      scope: state.killSwitchScope,
      targetRef: details.targetRef,
      triggerRef: details.triggerRef,
    });
  }
  state.status = "cancelled";
  state.cancelCompleted = true;
  context.trace.push("run_cancelled", {
    payload: compactPayload({
      authority_source: state.cancelAuthoritySource,
      reason: state.cancelReason,
      cancel_event_id: state.cancelEventId,
    }),
  });
}
