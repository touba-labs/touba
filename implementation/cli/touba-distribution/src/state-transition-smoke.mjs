// Executed by the installed (then preserved) Node, never by the source runtime.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [toolchain, root, mode] = process.argv.slice(2);
const { createToubaProjectServer } = await import(pathToFileURL(join(toolchain, "lib/cli/touba-project-server/src/serve.mjs")));
const user = "user:transition", device = "device:transition";
const marker = join(root, "external-effect.txt");
if (mode === "pause") {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".touba/air"), { recursive: true });
  const source = join(root, "src/transition.tb");
  writeFileSync(source, `module transition
tool Commit
    description "Record the authorized isolated effect."
    gives Text
strategy Run
    gives Text
    uses Commit
    do
        human.approve
            with context as "Isolated transition"
            into approval
        Commit
            into result
        give result
`);
  const air = execFileSync(process.execPath, [join(toolchain, "lib/cli/touba-project/src/main.mjs"), "compile", source, "--stdout"], { encoding: "utf8" });
  writeFileSync(join(root, ".touba/air/transition.air.json"), air);
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entry: "strategy:transition/Run" }));
  writeFileSync(join(root, "handler.mjs"), `import {appendFileSync} from "node:fs";
let raw="";for await(const chunk of process.stdin)raw+=chunk;const r=JSON.parse(raw);
appendFileSync(${JSON.stringify(marker)},"applied\\n");
process.stdout.write(JSON.stringify({ok:true,value:"committed",effect_receipt:{effect_id:r.effect.effect_id,request_digest:r.effect.request_digest,outcome:"applied"}}));`);
  writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:transition/Commit": { handler: { kind: "process", command: process.execPath, args: [join(root, "handler.mjs")] },
      grants: [], timeout_ms: 3000, max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } },
  } }));
  writeFileSync(join(root, ".touba/product-identity.json"), JSON.stringify({
    schema_version: "touba-product-identity-v1", generated_at: new Date().toISOString(),
    summary: { user_count: 1, team_count: 1, device_count: 1, active_assignment_count: 0, revoked_device_count: 0 },
    users: [{ user_ref: user, display_name: "Isolated reviewer", email: null, status: "active", team_refs: ["team:test"], role_refs: ["role:reviewer"] }],
    teams: [{ team_ref: "team:test", name: "Isolated", owner_refs: [user] }],
    roles: [{ role_ref: "role:reviewer", name: "Reviewer", scope: "human_decision" }],
    devices: [{ device_ref: device, user_ref: user, kind: "studio", status: "paired", paired_at: new Date().toISOString(), revoked_at: null }],
    sessions: [], assignments: [], escalation_policies: [], events: [],
  }));
}
const service = createToubaProjectServer({ projectRoot: root, port: 0, quiet: true });
try {
  await service.start();
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const post = async (path, value) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  if (mode === "pause") {
    const denied = await post("/runs/sandbox", { schema_version: "touba-sandbox-run-request-v1", execution_kind: "entrypoint",
      target_ref: "tool:transition/Commit", effect_policy: "allow_declared_external_effects", inputs: {},
      requested_by: { kind: "studio", id: "isolated-transition" }, reason: "Check undeclared entry refusal." });
    assert.equal(denied.status, 403, await denied.clone().text());
    assert.equal((await denied.json()).code, "ProjectEntrypointNotAllowed");
    assert.equal(existsSync(marker), false);
    const response = await post("/runs/sandbox", { schema_version: "touba-sandbox-run-request-v1", execution_kind: "entrypoint",
      target_ref: "strategy:transition/Run", effect_policy: "allow_declared_external_effects", inputs: {},
      requested_by: { kind: "studio", id: "isolated-transition" }, reason: "Check installed-build preservation." });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, "stopped");
    const pending = await (await fetch(base + "/approvals/pending/current")).json();
    writeFileSync(join(root, "pending.json"), JSON.stringify(pending));
    assert.equal(existsSync(marker), false);
  } else {
    const pending = JSON.parse(readFileSync(join(root, "pending.json"), "utf8"));
    const response = await post("/decisions", { schema_version: "touba-approval-decision-v1", request_id: pending.request_id,
      run_id: pending.run_id, trace_ref: pending.trace_ref, user_ref: user, device_ref: device,
      decision: "approve", decided_by: user, decided_at: new Date().toISOString(), comment: null, client_ref: "transition" });
    assert.equal(response.status, 202, await response.clone().text());
    const resumed = await post("/runs/sandbox/resume", { request_id: pending.request_id });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const result = await resumed.json();
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.run_id, pending.run_id);
    assert.equal(result.result, "committed");
    assert.equal(readFileSync(marker, "utf8"), "applied\n");
    await post("/runs/sandbox/resume", { request_id: pending.request_id });
    assert.equal(readFileSync(marker, "utf8"), "applied\n");
  }
} finally { await service.stop(); }
console.log(`STATE_TRANSITION_${mode.toUpperCase()}_OK`);
