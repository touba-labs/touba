// @ts-check

import {
  RuntimeCancelled,
  RuntimeFailure,
  RuntimeStop,
} from "./runtime-errors.mjs";
import { validateTraceMachineStream } from "../../../contracts/machine/contracts.mjs";
import { assertResultHasNoResolvedSecret } from "./secret-redaction.mjs";

/**
 * Execute one public run lifecycle while preserving the runtime error classes
 * and public result envelope.
 *
 * @param {any} context
 * @param {() => Promise<unknown>} execute
 * @param {{
 *   initializeRunControls: (context: any) => void,
 *   traceRunCancelled: (context: any, details: Record<string, unknown>) => void,
 *   traceUnhandledRuntimeFailure: (context: any, error: RuntimeFailure) => void,
 *   finalizeOutcome?: (outcome: {status: string, reason: string}) => void | Promise<void>,
 * }} operations
 */
export async function executeRunLifecycle(context, execute, operations) {
  const { trace } = context;
  trace.push("run_started", {
    payload: {
      entry_ref: context.entryRef,
      max_loop_iterations: context.maxLoopIterations,
    },
  });

  let status = "success";
  let reason = "completed";
  let result;
  try {
    if (context.packageAdmission) trace.push("package_admission_verified", { payload: context.packageAdmission });
    operations.initializeRunControls(context);
    const value = await execute();
    assertResultHasNoResolvedSecret(value, context.secretStore);
    result = value;
  } catch (error) {
    if (error instanceof RuntimeStop) {
      status = "stopped";
      reason = typeof error.details.reason === "string" ? error.details.reason : "explicit_stop";
    } else if (error instanceof RuntimeCancelled) {
      status = "cancelled";
      reason = error.details.authoritySource === "timeout" ? "timeout"
        : error.details.authoritySource === "kill_switch" ? "kill_switch" : "cancelled";
      operations.traceRunCancelled(context, error.details);
    } else if (error instanceof RuntimeFailure) {
      status = "failure";
      reason = error.code;
      operations.traceUnhandledRuntimeFailure(context, error);
    } else {
      throw error;
    }
  }

  // Custody is durable before publishing a successful outcome or resumable wait.
  try {
    await operations.finalizeOutcome?.({ status, reason });
  } catch (error) {
    if (!(error instanceof RuntimeFailure)) throw error;
    status = "failure";
    reason = error.code;
    result = undefined;
    context.pendingHumanApprovalCheckpoint = null;
    operations.traceUnhandledRuntimeFailure(context, error);
  }

  trace.push("run_completed", {
    payload: {
      status,
      reason,
      ...(context.compensation
        ? {
          compensation_id: context.compensation.config.envelope.compensation_id,
          compensates_effect_id:
            context.compensation.config.envelope.compensates_effect_id,
          inverse_effect_id: context.compensation.lastAttempt?.inverseEffectId
            ?? context.compensation.config.inverse_effect_id,
          ...(context.compensation.outcome === null
            ? {}
            : { result: context.compensation.outcome }),
          ...(context.compensation.blockerCode === null
            ? {}
            : { blocker_code: context.compensation.blockerCode }),
        }
        : {}),
    },
  });

  const traceReader = trace.snapshot();
  validateTraceMachineStream(traceReader.header, traceReader.events());
  /** @type {{status: string, reason: string, result: unknown, messages: any[], pending_interaction?: any, pending_interactions?: any[], trace: unknown, checkpoint?: unknown}} */
  const response = trace.attach({
    status,
    reason,
    result,
    messages: context.messages,
  }, traceReader);
  if (status === "stopped" && ["user_input_pending", "human_approval_pending"].includes(reason)) {
    /** @type {{interaction_ref: string, prompt: string}[]} */
    const pending = context.pendingHumanApprovalCheckpoint?.pending_interactions
      ?? (context.pendingInteraction ? [context.pendingInteraction] : []);
    if (pending.length) {
      // Public questions only: never expose continuation state or branch journals.
      const questions = pending.map(({ interaction_ref, prompt }) => ({ interaction_ref, prompt }));
      response.pending_interactions = questions;
      if (reason === "user_input_pending") response.pending_interaction = questions[0];
    }
  }
  if (context.pendingHumanApprovalCheckpoint) {
    response.checkpoint = context.pendingHumanApprovalCheckpoint;
  }
  return response;
}
