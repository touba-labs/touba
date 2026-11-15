import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject, prepareProject } from '../src/project.mjs';
import { newPackage, addPackage } from '../src/packages.mjs';
import { auditPackageStatus, cachedPackageDiagnostics } from '../src/package-status.mjs';
import { registryPackageStates } from '../src/registry.mjs';
import { packageCommand } from '../src/package-command.mjs';
import { readSignedRegistry } from '../src/registry-trust.mjs';
import { registryStatusCache } from '../src/registry-status-cache.mjs';
import { configureRegistry } from '../src/package-registry-config.mjs';
import { packageDiagnostic } from '../src/package-diagnostics.mjs';

const entry = { package_ref: 'pkg:fixture.notice', version: '1.0.0', kind: 'touba_package', status: 'validated',
  metadata_path: 'metadata/item.json', metadata_digest: 'sha256:' + '0'.repeat(64) };
const index = packages => ({ index_schema_version: 'touba-registry-index-v1', packages });
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'touba-package-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test('cache and review diagnostics remain actionable in French and English without echoing private details', () => {
  for (const code of ['RegistryStatusCacheMissing', 'RegistryStatusCacheInvalid', 'RegistryStatusCacheBusy',
    'RegistryStatusCacheUnavailable', 'PackageReviewRequired', 'PackageReviewChanged']) {
    const error = Object.assign(new Error('private/path/synthetic-secret'), { code });
    const fr = packageDiagnostic(error, 'fr'), en = packageDiagnostic(error, 'en');
    assert.ok(fr.startsWith(code + ': ')); assert.ok(en.startsWith(code + ': '));
    assert.notEqual(fr, en);
    assert.equal((fr + en).includes('synthetic-secret'), false);
  }
});

test('explicit audit reports installed withdrawals and unknown versions without changing the project', async t => {
  const root = temporary(t), consumer = join(root, 'consumer'), registry = join(root, 'registry');
  mkdirSync(registry); initProject({ root: consumer });
  const source = newPackage('fixture.notice', { root, version: '1.0.0', context: true }).path;
  await addPackage(source, { root: consumer });
  const files = ['touba.project.json', 'touba.packages.lock.json'];
  const before = files.map(file => readFileSync(join(consumer, file), 'utf8'));
  const save = packages => writeFileSync(join(registry, 'index.json'), JSON.stringify(index(packages)));
  save([entry]);
  assert.equal((await auditPackageStatus({ root: consumer, registry })).status, 'success');
  const withdrawal = { reason: 'Replaced after review', changed_at: '2026-11-14T12:00:00Z' };
  save([{ ...entry, status: 'yanked', withdrawal }]);
  const result = JSON.parse((await packageCommand(['audit', '--root', consumer, '--registry', registry, '--json'])).text);
  assert.equal(result.status, 'attention'); assert.equal(result.exitCode, 1);
  assert.equal(result.verified_signature, false); assert.ok(result.checked_at);
  assert.equal(result.packages[0].withdrawal.reason, withdrawal.reason);
  save([]);
  const missing = await auditPackageStatus({ root: consumer, registry });
  assert.equal(missing.status, 'attention'); assert.equal(missing.packages[0].status, 'unknown');
  assert.deepEqual(files.map(file => readFileSync(join(consumer, file), 'utf8')), before);
  const installed = join(consumer, 'packages/fixture.notice/touba.package.json');
  writeFileSync(installed, readFileSync(installed, 'utf8') + '\n');
  await assert.rejects(auditPackageStatus({ root: consumer, registry }), { code: 'PackageIntegrityMismatch' });
});

