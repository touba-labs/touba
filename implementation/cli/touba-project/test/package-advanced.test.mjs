import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '../src/project.mjs';
import { newPackage, addRegistryPackage, packPackage } from '../src/packages.mjs';
import { publishPackage } from '../src/package-publish.mjs';
import { restorePackages } from '../src/package-restore.mjs';
import { packageCommand } from '../src/package-command.mjs';
import { packageDiagnostic } from '../src/package-diagnostics.mjs';
import { packageReportText } from '../src/package-text.mjs';
import { acquirePackageTransaction } from '../src/package-store.mjs';
import { packageDigest } from '../src/package-contract.mjs';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-package-advanced-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const consumer = join(root, 'consumer'); mkdirSync(consumer); initProject({ root: consumer });
  const author = newPackage('acme.tools', { root, context: true, description: 'Reusable reference.', publisher: 'Acme', license: 'MIT' }).path;
  const registry = join(root, 'registry');
  await publishPackage(author, { registry });
  // Synthetic local catalogue: qualification is explicit, not inferred from publication.
  const index = JSON.parse(readFileSync(join(registry, 'index.json')));
  const entry = index.packages[0], metaPath = join(registry, entry.metadata_path);
  const meta = JSON.parse(readFileSync(metaPath)); meta.status = entry.status = 'validated';
  const bytes = JSON.stringify(meta); writeFileSync(metaPath, bytes);
  entry.metadata_digest = packageDigest(Buffer.from(bytes)); writeFileSync(join(registry, 'index.json'), JSON.stringify(index));
  await addRegistryPackage('acme.tools', { root: consumer, registry, version: '0.1.0' });
  return { root: consumer, author, registry, installed: join(consumer, 'packages/acme.tools') };
}

test('missing directory is listed and restored from the exact locked version without rewriting metadata', async t => {
  const f = await fixture(t);
  const files = ['touba.project.json', 'touba.packages.lock.json'];
  const before = files.map(file => readFileSync(join(f.root, file), 'utf8'));
  rmSync(f.installed, { recursive: true });
  const listed = JSON.parse((await packageCommand(['list', '--root', f.root, '--json'])).text);
  assert.equal(listed.packages[0].restrictions[0].code, 'PackageInstalledContentMissing');
  await assert.rejects(addRegistryPackage('acme.tools', { root: f.root, registry: f.registry, version: '0.1.0' }), { code: 'PackageInstalledContentMissing' });
  const report = await restorePackages(undefined, f);
  assert.equal(report.status, 'success'); assert.equal(report.lock_unchanged, true);
  assert.deepEqual(files.map(file => readFileSync(join(f.root, file), 'utf8')), before);
  assert.equal(JSON.parse((await packageCommand(['check', '--root', f.root, '--json'])).text).status, 'success');
});

test('restore refuses partial content and symlinks, never overwrites a present directory', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.installed, 'touba.package.json'), '{}');
  await assert.rejects(restorePackages(undefined, f));
  assert.equal(readFileSync(join(f.installed, 'touba.package.json'), 'utf8'), '{}');
  rmSync(f.installed, { recursive: true }); symlinkSync(f.author, f.installed, 'dir');
  await assert.rejects(restorePackages(undefined, f), { code: 'PackageSymlinkForbidden' });
});

test('search and exact info discover versions without installing or selecting latest', async t => {
  const f = await fixture(t);
  for (const [action, name] of [['search', 'tools'], ['info', 'acme.tools']]) {
    const result = JSON.parse((await packageCommand([action, name, '--registry', f.registry, '--root', f.root, '--json'])).text);
    assert.equal(result.packages[0].name, 'acme.tools'); assert.equal(result.packages[0].version, '0.1.0');
  }
  for (const version of ['latest', '^0.1.0', '>=0.1.0']) await assert.rejects(addRegistryPackage('acme.tools', { ...f, version }), { code: 'PackageExactVersionRequired' });
  await assert.rejects(addRegistryPackage('Acme.tools', { ...f, version: '0.1.0' }), { code: 'PackageNameInvalid' });
});

