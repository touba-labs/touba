import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { initProject } from '../../touba-project/src/project.mjs';
import { createToubaProjectServer, requiredIdentityPermission } from '../src/serve.mjs';

test('webhook observation shares execution read authority while review remains separate', () => {
  assert.equal(requiredIdentityPermission('GET', '/triggers/webhooks'), 'executions.read');
  assert.equal(requiredIdentityPermission('POST', '/triggers/webhooks/review'), 'governance.apply');
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`CLI ${signal} closes two streams and releases the server lease`, { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-cli-stop-')); initProject({ root });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../touba-project/src/main.mjs', import.meta.url)),
    'serve', '--project-root', root, '--port', '0', '--auth-token-env', 'TOUBA_CLI_STOP_TEST'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TOUBA_CLI_STOP_TEST: 'synthetic-cli-stop-token' } });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    // Only the isolated process group created by this test, never another server.
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await delay(30); rmSync(root, { recursive: true, force: true });
  });
  let start;
  for (let i = 0; i < 100 && !start; i++) {
    for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.event === 'touba_project_server_started') start = value; } catch {} }
    if (!start) await delay(30);
  }
  assert.ok(start, errors || output);
  const readers = await Promise.all([1, 2].map(async () => {
    const response = await fetch(`http://127.0.0.1:${start.port}/events`, { headers: { authorization: 'Bearer synthetic-cli-stop-token' } });
    assert.equal(response.status, 200); const reader = response.body.getReader(); await reader.read(); return reader;
  }));
  process.kill(-child.pid, signal);
  for (let i = 0; i < 100 && existsSync(join(root, '.touba/server-state.lock')); i++) await delay(20);
  assert.equal(existsSync(join(root, '.touba/server-state.lock')), false);
  for (const reader of readers) assert.equal((await reader.read()).done, true);
  assert.deepEqual(await exited, { code: null, signal });
  const restarted = createToubaProjectServer({ projectRoot: root, port: 0, quiet: true });
  await restarted.start(); await restarted.stop();
});

test('stop closes two event streams and releases its state lease without client cooperation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-stream-stop-'));
  initProject({ root });
  const identity = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ active: true, user: { id: 'reader' }, permissions: ['projects.read', 'executions.read'], project_root: root, session_id: 'stream-test' }));
  });
  await new Promise(resolve => identity.listen(0, '127.0.0.1', resolve));
  t.after(async () => { identity.closeAllConnections(); await new Promise(resolve => identity.close(resolve)); });
  const service = createToubaProjectServer({ projectRoot: root, host: '127.0.0.1', port: 0, quiet: true,
    identityControlPlaneUrl: `http://127.0.0.1:${identity.address().port}`, identityServiceToken: 'synthetic-service-token-for-stream-test' });
  t.after(async () => { service.server.closeAllConnections(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const url = `http://127.0.0.1:${service.server.address().port}/events`;
  const observed = await fetch(url.replace('/events', '/triggers/webhooks'), { headers: { 'x-touba-identity-token': 'synthetic-reader' } });
  assert.equal(observed.status, 200);
  await observed.json();
  const readers = await Promise.all([1, 2].map(async () => {
    const response = await fetch(url, { headers: { 'x-touba-identity-token': 'synthetic-reader' } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /touba.server.ready/);
    return reader;
  }));
  await delay(30); // Complete incoming GET messages while outgoing SSE stays open.
  assert.throws(() => createToubaProjectServer({ projectRoot: root, port: 0, quiet: true }), { code: 'ToubaStateInUse' });
  const stopped = await Promise.race([service.stop().then(() => true), delay(1500).then(() => false)]);
  assert.equal(stopped, true, 'server must not wait for clients to close their pages');
  assert.equal(existsSync(join(root, '.touba/server-state.lock')), false);
  for (const reader of readers) assert.equal((await reader.read()).done, true);
  const next = createToubaProjectServer({ projectRoot: root, port: 0, quiet: true });
  await next.start(); await next.stop();
});

test('authorization finishing during shutdown cannot open a late event stream', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-stop-admission-')); initProject({ root });
  let accept, release;
  const received = new Promise(resolve => { accept = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const identity = createServer(async (_request, response) => {
    accept(); await gate;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ active: true, user: { id: 'reader' }, permissions: ['projects.read', 'executions.read'], project_root: root, session_id: 'late' }));
  });
  await new Promise(resolve => identity.listen(0, '127.0.0.1', resolve));
  const service = createToubaProjectServer({ projectRoot: root, host: '127.0.0.1', port: 0, quiet: true,
    identityControlPlaneUrl: `http://127.0.0.1:${identity.address().port}`, identityServiceToken: 'synthetic-service-token-for-stream-test' });
  t.after(async () => { release(); service.server.closeAllConnections(); await service.stop(); identity.closeAllConnections();
    await new Promise(resolve => identity.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const request = fetch(`http://127.0.0.1:${service.server.address().port}/events`, { headers: { 'x-touba-identity-token': 'synthetic-reader' } });
  await received;
  const stopped = service.stop();
  await delay(20); release();
  const response = await request;
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'ToubaServeStopping');
  assert.equal(await Promise.race([stopped.then(() => true), delay(1500).then(() => false)]), true);
  assert.equal(existsSync(join(root, '.touba/server-state.lock')), false);
});
