import test from "node:test";
import assert from "node:assert/strict";

import { runAgentDecisionLoop } from "../src/agent-loop.mjs";
import {
  callerKindFromRef,
  evaluateAgentInvocationAuthority,
} from "../src/authority.mjs";
import { executeGraphTraversal } from "../src/graph-execution.mjs";
import {
  agentHumanReviewApprovalRef,
  classifyHumanApprovalDecision,
} from "../src/interactions.mjs";
import { executeRunLifecycle } from "../src/result-construction.mjs";
import {
  RuntimeFailure,
  RuntimeStop,
} from "../src/runtime-errors.mjs";
import {
  AIR_SCHEMA_VERSION,
  TRACE_CAPABILITY_PROFILE,
  TRACE_PROTOCOL_VERSION,
} from "../../../contracts/machine/contracts.mjs";

test("evaluates agent invocation authority without runtime side effects", () => {
  const agent = {
    callable_by: [{
      caller_ref: "strategy:test/Review",
      caller_kind: "strategy",
    }],
  };

  assert.equal(callerKindFromRef("strategy:test/Review"), "strategy");
  assert.deepEqual(
    evaluateAgentInvocationAuthority("strategy:test/Review", agent),
    { authorized: true, callerKind: "strategy" },
  );
  assert.deepEqual(
    evaluateAgentInvocationAuthority("agent:test/Other", agent),
    { authorized: false, callerKind: "agent", reason: "caller_not_allowed" },
  );
  assert.equal(
    evaluateAgentInvocationAuthority("skill:test/Review", agent).reason,
    "invalid_caller_kind",
  );
});

test("classifies human decisions and builds stable agent review references", () => {
  assert.deepEqual(classifyHumanApprovalDecision("approved"), {
    valid: true,
    approved: true,
  });
  assert.deepEqual(classifyHumanApprovalDecision("expired"), {
    valid: true,
    approved: false,
    terminalEvent: "human_approval_expired",
  });
  assert.deepEqual(classifyHumanApprovalDecision("maybe"), { valid: false });
  assert.equal(
    agentHumanReviewApprovalRef("agent:test/Reviewer", 2),
    "approval:agent:test/Reviewer:step-2:human-review",
  );
});

test("constructs the public run result after the preserved lifecycle", async () => {
  const events = [];
  const checkpoint = { checkpoint_schema_version: "test" };
  const context = {
    entryRef: "skill:test/Review",
    pendingHumanApprovalCheckpoint: checkpoint,
    trace: traceRecorder(events),
  };
  let initialized = false;

  const response = await executeRunLifecycle(
    context,
    async () => ({ accepted: true }),
    {
      initializeRunControls: () => { initialized = true; },
      traceRunCancelled: () => assert.fail("unexpected cancellation"),
      traceUnhandledRuntimeFailure: () => assert.fail("unexpected failure"),
    },
  );

  assert.equal(initialized, true);
  assert.equal(response.status, "success");
  assert.deepEqual(response.result, { accepted: true });
  assert.equal(response.checkpoint, checkpoint);
  assert.deepEqual(events.map((event) => event.kind), ["run_started", "run_completed"]);
});

test("classifies known runtime failures without swallowing unknown errors", async () => {
  const events = [];
  let observedCode;
  const context = {
    entryRef: "skill:test/Review",
    pendingHumanApprovalCheckpoint: null,
    trace: traceRecorder(events),
  };
  const operations = {
    initializeRunControls: () => {},
    traceRunCancelled: () => {},
    traceUnhandledRuntimeFailure: (_context, error) => { observedCode = error.code; },
  };

  const response = await executeRunLifecycle(
    context,
    async () => { throw new RuntimeFailure("broken", {}, "StableFailure"); },
    operations,
  );
  assert.equal(response.status, "failure");
  assert.equal(observedCode, "StableFailure");

  await assert.rejects(
    executeRunLifecycle(context, async () => { throw new TypeError("unknown"); }, operations),
    TypeError,
  );
});

