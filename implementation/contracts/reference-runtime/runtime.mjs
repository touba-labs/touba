import {
  AIR_SCHEMA_VERSION,
  TRACE_CAPABILITY_PROFILE,
  TRACE_PROTOCOL_VERSION,
  failureFamilyForRuntimeCode,
  validateAirMachineContract,
  validateTraceMachineContract,
  canonicalizeMachineValue,
} from "../machine/contracts.mjs";
import { createHash } from "node:crypto";

export const REFERENCE_RUNTIME_PROFILE = "touba-reference-runtime-pure-governed-v1";

export async function executeReferenceAir(document, {
  entryRef,
  simulatedAdapters = {},
  maxSteps = 100,
  runId = "run-reference",
} = {}) {
  validateAirMachineContract(document);
  const trace = traceWriter(document, entryRef, runId);
  trace.push("run_started", { entry_ref: entryRef, reference_runtime: REFERENCE_RUNTIME_PROFILE });
  let status = "success";
  let result;
  let failureCode = null;
  try {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw refusal("ReferenceStepLimitInvalid", "authority");
    if (document.required_features?.length) throw refusal("ReferenceFeatureOutsideProfile", "authority");
    if ((document.definitions.types ?? []).some(type => type.variants)) throw refusal("ReferenceEnumOutsideProfile", "business");
    if (document.execution_graphs.some(graph => (graph.expressions ?? []).some(expression => expression.kind.startsWith("optional_")))
      || Object.values(document.definitions).flat().some(definition =>
        [definition.signature?.output_type, ...(definition.signature?.inputs ?? []).map(input => input.type_ref),
          ...(definition.fields ?? []).map(field => field.type_ref)].some(type => /(^|:)optional:/u.test(type ?? "")))) {
      throw refusal("ReferenceOptionalOutsideProfile", "business");
    }
    const graph = document.execution_graphs.find((item) => item.owner_ref === entryRef);
    if (!graph) throw refusal("ReferenceEntryUnknown", "business");
    result = await executeGraph(document, graph, trace, simulatedAdapters, maxSteps);
  } catch (error) {
    status = error.code === "ReferenceStopped" ? "stopped" : "failure";
    failureCode = error.code ?? "ReferenceRuntimeFailure";
    if (status === "failure") trace.push("failure_detected", {
      runtime_error_code: failureCode,
      failure_family: error.failureFamily ?? failureFamilyForRuntimeCode(failureCode),
    });
  }
  const reason = status === "success" ? "completed" : status === "stopped" ? "explicit_stop" : failureCode;
  trace.push("run_completed", { status, reason });
  const traceDocument = trace.document();
  validateTraceMachineContract(traceDocument);
  return { status, reason, result, failure_code: failureCode, trace: traceDocument };
}

async function executeGraph(document, graph, trace, adapters, maxSteps) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const owner = definitionById(document, graph.owner_ref);
  let nodeId = graph.entry_node_id;
  let steps = 0;
  const values = new Map();
  trace.push("scope_entered", {});
  while (nodeId) {
    if (++steps > maxSteps) throw refusal("ReferenceStepLimitExceeded", "authority");
    const node = nodes.get(nodeId);
    if (!node) throw refusal("ReferenceNodeUnknown", "business");
    if (node.kind === "give") {
      const result = resolveValue(node.arguments?.[0], values);
      trace.push("scope_exited", { status: "success" });
      return result;
    }
    if (node.kind === "stop") throw refusal("ReferenceStopped", "human_stop");
    if (node.kind === "call_tool") {
      const target = node.target_ref;
      if (!(owner?.uses ?? []).includes(target)) throw refusal("UnauthorizedReferenceTarget", "authority");
      const adapter = adapters[target];
      if (!adapter || adapter.simulated !== true || typeof adapter.invoke !== "function") {
        throw refusal("ReferenceEffectAdapterRequired", "handler");
      }
      trace.push("call_started", { target_ref: target, simulated_effect: true });
      const value = await adapter.invoke({ arguments: node.arguments ?? [] });
      trace.push("call_completed", { target_ref: target, simulated_effect: true });
      if (node.result_binding) values.set(node.result_binding, value);
    } else if (node.kind === "call_agent") {
      const agent = definitionById(document, node.target_ref);
      const authorized = agent?.callable_by?.some((entry) => entry.caller_ref === graph.owner_ref);
      if (!authorized) throw refusal("UnauthorizedAgentInvocation", "authority");
      trace.push("agent_invocation_authorized", {
        caller_ref: graph.owner_ref, agent_ref: node.target_ref, authority_source: "callable_by",
      });
      throw refusal("ReferenceAgentExecutionOutsideProfile", "business");
    } else {
      throw refusal("ReferenceNodeKindOutsideProfile", "business");
    }
    nodeId = graph.edges.find((edge) => edge.from_node_id === nodeId && edge.role === "next")?.to_node_id;
  }
  trace.push("scope_exited", { status: "success" });
  return undefined;
}

function definitionById(document, id) {
  for (const collection of Object.values(document.definitions)) {
    const found = collection.find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}

function resolveValue(ref, values) {
  if (ref === undefined) return undefined;
  if (ref.startsWith("literal:string:")) return ref.slice("literal:string:".length);
  if (ref === "literal:bool:true" || ref === "literal:boolean:true") return true;
  if (ref === "literal:bool:false" || ref === "literal:boolean:false") return false;
  if (ref.startsWith("value:") && values.has(ref.slice("value:".length))) return values.get(ref.slice("value:".length));
  throw refusal("ReferenceValueOutsideProfile", "business");
}

function refusal(code, failureFamily) {
  return Object.assign(new Error(code), { code, failureFamily });
}

function traceWriter(document, entryRef, runId) {
  const events = [];
  const airDigest = `sha256:${createHash("sha256").update(canonicalizeMachineValue(document)).digest("hex")}`;
  return {
    push(kind, payload) {
      events.push({ event_id: `event:${runId}:${events.length + 1}`, run_id: runId,
        sequence_index: events.length, kind, payload });
    },
    document() {
      return {
        trace_protocol_version: TRACE_PROTOCOL_VERSION,
        trace_capability_profile: TRACE_CAPABILITY_PROFILE,
        run: { run_id: runId, air_schema_version: AIR_SCHEMA_VERSION,
          air_digest: airDigest,
          module_ref: document.module.id, entry_ref: entryRef },
        events,
      };
    },
  };
}
