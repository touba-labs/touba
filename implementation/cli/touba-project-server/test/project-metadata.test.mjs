import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectMetadata, projectMetadataScope, setProjectMetadataScope } from '../src/project-metadata.mjs';
import { registerEventClient, writeSse } from '../src/event-clients.mjs';
import { createToubaProjectServer } from '../src/serve.mjs';
import { initProject, newModule } from '../../touba-project/src/project.mjs';

test('metadata projections keep authority and canonical evidence unchanged', () => {
  const root = '/private/operator/project', reader = { active: true, audience: 'project-id', permissions: ['projects.read'] };
  const scope = projectMetadataScope(reader, root);
  const original = { schema_version: 'touba-project-refresh-v1', project_root: root, artifacts: [{ path: 'main.tb', sha256: 'unchanged' }] };
  assert.equal(projectMetadata(original, scope).project_root, 'project:project-id');
  assert.equal(original.project_root, root);
  assert.equal(projectMetadata(original, scope).artifacts, original.artifacts);
  const trace = { schema_version: 'touba-trace-v1', project_root: root, value: { root } };
  assert.equal(projectMetadata(trace, scope), trace, 'never rewrite user values or canonical traces');
  for (const identity of [null, { permissions: ['projects.manage'] }, { permissions: ['*'] }]) {
    assert.equal(projectMetadata(original, projectMetadataScope(identity, root)), original);
  }
});

test('live and replay project events use the same opaque registration reference', () => {
  const identity = { active: true, audience: 'id', permissions: ['projects.read'] };
  const response = Object.assign(new EventEmitter(), { frames: [], writableLength: 0, write(value) { this.frames.push(value); } });
  setProjectMetadataScope(response, identity, '/private/root'); registerEventClient(response, identity);
  const event = { event_id: 'e:1', payload: { schema_version: 'touba-project-refresh-v1', project_root: '/private/root' } };
  writeSse(response, 'project.changed', event);
  assert.ok(response.frames[0].includes('project:id'));
  assert.ok(!response.frames[0].includes('/private/root'));
  assert.equal(event.payload.project_root, '/private/root');
  response.emit('close');
});

test('reader HTTP surfaces hide absolute metadata roots while owner reads and authority use the real root', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'touba-metadata-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  initProject({ root, language: 'javascript' }); newModule('demo.main', { root });
  let wrongRoot = false;
  const authority = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { access_token } = JSON.parse(Buffer.concat(chunks));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ active: true, audience: 'registration-id', project_root: wrongRoot ? '/other' : root,
      user: { id: access_token }, permissions: access_token === 'owner' ? ['*']
        : ['projects.read', 'executions.read', 'governance.read', 'decisions.read', 'deployments.read'] }));
  });
  await new Promise(resolve => authority.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => authority.close(resolve)));
  const server = createToubaProjectServer({ projectRoot: root, host: '127.0.0.1', port: 0, quiet: true,
    identityControlPlaneUrl: `http://127.0.0.1:${authority.address().port}`, identityServiceToken: 'synthetic-service-key-long-enough-32' });
  await server.start(); t.after(() => server.stop());
  const call = (path, role) => fetch(`http://127.0.0.1:${server.server.address().port}${path}`, { headers: { 'x-touba-identity-token': role } });
  for (const path of ['/project', '/project/refresh', '/state', '/workspace/summary', '/authority/graph', '/supply-chain/status']) {
    const response = await call(path, 'reader');
    if (response.status === 404) assert.fail(`use the actual route: ${path}`);
    assert.equal(response.status, 200, path);
    const text = await response.text(); assert.ok(!text.includes(root), path); assert.ok(text.includes('project:registration-id'), path);
  }
  assert.equal((await (await call('/project', 'owner')).json()).project.root, root);
  wrongRoot = true;
  assert.equal((await call('/project', 'reader')).status, 401, 'opaque display never weakens real-root admission');
});
