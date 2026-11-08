import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { initProject, prepareProject } from "../../touba-project/src/project.mjs";
import { readPreparedProject } from "../src/prepared-project.mjs";
import { createTriggerService } from "../../touba-trigger-service/src/serve.mjs";
import { createToubaProjectServer, readProjectTriggerStatus } from "../src/serve.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;

test("client observes real webhook admissions and dead letters from the service SQLite stores", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-trigger-observation-"));
  let service, server;
  t.after(async () => {
    await server?.stop();
    if (service?.server.listening) await new Promise(resolve => service.server.close(resolve));
    await delay(10);
    rmSync(root, { recursive: true, force: true });
  });
  initProject({ root });
  mkdirSync(join(root, "src/test"), { recursive: true });
  writeFileSync(join(root, "src/test/webhooks.tb"), `module test.webhooks
agent Answer
    gives Text
    responsibility "Return the reviewed answer."
    callable_by strategy Fail
strategy Fail
    gives Text
    uses Answer
    do
        Answer
            into answer
        give answer
strategy Run
    gives Text
    do
        give "ok"
trigger Good
    on request POST "/good"
    runs strategy Run
    limits
        max_runs_per_day as 10
        timeout_ms as 5000
trigger Bad
    on request POST "/bad"
    runs strategy Fail
    limits
        max_runs_per_day as 10
        timeout_ms as 5000
trigger Scheduled
    on schedule "every 1s"
    runs strategy Fail
    limits
        max_runs_per_day as 10
        timeout_ms as 5000
`);
  const config = JSON.parse(readFileSync(join(root, "touba.project.json")));
  config.entry = "strategy:test.webhooks/Run";
  writeFileSync(join(root, "touba.project.json"), JSON.stringify(config));
  const trigger = { enabled: true, source: { kind: "request" }, limits: { max_runs_per_day: 10, timeout_ms: 5000 } };
  writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {},
    triggers: { "trigger:test.webhooks/Good": trigger, "trigger:test.webhooks/Bad": trigger,
      "trigger:test.webhooks/Scheduled": { ...trigger, source: { kind: "schedule" } } } }));
  const prepared = await prepareProject({ root, mode: "write", manifestPath: "touba.manifest.json" });
  assert.equal(prepared.status, "success", JSON.stringify(prepared));
  const triggerStatusPath = join(root, ".touba/trigger-status.json");
  const inspect = () => readProjectTriggerStatus({ projectRoot: root, contractsRoot, triggerStatusPath });
  assert.equal(inspect().triggers.length, 3);
  assert.equal(existsSync(join(root, ".touba/triggers.sqlite")), false, "inspection does not create state");
  const inputs = readPreparedProject(root).inputs;
  service = await createTriggerService({
    airPath: join(root, inputs.find(input => input.kind === "air").path),
    manifestPath: join(root, inputs.find(input => input.kind === "manifest").path),
    port: 0, quiet: true, maxAttempts: 1,
  });
  await service.start();
  const endpoint = `http://127.0.0.1:${service.server.address().port}`;
  for (const path of ["good", "bad"]) {
    const response = await fetch(`${endpoint}/${path}`, { method: "POST", headers: { "x-touba-event-id": path }, body: "{}" });
    assert.equal(response.status, 202);
  }
  let observed;
  for (let attempt = 0; attempt < 150; attempt++) {
    observed = inspect();
    if (observed.triggers.find(item => item.trigger_ref.endsWith("/Bad")).queue.dead_letter === 1) break;
    await delay(20);
  }
  assert.equal(observed.triggers.find(item => item.trigger_ref.endsWith("/Good")).state.accepted_count, 1);
  assert.equal(observed.triggers.find(item => item.trigger_ref.endsWith("/Bad")).queue.dead_letter, 1);
  assert.equal(existsSync(triggerStatusPath), false, "no synthetic status file is needed");
  const before = readFileSync(join(root, ".touba/trigger-queue.sqlite"));
  server = createToubaProjectServer({ projectRoot: root, port: 0, quiet: true });
  await server.start();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const response = await fetch(`${base}/triggers`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).triggers, observed.triggers);
  const health = await (await fetch(`${base}/triggers/queue-health`)).json();
  assert.equal(health.summary.trigger_count, 3);
  assert.equal(health.summary.dead_letter, 1);
  assert.deepEqual(readFileSync(join(root, ".touba/trigger-queue.sqlite")), before, "observing leaves queue bytes intact");
  // The public CLI already forwards runtime host options to its bounded runner.
  // Exercise that actual entry point with a real agent, without a paid provider.
  writeFileSync(join(root, "provider.mjs"), `export function decideAgentCapability() {
    return { action: "answer_directly", source: "qa", reason: "Sufficient answer", result: "scheduled" };
  }`);
  writeFileSync(join(root, "approval.mjs"), `export const initiatorRef = "service:qa";
    export function attestHumanApproval() { throw new Error("No approval is declared in this test"); }`);
  const cli = new URL("../../touba-project/src/main.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [cli, "trigger", "run",
    join(root, inputs.find(input => input.kind === "air").path),
    "--manifest", join(root, inputs.find(input => input.kind === "manifest").path),
    "--trigger", "trigger:test.webhooks/Scheduled", "--max-runs", "1",
    "--agent-decision-provider", join(root, "provider.mjs"), "--human-approval-host", join(root, "approval.mjs"),
    "--human-checkpoint-out", join(root, "approval.json"), "--output", "json"],
    { cwd: root, encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal(inspect().triggers.find(item => item.trigger_ref.endsWith("/Scheduled")).state.accepted_count, 1);
  const manifestPath = join(root, inputs.find(input => input.kind === "manifest").path);
  writeFileSync(manifestPath, readFileSync(manifestPath, "utf8") + "\n");
  const stale = inspect();
  assert.ok(stale.triggers.every(item => item.status === "blocked"));
  assert.equal(stale.triggers.find(item => item.trigger_ref.endsWith("/Bad")).queue.dead_letter, 1,
    "stale preparation retains observable evidence, without claiming readiness");
});
