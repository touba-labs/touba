export const AIR_SCHEMA_VERSION = "touba-air-v1";
export const AIR_CAPABILITY_PROFILE = "touba-air-capabilities-v1";
export const AIR_JSON_PROFILE = "touba-air-json-canonical-v1";
export const TRACE_PROTOCOL_VERSION = "touba-trace-v1";
export const TRACE_CAPABILITY_PROFILE = "touba-trace-capabilities-v1";

export const AIR_NODE_KINDS = Object.freeze([
  "call_function", "call_tool", "call_skill", "call_strategy", "call_agent", "parallel_call", "bind",
  "human_approval", "user_interaction", "branch", "loop", "give", "stop", "fallback",
]);
export const AIR_EDGE_ROLES = Object.freeze([
  "next", "true", "false", "loop_next", "loop_exit", "failure", "fallback", "expired",
]);
export const AIR_EXPRESSION_KINDS = Object.freeze([
  "optional_some", "optional_none", "optional_present", "optional_value",
  "enum_value",
  "value_ref", "literal_text", "literal_boolean", "literal_int", "literal_float",
  "text_conversion", "field_access", "construct_record", "unary_op", "binary_op",
]);
export const FAILURE_FAMILIES = Object.freeze([
  "business", "authority", "provider", "handler",
]);
export const TRACE_FAILURE_FAMILIES = Object.freeze([
  ...FAILURE_FAMILIES, "cancelled", "human_stop",
]);
export const TRACE_EVENT_KINDS = Object.freeze([
  "admission_refused",
  "parallel_group_admitted", "parallel_group_refused", "parallel_branch_started",
  "parallel_branch_completed", "parallel_branch_suspended", "parallel_join_completed",
  "parallel_join_failed", "parallel_group_resumed",
  "agent_capabilities_listed", "agent_capability_descriptions_diagnosed",
  "agent_capability_refused", "agent_capability_result_returned", "agent_capability_selected",
  "agent_decision_catalog_requested", "agent_decision_provider_call_attempted",
  "agent_decision_provider_retry_scheduled", "agent_decision_provider_returned",
  "provider_cost_recorded",
  "agent_decision_recorded", "agent_decision_requested", "agent_direct_answer_returned",
  "agent_human_review_requested", "agent_interface_entered", "agent_interface_refused",
  "agent_interface_result_returned", "agent_invocation_authorized", "agent_invocation_refused",
  "agent_observations_budget_refused", "agent_step_limit_exceeded", "binding_created",
  "branch_evaluated", "budget_consumed", "budget_limit_checked", "budget_limit_exceeded",
  "call_completed", "call_started", "dispatch_refused_budget_exceeded",
  "dispatch_refused_cancelled", "failure_detected", "fallback_selected",
  "human_approval_checkpoint_created", "human_approval_checkpoint_loaded",
  "human_approval_cancelled", "human_approval_decided", "human_approval_expired",
  "human_approval_pause_refused", "human_approval_paused", "human_approval_rejected",
  "human_approval_requested", "human_approval_resumed", "kill_switch_enabled",
  "loop_evaluated", "memory_access_authorized", "memory_access_refused",
  "memory_integrity_observed", "memory_integrity_refused", "memory_metadata_refused",
  "memory_provenance_observed", "run_cancel_requested",
  "run_cancelled", "run_completed", "run_started", "run_timeout_exceeded",
  "scope_entered", "scope_exited", "secret_handle_authorized", "secret_handle_refused",
  "skill_pack_activated", "skill_pack_activation_refused", "skill_pack_discovery_listed",
  "skill_pack_resource_loaded", "skill_pack_resource_refused", "tool_binding_authorized",
  "trigger_event_accepted", "trigger_event_received", "trigger_event_refused",
  "trigger_execution_completed", "trigger_execution_failed", "trigger_execution_started",
  "trigger_runner_run_started", "trigger_runner_run_completed",
  "trigger_rate_limited", "user_interaction_answered", "user_interaction_paused",
  "user_interaction_requested", "user_interaction_shown",
]);

