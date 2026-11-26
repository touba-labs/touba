import { validateAirExpressions } from "./air-expressions.mjs";
import { validateTracePage } from "../trace-reference.mjs";
export { validateTraceReference } from "../trace-reference.mjs";

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
  "next", "true", "false", "loop_next", "loop_exit", "failure", "fallback", "expired", "rejected",
]);
export const AIR_EXPRESSION_KINDS = Object.freeze([
  "optional_some", "optional_none", "optional_present", "optional_value",
  "enum_value",
  "value_ref", "literal_text", "literal_boolean", "literal_int", "literal_float",
  "text_conversion", "date_conversion", "field_access", "construct_record", "copy_record", "construct_list", "list_comprehension", "list_concat", "text_join", "unary_op", "binary_op",
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
  "agent_decision_provider_model_resolved",
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
  "run_cancelled", "run_completed", "run_started", "run_timeout_exceeded", "package_admission_verified", "package_tool_admitted",
  "scope_entered", "scope_exited", "secret_handle_authorized", "secret_handle_refused",
  "skill_pack_activated", "skill_pack_activation_refused", "skill_pack_discovery_listed",
  "skill_pack_resource_loaded", "skill_pack_resource_refused", "tool_binding_authorized", "tool_execution_status", "tool_approval_authorized",
  "trigger_event_accepted", "trigger_event_received", "trigger_event_refused",
  "trigger_execution_completed", "trigger_execution_failed", "trigger_execution_started",
  "trigger_runner_run_started", "trigger_runner_run_completed",
  "trigger_rate_limited", "user_interaction_answered", "user_interaction_paused",
  "user_interaction_requested", "user_interaction_shown",
]);

