import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyHostDecisions } from "../src/host-decisions.mjs";
import { prepareProject } from "../src/project.mjs";

const tool = "tool:orders.review/ReadOrder";
const agent = "agent:orders.review/Reviewer";
const source = `module orders.review
tool ReadOrder
    takes request as Text
    gives Text
    requires network, secret_read
    secrets ORDER_TOKEN
agent Reviewer
    takes request as Text
    gives Text
    responsibility "Review the order."
    uses ReadOrder
    callable_by strategy Review
strategy Review
    takes request as Text
    gives Text
    uses Reviewer
    do
        Reviewer
            with request as request
            into answer
        give answer
`;
const decisions = { bindings: { [tool]: { grants: ["network", "secret_read"], secrets: ["ORDER_TOKEN"],
  effect_contract: { kind: "none" }, timeout_ms: 7000, max_payload_bytes: 4096 } },
agent_secret_scopes: { [agent]: ["ORDER_TOKEN"] } };
function project(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-host-decisions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src/orders"), { recursive: true });
  writeFileSync(join(root, "src/orders/review.tb"), source);
  return root;
}
const manifestAt = root => join(root, ".touba/build/dev/touba.manifest.json");
const readManifest = root => JSON.parse(readFileSync(manifestAt(root), "utf8"));

test("explicit host decisions plan, write, repeat and check compiled source without granting implicitly", async t => {
  const root = project(t);
  let report = await prepareProject({ root, mode: "plan", hostDecisions: decisions });
  assert.notEqual(report.status, "error", JSON.stringify(report.diagnostics));
  assert.equal(existsSync(manifestAt(root)), false);
  const grant = report.actions.find(a => a.field === "grants");
  assert.deepEqual(grant.before, []);
  assert.deepEqual(grant.source_required, ["network", "secret_read"]);
  report = await prepareProject({ root, mode: "write", hostDecisions: decisions });
  assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
  const first = readFileSync(manifestAt(root), "utf8");
  assert.deepEqual(readManifest(root).agent_secret_scopes, decisions.agent_secret_scopes);
  for (const mode of ["write", "check"]) {
    report = await prepareProject({ root, mode, hostDecisions: decisions });
    assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
    assert.equal(report.actions.some(a => a.kind.includes("host_decision")), false);
    assert.equal(readFileSync(manifestAt(root), "utf8"), first);
  }
  report = await prepareProject({ root, mode: "check", hostDecisions: { bindings: { [tool]: { timeout_ms: 8000 } } } });
  assert.equal(report.status, "error");
  assert.ok(report.diagnostics.some(d => d.code === "HostDecisionDrift"));
  assert.equal(readFileSync(manifestAt(root), "utf8"), first);
  report = await prepareProject({ root, mode: "write", hostDecisions: { bindings: { [tool]: { timeout_ms: 8000 } } } });
  assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
  assert.deepEqual(readManifest(root).bindings[tool].grants, decisions.bindings[tool].grants);
  assert.equal(readManifest(root).bindings[tool].timeout_ms, 8000);
  // A source change is a requirement, not host consent; do not rewrite handlers.
  writeFileSync(join(root, "src/orders/review.tb"), source.replace("network, secret_read", "network, secret_read, filesystem_read"));
  report = await prepareProject({ root, mode: "write" });
  assert.ok(report.diagnostics.some(d => d.code === "ManifestGrantMissing"));
  assert.deepEqual(readManifest(root).bindings[tool].grants, decisions.bindings[tool].grants);
  report = await prepareProject({ root, mode: "check" });
  assert.equal(report.status, "error");
});

test("prepare text diagnostics expose the actual compiler source position", t => {
  const root = project(t);
  writeFileSync(join(root, "src/orders/review.tb"), 'module orders.review\nfunction Wrong\n    gives Int\n    do\n        give "wrong"\n');
  const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
  const args = [cli, "prepare", "--root", root, "--mode", "check"];
  const json = spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8" });
  assert.notEqual(json.status, 0);
  const diagnostic = JSON.parse(json.stdout).diagnostics.find(d => d.source_ref);
  assert.ok(diagnostic, json.stdout + json.stderr);
  const text = spawnSync(process.execPath, args, { encoding: "utf8" });
  const expected = diagnostic.source_ref.source_id + ":" + (diagnostic.source_ref.start_line + 1) + ":" + (diagnostic.source_ref.start_column + 1);
  assert.ok((text.stdout + text.stderr).includes(expected), text.stdout + text.stderr);
});

