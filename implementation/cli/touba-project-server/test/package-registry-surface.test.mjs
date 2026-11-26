import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectPackageSurface } from '../src/package-surface.mjs';
import { signedPackageFixture } from './fixtures/signed-package.mjs';
import { initProject } from '../../touba-project/src/project.mjs';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-project-registry-')));
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

test('grouped registry selections preserve every signed archive and recheck trust before the transaction', async t => {
  const data = await fixture(t), { root, surface, proof, bytes, trust, trustPath } = data;
  const other = await signedPackageFixture(root, trust.registry, 'fixture.other');
  const proofs = [proof(), other.proof()];
  const index = { index_schema_version: 'touba-registry-index-v1', packages: proofs.map((p, i) => ({
    ...JSON.parse(Buffer.from(p.index_jwt.split('.')[1], 'base64url')).index.packages[0], metadata_path: `metadata-${i}.json`,
  })) };
  const upload = { schema_version: 'touba-package-update-upload-v2', archives: [bytes, other.bytes].map(b => b.toString('base64')),
    registry: { index_jwt: proof({ index }).index_jwt, entries: proofs.map(({ name, version, metadata }) => ({ name, version, metadata })) } };
  const tampered = structuredClone(upload); tampered.archives.reverse();
  await assert.rejects(surface.previewUpdates('alice', tampered), { code: 'PackageIntegrityMismatch' });
  const wrongMetadata = structuredClone(upload); wrongMetadata.registry.entries[1].metadata += ' ';
  await assert.rejects(surface.previewUpdates('alice', wrongMetadata), { code: 'RegistryMetadataDigestMismatch' });
  await assert.rejects(surface.previewUpdates('alice', { ...upload, registry: { ...upload.registry, url: 'https://other.test' } }), { code: 'ToubaServePackageInvalid' });
  const preview = await surface.previewUpdates('alice', upload);
  assert.equal(preview.schema_version, 'touba-project-package-preview-v2');
  assert.equal(surface.inventory().packages.length, 0);
  await assert.rejects(surface.apply('bob', preview), { code: 'ToubaServePackagePreviewMissing' });
  await surface.apply('alice', preview);
  assert.deepEqual(surface.inventory().packages.map(row => row.name), ['fixture.other', 'fixture.remote']);
  const again = await surface.previewUpdates('alice', upload);
  const before = JSON.stringify(surface.inventory());
  trust.keys[0].status = 'revoked'; writeFileSync(trustPath, JSON.stringify(trust));
  await assert.rejects(surface.apply('alice', again), /trusted|revoked|active/i);
  assert.equal(JSON.stringify(surface.inventory()), before);
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
  const initialPage = await list({ index_jwt: initial.index_jwt });
  assert.equal(initialPage.items.length, 1);
  assert.equal(initialPage.items[0].name, 'fixture.remote');
  assert.equal(initialPage.items[0].version, '1.0.0');
  assert.equal(initialPage.items[0].status, 'validated');
  assert.equal(typeof initialPage.items[0].metadata_path, 'string');
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

test('catalogue compatibility verifies signed metadata without downloading or installing archives', async t => {
  const { surface, proof } = await fixture(t);
  const initial = proof();
  const list = value => surface.registryCatalogue({ index_jwt: value.index_jwt, metadata: [value.metadata] });
  const compatible = await list(initial);
  assert.equal(compatible.items[0].compatibility.compatible, true);
  assert.equal(typeof compatible.items[0].compatibility.runtime, 'string');
  const incompatible = proof({ compatibility: '>=99.0.0', revision: 2 });
  const checked = await list(incompatible);
  assert.equal(checked.items[0].compatibility.compatible, false);
  assert.equal(checked.items[0].compatibility.required, '>=99.0.0');
  await assert.rejects(list({ ...incompatible, metadata: incompatible.metadata + ' ' }), { code: 'RegistryMetadataDigestMismatch' });
  await assert.rejects(surface.registryCatalogue({ index_jwt: incompatible.index_jwt, metadata: [] }), { code: 'ToubaServePackageInvalid' });
  await assert.rejects(surface.registryCatalogue({ index_jwt: incompatible.index_jwt, metadata: ['x'.repeat(1024 * 1024)] }), { code: 'ToubaServePackageInvalid' });
  assert.equal(surface.inventory().packages.length, 0);
});
