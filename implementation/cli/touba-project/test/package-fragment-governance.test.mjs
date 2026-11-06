import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newPackage, addPackage, removePackage } from "../src/packages.mjs";
import { initProject, prepareProject } from "../src/project.mjs";
import { readPackage } from "../src/package-contract.mjs";

const ref = "tool:example.records/Export";
const policy = { role: "reviewer", timeout_ms: 60000, distinct_from: "initiator" };
const json = file => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const declaration = approval => `module example.records
tool Export
    takes value as Text
    gives Text
${approval ? '    human.approve\n        with role as "reviewer"\n        with timeout_ms as 60000\n        with distinct_from as "initiator"\n' : ''}`;

async function fixture(t, { consumerPolicy } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touba-fragment-policy-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = newPackage("example.records", { root }).path;
  const packagePath = join(source, "touba.package.json");
  const pkg = json(packagePath);
  Object.assign(pkg, { publisher: "test", license: "MIT", exports: { tools: [ref] },
    handlers: [{ tool: ref, path: "handlers/export.mjs", protocol: "touba-tool-handler-v1" }] });
  save(packagePath, pkg);
  const sourcePath = join(source, "src/example/records.tb");
  writeFileSync(sourcePath, declaration(true));
  mkdirSync(join(source, "handlers"));
  writeFileSync(join(source, "handlers/export.mjs"), "throw new Error('Preparation must never execute a handler');\n");
  const project = join(root, "consumer"); mkdirSync(project); initProject({ root: project });
  mkdirSync(join(project, "src/client"), { recursive: true });
  writeFileSync(join(project, "src/client/main.tb"), `module client.main
import tool Export from example.records
strategy Run
    takes value as Text
    gives Text
    uses Export
    do
        Export
            with value as value
            into result
        give result
`);
  await addPackage(source, { root: project });
  const configPath = join(project, "touba.project.json");
  const config = json(configPath);
  config.configuration = { ...config.configuration, binding_fragments: ["bindings.json"] };
  if (consumerPolicy) config.configuration.tool_policies = { [ref]: consumerPolicy };
  save(configPath, config);
  const fragmentPath = join(project, "bindings.json");
  save(fragmentPath, { fragment_schema_version: "touba-binding-fragment-v1", source: { kind: "module", module: "example.records" },
    bindings: { [ref]: { handler: { kind: "process", command: process.execPath, args: ["packages/example.records/handlers/export.mjs"], cwd: "." },
      grants: [], secrets: [], effect_contract: { kind: "none" }, timeout_ms: 5000, max_payload_bytes: 65536 } } });
  const options = { root: project, entryRef: "strategy:client.main/Run", mode: "write" };
  const first = await prepareProject(options);
  assert.equal(first.status, "success", JSON.stringify(first.diagnostics));
  return { root: project, source, sourcePath, packagePath, configPath, fragmentPath, options, manifestPath: first.manifest_path,
    effectivePath: first.effective_project_path };
}

const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("first package fragment write is immediately checkable with exact persisted input digests", async t => {
  const f = await fixture(t);
  const manifestBefore = readFileSync(f.manifestPath), configBefore = readFileSync(f.configPath);
  const effectiveBefore = readFileSync(f.effectivePath);
  const inputs = json(f.effectivePath).inputs;
  assert.equal(inputs.find(input => input.kind === "manifest").digest_sha256, digest(manifestBefore));
  assert.equal(inputs.find(input => input.kind === "project").digest_sha256, digest(configBefore));
  const checked = await prepareProject({ ...f.options, mode: "check" });
  assert.equal(checked.status, "success", JSON.stringify(checked.diagnostics));
  const planned = await prepareProject({ ...f.options, mode: "plan" });
  assert.ok(!planned.actions.some(action => action.kind === "would_write_effective_project"));
  assert.deepEqual(readFileSync(f.manifestPath), manifestBefore);
  assert.deepEqual(readFileSync(f.configPath), configBefore);
  assert.deepEqual(readFileSync(f.effectivePath), effectiveBefore);
});

test("package fragment with versioned baselines needs one write after build cleanup", async t => {
  const f = await fixture(t);
  const configBefore = readFileSync(f.configPath);
  assert.ok(json(f.configPath).configuration.fragment_baselines.dev);
  rmSync(join(f.root, ".touba/build"), { recursive: true, force: true });
  const written = await prepareProject(f.options);
  assert.equal(written.status, "success", JSON.stringify(written.diagnostics));
  assert.deepEqual(readFileSync(f.configPath), configBefore);
  assert.equal(json(f.effectivePath).inputs.find(input => input.kind === "manifest").digest_sha256,
    digest(readFileSync(f.manifestPath)));
  const checked = await prepareProject({ ...f.options, mode: "check" });
  assert.equal(checked.status, "success", JSON.stringify(checked.diagnostics));
});