const AIR_ROOT_FIELDS = new Set([
  "air_schema_version", "air_capability_profile", "air_json_profile", "module", "imports",
  "budgets", "definitions", "execution_graphs", "trace_points",
]);
const AIR_DEFINITION_COLLECTIONS = new Set([
  "types", "constants", "functions", "tools", "memories", "skills", "agents",
  "strategies", "triggers",
]);
const TRACE_ROOT_FIELDS = new Set([
  "trace_protocol_version", "trace_capability_profile", "run", "events",
]);
const TRACE_RUN_FIELDS = new Set([
  "run_id", "air_schema_version", "air_digest", "module_ref", "entry_ref", "admission",
]);
const TRACE_EVENT_FIELDS = new Set([
  "event_id", "run_id", "sequence_index", "kind", "air_ref", "payload", "message",
]);
const TERMINAL_STATUSES = new Set(["success", "failure", "stopped", "cancelled"]);
const PURE_FUNCTION_NODE_KINDS = new Set(["call_function", "bind", "branch", "loop", "give", "stop"]);

export class MachineContractError extends Error {
  /** @param {string} code @param {string} message @param {string} [path] */
  constructor(code, message, path = "$") {
    super(message);
    this.name = "MachineContractError";
    this.code = code;
    this.path = path;
  }
}

/** @param {unknown} value @returns {Record<string, any>} */
export function validateAirMachineContract(value) {
  const document = requireObject(value, "$", "AIR document");
  requireExact(document.air_schema_version, AIR_SCHEMA_VERSION, "$.air_schema_version");
  requireExact(document.air_capability_profile, AIR_CAPABILITY_PROFILE, "$.air_capability_profile");
  requireExact(document.air_json_profile, AIR_JSON_PROFILE, "$.air_json_profile");
  rejectUnknownFields(document, AIR_ROOT_FIELDS, "$");
  const module = requireObject(document.module, "$.module", "AIR module");
  requireString(module.id, "$.module.id");
  requireString(module.name, "$.module.name");
  const definitions = requireObject(document.definitions, "$.definitions", "AIR definitions");
  rejectUnknownFields(definitions, AIR_DEFINITION_COLLECTIONS, "$.definitions");
  const graphs = requireArray(document.execution_graphs, "$.execution_graphs");
  requireArray(document.trace_points, "$.trace_points");
  if (document.budgets !== undefined) {
    const budgets = requireObject(document.budgets, "$.budgets", "AIR budgets");
    rejectUnknownFields(budgets, new Set(["run"]), "$.budgets");
    if (budgets.run !== undefined) {
      const run = requireObject(budgets.run, "$.budgets.run", "AIR run budgets");
      rejectUnknownFields(run, new Set(["max_run_ms", "max_steps", "max_tool_calls", "max_agent_invocations", "max_provider_calls"]), "$.budgets.run");
      for (const [kind, value] of Object.entries(run)) {
        const path = `$.budgets.run.${kind}`;
        const limit = requireObject(value, path, "AIR run limit");
        rejectUnknownFields(limit, new Set(["value", "source_ref"]), path);
        if (!Number.isSafeInteger(limit.value) || limit.value <= 0) fail("AirBudgetInvalid", "run limit must be a positive safe integer", `${path}.value`);
        requireObject(limit.source_ref, `${path}.source_ref`, "run limit source reference");
      }
    }
  }

  const allIds = new Set();
  for (const [collection, items] of Object.entries(definitions)) {
    if (!Array.isArray(items)) fail("AirCollectionInvalid", `definitions.${collection} must be an array`, `$.definitions.${collection}`);
    for (let index = 0; index < items.length; index += 1) {
      registerId(items[index], allIds, `$.definitions.${collection}[${index}]`);
    }
  }
  for (let index = 0; index < graphs.length; index += 1) {
    validateGraph(graphs[index], allIds, `$.execution_graphs[${index}]`);
  }
  validateEnums(definitions, graphs);
  validateOptionals(definitions, graphs);
  validateFunctionPurity(definitions, graphs);
  validateStrategyCalls(definitions, graphs);
  const callable = new Map([...(definitions.functions ?? []), ...(definitions.tools ?? []), ...(definitions.skills ?? []),
    ...(definitions.agents ?? []), ...(definitions.strategies ?? [])].map(item => [item.id, item]));
  for (const graph of graphs) for (const node of graph.nodes) {
    if (node.kind !== "parallel_call") continue;
    const target = callable.get(node.target_ref);
    if (!/^(skill|strategy):/u.test(graph.owner_ref) || !target?.signature?.output_type
      || !Array.isArray(target.signature.inputs) || (node.arguments ?? []).length !== target.signature.inputs.length) {
      fail("InvalidParallelContract", "parallel requires a typed target and all explicit arguments in a skill or strategy");
    }
  }
  return document;
}

