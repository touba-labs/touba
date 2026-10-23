import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyHostDecisions, readHostDecisionsFile } from "../src/host-decisions.mjs";
import { prepareProject } from "../src/project.mjs";
import { inspectExplicitArtifacts } from "../../touba-inspect/src/inspect.mjs";

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

test("obsolete bindings require an explicit removal and active resources cannot be removed", async t => {
  const root = project(t);
  const initial = await prepareProject({ root, mode: "write", hostDecisions: decisions });
  assert.equal(initial.status, "success", JSON.stringify(initial.diagnostics));
  const before = readFileSync(manifestAt(root), "utf8");
  writeFileSync(join(root, "src/orders/review.tb"), "module orders.review\nstrategy Review\n    takes request as Text\n    gives Text\n    do\n        give request\n");
  assert.equal((await prepareProject({ root, mode: "write" })).status, "error");
  assert.equal(readFileSync(manifestAt(root), "utf8"), before);
  const removal = { remove_bindings: [tool] };
  const plan = await prepareProject({ root, mode: "plan", hostDecisions: removal });
  assert.equal(plan.diagnostics.some(d => d.severity === "error"), false, JSON.stringify(plan.diagnostics));
  assert.ok(plan.actions.some(action => action.field === "remove_binding"));
  assert.equal(readFileSync(manifestAt(root), "utf8"), before);
  const written = await prepareProject({ root, mode: "write", hostDecisions: removal });
  assert.equal(written.status, "success", JSON.stringify(written.diagnostics));
  assert.deepEqual(readManifest(root).bindings, {});
  const absent = { bindings: {} };
  assert.deepEqual(applyHostDecisions(absent, removal, absent).changes, []);
  assert.throws(() => applyHostDecisions({ bindings: { [tool]: {} } }, removal, { bindings: { [tool]: {} } }), /HostDecisionRemovalConflict/);
  assert.throws(() => applyHostDecisions(absent, { remove_bindings: [tool, tool] }, absent), /HostDecisionRemovalInvalid/);
});

test("module decisions grant only the explicit intersection and exact bindings can revoke", () => {
  const second = "tool:orders.review/Pure";
  const foreign = "tool:orders.review_extra/Write";
  const required = { bindings: { [tool]: { grants: ["network", "secret_read"], secrets: ["TOKEN"] },
    [second]: { grants: [], secrets: [] }, [foreign]: { grants: ["network"] } } };
  const current = { bindings: Object.fromEntries(Object.keys(required.bindings).map(ref => [ref, {grants: [], secrets: []}])) };
  const patch = { modules: { "orders.review": {grants: ["network"], secrets: ["TOKEN"], timeout_ms: 9000} },
    bindings: {[tool]: {grants: []}} };
  const result = applyHostDecisions(current, patch, required);
  assert.deepEqual(result.manifest.bindings[tool].grants, []);
  assert.deepEqual(result.manifest.bindings[second].grants, []);
  assert.deepEqual(result.manifest.bindings[second].secrets, []);
  assert.equal(result.manifest.bindings[second].timeout_ms, 9000);
  assert.equal(result.manifest.bindings[foreign].timeout_ms, undefined);
  assert.equal(current.bindings[second].timeout_ms, undefined);
  for (const modules of [{"orders": {}}, {"orders.review": {grants: ["filesystem_write"]}},
    {"orders.review": {effect_contract: {kind: "none"}}}, {"orders.review": {grants: ["network", "network"]}}]) {
    assert.throws(() => applyHostDecisions(current, {modules}, required), /HostDecision/);
  }
  assert.throws(() => applyHostDecisions(current, patch, required, new Set([second])), /HostDecisionFragmentConflict/);
});

test("explicit process handlers are atomic, validated and independent of grants", () => {
  const required = { bindings: { [tool]: { grants: ["network"], secrets: [] } } };
  const current = { bindings: { [tool]: { grants: [], handler: { kind: "process", command: "old", args: [] } } } };
  const handler = { kind: "process", command: "./.venv/bin/python", args: ["-B", "-m", "handlers.review"], cwd: "../../.." };
  const decisions = { bindings: { [tool]: { handler } } };
  const selected = applyHostDecisions(current, decisions, required);
  assert.deepEqual(selected.manifest.bindings[tool].handler, handler);
  assert.deepEqual(selected.manifest.bindings[tool].grants, []);
  assert.equal(current.bindings[tool].handler.command, "old");
  assert.equal(applyHostDecisions(selected.manifest, decisions, required).changes.length, 0);
  for (const bad of [null, [], { ...handler, kind: "shell" }, { ...handler, command: " " },
    { ...handler, command: "python\0" }, { ...handler, args: [1] }, { ...handler, args: ["x\0"] },
    { ...handler, cwd: "" }, { ...handler, env: { SECRET: "not allowed" } }]) {
    assert.throws(() => applyHostDecisions(current, { bindings: { [tool]: { handler: bad } } }, required), /HostDecision/);
  }
  assert.throws(() => applyHostDecisions(current, { bindings: { [tool]: { handler, package_handler: "example.python" } } }, required), /HostDecisionHandlerConflict/);
  assert.throws(() => applyHostDecisions(current, decisions, required, new Set([tool])), /HostDecisionFragmentConflict/);
});

