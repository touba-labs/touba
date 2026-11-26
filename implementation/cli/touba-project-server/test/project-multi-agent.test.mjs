import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, newModule, prepareProject } from "../../touba-project/src/project.mjs";
import { createToubaProjectServer } from "../src/serve.mjs";
import { readNativeTraceExport } from "../src/native-traces.mjs";
import { eventSummary, projectEvent } from "../../touba-inspect/src/trace-explorer/model.mjs";
import { multiAgentSource, multiAgentProvider } from "./fixtures/project-multi-agent.mjs";

test("Project run keeps three agents, repeated capabilities and two parallel branches in its native trace", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-multi-agent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject({ root }); const module = newModule("review.multi", { root });
  writeFileSync(module.source_path, multiAgentSource);
  const configPath = join(root, "touba.project.json");
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")),
    entry: "strategy:review.multi/Run", entrypoints: ["strategy:review.multi/Run", "strategy:review.multi/Partial"] }));
  const prepared = await prepareProject({ root, mode: "write" });
  assert.equal(prepared.status, "success", JSON.stringify(prepared));
  const calls = [];
  // Deliberately scripted provider: this qualifies protocol/trace integrity,
  // not model quality. All capabilities are pure and no external service runs.
  const server = createToubaProjectServer({ projectRoot: root, port: 0, quiet: true,
    agentDecisionProviderInitialMode: "capabilities", agentDecisionProvider: multiAgentProvider(calls) });
  await server.start(); t.after(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${server.server.address().port}/runs/sandbox`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ schema_version: "touba-sandbox-run-request-v1",
      execution_kind: "entrypoint", target_ref: "strategy:review.multi/Run", effect_policy: "runtime_only", inputs: { request: "review" },
      requested_by: { kind: "studio", id: "isolated-test" }, reason: "Qualify multi-agent trace reading." }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "review, review");
  assert.equal(new Set(calls.map(request => request.agent_ref)).size, 3);
  assert.equal(new Set(calls.map(request => request.invocation_id)).size, 5);
  const trace = readNativeTraceExport(root, result.run_id).segments[0].trace;
  const summaries = trace.events.map(eventSummary);
  assert.equal(new Set(summaries.filter(row => row.kind === "parallel_branch_started").map(row => row.branch)).size, 2);
  assert.equal(trace.events.filter(event => event.kind === "agent_capability_selected" && event.payload.selected_ref === "skill:review.multi/Echo").length, 6);
  assert.ok(summaries.some(row => row.parent));
  const projected = projectEvent({ payload: { provider_metadata: { model_id: "fixture", provider_name: "fixture",
    decision_interface: "native", history_max_messages: "12", api_key: "private" }, prompt: "private" } });
  assert.equal(projected.payload.history_max_messages, "12");
  assert.doesNotMatch(JSON.stringify(projected), /private/);
  const partialResponse = await fetch(`http://127.0.0.1:${server.server.address().port}/runs/sandbox`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ schema_version: "touba-sandbox-run-request-v1",
      execution_kind: "entrypoint", target_ref: "strategy:review.multi/Partial", effect_policy: "runtime_only", inputs: { request: "review" },
      requested_by: { kind: "studio", id: "isolated-test" }, reason: "Read partial branch evidence." }) });
  const partial = await partialResponse.json();
  assert.equal(partialResponse.status, 200, JSON.stringify(partial));
  assert.notEqual(partial.status, "success", JSON.stringify(partial));
  const events = readNativeTraceExport(root, partial.run_id).segments[0].trace.events;
  assert.equal(events.filter(event => event.kind === "parallel_branch_completed").length, 1);
  assert.equal(events.filter(event => event.kind === "parallel_branch_suspended").length, 1);
});
