import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistryReader } from '../src/package-fetch.mjs';

const registry = 'https://registry.example.test/registry';
const issuer = 'https://identity.example.test/realms/touba';
function fixture(t, { refused = false, challenge = true } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    url = String(url); calls.push({ url, options });
    const json = value => new Response(JSON.stringify(value));
    if (url === registry + '/config.json') return json({ registry,
      authorization: { client_id: 'publisher' },
      read_authorization: { issuer, client_id: 'reader', scope: 'openid read', acr: '1' } });
    if (url === issuer + '/.well-known/openid-configuration') return json({ issuer,
      device_authorization_endpoint: issuer + '/device', token_endpoint: issuer + '/token', revocation_endpoint: issuer + '/revoke' });
    if (url === issuer + '/device') return json({ device_code: 'fixture-device', user_code: 'TEST-CODE',
      expires_in: 10, interval: 1, verification_uri: issuer + '/activate' });
    if (url === issuer + '/token') return json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' });
    if (url === issuer + '/revoke') return new Response(null, { status: 204 });
    if (!url.startsWith(registry + '/')) throw new Error('credential exfiltration');
    if (refused || options.headers?.Authorization !== 'Bearer fixture-access') return new Response(null, {
      status: 401, headers: challenge ? { 'WWW-Authenticate': 'Bearer realm="touba-registry"' } : {} });
    return new Response('verified bytes');
  });
  return calls;
}

test('private reader requests only read consent, keeps one token in memory and revokes it', async t => {
  const calls = fixture(t), notices = [];
  const reader = createRegistryReader(registry, { noBrowser: true, notify: text => notices.push(text) });
  try {
    assert.equal((await reader.readBytes(registry + '/index.jwt', 100)).toString(), 'verified bytes');
    await reader.readBytes(registry + '/metadata/a.json', 100);
    await reader.readBytes(registry + '/archives/a.tar.gz', 100);
    assert.equal(calls.filter(c => c.url.endsWith('/device')).length, 1);
    const request = calls.find(c => c.url.endsWith('/device')).options.body;
    assert.equal(request.get('client_id'), 'reader');
    assert.equal(request.get('scope'), 'openid read');
    assert.ok(calls.every(c => c.options.redirect === 'error'));
    assert.ok(!notices.join('').includes('fixture-access'));
    const before = calls.length;
    for (const url of ['https://other.test/registry/archive', registry + '/../elsewhere',
      registry + '/archive?token=x', 'https://user:secret@registry.example.test/registry/archive']) {
      await assert.rejects(reader.readBytes(url, 100), { code: 'RegistryUrlInvalid' });
    }
    assert.equal(calls.length, before);
  } finally { await reader.close(); }
  assert.deepEqual(calls.filter(c => c.url.endsWith('/revoke')).map(c => c.options.body.get('token')),
    ['fixture-refresh', 'fixture-access']);
});

test('refused read never loops authorization and still revokes the acquired grant', async t => {
  const calls = fixture(t, { refused: true });
  const reader = createRegistryReader(registry, { noBrowser: true, notify() {} });
  try {
    await assert.rejects(reader.readBytes(registry + '/index.jwt', 100), { code: 'RegistryAuthenticationRequired' });
    await assert.rejects(reader.readBytes(registry + '/index.jwt', 100), { code: 'RegistryAuthenticationRequired' });
  } finally { await reader.close(); }
  assert.equal(calls.filter(c => c.url.endsWith('/device')).length, 1);
  assert.equal(calls.filter(c => c.url.endsWith('/revoke')).length, 2);
});

test('ordinary failures never trigger login and cancellation obtains no credential', async t => {
  const calls = fixture(t, { challenge: false });
  const reader = createRegistryReader(registry, { noBrowser: true, notify() {} });
  await assert.rejects(reader.readBytes(registry + '/index.jwt', 100), { code: 'RegistryFetchFailed' });
  await reader.close();
  assert.equal(calls.length, 1);
});
