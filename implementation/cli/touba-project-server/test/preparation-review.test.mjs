import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prepareProject } from "../../touba-project/src/project.mjs";
import { createProjectPreparation } from "../src/project-preparation.mjs";
import { preparationChanges } from "../src/preparation-review.mjs";
import { createToubaProjectServer } from "../src/serve.mjs";
import { preparationFixture, preparationTool as ref, preparationPolicy as policy, savePreparationJson as save } from "./fixtures/preparation-project.mjs";
import { validateObject } from "../../../contracts/product-surfaces/validate.mjs";
import schema from "../../../contracts/product-surfaces/schemas/touba-project-preparation-preview-v1.schema.json" with { type: "json" };
const json = file => JSON.parse(readFileSync(file, "utf8"));
async function fixture(t) { const f = await preparationFixture(); t.after(() => rmSync(f.directory, { recursive: true, force: true })); return f; }
const intent = preview => ({ schema_version: "touba-project-preparation-apply-v1", id: preview.id, review_digest: preview.review_digest });

test("reviewed preparation adopts packages once and retains consumer approval after a package removes it", async t => {
  const f = await fixture(t), service = createProjectPreparation(f.root);
  const before = readFileSync(f.configPath);
  let preview = await service.preview("owner");
  assert.deepEqual(validateObject(schema, preview), []);
  assert.equal(preview.can_apply, true, JSON.stringify(preview));
  assert.deepEqual(readFileSync(f.configPath), before, "preview does not write configuration");
  assert.equal(existsSync(join(f.root, ".touba/build/dev/touba.manifest.json")), false);
  assert.ok(preview.changes.some(c => c.field === "approval_policy" && c.after.includes("reviewer")));
  assert.equal((await service.apply("owner", intent(preview))).status, "success");
  assert.equal((await prepareProject({ root: f.root, mode: "check" })).status, "success");
  await f.removeApproval();
  preview = await service.preview("owner");
  assert.deepEqual(validateObject(schema, preview), []);
  assert.ok(preview.changes.some(c => c.field === "approval_policy" && c.before.includes("reviewer") && c.after === null));
  assert.equal((await service.apply("owner", intent(preview))).status, "success");
  assert.deepEqual(json(f.configPath).configuration.tool_policies[ref], policy);
  const manifest = json(join(f.root, ".touba/build/dev/touba.manifest.json"));
  assert.deepEqual(manifest.bindings[ref].approval_policy, policy);
  assert.deepEqual(manifest.bindings[ref].grants, []);
  assert.equal((await prepareProject({ root: f.root, mode: "check" })).status, "success");
});

test("preparation refuses another actor, expiry, replay, stale source and stale fragment before any write", async t => {
  const f = await fixture(t); let now = Date.now();
  const service = createProjectPreparation(f.root, { now: () => now });
  let p = await service.preview("owner");
  await assert.rejects(service.apply("reader", intent(p)), { code: "ToubaServePreparationReviewMissing" });
  await assert.rejects(service.apply("owner", { ...intent(p), review_digest: `sha256:${'0'.repeat(64)}` }), { code: "ProjectPreparationReviewStale" });
  now += 300001;
  await assert.rejects(service.apply("owner", intent(p)), { code: "ToubaServePreparationReviewMissing" });
  p = await service.preview("owner");
  assert.equal((await service.apply("owner", intent(p))).status, "success");
  await assert.rejects(service.apply("owner", intent(p)), { code: "ToubaServePreparationReviewMissing" });
  const source = join(f.root, "src/client/main.tb"), bytes = readFileSync(source, "utf8");
  const prepared = await prepareProject({ root: f.root, mode: "plan" });
  for (const mutate of [() => writeFileSync(source, bytes + "\n"), () => writeFileSync(prepared.run_plan_path, readFileSync(prepared.run_plan_path, "utf8") + "\n"), () => {
    const doc = json(f.fragmentPath); doc.bindings[ref].timeout_ms += 1000; save(f.fragmentPath, doc);
  }]) {
    p = await service.preview("owner");
    const config = readFileSync(f.configPath), manifestPath = join(f.root, ".touba/build/dev/touba.manifest.json"), manifest = readFileSync(manifestPath);
    mutate();
    await assert.rejects(service.apply("owner", intent(p)), { code: "ProjectPreparationReviewStale" });
    assert.deepEqual(readFileSync(f.configPath), config); assert.deepEqual(readFileSync(manifestPath), manifest);
    p = await service.preview("owner");
    assert.equal((await service.apply("owner", intent(p))).status, "success");
  }
});

