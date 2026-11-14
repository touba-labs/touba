import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyChangeTargetsTransaction, recoverProjectChangeTransactions } from '../src/project-transactions.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const target = (path, content, before = null) => ({ path, content, content_sha256: digest(content),
  base_content_exists: before !== null, base_content_sha256: before === null ? null : digest(before) });

test('partial transaction failure rolls back existing and newly created targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'touba-transaction-'));
  try {
    writeFileSync(join(root, 'old.json'), 'original');
    assert.throws(() => applyChangeTargetsTransaction({ projectRoot: root, proposalId: 'rollback',
      decidedAt: new Date().toISOString(), targets: [target('old.json', 'changed', 'original'),
        target('new.json', 'created'), target('new.json/child.json', 'unreachable')] }), /rolled back/);
    assert.equal(readFileSync(join(root, 'old.json'), 'utf8'), 'original');
    assert.equal(existsSync(join(root, 'new.json')), false);
    assert.equal(existsSync(join(root, '.touba/project-change.lock')), false);
    assert.equal(recoverProjectChangeTransactions({ projectRoot: root }).status, 'clean');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a concurrent edit is refused before any write and releases the lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'touba-transaction-'));
  try {
    writeFileSync(join(root, 'old.json'), 'concurrent');
    assert.throws(() => applyChangeTargetsTransaction({ projectRoot: root, proposalId: 'conflict',
      decidedAt: new Date().toISOString(), targets: [target('new.json', 'created'), target('old.json', 'changed', 'original')] }),
    error => error.code === 'ToubaServeChangeConflict');
    assert.equal(readFileSync(join(root, 'old.json'), 'utf8'), 'concurrent');
    assert.equal(existsSync(join(root, 'new.json')), false);
    assert.equal(existsSync(join(root, '.touba/project-change.lock')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