/** @param {Record<string, Array<Record<string, any>>>} definitions
 * @param {Array<Record<string, any>>} graphs */
function validateStrategyCalls(definitions, graphs) {
  const strategies = new Map((definitions.strategies ?? []).map(item => [item.id, item]));
  for (const [graphIndex, graph] of graphs.entries()) {
    for (const [nodeIndex, node] of graph.nodes.entries()) {
      if (node.kind !== "call_strategy") continue;
      const path = `$.execution_graphs[${graphIndex}].nodes[${nodeIndex}]`;
      const target = strategies.get(node.target_ref);
      if (!target || !target.id.startsWith("strategy:") || !target.signature?.output_type) {
        fail("AirStrategyTargetInvalid", "call_strategy must resolve to a strategy with an explicit signature", `${path}.target_ref`);
      }
      if (!Array.isArray(target.signature.inputs)
        || (node.arguments ?? []).length !== target.signature.inputs.length) {
        fail("AirStrategyArgumentsInvalid", "call_strategy requires every explicit input", `${path}.arguments`);
      }
    }
  }
}

/** @param {Record<string, Array<Record<string, any>>>} definitions
 *  @param {Array<Record<string, any>>} graphs */
function validateOptionals(definitions, graphs) {
  const knownTypes = new Set(["builtin:Text", "builtin:Boolean", "builtin:Int", "builtin:Float",
    ...(definitions.types ?? []).map(type => type.id)]);
  /** @param {unknown} type */
  const validType = type => {
    while (typeof type === "string" && /^(list|optional):/u.test(type)) type = type.slice(type.indexOf(":") + 1);
    return knownTypes.has(type);
  };
  for (const constant of definitions.constants ?? []) {
    if (typeof constant.type_ref === "string" && constant.type_ref.startsWith("optional:")) fail("AirOptionalInvalid", "module constants cannot contain optional constructors");
  }
  for (const [graphIndex, graph] of graphs.entries()) for (const [index, expression] of (graph.expressions ?? []).entries()) {
    if (typeof expression.type_ref === "string" && expression.type_ref.startsWith("optional:") && (expression.kind.startsWith("literal_") || expression.kind === "construct_record")) {
      fail("AirOptionalInvalid", "optional values require explicit constructors or typed references");
    }
    if (!expression.kind.startsWith("optional_")) continue;
    const path = `$.execution_graphs[${graphIndex}].expressions[${index}]`;
    rejectUnknownFields(expression, new Set(["id", "kind", "operands", "type_ref", "source_ref"]), path);
    const operands = expression.operands ?? [];
    const constructor = ["optional_some", "optional_none"].includes(expression.kind);
    if (!validType(expression.type_ref) || (constructor && !expression.type_ref.startsWith("optional:"))
      || (expression.kind === "optional_present" && expression.type_ref !== "builtin:Boolean")
      || !Array.isArray(operands) || operands.length !== (expression.kind === "optional_none" ? 0 : 1)
      || operands.some(handle => typeof handle !== "string" || !handle.length)) {
      fail("AirOptionalInvalid", "optional expression requires its declared type and exact operands", path);
    }
  }
}

