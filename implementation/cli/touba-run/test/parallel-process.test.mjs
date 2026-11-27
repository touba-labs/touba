import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { compileTestAir } from "../../../tests/helpers/compile.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";

test("real process diagnostics compare sequential and parallel service collection", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-parallel-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let active = 0, peak = 0, requests = 0;
  const server = createServer(async (request, response) => {
    requests++; peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 80));
    active--; response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ service: request.url.slice(1), healthy: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const handler = join(root, "diagnose.mjs");
  writeFileSync(handler, `let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const response = await fetch(${JSON.stringify(endpoint)} + '/' + encodeURIComponent(request.arguments.service));
if (!response.ok) throw new Error('Service unavailable');
const state = await response.json();
process.stdout.write(JSON.stringify({ ok: true, value: state.service + ': ' + (state.healthy ? 'healthy' : 'unhealthy') }));`);
  const common = `module service.diagnostics
tool Diagnose
    description "Read the service health endpoint and return its observed status."
    takes service as Text
    gives Text
skill Collect
    description "Collect the service health observation and show it."
    takes service as Text
    gives Text
    uses Diagnose
    do
        Diagnose
            with service as service
            into diagnosis
        show
            with message as diagnosis
        give diagnosis
agent Inspector
    takes service as Text
    gives Text
    responsibility "Inspect the supplied service through the authorized collector and return the observation."
    uses Collect
    callable_by strategy Run
strategy Run
    takes services as List of Text
    gives Text
    uses Inspector
    do
`;
  const bodies = {
    sequential: `        for service in services
            Inspector
                with service as service
                into diagnosis
        give "done"
`, parallel: `        parallel Inspector
            each service in services
            with service as service
            max_concurrency 4
            max_items 8
            into diagnoses
        give "done"
`,
  };
  const services = ["billing", "inventory", "orders", "shipping", "support", "identity"];
  const metrics = {};
  for (const [mode, body] of Object.entries(bodies)) {
    const path = join(root, `${mode}.tb`); writeFileSync(path, common + body);
    const document = compileTestAir(path);
    peak = 0; requests = 0;
    let providers = 0, largestCheckpoint = 0;
    const started = performance.now();
    const result = await executeAirDocument(document, {
      entryRef: "strategy:service.diagnostics/Run", inputs: { services },
      humanCheckpointStorePath: join(root, "approval-checkpoints.sqlite"),
      agentDecisionProviderInitialMode: "capabilities", agentDecisionProvider: request => {
        providers++;
        return request.step_index === 0
          ? { target_ref: "skill:service.diagnostics/Collect", arguments: { service: request.inputs.service } }
          : { action: "answer_directly", result: request.observations[0].value };
      },
      toolBindingManifest: { manifest_version: "touba-manifest-v1", bindings: {
        "tool:service.diagnostics/Diagnose": { handler: { kind: "process", command: process.execPath, args: [handler] },
          grants: [], timeout_ms: 3000, max_payload_bytes: 65536, effect_contract: { kind: "none" } },
      } },
      parallelCheckpointObserver: ({ checkpoint }) => { largestCheckpoint = Math.max(largestCheckpoint, Buffer.byteLength(JSON.stringify(checkpoint))); },
    });
    const milliseconds = Math.round(performance.now() - started);
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(result.messages.map(message => message.text), services.map(service => `${service}: healthy`));
    assert.equal(requests, services.length);
    assert.equal(providers, services.length * 2);
    assert.equal(active, 0);
    if (mode === "parallel") assert.ok(peak > 1 && peak <= 4);
    else assert.equal(peak, 1);
    metrics[mode] = { milliseconds, requests, provider_decisions: providers, peak_http_requests: peak,
      largest_checkpoint_bytes: largestCheckpoint, requests_per_second: +(requests * 1000 / milliseconds).toFixed(2),
      external_provider_cost: "not incurred; local deterministic decision adapter", monetary_price: "unknown for a remote deployment" };
  }
  t.diagnostic(JSON.stringify(metrics));
});
