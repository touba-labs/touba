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
  assert.equal(f.lock(), before);
  await reviewPackageUpdates([f.parent, f.base], { root: f.app, accept: a.review_digest });
  assert.equal(JSON.parse(f.lock()).packages.length, 2);
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
  await assert.rejects(addPackage(f.parent, { root: f.app }), { code: 'PackageVersionConflict' });
  assert.equal(f.lock(), before);
  edit(f.parent, { dependencies: { 'fixture.base': '>=1.0.0 <2.0.0' } });
  edit(f.base, { description: 'Different bytes at the installed version' });
  await assert.rejects(reviewPackageUpdates([f.parent, f.base], { root: f.app }), { code: 'PackageVersionConflict' });
  assert.equal(f.lock(), before);
});
