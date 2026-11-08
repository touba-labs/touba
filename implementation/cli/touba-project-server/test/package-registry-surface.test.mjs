import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectPackageSurface } from '../src/package-surface.mjs';
import { signedPackageFixture } from './fixtures/signed-package.mjs';
import { initProject } from '../../touba-project/src/project.mjs';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-studio-registry-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'consumer'); initProject({ root: project });
  const registry = 'https://cloud.example.test/registry';
  const data = await signedPackageFixture(root, registry);
  const surface = createProjectPackageSurface(project, { registry, trust: data.trustPath });
  t.after(() => surface.close());
  return { ...data, root, project, surface };
}

test('signed registry uses consumer trust and canonical resolution, then explicit compiler preview and install', async t => {
  const { surface, project, proof, bytes } = await fixture(t);
  const before = readFileSync(join(project, 'touba.project.json'));
  const resolution = await surface.resolveRegistry('alice', proof());
  assert.equal(surface.inventory().packages.length, 0);
  await assert.rejects(surface.previewRegistry('bob', resolution.id, bytes), { code: 'ToubaServePackagePreviewMissing' });
  const preview = await surface.previewRegistry('alice', resolution.id, bytes);
  assert.deepEqual(readFileSync(join(project, 'touba.project.json')), before);
  assert.equal((await surface.apply('alice', preview)).status, 'success');
  assert.equal(surface.inventory().packages[0].name, 'fixture.remote');
  await assert.rejects(surface.apply('alice', preview), { code: 'ToubaServePackagePreviewMissing' });
});

test('registry refuses altered, expired, withdrawn and incompatible evidence; no network fallback', async t => {
  const { surface, proof, bytes } = await fixture(t);
  const altered = proof(); altered.metadata += ' ';
  await assert.rejects(surface.resolveRegistry('alice', altered), { code: 'RegistryMetadataDigestMismatch' });
  await assert.rejects(surface.resolveRegistry('alice', proof({ exp: 1 })), { code: 'RegistrySignatureExpired' });
  await assert.rejects(surface.resolveRegistry('alice', proof({ status: 'yanked', revision: 2 })), /yanked/i);
  await assert.rejects(surface.resolveRegistry('alice', proof({ compatibility: '>=99.0.0', revision: 3 })), { code: 'PackageVersionIncompatible' });
  await assert.rejects(surface.resolveRegistry('alice', proof()), /revision|rollback/i);
  const resolution = await surface.resolveRegistry('alice', proof({ revision: 4 }));
  await assert.rejects(surface.previewRegistry('alice', resolution.id, Buffer.concat([bytes, Buffer.from('tampered')])), { code: 'PackageIntegrityMismatch' });
  assert.equal(surface.inventory().packages.length, 0);
});

test('revoked consumer trust is rechecked at apply and previews have bounded capacity', async t => {
  const { surface, proof, bytes, trust, trustPath } = await fixture(t);
  const first = await surface.resolveRegistry('alice', proof());
  const second = await surface.resolveRegistry('alice', proof());
  await assert.rejects(surface.resolveRegistry('alice', proof()), { code: 'ToubaServePackageCapacity' });
  assert.throws(() => surface.cancel('bob', second.id), { code: 'ToubaServePackagePreviewMissing' });
  surface.cancel('alice', second.id);
  const preview = await surface.previewRegistry('alice', first.id, bytes);
  trust.keys[0].status = 'revoked'; writeFileSync(trustPath, JSON.stringify(trust));
  await assert.rejects(surface.apply('alice', preview), /trusted|revoked|active/i);
  assert.equal(surface.inventory().packages.length, 0);
});

test('only one archive or registry proof can be received at a time', async t => {
  const { surface } = await fixture(t);
  let finish;
  const transfer = surface.receive(() => new Promise(resolve => { finish = resolve; }));
  let secondRead = false;
  await assert.rejects(surface.receive(async () => { secondRead = true; }), { code: 'ToubaServePackageBusy' });
  assert.equal(secondRead, false);
  finish(); await transfer;
  assert.equal(await surface.receive(async () => 'ready'), 'ready');
});

test('catalogue authenticates versions, hides withdrawn releases and refuses signature or revision tampering', async t => {
  const { surface, proof } = await fixture(t);
  const list = values => surface.registryCatalogue(values);
  const initial = proof();
  assert.deepEqual((await list({ index_jwt: initial.index_jwt })).items, [{ name: 'fixture.remote', version: '1.0.0', status: 'validated' }]);
  assert.equal((await list({ index_jwt: initial.index_jwt, query: 'OTHER' })).total, 0);
  assert.equal((await list({ index_jwt: initial.index_jwt, query: 'FIXTURE' })).total, 1);
  assert.deepEqual((await list({ index_jwt: initial.index_jwt, offset: 1 })).items, []);
  await assert.rejects(list({ index_jwt: 'invalid' }), { code: 'RegistrySignatureInvalid' });
  await assert.rejects(list({ index_jwt: initial.index_jwt, offset: -1 }), { code: 'RegistryIndexSchemaInvalid' });
  const withdrawn = proof({ status: 'yanked', revision: 2 });
  assert.deepEqual((await list({ index_jwt: withdrawn.index_jwt })).items, []);
  assert.equal((await list({ index_jwt: withdrawn.index_jwt, includeWithdrawn: true })).items[0].status, 'yanked');
  await assert.rejects(list({ index_jwt: initial.index_jwt }), { code: 'RegistryRollbackRefused' });
  assert.equal(surface.inventory().packages.length, 0);
});
