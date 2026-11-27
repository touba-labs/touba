import test, { before } from "node:test";
import assert from "node:assert/strict";
import { compileTestAir } from "../../../tests/helpers/compile.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateTraceMachineContract } from "../../../contracts/machine/contracts.mjs";
import { loadTraceAuditArtifacts, validateTraceAuditArtifacts, createTraceAuditExport } from "../../../cli/touba-audit/src/audit.mjs";
import { createApprovalTestRunner } from "../../../tests/helpers/approval-checkpoints.mjs";

const executeAirDocument = createApprovalTestRunner();


let air;
before(() => {
  const root = mkdtempSync(join(tmpdir(), "touba-pure-trace-"));
  try {
    const source = join(root, "program.tb");
    writeFileSync(source, `module pure_trace
function Label
    takes value as Int
    gives Text
    do
        bind digits as Text = text(value)
        if value > 0
            give "positive " ++ digits
        else
            give "other " ++ digits
function Divide
    takes value as Int
    gives Int
    do
        give 12 // value
strategy Run
    takes values as List of Int
    gives Text
    do
        for value in values
            Label
                with value as value
                into label
            show
                with message as label
        give "done"
strategy Fail
    gives Int
    do
        Divide
            with value as 0
            into result
        give result
strategy AskLoop
    takes values as List of Int
    gives Text
    do
        for value in values
            ask
                with prompt as text(value)
                into answer
        give "complete"
strategy Approval
    gives Text
    do
        Label
            with value as 1
            into label
        human.approve
            with context as label
            into approval
        give label
`);
    air = compileTestAir(source);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("calls detail reduces stored events while preserving outcomes, budgets, calls and outer control flow", async t => {
  const values = Array.from({ length: 20 }, (_, i) => i - 10);
  const options = { entryRef: "strategy:pure_trace/Run", inputs: { values }, runLimits: { max_steps: 500 }, runId: "run:detail" };
  const full = await executeAirDocument(air, options);
  assert.equal(full.result, "done");
  assert.equal(full.messages.length, values.length);
  const observed = [];
  const compact = await executeAirDocument(air, { ...options, tracePureFunctions: "calls", traceEventObserver: event => observed.push(event) });
  assert.equal(compact.status, "success", JSON.stringify(compact));
  assert.deepEqual(compact.result, full.result);
  assert.deepEqual(compact.messages, full.messages);
  assert.deepEqual(observed, compact.trace.events);
  assert.equal(compact.trace.run.pure_function_detail, "calls");
  assert.equal(full.trace.run.pure_function_detail, undefined);
  validateTraceMachineContract(compact.trace);
  const internal = event => event.air_ref?.owner_ref?.startsWith("function:")
    && ["branch_evaluated", "loop_evaluated", "binding_created", "scope_entered", "scope_exited"].includes(event.kind);
  const significant = trace => {
    // Compaction renumbers events. Compare the referenced call's ordinal while
    // still checking that every correlation resolves to an actual call start.
    const calls = new Map(trace.events.filter(event => event.kind === 'call_started').map((event, index) => [event.event_id, `call:${index}`]));
    const call = id => { assert.ok(calls.has(id), `unresolved call ${id}`); return calls.get(id); };
    return trace.events.filter(event => !internal(event)).map(({ kind, air_ref, payload }) => {
      const normalized = structuredClone(payload);
      if (normalized?.call_started_event_id) normalized.call_started_event_id = call(normalized.call_started_event_id);
      if (normalized?.trace_context?.call_event_id) normalized.trace_context.call_event_id = call(normalized.trace_context.call_event_id);
      return { kind, air_ref, payload: normalized };
    });
  };
  assert.deepEqual(significant(compact.trace), significant(full.trace));
  assert.ok(compact.trace.events.length < full.trace.events.length - 50);
  assert.ok(JSON.stringify(compact.trace).length < JSON.stringify(full.trace).length);
  t.diagnostic(`full=${full.trace.events.length} events/${Buffer.byteLength(JSON.stringify(full.trace))} bytes; calls=${compact.trace.events.length} events/${Buffer.byteLength(JSON.stringify(compact.trace))} bytes`);
  const auditRoot = mkdtempSync(join(tmpdir(), "touba-compact-audit-"));
  try {
    const paths = { trace: join(auditRoot, "run.trace.json"), air: join(auditRoot, "program.air.json") };
    writeFileSync(paths.trace, JSON.stringify(compact.trace));
    writeFileSync(paths.air, JSON.stringify(air));
    const artifacts = loadTraceAuditArtifacts(paths);
    const validation = validateTraceAuditArtifacts(artifacts);
    assert.equal(validation.validationReport.status, "ok", JSON.stringify(validation.validationReport));
    assert.doesNotThrow(() => createTraceAuditExport(artifacts, validation));
  } finally { rmSync(auditRoot, { recursive: true, force: true }); }
});

test("compact traces retain pure failures, budget refusals and the entry function scope", async () => {
  for (const options of [{ entryRef: "strategy:pure_trace/Fail" },
    { entryRef: "strategy:pure_trace/Run", inputs: { values: [1, 2, 3] }, runLimits: { max_steps: 2 } }]) {
    const full = await executeAirDocument(air, { ...options, runId: "pure-trace-comparison" });
    const compact = await executeAirDocument(air, { ...options, runId: "pure-trace-comparison", tracePureFunctions: "calls" });
    assert.equal(compact.status, "failure");
    assert.equal(compact.reason, full.reason);
    assert.deepEqual(compact.trace.events.filter(event => /refused|exceeded|failure/.test(event.kind)).map(event => [event.kind, event.payload]),
      full.trace.events.filter(event => /refused|exceeded|failure/.test(event.kind)).map(event => [event.kind, event.payload]));
    validateTraceMachineContract(compact.trace);
  }
  const direct = await executeAirDocument(air, { entryRef: "function:pure_trace/Label", inputs: { value: 1 }, tracePureFunctions: "calls" });
  assert.ok(direct.trace.events.some(event => event.kind === "scope_entered"));
  assert.ok(direct.trace.events.some(event => event.kind === "scope_exited"));
  await assert.rejects(executeAirDocument(air, { entryRef: "strategy:pure_trace/Fail", tracePureFunctions: "none" }), { code: "InvalidRuntimeOption" });
});

test("ask at the end of a loop follows its back edge and executes the final give", async () => {
  const graph = air.execution_graphs.find(g => g.owner_ref === "strategy:pure_trace/AskLoop");
  const node = graph.nodes.find(n => n.kind === "user_interaction");
  const result = await executeAirDocument(air, { entryRef: graph.owner_ref, inputs: { values: [1, 2, 3] },
    userInputs: { [node.interaction_ref]: "answer" } });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "complete");
  assert.equal(result.trace.events.filter(e => e.kind === "user_interaction_answered").length, 3);
});

test("compact pure calls preserve approval pause and resumed result", async () => {
  const options = { entryRef: "strategy:pure_trace/Approval", durableHumanApprovals: true, tracePureFunctions: "calls" };
  const paused = await executeAirDocument(air, options);
  assert.equal(paused.reason, "human_approval_pending", JSON.stringify(paused));
  const resumed = await executeAirDocument(air, { ...options,
    humanApprovalResumeCheckpoint: paused.checkpoint,
    humanApprovalDecisions: { [paused.checkpoint.approval_ref]: "approved" } });
  assert.equal(resumed.status, "success", JSON.stringify(resumed));
  assert.equal(resumed.result, "positive 1");
  validateTraceMachineContract(paused.trace);
  validateTraceMachineContract(resumed.trace);
});
