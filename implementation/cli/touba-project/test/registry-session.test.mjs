import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { sessionStore, sessionLock } from '../src/registry-session.mjs';
import { registryVault } from '../src/registry-vault.mjs';
import { authorizeRegistry } from '../src/package-identity.mjs';

const memoryVault = () => { const values = new Map(); return { values, read: key => values.get(key), write: (key, value) => values.set(key, value), remove: key => values.delete(key) }; };
const authorization = { issuer: 'https://id.invalid/realm', client_id: 'author', scope: 'write', acr: 'mfa', session_max_age_seconds: 600 };

test('native credential vault round trip with a disposable synthetic entry', { skip: process.env.TOUBA_TEST_NATIVE_VAULT !== '1' }, () => {
  const key = randomBytes(32).toString('hex'), value = randomBytes(256).toString('base64'), vault = registryVault();
  assert.equal(vault.read(key), null);
  try { vault.write(key, value); assert.equal(vault.read(key), value); }
  finally { vault.remove(key); }
  assert.equal(vault.read(key), null);
});

test('vault sessions bind registry, issuer, client, scope and original deadline', () => {
  let now = 1000000; const vault = memoryVault();
  const store = sessionStore('https://registry.invalid', 'publication', authorization, { vault, now: () => now });
  assert.equal(store.write({ refresh_token: 'first', refresh_expires_in: 600 }), true);
  const initial = store.read(); now += 200000;
  store.write({ refresh_token: 'rotated', refresh_expires_in: 600 }, initial);
  assert.equal(store.read().refresh, 'rotated'); assert.equal(store.read().until, initial.until);
  assert.equal(sessionStore('https://other.invalid', 'publication', authorization, { vault, now: () => now }).read(), null);
  assert.equal(sessionStore('https://registry.invalid', 'read', authorization, { vault, now: () => now }).read(), null);
  for (const change of [{ issuer: 'https://evil.invalid' }, { client_id: 'reader' }, { scope: 'other' }, { acr: 'weak' }]) {
    store.write({ refresh_token: 'first' });
    assert.equal(sessionStore('https://registry.invalid', 'publication', { ...authorization, ...change }, { vault, now: () => now }).read(), null);
  }
  store.write({ refresh_token: 'first' }); now += 600001;
  assert.equal(store.read(), null); assert.equal(vault.values.size, 0);
});

test('parallel refreshes serialize and release locks even after an error', async () => {
  const key = randomBytes(32).toString('hex'); const order = [];
  await Promise.all([sessionLock(key, async () => { order.push(1); await new Promise(r => setTimeout(r, 50)); order.push(2); }), sessionLock(key, () => order.push(3))]);
  assert.deepEqual(order, [1, 2, 3]);
  await assert.rejects(sessionLock(key, () => { throw Error('fixture'); }), /fixture/);
  assert.equal(await sessionLock(key, () => 4), 4);
});

test('OS adapters pass credentials only through stdin and refuse unsafe keys', () => {
  const key = 'a'.repeat(64), secret = 'synthetic-secret';
  for (const platform of ['darwin', 'linux', 'win32']) {
    const calls = [];
    const vault = registryVault({ platform, run: (command, args, input) => { calls.push({command, args, input}); return { ok: true, status: 0, output: platform === 'darwin' ? Buffer.from(secret).toString('base64') : secret }; } });
    vault.write(key, secret); assert.equal(vault.read(key), secret); vault.remove(key);
    assert.ok(calls.every(call => !call.args.join(' ').includes(secret)));
    assert.ok(calls.some(call => call.input?.includes(platform === 'darwin' ? Buffer.from(secret).toString('base64') : secret)));
    assert.throws(() => vault.write('bad\nkey', secret), { code: 'RegistryVaultUnavailable' });
  }
  assert.throws(() => registryVault({ platform: 'unsupported' }).write(key, secret), { code: 'RegistryVaultUnavailable' });
});

test('device grant is reused, refresh rotates, logout revokes, invalid grants reauthenticate', async t => {
  const vault = memoryVault(), notices = []; let issued = 0, refreshed = 0, rejected = false, failConfig = false, failRefresh = false; const revoked = [];
  let root;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw); let body;
    if (req.url === '/registry/config.json') { body = { registry: root + '/registry', authorization: { ...authorization, issuer: root + '/identity' } }; if (failConfig) res.statusCode = 503; }
    else if (req.url === '/identity/.well-known/openid-configuration') body = { issuer: root + '/identity', device_authorization_endpoint: root + '/identity/device', token_endpoint: root + '/identity/token', revocation_endpoint: root + '/identity/revoke' };
    else if (req.url === '/identity/device') { issued++; body = { device_code: 'fixture', user_code: 'CODE-1234', expires_in: 10, interval: 1, verification_uri: root + '/identity/verify' }; }
    else if (req.url === '/identity/revoke') { revoked.push(form.get('token')); body = {}; }
    else if (form.get('grant_type') === 'refresh_token') {
      refreshed++; assert.match(form.get('refresh_token'), /^refresh-/);
      if (failRefresh) { res.statusCode = 503; body = { error: 'temporarily_unavailable' }; }
      else if (rejected) { res.statusCode = 400; body = { error: 'invalid_grant' }; rejected = false; }
      else body = { access_token: 'access-refreshed', refresh_token: 'refresh-' + refreshed, refresh_expires_in: 600 };
    } else body = { access_token: 'access-device', refresh_token: 'refresh-device', refresh_expires_in: 600 };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  root = 'http://127.0.0.1:' + server.address().port;
  const options = { vault, noBrowser: true, notify: text => notices.push(text) };
  const first = await authorizeRegistry(root + '/registry', options); await first.revoke();
  assert.equal(first.persistent, true); assert.deepEqual(revoked, []);
  const second = await authorizeRegistry(root + '/registry', options);
  assert.equal(second.token, 'access-refreshed'); assert.equal(issued, 1); assert.equal(refreshed, 1);
  failRefresh = true;
  await assert.rejects(authorizeRegistry(root + '/registry', options), { code: 'PackagePublicationUnavailable' });
  assert.equal(issued, 1); assert.equal(vault.values.size, 1);
  failRefresh = false;
  rejected = true; await authorizeRegistry(root + '/registry', options); assert.equal(issued, 2);
  await authorizeRegistry(root + '/registry', { ...options, logout: true });
  assert.deepEqual(revoked, ['refresh-device']); assert.equal(vault.values.size, 0);
  assert.ok(notices.every(text => !/refresh-|access-/.test(text)));
  const oneShot = await authorizeRegistry(root + '/registry', { ...options, sessionOnly: true }); await oneShot.revoke();
  assert.equal(oneShot.persistent, false); assert.equal(vault.values.size, 0);
  assert.deepEqual(revoked.slice(-2), ['refresh-device', 'access-device']);
  await authorizeRegistry(root + '/registry', options);
  failConfig = true;
  await assert.rejects(authorizeRegistry(root + '/registry', { ...options, logout: true }), { code: 'RegistryLogoutIncomplete' });
  assert.equal(vault.values.size, 0);
  failConfig = false;
  const locked = { read: () => null, remove: () => {}, write: () => { throw Object.assign(Error('vault unavailable'), { code: 'RegistryVaultUnavailable' }); } };
  await assert.rejects(authorizeRegistry(root + '/registry', { ...options, vault: locked }), { code: 'RegistryVaultUnavailable' });
  assert.deepEqual(revoked.slice(-2), ['refresh-device', 'access-device']);
});
