import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newPackage, packPackage, checkPackageArchive } from '../src/packages.mjs';
import { packageCommand } from '../src/package-command.mjs';

test('archive checks reuse source validation, expose contracts and never run author tests', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-archive-check-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created = newPackage('fixture.transport', { root, license: 'Apache-2.0', publisher: 'Test publisher' });
  const manifestFile = join(created.path, 'touba.package.json');
  const manifest = JSON.parse(readFileSync(manifestFile));
  writeFileSync(join(created.path, manifest.contract_tests[0]), 'throw new Error("Author code must not run")');
  const archive = await packPackage(created.path);
  const before = readFileSync(archive.output);
  const checked = await checkPackageArchive(archive.output, { publishing: true });
  assert.equal(checked.package, 'fixture.transport');
  assert.equal(checked.archive_digest, archive.digest);
  assert.deepEqual(checked.manifest, manifest);
  assert.ok(checked.readme.includes('transport'));
  assert.equal(checked.closure, undefined);
  assert.deepEqual(readFileSync(archive.output), before);
  const result = await packageCommand(['check', archive.output, '--publishing', '--json']);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.text).archive_digest, archive.digest);
  assert.equal(existsSync(join(created.path, '.touba/build')), false);
});

test('invalid archive is refused without fallback to its containing directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-archive-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'invalid.tar.gz');
  writeFileSync(path, 'not an archive');
  await assert.rejects(checkPackageArchive(path), { code: 'PackageArchiveInvalid' });
});
