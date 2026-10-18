import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToubaEngine } from "../src/index.mjs";

const cli = fileURLToPath(new URL("../../../cli/touba-project/src/main.mjs", import.meta.url));
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-persistent-engine-"));
  const engine = new ToubaEngine({ projectRoot: root, command: process.execPath, commandArgs: [cli], executionMode: "persistent" });
  t.after(async () => { await engine.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "source.tb"), `module worker
tool Fetch
    takes value as Text
    gives Text
    requires network
strategy Call
    takes value as Text
    gives Text
    uses Fetch
    do
        Fetch
            with value as value
            into result
        give result
strategy Echo
    takes value as Text
    gives Text
    do
        give value
`);
  const { airJson } = await engine.compile({ source: "source.tb" });
  const manifest = { manifest_version: "touba-manifest-v1", bindings: { "tool:worker/Fetch": {
    effect_contract: { kind: "none" }, grants: ["network"], secrets: [], timeout_ms: 10000, max_payload_bytes: 65536,
    handler: { kind: "process", command: process.execPath, args: [join(root, "handler.mjs")] },
  } } };
  const handler = `let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
process.stdout.write(JSON.stringify({ok:true,value:request.arguments.value}));`;
  writeFileSync(join(root, "handler.mjs"), handler);
  const save = () => writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest)); save();
  return { root, engine, airJson, manifest, save, handler };
}

test("warm Engine reuses one process but separates values and rereads authority on every run", async t => {
  const { engine, airJson, manifest, save } = await fixture(t);
  const echo = { airJson, entryRef: "strategy:worker/Echo" };
  assert.equal((await engine.run({ ...echo, inputs: { value: "first" } })).result, "first");
  const pid = engine.workerPid;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => engine.run({ ...echo, inputs: { value: `input-${i}` } })));
  assert.deepEqual(results.map(result => result.result), Array.from({ length: 8 }, (_, i) => `input-${i}`));
  assert.equal(engine.workerPid, pid);
  const call = { airJson, entryRef: "strategy:worker/Call", manifest: "manifest.json", inputs: { value: "permitted" } };
  assert.equal((await engine.run(call)).result, "permitted");
  manifest.bindings["tool:worker/Fetch"].grants = []; save();
  await assert.rejects(engine.run(call), error => error.phase === "run" && error.details.status === "failure");
  assert.equal(engine.workerPid, pid);
  await assert.rejects(engine.run({ airJson: {} }), error => error.details.reason === "AirInvalid");
  assert.equal((await engine.run({ ...echo, inputs: { value: "after-refusal" } })).result, "after-refusal");
  await engine.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(engine.run(echo), error => error.details.code === "EngineClosed");
});

