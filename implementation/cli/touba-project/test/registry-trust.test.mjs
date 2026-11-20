import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { registryTrustState, trustedKeys } from '../src/registry-trust-state.mjs';
import { readSignedRegistry, readSignedRegistryStatus } from '../src/registry-trust.mjs';
import { registryStatusCache } from '../src/registry-status-cache.mjs';

test('installation reads refresh shared status without accepting an old network response or stale offline cache', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-shared-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = 'https://registry.example.invalid', file = join(root, 'trust.json');
  const key = generateKeyPairSync('ed25519');
  writeFileSync(file, JSON.stringify({ schema_version: 'touba-registry-trust-v1', registry,
    keys: [{ id: 'key', status: 'active', public_key: key.publicKey.export({ type: 'spki', format: 'pem' }) }] }));
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const make = revision => {
    const body = encode({ alg: 'EdDSA', typ: 'touba-registry+jwt', kid: 'key' }) + '.' + encode({
      registry, revision, iat: now, exp: now + 3600,
      index: { index_schema_version: 'touba-registry-index-v1', packages: [] },
    });
    return body + '.' + sign(null, Buffer.from(body), key.privateKey).toString('base64url');
  };
  const url = registry + '/index.json';
  const old = make(27);
  await readSignedRegistryStatus(url, file, async () => Buffer.from(old));
  await readSignedRegistry(url, file, now, async () => Buffer.from(make(28)));
  const noNetwork = async () => { assert.fail('offline status must not access the network'); };
  assert.equal((await readSignedRegistryStatus(url, file, noNetwork, { offline: true })).revision, 28);
  await assert.rejects(readSignedRegistry(url, file, now, async () => Buffer.from(old)),
    { code: 'RegistryRollbackRefused' });
  // Simulate a previously interrupted delivery that advanced continuity only.
  const material = trustedKeys(JSON.parse(readFileSync(file, 'utf8')), registry);
  registryTrustState(file + '.sqlite', registry).accept({ revision: 29,
    digest: (await readSignedRegistryStatus(url, file, noNetwork, { offline: true })).digest,
    signingKey: 'key', keyFingerprint: material[0].fingerprint });
  await assert.rejects(readSignedRegistryStatus(url, file, noNetwork, { offline: true }),
    { code: 'RegistryStatusCacheStale' });
  assert.equal(registryStatusCache(file, registry).read().revision, 28);
  await readSignedRegistry(url, file, now, async () => Buffer.from(make(29)));
  assert.equal((await readSignedRegistryStatus(url, file, noNetwork, { offline: true })).revision, 29);
});

test('remote indexes require explicit trust, valid signatures, origin and freshness; keys rotate and revoke', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'touba-trust-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  let token;
  const server = createServer((_req, res) => res.end(token));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const registry = `http://127.0.0.1:${server.address().port}/registry`;
  const url = registry + '/index.json';
  const key = generateKeyPairSync('ed25519'), replacement = generateKeyPairSync('ed25519');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const index = { index_schema_version: 'touba-registry-index-v1', packages: [] };
  const make = (privateKey = key.privateKey, kid = 'first', overrides = {}) => {
    const message = encode({ alg: 'EdDSA', kid, typ: 'touba-registry+jwt' }) + '.' + encode({ registry, iat: now, exp: now + 3600, revision: 1, index, ...overrides });
    return message + '.' + sign(null, Buffer.from(message), privateKey).toString('base64url');
  };
  const trust = { schema_version: 'touba-registry-trust-v1', registry, keys: [
    { id: 'first', status: 'active', public_key: key.publicKey.export({ type: 'spki', format: 'pem' }) },
    { id: 'second', status: 'active', public_key: replacement.publicKey.export({ type: 'spki', format: 'pem' }) },
  ] };
  const file = join(temporary, 'trust.json');
  const save = () => writeFileSync(file, JSON.stringify(trust));
  save(); token = make();
  await assert.rejects(readSignedRegistry(url), { code: 'RegistryTrustRequired' });
  assert.deepEqual((await readSignedRegistry(url, file)).value, index);
  token = make(replacement.privateKey, 'first');
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistrySignatureInvalid' });
  token = make(key.privateKey, 'first', { exp: now - 1 });
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistrySignatureExpired' });
  token = make(key.privateKey, 'first', { registry: registry + '/other' });
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistrySignatureExpired' });
  token = make(replacement.privateKey, 'second');
  assert.equal((await readSignedRegistry(url, file)).signingKey, 'second');
  token = make(replacement.privateKey, 'second', { revision: 2 });
  assert.equal((await readSignedRegistry(url, file)).revision, 2);
  token = make(replacement.privateKey, 'second');
  await assert.rejects(readSignedRegistry(url, file), error => {
    assert.equal(error.code, 'RegistryRollbackRefused');
    assert.match(error.message, /received signed revision 1; last accepted revision 2/);
    assert.match(error.message, /same trust file/);
    assert.match(error.message, /do not delete the trust state/);
    assert.ok(!error.message.includes(file));
    assert.ok(!error.message.includes(registry));
    return true;
  });
  // A refused older response must leave continuity unchanged. A new read is
  // explicit, and succeeds only if the response passes all original checks.
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryRollbackRefused' });
  token = make(replacement.privateKey, 'second', { revision: 2 });
  assert.equal((await readSignedRegistry(url, file)).revision, 2);
  token = make(replacement.privateKey, 'second', { revision: 2, index: { ...index, unexpected: true } });
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryRevisionConflict' });
  for (const revision of [undefined, null, 0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    token = make(replacement.privateKey, 'second', { revision });
    await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryRevisionInvalid' });
  }
  trust.keys[0].status = 'revoked'; save(); token = make();
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryKeyUntrusted' });
  trust.keys[0].status = 'active'; save(); token = make(key.privateKey, 'first', { revision: 3 });
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryKeyUntrusted' });
  token = make(replacement.privateKey, 'second', { revision: 2 });
  assert.equal((await readSignedRegistry(url, file)).signingKey, 'second');
  trust.registry += '/wrong'; save();
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryTrustTargetMismatch' });
  trust.registry = trust.registry.slice(0, -6);
  for (const value of [null, [], {}, { ...trust, keys: [null] }]) {
    writeFileSync(file, JSON.stringify(value));
    await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryTrustInvalid' });
  }
});

