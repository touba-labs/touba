// @ts-check

import { RuntimeFailure, RuntimeStop } from "./runtime-errors.mjs";

/**
 * Traverse one indexed AIR graph. Node semantics remain supplied by the
 * runtime facade to avoid duplicating target dispatch.
 *
 * @param {string} graphRef
 * @param {any} context
 * @param {{
 *   requireGraph: (graphRef: string) => any,
 *   isDispatchNode: (node: any) => boolean,
 *   assertRunCanContinue: (context: any) => void,
 *   consumeStepBudget: (context: any, details: any) => void,
 *   airRefForNode: (graph: any, node: any) => any,
 *   executeNode: (graph: any, node: any, context: any) => Promise<any>,
 *   nextNodeId: (graph: any, nodeId: string, edgeRole: string) => string | undefined,
 *   beforeNode?: (graph: any, node: any, context: any) => Promise<void>,
 *   afterNode?: (graph: any, node: any, context: any, step: any, nextNodeId: string | null) => Promise<void>,
 * }} operations
 * @param {{startNodeId?: string}} [options]
 */
export async function executeGraphTraversal(graphRef, context, operations, options = {}) {
  const graph = operations.requireGraph(graphRef);
  context.trace.push("scope_entered", {
    airRef: {
      flow_graph_ref: graph.id,
      owner_ref: graph.owner_ref,
    },
  });

  let currentNodeId = options.startNodeId ?? graph.entry_node_id;
  let result;
  while (currentNodeId) {
    const node = graph.nodes.find((/** @type {any} */ candidate) => candidate.id === currentNodeId);
    if (!node) {
      throw new RuntimeFailure(`unknown AIR node ${currentNodeId}`, {
        graphRef: graph.id,
        nodeId: currentNodeId,
      });
    }
    if (operations.beforeNode) {
      await operations.beforeNode(graph, node, context);
    } else if (!operations.isDispatchNode(node)) {
      operations.assertRunCanContinue(context);
      operations.consumeStepBudget(context, {
        airRef: operations.airRefForNode(graph, node),
        targetRef: node.target_ref,
      });
    }

    const step = await operations.executeNode(graph, node, context);
    const next = step.done
      ? null
      : operations.nextNodeId(graph, node.id, step.edgeRole);
    if (operations.afterNode) {
      await operations.afterNode(graph, node, context, step, next ?? null);
    }
    if (step.done) {
      context.trace.push("scope_exited", {
        airRef: {
          flow_graph_ref: graph.id,
          owner_ref: graph.owner_ref,
          node_id: node.id,
        },
        payload: { status: step.status },
      });
      if (step.status === "stopped") {
        throw new RuntimeStop("AIR stop node reached", {
          graphRef: graph.id,
          nodeId: node.id,
          reason: step.reason ?? "explicit_stop",
        });
      }
      return step.result;
    }

    result = step.result ?? result;
    currentNodeId = next;
  }

  context.trace.push("scope_exited", {
    airRef: {
      flow_graph_ref: graph.id,
      owner_ref: graph.owner_ref,
    },
    payload: { status: "success" },
  });
  return result;
}
