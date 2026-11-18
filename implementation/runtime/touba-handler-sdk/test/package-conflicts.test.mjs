import test from 'node:test';
import assert from 'node:assert/strict';
import { packageConflictDetails } from '../src/package-conflicts.mjs';

test('conflict evidence preserves optional version context and strips private fields', () => {
  const row = { consumer: 'example.consumer', dependency: 'example.base', constraint: '>=1.0.0 <2.0.0', version: '2.0.0' };
  assert.deepEqual(packageConflictDetails([row]), [row]);
  const context = { ...row, current_version: '1.0.0', origin: 'installed', blocking: true };
  assert.deepEqual(packageConflictDetails([{ ...context, secret: 'private-sentinel' }]), [context]);
  for (const bad of [{ current_version: '/private/path' }, { origin: 'private-sentinel' }, { constraint: '\nprivate-sentinel' }, {blocking:'true'}]) {
    assert.equal(packageConflictDetails([{ ...context, ...bad }]), undefined);
  }
  assert.equal(packageConflictDetails(Array(129).fill(context)), undefined);
});
