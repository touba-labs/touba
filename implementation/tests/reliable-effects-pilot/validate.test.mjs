import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { packPackage, addPackage } from '../../cli/touba-project/src/packages.mjs';
import { initProject } from '../../cli/touba-project/src/project.mjs';
import { installSdk } from '../../cli/touba-project/src/sdk-command.mjs';
import { packageSdk } from '../../cli/touba-distribution/src/package-sdk.mjs';
import { createCompensation } from '../../runtime/touba-runtime/src/compensation.mjs';
import { createSqliteCompensationStore } from '../../runtime/touba-runtime/src/sqlite-compensation-store.mjs';
import { createSqliteEffectJournal } from '../../runtime/touba-runtime/src/sqlite-effect-journal.mjs';
import { executeAirDocument, loadSecretsFromJson } from '../../runtime/touba-runtime/src/index.mjs';
import { isolatedPostgres } from '../helpers/postgres.mjs';

const here = dirname(fileURLToPath(import.meta.url)), implementation = resolve(here, '../..');
const library = process.env.TOUBA_TEST_LIBRARY ?? resolve(implementation, '../../touba-library');
const require = createRequire(new URL('../../cli/touba-run/package.json', import.meta.url));
const { Client } = require('pg'), pgPath = require.resolve('pg');

