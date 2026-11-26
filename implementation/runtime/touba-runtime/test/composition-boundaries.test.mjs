import { compileTestAir } from "../../../tests/helpers/compile.mjs";
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteTraceStore } from "../src/sqlite-trace-store.mjs";
import { executeAirDocument, loadToolBindingManifestFromJson } from "../src/index.mjs";
import { failureFamilyForRuntimeCode } from "../../../contracts/machine/contracts.mjs";

let air;
const tool = "tool:composition_boundaries/Echo";
before(() => {
  air = compileTestAir(fileURLToPath(new URL("fixtures/composition-boundaries.tb", import.meta.url)));
});
const options = entry => ({ entryRef: entry, inputs: { value: "synthetic" } });

test("the business rule admits only nonnegative amounts within the supplied limit", async () => {
  // Core checkouts carry their own example. The documentation is maintained
  // separately and can be checked explicitly during combined qualification.
  const filename = fileURLToPath(new URL("fixtures/business-validation.tb", import.meta.url));
  if (process.env.TOUBA_DOCUMENTATION_ROOT) {
    const page = readFileSync(join(process.env.TOUBA_DOCUMENTATION_ROOT, "tutoriels/fonctions-metier-pures.md"), "utf8");
    const source = page.match(/```touba title="business-validation.tb"\n([\s\S]*?)```/)[1];
    assert.equal(source.trim(), readFileSync(filename, "utf8").trim(), "The published example must match its tested fixture");
  }
  const document = compileTestAir(filename);
  for (const proposed of [-1, 0, 50, 100, 101]) {
    const result = await executeAirDocument(document, { entryRef: "strategy:business.validation/ValidatePrice", inputs: { proposed, ceiling: 100 } });
    assert.equal(result.status, proposed >= 0 && proposed <= 100 ? "success" : "stopped");
  }
});

for (const [kind, name] of [["skills", "Execute"], ["strategies", "Direct"]]) {
  test(`AIR cannot invoke an undeclared tool from ${kind}`, async () => {
    const document = structuredClone(air);
    const owner = document.definitions[kind].find(d => d.name === name);
    let calls = 0;
    const opts = { ...options(owner.id), toolHandlers: { [tool]: () => { calls++; return "ok"; } } };
    assert.equal((await executeAirDocument(document, opts)).status, "success");
    owner.uses = [];
    const refused = await executeAirDocument(document, opts);
    assert.equal(refused.reason, "CompositionCapabilityNotAllowed");
    assert.equal(calls, 1);
  });
}

test("policy constraints cannot be caught as business failures", async () => {
  let calls = 0;
  const manifest = loadToolBindingManifestFromJson(JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    [tool]: { handler: { kind: "process", command: process.execPath, args: [] }, grants: [], timeout_ms: 5000, max_payload_bytes: 65536,
      effect_contract: { kind: "none" }, payload_constraints: { input: { value: { allowed_values: ["allowed"] } } } },
  } }));
  const result = await executeAirDocument(air, { ...options("skill:composition_boundaries/Execute"), toolBindingManifest: manifest,
    toolHandlers: { [tool]: () => { calls++; return "forbidden"; } } });
  assert.equal(result.reason, "ToolPayloadConstraintViolation");
  assert.equal(calls, 0);
  assert.equal(result.trace.events.some(e => e.kind === "fallback_selected"), false);
});

test("failure families distinguish policy, handler result and uncertain effect", () => {
  for (const [code, family] of Object.entries({ ToolPayloadConstraintViolation: "authority", ToolInputSchemaInvalid: "business",
    ToolOutputSchemaInvalid: "handler", EffectOutcomeUnknown: "handler", EffectNotApplied: "business" })) {
    assert.equal(failureFamilyForRuntimeCode(code), family);
  }
});

test("model explanations do not disclose business input in traces or observers", async () => {
  const privateText = "private-client@example.test / 客户 #107";
  const events = [];
  const result = await executeAirDocument(air, { ...options("strategy:composition_boundaries/RunAgent"),
    inputs: { value: privateText }, traceEventObserver: event => events.push(event),
    agentDecisionProvider: () => ({ action: "answer_directly", result: "ok", reason: privateText }) });
  assert.equal(result.status, "success");
  assert.equal(JSON.stringify(result.trace).includes(privateText), false);
  assert.equal(JSON.stringify(events).includes(privateText), false);
  assert.ok(events.some(e => e.payload?.reason_present));
});

test("independent runs have independent default identities", async () => {
  const opts = { ...options("strategy:composition_boundaries/Direct"), toolHandlers: { [tool]: () => "ok" } };
  const a = await executeAirDocument(air, opts), b = await executeAirDocument(air, opts);
  assert.equal(a.status, "success"); assert.equal(b.status, "success");
  assert.notEqual(a.trace.run.run_id, b.trace.run.run_id);
  assert.notEqual(a.trace.events[0].event_id, b.trace.events[0].event_id);
});

