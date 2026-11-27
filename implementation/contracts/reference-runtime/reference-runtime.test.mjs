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

test("preserves canonical Boolean results and refuses unsupported value expressions", async () => {
  const air = baseAir();
  const graph = air.execution_graphs[0];
  air.definitions.skills[0].signature.output_type = "builtin:Boolean";
  const run = () => executeReferenceAir(air, { entryRef: "skill:conformance/Run" });
  for (const value of [true, false]) {
    graph.nodes[0].arguments = [`literal:bool:${value}`];
    const result = await run();
    assert.equal(result.status, "success");
    assert.equal(result.result, value);
  }

  graph.expressions.push({ id: "bool", kind: "literal_boolean", literal_boolean: true,
    type_ref: "builtin:Boolean", source_ref: air.module.source_ref });
  graph.nodes[0].arguments = ["expr:bool"];
  const refusal = await run();
  assert.equal(refusal.status, "failure");
  assert.equal(refusal.failure_code, "ReferenceValueOutsideProfile");
});

test("refuses non-positive or non-integral reference step limits", async () => {
  for (const maxSteps of [0, -1, 1.5, NaN, Infinity, "1"]) {
    const result = await executeReferenceAir(baseAir(), { entryRef: "skill:conformance/Run", maxSteps });
    assert.equal(result.status, "failure");
    assert.equal(result.failure_code, "ReferenceStepLimitInvalid");
  }
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

test("refuses optional signatures outside the reference profile before effects", async () => {
  const air = effectAir();
  air.definitions.skills[0].signature = { inputs: [{ name: "contact", type_ref: "optional:builtin:Text" }] };
  let invoked = false;
  const result = await executeReferenceAir(air, {
    entryRef: "skill:conformance/Run",
    simulatedAdapters: { "tool:conformance/Lookup": { simulated: true, invoke: () => { invoked = true; } } },
  });
  assert.equal(result.failure_code, "ReferenceOptionalOutsideProfile");
  assert.equal(invoked, false);
});

test("refuses enum programs outside the reference profile before simulated effects", async () => {
  const air = effectAir();
  air.definitions.types.push({ id: "type:conformance/Priority", name: "Priority", fields: [],
    variants: [{ name: "high", source_ref: air.module.source_ref }], source_ref: air.module.source_ref });
  let invoked = false;
  const result = await executeReferenceAir(air, {
    entryRef: "skill:conformance/Run",
    simulatedAdapters: { "tool:conformance/Lookup": { simulated: true, invoke: () => { invoked = true; } } },
  });
  assert.equal(result.failure_code, "ReferenceEnumOutsideProfile");
  assert.equal(invoked, false);
});
