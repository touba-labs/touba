import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newPackage, addPackage, reviewPackageUpdate, reviewPackageUpdates, removePackage, packPackage, checkPackageArchive } from '../src/packages.mjs';
import { updatePackageSet } from '../src/package-update-set.mjs';
import { packageCommand } from '../src/package-command.mjs';
import { initProject, prepareProject } from '../src/project.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readPackageWorkspace, verifyInstalledPackages } from '../src/package-store.mjs';
import { resolvePackageResource } from '../../../runtime/touba-handler-sdk/src/package-resources.mjs';

function edit(path, changes) {
  const manifest = join(path, 'touba.package.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest)), ...changes }));
}
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-compatible-update-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = newPackage('fixture.shared', { root, version: '1.0.0', publisher: 'Fixture', license: 'MIT' }).path;
  const left = newPackage('fixture.left', { root, version: '1.0.0', publisher: 'Fixture', license: 'MIT' }).path;
  const right = newPackage('fixture.right', { root, version: '1.0.0', publisher: 'Fixture', license: 'MIT' }).path;
  for (const side of [left, right]) {
    await addPackage(base, { root: side });
    edit(side, { package_schema_version: 'touba-package-v2', dependencies: { 'fixture.shared': '>=1.0.0 <2.0.0' } });
  }
  const app = join(root, 'app'); initProject({ root: app });
  for (const side of [left, right]) await addPackage(side, { root: app });
  const lock = () => verifyInstalledPackages(app, readPackageWorkspace(app).records);
  return { root, base, left, right, app, lock };
}

test('a shared diamond evolves after review without republishing its compatible consumers', async t => {
  const f = await fixture(t), old = f.lock();
  edit(f.base, { version: '1.1.0' });
  const plan = await reviewPackageUpdate(f.base, { root: f.app });
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.constraints.length, 2);
  assert.ok(plan.constraints.every(row => row.constraint === '>=1.0.0 <2.0.0' && row.version === '1.1.0'));
  assert.deepEqual(f.lock(), old);
  await reviewPackageUpdate(f.base, { root: f.app, accept: plan.review_digest });
  const current = f.lock();
  assert.equal(current.packages.find(pkg => pkg.name === 'fixture.shared').version, '1.1.0');
  for (const name of ['fixture.left', 'fixture.right']) {
    assert.deepEqual(current.packages.find(pkg => pkg.name === name), old.packages.find(pkg => pkg.name === name));
    assert.equal(resolvePackageResource(join(f.app, 'packages', name, 'touba.package.json'), 'fixture.shared', 'README.md'), join(f.app, 'packages/fixture.shared/README.md'));
  }
  const prepared = await prepareProject({ root: f.app, mode: 'write', entryRef: 'skill:fixture.left/Echo' });
  assert.equal(prepared.status, 'success', JSON.stringify(prepared.diagnostics));
  const check = await prepareProject({ root: f.app, mode: 'check' });
  assert.equal(check.status, 'success', JSON.stringify(check.diagnostics));
  const cli = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'run', '--project', f.app, '--inputs-json', '{"value":"compatible"}', '--output', 'json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(JSON.parse(run.stdout).result, 'compatible');
  for (const version of ['2.0.0', '1.2.0-rc.1']) {
    edit(f.base, { version });
    await assert.rejects(reviewPackageUpdate(f.base, { root: f.app }), error => error.code === 'PackageInUse' && /fixture\.(left|right) -> fixture.shared/.test(error.message));
    assert.deepEqual(f.lock(), current);
  }
  edit(f.base, { version: '1.1.0', description: 'Different content at an already selected version' });
  await assert.rejects(reviewPackageUpdate(f.base, { root: f.app }), { code: 'PackageVersionConflict' });
});

