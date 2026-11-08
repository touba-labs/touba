import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servicePrincipal, assertApplicationRoute, createApplicationAdmission } from '../src/application-access.mjs';
import { createToubaProjectServer, authorizeHumanIdentity } from '../src/serve.mjs';
import { initProject, newModule, prepareProject } from '../../touba-project/src/project.mjs';

const identity = { active: true, project_root: '/fixture', principal: { kind: 'service', id: 'application-1' }, scopes: ['executions.invoke', 'executions.read-own', 'executions.cancel-own'], targets: ['function:app/Echo'] };
test('application writes are independently rate bounded without spending human or read quotas', () => {
  let now = 0; const admit = createApplicationAdmission({ now: () => now, maxWritesPerMinute: 2 });
  admit(identity, 'POST'); admit(identity, 'POST');
  assert.throws(() => admit(identity, 'POST'), { code: 'ToubaServeApplicationRateLimited' });
  admit(identity, 'GET'); admit({ user: { id: 'owner' } }, 'POST');
  admit({ ...identity, principal: { kind: 'service', id: 'other' } }, 'POST');
  now = 60000; assert.doesNotThrow(() => admit(identity, 'POST'));
});
test('service principal is explicit and cannot acquire human permissions or unbounded targets', async () => {
  assert.ok(servicePrincipal(identity, '/fixture'));
  for (const bad of [{ ...identity, user: { id: 'human' } }, { ...identity, targets: ['*'] }, { ...identity, scopes: ['decisions.act'] }]) assert.equal(servicePrincipal(bad, '/fixture'), null);
  assert.equal(servicePrincipal(identity, '/different'), null);
  assert.equal(servicePrincipal(identity), null);
  const fetchImpl = async () => ({ ok: true, json: async () => identity });
  assert.equal((await authorizeHumanIdentity({ accessToken: 'app', controlPlaneUrl: 'https://cloud.test/', permission: 'executions.run', expectedProjectRoot: '/fixture', fetchImpl })).active, false);
  const app = await authorizeHumanIdentity({ accessToken: 'app', controlPlaneUrl: 'https://cloud.test/', permission: 'executions.run', expectedProjectRoot: '/fixture', allowService: true, fetchImpl });
  assert.equal(app.allowed, true);
  const own = () => ({ created_by: identity.principal, target_ref: 'function:app/Echo' });
  for (const [method,path] of [['GET','/project'], ['GET','/events'], ['GET','/interactions/sessions'], ['POST','/decisions'], ['POST','/runs/sandbox'], ['POST','/interactions/sessions/s1/resume'], ['GET','/interaction-assets/secret']]) {
    assert.throws(() => assertApplicationRoute(app, method, path, own), { code: 'ToubaServeApplicationPermissionDenied' });
  }
  assert.doesNotThrow(() => assertApplicationRoute(app, 'GET', '/interactions/sessions/s1', own));
  assert.throws(() => assertApplicationRoute(app, 'GET', '/interactions/sessions/s1', () => ({ ...own(), created_by: { kind: 'user', id: 'application-1' } })), { code: 'ToubaServeApplicationPermissionDenied' });
});

test('an application uses the same runtime while sessions, targets and revocation remain isolated', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'touba-application-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  initProject({ root, language: 'javascript' }); newModule('demo.app', { root });
  await writeFile(join(root, 'src/demo/app.tb'), 'module demo.app\n\nfunction Echo\n    takes request as Text\n    gives Text\n    do\n        give request\n');
  const file = join(root, 'touba.project.json');
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), entry: 'function:demo.app/Echo' }));
  assert.equal((await prepareProject({ root, mode: 'write' })).status, 'success');
  let revoked = false;
  const authority = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const token = JSON.parse(Buffer.concat(chunks)).access_token;
    const value = token === 'human' ? { active: true, project_root: root, user: { id: 'owner' }, permissions: ['*'] }
      : { ...identity, targets: ['function:demo.app/Echo'], project_root: root, principal: { kind: 'service', id: token === 'other' ? 'other-app' : 'application-1' }, active: !revoked };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => authority.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => authority.close(resolve)));
  const server = createToubaProjectServer({ projectRoot: root, host: '127.0.0.1', port: 0, quiet: true,
    identityControlPlaneUrl: `http://127.0.0.1:${authority.address().port}`, identityServiceToken: 'fixture-service-key-at-least-32-characters' });
  await server.start(); t.after(() => server.stop());
  const call = (path, method = 'GET', body, token = 'app') => fetch(`http://127.0.0.1:${server.server.address().port}${path}`, { method, headers: { 'x-touba-identity-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const creation = { schema_version: 'touba-interaction-session-create-v1', target_ref: 'function:demo.app/Echo', target_kind: 'function', presentation: 'invocation', effect_policy: 'runtime_only', requested_by: { kind: 'user', id: 'spoofed' } };
  const response = await call('/interactions/sessions', 'POST', creation);
  assert.equal(response.status, 201, await response.clone().text());
  const session = await response.json(); assert.deepEqual(session.created_by, identity.principal);
  const path = `/interactions/sessions/${session.session_id}`;
  assert.equal((await call(path, 'GET', undefined, 'other')).status, 403);
  assert.equal((await call(path, 'GET', undefined, 'human')).status, 200);
  assert.equal((await call('/interactions/sessions', 'POST', { ...creation, target_ref: 'tool:app/Pay' })).status, 403);
  assert.equal((await call('/decisions', 'POST', {})).status, 403);
  assert.equal((await call('/project')).status, 403);
  const message = { schema_version: 'touba-interaction-message-request-v1', message_id: 'idempotent-1', display_text: 'Echo', inputs: { request: 'application-result' }, requested_by: { kind: 'user', id: 'spoofed' } };
  const queued = await call(path + '/messages', 'POST', message); assert.equal(queued.status, 202, await queued.clone().text());
  const operation = await queued.json(); let result;
  for (let i = 0; i < 100; i++) {
    result = await (await call(path + `/operations/${operation.operation_id}`)).json();
    if (!['queued','running'].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal((await (await call(path + '/messages', 'POST', message)).json()).operation_id, operation.operation_id);
  revoked = true;
  assert.equal((await call(path)).status, 401);
  assert.equal((await call(path + '/messages', 'POST', { ...message, message_id: 'new' })).status, 401);
});
