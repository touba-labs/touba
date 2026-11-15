import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/project.mjs';
import { newPackage, addPackage, packPackage } from '../src/packages.mjs';
import { packageDigest } from '../src/package-contract.mjs';
import { updatePackageSet, validatePackageUpdateSet } from '../src/package-update-set.mjs';
import { readPackageWorkspace, verifyInstalledPackages } from '../src/package-store.mjs';

test('the canonical update-set document admits exact reviewed sources and rejects ambiguous instructions', () => {
  const wrap = packages => ({ schema_version: 'touba-package-update-set-v1', packages });
  const remote = { name: 'fixture.test', version: '1.2.3', registry: 'https://registry.example.invalid', trust: 'trust.json' };
  for (const value of [wrap([{ path: './candidate' }]), wrap([remote, { path: './archive.tar.gz' }]),
    wrap([{ ...remote, version: '1.2.3-rc.1+build.4' }])]) assert.equal(validatePackageUpdateSet(value), value);
  for (const value of [wrap([{ path: '' }]), wrap([{ path: 'bad\npath' }]), wrap([{ path: 'x'.repeat(4097) }]),
    wrap([{ ...remote, path: './also-local' }]), wrap([{ ...remote, version: '01.2.3' }]),
    wrap([{ ...remote, version: '1.2.3-01' }]), wrap([{ ...remote, version: '^1.2.3' }]),
    wrap([{ ...remote, name: '../other' }]), { ...wrap([remote]), execute: true }]) {
    assert.throws(() => validatePackageUpdateSet(value), { code: 'PackageUpdateSetInvalid' });
  }
});

test('one update set verifies two distinct signed origins again before applying exact frozen bytes', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-update-origins-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'app'); initProject({ root: app });
  const origins = [], entries = [];
  for (const label of ['alpha', 'beta']) {
    const name = `fixture.${label}`, source = newPackage(name, { root, version: '1.0.0', license: 'MIT', publisher: 'Fixture' }).path;
    await addPackage(source, { root: app });
    const manifestFile = join(source, 'touba.package.json'), manifest = JSON.parse(readFileSync(manifestFile));
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: '1.1.0' }));
    const packed = await packPackage(source, { output: join(root, `${label}.tar.gz`) });
    const registry = `https://${label}.example.invalid/registry`, keys = generateKeyPairSync('ed25519');
    const trust = join(root, `${label}-trust.json`);
    writeFileSync(trust, JSON.stringify({ schema_version: 'touba-registry-trust-v1', registry,
      keys: [{ id: label, status: 'active', public_key: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] }));
    const bytes = readFileSync(packed.output);
    const metadata = JSON.stringify({ schema_version: 'touba-registry-package-v1', package_ref: `pkg:${name}`, namespace: 'fixture', name: label,
      version: '1.1.0', kind: 'touba_package', status: 'validated', summary: 'Synthetic candidate',
      source: { type: 'archive', url: registry + '/archive.tar.gz', path: 'archive.tar.gz', revision: packageDigest(bytes) },
      compatibility: { touba: manifest.touba.runtime_compatibility, protocols: ['touba-package-v1'] },
      artifacts: [{ kind: 'package_archive', path: 'archive.tar.gz', digest: packageDigest(bytes) }] });
    const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = encode({ alg: 'EdDSA', kid: label, typ: 'touba-registry+jwt' }) + '.' + encode({ registry, iat: now, exp: now + 300, revision: 1,
      index: { index_schema_version: 'touba-registry-index-v1', packages: [{ package_ref: `pkg:${name}`, version: '1.1.0', kind: 'touba_package', status: 'validated',
        metadata_path: 'metadata.json', metadata_digest: packageDigest(Buffer.from(metadata)) }] } });
    origins.push({ registry, metadata, bytes, jwt: token + '.' + sign(null, Buffer.from(token), keys.privateKey).toString('base64url') });
    entries.push({ name, version: '1.1.0', registry, trust });
  }
  const file = join(root, 'updates.json');
  writeFileSync(file, JSON.stringify({ schema_version: 'touba-package-update-set-v1', packages: entries }));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url); requests.push(target); assert.equal(options.redirect, 'error');
    const origin = origins.find(item => target.startsWith(item.registry + '/')); assert.ok(origin);
    return new Response(target.endsWith('/index.jwt') ? origin.jwt : target.endsWith('/metadata.json') ? origin.metadata : origin.bytes);
  });
  const before = readFileSync(join(app, 'touba.packages.lock.json'));
  const preview = await updatePackageSet(file, { root: app });
  assert.equal(preview.roots.length, 2);
  assert.deepEqual(preview.sources.map(row => row.registry), entries.map(row => row.registry));
  const bytes = origins[1].bytes; origins[1].bytes = Buffer.from('tampered');
  await assert.rejects(updatePackageSet(file, { root: app, accept: preview.review_digest }), { code: 'PackageIntegrityMismatch' });
  assert.deepEqual(readFileSync(join(app, 'touba.packages.lock.json')), before);
  origins[1].bytes = bytes;
  const applied = await updatePackageSet(file, { root: app, accept: preview.review_digest });
  assert.equal(applied.status, 'success');
  assert.ok(verifyInstalledPackages(app, readPackageWorkspace(app).records).packages.every(pkg => pkg.version === '1.1.0'));
  for (const origin of origins) assert.equal(requests.filter(url => url === origin.registry + '/index.jwt').length, 3);
});

test('malformed, unbounded and implicit version selections are refused before any network', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-update-input-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let requests = 0; t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('unexpected network'); });
  const path = join(root, 'updates.json');
  for (const document of [null, {}, { schema_version: 'touba-package-update-set-v1', packages: [] },
    { schema_version: 'touba-package-update-set-v1', packages: Array(33).fill({ path: '.' }) },
    { schema_version: 'touba-package-update-set-v1', packages: [{ name: 'fixture.test', version: 'latest', registry: 'https://example.invalid', trust: 'trust.json' }] },
    { schema_version: 'touba-package-update-set-v1', packages: [{ path: '.', allow: true }] }]) {
    writeFileSync(path, JSON.stringify(document));
    await assert.rejects(updatePackageSet(path), { code: 'PackageUpdateSetInvalid' });
  }
  assert.equal(requests, 0);
});