test('a bundled multi-package update reviews all replacements and preserves author ranges and exact archive locks', async t => {
  const f = await fixture(t);
  edit(f.base, { version: '1.2.0' });
  const authorPlan = await reviewPackageUpdate(f.base, { root: f.left });
  await reviewPackageUpdate(f.base, { root: f.left, accept: authorPlan.review_digest });
  assert.equal(JSON.parse(readFileSync(join(f.left, 'touba.package.json'))).dependencies['fixture.shared'], '>=1.0.0 <2.0.0');
  edit(f.left, { version: '1.1.0' });
  const archive = join(f.root, 'left.tar.gz'); await packPackage(f.left, { output: archive });
  const checked = await checkPackageArchive(archive);
  assert.equal(checked.packages.find(pkg => pkg.name === 'fixture.left').dependencies['fixture.shared'], '1.2.0');
  const old = f.lock(), plan = await reviewPackageUpdate(archive, { root: f.app });
  assert.deepEqual(plan.changes.map(row => row.name), ['fixture.left', 'fixture.shared']);
  assert.deepEqual(f.lock(), old);
  const rename = fs.renameSync; let injected = false;
  fs.renameSync = (source, target) => {
    if (!injected && target === join(f.app, 'packages/fixture.shared') && source.includes('.touba-package-stage-') && !source.includes('previous-')) {
      injected = true; throw Object.assign(new Error('Synthetic replacement interruption'), { code: 'EIO' });
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(reviewPackageUpdate(archive, { root: f.app, accept: plan.review_digest }), { code: 'EIO' }); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.deepEqual(f.lock(), old, 'an error after the first replacement restores every package and the exact lock');
  assert.equal(existsSync(join(f.app, '.touba-package-installing')), false);
  await reviewPackageUpdate(archive, { root: f.app, accept: plan.review_digest });
  assert.equal(f.lock().packages.find(pkg => pkg.name === 'fixture.shared').version, '1.2.0');
  assert.equal(f.lock().packages.find(pkg => pkg.name === 'fixture.left').version, '1.1.0');
  assert.deepEqual(f.lock().packages.find(pkg => pkg.name === 'fixture.right'), old.packages.find(pkg => pkg.name === 'fixture.right'));
  assert.equal(existsSync(join(f.app, '.touba-package-installing')), false);
});

test('independent roots share one review, reject stale input and roll back the whole set', async t => {
  const f = await fixture(t), before = f.lock();
  for (const path of [f.base, f.left, f.right]) edit(path, { version: '1.1.0' });
  const file = join(f.root, 'updates.json');
  writeFileSync(file, JSON.stringify({ schema_version: 'touba-package-update-set-v1', packages: ['left', 'right', 'shared'].map(path => ({ path })) }));
  const preview = await updatePackageSet(file, { root: f.app });
  assert.deepEqual(preview.roots.map(row => row.name), ['fixture.left', 'fixture.right', 'fixture.shared']);
  assert.equal(preview.changes.length, 3);
  assert.ok(preview.constraints.every(row => row.version === '1.1.0'));
  assert.deepEqual(f.lock(), before);
  edit(f.right, { description: 'Changed after preview' });
  await assert.rejects(updatePackageSet(file, { root: f.app, accept: preview.review_digest }), { code: 'PackageReviewChanged' });
  assert.deepEqual(f.lock(), before);
  const fresh = await updatePackageSet(file, { root: f.app });
  const rename = fs.renameSync; let injected = false;
  fs.renameSync = (source, target) => {
    if (!injected && target === join(f.app, 'packages/fixture.right') && source.includes('.touba-package-stage-') && !source.includes('previous-')) {
      injected = true; throw Object.assign(new Error('Synthetic set failure'), { code: 'EIO' });
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(updatePackageSet(file, { root: f.app, accept: fresh.review_digest }), { code: 'EIO' }); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.deepEqual(f.lock(), before);
  await packageCommand(['update-set', file, '--root', f.app, '--accept', fresh.review_digest, '--json']);
  assert.ok(f.lock().packages.every(pkg => pkg.version === '1.1.0'));
  assert.equal((await prepareProject({ root: f.app, mode: 'write', entryRef: 'skill:fixture.left/Echo' })).status, 'success');
  assert.equal((await prepareProject({ root: f.app, mode: 'check' })).status, 'success');
});

test('set selection rejects duplicate roots, ambiguous bundles and incompatible explicit choices', async t => {
  const f = await fixture(t), before = f.lock();
  edit(f.base, { version: '1.1.0' });
  const leftPlan = await reviewPackageUpdate(f.base, { root: f.left });
  await reviewPackageUpdate(f.base, { root: f.left, accept: leftPlan.review_digest });
  edit(f.left, { version: '1.1.0' }); edit(f.right, { version: '1.1.0' });
  await assert.rejects(reviewPackageUpdates([f.left, f.left], { root: f.app }), { code: 'PackageUpdateSetInvalid' });
  await assert.rejects(reviewPackageUpdates([f.left, f.right], { root: f.app }), { code: 'PackageDependencyConflict' });
  edit(f.base, { version: '2.0.0' });
  await assert.rejects(reviewPackageUpdates([f.left, f.right, f.base], { root: f.app }), { code: 'PackageInUse' });
  assert.deepEqual(f.lock(), before);
});

test('removing a dependency edge does not claim to remove the retained dependency contracts', async t => {
  const f = await fixture(t);
  removePackage('fixture.shared', { root: f.left });
  edit(f.left, { version: '1.1.0' });
  const review = await reviewPackageUpdate(f.left, { root: f.app });
  assert.equal(review.contract_changes.some(row => row.package === 'fixture.shared'), false);
  await reviewPackageUpdate(f.left, { root: f.app, accept: review.review_digest });
  assert.ok(f.lock().packages.some(pkg => pkg.name === 'fixture.shared'));
});
