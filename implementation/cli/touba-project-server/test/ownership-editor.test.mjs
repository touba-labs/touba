import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject, prepareProject } from '../../touba-project/src/project.mjs';
import { createOwnershipEditor } from '../src/ownership-editor.mjs';
import { readOwnershipReadiness } from '../src/ownership-readiness.mjs';
import { createToubaProjectServer, requiredIdentityPermission } from '../src/serve.mjs';
import { projectActivityKind } from '../src/project-activity.mjs';
import { assertApplicationRoute } from '../src/application-access.mjs';
import { validateObject } from '../../../contracts/product-surfaces/validate.mjs';
import stateSchema from '../../../contracts/product-surfaces/schemas/touba-ownership-state-v1.schema.json' with { type: 'json' };
import previewSchema from '../../../contracts/product-surfaces/schemas/touba-ownership-preview-v1.schema.json' with { type: 'json' };
const source = 'module app.main\ntool Read\n    gives Text\nfunction Ready\n    gives Text\n    do\n        give "ready"\n';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-ownership-editor-')));
  initProject({ root, language: 'javascript' });
  mkdirSync(join(root, 'src/app'), { recursive: true }); writeFileSync(join(root, 'src/app/main.tb'), source);
  const config = JSON.parse(readFileSync(join(root, 'touba.project.json'))); config.entry = 'function:app.main/Ready';
  writeFileSync(join(root, 'touba.project.json'), JSON.stringify(config));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
const application = preview => ({ id: preview.id, review_digest: preview.review_digest, reason: 'Synthetic ownership qualification' });
function editor(root, now = Date.now) {
  return createOwnershipEditor(root, { now, apply(args) {
    for (const item of args.targets) { mkdirSync(dirname(join(root, item.path)), { recursive: true }); writeFileSync(join(root, item.path), item.content); }
    const path = join(root, '.touba/change-transactions', args.transaction_id, 'journal.json'); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ transaction_id: args.transaction_id, status: 'committed', review_evidence: args.review_evidence }));
    return { transaction_id: args.transaction_id };
  } });
}
async function apply(editor, body, user = 'user:alice') {
  const preview = await editor.preview('alice-session', user, body);
  assert.deepEqual(validateObject(previewSchema, preview), []);
  return editor.apply('alice-session', user, application(preview), body.action === 'review');
}

test('ownership edits are reviewed, explicit, revision-bound and confer no runtime authority', async t => {
  const root = fixture(t), service = editor(root);
  assert.deepEqual(validateObject(stateSchema, await service.read()), []);
  const preview = await service.preview('alice-session', 'user:alice', { action: 'team', team_ref: 'team:maintainers', members: ['user:alice'] });
  assert.equal(existsSync(join(root, 'touba.ownership.json')), false);
  await assert.rejects(service.apply('bob-session', 'user:alice', application(preview), false), { code: 'OwnershipReviewMissing' });
  await service.apply('alice-session', 'user:alice', application(preview), false);
  await assert.rejects(service.apply('alice-session', 'user:alice', application(preview), false), { code: 'OwnershipReviewMissing' });
  await apply(service, { action: 'assign', target_ref: 'module:app.main', teams: ['team:maintainers'] });
  await apply(service, { action: 'inherit', sources: ['module:app.main'] });
  const state = await service.read();
  assert.deepEqual(state.assignments.find(item => item.target_ref === 'tool:app.main/Read'), {
    target_ref: 'tool:app.main/Read', teams: ['team:maintainers'], origin_refs: ['module:app.main'], inherited: true,
  });
  const request = { action: 'review', reviewer: 'team:maintainers', target_ref: 'tool:app.main/Read', decision: 'approved' };
  await assert.rejects(service.preview('bob-session', 'user:bob', request), { code: 'OwnershipReviewerUnauthorized' });
  await assert.rejects(service.preview('bearer', null, request), { code: 'OwnershipReviewerUnauthorized' });
  await apply(service, request);
  let review = (await service.read()).reviews[0];
  assert.equal(review.evidence, 'server_recorded'); assert.equal(review.actor_ref, 'user:alice'); assert.equal(review.state, 'current');
  const report = await prepareProject({ root, mode: 'plan' });
  assert.ok(report.actions.some(item => item.kind === 'review_required_permission'), 'maintenance ownership grants no tool permissions');
  await prepareProject({ root, mode: 'write' });
  assert.deepEqual(readOwnershipReadiness(root).owners['tool:app.main/Read'], ['team:maintainers']);
  writeFileSync(join(root, 'src/app/main.tb'), source.replace('"ready"', '"changed"'));
  assert.equal(readOwnershipReadiness(root).summary.status, 'unavailable', 'a stale preparation never invents inherited membership');
  review = (await service.read()).reviews[0]; assert.equal(review.state, 'stale');
  const path = join(root, 'touba.ownership.json'), doc = JSON.parse(readFileSync(path));
  doc.reviews[0].actor_ref = 'user:bob'; writeFileSync(path, JSON.stringify(doc));
  review = (await service.read()).reviews[0]; assert.equal(review.evidence, 'declared'); assert.equal(review.actor_ref, null);
});

