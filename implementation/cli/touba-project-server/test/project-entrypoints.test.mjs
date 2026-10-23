import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { initProject, prepareProject, resolveProjectRunArgs } from "../../touba-project/src/project.mjs";
import { projectEntrypoints } from "../../touba-project/src/project-entrypoints.mjs";
import { createToubaProjectServer } from "../src/serve.mjs";

test("project admission rejects malformed lists and direct agents", () => {
  for (const config of [{ entrypoints: "strategy:demo.main/Run" }, { entry: "agent:demo.main/Reader" },
    { entrypoints: ["strategy:demo.main/Run", "strategy:demo.main/Run"] }, { entrypoints: ["*"] }]) {
    assert.throws(() => projectEntrypoints(config), { code: "ProjectEntrypointsInvalid" });
  }
  assert.deepEqual(projectEntrypoints({}), []);
});

test("prepared CLI and HTTP expose only declared entries across modules, before any provider call", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-entry-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject({ root });
  mkdirSync(join(root, "src/demo"), { recursive: true });
  writeFileSync(join(root, "src/demo/first.tb"), `module demo.first
agent Reader
    gives Text
    responsibility "Return a typed answer."
    callable_by strategy First
tool Write
    gives Text
strategy First
    gives Text
    do
        give "first"
function Hidden
    gives Text
    do
        give "hidden"
`);
  writeFileSync(join(root, "src/demo/second.tb"), `module demo.second
strategy Second
    gives Text
    do
        give "second"
`);
  const configPath = join(root, "touba.project.json");
  const config = JSON.parse(readFileSync(configPath));
  config.entry = "strategy:demo.first/First";
  config.entrypoints = [config.entry, "strategy:demo.second/Second"];
  writeFileSync(configPath, JSON.stringify(config));
  const hostDecisions = { bindings: { "tool:demo.first/Write": {
    grants: [], effect_contract: { kind: "external_write", retry_mode: "none" },
  } } };
  const prepared = await prepareProject({ root, mode: "write", hostDecisions });
  assert.equal(prepared.status, "success", JSON.stringify(prepared));
  const manifest = JSON.parse(readFileSync(prepared.manifest_path));
  const marker = join(root, "forbidden-handler-called");
  const handlerPath = join(root, manifest.bindings["tool:demo.first/Write"].handler.args[0]);
  writeFileSync(handlerPath, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
process.stdout.write(JSON.stringify({ok:true,value:"wrote"}));
`);
  assert.equal((await prepareProject({ root, mode: "check", hostDecisions })).status, "success");
  for (const [ref, value] of [[config.entry, "first"], [config.entrypoints[1], "second"]]) {
    const args = resolveProjectRunArgs(["--project", root, "--entry", ref, "--output", "result"]);
    const cli = new URL("../../touba-run/src/run.mjs", import.meta.url).pathname;
    assert.match(execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" }), new RegExp(value));
  }
  let providerCalls = 0;
  const service = createToubaProjectServer({ projectRoot: root, port: 0, quiet: true,
    agentDecisionProvider: () => { providerCalls++; assert.fail("must not call a direct agent"); } });
  await service.start();
  t.after(() => service.stop());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const project = await (await fetch(`${base}/project`)).json();
  assert.deepEqual(project.entrypoints.map(item => item.ref).sort(), [...config.entrypoints].sort());
  for (const ref of ["agent:demo.first/Reader", "function:demo.first/Hidden", "tool:demo.first/Write"]) {
    const response = await fetch(`${base}/runs/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      schema_version: "touba-sandbox-run-request-v1", execution_kind: "entrypoint", target_ref: ref,
      inputs: {}, effect_policy: "allow_declared_external_effects", requested_by: { kind: "service", id: "isolated-test" }, reason: "Verify entry admission",
    }) });
    assert.notEqual(response.status, 200);
    assert.match(JSON.stringify(await response.json()), /ProjectEntrypointNotAllowed/);
  }
  assert.equal(providerCalls, 0);
  assert.equal(existsSync(marker), false, "declared and configured write handler must never start");
});