/** @param {Record<string, Array<Record<string, any>>>} definitions
 *  @param {Array<Record<string, any>>} graphs */
function validateEnums(definitions, graphs) {
  const enums = new Map();
  for (const [index, type] of (definitions.types ?? []).entries()) {
    if (!Object.hasOwn(type, "variants")) continue;
    const path = `$.definitions.types[${index}]`;
    const variants = requireArray(type.variants, `${path}.variants`);
    if (!variants.length || requireArray(type.fields, `${path}.fields`).length) fail("AirEnumInvalid", "enum needs members and no record fields", path);
    const names = new Set();
    for (const [memberIndex, member] of variants.entries()) {
      const memberPath = `${path}.variants[${memberIndex}]`;
      requireObject(member, memberPath, "enum member");
      rejectUnknownFields(member, new Set(["name", "source_ref"]), memberPath);
      if (typeof member.name !== "string" || !/^[a-z_][A-Za-z0-9_]*$/u.test(member.name) || names.has(member.name)) fail("AirEnumInvalid", "enum members must be distinct value identifiers", memberPath);
      requireObject(member.source_ref, `${memberPath}.source_ref`, "enum source reference");
      names.add(member.name);
    }
    enums.set(type.id, names);
  }
  for (const [index, constant] of (definitions.constants ?? []).entries()) {
    if (enums.has(constant.type_ref) && (!enums.get(constant.type_ref).has(constant.literal_text)
      || ["literal_boolean", "literal_int", "literal_float"].some(key => Object.hasOwn(constant, key)))) fail("AirEnumValueInvalid", "constant must contain one declared enum member", `$.definitions.constants[${index}]`);
  }
  for (const [graphIndex, graph] of graphs.entries()) for (const [index, expression] of (graph.expressions ?? []).entries()) {
    const path = `$.execution_graphs[${graphIndex}].expressions[${index}]`;
    if (expression.kind === "enum_value") {
      rejectUnknownFields(expression, new Set(["id", "kind", "literal_text", "type_ref", "source_ref"]), path);
      if (!enums.get(expression.type_ref)?.has(expression.literal_text)) fail("AirEnumValueInvalid", "expression must name a declared enum member", path);
    } else if (["literal_text", "construct_record"].includes(expression.kind) && enums.has(expression.type_ref)) {
      fail("AirEnumValueInvalid", "enum values require an explicit enum expression", path);
    }
  }
}

// Check the entire function graph, not just the path chosen in this execution.
// Closure follows because every call_function resolves to another checked function.
/** @param {Record<string, Array<Record<string, any>>>} definitions
 *  @param {Array<Record<string, any>>} graphs */
function validateFunctionPurity(definitions, graphs) {
  const functions = new Map((definitions.functions ?? []).map(item => [item.id, item]));
  const graphById = new Map(graphs.map(item => [item.id, item]));
  for (const [index, declaration] of (definitions.functions ?? []).entries()) {
    const path = `$.definitions.functions[${index}]`;
    const graph = graphById.get(declaration.body_graph_ref);
    if (!declaration.id.startsWith("function:") || !graph || graph.owner_ref !== declaration.id) {
      fail("AirFunctionGraphInvalid", "function must reference its own executable graph", path);
    }
  }
  for (const [index, graph] of graphs.entries()) {
    const path = `$.execution_graphs[${index}]`;
    const isFunction = functions.has(graph.owner_ref);
    if (graph.owner_ref.startsWith("function:") && !isFunction) {
      fail("AirFunctionGraphInvalid", "function graph owner is unresolved", `${path}.owner_ref`);
    }
    for (const [nodeIndex, node] of graph.nodes.entries()) {
      const nodePath = `${path}.nodes[${nodeIndex}]`;
      if (isFunction && !PURE_FUNCTION_NODE_KINDS.has(node.kind)) {
        fail("AirFunctionNotPure", `function graph cannot contain ${node.kind}`, nodePath);
      }
      if (node.kind === "call_function" && !functions.has(node.target_ref)) {
        fail("AirFunctionTargetInvalid", "call_function must resolve to a declared function", `${nodePath}.target_ref`);
      }
    }
  }
}

