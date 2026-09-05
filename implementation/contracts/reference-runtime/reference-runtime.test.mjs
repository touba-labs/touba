import test from "node:test";
import assert from "node:assert/strict";

import { runConformance } from "../conformance/runner.mjs";
import { baseAir } from "../conformance/corpus.mjs";
import adapter from "./adapter.mjs";
import { buildDifferentialReport } from "./differential.mjs";
import { executeReferenceAir } from "./runtime.mjs";

test("runs the conformance corpus through the independent reference runtime", async () => {
  const report = await runConformance({ runtimeAdapter: adapter });
  assert.equal(report.status, "success");
});

test("matches principal runtime result, authority refusal and essential events", async () => {
  const report = await buildDifferentialReport();
  assert.equal(report.status, "success");
  assert.equal(report.comparisons.length, 7);
  assert.ok(report.comparisons.every((item) => item.classification === "conformant"));
});

test("refuses an effect before adapter invocation when uses is absent", async () => {
  const air = effectAir();
  air.definitions.skills[0].uses = [];
  let invoked = false;
  const result = await executeReferenceAir(air, {
    entryRef: "skill:conformance/Run",
    simulatedAdapters: { "tool:conformance/Lookup": { simulated: true, invoke: () => { invoked = true; } } },
  });
  assert.equal(result.failure_code, "UnauthorizedReferenceTarget");
  assert.equal(invoked, false);
});

test("requires explicitly simulated effect adapters and marks their trace", async () => {
  const air = effectAir();
  const refused = await executeReferenceAir(air, { entryRef: "skill:conformance/Run" });
  assert.equal(refused.failure_code, "ReferenceEffectAdapterRequired");
  const accepted = await executeReferenceAir(air, {
    entryRef: "skill:conformance/Run",
    simulatedAdapters: { "tool:conformance/Lookup": { simulated: true, invoke: async () => "simulated-value" } },
  });
  assert.equal(accepted.status, "success");
  assert.equal(accepted.result, "simulated-value");
  assert.equal(accepted.trace.events.find((event) => event.kind === "call_started").payload.simulated_effect, true);
});

function effectAir() {
  const air = baseAir();
  air.definitions.tools.push({ id: "tool:conformance/Lookup", name: "Lookup", source_ref: air.module.source_ref });
  air.definitions.skills[0].uses = ["tool:conformance/Lookup"];
  air.execution_graphs[0].nodes = [
    { id: "call", kind: "call_tool", target_ref: "tool:conformance/Lookup", arguments: [], result_binding: "lookup", trace_point_refs: [], source_ref: air.module.source_ref },
    { id: "give", kind: "give", arguments: ["value:lookup"], trace_point_refs: [], source_ref: air.module.source_ref },
  ];
  air.execution_graphs[0].entry_node_id = "call";
  air.execution_graphs[0].edges = [{ from_node_id: "call", to_node_id: "give", role: "next", source_ref: air.module.source_ref }];
  return air;
}
