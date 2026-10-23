import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizePublication, publicationUrl } from '../src/package-publish-remote.mjs';

const registry = 'https://registry.example.test/registry';
const issuer = 'https://identity.example.test/realms/touba';

test('publication destinations require HTTPS or explicit loopback', () => {
  assert.equal(publicationUrl(registry + '/'), registry);
  assert.equal(publicationUrl('http://127.0.0.1:4180/registry'), 'http://127.0.0.1:4180/registry');
  for (const value of ['http://example.test', 'https://user:password@example.test', 'https://example.test?a=1', 'https://example.test/#a', 'file:///etc/passwd']) {
    assert.throws(() => publicationUrl(value), { code: 'PackagePublicationTargetInvalid' });
  }
});

test('device authorization uses exact issuer endpoints and revokes memory-only grants', async t => {
  const calls = [], notices = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    const json = data => new Response(JSON.stringify(data));
    if (url === registry + '/config.json') return json({ registry, authorization: { issuer, client_id: 'cli', scope: 'openid publish', acr: 'strong' } });
    if (url === issuer + '/.well-known/openid-configuration') return json({ issuer, device_authorization_endpoint: issuer + '/device', token_endpoint: issuer + '/token', revocation_endpoint: issuer + '/revoke' });
    if (url === issuer + '/device') return json({ device_code: 'test-device-code', user_code: 'TEST-CODE', expires_in: 10, interval: 1, verification_uri_complete: issuer + '/activate?user_code=TEST-CODE' });
    if (url === issuer + '/token') return json({ access_token: 'unit-access', refresh_token: 'unit-refresh' });
    if (url === issuer + '/revoke') return new Response(null, { status: 204 });
    throw new Error('unexpected destination');
  });
  const identity = await authorizePublication(registry, { noBrowser: true, notify: value => notices.push(value) });
  assert.equal(identity.token, 'unit-access');
  assert.ok(notices.join('').includes('TEST-CODE'));
  assert.ok(!notices.join('').includes('unit-access'));
  assert.ok(calls.every(({ options }) => options.redirect === 'error'));
  const exchange = calls.find(call => call.url.endsWith('/token')).options.body;
  assert.equal(exchange.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(exchange.get('device_code'), 'test-device-code');
  await identity.revoke();
  assert.deepEqual(calls.filter(call => call.url.endsWith('/revoke')).map(call => call.options.body.get('token')), ['unit-refresh', 'unit-access']);
});

test('malformed discovery and refused device authorization fail without token disclosure', async t => {
  let variant = 'issuer';
  t.mock.method(globalThis, 'fetch', async url => {
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (url === registry + '/config.json') return json(variant === 'null' ? null : { registry, authorization: { issuer, client_id: 'cli', scope: 'openid publish', acr: 'strong' } });
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: variant === 'issuer' ? 'https://wrong.test' : issuer, device_authorization_endpoint: issuer + '/device', token_endpoint: variant === 'endpoint' ? 'https://other.test/token' : issuer + '/token', revocation_endpoint: issuer + '/revoke' });
    if (url.endsWith('/device')) return json({ device_code: 'private-unit-code', user_code: 'TEST-CODE', expires_in: 3, interval: 1, verification_uri: issuer + '/activate' });
    return json({ error: 'access_denied', error_description: 'private-unit-code' }, 400);
  });
  for (variant of ['issuer', 'endpoint', 'null', 'denied']) {
    await assert.rejects(authorizePublication(registry, { noBrowser: true, notify() {} }), error => {
      assert.ok(error.code.startsWith('PackagePublication'));
      assert.ok(!error.message.includes('private-unit-code'));
      return true;
    });
  }
});