/** @param {unknown} value @param {Set<string>} allIds @param {string} path */
function validateGraph(value, allIds, path) {
  const graph = requireObject(value, path, "AIR graph");
  registerId(graph, allIds, path);
  requireString(graph.owner_ref, `${path}.owner_ref`);
  const nodes = requireArray(graph.nodes, `${path}.nodes`);
  const nodeIds = new Set();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = requireObject(nodes[index], `${path}.nodes[${index}]`, "AIR node");
    const id = requireString(node.id, `${path}.nodes[${index}].id`);
    if (nodeIds.has(id)) fail("DuplicateAirId", `duplicate AIR node id ${id}`, `${path}.nodes[${index}].id`);
    nodeIds.add(id);
    requireEnum(node.kind, AIR_NODE_KINDS, `${path}.nodes[${index}].kind`);
    if (Object.hasOwn(node, "approval_policy")) {
      const policyPath = `${path}.nodes[${index}].approval_policy`;
      const policy = requireObject(node.approval_policy, policyPath, "approval policy");
      const label = (/** @type {unknown} */ value) => typeof value === "string" && value.trim() === value && value.length > 0
        && new TextEncoder().encode(value).length <= 128 && !/[\x00-\x1f\x7f]/u.test(value);
      if (node.kind !== "human_approval" || Object.keys(policy).length === 0
        || Object.keys(policy).some(key => !["role", "timeout_ms", "distinct_from"].includes(key))
        || (Object.hasOwn(policy, "role") && !label(policy.role))
        || (Object.hasOwn(policy, "timeout_ms") && (!Number.isSafeInteger(policy.timeout_ms) || policy.timeout_ms < 1 || policy.timeout_ms > 2592000000))
        || (Object.hasOwn(policy, "distinct_from") && !["initiator", "previous", "initiator_and_previous"].includes(policy.distinct_from))) {
        fail("InvalidHumanApprovalPolicy", "invalid static source approval constraints", policyPath);
      }
    }
    const parallelFields = ["collection_ref", "item_binding", "max_concurrency", "max_items"];
    if (node.kind === "parallel_call") {
      rejectUnknownFields(node, new Set(["id", "kind", "target_ref", "arguments", "result_binding",
        "source_ref", "trace_point_refs", ...parallelFields]), path);
      for (const field of ["target_ref", "collection_ref", "item_binding", "result_binding"]) requireString(node[field], path);
      if (!node.item_binding.startsWith("value:") || node.item_binding === node.result_binding
        || !Number.isSafeInteger(node.max_concurrency) || node.max_concurrency < 1
        || !Number.isSafeInteger(node.max_items) || node.max_items < node.max_concurrency) {
        fail("InvalidParallelContract", "parallel requires valid bounded concurrency, items and local bindings", path);
      }
      for (const argument of node.arguments ?? []) requireString(argument, path);
    } else if (parallelFields.some(field => Object.hasOwn(node, field))) {
      fail("InvalidParallelContract", "parallel fields require parallel_call", path);
    }
  }
  const entry = requireString(graph.entry_node_id, `${path}.entry_node_id`);
  if (!nodeIds.has(entry)) fail("AirReferenceUnresolved", `entry node ${entry} is absent`, `${path}.entry_node_id`);
  for (const [index, edge] of requireArray(graph.edges, `${path}.edges`).entries()) {
    const item = requireObject(edge, `${path}.edges[${index}]`, "AIR edge");
    requireNodeRef(item.from_node_id, nodeIds, `${path}.edges[${index}].from_node_id`);
    requireNodeRef(item.to_node_id, nodeIds, `${path}.edges[${index}].to_node_id`);
    requireEnum(item.role, AIR_EDGE_ROLES, `${path}.edges[${index}].role`);
    if (item.role === "expired" && nodes.find(node => node.id === item.from_node_id)?.kind !== "human_approval") {
      fail("InvalidHumanApprovalPolicy", "expired edge requires a human approval source", `${path}.edges[${index}]`);
    }
  }
  for (const [index, expression] of (graph.expressions ?? []).entries()) {
    const item = requireObject(expression, `${path}.expressions[${index}]`, "AIR expression");
    requireString(item.id, `${path}.expressions[${index}].id`);
    requireEnum(item.kind, AIR_EXPRESSION_KINDS, `${path}.expressions[${index}].kind`);
    if (item.kind === "construct_record") validateCanonicalRecordFields(item, `${path}.expressions[${index}]`);
  }
  for (const [index, failurePath] of (graph.failure_paths ?? []).entries()) {
    const item = requireObject(failurePath, `${path}.failure_paths[${index}]`, "AIR failure path");
    requireString(item.id, `${path}.failure_paths[${index}].id`);
    requireNodeRef(item.trigger_node_id, nodeIds, `${path}.failure_paths[${index}].trigger_node_id`);
    requireNodeRef(item.target_node_id, nodeIds, `${path}.failure_paths[${index}].target_node_id`);
    requireEnum(item.mode, ["fallback", "stop"], `${path}.failure_paths[${index}].mode`);
    requireEnum(item.failure_family, FAILURE_FAMILIES, `${path}.failure_paths[${index}].failure_family`);
  }
}