test('installed HTTP/SQL packages: compiled workflow, lost receipt, restart, reconciliation, conflict and compensation', { timeout: 120000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-real-package-effects-')));
  const project = join(root, 'consumer');
  let admin, server, postgres, reads = 0;
  t.after(async () => {
    try { await admin?.end(); }
    finally {
      if (server) await new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); });
      try { await postgres?.stop(); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  mkdirSync(project); initProject({ root: project });
  for (const name of ['touba.http-api', 'touba.sql-effects']) {
    const archive = join(root, name + '.tar.gz');
    await packPackage(join(library, 'packages', name), { output: archive });
    await addPackage(archive, { root: project });
  }
  const toolchain = join(root, 'toolchain');
  const sdk = packageSdk(implementation, toolchain);
  writeFileSync(join(toolchain, 'TOOLCHAIN.json'), JSON.stringify({ sdk }));
  installSdk('javascript', { root: project, distributionRoot: toolchain });
  cpSync(join(here, 'program.tb'), join(project, 'src/pilot.tb'));
  mkdirSync(join(project, 'handlers'), { recursive: true }); cpSync(join(here, 'handlers.mjs'), join(project, 'handlers/pilot.mjs'));
  const air = JSON.parse(execFileSync(process.execPath, [join(implementation, 'cli/touba-project/src/main.mjs'), 'compile', join(project, 'src/pilot.tb'), '--stdout'],
    { encoding: 'utf8', cwd: project, timeout: 30000 }));
  postgres = await isolatedPostgres({ user: 'effects_test', password: 'isolated-effects-test', database: 'effects_test' });
  const { port } = postgres;
  const connection = `postgresql://effects_test:isolated-effects-test@127.0.0.1:${port}/effects_test`;
  for (let attempt = 0; attempt < 50; attempt++) {
    admin = new Client({ connectionString: connection, connectionTimeoutMillis: 1000 });
    try { await admin.connect(); break; }
    catch (error) { await admin.end().catch(() => {}); admin = null; if (attempt === 49) throw error; await wait(100); }
  }
  await admin.query(readFileSync(join(project, 'packages/touba.sql-effects/sql/schema.sql'), 'utf8'));
  await admin.query('CREATE TABLE orders(id text PRIMARY KEY, status text NOT NULL)');
  server = createServer((_request, response) => { reads++; response.setHeader('content-type', 'application/json'); response.end('{"available":true}'); });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const handlerProbe = JSON.parse(execFileSync(process.execPath, ['handlers/pilot.mjs', 'tool:touba.http_api/Read', pgPath, origin],
    { cwd: project, input: '{}', encoding: 'utf8', timeout: 5000 }));
  assert.equal(handlerProbe.error.code, 'InvalidProtocol');
  const binding = (ref, write = false) => ({
    handler: { kind: 'process', command: process.execPath, args: ['handlers/pilot.mjs', ref, pgPath, origin, 'lose-first-receipt'], cwd: project },
    grants: ref === 'tool:touba.http_api/Read' ? ['network'] : ['network', 'secret_read'],
    secrets: ref === 'tool:touba.http_api/Read' ? [] : ['PILOT_DATABASE'], timeout_ms: 5000, max_payload_bytes: 65536,
    effect_contract: write ? { kind: 'external_write', retry_mode: 'idempotency_key' } : { kind: 'none' },
  });
  const manifest = { manifest_version: 'touba-manifest-v1', bindings: {
    'tool:touba.http_api/Read': binding('tool:touba.http_api/Read'), 'tool:pilot/CreateOrder': binding('tool:pilot/CreateOrder', true),
    'tool:pilot/ReadStatus': binding('tool:pilot/ReadStatus'), 'tool:pilot/ReleaseOrder': binding('tool:pilot/ReleaseOrder', true),
  } };
  manifest.bindings['tool:pilot/CreateOrder'].effect_contract.compensation = { entry_ref: 'strategy:pilot/Release' };
  const secretStore = loadSecretsFromJson(JSON.stringify({ secrets_version: 'touba-secrets-v1', secrets: {
    PILOT_DATABASE: { source: 'env', name: 'PILOT_DATABASE' },
  } }), { env: { PILOT_DATABASE: connection } });
  const journalPath = join(root, 'effects.sqlite'), compensationPath = join(root, 'compensations.sqlite');
  const journal = () => createSqliteEffectJournal(journalPath, { secretValues: [connection] });
  const common = { entryRef: 'strategy:pilot/Create', inputs: { order_id: 'order-17' }, effectScopeId: 'operation:order-17',
    toolBindingManifest: manifest, secretStore };
  const interrupted = await executeAirDocument(air, { ...common, effectJournal: journal() });
  assert.equal(interrupted.status, 'failure');
  assert.equal(journal().entriesForScope(common.effectScopeId)[0]?.state, 'unknown', JSON.stringify(interrupted.trace));
  assert.equal((await admin.query("SELECT status FROM orders WHERE id='order-17'")).rows[0].status, 'active');
  const retried = await executeAirDocument(air, { ...common, effectJournal: journal() });
  assert.equal(retried.status, 'success', JSON.stringify(retried.trace));
  const [original] = journal().entriesForScope(common.effectScopeId);
  assert.equal(original.state, 'applied'); assert.equal(original.attempt_count, 2);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1);
  const replay = await executeAirDocument(air, { ...common, effectJournal: journal() });
  assert.equal(replay.status, 'success'); assert.equal(journal().entriesForScope(common.effectScopeId)[0].attempt_count, 2);
  const divergent = await executeAirDocument(air, { ...common, inputs: { order_id: 'another-order' }, effectJournal: journal() });
  assert.equal(divergent.status, 'failure');
  assert.ok(divergent.trace.events.some(event => JSON.stringify(event).includes('EffectRequestConflict')));
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1);
  const reconciled = await executeAirDocument(air, { ...common, entryRef: 'strategy:pilot/Reconcile' });
  assert.equal(reconciled.status, 'success'); assert.equal(reconciled.result, 'active');
  const compensationOptions = { airDocument: air, toolBindingManifest: manifest, effectJournal: journal(), secretStore,
    compensationStore: createSqliteCompensationStore(compensationPath, { secretValues: [connection] }),
    compensationAuthorityProvider: { check: () => true }, compensationAuthorityTimeoutMs: 250 };
  const command = { compensation_request_id: 'request:release-order-17', compensates_effect_id: original.effect_id,
    requester_ref: 'principal:test', journal_scope_ref: 'effect-journal:orders' };
  const compensated = await createCompensation(command, compensationOptions);
  assert.equal(compensated.record.result, 'completed', JSON.stringify(compensated));
  assert.equal((await admin.query("SELECT status FROM orders WHERE id='order-17'")).rows[0].status, 'released');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM touba_sql_effects')).rows[0].n, 2);
  const compensatedAgain = await createCompensation(command, compensationOptions);
  assert.equal(compensatedAgain.trace, null);
  const denied = structuredClone(manifest); denied.bindings['tool:touba.http_api/Read'].grants = [];
  const previousReads = reads;
  const refusal = await executeAirDocument(air, { ...common, toolBindingManifest: denied, effectJournal: journal() });
  assert.equal(refusal.status, 'failure'); assert.equal(reads, previousReads);
  const evidence = [readFileSync(journalPath), readFileSync(compensationPath),
    JSON.stringify([interrupted.trace, retried.trace, replay.trace, reconciled.trace, compensated.trace])].join('\n');
  assert.equal(evidence.includes(connection), false);
});