test("preparation serializes concurrent writes and replaces a session's previous preview", async t => {
  const f = await fixture(t), service = createProjectPreparation(f.root);
  const obsolete = await service.preview("owner");
  const latest = await service.preview("owner");
  await assert.rejects(service.apply("owner", intent(obsolete)), { code: "ToubaServePreparationReviewMissing" });
  const applying = service.apply("owner", intent(latest));
  await assert.rejects(service.apply("owner", intent(latest)), { code: "ToubaServePreparationBusy" });
  assert.equal((await applying).status, "success");
});

test("source fragment changes are shown; a tampered generated manifest is not reconciled by confirmation", async t => {
  const f = await fixture(t), service = createProjectPreparation(f.root);
  await service.apply("owner", intent(await service.preview("owner")));
  const fragment = json(f.fragmentPath); fragment.bindings[ref].timeout_ms = 7000; save(f.fragmentPath, fragment);
  const p = await service.preview("owner");
  assert.ok(p.changes.some(c => c.field === "timeout_ms" && c.before === "5000" && c.after === "7000"));
  await service.apply("owner", intent(p));
  const path = join(f.root, ".touba/build/dev/touba.manifest.json"), manifest = json(path);
  manifest.bindings[ref].grants = ["network"]; save(path, manifest);
  const blocked = await service.preview("owner");
  assert.equal(blocked.can_apply, false);
  assert.ok(blocked.diagnostics.some(d => d.code === "BindingFragmentManifestDrift"));
  await assert.rejects(service.apply("owner", intent(blocked)), { code: "ToubaServePreparationReviewMissing" });
});

test("preparation HTTP requires authentication and rejects arbitrary commands, paths, grants and consumer overrides", async t => {
  const f = await fixture(t);
  process.env.TOUBA_PREPARATION_REVIEW_TEST = "isolated-review-token";
  t.after(() => { delete process.env.TOUBA_PREPARATION_REVIEW_TEST; });
  const server = createToubaProjectServer({ projectRoot: f.root, port: 0, quiet: true, authTokenEnv: "TOUBA_PREPARATION_REVIEW_TEST" });
  await server.start(); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const post = (path, body, auth = true) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer isolated-review-token" } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post("/project/prepare/preview", {}, false)).status, 401);
  assert.equal((await post("/project/prepare/preview", { root: "/tmp" })).status, 400);
  const preview = await (await post("/project/prepare/preview", {})).json();
  assert.deepEqual(validateObject(schema, preview), []);
  for (const field of ["root", "profile", "command", "grants", "hostDecisions", "tool_policies"]) {
    assert.equal((await post("/project/prepare/apply", { ...intent(preview), [field]: {} })).status, 400);
  }
  assert.equal((await (await post("/project/prepare/apply", intent(preview))).json()).status, "success");
  assert.notEqual((await post("/project/prepare/apply", intent(preview))).status, 200);
});

test("review projection does not expose raw host actions or handler arguments", () => {
  assert.deepEqual(preparationChanges([{ kind: "apply_host_decision", handler: { args: ["secret-value"] } }]), []);
  assert.throws(() => preparationChanges(Array.from({ length: 513 }, () => ({ kind: "review_fragment_binding", tool_ref: ref }))), { code: "ToubaServePreparationLimit" });
});

test("trigger activation is explicit, reviewed, single-use and cannot grant tool authority", async t => {
  const f = await fixture(t), service = createProjectPreparation(f.root);
  await service.apply("owner", intent(await service.preview("owner")));
  const source = join(f.root, "src/client/main.tb");
  writeFileSync(source, readFileSync(source, "utf8") + '\nstrategy Scheduled\n    gives Text\n    do\n        give "daily"\n\ntrigger Daily\n    on schedule "every 1h"\n    runs strategy Scheduled\n    limits\n        max_runs_per_day as 24\n        timeout_ms as 30000\n');
  await service.apply("owner", intent(await service.preview("owner")));
  const path = join(f.root, ".touba/build/dev/touba.manifest.json");
  const before = readFileSync(path), manifest = JSON.parse(before);
  const trigger = Object.keys(manifest.triggers).find(ref => ref.endsWith("/Daily"));
  assert.equal(manifest.triggers[trigger].enabled, false);
  const preview = await service.preview("owner", { triggers: { [trigger]: { enabled: true } } });
  assert.deepEqual(validateObject(schema, preview), []);
  assert.ok(preview.changes.some(change => change.kind === "update_trigger" && change.subject === trigger && change.before === "false" && change.after === "true"));
  assert.deepEqual(readFileSync(path), before);
  await assert.rejects(service.apply("reader", intent(preview)), { code: "ToubaServePreparationReviewMissing" });
  assert.equal((await service.apply("owner", intent(preview))).status, "success");
  const after = json(path);
  assert.equal(after.triggers[trigger].enabled, true);
  assert.deepEqual(after.bindings, manifest.bindings);
  assert.equal((await prepareProject({ root: f.root, mode: "check" })).status, "success");
  await assert.rejects(service.apply("owner", intent(preview)), { code: "ToubaServePreparationReviewMissing" });
  for (const triggers of [{ [trigger]: { enabled: true, grants: ["network"] } }, { [trigger]: { enabled: "true" } }, []]) {
    await assert.rejects(service.preview("owner", { triggers }), { code: "ToubaServePreparationInvalid" });
  }
  const unknown = await service.preview("owner", { triggers: { "trigger:foreign/Unknown": { enabled: true } } });
  assert.equal(unknown.can_apply, false);
  assert.deepEqual(json(path), after);
});