/** @param {Record<string, any>} expression @param {string} path */
function validateCanonicalRecordFields(expression, path) {
  requireString(expression.type_ref, `${path}.type_ref`);
  const fields = requireArray(expression.record_fields, `${path}.record_fields`);
  let previous = "";
  for (let index = 0; index < fields.length; index += 1) {
    const field = requireObject(fields[index], `${path}.record_fields[${index}]`, "record field");
    const name = requireString(field.name, `${path}.record_fields[${index}].name`);
    requireString(field.value_ref, `${path}.record_fields[${index}].value_ref`);
    if (name <= previous) fail("AirRecordFieldsNonCanonical", "record fields must be unique and lexically ordered", `${path}.record_fields`);
    previous = name;
  }
}

/** @param {unknown} value @returns {Record<string, any>} */
export function validateTraceMachineContract(value) {
  const trace = requireObject(value, "$", "trace document");
  requireExact(trace.trace_protocol_version, TRACE_PROTOCOL_VERSION, "$.trace_protocol_version");
  requireExact(trace.trace_capability_profile, TRACE_CAPABILITY_PROFILE, "$.trace_capability_profile");
  rejectUnknownFields(trace, TRACE_ROOT_FIELDS, "$");
  const run = requireObject(trace.run, "$.run", "trace run");
  rejectUnknownFields(run, TRACE_RUN_FIELDS, "$.run");
  const runId = requireString(run.run_id, "$.run.run_id");
  if (run.admission !== undefined) {
    requireExact(run.admission, "refused", "$.run.admission");
    // An admission refusal is evidence of non-execution, never a synthetic run.
    for (const key of ["air_schema_version", "air_digest", "module_ref", "entry_ref"]) {
      requireExact(run[key], null, `$.run.${key}`);
    }
    const events = requireArray(trace.events, "$.events");
    if (events.length !== 1) fail("TraceAdmissionInvalid", "admission refusal requires exactly one event", "$.events");
    const event = requireObject(events[0], "$.events[0]", "admission event");
    rejectUnknownFields(event, new Set(["event_id", "run_id", "sequence_index", "kind", "payload"]), "$.events[0]");
    requireString(event.event_id, "$.events[0].event_id");
    requireExact(event.run_id, runId, "$.events[0].run_id");
    requireExact(event.sequence_index, 0, "$.events[0].sequence_index");
    requireExact(event.kind, "admission_refused", "$.events[0].kind");
    const payload = requireObject(event.payload, "$.events[0].payload", "admission diagnostic");
    rejectUnknownFields(payload, new Set(["code", "stage"]), "$.events[0].payload");
    for (const key of ["code", "stage"]) {
      if (typeof payload[key] !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(payload[key])) {
        fail("TraceAdmissionInvalid", "admission diagnostic must be a bounded identifier", `$.events[0].payload.${key}`);
      }
    }
    return trace;
  }
  if (typeof run.air_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(run.air_digest)) {
    fail("TraceAirCommitmentInvalid", "trace requires the execution-time canonical AIR digest", "$.run.air_digest");
  }
  requireExact(run.air_schema_version, AIR_SCHEMA_VERSION, "$.run.air_schema_version");
  requireString(run.module_ref, "$.run.module_ref");
  requireString(run.entry_ref, "$.run.entry_ref");
  const events = requireArray(trace.events, "$.events");
  if (events.length < 2) fail("TraceTerminalInvalid", "trace requires start and terminal events", "$.events");
  const eventIds = new Set();
  const initialSequenceIndex = events[0]?.sequence_index;
  if (!Number.isSafeInteger(initialSequenceIndex) || initialSequenceIndex < 0) {
    fail(
      "TraceSequenceInvalid",
      "first sequence index must be a non-negative safe integer",
      "$.events[0].sequence_index",
    );
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = requireObject(events[index], `$.events[${index}]`, "trace event");
    rejectUnknownFields(event, TRACE_EVENT_FIELDS, `$.events[${index}]`);
    const eventId = requireString(event.event_id, `$.events[${index}].event_id`);
    if (eventIds.has(eventId)) fail("DuplicateTraceEventId", `duplicate trace event ${eventId}`, `$.events[${index}].event_id`);
    eventIds.add(eventId);
    requireExact(event.run_id, runId, `$.events[${index}].run_id`);
    const expectedSequenceIndex = initialSequenceIndex + index;
    if (event.sequence_index !== expectedSequenceIndex) {
      fail(
        "TraceSequenceInvalid",
        `expected contiguous sequence index ${expectedSequenceIndex}`,
        `$.events[${index}].sequence_index`,
      );
    }
    requireEnum(event.kind, TRACE_EVENT_KINDS, `$.events[${index}].kind`);
    if (event.kind === "admission_refused") fail("TraceAdmissionInvalid", "admission refusal cannot appear in an executed run", `$.events[${index}].kind`);
    rejectForbiddenTraceFields(event.payload, `$.events[${index}].payload`);
    if (event.kind === "failure_detected") {
      requireString(event.payload?.runtime_error_code, `$.events[${index}].payload.runtime_error_code`);
      requireEnum(event.payload?.failure_family, TRACE_FAILURE_FAMILIES, `$.events[${index}].payload.failure_family`);
    }
  }
  if (events[0].kind !== "run_started") fail("TraceStartInvalid", "first event must be run_started", "$.events[0].kind");
  const terminal = events.at(-1);
  if (terminal.kind !== "run_completed") fail("TraceTerminalInvalid", "last event must be run_completed", `$.events[${events.length - 1}].kind`);
  requireEnum(terminal.payload?.status, TERMINAL_STATUSES, `$.events[${events.length - 1}].payload.status`);
  requireString(terminal.payload?.reason, `$.events[${events.length - 1}].payload.reason`);
  if (events.slice(0, -1).some((event) => event.kind === "run_completed")) {
    fail("TraceTerminalInvalid", "run_completed must be unique and final", "$.events");
  }
  return trace;
}

