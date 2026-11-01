#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { baseAir } from "../conformance/corpus.mjs";
import principal from "../conformance/principal-runtime-adapter.mjs";
import reference from "./adapter.mjs";

export async function buildDifferentialReport() {
  const entry = "skill:conformance/Run";
  const pure = await observeBoth(baseAir(), entry);
  const refusedAuthorityAir = baseAir();
  // Isolate callable_by refusal from the composition's own uses boundary.
  refusedAuthorityAir.definitions.skills[0].uses = ["agent:conformance/Reviewer"];
  refusedAuthorityAir.execution_graphs[0].nodes = [{
    id: "call", kind: "call_agent", target_ref: "agent:conformance/Reviewer",
    arguments: [], trace_point_refs: [], source_ref: refusedAuthorityAir.module.source_ref,
  }];
  refusedAuthorityAir.execution_graphs[0].entry_node_id = "call";
  refusedAuthorityAir.execution_graphs[0].edges = [];
  const refusal = await observeBoth(refusedAuthorityAir, entry);
  const comparisons = [
    compare("pure.terminal_status", pure.product.status, pure.reference.status),
    compare("pure.result_value", pure.product.result, pure.reference.result),
    compare("pure.essential_events", pure.product.essential_events, pure.reference.essential_events),
    compare("authority_refusal.terminal_status", refusal.product.status, refusal.reference.status),
    compare("authority_refusal.failure_code", refusal.product.failure_code, refusal.reference.failure_code),
    compare("authority_refusal.failure_family", refusal.product.failure_family, refusal.reference.failure_family),
    compare("authority_refusal.essential_events", refusal.product.essential_events, refusal.reference.essential_events),
  ];
  return {
    schema_version: "touba-runtime-differential-report-v1",
    scope: "minimal_portability_proof",
    runtimes: [principal.name, reference.name],
    status: comparisons.every((item) => item.classification === "conformant") ? "success" : "failure",
    comparisons,
    scenarios: ["pure_result", "unauthorized_agent_invocation"],
    allowed_variations: ["event identifiers", "budget-detail events", "non-essential dispatch events", "timestamps absent in both profiles"],
    outside_profile: ["real handlers", "provider calls", "durable checkpoints", "distributed execution"],
  };
}

function compare(subject, product, referenceValue) {
  return { subject, product, reference: referenceValue,
    classification: JSON.stringify(product) === JSON.stringify(referenceValue) ? "conformant" : "bug" };
}

async function observeBoth(document, entry) {
  const [product, referenceResult] = await Promise.all([
    principal.runCase(structuredClone(document), entry),
    reference.runCase(structuredClone(document), entry),
  ]);
  return { product, reference: referenceResult };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = await buildDifferentialReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "success") process.exitCode = 1;
}
