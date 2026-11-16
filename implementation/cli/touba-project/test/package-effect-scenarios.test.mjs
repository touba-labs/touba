import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { testPackage } from '../src/package-author.mjs';
import { readPackage } from '../src/package-contract.mjs';

test('explicit author effect scenarios execute the packaged handler and detect deficient controls', async () => {
  const root = fileURLToPath(new URL('../../../examples/package-effect-scenarios/', import.meta.url));
  const before = readPackage(root).digest;
  const result = await testPackage(root);
  assert.equal(result.status, 'success', result.stdout + result.stderr);
  assert.equal(result.tests, 5);
  assert.equal(readPackage(root).digest, before);
});
