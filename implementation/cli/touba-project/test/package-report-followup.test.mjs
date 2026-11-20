import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageDependencyRecords } from '../src/package-store.mjs';
import { packageDiagnostic } from '../src/package-diagnostics.mjs';
import { registryAccountLabel } from '../src/registry-account-label.mjs';
import { listRegistryPackages } from '../src/registry.mjs';
import { packageReportText } from '../src/package-text.mjs';

test('missing selection differs from version conflict and keeps the author declaration untouched', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-range-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const document = { name: 'acme.consumer', package_schema_version: 'touba-package-v2', dependencies: { 'acme.base': '^1.0.0' } };
  writeFileSync(join(root, 'touba.package.json'), JSON.stringify(document));
  const before = readFileSync(join(root, 'touba.package.json'));
  assert.throws(() => packageDependencyRecords(root, document), error => {
    assert.equal(error.code, 'PackageDependencyConflict');
    for (const locale of ['fr', 'en']) {
      assert.match(packageDiagnostic(error, locale), /acme.base/);
      assert.match(packageDiagnostic(error, locale), /touba package add/);
    }
    return true;
  });
  assert.deepEqual(readFileSync(join(root, 'touba.package.json')), before);
});

test('reader hints identify only a bounded issuer label and never print tokens or terminal controls', () => {
  const token = claims => 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.SECRET_SIGNATURE';
  assert.equal(registryAccountLabel(token({ preferred_username: 'julie.qa' })), 'julie.qa');
  assert.match(registryAccountLabel(token({ preferred_username: 'bad\u001b[31m', sub: 'private-subject' })), /^account-[a-f0-9]{12}$/);
  for (const locale of ['fr', 'en']) {
    const error = { code: 'RegistryFetchFailed', httpStatus: 404, registryReadAccount: 'julie.qa', registryReadOrigin: 'https://registry.example.test/registry' };
    assert.match(packageDiagnostic(error, locale), /julie.qa/);
    assert.match(packageDiagnostic(error, locale), /logout --registry https:\/\/registry.example.test\/registry --read/);
    assert.doesNotMatch(packageDiagnostic({ ...error, registryReadAccount: '\nSECRET' }, locale), /SECRET/);
    assert.match(packageDiagnostic({ code: 'PackageDependencyConflict', reason: 'PackageUpdateReviewRequired' }, locale), /touba package update/);
  }
});

test('catalog search groups identities, searches signed descriptions and distinguishes prereleases', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-catalog-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = { package_ref: 'pkg:acme.demo', version: '1.0.0', kind: 'touba_package', status: 'validated', summary: 'Weather adapter', metadata_path: 'meta.json', metadata_digest: 'sha256:' + '0'.repeat(64) };
  writeFileSync(join(root, 'index.json'), JSON.stringify({ index_schema_version: 'touba-registry-index-v1', packages: [entry, { ...entry, version: '2.0.0-rc.1' }] }));
  const result = await listRegistryPackages({ registry: root, query: 'Weather' });
  assert.equal(result.total, 1); assert.equal(result.items[0].version, '1.0.0');
  const info = await listRegistryPackages({ registry: root, query: 'acme.demo', exact: true });
  assert.equal(info.total, 2); assert.equal(info.items[1].prerelease, true);
  for (const locale of ['fr', 'en']) {
    const rendered = packageReportText({ command: 'package info', status: 'success', packages: info.items }, locale);
    assert.match(rendered, /Weather adapter/);
    assert.match(rendered, locale === 'fr' ? /Préversion/ : /Prerelease/);
  }
});
