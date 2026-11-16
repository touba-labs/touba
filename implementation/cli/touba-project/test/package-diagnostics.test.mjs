import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageCommand } from '../src/package-command.mjs';
import { packageDiagnostic } from '../src/package-diagnostics.mjs';
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
