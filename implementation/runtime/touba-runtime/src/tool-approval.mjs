// Internal continuations derived exclusively from AIR tool requirements.
// No program value, host binding or serialized Approval can mint a permit.
import { RuntimeFailure } from "./runtime-errors.mjs";
import { validateApprovalPolicy } from "./human-approval-policy.mjs";
import { canonicalDigest } from "./execution-checkpoints.mjs";
import { combineToolApprovalPolicies } from "../../../contracts/tool-approval-policy.mjs";

const permits = new WeakMap();

export function toolApprovalPolicy(tool) {
  if (!Object.hasOwn(tool, "approval_policy")) return undefined;
  const policy = tool.approval_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new RuntimeFailure("tool approval policy must be an object", {}, "InvalidHumanApprovalPolicy");
  }
  return Object.keys(policy).length ? validateApprovalPolicy(policy) : null;
}

export function createToolApprovalGraphs(indexes, manifest) {
  const graphs = new Map();
  for (let tool of indexes.tools.values()) {
    const consumer = manifest?.bindings.get(tool.id)?.approvalPolicy;
    if (consumer !== undefined) {
      let policy;
      try { policy = combineToolApprovalPolicies(tool.approval_policy, consumer); }
      catch (error) { throw new RuntimeFailure("source and consumer approval policies cannot be combined", {}, error.code); }
      tool = { ...tool, approval_policy: policy };
      indexes.tools.set(tool.id, tool);
    }
    const policy = toolApprovalPolicy(tool);
    if (policy === undefined) continue;
    const id = `graph:tool-approval:${tool.id}`;
    if (indexes.graphs.has(id)) throw new RuntimeFailure("reserved tool approval graph identity", {}, "InvalidHumanApprovalPolicy");
    const approval = `${id}:approval`, dispatch = `${id}:dispatch`;
    const graph = { id, owner_ref: tool.id, entry_node_id: approval, source_ref: tool.source_ref,
      expressions: [], failure_paths: [], failure_path_refs: [],
      nodes: [
        { id: approval, kind: "human_approval", approval_ref: `approval:${tool.id}`, approval_mode: "required_approval",
          ...(policy ? { approval_policy: policy } : {}),
          context_refs: (tool.signature.inputs ?? []).map(input => `value:${input.name}`),
          result_binding: "@operation_approval", source_ref: tool.source_ref },
        { id: dispatch, kind: "internal_tool_dispatch", target_ref: tool.id, source_ref: tool.source_ref },
      ],
      edges: [{ from_node_id: approval, to_node_id: dispatch, role: "next" }],
    };
    graphs.set(tool.id, graph);
    indexes.graphs.set(id, graph);
  }
  return graphs;
}

export function approvedOperation(tool, context) {
  return { tool_ref: tool.id, run_id: context.trace.runId,
    caller_ref: context.activeCallerRef, agent_ref: context.activeAgentRef,
    arguments: Object.fromEntries((tool.signature.inputs ?? []).map(input => [input.name, context.values.get(`value:${input.name}`)])) };
}

export function grantToolApproval(graph, context, request) {
  if (context.toolApprovalGraphs.get(graph.owner_ref) !== graph) return;
  const tool = context.indexes.tools.get(graph.owner_ref);
  const operation = approvedOperation(tool, context);
  if (!request || canonicalDigest(request.review_context?.operation) !== canonicalDigest(operation)) {
    throw new RuntimeFailure("approval does not match the exact tool operation", {}, "ToolApprovalOperationMismatch");
  }
  permits.set(context, { request_id: request.request_id, digest: canonicalDigest(operation) });
}

export function consumeToolApproval(tool, context) {
  if (toolApprovalPolicy(tool) === undefined) return;
  const permit = permits.get(context);
  permits.delete(context);
  if (!permit || permit.digest !== canonicalDigest(approvedOperation(tool, context))) {
    throw new RuntimeFailure("tool dispatch requires approval of this exact operation", { toolRef: tool.id }, "ToolApprovalRequired");
  }
  context.trace.push("tool_approval_authorized", { payload: { tool_ref: tool.id, request_id: permit.request_id,
    approval_policy_digest: canonicalDigest(tool.approval_policy) } });
  return permit.request_id;
}