/** @param {unknown} value @returns {string} */
export function canonicalizeMachineValue(value) {
  return JSON.stringify(canonicalValue(value));
}

/** @param {unknown} codeValue @param {unknown} [failureMode] @returns {string} */
export function failureFamilyForRuntimeCode(codeValue, failureMode = undefined) {
  const code = String(codeValue ?? "RuntimeFailure");
  if (/^HumanApproval(?:Authority|Evidence|Role|Signer|Identity|Initiator|Attestation|DecisionAlready|StateLimit|NotExpired)/u.test(code)
    || code === "InvalidHumanApprovalPolicy") return "authority";
  if (/^(InvalidParallel|ParallelContinuation|ParallelOutcome|Parallel.*LimitExceeded)/u.test(code)) return "authority";
  if (code === "RuntimeCancelled") return "cancelled";
  if (/^DecisionHistory/u.test(code) || code === "ProviderContextWindowExceeded") return "authority";
  if (code === "RuntimeStopped" || /human_approval|human_review/u.test(String(failureMode ?? ""))) {
    return "human_stop";
  }
  if (/Unauthorized|NotAllowed|NotGranted|Grant|Secret|Memory.*(?:Scope|Access|Grant)|Budget|LimitExceeded|KillSwitch|Authority|Permission|Caller/u.test(code)) {
    return "authority";
  }
  if (/Provider/u.test(code)) return "provider";
  if (/Handler|ToolBinding|ProcessProtocol/u.test(code)) return "handler";
  return "business";
}

