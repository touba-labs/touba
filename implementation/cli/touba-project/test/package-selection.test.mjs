import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPackageClosure } from '../src/package-selection.mjs';

const pkg = (name, version, dependencies = {}) => ({ document: { name, version, dependencies,
  package_schema_version: 'touba-package-v2' }, digest: `${name}-${version}` });
const map = packages => new Map(packages.map(p => [p.document.name, p]));
const check = packages => ({ closure: { packages } });

test('a reused parent excludes unused bundled descendants and their conflicting choices', () => {
  const oldBase = pkg('base', '1.1.0'), oldParent = pkg('parent', '1.0.0', { base: '>=1.0.0 <2.0.0' });
  const bundledParent = pkg('parent', '1.2.0', { extra: '1.0.0' });
  const extra = pkg('extra', '1.0.0', { base: '2.0.0' });
  const a = pkg('a', '1.0.0', { parent: '>=1.0.0 <2.0.0' });
  const b = pkg('b', '1.0.0', { parent: '>=1.0.0 <2.0.0' });
  const checks = [check([a, bundledParent, extra, pkg('base', '2.0.0')]),
    check([b, pkg('parent', '1.3.0', { extra: '2.0.0' }), pkg('extra', '2.0.0')])];
  const installed = map([oldBase, oldParent]);
  for (const roots of [[a, b], [b, a]]) {
    assert.deepEqual(selectPackageClosure(map(roots), checks, installed, { preferInstalled: true })
      .map(p => `${p.document.name}@${p.document.version}`), ['a@1.0.0', 'b@1.0.0', 'base@1.1.0', 'parent@1.0.0']);
  }
});

test('fallback revisits the reachable graph and preserves installed consumers', () => {
  const oldBase = pkg('base', '1.0.0'), oldParent = pkg('parent', '1.0.0', { base: '1.0.0' });
  const parent = pkg('parent', '1.1.0', { base: '1.1.0' }), base = pkg('base', '1.1.0');
  const root = pkg('root', '1.0.0', { parent: '1.1.0' });
  const result = selectPackageClosure(map([root]), [check([root, parent, base])], map([oldBase, oldParent]), { preferInstalled: true });
  assert.deepEqual(result.map(p => `${p.document.name}@${p.document.version}`), ['base@1.1.0', 'parent@1.1.0', 'root@1.0.0']);
});

test('reachable ambiguity and same-version different bytes fail closed', () => {
  const root = pkg('root', '1.0.0', { base: '>=1.0.0 <2.0.0' });
  assert.throws(() => selectPackageClosure(map([root]), [check([root, pkg('base', '1.0.0'), pkg('base', '1.1.0')])], new Map()), { code: 'PackageDependencyConflict' });
  assert.throws(() => selectPackageClosure(map([root]), [check([root, pkg('base', '1.0.0'), { ...pkg('base', '1.0.0'), digest: 'changed' }])], new Map()), { code: 'PackageVersionConflict' });
});
