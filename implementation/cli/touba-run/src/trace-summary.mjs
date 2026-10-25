// Read a fixed trace prefix. Keep only the fields needed by the public summary,
// with a separate bound for collections (approvals, refusals and source nodes).
export function buildRunSummary(result, parsed = {}, { maxBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("summary byte limit must be a positive safe integer");
  const reader = result.traceReader;
  const trace = reader?.header ?? result.trace ?? {};
  const settled = new Set(), pending = new Map(), nodes = new Set();
  const refusals = [];
  const consumed = { max_steps: 0, max_tool_calls: 0, max_provider_calls: 0 };
  let bytes = 0, toolCalls = 0, providerCalls = 0, order = 0;
  let firstObservedAt, lastObservedAt;
  let triggerRef = trace.run?.entry_ref?.startsWith("trigger:") ? trace.run.entry_ref : null;
  const reserve = value => {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (bytes + size > maxBytes) {
      throw Object.assign(new Error("run summary exceeds its byte limit; use a streaming trace export"), { code: "TraceSummaryLimitExceeded" });
    }
    bytes += size;
    return size;
  };
  for (const event of reader?.events() ?? trace.events ?? []) {
    order++;
    const payload = event.payload ?? {};
    firstObservedAt ??= event.observed_at;
    lastObservedAt = event.observed_at;
    if (triggerRef === null && typeof payload.trigger_ref === "string") triggerRef = payload.trigger_ref;
    const approvalRef = payload.approval_ref;
    if (typeof approvalRef === "string") {
      if (SETTLED_APPROVALS.has(event.kind) && !settled.has(approvalRef)) {
        const previous = pending.get(approvalRef);
        if (previous) { bytes -= previous.bytes; pending.delete(approvalRef); }
        reserve(approvalRef); settled.add(approvalRef);
      } else if (event.kind === "human_approval_paused" && !settled.has(approvalRef)) {
        const entry = { ref: approvalRef, mode: payload.mode, order };
        const size = reserve(entry);
        const item = pending.get(approvalRef) ?? { entries: [], bytes: 0 };
        item.entries.push(entry); item.bytes += size; pending.set(approvalRef, item);
      }
    }
    if (isRefusal(event.kind)) {
      const item = {
        code: textOr(payload.runtime_error_code ?? payload.reason ?? event.kind, event.kind),
        message: textOr(event.message ?? refusalMessage(event), event.kind),
        source_ref: sourceRef(event),
      };
      reserve(item); refusals.push(item);
    }
    if (event.kind === "budget_consumed" && Object.hasOwn(consumed, payload.budget_kind)
      && Number.isInteger(payload.consumed_value) && payload.consumed_value >= 0) {
      consumed[payload.budget_kind] = payload.consumed_value;
    }
    const { node_id: node, flow_graph_ref: graph } = event.air_ref ?? {};
    if (typeof node === "string" && typeof graph === "string") {
      const key = `${graph}#${node}`;
      if (!nodes.has(key)) { reserve(key); nodes.add(key); }
    }
    if (event.kind === "call_completed" && typeof payload.target_ref === "string" && payload.target_ref.startsWith("tool:")) toolCalls++;
    if (event.kind === "agent_decision_provider_call_attempted") providerCalls++;
  }
  const approvals = [...pending.values()].flatMap(item => item.entries).sort((left, right) => left.order - right.order);
  const status = runStatus(result, approvals, refusals);
  const generatedAt = new Date().toISOString();
  const runId = textOr(trace.run?.run_id, "run:unknown");
  return {
    schema_version: "touba-run-summary-v1",
    run_id: runId,
    status,
    entrypoint_ref: textOr(trace.run?.entry_ref ?? parsed.entryRef, "entry:unknown"),
    started_at: firstObservedAt ?? generatedAt,
    completed_at: ["succeeded", "failed", "cancelled", "refused", "stopped"].includes(status) ? lastObservedAt ?? generatedAt : null,
    trigger_ref: triggerRef,
    trace_ref: parsed.traceOutPath ? `file:${parsed.traceOutPath}` : `trace:${runId}`,
    approvals_pending: approvals.map(item => item.ref),
    refusals,
    budgets: {
      steps_used: Math.max(consumed.max_steps, nodes.size),
      tool_calls_used: Math.max(consumed.max_tool_calls, toolCalls),
      provider_calls_used: Math.max(consumed.max_provider_calls, providerCalls),
    },
  };
}

const SETTLED_APPROVALS = new Set([
  "human_approval_decided", "human_approval_resumed", "human_approval_rejected",
  "human_approval_expired", "human_approval_cancelled",
]);

function runStatus(result, approvals, refusals) {
  if (approvals.length) return approvals.some(item => item.mode === "agent_review") ? "review_pending" : "approval_pending";
  if (result.status === "success") return "succeeded";
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "stopped") {
    if (result.reason === "human_approval_cancelled") return "cancelled";
    if (["human_approval_rejected", "human_approval_expired"].includes(result.reason)) return "refused";
    return result.reason === "explicit_stop" ? "stopped" : "paused";
  }
  return result.status === "failure" && refusals.length ? "refused" : "failed";
}

function isRefusal(kind) {
  return kind.endsWith("_refused") || ["budget_limit_exceeded", "dispatch_refused_budget_exceeded",
    "agent_step_limit_exceeded", "trigger_rate_limited", "human_approval_rejected",
    "human_approval_expired", "human_approval_cancelled"].includes(kind);
}

function refusalMessage(event) {
  const payload = event.payload ?? {};
  if (typeof payload.reason === "string") return `${event.kind}: ${payload.reason}`;
  if (typeof payload.runtime_error_code === "string") return `${event.kind}: ${payload.runtime_error_code}`;
  return event.kind;
}

function sourceRef(event) {
  if (typeof event.air_ref === "string") return event.air_ref;
  const payload = event.payload ?? {};
  return [payload.target_ref, payload.trigger_ref, payload.approval_ref, payload.agent_ref, payload.caller_ref]
    .find(value => typeof value === "string") ?? null;
}

function textOr(value, fallback) { return typeof value === "string" && value.trim() !== "" ? value : fallback; }