test('a reduced source trigger limit is proposed for review without increasing stricter host limits', async t => {
  const f = await fixture(t), service = createProjectPreparation(f.root);
  await service.apply('owner', intent(await service.preview('owner')));
  const source = join(f.root, 'src/client/main.tb');
  writeFileSync(source, readFileSync(source, 'utf8') + '\nstrategy Scheduled\n    gives Text\n    do\n        give "daily"\n\ntrigger Daily\n    on schedule "every 1h"\n    runs strategy Scheduled\n    limits\n        max_runs_per_day as 24\n        timeout_ms as 30000\n');
  await service.apply('owner', intent(await service.preview('owner')));
  const path = join(f.root, '.touba/build/dev/touba.manifest.json'), ref = 'trigger:client.main/Daily';
  const before = readFileSync(path);
  writeFileSync(source, readFileSync(source, 'utf8').replace('max_runs_per_day as 24', 'max_runs_per_day as 1'));
  const raw = await prepareProject({ root: f.root, mode: 'plan' });
  assert.ok(raw.diagnostics.some(item => item.code === 'ManifestTriggerInvalid'));
  assert.ok(raw.actions.some(item => item.kind === 'review_trigger_limits'));
  const preview = await service.preview('owner');
  assert.equal(preview.can_apply, true, JSON.stringify(preview.diagnostics));
  assert.deepEqual(validateObject(schema, preview), []);
  assert.deepEqual(preview.changes.find(item => item.subject === ref && item.field === 'limits'), {
    kind: 'update_trigger', subject: ref, field: 'limits',
    before: JSON.stringify({ max_runs_per_day: 24, timeout_ms: 30000 }),
    after: JSON.stringify({ max_runs_per_day: 1, timeout_ms: 30000 }),
  });
  assert.deepEqual(readFileSync(path), before, 'review has no write');
  assert.equal((await service.apply('owner', intent(preview))).status, 'success');
  assert.equal(json(path).triggers[ref].enabled, false);
  assert.equal((await prepareProject({ root: f.root, mode: 'check' })).status, 'success');
  writeFileSync(source, readFileSync(source, 'utf8').replace('max_runs_per_day as 1', 'max_runs_per_day as 50'));
  const broader = await service.preview('owner');
  assert.equal(broader.can_apply, true);
  assert.ok(broader.diagnostics.some(item => item.code === 'ManifestTriggerLimitsRetained' && item.severity === 'info'));
  assert.equal(broader.changes.some(item => item.field === 'limits'), false);
  await service.apply('owner', intent(broader));
  assert.equal(json(path).triggers[ref].limits.max_runs_per_day, 1);
  const raised = await service.preview('owner', { triggers: { [ref]: { limits: { max_runs_per_day: 40 } } } });
  assert.equal(raised.can_apply, true, JSON.stringify(raised.diagnostics));
  const change = raised.changes.find(item => item.subject === ref && item.field === 'limits');
  assert.equal(JSON.parse(change.before).max_runs_per_day, 1);
  assert.equal(JSON.parse(change.after).max_runs_per_day, 40);
  assert.equal(json(path).triggers[ref].limits.max_runs_per_day, 1, 'raising a limit only previews');
  assert.equal((await service.apply('owner', intent(raised))).status, 'success');
  assert.equal(json(path).triggers[ref].limits.max_runs_per_day, 40);
  assert.equal(json(path).triggers[ref].enabled, false, 'reviewing limits grants no activation');
  const excessive = await service.preview('owner', { triggers: { [ref]: { limits: { max_runs_per_day: 51 } } } });
  assert.equal(excessive.can_apply, false);
  assert.ok(excessive.diagnostics.some(item => item.code === 'HostDecisionLimitInvalid'));
  for (const limits of [{ max_runs_per_day: -1 }, { timeout_ms: 0 }, { timeout_ms: 1.5 }, { arbitrary: 5 }, {}]) {
    await assert.rejects(service.preview('owner', { triggers: { [ref]: { limits } } }), { code: 'ToubaServePreparationInvalid' });
  }
});
