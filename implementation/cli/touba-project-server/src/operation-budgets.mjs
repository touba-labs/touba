// A projection of the retained runtime checkpoint, never an admission decision.
// Reserved calls/time are already included in charged usage: do not add twice.
export function projectOperationBudgets({ execution, human, status }) {
  const record = status === "awaiting_human" ? human : execution;
  const checkpoint = record?.checkpoint;
  const state = record?.record_kind === "human" ? checkpoint : checkpoint?.runtime_state;
  if (!state) return { status: "unavailable", source: "checkpoint", rows: [] };
  const reserved = checkpoint.pending_dispatch?.budget_reserved;
  const counters = state.budget_counters;
  const definitions = [
    ["max_steps", counters.steps, 0],
    ["max_tool_calls", counters.tool_calls, reserved?.tool_calls ?? 0],
    ["max_agent_invocations", counters.agent_invocations, 0],
    ["max_provider_calls", counters.provider_calls, 0],
    ["max_run_ms", state.active_elapsed_ms, reserved?.active_ms ?? 0],
  ];
  return {
    status: "available", source: "checkpoint",
    rows: definitions.map(([kind, charged, held]) => {
      const limit = state.effective_limits[kind] ?? null;
      return { kind, limit, charged, reserved: held, remaining: limit === null ? null : Math.max(0, limit - charged) };
    }),
  };
}
