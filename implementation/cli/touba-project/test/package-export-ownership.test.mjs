import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPackageModuleOwnership, validatePackageDocument } from '../src/package-contract.mjs';
import { packageDiagnostic, publicationRefusal } from '../src/package-diagnostics.mjs';

function manifest(name, module) {
  return { package_schema_version: 'touba-package-v1', name, version: '1.0.0',
    touba: { air_profile: 'touba-air-json-canonical-v1', runtime_compatibility: '>=1.0.0 <2.0.0' },
    exports: { skills: [`skill:${module}/Run`] } };
}

test('exports belong to the canonical package module or its dot-separated children', () => {
  for (const module of ['acme_team.http_client', 'acme_team.http_client.extra']) {
    assert.doesNotThrow(() => validatePackageDocument(manifest('acme-team.http-client', module)));
  }
  for (const module of ['other.http', 'acme_team.http_clients', 'touba.official', 'acme_team.other.extra']) {
    assert.throws(() => validatePackageDocument(manifest('acme-team.http-client', module)), { code: 'PackageModuleOwnershipMismatch' });
  }
  assert.throws(() => validatePackageDocument(manifest('acme-team.http-client', 'acme_team')), { code:'PackageExportUnknownRef' });
});

test('ownership covers all export kinds, not only executable entry points', () => {
  for (const [kind, type] of Object.entries({ types:'type', defines:'constant', functions:'function', tools:'tool', skills:'skill', agents:'agent', strategies:'strategy', memories:'memory' })) {
    const document=manifest('acme.tools','acme.tools');
    document.exports={ [kind]: [`${type}:other.tools/Thing`] };
    assert.throws(() => validatePackageDocument(document), { code:'PackageModuleOwnershipMismatch' });
  }
});

test('installed packages cannot overlap through parent and child module claims', () => {
  const parent={ document:manifest('acme.tools','acme.tools') };
  const child={ document:manifest('acme.tools.extra','acme.tools.extra') };
  for (const packages of [[parent,child],[child,parent]]) {
    assert.throws(() => assertPackageModuleOwnership(packages), {code:'PackageModuleConflict'});
  }
  assert.doesNotThrow(() => assertPackageModuleOwnership([parent,{ document:manifest('acme.toolbox','acme.toolbox') }]));
  assert.doesNotThrow(() => assertPackageModuleOwnership([parent,{ document:manifest('acme.tools','acme.tools.extra') }]));
  assert.throws(() => assertPackageModuleOwnership([{ document:manifest('acme.other','acme.tools.extra') }]), {code:'PackageModuleOwnershipMismatch'});
});

test('ownership diagnostics name bounded modules in both languages without terminal controls', () => {
  let refusal;
  try { validatePackageDocument(manifest('acme.tools', 'other.tools')); } catch (error) { refusal=error; }
  for (const lang of ['fr', 'en']) {
    assert.match(packageDiagnostic(refusal,lang), /acme\.tools: other\.tools/);
    refusal.moduleClaims=[{package:'acme.tools',module:'other.tools\u001b[31m'}];
    assert.doesNotMatch(packageDiagnostic(refusal,lang), /\u001b/);
    refusal.moduleClaims=[{package:'acme.tools',module:'other.tools'}];
  }
  try { assertPackageModuleOwnership([{document:manifest('acme.tools','acme.tools')},
    {document:manifest('acme.tools.extra','acme.tools.extra')}]); } catch (error) { refusal=error; }
  assert.match(packageDiagnostic(refusal,'fr'), /acme\.tools: acme\.tools/);
  assert.match(packageDiagnostic(refusal,'en'), /acme\.tools\.extra: acme\.tools\.extra/);
  const remote = claims => publicationRefusal('RegistryPublicationFailed', { data: { error: 'package_module_conflict',
    diagnostic: { phase: 'ownership', code: 'PackageModuleConflict', claims } } }, 'refused');
  for (const lang of ['fr','en']) {
    assert.match(packageDiagnostic(remote([{package:'legacy.tools',module:'acme.tools'}]),lang), /legacy\.tools: acme\.tools/);
    assert.deepEqual(remote([{package:'private\nsecret',module:'acme.tools'}]).moduleClaims,[]);
    assert.deepEqual(remote([{package:'legacy.tools',module:'acme.tools',secret:'hidden'}]).moduleClaims,[{package:'legacy.tools',module:'acme.tools'}]);
  }
});