test('ownership previews reject expiry, concurrent changes, forged authors and lost reviewer membership', async t => {
  const root = fixture(t); let now = 1; const service = editor(root, () => now);
  const request = { action: 'team', team_ref: 'team:review', members: ['user:alice'] };
  let preview = await service.preview('alice-session', 'user:alice', request); now += 300001;
  await assert.rejects(service.apply('alice-session', 'user:alice', application(preview), false), { code: 'OwnershipReviewMissing' });
  preview = await service.preview('alice-session', 'user:alice', request);
  writeFileSync(join(root, 'src/app/main.tb'), source.replace('"ready"', '"changed"'));
  await assert.rejects(service.apply('alice-session', 'user:alice', application(preview), false), { code: 'OwnershipReviewStale' });
  await apply(service, request);
  const review = { action: 'review', reviewer: 'team:review', target_ref: 'module:app.main', decision: 'approved' };
  await assert.rejects(service.preview('alice-session', 'user:alice', { ...review, actor_ref: 'user:bob' }), { code: 'OwnershipEditorInvalid' });
  preview = await service.preview('alice-session', 'user:alice', review);
  await assert.rejects(service.apply('alice-session', 'user:alice', application(preview), false), { code: 'OwnershipReviewMissing' });
  const path = join(root, 'touba.ownership.json'), doc = JSON.parse(readFileSync(path)); doc.teams['team:review'].members = [];
  writeFileSync(path, JSON.stringify(doc));
  await assert.rejects(service.apply('alice-session', 'user:alice', application(preview), true), { code: 'OwnershipReviewerUnauthorized' });
});

test('ownership never adopts an orphan contract or follows a selected symlink', async t => {
  const root = fixture(t), service = editor(root), path = join(root, 'touba.ownership.json');
  writeFileSync(path, '{}'); await assert.rejects(service.read(), { code: 'OwnershipEditorSelectionRequired' });
  rmSync(path); symlinkSync(join(root, 'touba.project.json'), path);
  await assert.rejects(service.read(), /symbolic/);
});

test('strict revision gates stay stable across prepare and reject later binding or source changes', async t => {
  const root = fixture(t), service = editor(root);
  await prepareProject({ root, mode: 'write', hostDecisions: { bindings: { 'tool:app.main/Read': { effect_contract: { kind: 'none' } } } } });
  await apply(service, { action: 'team', team_ref: 'team:qa', members: ['user:alice'] });
  await apply(service, { action: 'assign', target_ref: 'tool:app.main/Read', teams: ['team:qa'] });
  const path = join(root, 'touba.ownership.json'), doc = JSON.parse(readFileSync(path));
  doc.review_gates = { dev: { requires_review_for: ['tool_binding'], reviewers: ['team:qa'], require_revision: true } };
  writeFileSync(path, JSON.stringify(doc));
  let report = await prepareProject({ root, mode: 'plan' });
  assert.ok(report.diagnostics.some(item => item.code === 'ReviewGateMissing'));
  await apply(service, { action: 'review', reviewer: 'team:qa', target_ref: 'tool:app.main/Read', decision: 'approved' });
  report = await prepareProject({ root, mode: 'write' });
  assert.equal(report.status, 'success', JSON.stringify(report.diagnostics));
  const checked = await prepareProject({ root, mode: 'check' });
  assert.equal(checked.ownership.review_scope_digest, report.ownership.review_scope_digest);
  assert.equal(checked.diagnostics.some(item => item.code === 'ReviewGateMissing'), false);
  const manifest = JSON.parse(readFileSync(report.manifest_path)); manifest.bindings['tool:app.main/Read'].timeout_ms += 1;
  writeFileSync(report.manifest_path, JSON.stringify(manifest));
  const changed = await prepareProject({ root, mode: 'plan' });
  assert.ok(changed.diagnostics.some(item => item.code === 'OwnershipReviewedArtifactDrift'));
});

test('ownership routes separate maintenance editing and human review, excluding applications', () => {
  assert.equal(requiredIdentityPermission('GET', '/ownership'), 'governance.read');
  for (const [route, permission, mutation] of [['preview', 'governance.propose', false], ['apply', 'governance.apply', true],
    ['reviews/preview', 'decisions.act', false], ['reviews/apply', 'decisions.act', true]]) {
    const path = '/ownership/' + route;
    assert.equal(requiredIdentityPermission('POST', path), permission);
    assert.equal(projectActivityKind('POST', path), mutation ? 'mutation' : null);
    assert.throws(() => assertApplicationRoute({ principal: { kind: 'service' } }, 'POST', path, () => null), { code: 'ToubaServeApplicationPermissionDenied' });
  }
});

test('HTTP ownership uses the recoverable transaction and cannot attest a bearer-only review', async t => {
  const root = fixture(t); process.env.TOUBA_OWNERSHIP_QA = 'synthetic'; t.after(() => delete process.env.TOUBA_OWNERSHIP_QA);
  const service = createToubaProjectServer({ projectRoot: root, port: 0, quiet: true, authTokenEnv: 'TOUBA_OWNERSHIP_QA' });
  await service.start(); t.after(() => service.stop());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const send = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const response = await send('/ownership/preview', { action: 'team', team_ref: 'team:review', members: ['user:alice'] });
  const preview = await response.json(); assert.equal(response.status, 200, JSON.stringify(preview));
  const applied = await send('/ownership/apply', application(preview)), result = await applied.json(); assert.equal(applied.status, 200, JSON.stringify(result));
  assert.equal(JSON.parse(readFileSync(join(root, '.touba/change-transactions', result.transaction_id, 'journal.json'))).status, 'committed');
  assert.deepEqual(validateObject(stateSchema, await (await send('/ownership')).json()), []);
  const review = await send('/ownership/reviews/preview', { action: 'review', reviewer: 'team:review', target_ref: 'module:app.main', decision: 'approved' });
  assert.notEqual(review.status, 200);
});