const AIR_ROOT_FIELDS = new Set([
  "air_schema_version", "air_capability_profile", "air_json_profile", "module", "imports",
  "budgets", "definitions", "execution_graphs", "trace_points", "required_features",
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
  "pure_function_detail", "segment_id",
]);
const TRACE_EVENT_FIELDS = new Set([
  "event_id", "run_id", "sequence_index", "kind", "air_ref", "payload", "message", "observed_at",
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
  const features = document.required_features === undefined ? [] : requireArray(document.required_features, "$.required_features");
  if (new Set(features).size !== features.length || features.some(feature => feature !== "tool_operation_approval")) {
    fail("AirFeatureUnsupported", "this runtime does not implement a required AIR feature", "$.required_features");
  }
  for (const item of definitions.tools === undefined ? [] : requireArray(definitions.tools, "$.definitions.tools")) {
    const tool = requireObject(item, "$.definitions.tools[]", "AIR tool");
    if (Object.hasOwn(tool, "approval_policy")) {
      if (!features.includes("tool_operation_approval")) fail("AirFeatureRequired", "tool approval requires an explicit runtime feature", "$.required_features");
      validateSourceApprovalPolicy(tool.approval_policy, `$.definitions.tools.${tool.id}.approval_policy`, true);
    }
  }
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
  validateAirExpressions(document, fail);
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
  const knownTypes = new Set(["builtin:Text", "builtin:Boolean", "builtin:Int", "builtin:Float", "builtin:Date", "builtin:Approval",
    ...(definitions.types ?? []).map(type => type.id)]);
  /** @param {unknown} type */
  const validType = type => {
    while (typeof type === "string" && /^(list|optional):/u.test(type)) type = type.slice(type.indexOf(":") + 1);
    return knownTypes.has(type);
  };
  for (const type of definitions.types ?? []) for (const field of type.fields ?? []) {
    if (Object.hasOwn(field, "constraints") && !validFieldConstraints(field.type_ref, field.constraints)) {
      fail("AirFieldConstraintInvalid", "field constraints must be compatible, bounded and noncontradictory");
    }
    if (Object.hasOwn(field, "default") && (!validType(field.type_ref) || !validFieldDefault(field.default, field.type_ref, field.constraints))) {
      fail("AirFieldDefaultInvalid", "field default must satisfy its type and constraints");
    }
  }
  for (const constant of definitions.constants ?? []) {
    if (typeof constant.type_ref === "string" && constant.type_ref.startsWith("optional:")) fail("AirOptionalInvalid", "module constants cannot contain optional constructors");
    if (constant.type_ref === "builtin:Date" && (!isIsoDate(constant.literal_text)
      || ["literal_boolean", "literal_int", "literal_float"].some(key => Object.hasOwn(constant, key)))) {
      fail("AirDateInvalid", "Date constant requires one valid YYYY-MM-DD civil date");
    }
  }
  for (const [graphIndex, graph] of graphs.entries()) for (const [index, expression] of (graph.expressions ?? []).entries()) {
    if (expression.kind === "date_conversion") {
      const path = `$.execution_graphs[${graphIndex}].expressions[${index}]`;
      rejectUnknownFields(expression, new Set(["id", "kind", "operands", "type_ref", "source_ref"]), path);
      if (expression.type_ref !== "builtin:Date" || !Array.isArray(expression.operands)
        || expression.operands.length !== 1 || typeof expression.operands[0] !== "string" || !expression.operands[0]) {
        fail("AirDateInvalid", "date conversion requires one Text operand and Date result", path);
      }
    }
    if (expression.kind === "construct_list") {
      const path = `$.execution_graphs[${graphIndex}].expressions[${index}]`;
      rejectUnknownFields(expression, new Set(["id", "kind", "operands", "type_ref", "source_ref"]), path);
      if (!validType(expression.type_ref) || !expression.type_ref.startsWith("list:")
        || !Array.isArray(expression.operands ?? [])
        || (expression.operands ?? []).some(/** @param {unknown} handle */ handle => typeof handle !== "string" || !handle.length)) {
        fail("AirListInvalid", "list expression requires a known list type and ordered operands", path);
      }
    }
    if (["list_comprehension", "list_concat", "text_join"].includes(expression.kind)) {
      const path = `$.execution_graphs[${graphIndex}].expressions[${index}]`;
      const comprehension = expression.kind === "list_comprehension";
      rejectUnknownFields(expression, new Set(["id", "kind", "operands", "type_ref", "source_ref", ...(comprehension ? ["value_ref"] : [])]), path);
      if (!validType(expression.type_ref) || (expression.kind === "text_join" ? expression.type_ref !== "builtin:Text" : !expression.type_ref.startsWith("list:"))
        || !Array.isArray(expression.operands) || !(comprehension ? [2, 3] : [2]).includes(expression.operands.length)
        || expression.operands.some(/** @param {unknown} handle */ handle => typeof handle !== "string" || !handle.length)
        || comprehension && (typeof expression.value_ref !== "string" || !/^value:[a-z_][A-Za-z0-9_]*$/u.test(expression.value_ref))) {
        fail("AirListInvalid", "list operation requires a known result type, exact operands and a local comprehension binding", path);
      }
    }
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

/** @param {unknown} value @param {string} path @param {boolean} [allowEmpty] */
function validateSourceApprovalPolicy(value, path, allowEmpty = false) {
  const policy = requireObject(value, path, "approval policy");
  /** @param {unknown} value */
  const label = value => typeof value === "string" && value.trim() === value && value.length > 0
    && new TextEncoder().encode(value).length <= 128 && !/[\x00-\x1f\x7f]/u.test(value);
  if ((!allowEmpty && Object.keys(policy).length === 0)
    || Object.keys(policy).some(key => !["role", "timeout_ms", "distinct_from", "exclude_signers"].includes(key))
    || (Object.hasOwn(policy, "role") && !label(policy.role))
    || (Object.hasOwn(policy, "exclude_signers") && !label(policy.exclude_signers))
    || (Object.hasOwn(policy, "timeout_ms") && (!Number.isSafeInteger(policy.timeout_ms) || policy.timeout_ms < 1 || policy.timeout_ms > 2592000000))
    || (Object.hasOwn(policy, "distinct_from") && !["initiator", "previous", "initiator_and_previous"].includes(policy.distinct_from))) {
    fail("InvalidHumanApprovalPolicy", "invalid static source approval constraints", path);
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
      if (node.kind !== "human_approval") fail("InvalidHumanApprovalPolicy", "approval policy requires a human approval node", policyPath);
      validateSourceApprovalPolicy(node.approval_policy, policyPath);
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
    if (["expired", "rejected"].includes(item.role) && nodes.find(node => node.id === item.from_node_id)?.kind !== "human_approval") {
      fail("InvalidHumanApprovalPolicy", "approval outcome edge requires a human approval source", `${path}.edges[${index}]`);
    }
  }
  for (const [index, expression] of (graph.expressions ?? []).entries()) {
    const item = requireObject(expression, `${path}.expressions[${index}]`, "AIR expression");
    requireString(item.id, `${path}.expressions[${index}].id`);
    requireEnum(item.kind, AIR_EXPRESSION_KINDS, `${path}.expressions[${index}].kind`);
    if (["construct_record", "copy_record"].includes(item.kind)) validateCanonicalRecordFields(item, `${path}.expressions[${index}]`);
    if (item.kind === "copy_record" && (!Array.isArray(item.operands) || item.operands.length !== 1 || typeof item.operands[0] !== "string")) {
      fail("AirRecordCopyInvalid", "record copy requires one typed base operand", `${path}.expressions[${index}]`);
    }
  }
  validateApprovalOutcomeBranches(graph, path);
  for (const [index, failurePath] of (graph.failure_paths ?? []).entries()) {
    const item = requireObject(failurePath, `${path}.failure_paths[${index}]`, "AIR failure path");
    requireString(item.id, `${path}.failure_paths[${index}].id`);
    requireNodeRef(item.trigger_node_id, nodeIds, `${path}.failure_paths[${index}].trigger_node_id`);
    requireNodeRef(item.target_node_id, nodeIds, `${path}.failure_paths[${index}].target_node_id`);
    requireEnum(item.mode, ["fallback", "stop"], `${path}.failure_paths[${index}].mode`);
    requireEnum(item.failure_family, FAILURE_FAMILIES, `${path}.failure_paths[${index}].failure_family`);
  }
}

/** Refusal/expiry cannot be forged into an approved continuation in direct AIR.
 * @param {any} graph @param {string} path */
function validateApprovalOutcomeBranches(graph, path) {
  const byId = new Map(graph.nodes.map(/** @param {any} node */ node => [node.id, node]));
  const outgoing = /** @type {Map<string, any[]>} */ (new Map());
  for (const edge of graph.edges) outgoing.set(edge.from_node_id, [...(outgoing.get(edge.from_node_id) ?? []), edge]);
  const reachable = /** @param {string[]} starts */ starts => {
    const seen = new Set();
    const queue = [...starts];
    while (queue.length) {
      const id = queue.pop();
      if (id === undefined) break;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of outgoing.get(id) ?? []) queue.push(edge.to_node_id);
    }
    return seen;
  };
  for (const node of graph.nodes) if (node.kind === "human_approval") {
    const edges = outgoing.get(node.id) ?? [];
    const approved = reachable(edges.filter(edge => !["expired", "rejected"].includes(edge.role)).map(edge => edge.to_node_id));
    for (const role of ["expired", "rejected"]) {
      const outcomes = edges.filter(edge => edge.role === role);
      if (outcomes.length > 1) fail("InvalidHumanApprovalOutcome", "approval has duplicate outcome branches", path);
      for (const target of reachable(outcomes.map(edge => edge.to_node_id))) {
        if (approved.has(target) || target === node.id || (!(outgoing.get(target)?.length) && !["give", "stop"].includes(byId.get(target)?.kind))) {
          fail("InvalidHumanApprovalOutcome", "approval outcome must terminate without joining the protected continuation", path);
        }
      }
    }
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
function validateTraceHeader(value) {
  const trace = requireObject(value, "$", "trace document");
  requireExact(trace.trace_protocol_version, TRACE_PROTOCOL_VERSION, "$.trace_protocol_version");
  requireExact(trace.trace_capability_profile, TRACE_CAPABILITY_PROFILE, "$.trace_capability_profile");
  rejectUnknownFields(trace, TRACE_ROOT_FIELDS, "$");
  const run = requireObject(trace.run, "$.run", "trace run");
  rejectUnknownFields(run, TRACE_RUN_FIELDS, "$.run");
  if (run.segment_id !== undefined && (typeof run.segment_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(run.segment_id))) {
    fail("TraceSegmentInvalid", "segment_id requires a UUID", "$.run.segment_id");
  }
  if (run.pure_function_detail !== undefined && !["full", "calls"].includes(run.pure_function_detail)) {
    fail("TraceDetailInvalid", "pure_function_detail must be full or calls", "$.run.pure_function_detail");
  }
  requireString(run.run_id, "$.run.run_id");
  return trace;
}

/** @param {unknown} value @returns {Record<string, any>} */
export function validateTraceMachineContract(value) {
  const trace = validateTraceHeader(value);
  const run = trace.run;
  const runId = run.run_id;
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
  const events = requireArray(trace.events, "$.events");
  validateExecutionEvents(trace, events, false);
  return trace;
}

/** Validate a runtime-generated trace without collecting its events or IDs.
 * Runtime IDs are derived from the run and sequence, so contiguity also proves
 * uniqueness. General imported documents retain the existing ID-set check.
 * @param {unknown} header
 * @param {Iterable<unknown>} events
 */
export function validateTraceMachineStream(header, events) {
  const trace = validateTraceHeader(header);
  if (Object.hasOwn(trace, "events") || trace.run.admission !== undefined) {
    fail("TraceStreamInvalid", "an execution stream requires a header without events or admission", "$");
  }
  validateExecutionEvents(trace, events, true);
}

/** Validate an explicitly incomplete, frozen prefix without inventing a terminal.
 * The result is not a complete trace contract and must not be used as such.
 * @param {unknown} header
 * @param {Iterable<unknown>} events
 */
export function validateTraceMachinePrefix(header, events) {
  const trace = validateTraceHeader(header);
  if (Object.hasOwn(trace, "events") || trace.run.admission !== undefined) {
    fail("TraceStreamInvalid", "an execution prefix requires an execution header", "$");
  }
  validateExecutionEvents(trace, events, true, true);
}

/** Validate a bounded page without treating it as a complete execution.
 * @param {any} page @param {any} [reference] @param {number} [after] @param {number} [limit]
 */
export function validateTracePageMachineContract(page, reference = page?.reference,
  after = page?.events?.length ? page.events[0].sequence_index - 1 : page?.next, limit = 1000) {
  validateTracePage(page, reference, after, limit);
  const trace = validateTraceHeader(page.header);
  if (Object.hasOwn(trace, "events") || trace.run.admission !== undefined) {
    fail("TraceStreamInvalid", "a page requires an execution header", "$.header");
  }
  requireExact(trace.run.air_schema_version, AIR_SCHEMA_VERSION, "$.header.run.air_schema_version");
  requireString(trace.run.module_ref, "$.header.run.module_ref");
  requireString(trace.run.entry_ref, "$.header.run.entry_ref");
  if (typeof trace.run.air_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(trace.run.air_digest)) {
    fail("TraceAirCommitmentInvalid", "trace requires the execution-time canonical AIR digest", "$.header.run.air_digest");
  }
  for (const [index, event] of page.events.entries()) validateExecutionEventFields(event, index);
  return page;
}

/** @param {Record<string, any>} event @param {number} index */
function validateExecutionEventFields(event, index) {
  rejectUnknownFields(event, TRACE_EVENT_FIELDS, `$.events[${index}]`);
  if (event.observed_at !== undefined && (typeof event.observed_at !== "string" || !Number.isFinite(Date.parse(event.observed_at))
    || new Date(event.observed_at).toISOString() !== event.observed_at)) {
    fail("TraceTimestampInvalid", "observed_at requires a canonical UTC ISO instant", `$.events[${index}].observed_at`);
  }
  requireEnum(event.kind, TRACE_EVENT_KINDS, `$.events[${index}].kind`);
  if (event.kind === "admission_refused") fail("TraceAdmissionInvalid", "admission refusal cannot appear in an executed run", `$.events[${index}].kind`);
  rejectForbiddenTraceFields(event.payload, `$.events[${index}].payload`);
  const correlation = event.payload?.trace_context;
  if (correlation !== undefined) {
    const path = `$.events[${index}].payload.trace_context`;
    requireObject(correlation, path, "trace correlation");
    rejectUnknownFields(correlation, new Set(["span_id", "parent_span_id", "target_ref", "call_event_id", "agent_invocation_id", "agent_ref"]), path);
    for (const key of ["span_id", "target_ref", ...Object.keys(correlation)]) {
      // These references retain the identifiers already accepted by the runtime.
      // Reading surfaces enforce their own resource limits without invalidating
      // an execution solely because its host supplied a long identifier.
      requireString(correlation[key], `${path}.${key}`);
    }
    if (!correlation.span_id.startsWith("span:") || correlation.parent_span_id === correlation.span_id) {
      fail("TraceCorrelationInvalid", "trace correlation requires a distinct parent and a span identifier", path);
    }
  }
  if (event.payload?.call_started_event_id !== undefined) {
    requireString(event.payload.call_started_event_id, `$.events[${index}].payload.call_started_event_id`);
  }
  if (event.kind === "failure_detected") {
    requireString(event.payload?.runtime_error_code, `$.events[${index}].payload.runtime_error_code`);
    requireEnum(event.payload?.failure_family, TRACE_FAILURE_FAMILIES, `$.events[${index}].payload.failure_family`);
  }
}

/** @param {Record<string, any>} trace @param {Iterable<unknown>} events @param {boolean} canonicalIds */
function validateExecutionEvents(trace, events, canonicalIds, incomplete = false) {
  const run = trace.run, runId = run.run_id;
  if (typeof run.air_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(run.air_digest)) {
    fail("TraceAirCommitmentInvalid", "trace requires the execution-time canonical AIR digest", "$.run.air_digest");
  }
  requireExact(run.air_schema_version, AIR_SCHEMA_VERSION, "$.run.air_schema_version");
  requireString(run.module_ref, "$.run.module_ref");
  requireString(run.entry_ref, "$.run.entry_ref");
  const eventIds = canonicalIds ? null : new Set();
  let index = 0, initialSequenceIndex = 0;
  /** @type {Record<string, any> | null} */
  let terminal = null;
  for (const item of events) {
    const event = requireObject(item, `$.events[${index}]`, "trace event");
    if (index === 0) {
      initialSequenceIndex = event.sequence_index;
      if (!Number.isSafeInteger(initialSequenceIndex) || initialSequenceIndex < 0) {
        fail("TraceSequenceInvalid", "first sequence index must be a non-negative safe integer", "$.events[0].sequence_index");
      }
      if (event.kind !== "run_started") fail("TraceStartInvalid", "first event must be run_started", "$.events[0].kind");
    }
    if (terminal?.kind === "run_completed") fail("TraceTerminalInvalid", "run_completed must be unique and final", "$.events");
    validateExecutionEventFields(event, index);
    const eventId = requireString(event.event_id, `$.events[${index}].event_id`);
    if (eventIds?.has(eventId)) fail("DuplicateTraceEventId", `duplicate trace event ${eventId}`, `$.events[${index}].event_id`);
    eventIds?.add(eventId);
    requireExact(event.run_id, runId, `$.events[${index}].run_id`);
    const expectedSequenceIndex = initialSequenceIndex + index;
    if (!Number.isSafeInteger(expectedSequenceIndex) || event.sequence_index !== expectedSequenceIndex) {
      fail(
        "TraceSequenceInvalid",
        `expected contiguous sequence index ${expectedSequenceIndex}`,
        `$.events[${index}].sequence_index`,
      );
    }
    if (canonicalIds && eventId !== `event:${runId}:${run.segment_id ? `${run.segment_id}:` : ""}${expectedSequenceIndex + 1}`) {
      fail("TraceEventIdentityInvalid", "runtime event ID must match its run and sequence", `$.events[${index}].event_id`);
    }
    terminal = event;
    index++;
  }
  if (incomplete && terminal?.kind !== "run_completed") return;
  if (index < 2 || terminal === null) fail("TraceTerminalInvalid", "trace requires start and terminal events", "$.events");
  if (terminal.kind !== "run_completed") fail("TraceTerminalInvalid", "last event must be run_completed", `$.events[${index - 1}].kind`);
  requireEnum(terminal.payload?.status, TERMINAL_STATUSES, `$.events[${index - 1}].payload.status`);
  requireString(terminal.payload?.reason, `$.events[${index - 1}].payload.reason`);
}

/** @param {unknown} value @returns {string} */
export function canonicalizeMachineValue(value) {
  return JSON.stringify(canonicalValue(value));
}

/** @param {unknown} codeValue @param {unknown} [failureMode] @returns {string} */
export function failureFamilyForRuntimeCode(codeValue, failureMode = undefined) {
  const code = String(codeValue ?? "RuntimeFailure");
  /** @type {Record<string, string>} */
  const explicit = {
    ToolApprovalRequired: "authority",
    ToolApprovalOperationMismatch: "authority",
    ToolPayloadConstraintViolation: "authority",
    ToolInputSchemaInvalid: "business",
    ToolInputSchemaViolation: "business",
    ToolOutputSchemaInvalid: "handler",
    ToolOutputSchemaViolation: "handler",
    EffectOutcomeUnknown: "handler",
    EffectReconciliationRequired: "handler",
    EffectResultUnavailable: "handler",
    EffectReceiptInvalid: "handler",
    EffectRequestConflict: "authority",
    EffectNotApplied: "business",
  };
  if (Object.hasOwn(explicit, code)) return explicit[code];
  if (/^HumanApproval(?:Authority|Evidence|Exclusion|Role|Signer|Identity|Initiator|Attestation|DecisionAlready|StateLimit|NotExpired|Checkpoint)/u.test(code)
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
  if (/Provider|^PythonHost/u.test(code)) return "provider";
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
    const result = /** @type {Record<string, unknown>} */ (Object.create(null));
    // Build the same ordered object without allocating an entry array and a
    // key/value pair for every field. A prototype-free intermediate also keeps
    // __proto__ as an ordinary own field and never invokes inherited setters.
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalValue(record[key]);
    }
    return result;
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
import { isIsoDate, validFieldConstraints, validFieldDefault } from "./value-contracts.mjs";
