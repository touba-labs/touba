import test from "node:test";
import assert from "node:assert/strict";
import { TraceBuilder, sha256Json } from "../src/trace-builder.mjs";
import { validateTraceMachineContract } from "../../../contracts/machine/contracts.mjs";
import { exportTraceToOpenTelemetry } from "../../../cli/touba-inspect/src/inspect.mjs";

test("trace timestamps are actual UTC observations, serialized and covered by integrity", () => {
  const before = Date.now();
  const builder = new TraceBuilder({ air_schema_version: "touba-air-v1", module: { id: "module:test" } }, "strategy:test/Run", "run:time");
  builder.push("run_started");
  builder.push("run_completed", { payload: { status: "success", reason: "completed" } });
  const trace = JSON.parse(JSON.stringify(builder.document()));
  validateTraceMachineContract(trace);
  for (const event of trace.events) {
    assert.ok(Date.parse(event.observed_at) >= before && Date.parse(event.observed_at) <= Date.now());
    assert.equal(new Date(event.observed_at).toISOString(), event.observed_at);
  }
  const changed = structuredClone(trace);
  changed.events[0].observed_at = "2000-01-01T00:00:00.000Z";
  assert.notEqual(sha256Json(changed.events), sha256Json(trace.events));
  changed.events[0].observed_at = "yesterday";
  assert.throws(() => validateTraceMachineContract(changed), { code: "TraceTimestampInvalid" });
  const span = exportTraceToOpenTelemetry(trace).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.startTimeUnixNano, (BigInt(Date.parse(trace.events[0].observed_at)) * 1000000n).toString());
});