test("first package fragment write respects a predeclared consumer policy regardless of key order", async t => {
  const f = await fixture(t, { consumerPolicy: { distinct_from: "initiator", timeout_ms: 1000, role: "reviewer" } });
  assert.deepEqual(json(f.manifestPath).bindings[ref].approval_policy, { ...policy, timeout_ms: 1000 });
  const before = readFileSync(f.effectivePath);
  assert.equal(json(f.effectivePath).inputs.find(input => input.kind === "manifest").digest_sha256,
    digest(readFileSync(f.manifestPath)));
  const checked = await prepareProject({ ...f.options, mode: "check" });
  assert.equal(checked.status, "success", JSON.stringify(checked.diagnostics));
  const repeated = await prepareProject(f.options);
  assert.equal(repeated.status, "success", JSON.stringify(repeated.diagnostics));
  assert.deepEqual(readFileSync(f.effectivePath), before);
});

test("package approval with explicit fragment is idempotent and actual manifest drift stays refused", async t => {
  const f = await fixture(t);
  assert.equal(json(f.fragmentPath).bindings[ref].approval_policy, undefined);
  assert.deepEqual(json(f.manifestPath).bindings[ref].approval_policy, policy);
  const before = readFileSync(f.manifestPath, "utf8");
  for (let i = 0; i < 2; i++) for (const mode of ["plan", "write", "check"]) {
    const report = await prepareProject({ ...f.options, mode });
    assert.equal(report.diagnostics.some(d => d.severity === "error"), false, JSON.stringify(report.diagnostics));
    if (mode !== "plan") assert.equal(report.status, "success");
    assert.equal(readFileSync(f.manifestPath, "utf8"), before);
  }
  for (const tamper of [b => { delete b.approval_policy; }, b => { b.approval_policy.timeout_ms = 120000; },
    b => { b.grants = ["network"]; }, b => { b.handler.command = "/different/command"; }]) {
    const changed = JSON.parse(before); tamper(changed.bindings[ref]); save(f.manifestPath, changed);
    const tampered = readFileSync(f.manifestPath, "utf8");
    for (const mode of ["plan", "write", "check"]) {
      const report = await prepareProject({ ...f.options, mode });
      assert.ok(report.diagnostics.some(d => d.code === "BindingFragmentManifestDrift"), JSON.stringify(report.diagnostics));
      assert.equal(readFileSync(f.manifestPath, "utf8"), tampered);
    }
    writeFileSync(f.manifestPath, before);
  }
});

test("explicit fragments support reviewed package downgrade and intentional consumer policy changes", async t => {
  const f = await fixture(t);
  await removePackage("example.records", { root: f.root });
  const pkg = json(f.packagePath); pkg.version = "0.1.1"; save(f.packagePath, pkg);
  writeFileSync(f.sourcePath, declaration(false));
  await addPackage(f.source, { root: f.root });
  const refused = await prepareProject(f.options);
  assert.ok(refused.diagnostics.some(d => d.code === "PackageGovernanceReviewRequired"));
  const review = { review_packages: { "example.records": readPackage(f.packagePath).digest } };
  assert.equal((await prepareProject({ ...f.options, hostDecisions: review })).status, "success");
  assert.deepEqual(json(f.manifestPath).bindings[ref].approval_policy, policy);
  for (const mode of ["plan", "write", "check"]) {
    const repeated = await prepareProject({ ...f.options, mode });
    assert.equal(repeated.diagnostics.some(d => d.severity === "error"), false, JSON.stringify(repeated.diagnostics));
    if (mode !== "plan") assert.equal(repeated.status, "success");
  }
  for (const next of [{ ...policy, timeout_ms: 1000 }, null, policy]) {
    const hostDecisions = { tool_policies: { [ref]: next } };
    const plan = await prepareProject({ ...f.options, mode: "plan", hostDecisions });
    assert.equal(plan.diagnostics.some(d => d.severity === "error"), false, JSON.stringify(plan.diagnostics));
    const written = await prepareProject({ ...f.options, hostDecisions });
    assert.equal(written.status, "success", JSON.stringify(written.diagnostics));
    assert.deepEqual(json(f.manifestPath).bindings[ref].approval_policy, next ?? undefined);
    const checked = await prepareProject({ ...f.options, mode: "check" });
    assert.equal(checked.status, "success", JSON.stringify(checked.diagnostics));
  }
});
