// Stable process exit contract. Runtime reasons are machine values, never prose.
export function runExitCode(result) {
  if (result.status === "success") return 0;
  if (result.status === "failure") return 1;
  if (result.status === "cancelled" || result.reason === "human_approval_cancelled") return 5;
  if (result.status === "stopped") {
    return ["human_approval_pending", "user_input_pending"].includes(result.reason) ? 3 : 4;
  }
  return 1;
}

export function publicRunResult(result) {
  return {
    schema_version: "touba-run-result-v1",
    status: result.status,
    reason: result.reason,
    result: result.result ?? null,
    messages: result.messages,
    ...(result.pending_interaction ? { pending_interaction: result.pending_interaction } : {}),
    ...(result.pending_interactions?.length ? { pending_interactions: result.pending_interactions } : {}),
    trace: result.trace,
  };
}

export function validateRunResult(value) {
  const fail = () => { throw new TypeError("Invalid touba-run-result-v1 envelope"); };
  if (!value || value.schema_version !== "touba-run-result-v1") fail();
  const keys = new Set(["schema_version", "status", "reason", "result", "messages", "pending_interaction", "pending_interactions", "trace"]);
  if (Object.keys(value).some(key => !keys.has(key))) fail();
  if (!Object.hasOwn(value, "result") || !["success", "stopped", "cancelled", "failure"].includes(value.status)) fail();
  if (typeof value.reason !== "string" || value.reason.length === 0 || !Array.isArray(value.messages)) fail();
  if (value.messages.some(message => !message || typeof message.text !== "string" || typeof message.interaction_ref !== "string"
    || Object.keys(message).some(key => !["interaction_ref", "text"].includes(key)))) fail();
  const terminal = value.trace?.events?.at(-1);
  const refusedAdmission = value.trace?.run?.admission === "refused"
    && value.trace.events.length === 1 && terminal?.kind === "admission_refused"
    && terminal.payload?.code === value.reason && value.status === "failure"
    && value.result === null && value.messages.length === 0 && value.pending_interaction === undefined && value.pending_interactions === undefined;
  if (!refusedAdmission && (terminal?.kind !== "run_completed" || terminal.payload?.status !== value.status || terminal.payload?.reason !== value.reason)) fail();
  if (value.pending_interaction !== undefined) {
    const pending = value.pending_interaction;
    if (value.reason !== "user_input_pending" || typeof pending?.interaction_ref !== "string" || typeof pending.prompt !== "string"
      || Object.keys(pending).some(key => !["interaction_ref", "prompt"].includes(key))) fail();
  }
  if (value.pending_interactions !== undefined) {
    const pending = value.pending_interactions;
    if (value.status !== "stopped" || !["user_input_pending", "human_approval_pending"].includes(value.reason)
      || !Array.isArray(pending) || pending.length === 0
      || pending.some(item => !item || typeof item.interaction_ref !== "string" || typeof item.prompt !== "string"
        || Object.keys(item).some(key => !["interaction_ref", "prompt"].includes(key)))
      || new Set(pending.map(item => item.interaction_ref)).size !== pending.length) fail();
    if (value.pending_interaction && (value.pending_interaction.interaction_ref !== pending[0].interaction_ref
      || value.pending_interaction.prompt !== pending[0].prompt)) fail();
  }
  return value;
}