test('transaction races and public-key fingerprints have useful human diagnostics', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-package-marker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  acquirePackageTransaction(root, { pid: process.pid });
  assert.throws(() => acquirePackageTransaction(root, {}), { code: 'PackageInstallationIncomplete' });
  assert.match(packageDiagnostic({ code: 'RegistryFetchFailed', httpStatus: 503 }, 'fr'), /HTTP 503/);
  assert.match(packageDiagnostic({ code: 'PackageReviewChanged' }, 'fr'), /empreinte acceptée/);
  assert.match(packageReportText({ command: 'package registry', status: 'success', fingerprints: [{ id: 'test', status: 'active', sha256: 'a'.repeat(64) }] }, 'fr'), /SHA-256 SPKI DER: a{64}/);
  assert.match(packageReportText({ command: 'package add', status: 'success', packages: [{ name: 'acme.parent', version: '1.0.0', dependencies: { 'acme.child': '0.1.0' } }] }, 'fr'), /Dépendance embarquée de acme.parent : acme.child@0.1.0/);
});

test('per-command help is localized and does not open a project or network connection', async () => {
  const fr = (await packageCommand(['search', '--help', '--lang', 'fr', '--root', '/does-not-exist'])).text;
  assert.match(fr, /Recherche dans le catalogue vérifié/);
  assert.doesNotMatch(fr, /touba package publish/);
  const en = (await packageCommand(['restore', '-h', '--lang', 'en'])).text;
  assert.match(en, /Restore only missing managed directories/);
  assert.doesNotMatch(en, /touba package search/);
});

test('restore refuses a withdrawn version and preserves the exact lock', async t => {
  const f = await fixture(t);
  const before = readFileSync(join(f.root, 'touba.packages.lock.json'));
  rmSync(f.installed, { recursive: true });
  const indexPath = join(f.registry, 'index.json');
  const index = JSON.parse(readFileSync(indexPath));
  const entry = index.packages[0];
  entry.status = 'yanked';
  const metadataPath = join(f.registry, entry.metadata_path);
  const metadata = JSON.parse(readFileSync(metadataPath)); metadata.status = 'yanked';
  const bytes = JSON.stringify(metadata); writeFileSync(metadataPath, bytes);
  entry.metadata_digest = packageDigest(Buffer.from(bytes));
  writeFileSync(indexPath, JSON.stringify(index));
  await assert.rejects(restorePackages(undefined, f), { code: 'RegistryPackageYanked' });
  assert.deepEqual(readFileSync(join(f.root, 'touba.packages.lock.json')), before);
  assert.throws(() => readFileSync(join(f.installed, 'touba.package.json')), { code: 'ENOENT' });
});

test('a coherent registry cannot replace locked content during restoration', async t => {
  const f = await fixture(t);
  const before = readFileSync(join(f.root, 'touba.packages.lock.json'));
  rmSync(f.installed, { recursive: true });
  const indexPath = join(f.registry, 'index.json');
  const index = JSON.parse(readFileSync(indexPath));
  const entry = index.packages[0], metadataPath = join(f.registry, entry.metadata_path);
  const metadata = JSON.parse(readFileSync(metadataPath));
  const document = JSON.parse(readFileSync(join(f.author, 'touba.package.json')));
  writeFileSync(join(f.author, document.readme), '# Different content at the same version\n');
  const replacement = await packPackage(f.author, { output: join(f.registry, 'replacement.tar.gz') });
  writeFileSync(join(f.registry, metadata.artifacts[0].path), readFileSync(replacement.output));
  metadata.artifacts[0].digest = metadata.source.revision = replacement.digest;
  const bytes = JSON.stringify(metadata); writeFileSync(metadataPath, bytes);
  entry.metadata_digest = packageDigest(Buffer.from(bytes)); writeFileSync(indexPath, JSON.stringify(index));
  await assert.rejects(restorePackages(undefined, f), error => error.code === 'PackageIntegrityMismatch' && error.packageName === 'acme.tools');
  assert.deepEqual(readFileSync(join(f.root, 'touba.packages.lock.json')), before);
  assert.throws(() => readFileSync(join(f.installed, 'touba.package.json')), { code: 'ENOENT' });
});
