// @ts-check

import {
  RuntimeCancelled,
  RuntimeFailure,
  RuntimeStop,
} from "./runtime-errors.mjs";
import { validateTraceMachineContract } from "../../../contracts/machine/contracts.mjs";

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
  let result;
  try {
    operations.initializeRunControls(context);
    result = await execute();
  } catch (error) {
    if (error instanceof RuntimeStop) {
      status = "stopped";
    } else if (error instanceof RuntimeCancelled) {
      status = "cancelled";
      operations.traceRunCancelled(context, error.details);
    } else if (error instanceof RuntimeFailure) {
      status = "failure";
      operations.traceUnhandledRuntimeFailure(context, error);
    } else {
      throw error;
    }
  }

  trace.push("run_completed", {
    payload: { status },
  });

  const traceDocument = trace.document();
  validateTraceMachineContract(traceDocument);
  /** @type {{status: string, result: unknown, trace: unknown, checkpoint?: unknown}} */
  const response = {
    status,
    result,
    trace: traceDocument,
  };
  if (context.pendingHumanApprovalCheckpoint) {
    response.checkpoint = context.pendingHumanApprovalCheckpoint;
  }
  return response;
}
