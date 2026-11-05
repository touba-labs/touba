import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TraceBuilder } from "../src/trace-builder.mjs";
import { withTraceInvocation, withTraceApproval } from "../src/trace-context.mjs";
import { executeAirDocument } from "../src/index.mjs";
import { validateTraceMachineContract } from "../../../contracts/machine/contracts.mjs";

const header = { air_schema_version: "touba-air-v1", module: { id: "module:test" } };
test("approval correlation stays within its run and concurrent operation", async () => {
  const trace = new TraceBuilder(header, "strategy:test/Run", "run:approvals");
  const other = new TraceBuilder(header, "strategy:test/Run", "run:other");
  await Promise.all([0, 1].map(i => withTraceApproval(Object.create(trace), `request:${i}`, async () => {
    trace.push("tool_binding_authorized", { payload: { tool_ref: `tool:test/T${i}` } });
    await new Promise(resolve => setImmediate(resolve));
    trace.push("tool_handler_completed", { payload: { tool_ref: `tool:test/T${i}` } });
    other.push("tool_handler_completed", { payload: { tool_ref: "tool:test/Other" } });
    withTraceApproval(trace, undefined, () => trace.push("tool_handler_completed", { payload: { tool_ref: "tool:test/Unprotected" } }));
  })));
  for (const i of [0, 1]) {
    const events = trace.events.filter(event => event.payload?.tool_ref === `tool:test/T${i}`);
    assert.equal(events.length, 2);
    assert.ok(events.every(event => event.payload.approval_request_id === `request:${i}`));
  }
  for (const event of [...other.events, ...trace.events.filter(event => event.payload?.tool_ref === "tool:test/Unprotected")]) {
    assert.equal(event.payload.approval_request_id, undefined);
  }
  const after = trace.push("tool_handler_completed", { payload: { tool_ref: "tool:test/After" } });
  assert.equal(after.payload.approval_request_id, undefined);
});

test("concurrent invocation correlation is isolated and survives awaits without changing payloads", async () => {
  const trace = new TraceBuilder(header, "strategy:test/Run", "run:scope");
  trace.push("run_started");
  await withTraceInvocation(trace, "strategy:test/Run", {}, async () => {
    trace.push("scope_entered");
    await Promise.all([0, 1].map(i => withTraceInvocation(Object.create(trace), "agent:test/A",
      { agentInvocationId: `invocation:${i}`, activeAgentRef: "agent:test/A" }, async () => {
        trace.push("agent_capabilities_listed", { payload: { agent_ref: "agent:test/A" } });
        await new Promise(resolve => setImmediate(resolve));
        trace.push("agent_direct_answer_returned", { payload: { agent_ref: "agent:test/A" } });
      })));
  });
  trace.push("run_completed", { payload: { status: "success", reason: "completed" } });
  const document = trace.document();
  validateTraceMachineContract(document);
  const children = document.events.filter(e => e.payload?.trace_context?.agent_invocation_id);
  assert.equal(new Set(children.map(e => e.payload.trace_context.span_id)).size, 2);
  for (const id of ["invocation:0", "invocation:1"]) {
    const events = children.filter(e => e.payload.trace_context.agent_invocation_id === id);
    assert.equal(events.length, 2);
    assert.equal(events[0].payload.trace_context.span_id, events[1].payload.trace_context.span_id);
    assert.equal(events[0].payload.trace_context.parent_span_id, document.events[1].payload.trace_context.span_id);
  }
  assert.equal(document.events.at(-1).payload.trace_context, undefined);
  const changed = structuredClone(document);
  changed.events[1].payload.trace_context.parent_span_id = changed.events[1].payload.trace_context.span_id;
  assert.throws(() => validateTraceMachineContract(changed), { code: "TraceCorrelationInvalid" });
});

test("a real compiled program emits explicit call and scope relationships", async () => {
  const air = JSON.parse(await readFile(new URL("../../../tests/air/tb-v01-001-linear-skill.air.json", import.meta.url)));
  const result = await executeAirDocument(air, { runId: "run:real-correlations:" + "x".repeat(4096),
    entryRef: "strategy:examples.linear_skill/RunSourcedNote", inputs: { request: { topic: "traces" } },
    agentDecisions: { "agent:examples.linear_skill/Researcher": { target_ref: "skill:examples.linear_skill/BuildNote", arguments: { request: { topic: "traces" } } } }, toolHandlers: {
    "tool:examples.linear_skill/FetchSource": async () => ({ content: "source" }),
  } });
  assert.equal(result.status, "success", result.reason);
  validateTraceMachineContract(result.trace);
  const starts = result.trace.events.filter(e => e.kind === "call_started");
  assert.ok(starts.length > 0);
  for (const event of result.trace.events.filter(e => e.kind === "call_completed")) {
    const start = starts.find(e => e.event_id === event.payload.call_started_event_id);
    assert.ok(start);
    assert.equal(start.payload.target_ref, event.payload.target_ref);
  }
  assert.ok(result.trace.events.some(e => e.payload?.trace_context?.parent_span_id));
});