/** @param {unknown} value @returns {any} */
function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CanonicalNumberInvalid", "canonical JSON requires finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
  }
  fail("CanonicalValueInvalid", `unsupported canonical value ${typeof value}`);
}

/** @param {unknown} value @param {string} path */
function rejectForbiddenTraceFields(value, path) {
  if (value === undefined) return;
  if (Array.isArray(value)) return value.forEach((item, index) => rejectForbiddenTraceFields(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (["secret_value", "secret_values", "raw_payload", "payload_raw"].includes(key)) {
      fail("TraceSensitiveFieldForbidden", `trace field ${key} is forbidden`, `${path}.${key}`);
    }
    rejectForbiddenTraceFields(item, `${path}.${key}`);
  }
}

/** @param {unknown} value @param {Set<string>} ids @param {string} path */
function registerId(value, ids, path) {
  const item = requireObject(value, path, "AIR item");
  const id = requireString(item.id, `${path}.id`);
  if (ids.has(id)) fail("DuplicateAirId", `duplicate AIR id ${id}`, `${path}.id`);
  ids.add(id);
}

/** @param {unknown} value @param {Set<string>} nodeIds @param {string} path */
function requireNodeRef(value, nodeIds, path) {
  const ref = requireString(value, path);
  if (!nodeIds.has(ref)) fail("AirReferenceUnresolved", `node ${ref} is absent`, path);
}

/** @param {unknown} value @param {string} path @param {string} label @returns {Record<string, any>} */
function requireObject(value, path, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MachineTypeMismatch", `${label} must be an object`, path);
  return value;
}
/** @param {unknown} value @param {string} path @returns {any[]} */
function requireArray(value, path) {
  if (!Array.isArray(value)) fail("MachineTypeMismatch", "value must be an array", path);
  return value;
}
/** @param {unknown} value @param {string} path @returns {string} */
function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") fail("MachineTypeMismatch", "value must be a non-empty string", path);
  return value;
}
/** @template T @param {unknown} value @param {T} expected @param {string} path @returns {T} */
function requireExact(value, expected, path) {
  if (value !== expected) fail("MachineVersionUnsupported", `expected ${expected}`, path);
  return /** @type {T} */ (value);
}
/** @param {unknown} value @param {readonly any[] | Set<any>} allowed @param {string} path @returns {any} */
function requireEnum(value, allowed, path) {
  const matches = allowed instanceof Set ? allowed.has(value) : allowed.includes(value);
  if (!matches) fail("MachineEnumUnknown", `expected one of ${[...allowed].join(", ")}`, path);
  return value;
}
/** @param {Record<string, any>} value @param {Set<string>} allowed @param {string} path */
function rejectUnknownFields(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail("MachineExtensionUnknown", `unknown field(s): ${unknown.join(", ")}`, path);
}
/** @returns {never} @param {string} code @param {string} message @param {string} [path] */
function fail(code, message, path = "$") {
  throw new MachineContractError(code, message, path);
}
// @ts-check
