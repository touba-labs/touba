import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readOwnershipReadiness } from '../src/ownership-readiness.mjs';
import { buildGovernanceReadiness } from '../src/serve.mjs';

test('responsibilities come only from the selected ownership contract, not identity owners', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-ownership-readiness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const save = (path, document) => writeFileSync(join(root, path), JSON.stringify(document));
  const document = { ownership_schema_version: 'touba-ownership-v1', teams: { 'team:finance': {}, 'team:review': {} },
    owners: { 'tool:app.main/Pay': ['team:finance'], 'module:app.main': ['team:finance', 'team:review'] }, reviews: [] };
  save('touba.ownership.json', document);
  assert.equal(readOwnershipReadiness(root).summary.status, 'not_configured');
  save('touba.project.json', { project_version: 'touba-project-v1', configuration: { ownership: 'touba.ownership.json' } });
  const state = readOwnershipReadiness(root);
  assert.deepEqual(state.summary, { status: 'declared', path: 'touba.ownership.json', team_count: 2, target_count: 2, review_count: 0 });
  assert.deepEqual(state.owners['tool:app.main/Pay'], ['team:finance']);
  assert.equal(state.owners['tool:app.main/Read'], undefined, 'module ownership is not silently inherited');
  const surface = buildGovernanceReadiness({ projectRoot: root });
  assert.deepEqual(surface.ownership, state.summary);
  assert.deepEqual(surface.ownership_details.assignments, state.details.assignments);
  document.teams['team:review'].contact = 'private@example.invalid';
  document.reviews = [{ review_id: 'review:one', target_ref: 'tool:app.main/Pay', reviewer: 'team:review',
    decision: 'approved', profile: 'dev', evidence_ref: '/private/review-secret', notes: 'private-note' }];
  save('touba.ownership.json', document);
  const projected = readOwnershipReadiness(root);
  assert.equal(projected.details.reviews[0].decision, 'approved');
  assert.equal(JSON.stringify(projected).includes('private'), false, 'only declared identity references, not arbitrary private metadata');
  document.owners['tool:app.main/Pay'] = ['team:unknown']; save('touba.ownership.json', document);
  assert.equal(readOwnershipReadiness(root).summary.status, 'unavailable');
  assert.equal(readOwnershipReadiness(root).summary.team_count, null);
  writeFileSync(join(root, 'touba.ownership.json'), 'not json');
  assert.equal(readOwnershipReadiness(root).summary.status, 'unavailable');
  document.owners = {};
  document.reviews = [{ review_id: 'review:fake', profile: 'dev', reviewer: 'team:unknown', target_ref: 'tool:app.main/Pay', decision: 'approved' }];
  save('touba.ownership.json', document);
  assert.equal(readOwnershipReadiness(root).summary.status, 'unavailable', 'malformed reviews cannot inflate declared counters');
});

test('ownership projection refuses files outside the project and reports empty contracts distinctly', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-ownership-readiness-'));
  const outside = mkdtempSync(join(tmpdir(), 'touba-ownership-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(join(outside, 'outside.json'), JSON.stringify({ ownership_schema_version: 'touba-ownership-v1', teams: {}, owners: {} }));
  symlinkSync(join(outside, 'outside.json'), join(root, 'link.json'));
  writeFileSync(join(root, 'touba.project.json'), JSON.stringify({ configuration: { ownership: 'link.json' } }));
  assert.equal(readOwnershipReadiness(root).summary.status, 'unavailable');
  mkdirSync(join(root, 'directory.json'));
  writeFileSync(join(root, 'touba.project.json'), JSON.stringify({ configuration: { ownership: 'directory.json' } }));
  assert.equal(readOwnershipReadiness(root).summary.status, 'unavailable');
  writeFileSync(join(root, 'empty.json'), JSON.stringify({ ownership_schema_version: 'touba-ownership-v1', teams: {}, owners: {} }));
  writeFileSync(join(root, 'touba.project.json'), JSON.stringify({ configuration: { ownership: 'empty.json' } }));
  assert.deepEqual(readOwnershipReadiness(root).summary, { status: 'declared', path: 'empty.json', team_count: 0, target_count: 0, review_count: 0 });
});