test("saturated engine reports capacity, never a launch failure, and remains usable", async t => {
  const { engine, root, airJson, handler } = await fixture(t);
  const release = join(root, "release");
  writeFileSync(join(root, "handler.mjs"), `import {existsSync} from 'node:fs';
while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20));
${handler}`);
  const call = { airJson, entryRef: "strategy:worker/Call", manifest: "manifest.json", inputs: {value: "ok"} };
  const runs = Array.from({length: 20}, () => engine.run(call));
  const joined = Promise.all(runs);
  try {
    const deadline = Date.now() + 8000;
    while (engine.transport.pending.size < 20 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(engine.transport.pending.size, 20);
    await assert.rejects(engine.run(call), error => {
      assert.equal(error.code, "EngineCapacityExceeded");
      assert.match(error.message, /at capacity/);
      assert.doesNotMatch(error.message, /could not be launched/);
      return true;
    });
  } finally { writeFileSync(release, "release test handlers"); await joined; }
  assert.equal((await engine.run(call)).result, "ok");
});

test("cancellation remains request-specific while another run finishes", async t => {
  const { engine, root, airJson } = await fixture(t);
  writeFileSync(join(root, "handler.mjs"), `let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
await new Promise(resolve => setTimeout(resolve, 400));
process.stdout.write(JSON.stringify({ok:true,value:request.arguments.value}));`);
  const controller = new AbortController();
  const call = engine.run({ airJson, entryRef: "strategy:worker/Call", manifest: "manifest.json",
    inputs: { value: "cancelled" }, signal: controller.signal });
  const unrelated = engine.run({ airJson, entryRef: "strategy:worker/Echo", inputs: { value: "independent" } });
  const timer = setTimeout(() => controller.abort(), 100); t.after(() => clearTimeout(timer));
  const result = await call.catch(error => error);
  assert.ok(result.status === "cancelled" || result.details?.code === "EngineCancelled", JSON.stringify(result));
  assert.equal((await unrelated).result, "independent");
});

test("persistent runs do not retain a previous run's secret store or borrow another Engine's environment", async t => {
  const { root } = await fixture(t);
  writeFileSync(join(root, "secret.tb"), `module secret_worker
tool Probe
    gives Text
    requires secret_read
    secrets TEST_TOKEN
strategy Run
    gives Text
    uses Probe
    do
        Probe
            into result
        give result
`);
  writeFileSync(join(root, "secret-handler.mjs"), 'process.stdout.write(JSON.stringify({ok:true,value:process.env.TEST_TOKEN}));');
  writeFileSync(join(root, "secret-manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:secret_worker/Probe": { effect_contract: { kind: "none" }, handler: { kind: "process", command: process.execPath, args: [join(root, "secret-handler.mjs")] },
      grants: ["secret_read"], secrets: ["TEST_TOKEN"], timeout_ms: 5000, max_payload_bytes: 4096 },
  } }));
  writeFileSync(join(root, "secrets.json"), JSON.stringify({ secrets_version: "touba-secrets-v1", secrets: { TEST_TOKEN: { source: "env", name: "TEST_TOKEN" } } }));
  const engines = ["synthetic-secret-a", "synthetic-secret-b"].map(token => new ToubaEngine({
    projectRoot: root, command: process.execPath, commandArgs: [cli], executionMode: "persistent", env: { TEST_TOKEN: token },
  }));
  t.after(async () => { await Promise.all(engines.map(engine => engine.close())); });
  await Promise.all(engines.map(async (engine, index) => {
    await assert.rejects(engine.run({ source: "secret.tb", manifest: "secret-manifest.json", secrets: "secrets.json" }), error => {
      assert.equal(error.details.reason, "SecretValueInResult");
      assert.doesNotMatch(JSON.stringify(error), /synthetic-secret-[ab]/);
      return true;
    });
    const pid = engine.workerPid;
    const value = `synthetic-secret-${index ? "b" : "a"}`;
    assert.equal((await engine.run({ source: "source.tb", entryRef: "strategy:worker/Echo", inputs: { value } })).result, value);
    await assert.rejects(engine.run({ source: "secret.tb", manifest: "secret-manifest.json" }), error => error.details.status === "failure");
    assert.equal(engine.workerPid, pid);
  }));
  assert.notEqual(engines[0].workerPid, engines[1].workerPid);
});

test("worker crash rejects in-flight work without retry, and the next explicit run starts fresh", async t => {
  const { engine, root, airJson, handler } = await fixture(t);
  const marker = join(root, "handler-started.json");
  writeFileSync(join(root, "handler.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));
await new Promise(resolve => setTimeout(resolve, 10000));
${handler}`);
  const running = engine.run({ airJson, entryRef: "strategy:worker/Call", manifest: "manifest.json", inputs: { value: "interrupted" } });
  const rejected = assert.rejects(running, error => error.details.code === "EngineWorkerInterrupted");
  const deadline = Date.now() + 8000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(existsSync(marker));
  const oldPid = engine.workerPid;
  engine.transport.kill(); // Only this test's dedicated worker group.
  await rejected;
  assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" });
  const result = await engine.run({ airJson, entryRef: "strategy:worker/Echo", inputs: { value: "new-call" } });
  assert.equal(result.result, "new-call");
  assert.notEqual(engine.workerPid, oldPid);
  assert.equal(typeof JSON.parse(readFileSync(marker)).pid, "number");
});
