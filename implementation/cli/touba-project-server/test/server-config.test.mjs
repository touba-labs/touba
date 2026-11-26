import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, linkSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandServerConfig, serverConfigArguments } from '../src/server-config.mjs';
import { initProject, newModule } from '../../touba-project/src/project.mjs';
import { fileURLToPath } from "node:url";


function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba server config ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = value => writeFileSync(join(root, 'touba.server.json'), JSON.stringify(value));
  const profile = { schema_version: 'touba-project-server-config-v1', host: '127.0.0.1', port: 0,
    identity_control_plane_url: 'https://account.example.test/api/v1/studio', identity_service_token_env: 'QA_SERVICE_TOKEN',
    schedule_triggers: false, cloud_notifications: true, validation_plan: 'tests/validation.json' };
  write(profile);
  return { root, profile, write };
}

test('explicit profile resolves project paths, carries environment names and preserves disabled features', t => {
  const { root, profile } = fixture(t);
  const args = expandServerConfig(['--config', 'touba.server.json', '--project-root', root]);
  assert.deepEqual(args, ['--host', '127.0.0.1', '--port', '0',
    '--identity-control-plane-url', profile.identity_control_plane_url, '--identity-service-token-env', 'QA_SERVICE_TOKEN',
    '--cloud-notifications', '--validation-plan', join(root, 'tests/validation.json'), '--project-root', root]);
  assert.deepEqual(expandServerConfig(['--port', '8792'], root), ['--port', '8792']);
  assert.deepEqual(readdirSync(root), ['touba.server.json'], 'profile loading creates no state and starts no process');
  assert.deepEqual(serverConfigArguments(root, { schema_version: profile.schema_version, package_hosts: true }), ['--package-hosts']);
});

test('project webhook profile carries only its secret reference and requires it when enabled',t=>{
  const {root,profile}=fixture(t);
  assert.deepEqual(serverConfigArguments(root,{schema_version:profile.schema_version,request_triggers:true,webhook_signature_secret_env:'WEBHOOK_SIGNING_KEY'}),['--request-triggers','--webhook-signature-secret-env','WEBHOOK_SIGNING_KEY']);
  assert.throws(()=>serverConfigArguments(root,{...profile,request_triggers:true}),{code:'ToubaServeConfigInvalid',field:'webhook_signature_secret_env'});
  assert.throws(()=>serverConfigArguments(root,{...profile,webhook_signature_secret_env:'actual secret value'}),{code:'ToubaServeConfigInvalid'});
});

test('profiles reject credential values, commands, paths, endpoint injection and conflicting options', t => {
  const { root, profile, write } = fixture(t);
  for (const extra of [{ token: 'must-not-be-stored' }, { command: 'shell' }, { validation_plan: '../outside.json' },
    { validation_plan: '/outside.json' }, { validation_plan: 'test\\other.json' }, { validation_plan: 'tests//x.json' },
    { identity_service_token_env: 'NAME; command' }, { identity_control_plane_url: 'https://u:secret@example.test' },
    { identity_control_plane_url: 'http://remote.example.test' }, { identity_control_plane_url: 'https://x.test?token=x' },
    { client_origins: ['http://127.0.0.1:4180'] }, { client_origins: ['https://x.test/path'] }, { port: 70000 },
    { package_registry: 'https://registry.example.test' }, { package_hosts: true, human_approval_host: 'host.mjs' }]) {
    assert.throws(() => serverConfigArguments(root, { ...profile, ...extra }), { code: 'ToubaServeConfigInvalid' });
  }
  for (const args of [['--port', '8792'], ['--port=8792'], ['--schedule-triggers'], ['--config', 'touba.server.json']]) {
    assert.throws(() => expandServerConfig(['--config', 'touba.server.json', ...args], root), { code: 'ToubaServeConfigInvalid' });
  }
  assert.throws(() => expandServerConfig(['--config', 'touba.server.json', '--port', '8792'], root), error => {
    assert.equal(error.code, 'ToubaServeConfigInvalid');
    assert.equal(error.field, 'port');
    assert.equal(error.reason, 'duplicate_option');
    assert.match(error.message, /already set by --config/);
    assert.match(error.message, /remove the duplicate/);
    return true;
  });
  write({ ...profile, host: ['127.0.0.1'] });
  assert.throws(() => expandServerConfig(['--config', 'touba.server.json'], root), { code: 'ToubaServeConfigInvalid' });
});

test('profile and referenced paths reject links and unbounded files', t => {
  const { root, profile, write } = fixture(t);
  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'linked'));
  assert.throws(() => serverConfigArguments(root, { ...profile, validation_plan: 'linked/plan.json' }), { code: 'ToubaServeConfigInvalid' });
  symlinkSync(join(root, 'touba.server.json'), join(root, 'link.json'));
  assert.throws(() => expandServerConfig(['--config', 'link.json'], root), { code: 'ToubaServeConfigInvalid' });
  linkSync(join(root, 'touba.server.json'), join(root, 'hard.json'));
  assert.throws(() => expandServerConfig(['--config', 'hard.json'], root), { code: 'ToubaServeConfigInvalid' });
  rmSync(join(root, 'hard.json'));
  writeFileSync(join(root, 'touba.server.json'), ' '.repeat(32769));
  assert.throws(() => expandServerConfig(['--config', 'touba.server.json'], root), { code: 'ToubaServeConfigInvalid' });
  write(profile);
});

test('real CLI loads a profile during offline preflight without executing its host', t => {
  const { root, profile, write } = fixture(t);
  writeFileSync(join(root, 'host.mjs'), 'throw new Error("must-not-be-imported");');
  write({ ...profile, human_approval_host: 'host.mjs' });
  const raw = execFileSync(process.execPath, [fileURLToPath(new URL('../src/serve.mjs', import.meta.url)),
    '--project-root', root, '--config', 'touba.server.json', '--check-state'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(JSON.parse(raw).status, 'structurally_valid');
  assert.deepEqual(readdirSync(root).sort(), ['host.mjs', 'touba.server.json']);
});

test('real CLI starts and stops a project from its explicit profile', { timeout: 30000 }, async t => {
  const { root, write } = fixture(t);
  initProject({ root, language: 'javascript' });
  newModule('config.demo', { root });
  write({ schema_version: 'touba-project-server-config-v1', host: '127.0.0.1', port: 0,
    schedule_triggers: false, cloud_notifications: false });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/serve.mjs', import.meta.url)),
    '--project-root', root, '--config', 'touba.server.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  });
  const started = await new Promise((resolve, reject) => {
    let output = '';
    const deadline = setTimeout(() => reject(new Error('project server startup timed out')), 20000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', () => { clearTimeout(deadline); reject(new Error(stderr)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) {
        clearTimeout(deadline);
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
  });
  assert.equal(started.event, 'touba_project_server_started');
  assert.equal(started.project_root, root);
  assert.equal(started.host, '127.0.0.1');
  assert.ok(started.port > 0);
  const response = await fetch(`http://127.0.0.1:${started.port}/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  child.kill('SIGTERM');
  await exited;
});
