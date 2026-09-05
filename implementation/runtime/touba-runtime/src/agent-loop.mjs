// @ts-check

import { callerKindFromRef } from "./authority.mjs";
import { payloadValueKind } from "./payload-validation.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";
import { compactPayload } from "./trace-builder.mjs";

/**
 * Run the bounded agent decision loop. Provider resolution, target dispatch
 * and nested-agent authority remain explicit operations supplied by the
 * runtime facade.
 *
 * @param {any} agent
 * @param {string[]} capabilityRefs
 * @param {any} context
 * @param {{
 *   resolveAgentDecision: (agent: any, capabilityRefs: string[], context: any, loopState: any) => Promise<any>,
 *   executeAgentHumanReview: (agent: any, decision: any, context: any, stepIndex: number, observations: any[]) => any,
 *   assertAgentDecisionDoesNotExecuteSkillPack: (decision: any, agent: any, capabilityRefs: string[], context: any, stepIndex: number) => void,
 *   callArgumentsForAgentDecision: (decision: any, context: any) => any,
 *   authorizeAgentInvocationByCaller: (callerRef: string, targetRef: string, context: any) => void,
 *   executeTarget: (targetRef: string, context: any, callArguments: any) => Promise<any>,
 *   validateAgentFinalResult: (agent: any, result: unknown, context: any) => unknown,
 * }} operations
 * @param {{observations?: any[], startStepIndex?: number}} [options]
 */
export async function runAgentDecisionLoop(
  agent,
  capabilityRefs,
  context,
  operations,
  options = {},
) {
  const observations = Array.isArray(options.observations) ? options.observations : [];
  const requestedStartStepIndex = options.startStepIndex;
  const startStepIndex = typeof requestedStartStepIndex === "number"
    && Number.isSafeInteger(requestedStartStepIndex)
    && requestedStartStepIndex >= 0
    ? requestedStartStepIndex
    : 0;

  for (let stepIndex = startStepIndex; stepIndex < context.maxAgentSteps; stepIndex += 1) {
    const loopState = { stepIndex, observations };
    const decision = await operations.resolveAgentDecision(
      agent,
      capabilityRefs,
      context,
      loopState,
    );
    if (!decision) {
      throw new RuntimeFailure(
        `agent decision required for ${agent.id}`,
        { agentRef: agent.id, allowedRefs: capabilityRefs },
        "AgentDecisionRequired",
      );
    }

    context.trace.push("agent_decision_recorded", {
      payload: compactPayload({
        agent_ref: agent.id,
        step_index: stepIndex,
        action: decision.action,
        selected_ref: decision.targetRef,
        decision_source: decision.source,
        reason: decision.reason,
        arguments_present: decision.arguments !== undefined ? true : undefined,
      }),
    });

    if (decision.action === "answer_directly") {
      operations.validateAgentFinalResult(agent, decision.result, context);
      context.trace.push("agent_direct_answer_returned", {
        payload: compactPayload({
          agent_ref: agent.id,
          step_index: stepIndex,
          decision_source: decision.source,
          reason: decision.reason,
        }),
      });
      return decision.result;
    }

    if (decision.action === "request_human_review") {
      const reviewResult = operations.executeAgentHumanReview(
        agent,
        decision,
        context,
        stepIndex,
        observations,
      );
      observations.push({
        step_index: stepIndex,
        action: "request_human_review",
        result_type: "human_review_decision",
        value: reviewResult,
      });
      continue;
    }

    operations.assertAgentDecisionDoesNotExecuteSkillPack(
      decision,
      agent,
      capabilityRefs,
      context,
      stepIndex,
    );
    if (!capabilityRefs.includes(decision.targetRef)) {
      context.trace.push("agent_capability_refused", {
        payload: {
          agent_ref: agent.id,
          step_index: stepIndex,
          selected_ref: decision.targetRef,
          allowed_refs: capabilityRefs,
          reason: "capability_not_declared_in_uses",
        },
      });
      throw new RuntimeFailure(
        `agent capability refused: ${decision.targetRef} is not declared in ${agent.id} uses`,
        {
          targetRef: decision.targetRef,
          agentRef: agent.id,
          allowedRefs: capabilityRefs,
          reason: "capability_not_declared_in_uses",
        },
        "AgentCapabilityNotAllowed",
      );
    }

    context.trace.push("agent_capability_selected", {
      payload: compactPayload({
        agent_ref: agent.id,
        step_index: stepIndex,
        selected_ref: decision.targetRef,
        authority_source: "uses",
        decision_source: decision.source,
        reason: decision.reason,
      }),
    });

    const selectedCallArguments = operations.callArgumentsForAgentDecision(decision, context);
    if (decision.targetRef.startsWith("agent:")) {
      operations.authorizeAgentInvocationByCaller(agent.id, decision.targetRef, context);
    }

    const previousAgentRef = context.activeAgentRef;
    const previousCallerRef = context.activeCallerRef;
    context.activeAgentRef = agent.id;
    context.activeCallerRef = agent.id;
    let result;
    try {
      result = await operations.executeTarget(
        decision.targetRef,
        context,
        selectedCallArguments,
      );
    } finally {
      context.activeAgentRef = previousAgentRef;
      context.activeCallerRef = previousCallerRef;
    }

    const observation = {
      step_index: stepIndex,
      action: "select_capability",
      target_ref: decision.targetRef,
      kind: callerKindFromRef(decision.targetRef),
      result_type: payloadValueKind(result),
      value: result,
    };
    observations.push(observation);
    context.trace.push("agent_capability_result_returned", {
      payload: compactPayload({
        agent_ref: agent.id,
        step_index: stepIndex,
        selected_ref: decision.targetRef,
        result_available: true,
        result_type: observation.result_type,
      }),
    });
  }

  context.trace.push("agent_step_limit_exceeded", {
    payload: {
      agent_ref: agent.id,
      max_agent_steps: context.maxAgentSteps,
    },
  });
  throw new RuntimeFailure(
    `agent step limit exceeded for ${agent.id}`,
    { agentRef: agent.id, maxAgentSteps: context.maxAgentSteps },
    "AgentStepLimitExceeded",
  );
}
