import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { initProject, prepareProject } from "../../touba-project/src/project.mjs";
import { createToubaProjectServer } from "../src/serve.mjs";
import { readPreparedProject } from "../src/prepared-project.mjs";
import { newPackage, addPackage } from "../../touba-project/src/packages.mjs";

test("unified serve CLI loads a provider and documented identity and routes triggers explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-server-provider-"));
  let child;
  let closed;
  try {
    initProject({ root });
    const context = newPackage("acme.review", { root, context: true });
    await addPackage(context.path, { root });
    const configPath = join(root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath));
    config.entry = "strategy:demo.server/Run";
    config.entrypoints = ["trigger:demo.server/Hourly"];
    config.configuration = { ...config.configuration, contexts: [{ package: "acme.review", context: "review", active: true }] };
    writeFileSync(configPath, JSON.stringify(config));
    mkdirSync(join(root, "src/demo"), { recursive: true });
    writeFileSync(join(root, "src/demo/server.tb"), `module demo.server
agent Answer
    gives Text
    responsibility "Return a direct answer within declared authority."
    callable_by strategy Run
strategy Run
    gives Text
    uses Answer
    do
        Answer
            into answer
        give answer
strategy Ping
    gives Text
    do
        give "pong"
trigger Hourly
    on schedule "every 1h"
    runs strategy Ping
    limits
        max_runs_per_day as 10
        timeout_ms as 30000
`);
    writeFileSync(join(root, "provider.mjs"), `import assert from 'node:assert/strict';
    export function decideAgentCapability(request) {
      assert.equal(request.model_input.active_skill_packs[0].ref, 'skill_pack:acme.review/review');
      return { action: "answer_directly", source: "isolated-test", reason: "A direct answer is sufficient.", result: "served" };
    }`);
    const guide = readFileSync(new URL("../../../../docs/guides/api-serveur-projet.md", import.meta.url), "utf8");
    const identity = guide.match(/```json title="project-identity.json"\n([\s\S]*?)```/)[1];
    writeFileSync(join(root, "project-identity.json"), identity);
    const prepared = await prepareProject({ root, mode: "write", profile: "dev" });
    assert.notEqual(prepared.status, "error", JSON.stringify(prepared));
    // Explicit activation, never inferred from the source trigger.
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {},
      triggers: { "trigger:demo.server/Hourly": { enabled: true, source: { kind: "schedule" }, limits: { max_runs_per_day: 10, timeout_ms: 30000 } } } }));
    const activated = await prepareProject({ root, mode: "write", profile: "dev", manifestPath: "touba.manifest.json" });
    assert.notEqual(activated.status, "error", JSON.stringify(activated));
    const cli = new URL("../../touba-project/src/main.mjs", import.meta.url).pathname;
    child = spawn(process.execPath, [cli, "serve", "--project-root", root, "--port", "0",
      "--agent-decision-provider", join(root, "provider.mjs"), "--identity", join(root, "project-identity.json")],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    closed = once(child, "close");
    let output = "", errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${errors}`)), 10000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error(errors)); });
      child.stdout.on("data", chunk => {
        output += chunk;
        for (const line of output.split("\n")) {
          try { const event = JSON.parse(line); if (event.event === "touba_project_server_started") { clearTimeout(timer); resolve(event); } } catch {}
        }
      });
    });
    const base = `http://127.0.0.1:${started.port}`;
    const loaded = await (await fetch(base + "/identity")).json();
    assert.equal(loaded.users[0].user_ref, "user:reviewer");
    for (const [route, kind, target, status, value] of [
      ["/runs/sandbox", "entrypoint", "strategy:demo.server/Run", 200, "served"],
      ["/runs/sandbox", "trigger", "trigger:demo.server/Hourly", 400, undefined],
      ["/triggers/fire", "trigger", "trigger:demo.server/Hourly", 200, "pong"],
    ]) {
      const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        schema_version: "touba-sandbox-run-request-v1", execution_kind: kind, target_ref: target,
        inputs: {}, effect_policy: "runtime_only", requested_by: { kind: "service", id: "integration" }, reason: "Verify documented server routes",
        ...(kind === "trigger" ? { event_id: "event-1", source_kind: "schedule" } : {}),
      }) });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      if (status === 200) { assert.equal(result.status, "success", JSON.stringify(result)); assert.equal(result.result, value); }
    }
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (closed) await closed;
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare write/check is idempotent and serve executes the prepared development AIR without copying", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-serve-prepared-"));
  let service;
  try {
    initProject({ root });
    mkdirSync(join(root, "src/demo"), { recursive: true });
    const source = join(root, "src/demo/main.tb");
    writeFileSync(source, 'module demo.main\nstrategy Run\n    gives Text\n    do\n        give "prepared"\n');
    const first = await prepareProject({ root, mode: "write", profile: "dev" });
    assert.equal(first.status, "success", JSON.stringify(first));
    const checked = await prepareProject({ root, mode: "check", profile: "dev" });
    assert.equal(checked.status, "success", JSON.stringify(checked));
    assert.equal(checked.actions.some(action => action.kind === "would_write_air"), false);
    const prepared = readPreparedProject(root);
    assert.ok(prepared.inputs.some(input => input.path === ".touba/build/dev/air/demo/main.air.json"));
    service = createToubaProjectServer({ projectRoot: root, port: 0, quiet: true });
    await service.start();
    const url = `http://127.0.0.1:${service.server.address().port}`;
    const response = await fetch(`${url}/runs/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      schema_version: "touba-sandbox-run-request-v1", execution_kind: "entrypoint",
      target_ref: "strategy:demo.main/Run", inputs: {}, effect_policy: "runtime_only",
      requested_by: { kind: "service", id: "prepared-test" }, reason: "Run isolated preparation test",
    }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.status, "success");
    writeFileSync(source, readFileSync(source, "utf8") + "\n");
    assert.throws(() => readPreparedProject(root), { code: "ToubaServePreparedProjectInvalid" });
    const stale = await prepareProject({ root, mode: "check", profile: "dev" });
    assert.equal(stale.status, "error");
  } finally {
    await service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