test('status consultation accepts only a fresh signed index with bounded withdrawal metadata', async t => {
  const root = temporary(t), registry = 'https://registry.example.invalid', trust = join(root, 'trust.json');
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(trust, JSON.stringify({ schema_version: 'touba-registry-trust-v1', registry,
    keys: [{ id: 'fixture', status: 'active', public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] }));
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (packages, overrides = {}) => {
    const message = encode({ alg: 'EdDSA', typ: 'touba-registry+jwt', kid: 'fixture' }) + '.'
      + encode({ registry, revision: 1, iat: now, exp: now + 3600, index: index(packages), ...overrides });
    return Buffer.from(message + '.' + sign(null, Buffer.from(message), keys.privateKey).toString('base64url'));
  };
  const item = { ...entry, status: 'yanked', withdrawal: { reason: 'Review\nrequired', changed_at: '2026-11-14T12:00:00Z' } };
  let payload = token([item]); const requests = [];
  const options = { registry, trust, readBytes: async url => { requests.push(url); return payload; } };
  const result = await registryPackageStates(options);
  assert.equal(result.verified_signature, true); assert.equal(result.packages[0].withdrawal.reason, 'Review required');
  assert.deepEqual(requests, [registry + '/index.jwt'], 'only the full index is requested, not a private package inventory');
  payload = token([item], { iat: now - 7200, exp: now - 3600 });
  await assert.rejects(registryPackageStates(options), { code: 'RegistrySignatureExpired' });
  payload = token([{ ...item, withdrawal: { ...item.withdrawal, reason: 'x'.repeat(501) } }], { revision: 2 });
  await assert.rejects(registryPackageStates(options), { code: 'RegistryIndexSchemaInvalid' });
  const reason = '🔒'.repeat(500);
  payload = token([{ ...item, withdrawal: { ...item.withdrawal, reason } }], { revision: 3 });
  const unicode = await registryPackageStates(options);
  assert.equal(unicode.packages[0].withdrawal.reason, reason);
  assert.ok(packageDiagnostic({ code: 'RegistryPackageYanked', withdrawalReason: reason }, 'fr').includes(reason));
  payload = token([{ ...item, withdrawal: { ...item.withdrawal, reason: reason + '🔒' } }], { revision: 4 });
  await assert.rejects(registryPackageStates(options), { code: 'RegistryIndexSchemaInvalid' });
});

function signedFixture(t) {
  const root = temporary(t), registry = 'https://registry.example.invalid', trust = join(root, 'trust.json');
  const keys = generateKeyPairSync('ed25519');
  const trustDocument = { schema_version: 'touba-registry-trust-v1', registry,
    keys: [{ id: 'fixture', status: 'active', public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] };
  const saveTrust = () => writeFileSync(trust, JSON.stringify(trustDocument)); saveTrust();
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (packages = [entry], overrides = {}) => {
    const message = encode({ alg: 'EdDSA', typ: 'touba-registry+jwt', kid: 'fixture' }) + '.'
      + encode({ registry, revision: 1, iat: now, exp: now + 60, index: index(packages), ...overrides });
    return message + '.' + sign(null, Buffer.from(message), keys.privateKey).toString('base64url');
  };
  return { root, registry, trust, trustDocument, saveTrust, now, token };
}

test('preparation shows a signed cached withdrawal without network or a new execution policy', async t => {
  const f = signedFixture(t), consumer = join(f.root, 'consumer'); initProject({ root: consumer });
  const source = newPackage('fixture.notice', { root: f.root, version: '1.0.0', context: true }).path;
  await addPackage(source, { root: consumer });
  const unconfigured = await cachedPackageDiagnostics(consumer);
  assert.equal(unconfigured[0].code, 'PackageStatusNotConfigured');
  assert.match(unconfigured[0].message, /touba package registry/);
  configureRegistry(f.registry, { root: consumer, trust: f.trust });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected network'); });
  assert.equal((await cachedPackageDiagnostics(consumer))[0].code, 'PackageStatusUnavailable');
  await registryPackageStates({ registry: f.registry, trust: f.trust, readBytes: async () => Buffer.from(f.token([
    { ...entry, status: 'yanked', withdrawal: { reason: 'Use the corrected release', changed_at: '2026-11-14T12:00:00Z' } },
  ])) });
  const prepared = await prepareProject({ root: consumer, mode: 'plan' });
  const warnings = prepared.diagnostics.filter(item => item.code === 'PackageVersionWithdrawn');
  assert.equal(warnings.length, 1); assert.match(warnings[0].message, /Use the corrected release/);
  assert.equal(warnings[0].severity, 'warning'); assert.equal(warnings[0].source, 'cache');
  assert.equal(requests, 0);
  t.mock.method(Date, 'now', () => (f.now + 61) * 1000);
  const expired = await cachedPackageDiagnostics(consumer);
  assert.ok(expired.some(item => item.code === 'PackageStatusExpired'));
  assert.ok(expired.some(item => item.code === 'PackageVersionWithdrawn' && item.freshness === 'expired'));
});

test('cached status is explicitly offline, expires without becoming an installation authority and survives network failure', async t => {
  const f = signedFixture(t), consumer = join(f.root, 'consumer'); initProject({ root: consumer });
  const source = newPackage('fixture.notice', { root: f.root, version: '1.0.0', context: true }).path;
  await addPackage(source, { root: consumer });
  configureRegistry(f.registry, { root: consumer, trust: f.trust });
  const files = ['touba.project.json', 'touba.packages.lock.json'];
  const before = files.map(file => readFileSync(join(consumer, file), 'utf8'));
  let calls = 0, unreachable = false;
  const token = f.token();
  t.mock.method(globalThis, 'fetch', async url => {
    calls++; assert.equal(String(url), f.registry + '/index.jwt');
    if (unreachable) throw new Error('Synthetic unavailable registry');
    return new Response(token);
  });
  await assert.rejects(auditPackageStatus({ root: consumer, registry: f.registry, trust: f.trust, offline: true }), { code: 'RegistryStatusCacheMissing' });
  assert.equal(calls, 0);
  const online = JSON.parse((await packageCommand(['audit', '--root', consumer, '--json'])).text);
  assert.equal(online.freshness, 'current'); assert.equal(calls, 1);
  const cached = JSON.parse((await packageCommand(['list', '--status', '--root', consumer, '--json'])).text);
  assert.equal(cached.command, 'package list'); assert.equal(cached.source, 'cache');
  assert.equal(cached.freshness, 'cached'); assert.equal(cached.collected_at, online.collected_at); assert.equal(calls, 1);
  unreachable = true;
  await assert.rejects(packageCommand(['audit', '--root', consumer, '--json']), /Synthetic unavailable/);
  assert.equal(calls, 2, 'online failure is never disguised as cached success');
  t.mock.method(Date, 'now', () => (f.now + 61) * 1000);
  const expired = JSON.parse((await packageCommand(['audit', '--offline', '--root', consumer, '--json'])).text);
  assert.equal(expired.freshness, 'expired'); assert.equal(expired.status, 'attention'); assert.equal(expired.exitCode, 1);
  assert.equal(expired.collected_at, online.collected_at); assert.equal(calls, 2);
  await assert.rejects(readSignedRegistry(f.registry + '/index.json', f.trust, undefined, async () => Buffer.from(token)), { code: 'RegistrySignatureExpired' });
  assert.deepEqual(files.map(file => readFileSync(join(consumer, file), 'utf8')), before);
});

test('offline cache rechecks signature, current revocation and the continuity revision', async t => {
  const f = signedFixture(t), options = { registry: f.registry, trust: f.trust };
  await registryPackageStates({ ...options, readBytes: async () => Buffer.from(f.token()) });
  const cache = registryStatusCache(f.trust, f.registry), original = cache.read();
  // A newer signed revision encountered during installation invalidates the older status cache.
  await readSignedRegistry(f.registry + '/index.json', f.trust, undefined, async () => Buffer.from(f.token([entry], { revision: 2 })));
  await assert.rejects(registryPackageStates({ ...options, offline: true }), { code: 'RegistryRollbackRefused' });
  await registryPackageStates({ ...options, readBytes: async () => Buffer.from(f.token([entry], { revision: 2 })) });
  const latest = cache.read();
  cache.write(original);
  assert.equal(cache.read().revision, 2, 'an earlier concurrent response cannot replace a newer snapshot');
  const parts = latest.token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), exp: f.now + 3600 })).toString('base64url');
  cache.write({ ...latest, token: parts.join('.') });
  await assert.rejects(registryPackageStates({ ...options, offline: true }), { code: 'RegistrySignatureInvalid' });
  cache.write(latest);
  f.trustDocument.keys[0].status = 'revoked'; f.saveTrust();
  await assert.rejects(registryPackageStates({ ...options, offline: true }), { code: 'RegistryKeyUntrusted' });
  f.trustDocument.keys[0].status = 'active'; f.saveTrust();
  await assert.rejects(registryPackageStates({ ...options, offline: true }), { code: 'RegistryKeyUntrusted' });
});
