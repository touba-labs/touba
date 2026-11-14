import { DatabaseSync } from 'node:sqlite';
import { handleToolRequest, createToolResult } from '../../../../touba-handler-sdk/src/index.mjs';

// Synthetic provider: atomic deduplication belongs to the effect owner.
// This fixture neither contacts nor qualifies a commercial provider.
const [database, mode] = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const response = await handleToolRequest(input, 'tool:test/Create', async context => {
  const { effect_id: id, request_digest: digest, attempt_index: attempt } = context.effect;
  const value = 'created:' + context.arguments.query;
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    db.prepare('INSERT INTO calls VALUES (?, ?, ?)').run(id, digest, attempt);
    const existing = db.prepare('SELECT digest FROM effects WHERE id = ?').get(id);
    if (existing && existing.digest !== digest) throw new Error('Provider request conflict');
    db.prepare('INSERT OR IGNORE INTO effects VALUES (?, ?, ?)').run(id, digest, value);
    db.exec('COMMIT');
  } finally { db.close(); }
  if (attempt === 1) {
    if (mode === 'missing') return value;
    if (mode === 'throw') throw new Error('Synthetic failure after committed write');
    if (mode === 'timeout') await new Promise(() => { setInterval(() => {}, 1000); });
  }
  const receipt = context.createEffectReceipt({ outcome: 'applied', receipt_ref: 'synthetic:created' });
  if (attempt === 1 && mode === 'invalid') receipt.request_digest = 'sha256:' + 'f'.repeat(64);
  return createToolResult(value, { effectReceipt: receipt });
});
process.stdout.write(JSON.stringify(response));
