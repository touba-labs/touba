import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolvePackageResource } from '../../../runtime/touba-handler-sdk/src/package-resources.mjs';
import { newPackage, addPackage, reviewPackageUpdates, checkPackage, packPackage } from '../src/packages.mjs';
import { packageCommand } from '../src/package-command.mjs';
import { packageDiagnostic } from '../src/package-diagnostics.mjs';
import { packageReportText } from '../src/package-text.mjs';
import { initProject, prepareProject } from '../src/project.mjs';

function edit(path, fields) {
  const file = join(path, 'touba.package.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), ...fields }));
}
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-install-selection-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const make = name => newPackage(`fixture.${name}`, { root, version: '1.0.0', publisher: 'Fixture', license: 'MIT' }).path;
  const base = make('base'), parent = make('parent');
  for (const [extension, code] of [['mjs', 'export const value = "1.0.0";'], ['py', 'value = "1.0.0"']]) writeFileSync(join(base, 'src/version.' + extension), code);
  await addPackage(base, { root: parent });
  edit(parent, { package_schema_version: 'touba-package-v2', dependencies: { 'fixture.base': '>=1.0.0 <2.0.0' } });
  edit(base, { version: '1.1.0' });
  for (const [extension, code] of [['mjs', 'export const value = "1.1.0";'], ['py', 'value = "1.1.0"']]) writeFileSync(join(base, 'src/version.' + extension), code);
  const app = join(root, 'app'); initProject({ root: app });
  await addPackage(base, { root: app });
  const lock = () => readFileSync(join(app, 'touba.packages.lock.json'), 'utf8');
  return { root, base, parent, app, lock };
}

test('adding a compatible package reviews reuse and preserves the original author closure', async t => {
  const f = await fixture(t), before = f.lock();
  const authorLock = readFileSync(join(f.parent, 'touba.packages.lock.json'));
  const preview = await addPackage(f.parent, { root: f.app });
  assert.equal(preview.status, 'review_required');
  assert.equal(preview.schema_version, 'touba-package-update-review-v2');
  assert.equal(preview.direction, 'add');
  assert.equal(preview.packages.find(p => p.name === 'fixture.base').version, '1.1.0');
  assert.equal(f.lock(), before);
  assert.equal(existsSync(join(f.app, 'packages/fixture.parent')), false);
  await addPackage(f.parent, { root: f.app, accept: preview.review_digest });
  assert.equal(JSON.parse(f.lock()).packages.find(p => p.name === 'fixture.base').version, '1.1.0');
  assert.deepEqual(readFileSync(join(f.parent, 'touba.packages.lock.json')), authorLock);
  assert.equal((await checkPackage(f.parent)).packages.find(p => p.name === 'fixture.base').version, '1.0.0');
  assert.equal((await prepareProject({ root: f.app, mode: 'write', entryRef: 'skill:fixture.parent/Echo' })).status, 'success');
  const installed = join(f.app, 'packages/fixture.parent/touba.package.json');
  assert.equal((await import(pathToFileURL(resolvePackageResource(installed, 'fixture.base', 'src/version.mjs')))).value, '1.1.0');
  const python = spawnSync('python3', ['-B', '-c', `import sys, importlib.util
sys.path.insert(0, sys.argv[1])
from touba_sdk import resolve_package_resource
path = resolve_package_resource(sys.argv[2], 'fixture.base', 'src/version.py')
spec = importlib.util.spec_from_file_location('selected', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.value)
`, fileURLToPath(new URL('../../../runtime/touba-python-sdk/src/', import.meta.url)), installed], { encoding: 'utf8', timeout: 10000 });
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), '1.1.0');
});

test('one transaction admits a new root and an unchanged explicit base in either order', async t => {
  const f = await fixture(t), before = f.lock();
  const a = await reviewPackageUpdates([f.parent, f.base], { root: f.app });
  const inferred = await reviewPackageUpdates([f.parent], { root: f.app });
  assert.equal(inferred.packages.find(p => p.name === 'fixture.base').version, '1.1.0');
  const b = await reviewPackageUpdates([f.base, f.parent], { root: f.app });
  assert.equal(a.review_digest, b.review_digest);
  assert.deepEqual(a.roots.map(r => r.direction), ['keep', 'add']);
  for (const locale of ['fr', 'en']) {
    const text = packageReportText(a, locale);
    assert.match(text, /fixture.base: 1.1.0 -> 1.1.0/);
    assert.match(text, /fixture.parent: absent -> 1.0.0/);
    assert.match(text, /fixture.base@1.0.0/);
    assert.match(text, locale === 'fr' ? /sélection 1.1.0/ : /selected 1.1.0/);
    assert.match(text, locale === 'fr' ? /conservé/ : /keep/);
  }
  assert.equal(f.lock(), before);
  const selection = join(f.root, 'selection.json');
  writeFileSync(selection, JSON.stringify({ schema_version: 'touba-package-update-set-v1', packages: [{ path: './parent' }, { path: './base' }] }));
  const french = (await packageCommand(['update-set', selection, '--root', f.app, '--lang', 'fr'])).text;
  assert.match(french, /Revue/); assert.match(french, /testé par l’auteur/);
  assert.doesNotMatch(french, /Review every|Installed and/);
  await reviewPackageUpdates([f.parent, f.base], { root: f.app, accept: a.review_digest });
  assert.equal(JSON.parse(f.lock()).packages.length, 2);
});