test("prepare persists an explicit process command without creating an unused stub", async t => {
  const root = project(t);
  const handler = { kind: "process", command: "./.venv/bin/python", args: ["-B", "-m", "handlers.review"], cwd: "../../.." };
  const selected = structuredClone(decisions);
  selected.bindings[tool].handler = handler;
  const result = await prepareProject({ root, mode: "write", hostDecisions: selected });
  assert.notEqual(result.status, "error", JSON.stringify(result.diagnostics));
  assert.deepEqual(readManifest(root).bindings[tool].handler, handler);
  assert.equal(result.actions.some(action => action.kind === "create_handler_stub"), false);
  assert.equal(existsSync(join(root, "handlers/orders/review/read_order.handler.mjs")), false);
});

test("an explicit python -m handler runs in a spaced project path without bytecode", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba module handler "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src/examples"), { recursive: true });
  writeFileSync(join(root, "src/examples/module_handler.tb"), `module examples.module_handler
tool Echo
    takes value as Text
    gives Text
`);
  mkdirSync(join(root, "handlers"));
  writeFileSync(join(root, "handlers/__init__.py"), "");
  writeFileSync(join(root, "handlers/helper.py"), "def echo(value):\n    return value\n");
  writeFileSync(join(root, "handlers/echo.py"), `import json, sys
from .helper import echo
assert sys.dont_write_bytecode
request = json.load(sys.stdin)
print(json.dumps({"ok": True, "value": echo(request["arguments"]["value"])}))
`);
  const python = process.env.TOUBA_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const resolved = spawnSync(python, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(resolved.status, 0, resolved.stderr);
  const prepared = await prepareProject({
    root, mode: "write", entryRef: "tool:examples.module_handler/Echo",
    hostDecisions: {
      bindings: {
        "tool:examples.module_handler/Echo": {
          handler: { kind: "process", command: resolved.stdout.trim(), args: ["-m", "handlers.echo"], cwd: "../../.." },
          effect_contract: { kind: "none" },
        },
      },
    },
  });
  assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
  const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "run", "--project", root, "--inputs-json", '{"value":"module works"}', "--output", "json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(JSON.parse(run.stdout).result, "module works");
  assert.equal(existsSync(join(root, "handlers/__pycache__")), false);
  const inspection = inspectExplicitArtifacts({
    air: join(root, ".touba/build/dev/air/examples/module_handler.air.json"),
    run_plan: join(root, ".touba/build/dev/touba.run-plan.json"),
  });
  assert.equal(inspection.run_plan.entry_ref, "tool:examples.module_handler/Echo");
  assert.doesNotMatch(JSON.stringify(inspection), /RunPlanEntryUnknown/);
});

test("host decision files are bounded JSON objects and resolve against the project root", t => {
  const root = project(t);
  const path = join(root, "host-decisions.json");
  const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
  const args = [cli, "prepare", "--host-decisions", "host-decisions.json", "--root", root, "--mode", "write", "--json"];
  for (const input of ["[]", "null", '{"secret":"do-not-echo', " ".repeat(65537)]) {
    writeFileSync(path, input);
    assert.throws(() => readHostDecisionsFile(path), /HostDecisionFileInvalid/);
    const failed = spawnSync(process.execPath, args, {encoding: "utf8"});
    assert.notEqual(failed.status, 0);
    assert.equal((failed.stdout + failed.stderr).includes("do-not-echo"), false);
    assert.equal(existsSync(manifestAt(root)), false);
  }
  assert.throws(() => readHostDecisionsFile(root), /HostDecisionFileInvalid/);
  writeFileSync(path, JSON.stringify(decisions));
  for (const extra of [["--host-decisions", path], ["--host-decisions-json", "{}"]]) {
    assert.notEqual(spawnSync(process.execPath, [...args, ...extra], {encoding: "utf8"}).status, 0);
  }
  const result = spawnSync(process.execPath, args, {encoding: "utf8"});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readManifest(root).bindings[tool].grants, decisions.bindings[tool].grants);
});

test("unknown project keys fail explicitly without writing preparation artifacts", async t => {
  for (const extra of [{contexts: ["context.json"]}, {unknown_key: true}, {configuration: {contexts: [], typo: []}}]) {
    const root = project(t);
    const path = join(root, "touba.project.json");
    const bytes = JSON.stringify({project_version: "touba-project-v1", artifact_layout: "touba-artifacts-v1", language: "javascript", sdk: "@touba/sdk", ...extra});
    writeFileSync(path, bytes);
    const result = await prepareProject({root, mode: "write"});
    assert.equal(result.status, "error");
    assert.ok(result.diagnostics.some(d => d.code === "ProjectConfigFieldUnknown"), JSON.stringify(result.diagnostics));
    if (extra.contexts) assert.match(JSON.stringify(result.diagnostics), /configuration.contexts/);
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.equal(existsSync(manifestAt(root)), false);
  }
});

test("sandbox host decisions preserve omitted inventory and reject invalid fields", () => {
  const required = {bindings: {[tool]: {grants: [], secrets: []}}};
  const current = {bindings: {[tool]: {sandbox: {required: true, code_paths: ["sdk.mjs"]}}}};
  const changed = applyHostDecisions(current, {bindings: {[tool]: {sandbox: {read_paths: ["data.json"]}}}}, required);
  assert.deepEqual(changed.manifest.bindings[tool].sandbox, {required: true, code_paths: ["sdk.mjs"], read_paths: ["data.json"]});
  assert.equal(current.bindings[tool].sandbox.read_paths, undefined);
  for (const sandbox of [{required: "true"}, {profile: "unrestricted"}, {code_paths: "file.mjs"}, {read_paths: [null]}, {allow_all: true}]) {
    assert.throws(() => applyHostDecisions(current, {bindings: {[tool]: {sandbox}}}, required), /HostDecision/);
  }
});

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
