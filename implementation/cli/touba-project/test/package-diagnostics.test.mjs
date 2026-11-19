import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageCommand } from '../src/package-command.mjs';
import { packageDiagnostic, publicationRefusal } from '../src/package-diagnostics.mjs';
import { initProject } from '../src/project.mjs';

test('French list and new messages retain stable machine status', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-package-locale-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject({ root: join(root, 'consumer') });
  const listed = await packageCommand(['list', '--root', join(root, 'consumer'), '--lang', 'fr']);
  assert.match(listed.text, /réussi/);
  assert.match(listed.text, /Aucun package enregistré/);
  const machine = await packageCommand(['list', '--root', join(root, 'consumer'), '--lang', 'fr', '--json']);
  assert.equal(JSON.parse(machine.text).status, 'success');
  const created = await packageCommand(['new', 'fixture.fr', '--yes', '--root', root, '--lang', 'fr']);
  assert.match(created.text, /réussi/);
  assert.doesNotMatch(created.text, /Edit |Review |created|success/);
});

test('missing files and replaced drafts have safe bilingual guidance', () => {
  const replacementId = '01234567-0123-4567-89ab-0123456789ab';
  for (const lang of ['fr', 'en']) {
    const missing = Object.assign(new Error('sensitive raw path'), { code: 'PackageFileMissing' });
    assert.doesNotMatch(packageDiagnostic(missing, lang), /sensitive/);
    const replaced = Object.assign(new Error('untrusted'), { code: 'PackageDraftReplaced', replacementId });
    assert.match(packageDiagnostic(replaced, lang), new RegExp(`--draft ${replacementId}`));
    replaced.replacementId = '\nSECRET';
    assert.doesNotMatch(packageDiagnostic(replaced, lang), /SECRET|--draft/);
  }
});

test('parser errors honor explicit locale and safe diagnostics distinguish blocking consumers', async()=>{
  await assert.rejects(packageCommand(['list','--unknown','--lang','fr']),error=>{
    assert.match(packageDiagnostic(error),/Option invalide/);return true;
  });
  for(const code of ['RegistryTrustInvalid','PackagePathInvalid','PackageArchiveInvalid']) {
    assert.doesNotMatch(packageDiagnostic(Object.assign(new Error('ENOENT private-sentinel'),{code}),'fr'),/ENOENT|private-sentinel/);
  }
  const error={code:'PackageInUse',constraints:[
    {consumer:'example.old',dependency:'example.base',constraint:'1.0.0',version:'2.0.0',blocking:true},
    {consumer:'example.new',dependency:'example.base',constraint:'2.0.0',version:'2.0.0',blocking:false},
  ]};
  assert.match(packageDiagnostic(error,'fr'),/\[bloquant\] example.old/);
  assert.match(packageDiagnostic(error,'fr'),/\[compatible\] example.new/);
});

test('rollback and metadata refusal have localized remedies without private output', () => {
  const rollback = {code:'RegistryRollbackRefused'};
  assert.match(packageDiagnostic(rollback,'fr'), /continuité de confiance/);
  assert.match(packageDiagnostic(rollback,'en'), /trust continuity/);
  const error = publicationRefusal('PackageDraftRefused', {data:{error:'package_validation_failed',
    diagnostic:{phase:'inspection',code:'PackageMetadataInvalid',message:'PRIVATE_SENTINEL'}}}, 'refused');
  assert.match(packageDiagnostic(error,'fr'), /README/);
  assert.match(packageDiagnostic(error,'en'), /README/);
  assert.doesNotMatch(packageDiagnostic(error,'fr'), /PRIVATE_SENTINEL/);
});

test('recovery advice belongs only to installed packages and missing roots have stable diagnostics', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-package-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for(const lang of ['fr', 'en']) {
    for(const code of ['PackageNotInstalled','PackageIntegrityMismatch','PackageSymlinkForbidden']) {
      const rendered = packageDiagnostic(Object.assign(new Error('PRIVATE_SENTINEL'), {code}), lang);
      assert.ok(rendered.startsWith(code + ': '));
      assert.doesNotMatch(rendered, /PRIVATE_SENTINEL/);
    }
    const author = {code:'PackageMetadataInvalid'};
    assert.doesNotMatch(packageDiagnostic(author,lang), /package remove/);
    assert.match(packageDiagnostic({...author,installedPackageContext:true},lang), /package remove/);
    await assert.rejects(packageCommand(['remove','example.tools','--root',join(root,'missing'),'--lang',lang]), error => {
      assert.equal(error.code,'PackageProjectRequired');
      assert.doesNotMatch(packageDiagnostic(error), /ENOENT|PRIVATE_SENTINEL|realpath/);
      return true;
    });
  }
});