test("explicit revocation is persisted without refilling authority from source", async t => {
  const root = project(t);
  await prepareProject({ root, mode: "write", hostDecisions: decisions });
  const report = await prepareProject({ root, mode: "write", hostDecisions: {
    bindings: { [tool]: { grants: [], secrets: [] } }, agent_secret_scopes: { [agent]: [] },
  } });
  assert.equal(report.status, "needs_changes", JSON.stringify(report.diagnostics));
  assert.deepEqual(readManifest(root).bindings[tool].grants, []);
  assert.deepEqual(readManifest(root).agent_secret_scopes[agent], []);
  assert.equal((await prepareProject({ root, mode: "check" })).status, "error");
});

test("invalid decisions reject the entire preparation before any write", async t => {
  const root = project(t);
  const report = await prepareProject({ root, mode: "write", hostDecisions: {
    bindings: { [tool]: { ...decisions.bindings[tool], password: "must-not-appear" } },
  } });
  assert.equal(report.status, "error");
  assert.ok(report.diagnostics.some(d => d.code === "HostDecisionFieldUnknown"));
  assert.equal(report.diagnostics.find(d => d.code === "HostDecisionFieldUnknown").field, "password");
  assert.ok(report.diagnostics.find(d => d.code === "HostDecisionFieldUnknown").message.includes(tool));
  assert.equal(JSON.stringify(report).includes("must-not-appear"), false);
  assert.equal(existsSync(join(root, ".touba")), false);
  assert.equal(existsSync(join(root, "handlers")), false);
});

test("pure proposal validates every field, unknown targets, memory and fragment conflicts atomically", () => {
  const required = { bindings: { [tool]: { ...decisions.bindings[tool], memories: [{ ref: "memory:orders.review/Orders", access: "read" }] } },
    agent_secret_scopes: decisions.agent_secret_scopes };
  const current = { bindings: { [tool]: { handler: { command: "node" }, grants: [], secrets: [], memories: [], effect_contract: null } } };
  for (const patch of [null, [], { unknown: {} }, { bindings: { unknown: {} } }, { bindings: { [tool]: { handler: {} } } },
    ...[{ grants: ["network", "network"] }, { secrets: ["raw-secret-value"] }, { timeout_ms: 0 }, { timeout_ms: 1.1 },
      { max_payload_bytes: Number.MAX_SAFE_INTEGER + 1 }, { effect_contract: { kind: "external_write" } },
      { memories: [{ ref: "memory:orders.review/Orders", access: "write" }] },
      { memories: [{ ref: "memory:orders.review/Orders", access: "read" }, { access: "read", ref: "memory:orders.review/Orders" }] }].map(p => ({ bindings: { [tool]: p } })),
    { agent_secret_scopes: { [agent]: ["OTHER_TOKEN"] } }, { agent_secret_scopes: { "agent:orders.review/Unknown": [] } }]) {
    assert.throws(() => applyHostDecisions(current, patch, required), /HostDecision/u);
  }
  assert.throws(() => applyHostDecisions(current, decisions, required, new Set([tool])), /HostDecisionFragmentConflict/u);
  const result = applyHostDecisions(current, { bindings: { [tool]: { memories: required.bindings[tool].memories } } }, required);
  assert.deepEqual(result.manifest.bindings[tool].memories, required.bindings[tool].memories);
  assert.deepEqual(current.bindings[tool].memories, []);
  assert.deepEqual(result.manifest.bindings[tool].handler, current.bindings[tool].handler);
});

test("CLI accepts JSON decisions and rejects malformed input without echoing it", t => {
  const root = project(t);
  const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
  const run = value => spawnSync(process.execPath, [cli, "prepare", "--root", root, "--mode", "write", "--json", "--host-decisions-json", value], { encoding: "utf8" });
  const bad = run('{"password":"do-not-print');
  assert.notEqual(bad.status, 0);
  assert.equal((bad.stdout + bad.stderr).includes("do-not-print"), false);
  const result = run(JSON.stringify(decisions));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "success");
});
