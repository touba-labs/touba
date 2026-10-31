import assert from "node:assert/strict";
import test from "node:test";
import { projectOperationBudgets } from "../src/operation-budgets.mjs";

test("checkpoint budgets retain conservative reservations without charging them twice", () => {
  const state = { effective_limits: { max_tool_calls: 8, max_run_ms: 7000 }, active_elapsed_ms: 5000,
    budget_counters: { steps: 4, tool_calls: 3, agent_invocations: 2, provider_calls: 5 } };
  const execution = { record_kind: "execution", checkpoint: { runtime_state: state,
    pending_dispatch: { budget_reserved: { tool_calls: 1, active_ms: 3000 } } } };
  const before = structuredClone(execution);
  const budgets = projectOperationBudgets({ execution, status: "interrupted" });
  assert.deepEqual(budgets.rows.find(row => row.kind === "max_tool_calls"),
    { kind: "max_tool_calls", limit: 8, charged: 3, reserved: 1, remaining: 5 });
  assert.deepEqual(budgets.rows.find(row => row.kind === "max_run_ms"),
    { kind: "max_run_ms", limit: 7000, charged: 5000, reserved: 3000, remaining: 2000 });
  assert.equal(budgets.rows.find(row => row.kind === "max_provider_calls").remaining, null);
  assert.deepEqual(execution, before);
  const human = { record_kind: "human", checkpoint: { ...state, budget_counters: { ...state.budget_counters, tool_calls: 4 } } };
  const waiting = projectOperationBudgets({ execution, human, status: "awaiting_human" });
  assert.equal(waiting.rows[1].charged, 4);
  assert.equal(waiting.rows[1].reserved, 0);
  assert.deepEqual(projectOperationBudgets({ status: "failed" }), { status: "unavailable", source: "checkpoint", rows: [] });
});
