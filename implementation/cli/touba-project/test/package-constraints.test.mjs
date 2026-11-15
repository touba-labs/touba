import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import semver from 'semver';
import { validPackageConstraint, satisfiesPackageConstraint } from '../../../runtime/touba-handler-sdk/src/package-constraints.mjs';

test('portable dependency constraints agree in JavaScript, Python and comparator precedence', () => {
  const cases = JSON.parse(readFileSync(new URL('../../../contracts/packages/dependency-constraints.json', import.meta.url))).cases;
  const versions = ['0.0.0', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '1.0.0-rc.1', '1.0.0-beta.2', '1.0.0-beta.11'];
  for (const first of versions) for (const second of versions) for (const op of ['>', '>=', '<', '<=', '=']) {
    const constraint = `${op}${second}`;
    cases.push([first, constraint, semver.satisfies(first, constraint)]);
  }
  for (const [selected, constraint, expected] of cases) {
    assert.equal(satisfiesPackageConstraint(selected, constraint, 'touba-package-v2'), expected, `${selected} in ${constraint}`);
    if (typeof constraint === 'string' && /[<>=]/.test(constraint)) assert.equal(validPackageConstraint(constraint, 'touba-package-v1'), false);
  }
  const sdk = fileURLToPath(new URL('../../../runtime/touba-python-sdk/src/touba_sdk', import.meta.url));
  const result = spawnSync('python3', ['-I', '-S', '-c', `import sys,json\nsys.path.insert(0,${JSON.stringify(sdk)})\nfrom package_resources import _satisfies_constraint\ncases=json.load(sys.stdin)\nprint(json.dumps([_satisfies_constraint(v,c,'touba-package-v2') for v,c,_ in cases]))`], { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), cases.map(item => item[2]));
  assert.equal(validPackageConstraint('>=1.0.0 '.repeat(9).trim(), 'touba-package-v2'), false);
  assert.equal(satisfiesPackageConstraint('1.0.0', '1.0.0', 'unknown'), false);
});
