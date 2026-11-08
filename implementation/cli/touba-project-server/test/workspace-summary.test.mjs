import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createToubaProjectServer, appendProjectEventJournal, buildProjectEvent } from "../src/serve.mjs";
import { buildWorkspaceSummary, workspaceActivity } from "../src/workspace-summary.mjs";
import { validateObject } from "../../../contracts/product-surfaces/validate.mjs";

const schema = JSON.parse(readFileSync(new URL('../../../contracts/product-surfaces/schemas/touba-workspace-summary-v1.schema.json', import.meta.url)));
const event = (type, sequence) => buildProjectEvent({ type, sequence, payload: {
  proposal_id: 'proposal-1', inputs: { secret: 'never-forward' }, comment: 'private comment', token: 'private key',
} });

test('fleet activity is bounded, ordered, minimized and filtered with live event permissions', () => {
  const events = Array.from({ length: 150 }, (_, i) => event(i % 2 ? 'change.applied' : 'sandbox_run.completed', i + 1));
  events.push(event('unknown.future', 151));
  assert.equal(workspaceActivity(events, null).length, 100);
  const allowed = workspaceActivity(events, { active: true, permissions: ['governance.read'] });
  assert.equal(allowed.length, 75);
  assert.ok(allowed.every(item => item.category === 'change'));
  assert.equal(allowed[0].id, 'evt_000150');
  assert.doesNotMatch(JSON.stringify(allowed), /private|secret|inputs|token|comment/u);
  assert.deepEqual(workspaceActivity(events, { active: false, permissions: ['*'] }), []);
});

test('forbidden summary readers never run and failure remains unknown instead of zero', () => {
  const reads = Object.fromEntries(['run','triggers','supply','decisions','activity'].map(name => [name, () => { throw new Error('private diagnostic'); }]));
  for (const name of ['run','triggers','decisions']) reads[name] = () => assert.fail('forbidden read');
  const value = buildWorkspaceSummary({ identity: { active: true, permissions: ['projects.read'] },
    project: { name: 'Test', root: '/test', touba_version: '1.4.0', build_id: 'test' }, reads });
  assert.deepEqual(value.attention, { decisions: null, drift: null, triggers: null });
  assert.deepEqual(value.failures, ['supply', 'activity']);
  assert.deepEqual(validateObject(schema, value), []);
  assert.doesNotMatch(JSON.stringify(value), /private diagnostic/);
});

test('HTTP summary exposes real server identity and scoped persisted history after restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-workspace-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const token = JSON.parse(body).access_token;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ active: token !== 'revoked', user: { id: token }, project_root: root,
      permissions: token === 'owner' ? ['*'] : ['projects.read'] }));
  });
  await new Promise(resolve => identity.listen(0, '127.0.0.1', resolve));
  t.after(() => { identity.closeAllConnections(); identity.close(); });
  const options = { projectRoot: root, port: 0, quiet: true,
    identityControlPlaneUrl: `http://127.0.0.1:${identity.address().port}`, identityServiceToken: 'synthetic-test-service-key-at-least-32-characters' };
  let core = createToubaProjectServer(options); await core.start();
  const journal = join(root, '.touba/project-events.jsonl');
  // Use an explicit journal to keep this test independent of its default name.
  await core.stop();
  appendProjectEventJournal({ eventJournalPath: journal, event: event('change.applied', 1) });
  appendProjectEventJournal({ eventJournalPath: journal, event: event('sandbox_run.completed', 2) });
  core = createToubaProjectServer({ ...options, eventJournalPath: journal }); await core.start();
  t.after(async () => { core.server.closeAllConnections(); await core.stop(); });
  const get = token => fetch(`http://127.0.0.1:${core.server.address().port}/workspace/summary`, { headers: { 'x-touba-identity-token': token } });
  const owner = await (await get('owner')).json();
  assert.deepEqual(validateObject(schema, owner), []);
  assert.equal(owner.project.touba_version, '1.4.0');
  assert.match(owner.project.build_id, /^(?:source:)?[a-f0-9]{64}$/);
  assert.ok(owner.activity.some(item => item.type === 'change.applied'));
  const reader = await (await get('reader')).json();
  assert.ok(reader.activity.every(item => !/change|sandbox/.test(item.type)));
  assert.equal(reader.attention.decisions, null);
  assert.equal(reader.run_status, null);
  assert.equal((await get('revoked')).status, 401);
  const base = `http://127.0.0.1:${core.server.address().port}`;
  for (const path of ['/alerts/current', '/resources/featured', '/approvals/pending/current', '/reviews/pending/current']) {
    const response = await fetch(`${base}${path}?optional=true`, { headers: { 'x-touba-identity-token': 'owner' } });
    assert.equal(response.status, 200);
    assert.equal(await response.json(), null);
  }
  const denied = await fetch(`${base}/approvals/pending/current?optional=true`, { headers: { 'x-touba-identity-token': 'reader' } });
  assert.equal(denied.status, 403, 'optional absence does not bypass decision permissions');
  const missing = await fetch(`${base}/approvals/pending/current`, { headers: { 'x-touba-identity-token': 'owner' } });
  assert.equal(missing.status, 404, 'strict legacy behavior is preserved');
});
