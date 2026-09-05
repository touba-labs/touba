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

test("restores active agent context after a selected capability", async () => {
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
  operations.executeTarget = async (_targetRef, activeContext) => {
    assert.equal(activeContext.activeAgentRef, "agent:test/Reviewer");
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

function agentOperations(decision = undefined) {
  return {
    resolveAgentDecision: async () => decision,
    executeAgentHumanReview: () => ({ decision: "approved" }),
    assertAgentDecisionDoesNotExecuteSkillPack: () => {},
    callArgumentsForAgentDecision: () => [],
    authorizeAgentInvocationByCaller: () => {},
    executeTarget: async () => ({ ok: true }),
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
