import test from "node:test";
import assert from "node:assert/strict";
import { createInvocationScope, snapshotInvocationValue } from "../src/invocation-scope.mjs";

function context() {
  return {
    values: new Map([["value:input", "incident"]]), valueTypes: new Map(), inputValueKeys: new Set(["value:input"]),
    callStack: [], loopState: new Map(), skillPackProjectionTraces: new Set(),
    activeAgentRef: null, activeCallerRef: null, nextCallIndex: 1,
    pendingHumanApprovalCheckpoint: null, pendingInteraction: null,
    budgetState: { counters: { toolCalls: 0 } }, runState: { cancelRequested: false },
    effectState: { externalToolDispatches: 0 }, executionDurability: { enabled: false },
  };
}

test("interleaved invocation scopes keep lexical identities private and run counters shared", async () => {
  const root = context();
  const left = createInvocationScope(root), right = createInvocationScope(root);
  const entered = [];
  await Promise.all([left, right].map(async (scope, index) => {
    scope.activeAgentRef = `agent:example/A${index}`;
    scope.activeCallerRef = `strategy:example/S${index}`;
    scope.values.set("value:local", index);
    scope.valueTypes.set("value:local", "builtin:Int");
    scope.callStack.push({ target_ref: scope.activeAgentRef });
    scope.loopState.set("loop", { index });
    scope.inputValueKeys.add(`value:private${index}`);
    scope.skillPackProjectionTraces.add(`pack:${index}`);
    entered.push(scope.nextCallIndex++);
    scope.budgetState.counters.toolCalls++;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scope.activeAgentRef, `agent:example/A${index}`);
    assert.equal(scope.values.get("value:local"), index);
    assert.equal(scope.callStack.length, 1);
    assert.equal(scope.loopState.get("loop").index, index);
    assert.equal(scope.inputValueKeys.has(`value:private${1 - index}`), false);
  }));
  assert.deepEqual(entered, [1, 2]);
  assert.equal(root.nextCallIndex, 3);
  assert.equal(root.budgetState.counters.toolCalls, 2);
  assert.equal(root.values.has("value:local"), false);
  assert.equal(root.callStack.length, 0);
  assert.equal(root.loopState.size, 0);
  assert.equal(root.activeAgentRef, null);
  assert.equal(root.activeCallerRef, null);
  assert.equal(root.skillPackProjectionTraces.size, 0);
  left.runState.cancelRequested = true;
  assert.equal(right.runState.cancelRequested, true);
});

test("nested invocation shares call allocation and publishes pending state to its run", () => {
  const root = context(), child = createInvocationScope(createInvocationScope(root));
  child.nextCallIndex++;
  child.pendingHumanApprovalCheckpoint = { approval_ref: "approval:example" };
  child.pendingInteraction = { interaction_ref: "interaction:example" };
  assert.equal(root.nextCallIndex, 2);
  assert.equal(root.pendingHumanApprovalCheckpoint.approval_ref, "approval:example");
  assert.equal(root.pendingInteraction.interaction_ref, "interaction:example");
  assert.equal(child.sharedRunRoot, root);
});

test("copied boundary values retain structure without mutable aliases", () => {
  const value = { rows: [{ tags: ["original"] }] };
  const copy = snapshotInvocationValue(value);
  copy.rows[0].tags.push("changed");
  assert.deepEqual(value, { rows: [{ tags: ["original"] }] });
  assert.throws(() => snapshotInvocationValue({ callback() {} }), { code: "InvalidInvocationValue" });
});
