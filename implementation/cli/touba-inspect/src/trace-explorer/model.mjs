// Shared projection. Original events remain in the canonical trace journal.
// Free-form messages, inputs, model output and credentials are not projected.
const fields = new Set([
  'code', 'stage',
  'agent_ref', 'caller_ref', 'target_ref', 'tool_ref', 'memory_ref', 'scope_ref', 'selected_ref',
  'authority_source', 'decision_source', 'action', 'operation', 'access', 'access_kind', 'mode',
  'status', 'runtime_error_code', 'failure_family', 'failure_mode', 'handler_kind',
  'group_id', 'branch_id', 'parent_branch_id', 'approval_ref', 'review_ref', 'interaction_ref',
  'step_index', 'iteration_index', 'attempt', 'attempt_index', 'timeout_ms', 'max_payload_bytes',
  'count', 'max_concurrency', 'argument_count', 'result_binding', 'resumed_from_checkpoint',
  'call_started_event_id', 'call_id', 'effect_id', 'compensation_id', 'compensates_effect_id',
  'trace_context', 'required_capabilities', 'granted_capabilities', 'missing_capabilities',
  'required_secrets', 'granted_secrets', 'missing_secrets', 'capability_refs', 'allowed_refs',
  'budget_name', 'limit', 'used', 'requested', 'remaining', 'provider_call_count', 'tool_call_count',
  'owner_ref', 'secret_handle', 'secret_handles_required', 'secret_handles_granted',
  'secret_handles_used', 'secret_handles_refused', 'memory_accesses_required', 'memory_accesses_granted',
  'required_memory_accesses', 'effect_contract_kind', 'budget', 'maximum', 'consumed',
]);
function bounded(value, depth = 0) {
  if (depth > 4) return '[omitted]';
  if (typeof value === 'string') return value.slice(0, 4096);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(v => bounded(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30)
    .filter(([key]) => ['span_id', 'parent_span_id', 'target_ref', 'call_event_id', 'agent_ref', 'agent_invocation_id', 'memory_ref', 'access'].includes(key))
    .map(([key, v]) => [key, bounded(v, depth + 1)]));
  return undefined;
}
export function projectEvent(event) {
  const payload = Object.fromEntries(Object.entries(event.payload ?? {}).filter(([key]) => fields.has(key)).map(([key, value]) => [key, bounded(value)]));
  if (/^[A-Za-z0-9_:.-]{1,120}$/u.test(event.payload?.reason ?? '')) payload.reason = event.payload.reason;
  // Flatten only explicit, bounded provider facts. Never project host paths,
  // namespace identifiers, prompt text, provider options or arbitrary metadata.
  for (const key of ['provider_kind', 'provider_name', 'model_id', 'decision_interface', 'history_storage',
    'history_max_messages', 'history_max_bytes', 'history_retained_max_bytes', 'history_summary']) {
    const value = event.payload?.provider_metadata?.[key];
    if (typeof value === 'string' && value.length <= 200) payload[key] = value;
  }
  return { event_id: event.event_id, run_id: event.run_id, sequence_index: event.sequence_index,
    kind: event.kind, ...(event.observed_at ? { observed_at: event.observed_at } : {}),
    ...(event.air_ref ? { air_ref: Object.fromEntries(Object.entries(event.air_ref)
      .filter(([key, value]) => ['flow_graph_ref', 'node_id', 'owner_ref', 'module_ref'].includes(key) && typeof value === 'string')
      .map(([key, value]) => [key, value.slice(0, 4096)])) } : {}), payload };
}
export function eventCategory(kind) {
  if (/refused|rejected|denied/u.test(kind)) return 'refusal';
  if (/failure|failed|timeout_exceeded/u.test(kind)) return 'error';
  if (/human_|approval|review/u.test(kind)) return 'human';
  if (/budget/u.test(kind)) return 'budget';
  if (/effect|compensation/u.test(kind)) return 'effect';
  if (/memory/u.test(kind)) return 'memory';
  if (/agent_|provider_|conversation/u.test(kind)) return 'agent';
  if (/tool_|call_/u.test(kind)) return 'call';
  return 'flow';
}
export function eventSummary(event) {
  const p = event.payload ?? {}, c = p.trace_context ?? {};
  return {
    sequence: event.sequence_index, id: event.event_id, kind: event.kind,
    category: eventCategory(event.kind), time: event.observed_at ?? '',
    agent: p.agent_ref ?? c.agent_ref ?? '', invocation: c.agent_invocation_id ?? p.invocation_id ?? '',
    span: c.span_id ?? '', parent: c.parent_span_id ?? '',
    scope: c.target_ref ?? '',
    resource: p.tool_ref ?? p.memory_ref ?? p.target_ref ?? p.selected_ref ?? c.target_ref ?? event.air_ref?.owner_ref ?? '',
    operation: p.operation ?? p.access_kind ?? p.access ?? p.action ?? '',
    branch: p.branch_id ?? '', source: Boolean(event.air_ref),
    status: p.status ?? '', call: c.call_event_id ?? '',
  };
}

export function queryOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('TraceQueryInvalid');
  const allowed = new Set(['search', 'agent', 'invocation', 'resource', 'branch', 'category', 'kind', 'operation', 'status', 'from', 'to', 'start', 'end', 'offset', 'limit', 'level']);
  if (Object.keys(input).some(k => !allowed.has(k))) throw new Error('TraceQueryInvalid');
  const q = {};
  for (const [key, value] of Object.entries(input)) {
    if (['start', 'end', 'offset', 'limit'].includes(key)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('TraceQueryInvalid');
      q[key] = value;
    } else {
      if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error('TraceQueryInvalid');
      if (value) q[key] = value;
    }
  }
  q.offset ??= 0; q.limit ??= 100;
  if (q.limit < 1 || q.limit > 200 || q.offset > 1000000) throw new Error('TraceQueryInvalid');
  if (q.start !== undefined && q.end !== undefined && q.start > q.end) throw new Error('TraceQueryInvalid');
  for (const key of ['from', 'to']) if (q[key] && !Number.isFinite(Date.parse(q[key]))) throw new Error('TraceQueryInvalid');
  if (q.from && q.to && Date.parse(q.from) > Date.parse(q.to)) throw new Error('TraceQueryInvalid');
  if (q.level && !['summary', 'governance', 'technical'].includes(q.level)) throw new Error('TraceQueryInvalid');
  return q;
}

export function queryWhere(q) {
  const clauses = [], values = [];
  for (const key of ['agent', 'invocation', 'resource', 'branch', 'category', 'kind', 'operation', 'status']) if (q[key]) { clauses.push(`${key} = ?`); values.push(q[key]); }
  if (q.search) { clauses.push("instr(lower(search),lower(?)) > 0"); values.push(q.search); }
  for (const [key, column, op] of [['start', 'sequence', '>='], ['end', 'sequence', '<='], ['from', 'time', '>='], ['to', 'time', '<=']]) {
    if (q[key] !== undefined) { clauses.push(`${column} ${op} ?`); values.push(['from', 'to'].includes(key) ? new Date(q[key]).toISOString() : q[key]); }
  }
  if (q.level === 'summary') clauses.push("(category IN ('refusal','error','human','effect') OR kind IN ('run_started','run_completed','call_started','call_completed','parallel_group_admitted','parallel_join_completed'))");
  if (q.level === 'governance') clauses.push("(category IN ('refusal','error','human','effect','budget','memory') OR kind IN ('tool_binding_authorized','agent_capability_selected','agent_invocation_authorized'))");
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}