test('check, version and installation notes honor the explicit French locale', async t => {
  const f = await fixture(t);
  const source = newPackage('fixture.presentation', { root: f.root, version: '1.0.0', context: true }).path;
  const checked = (await packageCommand(['check', source, '--lang', 'fr'])).text;
  assert.match(checked, /Avant le partage/); assert.doesNotMatch(checked, /Before sharing/);
  const versioned = (await packageCommand(['version', 'patch', '--root', source, '--lang', 'fr'])).text;
  assert.match(versioned, /Version mise à jour/); assert.doesNotMatch(versioned, /Version updated/);
  const installed = (await packageCommand(['add', source, '--root', f.app, '--lang', 'fr'])).text;
  assert.match(installed, /Installé et enregistré/); assert.doesNotMatch(installed, /Installed and/);
});

test('CLI archive installation accepts a stable review across independent staging directories', async t => {
  const f = await fixture(t), archive = join(f.root, 'parent.tar.gz');
  await packPackage(f.parent, { output: archive });
  const preview = JSON.parse((await packageCommand(['add', archive, '--root', f.app, '--json'])).text);
  assert.equal(preview.status, 'review_required');
  const applied = JSON.parse((await packageCommand(['add', archive, '--root', f.app, '--accept', preview.review_digest, '--json'])).text);
  assert.equal(applied.status, 'success');
  assert.equal(JSON.parse(f.lock()).packages.find(p => p.name === 'fixture.base').version, '1.1.0');
});

test('changed source or workspace invalidates an installation review', async t => {
  const f = await fixture(t), before = f.lock();
  const plan = await addPackage(f.parent, { root: f.app });
  edit(f.parent, { description: 'Changed after preview' });
  await assert.rejects(addPackage(f.parent, { root: f.app, accept: plan.review_digest }), { code: 'PackageReviewChanged' });
  assert.equal(f.lock(), before);
});

test('incompatible installed consumers and equal-version content changes remain refused', async t => {
  const f = await fixture(t), before = f.lock();
  edit(f.parent, { dependencies: { 'fixture.base': '1.0.0' } });
  await assert.rejects(addPackage(f.parent, { root: f.app }), error => {
    assert.equal(error.code, 'PackageVersionConflict');
    assert.equal(error.reason, 'package_downgrade_review_required');
    for (const lang of ['fr', 'en']) assert.match(packageDiagnostic(error, lang), /touba package update-set --allow-downgrade/);
    return true;
  });
  assert.equal(f.lock(), before);
  edit(f.parent, { dependencies: { 'fixture.base': '>=1.0.0 <2.0.0' } });
  edit(f.base, { description: 'Different bytes at the installed version' });
  await assert.rejects(reviewPackageUpdates([f.parent, f.base], { root: f.app }), { code: 'PackageVersionConflict', reason: 'package_version_immutable' });
  assert.equal(f.lock(), before);
});

test('composition refusals name both the imposing package and the blocked consumer without writes', async t => {
  const f = await fixture(t);
  const consumer = newPackage('fixture.consumer', { root: f.root, version: '1.0.0', publisher: 'Fixture', license: 'MIT' }).path;
  await addPackage(f.base, { root: consumer });
  edit(consumer, { package_schema_version: 'touba-package-v2', dependencies: { 'fixture.base': '>=1.1.0 <2.0.0' } });
  await addPackage(consumer, { root: f.app });
  edit(f.parent, { dependencies: { 'fixture.base': '1.0.0' } });
  const before = f.lock(), config = readFileSync(join(f.app, 'touba.project.json'));
  for (const operation of [() => addPackage(f.parent, { root: f.app }),
    () => reviewPackageUpdates([f.parent], { root: f.app, 'allow-downgrade': true })]) {
    await assert.rejects(operation(), error => {
      assert.equal(error.code, 'PackageInUse');
      assert.deepEqual(error.constraints.map(row => row.consumer), ['fixture.consumer', 'fixture.parent']);
      assert.ok(error.constraints.every(row => row.version === '1.0.0'));
      assert.ok(error.constraints.every(row => row.current_version === '1.1.0'));
      assert.deepEqual(error.constraints.map(row => row.origin), ['installed', 'selected']);
      for (const lang of ['fr', 'en']) {
        const text = packageDiagnostic(error, lang);
        assert.match(text, /fixture.consumer/); assert.match(text, /fixture.parent/);
        assert.match(text, />=1.1.0 <2.0.0/);
      }
      return true;
    });
  }
  const cli = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
  const refused = spawnSync(process.execPath, [cli, 'package', 'add', f.parent, '--root', f.app, '--json', '--lang', 'fr'], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  const report = JSON.parse(refused.stdout);
  assert.equal(report.constraints.length, 2);
  assert.match(JSON.stringify(report), /Des contraintes/);
  const wrapper = newPackage('fixture.wrapper', { root: f.root, version: '1.0.0', publisher: 'Fixture', license: 'MIT' }).path;
  await addPackage(f.parent, { root: wrapper });
  await assert.rejects(addPackage(wrapper, { root: f.app }), error => {
    assert.equal(error.code, 'PackageInUse');
    assert.equal(error.constraints.find(row => row.consumer === 'fixture.parent').origin, 'selected', 'new transitive consumers are part of the selection, not already installed');
    return true;
  });
  assert.equal(f.lock(), before); assert.deepEqual(readFileSync(join(f.app, 'touba.project.json')), config);
});
