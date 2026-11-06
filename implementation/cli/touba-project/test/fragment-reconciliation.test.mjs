import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, prepareProject, renderReport } from "../src/project.mjs";
import { fragmentContract, normalizeFragmentBaselines } from "../src/fragment-governance.mjs";

const ref = "tool:fragment.demo/Read";
const json = path => JSON.parse(readFileSync(path, "utf8"));
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-fragment-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject({ root }); mkdirSync(join(root, "src/fragment"), { recursive: true });
  writeFileSync(join(root, "src/fragment/demo.tb"), `module fragment.demo
tool Read
    gives Text
strategy Run
    gives Text
    uses Read
    do
        Read
            into result
        give result
`);
  const configPath = join(root, "touba.project.json"), fragmentPath = join(root, "binding.json");
  const cfg = json(configPath); cfg.configuration = { binding_fragments: ["binding.json"] }; save(configPath, cfg);
  const fragment = { fragment_schema_version: "touba-binding-fragment-v1", source: { kind: "module", module: "fragment.demo" },
    bindings: { [ref]: { handler: { kind: "process", command: process.execPath, args: ["never.mjs"], cwd: "." },
      grants: [], secrets: [], timeout_ms: 10000, max_payload_bytes: 65536, effect_contract: { kind: "none" } } } };
  save(fragmentPath, fragment);
  writeFileSync(join(root, "never.mjs"), "throw new Error('prepare must never run handlers');\n");
  const options = { root, entryRef: "strategy:fragment.demo/Run" };
  const prepared = await prepareProject({ ...options, mode: "write" });
  assert.equal(prepared.status, "success", JSON.stringify(prepared.diagnostics));
  return { root, options, configPath, fragmentPath, manifestPath: prepared.manifest_path, fragment };
}
const good = report => assert.equal(report.diagnostics.some(d => d.severity === "error"), false, JSON.stringify(report.diagnostics));
const refused = (report, code) => assert.ok(report.diagnostics.some(d => d.code === code), JSON.stringify(report.diagnostics));

test("fragment source edits are planned, written and checked without deleting build artifacts", async t => {
  const f = await fixture(t);
  for (const patch of [{ timeout_ms: 20000 }, { sandbox: { required: true, write_paths: [] } },
    { handler: { kind: "process", command: process.execPath, args: ["other.mjs"], cwd: "." } }, { grants: ["network"] }]) {
    const before = readFileSync(f.manifestPath, "utf8"), configBefore = readFileSync(f.configPath, "utf8");
    Object.assign(f.fragment.bindings[ref], patch); save(f.fragmentPath, f.fragment);
    const plan = await prepareProject({ ...f.options, mode: "plan" }); good(plan);
    assert.ok(plan.actions.some(a => a.kind === "would_update_fragment_binding" && a.field === Object.keys(patch)[0]));
    if (patch.timeout_ms) assert.match(renderReport(plan), /timeout_ms: 10000 -> 20000/);
    refused(await prepareProject({ ...f.options, mode: "check" }), "BindingFragmentChangePending");
    assert.equal(readFileSync(f.manifestPath, "utf8"), before); assert.equal(readFileSync(f.configPath, "utf8"), configBefore);
    good(await prepareProject({ ...f.options, mode: "write" })); good(await prepareProject({ ...f.options, mode: "check" }));
    const repeated = await prepareProject({ ...f.options, mode: "write" }); good(repeated);
    assert.ok(!repeated.actions.some(a => a.kind === "update_fragment_binding"));
  }
});

test("manifest tampering stays refused even alongside a fragment edit or a removed binding", async t => {
  const f = await fixture(t), original = readFileSync(f.manifestPath, "utf8");
  f.fragment.bindings[ref].timeout_ms = 20000; save(f.fragmentPath, f.fragment);
  for (const change of [m => { m.bindings[ref].grants = ["network"]; }, m => { delete m.bindings[ref]; }]) {
    const changed = JSON.parse(original); change(changed); save(f.manifestPath, changed);
    const before = readFileSync(f.configPath, "utf8");
    for (const mode of ["plan", "write", "check"]) refused(await prepareProject({ ...f.options, mode }), "BindingFragmentManifestDrift");
    assert.equal(readFileSync(f.configPath, "utf8"), before);
  }
});