test('pinned keys reject replacement, removal reversal and revoked material under another name', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-trust-pinning-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = 'https://registry.example.invalid', file = join(root, 'trust.sqlite');
  const key = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
  const trust = { schema_version: 'touba-registry-trust-v1', registry, keys: [
    { id: 'first', status: 'active', public_key: key.publicKey.export({ type: 'spki', format: 'pem' }) },
    { id: 'second', status: 'active', public_key: other.publicKey.export({ type: 'spki', format: 'pem' }) },
  ] };
  const state = registryTrustState(file, registry), keys = trustedKeys(trust, registry);
  const ack = { revision: 1, digest: 'sha256:' + '0'.repeat(64), signingKey: 'first', keyFingerprint: keys[0].fingerprint };
  state.observe(keys); state.accept(ack);
  assert.throws(() => state.observe([{ ...keys[0], fingerprint: keys[1].fingerprint }]), { code: 'RegistryKeyConflict' });
  state.observe([keys[1]]);
  const reopened = registryTrustState(file, registry);
  reopened.observe(keys);
  assert.throws(() => reopened.accept(ack), { code: 'RegistryKeyUntrusted' });
  reopened.observe([keys[1], { ...keys[0], id: 'alias' }]);
  assert.throws(() => reopened.accept({ ...ack, signingKey: 'alias' }), { code: 'RegistryKeyUntrusted' });
  reopened.accept({ ...ack, signingKey: 'second', keyFingerprint: keys[1].fingerprint });
  for (const changed of [
    { ...trust, keys: [...trust.keys, trust.keys[0]] },
    { ...trust, keys: [{ ...trust.keys[0], id: undefined }] },
    { ...trust, keys: [{ ...trust.keys[0], public_key: 'not a key' }] },
    { ...trust, keys: [trust.keys[0], { ...trust.keys[0], id: 'alias' }] },
  ]) assert.throws(() => trustedKeys(changed, registry), { code: 'RegistryTrustInvalid' });
});

test('separate CLI processes preserve the highest signed revision under concurrent reads', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-trust-processes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = 'https://registry.example.invalid', file = join(root, 'trust.json');
  const key = generateKeyPairSync('ed25519');
  writeFileSync(file, JSON.stringify({ schema_version: 'touba-registry-trust-v1', registry,
    keys: [{ id: 'key', status: 'active', public_key: key.publicKey.export({ type: 'spki', format: 'pem' }) }] }));
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const make = revision => {
    const body = encode({ alg: 'EdDSA', typ: 'touba-registry+jwt', kid: 'key' }) + '.' + encode({ registry, revision,
      iat: now, exp: now + 3600, index: { index_schema_version: 'touba-registry-index-v1', packages: [] } });
    return body + '.' + sign(null, Buffer.from(body), key.privateKey).toString('base64url');
  };
  const run = revision => new Promise((resolve, reject) => {
    const script = `import {readSignedRegistry} from ${JSON.stringify(new URL('../src/registry-trust.mjs', import.meta.url).href)};
      try { const result=await readSignedRegistry(${JSON.stringify(registry + '/index.json')},${JSON.stringify(file)},undefined,
        async()=>Buffer.from(${JSON.stringify(make(revision))})); console.log(result.revision); }
      catch(error){if(error.code==='RegistryRollbackRefused') console.log(error.code);else throw error;}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject); child.on('close', code => code ? reject(new Error(errors)) : resolve(output.trim()));
  });
  const results = await Promise.all([3, 8, 4, 1, 6, 2].map(run));
  assert.ok(results.includes('8'));
  assert.equal(await run(7), 'RegistryRollbackRefused');
  assert.equal(await run(8), '8');
});
