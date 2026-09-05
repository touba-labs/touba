import test from "node:test";
import assert from "node:assert/strict";
import { runGovernanceCostBenchmark } from "./benchmark.mjs";

test("measures governance phases and preserves non-regression thresholds", async () => {
  const report = await runGovernanceCostBenchmark();
  assert.equal(report.status, "success");
  assert.equal(report.rows[0].metrics.provider_calls, 3);
  assert.equal(report.rows[1].metrics.provider_calls, 2);
  assert.equal(report.rows[0].phases.orientation, 1);
  assert.equal(report.rows[1].phases.catalogue, 1);
  assert.equal(report.rows[1].phases.observations, 1);
  assert.equal(report.rows[1].phases.direct_answers, 1);
  assert.ok(report.rows.every((row) => row.metrics.latency_ms >= 0));
  assert.ok(report.thresholds.every((threshold) => threshold.governance_non_regression));
});

test("keeps unavailable token and provider cost data explicit", async () => {
  const report = await runGovernanceCostBenchmark();
  for (const row of report.rows) {
    assert.equal(row.metrics.tokens_input, null);
    assert.equal(row.metrics.tokens_output, null);
    assert.equal(row.metrics.provider_cost, null);
  }
  assert.equal(report.live.status, "not_run");
});
