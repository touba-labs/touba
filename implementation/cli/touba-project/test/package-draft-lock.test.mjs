import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { acquireDraftLock } from '../src/package-draft-lock.mjs';
import { packageDiagnostic, packageSessionNotice } from '../src/package-diagnostics.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'touba-draft-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'draft.lock');
}
test('live owner is preserved and release never deletes a replacement', t => {
  const path = fixture(t), release = acquireDraftLock(path);
  const original = readFileSync(path, 'utf8');
  assert.throws(() => acquireDraftLock(path), { code: 'PackageDraftBusy' });
  assert.equal(readFileSync(path, 'utf8'), original);
  renameSync(path, path + '.old');
  const second = acquireDraftLock(path);
  release(); assert.ok(existsSync(path)); second(); assert.equal(existsSync(path), false);
});
test('a killed process leaves a recoverable local lock', async t => {
  const path = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireDraftLock } from ${JSON.stringify(new URL('../src/package-draft-lock.mjs', import.meta.url).href)}; acquireDraftLock(process.argv[1]); console.log('ready'); setInterval(() => {}, 1000);`, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child.stdout, 'data');
  assert.throws(() => acquireDraftLock(path), { code: 'PackageDraftBusy' });
  child.kill('SIGKILL'); await once(child, 'exit');
  const release = acquireDraftLock(path);
  assert.equal(JSON.parse(readFileSync(path)).pid, process.pid);
  release(); assert.equal(existsSync(path), false);
});
test('legacy, foreign, malformed and symlink locks are not guessed or removed', t => {
  const path = fixture(t);
  for (const value of ['123\n', '{', JSON.stringify({version: 1, pid: 2147483647, host: hostname() + '-foreign', id:'test'})]) {
    writeFileSync(path, value);
    assert.throws(() => acquireDraftLock(path), {code:'PackageDraftLockUnsafe'});
    assert.equal(readFileSync(path, 'utf8'), value); rmSync(path);
  }
  writeFileSync(path + '.target', 'keep'); symlinkSync(path + '.target', path);
  assert.throws(() => acquireDraftLock(path), {code:'PackageDraftLockUnsafe'});
  assert.equal(readFileSync(path + '.target', 'utf8'), 'keep');
});
test('author recovery diagnostics and session notices are bilingual', () => {
  for (const code of ['publication_authentication_required', 'PackageDraftBusy', 'PackageDraftLockUnsafe', 'PackageOptionInvalid', 'PackageAutomationRequestRequired']) {
    const error = {code, message: 'untranslated'};
    assert.notEqual(packageDiagnostic(error, 'fr'), packageDiagnostic(error, 'en'));
    assert.ok(packageDiagnostic(error, 'fr').startsWith(code + ':'));
  }
  assert.match(packageSessionNotice({logout: true}, 'fr'), /effacée/);
  assert.match(packageSessionNotice({persistent: true, minutes: 60}, 'fr'), /60 minutes/);
  assert.match(packageSessionNotice({persistent: true, read: true}, 'en'), /eight hours/);
});