test("fragment changes remain visible after deleting only the generated build", async t => {
  const f = await fixture(t);
  rmSync(join(f.root, ".touba/build"), { recursive: true, force: true });
  f.fragment.bindings[ref].timeout_ms = 20000; save(f.fragmentPath, f.fragment);
  const plan = await prepareProject({ ...f.options, mode: "plan" }); good(plan);
  const change = plan.actions.find(a => a.kind === "would_update_fragment_binding" && a.field === "timeout_ms");
  assert.match(change.before, /^sha256:/); assert.equal(change.after, 20000);
  // Check also refuses the missing generated artifacts before reconciliation.
  refused(await prepareProject({ ...f.options, mode: "check" }), "ManifestMissing");
  good(await prepareProject({ ...f.options, mode: "write" })); good(await prepareProject({ ...f.options, mode: "check" }));
});

test("legacy fragment reconciliation requires the exact reviewed plan and rejects stale reviews", async t => {
  const f = await fixture(t), config = json(f.configPath); delete config.configuration.fragment_baselines; save(f.configPath, config);
  refused(await prepareProject({ ...f.options, mode: "check" }), "BindingFragmentBaselineMissing");
  good(await prepareProject({ ...f.options, mode: "write" }));
  good(await prepareProject({ ...f.options, mode: "check" }));
  save(f.configPath, config);
  f.fragment.bindings[ref].timeout_ms = 20000; save(f.fragmentPath, f.fragment);
  const plan = await prepareProject({ ...f.options, mode: "plan" }); refused(plan, "BindingFragmentManifestDrift");
  const review = plan.actions.find(a => a.kind === "review_fragment_binding"); assert.ok(review.changed_fields.includes("timeout_ms"));
  const hostDecisions = { review_fragments: { [ref]: review.digest } };
  for (const review_fragments of [[], { [ref]: "invalid" }, { "tool:unknown/Read": review.digest }]) {
    refused(await prepareProject({ ...f.options, mode: "write", hostDecisions: { review_fragments } }), "BindingFragmentReviewInvalid");
  }
  f.fragment.bindings[ref].timeout_ms = 30000; save(f.fragmentPath, f.fragment);
  refused(await prepareProject({ ...f.options, mode: "write", hostDecisions }), "BindingFragmentReviewStale");
  f.fragment.bindings[ref].timeout_ms = 20000; save(f.fragmentPath, f.fragment);
  good(await prepareProject({ ...f.options, mode: "write", hostDecisions })); good(await prepareProject({ ...f.options, mode: "check" }));
  refused(await prepareProject({ ...f.options, mode: "write", hostDecisions }), "BindingFragmentReviewStale");
});

test("fragment baselines are separated by profile and bound strictly without private content", async t => {
  const f = await fixture(t), config = json(f.configPath);
  config.run_profiles.staging = structuredClone(config.run_profiles.dev); save(f.configPath, config);
  const before = config.configuration.fragment_baselines.dev;
  good(await prepareProject({ ...f.options, runProfile: "staging", mode: "write" }));
  f.fragment.bindings[ref].timeout_ms = 20000; save(f.fragmentPath, f.fragment);
  good(await prepareProject({ ...f.options, runProfile: "staging", mode: "write" }));
  assert.deepEqual(json(f.configPath).configuration.fragment_baselines.dev, before);
  refused(await prepareProject({ ...f.options, mode: "check" }), "BindingFragmentChangePending");
  const fingerprint = fragmentContract({ handler: { args: ["private-synthetic-argument"] } });
  assert.deepEqual(fragmentContract({ handler: { command: "node", args: [] }, timeout_ms: 1 }),
    fragmentContract({ timeout_ms: 1, handler: { args: [], command: "node" } }));
  assert.ok(!JSON.stringify(fingerprint).includes("private-synthetic-argument"));
  for (const invalid of [[], { dev: { [ref]: { ...fingerprint, arbitrary: true } } },
    { dev: { [ref]: { ...fingerprint, digest: "sha256:" + "0".repeat(64) } } }]) {
    assert.throws(() => normalizeFragmentBaselines(invalid), { code: "BindingFragmentBaselineInvalid" });
  }
});
