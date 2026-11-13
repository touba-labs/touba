import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { systemVault } from '../../touba-project/src/registry-vault.mjs';
import { projectServiceCredentials, serviceCredentialKey, serviceCredentialCommand } from '../src/service-credentials.mjs';
import { authorizeHumanIdentity } from '../src/serve.mjs';

test('system vault purposes stay isolated; all adapters keep credentials out of arguments', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const calls = [], token = 'synthetic-project-key-'.repeat(3), key = 'a'.repeat(64);
    const vault = systemVault({ purpose: 'project-service', platform, asynchronous: true, run: async (command, args, input) => {
      calls.push({ command, args, input });
      return { ok: true, status: 0, output: platform === 'darwin' ? Buffer.from(token).toString('base64') : token };
    } });
    await vault.write(key, token); assert.equal(await vault.read(key), token); await vault.remove(key);
    assert.ok(calls.every(value => !JSON.stringify(value.args).includes(token)));
    assert.ok(calls.every(value => !JSON.stringify(value).includes('registry-session.v1')));
    assert.ok(calls.some(value => JSON.stringify(value).includes('project-service.v1')));
    await assert.rejects(vault.read('../unsafe'), { code: 'ToubaServeVaultUnavailable' });
  }
});

test('project keys bind canonical root and control plane, reload rotations and fail closed after removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'touba-service-key-'));
  const values = new Map(), url = 'https://cloud.example.test/api/v1/studio';
  const vault = { read: async key => values.get(key), write: async (key, value) => values.set(key, value), remove: async key => values.delete(key) };
  try {
    await mkdir(join(root, 'other'));
    assert.notEqual(serviceCredentialKey(root, url), serviceCredentialKey(join(root, 'other'), url));
    assert.notEqual(serviceCredentialKey(root, url), serviceCredentialKey(root, 'https://dev.example.test/api/v1/studio'));
    for (const invalid of ['http://remote.example', 'https://user:pass@example.test', url + '?secret=value']) assert.throws(() => serviceCredentialKey(root, invalid));
    const credentials = projectServiceCredentials(root, url, vault);
    const first = 'first-'.repeat(8), second = 'second-'.repeat(8), received = [];
    const authorize = () => authorizeHumanIdentity({ accessToken: 'human-session', controlPlaneUrl: url,
      serviceToken: credentials.read, permission: 'decisions.act', expectedProjectRoot: root,
      fetchImpl: async (_, request) => { received.push(request.headers['x-touba-service-token']); return Response.json({ active: true, user: { id: 'qa' }, project_root: root, permissions: ['decisions.act'] }); } });
    await credentials.write(first); assert.equal((await authorize()).allowed, true);
    await credentials.write(second); assert.equal((await authorize()).allowed, true);
    assert.deepEqual(received, [first, second]);
    await credentials.remove(); await assert.rejects(authorize(), { code: 'ToubaServeIdentityUnavailable' });
    assert.equal(received.length, 2, 'no request with a missing or stale key');
    await writeFile(join(root, 'touba.server.json'), JSON.stringify({ schema_version: 'touba-project-server-config-v1', identity_control_plane_url: url, identity_service_token_vault: true }));
    const result = await serviceCredentialCommand(['login', '--config', 'touba.server.json', '--token-stdin'], { cwd: root, input: Readable.from([second + '\n']), vault });
    assert.ok(!result.includes(second)); assert.equal(await credentials.read(), second);
    await serviceCredentialCommand(['logout', '--config', 'touba.server.json'], { cwd: root, vault });
    await assert.rejects(credentials.read());
    for (const flags of [['login', '--token', first], ['login', '--config', 'touba.server.json'], ['logout', '--config', 'touba.server.json', '--token-stdin']]) {
      await assert.rejects(serviceCredentialCommand(flags, { cwd: root, vault }));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
