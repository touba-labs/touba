import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSignedRegistry } from '../src/registry-trust.mjs';

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
    const message = encode({ alg: 'EdDSA', kid, typ: 'touba-registry+jwt' }) + '.' + encode({ registry, iat: now, exp: now + 3600, index, ...overrides });
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
  trust.keys[0].status = 'revoked'; save(); token = make();
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryKeyUntrusted' });
  token = make(replacement.privateKey, 'second');
  assert.equal((await readSignedRegistry(url, file)).signingKey, 'second');
  trust.registry += '/wrong'; save();
  await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryTrustInvalid' });
  for (const value of [null, [], {}, { ...trust, keys: [null] }]) {
    writeFileSync(file, JSON.stringify(value));
    await assert.rejects(readSignedRegistry(url, file), { code: 'RegistryTrustInvalid' });
  }
});
