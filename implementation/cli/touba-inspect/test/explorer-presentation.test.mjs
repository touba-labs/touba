import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, fitGraphViewport } from '../src/explorer/web/view.mjs';

test('durations show days and hours without dropping the remaining units', () => {
  assert.equal(formatDuration(172800000, 'fr'), '2 j');
  assert.equal(formatDuration(172800000, 'en'), '2 d');
  assert.equal(formatDuration(9000000), '2 h 30 min');
  assert.equal(formatDuration(60500), '1 min 500 ms');
  assert.equal(formatDuration(0), '0 ms');
  for (const value of [null, undefined, -1, Infinity, NaN, '1000']) assert.equal(formatDuration(value), null);
});

test('large flows start with readable labels and their first node; Fit retains all nodes', () => {
  const layout = { width: 800, height: 6000, nodeWidth: 220, nodeHeight: 70, direction: 'vertical', positions: new Map([['last', { x: 100, y: 5900 }], ['first', { x: 100, y: 30 }]]) };
  const rect = { width: 700, height: 500 };
  const readable = fitGraphViewport(layout, rect, true), full = fitGraphViewport(layout, rect);
  assert.equal(rect.width / readable.w, 1);
  assert.ok(readable.y < 30 && readable.y + readable.h > 100);
  assert.ok(full.h >= layout.height && full.w >= layout.width);
  assert.equal(fitGraphViewport({ ...layout, direction: 'horizontal' }, rect, true).x, 76);
});