test("cancelling a pending provider aborts it without retry or tool dispatch", async () => {
  let cancel = false, attempts = 0, aborted = false, calls = 0;
  const result = await executeAirDocument(air, { ...options("strategy:composition_boundaries/RunAgent"),
    cancelRequestedProvider: () => cancel,
    toolHandlers: { [tool]: () => { calls++; return "unused"; } },
    agentDecisionProvider: (request, host) => {
      attempts++; cancel = true;
      host.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    } });
  assert.equal(result.status, "cancelled");
  assert.equal(attempts, 1); assert.equal(calls, 0); assert.equal(aborted, true);
  assert.equal(result.trace.events.some(e => e.kind === "agent_capability_selected"), false);
});

for (const mode of ["answer", "unknown-capability", "exception"]) test(`private provider text stays out of SQLite and export: ${mode}`, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-private-trace-"));
  const storage = createSqliteTraceStore({ filename: join(root, "trace.sqlite") });
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const marker = "private-client@example.test / 客户";
  const observed = [];
  const result = await executeAirDocument(air, { ...options("strategy:composition_boundaries/RunAgent"),
    traceStorage: storage, traceEventObserver: event => observed.push(event),
    agentDecisionProvider: () => {
      if (mode === "exception") throw new Error(marker);
      return mode === "answer" ? { action: "answer_directly", source: marker, reason: marker, result: "ok" }
        : { action: "select_capability", targetRef: `tool:private/${marker}`, reason: marker, source: marker };
    } });
  assert.equal(result.status, mode === "answer" ? "success" : "failure");
  assert.equal(JSON.stringify(result.trace).includes(marker), false);
  assert.equal(JSON.stringify(observed).includes(marker), false);
  for (const segment of storage.segments()) {
    assert.equal([...storage.snapshot(segment.id).json()].join("").includes(marker), false);
  }
});

test("an invalid handler result is reported after dispatch and cannot enter a business fallback", async () => {
  let calls = 0;
  const result = await executeAirDocument(air, { ...options("skill:composition_boundaries/Execute"),
    toolHandlers: { [tool]: () => { calls++; return { wrong: "type" }; } } });
  assert.equal(calls, 1);
  assert.equal(result.status, "failure");
  assert.equal(result.trace.events.some(e => e.kind === "fallback_selected"), false);
  const status = result.trace.events.filter(e => e.kind === "tool_execution_status").at(-1).payload;
  assert.equal(status.phase, "post_validation");
  assert.equal(status.effect_status, "requires_effect_evidence");
});

test("authority recovery remains explicit and its fallback must itself be declared", async () => {
  const document = structuredClone(air);
  const graph = document.execution_graphs.find(g => g.owner_ref === "skill:composition_boundaries/Execute");
  graph.failure_paths[0].failure_family = "authority";
  const manifest = loadToolBindingManifestFromJson(JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    [tool]: { handler: { kind: "process", command: process.execPath, args: [] }, grants: [], timeout_ms: 5000, max_payload_bytes: 65536,
      effect_contract: { kind: "none" }, payload_constraints: { input: { value: { allowed_values: ["allowed"] } } } },
  } }));
  let calls = 0;
  const config = { ...options(graph.owner_ref), toolBindingManifest: manifest, toolHandlers: { [tool]: () => { calls++; return "bad"; } } };
  const recovered = await executeAirDocument(document, config);
  assert.equal(recovered.result, "fallback");
  assert.ok(recovered.trace.events.some(e => e.kind === "failure_detected" && e.payload.runtime_error_code === "ToolPayloadConstraintViolation"));
  document.definitions.skills.find(s => s.id === graph.owner_ref).uses = [tool];
  assert.equal((await executeAirDocument(document, config)).reason, "CompositionCapabilityNotAllowed");
  assert.equal(calls, 0);
});

for (const family of ["business", "handler"]) test(`an uncertain external effect cannot complete through ${family} fallback`, async () => {
  const document = structuredClone(air);
  document.execution_graphs.find(g => g.owner_ref === "skill:composition_boundaries/Execute").failure_paths[0].failure_family = family;
  const manifest = loadToolBindingManifestFromJson(JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    [tool]: { handler: { kind: "process", command: process.execPath, args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('invalid'));" ] },
      grants: [], timeout_ms: 5000, max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } },
  } }));
  const rows = new Map();
  const journal = { schemaVersion: "touba-effect-journal-v1",
    readEntry(effectId) { return rows.get(effectId) ?? null; },
    writeEntry(entry) { rows.set(entry.effect_id, structuredClone(entry)); } };
  const result = await executeAirDocument(document, { ...options("skill:composition_boundaries/Execute"),
    toolBindingManifest: manifest, effectScopeId: "isolated-test-unknown", effectJournal: journal });
  assert.equal(result.status, "failure");
  assert.equal(result.trace.events.some(e => e.kind === "fallback_selected"), false);
  assert.equal([...rows.values()][0]?.state, "unknown");
  assert.ok(result.trace.events.some(e => e.kind === "tool_execution_status" && e.payload.effect_status === "unknown"));
});
