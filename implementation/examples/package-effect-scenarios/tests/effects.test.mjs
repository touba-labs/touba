import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOUBA_SDK_METADATA } from '@touba/sdk';
import { assertEffectScenario } from '@touba/sdk/testing';
import { executeAirDocument, loadToolBindingManifestFromJson } from '@touba/runtime';
import { createSqliteEffectJournal } from '@touba/runtime/sqlite-effect-journal';

const tool = 'tool:example.effect_scenarios/Write';
const entry = 'skill:example.effect_scenarios/WriteOnce';
const cli = (...args) => {
  try { return execFileSync(process.execPath, [process.env.TOUBA_TEST_CLI, ...args], { encoding: 'utf8', timeout: 20000 }); }
  catch (error) { throw new Error(`Synthetic fixture command failed: ${error.stdout?.slice(-2000) ?? ''}`); }
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));

// The controller owns the durable observation store. The handler receives only
// an HTTP endpoint, not its database path or the effect journal's location.
async function service(root, loseFirstReply) {
  const db = new DatabaseSync(join(root, 'service.sqlite'));
  db.exec('CREATE TABLE calls (key TEXT, digest TEXT); CREATE TABLE writes (key TEXT PRIMARY KEY, digest TEXT, value TEXT)');
  const token = '/' + randomUUID();
  const counts = () => ({ calls: db.prepare('SELECT count(*) AS n FROM calls').get().n, writes: db.prepare('SELECT count(*) AS n FROM writes').get().n });
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== token || counts().calls >= 16) { response.writeHead(403).end(); return; }
    try {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw new Error('Bound exceeded'); }
      const { key, digest, value } = JSON.parse(raw);
      if (![key, digest, value].every(v => typeof v === 'string' && v.length <= 1024)) throw new Error('Invalid record');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO calls VALUES (?, ?)').run(key, digest);
        const prior = db.prepare('SELECT digest, value FROM writes WHERE key = ?').get(key);
        if (prior && (prior.digest !== digest || prior.value !== value)) throw new Error('Request conflict');
        db.prepare('INSERT OR IGNORE INTO writes VALUES (?, ?, ?)').run(key, digest, value);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (loseFirstReply && counts().calls === 1) { response.destroy(); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ value }));
    } catch { if (!response.destroyed) response.writeHead(422).end(); }
  });
  server.requestTimeout = 2000; server.headersTimeout = 2000; server.timeout = 2000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { endpoint: `http://127.0.0.1:${server.address().port}${token}`, counts,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); } };
}

async function experiment(kind, behavior = 'healthy') {
  // Nested below the extracted package so imports use the toolchain test SDK.
  // These temporary files are outside its explicit package inventory.
  const root = mkdtempSync(join(process.cwd(), '.effect-case-'));
  let provider;
  try {
    provider = await service(root, kind !== 'duplicate');
    const consumer = join(root, 'consumer'); mkdirSync(consumer);
    cli('init', '--root', consumer);
    cli('package', 'add', process.cwd(), '--root', consumer);
    const configPath = join(consumer, 'touba.project.json'), config = json(configPath);
    delete config.entry; config.entrypoints = [entry];
    writeFileSync(configPath, JSON.stringify(config));
    // Resolution uses the exact SDK provided to these author tests, not a
    // network installation or a link maintained by a user's application.
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, dependencies: { '@touba/sdk': TOUBA_SDK_METADATA.version } }));
    const policy = kind === 'reconciliation_required' ? 'reconcile' : 'idempotency_key';
    const host = join(root, 'host.json');
    writeFileSync(host, JSON.stringify({ bindings: { [tool]: { package_handler: 'example.effect-scenarios', grants: ['network'],
      effect_contract: { kind: 'external_write', retry_mode: policy }, configuration: { endpoint: provider.endpoint, behavior } } } }));
    cli('prepare', '--root', consumer, '--entry', entry, '--mode', 'write', '--host-decisions', host);
    const airDocument = json(join(consumer, '.touba/build/dev/air/example/effect_scenarios.air.json'));
    const manifestPath = join(consumer, '.touba/build/dev/touba.manifest.json'), rawManifest = json(manifestPath);
    // File-based CLI loading resolves handler cwd relative to its manifest.
    // The direct runtime JSON API takes the already resolved host bindings.
    for (const binding of Object.values(rawManifest.bindings)) {
      if (binding.handler?.cwd) binding.handler.cwd = resolve(dirname(manifestPath), binding.handler.cwd);
    }
    const manifest = loadToolBindingManifestFromJson(JSON.stringify(rawManifest));
    const journalPath = join(root, 'run.effect-journal.sqlite');
    const scope = 'synthetic:' + randomUUID();
    const observations = { before: provider.counts(), runs: [] };
    for (let i = 0; i < 3; i++) {
      // Same scope, arguments, program and journal; a new adapter per execution.
      // Runs are sequential and this fixture is the journal's sole writer.
      const result = await executeAirDocument(airDocument, { entryRef: entry, inputs: { value: 'synthetic record' },
        toolBindingManifest: manifest, effectScopeId: scope, effectJournal: createSqliteEffectJournal(journalPath) });
      const records = createSqliteEffectJournal(journalPath).entriesForScope(scope);
      assert.equal(records.length, 1);
      const { tool_ref, effect_id, request_digest, state, attempt_count, receipt } = records[0];
      observations.runs.push({ status: result.status,
        reason: result.status === 'success' ? result.reason : result.trace.events.findLast(e => e.kind === 'failure_detected')?.payload.runtime_error_code,
        effect: { tool_ref, effect_id, request_digest, state, attempt_count, ...(receipt ? { receipt } : {}) }, service: provider.counts() });
      if (result.status === 'success') assert.equal(result.result, 'synthetic record');
    }
    return assertEffectScenario({ schema_version: 'touba-effect-scenario-v1', id: kind.replaceAll('_', '-'), tool_ref: tool, case: kind }, observations);
  } finally {
    await provider?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const kind of ['duplicate', 'lost_reply', 'reconciliation_required']) {
  test(kind, async () => assert.equal((await experiment(kind)).status, 'passed'));
}
test('negative control: a handler with no receipt does not pass', async () => {
  await assert.rejects(experiment('duplicate', 'missing_receipt'), /unexpected scenario run status/);
});
test('negative control: a new idempotency key on retry produces a second write and fails', async () => {
  await assert.rejects(experiment('lost_reply', 'bad_key'), /committed writes/);
});
