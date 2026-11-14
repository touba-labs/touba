import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bindingReviewValue as display } from '../src/binding-review.mjs';

const root = resolve('isolated-review'), digest = 'sha256:' + 'b'.repeat(64);
test('handler review reveals interpreter category and counts, never command arguments or absolute paths', () => {
  const value = display('handler', { command: '/private/operator/python3.14', args: ['secret-token', 'handler.py'], cwd: '../..' }, digest,
    { root, manifestPath: resolve(root, '.touba/build/manifest.json') });
  assert.equal(value.executable, 'python3.14'); assert.equal(value.arguments_count, 2);
  assert.deepEqual(value.working_directory, { count: 1, paths: ['.'], hidden_count: 0 });
  assert.equal(value.digest, digest);
  assert.doesNotMatch(JSON.stringify(value), /secret-token|private\/operator|handler.py/);
});
test('sandbox review bounds project-relative access and hides external paths and code inventory', () => {
  const value = display('sandbox', { required: true, code_paths: ['/private/secret/library.py'],
    read_paths: ['data', '../private-client', '/private/sensitive', 'bad\npath'], write_paths: ['output'], local_sockets: ['/private/socket'] }, digest,
    { root, manifestPath: root });
  assert.deepEqual(value.read_access, { count: 4, paths: ['data'], hidden_count: 3 });
  assert.deepEqual(value.write_access, { count: 1, paths: ['output'], hidden_count: 0 });
  assert.deepEqual(value.code_inventory, { count: 1, paths_hidden: true });
  assert.doesNotMatch(JSON.stringify(value), /private|sensitive|library|socket"|bad/);
  assert.equal(display('sandbox', undefined, digest), digest, 'a missing old projection remains unknown, never reconstructed');
});
test('custom commands and unknown capabilities remain fingerprint-only; lists are bounded', () => {
  assert.equal(display('handler', { command: '/token-secret', args: [] }, digest).executable, '[hidden]');
  assert.equal(display('grants', ['secret-token'], digest), digest);
  assert.deepEqual(display('grants', ['network'], digest), ['network']);
  const many = display('sandbox', { read_paths: Array.from({ length: 20 }, (_, n) => 'data' + n) }, digest, { root, manifestPath: root });
  assert.equal(many.read_access.paths.length, 8); assert.equal(many.read_access.hidden_count, 12);
});