test("traverses graph nodes in order and applies step checks before execution", async () => {
  const events = [];
  const calls = [];
  const graph = {
    id: "graph:skill:test/Review",
    owner_ref: "skill:test/Review",
    entry_node_id: "node-1",
    nodes: [
      { id: "node-1", kind: "bind" },
      { id: "node-2", kind: "give" },
    ],
  };
  const result = await executeGraphTraversal(
    graph.id,
    { trace: traceRecorder(events) },
    {
      requireGraph: () => graph,
      isDispatchNode: () => false,
      assertRunCanContinue: () => calls.push("continue"),
      consumeStepBudget: () => calls.push("budget"),
      airRefForNode: (_graph, node) => ({ node_id: node.id }),
      executeNode: async (_graph, node) => {
        calls.push(`execute:${node.id}`);
        return node.id === "node-2"
          ? { done: true, status: "success", result: "ok" }
          : { edgeRole: "next" };
      },
      nextNodeId: (_graph, nodeId) => nodeId === "node-1" ? "node-2" : undefined,
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(calls, [
    "continue", "budget", "execute:node-1",
    "continue", "budget", "execute:node-2",
  ]);
  assert.deepEqual(events.map((event) => event.kind), ["scope_entered", "scope_exited"]);
});

test("preserves graph stop semantics", async () => {
  const graph = {
    id: "graph:test",
    owner_ref: "skill:test/Stop",
    entry_node_id: "stop",
    nodes: [{ id: "stop", kind: "stop" }],
  };
  await assert.rejects(
    executeGraphTraversal(
      graph.id,
      { trace: traceRecorder([]) },
      {
        requireGraph: () => graph,
        isDispatchNode: () => false,
        assertRunCanContinue: () => {},
        consumeStepBudget: () => {},
        airRefForNode: () => ({}),
        executeNode: async () => ({ done: true, status: "stopped" }),
        nextNodeId: () => undefined,
      },
    ),
    RuntimeStop,
  );
});

test("returns a direct agent answer through the extracted bounded loop", async () => {
  const events = [];
  const context = {
    maxAgentSteps: 2,
    activeAgentRef: null,
    activeCallerRef: null,
    trace: traceRecorder(events),
  };
  const result = await runAgentDecisionLoop(
    { id: "agent:test/Reviewer" },
    ["tool:test/Lookup"],
    context,
    agentOperations({ action: "answer_directly", result: "done", source: "test" }),
  );

  assert.equal(result, "done");
  assert.deepEqual(events.map((event) => event.kind), [
    "agent_decision_recorded",
    "agent_direct_answer_returned",
  ]);
});

test("delegates selected capability execution with the caller context and pending loop state", async () => {
  const events = [];
  const context = {
    maxAgentSteps: 2,
    activeAgentRef: "agent:test/Outer",
    activeCallerRef: "strategy:test/Entry",
    trace: traceRecorder(events),
  };
  const decisions = [
    { action: "select_capability", targetRef: "tool:test/Lookup", source: "test" },
    { action: "answer_directly", result: "done", source: "test" },
  ];
  const operations = agentOperations();
  operations.resolveAgentDecision = async () => decisions.shift();
  operations.executeAgentCapability = async (agent, decision, activeContext, args, loopState) => {
    assert.equal(agent.id, "agent:test/Reviewer");
    assert.equal(decision.targetRef, "tool:test/Lookup");
    assert.equal(activeContext.activeAgentRef, "agent:test/Outer");
    assert.deepEqual(args, []);
    assert.equal(loopState.stepIndex, 0);
    assert.deepEqual(loopState.observations, []);
    return { rows: 1 };
  };

  const result = await runAgentDecisionLoop(
    { id: "agent:test/Reviewer" },
    ["tool:test/Lookup"],
    context,
    operations,
  );
  assert.equal(result, "done");
  assert.equal(context.activeAgentRef, "agent:test/Outer");
  assert.equal(context.activeCallerRef, "strategy:test/Entry");
});

test("offers one non-executable finalization decision after the last capability step", async () => {
  const events = [];
  const context = {
    maxAgentSteps: 1,
    activeAgentRef: null,
    activeCallerRef: null,
    trace: traceRecorder(events),
  };
  const decisions = [
    { action: "select_capability", targetRef: "tool:test/Measure", source: "development-fixture" },
    {
      action: "answer_directly",
      result: "measurement complete",
      source: "development-fixture",
      reason: "the final observation satisfies the goal",
    },
  ];
  const phases = [];
  const operations = agentOperations();
  operations.resolveAgentDecision = async (_agent, _refs, _context, loopState) => {
    phases.push(loopState.phase);
    return decisions.shift();
  };
  operations.executeAgentCapability = async () => ({ measured: true });

  const result = await runAgentDecisionLoop(
    { id: "agent:test/Measurer" },
    ["tool:test/Measure"],
    context,
    operations,
  );

  assert.equal(result, "measurement complete");
  assert.deepEqual(phases, ["execution", "finalization"]);
  assert.equal(events.filter((event) => event.kind === "agent_capability_selected").length, 1);
  assert.equal(events.filter((event) => event.kind === "agent_direct_answer_returned").length, 1);
  assert.equal(events.some((event) => event.kind === "agent_step_limit_exceeded"), false);
});

test("keeps the step-limit refusal when terminal observations are insufficient", async () => {
  const events = [];
  const context = {
    maxAgentSteps: 1,
    activeAgentRef: null,
    activeCallerRef: null,
    trace: traceRecorder(events),
  };
  const decisions = [
    { action: "select_capability", targetRef: "tool:test/Inspect", source: "development-fixture" },
    {
      action: "cannot_complete",
      source: "development-fixture",
      reason: "the observation is incomplete",
    },
  ];
  const operations = agentOperations();
  operations.resolveAgentDecision = async () => decisions.shift();

  await assert.rejects(
    runAgentDecisionLoop(
      { id: "agent:test/Inspector" },
      ["tool:test/Inspect"],
      context,
      operations,
    ),
    (error) => error instanceof RuntimeFailure && error.code === "AgentStepLimitExceeded",
  );

  assert.equal(events.filter((event) => event.kind === "agent_capability_selected").length, 1);
  assert.equal(events.filter((event) => event.kind === "agent_step_limit_exceeded").length, 1);
});

test("never executes a capability selected during finalization", async () => {
  const events = [];
  const executed = [];
  const context = {
    maxAgentSteps: 1,
    activeAgentRef: null,
    activeCallerRef: null,
    trace: traceRecorder(events),
  };
  const decisions = [
    { action: "select_capability", targetRef: "tool:test/Read", source: "development-fixture" },
    { action: "select_capability", targetRef: "tool:test/Write", source: "development-fixture" },
  ];
  const operations = agentOperations();
  operations.resolveAgentDecision = async () => decisions.shift();
  operations.executeAgentCapability = async (_agent, decision) => {
    executed.push(decision.targetRef);
    return { ok: true };
  };

  await assert.rejects(
    runAgentDecisionLoop(
      { id: "agent:test/Bounded" },
      ["tool:test/Read", "tool:test/Write"],
      context,
      operations,
    ),
    (error) => error instanceof RuntimeFailure && error.code === "AgentStepLimitExceeded",
  );

  assert.deepEqual(executed, ["tool:test/Read"]);
});

test("allows repeated capability dispatch until the explicit step budget is exhausted", async () => {
  const events = [];
  const executed = [];
  const context = {
    maxAgentSteps: 2,
    activeAgentRef: null,
    activeCallerRef: null,
    trace: traceRecorder(events),
  };
  const operations = agentOperations();
  operations.resolveAgentDecision = async () => ({
    action: "select_capability",
    targetRef: "tool:test/Poll",
    source: "development-fixture",
  });
  operations.executeAgentCapability = async (_agent, decision) => {
    executed.push(decision.targetRef);
    return { ok: true };
  };

  await assert.rejects(
    runAgentDecisionLoop(
      { id: "agent:test/Poller" },
      ["tool:test/Poll"],
      context,
      operations,
    ),
    (error) => error instanceof RuntimeFailure && error.code === "AgentStepLimitExceeded",
  );

  assert.deepEqual(executed, ["tool:test/Poll", "tool:test/Poll"]);
  assert.equal(events.some((event) => event.kind === "agent_capability_refused"), false);
});

function agentOperations(decision = undefined) {
  return {
    resolveAgentDecision: async () => decision,
    executeAgentHumanReview: () => ({ decision: "approved" }),
    assertAgentDecisionDoesNotExecuteSkillPack: () => {},
    callArgumentsForAgentDecision: () => [],
    argumentsForAgentObservation: () => ({}),
    authorizeAgentInvocationByCaller: () => {},
    executeAgentCapability: async () => ({ ok: true }),
    validateAgentFinalResult: (_agent, result) => result,
  };
}

function traceRecorder(events) {
  return {
    push(kind, details = {}) {
      events.push({ kind, ...details });
    },
    document() {
      const runId = "run-extracted-modules";
      return {
        trace_protocol_version: TRACE_PROTOCOL_VERSION,
        trace_capability_profile: TRACE_CAPABILITY_PROFILE,
        run: {
          run_id: runId,
          // Synthetic lifecycle recorder, not evidence from a real execution.
          air_digest: `sha256:${"0".repeat(64)}`,
          air_schema_version: AIR_SCHEMA_VERSION,
          module_ref: "module:test",
          entry_ref: "skill:test/Review",
        },
        events: events.map((event, index) => ({
          event_id: `event:${runId}:${index + 1}`,
          run_id: runId,
          sequence_index: index,
          kind: event.kind,
          ...(event.payload === undefined ? {} : { payload: event.payload }),
        })),
      };
    },
  };
}
