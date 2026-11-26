import test from "node:test";
import { spawnSync } from 'node:child_process';
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, prepareProject, renderReport } from "../src/project.mjs";
import { fragmentContract, normalizeFragmentBaselines } from "../src/fragment-governance.mjs";
import { fileURLToPath } from "node:url";


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

test('known fragment projection restores atomically with a reason and exact single-use digest', async t => {
  const f = await fixture(t), original = readFileSync(f.manifestPath, 'utf8');
  const manifest = json(f.manifestPath); manifest.bindings[ref].timeout_ms = 555;
  manifest.bindings[ref].handler.args = ['private-synthetic-value']; save(f.manifestPath, manifest);
  const plan = await prepareProject({ ...f.options, mode: 'plan' }); refused(plan, 'BindingFragmentManifestDrift');
  const restore = plan.actions.find(item => item.kind === 'restore_fragment_binding'); assert.ok(restore);
  assert.equal(JSON.stringify(plan.actions).includes('private-synthetic-value'), false);
  const hostDecisions = { restore_fragments: { [ref]: { digest: restore.digest, reason: 'Restore the reviewed declaration' } } };
  const reviewed = await prepareProject({ ...f.options, mode: 'plan', hostDecisions }); good(reviewed);
  const result = await prepareProject({ ...f.options, mode: 'write', hostDecisions, expectedReviewDigest: reviewed.review_digest }); good(result);
  assert.equal(readFileSync(f.manifestPath, 'utf8'), original);
  const receipt = json(join(f.root, '.touba/change-transactions', result.restoration.transaction_id, 'journal.json'));
  assert.equal(receipt.status, 'committed'); assert.equal(receipt.reason, 'Restore the reviewed declaration');
  assert.equal(JSON.stringify(receipt).includes('private-synthetic-value'), false);
  good(await prepareProject({ ...f.options, mode: 'check' }));
  refused(await prepareProject({ ...f.options, mode: 'write', hostDecisions }), 'BindingFragmentReviewStale');
});

test('restoration never combines unrelated source changes or grants with recovery', async t => {
  const f = await fixture(t), manifest = json(f.manifestPath); manifest.bindings[ref].timeout_ms = 555; save(f.manifestPath, manifest);
  const original = readFileSync(f.manifestPath, 'utf8');
  const plan = await prepareProject({ ...f.options, mode: 'plan' });
  const restore = plan.actions.find(item => item.kind === 'restore_fragment_binding');
  const hostDecisions = { restore_fragments: { [ref]: { digest: restore.digest, reason: 'Synthetic restoration' } } };
  const path = join(f.root, 'src/fragment/demo.tb'); writeFileSync(path, readFileSync(path, 'utf8') + '\n');
  refused(await prepareProject({ ...f.options, mode: 'write', hostDecisions }), 'BindingFragmentRestoreUnavailable');
  assert.equal(readFileSync(f.manifestPath, 'utf8'), original);
  for (const restores of [{ [ref]: restore.digest }, { [ref]: { digest: restore.digest, reason: '' } },
    { 'tool:foreign/Run': { digest: restore.digest, reason: 'Unreviewed target' } }]) {
    refused(await prepareProject({ ...f.options, mode: 'write', hostDecisions: { restore_fragments: restores } }), 'BindingFragmentRestoreInvalid');
  }
});

test('CLI restores the same known projection through explicit host decisions', async t => {
  const f = await fixture(t), manifest = json(f.manifestPath); manifest.bindings[ref].timeout_ms = 123; save(f.manifestPath, manifest);
  const plan = await prepareProject({ ...f.options, mode: 'plan' });
  const digest = plan.actions.find(item => item.kind === 'restore_fragment_binding').digest;
  save(join(f.root, 'restore.json'), { restore_fragments: { [ref]: { digest, reason: 'Reviewed CLI recovery' } } });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'prepare', '--root', f.root,
    '--entry', f.options.entryRef, '--mode', 'write', '--host-decisions', 'restore.json', '--json'], { cwd: f.root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(json(f.manifestPath).bindings[ref].timeout_ms, 10000);
  assert.ok(JSON.parse(result.stdout).restoration.transaction_id.startsWith('restore-'));
});
