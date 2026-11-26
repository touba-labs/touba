import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareValidationPlan, validationPlanCommand } from '../src/validation-plan-command.mjs';
import { readValidationPlan } from '../../touba-project-server/src/project-validation.mjs';
import { validateObject } from '../../../contracts/product-surfaces/validate.mjs';
import { fileURLToPath } from "node:url";


const reviewSchema = JSON.parse(readFileSync(new URL('../../../contracts/product-surfaces/schemas/touba-validation-plan-review-v1.schema.json', import.meta.url)));

const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
test('validation help works outside a project and does not inspect or write files', () => {
  for (const args of [['plan', '--help'], ['plan', '-h'], ['--help']]) {
    const result = validationPlanCommand(args);
    assert.equal(result.exitCode, 0);
    assert.match(result.text, /Usage: touba validation plan/);
    assert.match(result.text, /--review-digest/);
    assert.match(result.text, /--python/);
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url)),
    'validation', 'plan', '--help'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preview first/);
  assert.throws(() => validationPlanCommand(['plan', '--help', '--apply']), { code: 'ToubaValidationPlanOptionsInvalid' });
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'touba-plan-generation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests/demo.test.mjs'), 'throw new Error("generation must not execute tests");');
  writeFileSync(join(root, 'handler.mjs'), 'export const result = 42;');
  const suite = { id: 'contracts', label: 'Contracts', kind: 'contract', engine: 'node',
    tests: ['tests/demo.test.mjs'], inputs: { 'handler.mjs': '' }, timeout_ms: 30000, env: [], tool_refs: ['tool:demo/Read'] };
  return { root, suite };
}
test('a reviewed plan pins selected files without executing them and preserves other suites', t => {
  const options = fixture(t), path = join(options.root, 'tests/validation.json');
  const preview = prepareValidationPlan(options);
  assert.deepEqual(validateObject(reviewSchema, preview), []);
  assert.equal(preview.status, 'preview'); assert.equal(existsSync(path), false);
  assert.equal(preview.after.suites[0].inputs['handler.mjs'], sha(readFileSync(join(options.root, 'handler.mjs'))));
  const written = prepareValidationPlan({ ...options, apply: true, reviewDigest: preview.review_digest });
  assert.equal(written.status, 'written');
  assert.deepEqual(validateObject(reviewSchema, written), []);
  assert.deepEqual(readValidationPlan(options.root, path), written.after.suites);
  const next = { ...options, suite: { ...options.suite, id: 'business', kind: 'business', tool_refs: [] } };
  const reviewed = prepareValidationPlan(next);
  prepareValidationPlan({ ...next, apply: true, reviewDigest: reviewed.review_digest });
  assert.deepEqual(readValidationPlan(options.root, path).map(s => s.id), ['contracts', 'business']);
});
test('changes between preview and write require a fresh review', t => {
  const options = fixture(t), preview = prepareValidationPlan(options);
  const input = join(options.root, 'handler.mjs'), path = join(options.root, 'tests/validation.json');
  writeFileSync(input, 'export const result = 43;');
  assert.throws(() => prepareValidationPlan({ ...options, apply: true, reviewDigest: preview.review_digest }), { code: 'ToubaValidationPlanReviewStale' });
  assert.equal(existsSync(path), false);
  const next = prepareValidationPlan(options);
  prepareValidationPlan({ ...options, apply: true, reviewDigest: next.review_digest });
  const before = readFileSync(path);
  writeFileSync(input, 'export const result = 44;');
  const refresh = { root: options.root, refresh: true };
  const review = prepareValidationPlan(refresh);
  assert.deepEqual(readFileSync(path), before);
  assert.notEqual(review.before.suites[0].inputs['handler.mjs'], review.after.suites[0].inputs['handler.mjs']);
  prepareValidationPlan({ ...refresh, apply: true, reviewDigest: review.review_digest });
  assert.equal(readValidationPlan(options.root, path).length, 1);
  assert.throws(() => prepareValidationPlan({ ...options, apply: true, reviewDigest: next.review_digest }), { code: 'ToubaValidationPlanReviewStale' });
});
test('generation rejects traversal, links, unknown switches and arbitrary host commands', t => {
  const options = fixture(t);
  for (const input of ['../outside', '/etc/passwd', 'tests/../handler.mjs', 'tests\\demo.test.mjs']) {
    assert.throws(() => prepareValidationPlan({ ...options, suite: { ...options.suite, inputs: { [input]: '' } } }), { code: 'ToubaValidationPathInvalid' });
  }
  symlinkSync(join(options.root, 'handler.mjs'), join(options.root, 'linked.mjs'));
  assert.throws(() => prepareValidationPlan({ ...options, suite: { ...options.suite, inputs: { 'linked.mjs': '' } } }), { code: 'ToubaValidationPathInvalid' });
  symlinkSync(join(options.root, 'tests'), join(options.root, 'linked-tests'));
  assert.throws(() => prepareValidationPlan({ ...options, output: 'linked-tests/plan.json' }), { code: 'ToubaValidationPathInvalid' });
  for (const tail of [['--command', 'sh'], ['--apply', '--apply'], ['--refresh', '--engine', 'node']]) {
    assert.throws(() => validationPlanCommand(['plan', ...tail]), { code: 'ToubaValidationPlanOptionsInvalid' });
  }
  assert.throws(() => prepareValidationPlan({ ...options, suite: { ...options.suite, command: 'sh' } }), { code: 'ToubaValidationPlanInvalid' });
});
test('Python interpreter pinning reads bytes without starting the executable', t => {
  const options = fixture(t), python = join(options.root, 'python');
  writeFileSync(python, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  writeFileSync(join(options.root, 'tests/test_demo.py'), 'raise Exception("not executed")');
  const preview = prepareValidationPlan({ root: options.root, suite: { ...options.suite, engine: 'python',
    tests: ['tests/test_demo.py'], python: { command: python } } });
  assert.equal(preview.after.suites[0].python.digest, sha(readFileSync(python)));
});
test('the real CLI previews and writes a plan with the exact reviewed digest', t => {
  const { root } = fixture(t);
  const args = [fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'validation', 'plan',
    '--root', root, '--id', 'contracts', '--test', 'tests/demo.test.mjs', '--input', 'handler.mjs'];
  const preview = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  const digest = JSON.parse(preview.stdout).review_digest;
  const written = spawnSync(process.execPath, [...args, '--apply', '--review-digest', digest], { encoding: 'utf8' });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(JSON.parse(written.stdout).status, 'written');
});
