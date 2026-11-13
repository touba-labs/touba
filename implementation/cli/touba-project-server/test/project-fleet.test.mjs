import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectFleet, assertFleetReview } from '../src/project-fleet.mjs';
import { createFleetSupervisor } from '../src/fleet-supervisor.mjs';
import { fleetUpgrade } from '../src/fleet-upgrade.mjs';
import { acquireStateLease, archiveProjectState } from '../src/state-maintenance.mjs';
import { checkToubaProjectState } from '../src/serve.mjs';
import { initProject } from '../../touba-project/src/project.mjs';
import { createInteractionSession, enqueueInteractionOperation } from '../src/interactions.mjs';
import { fleetCommand, renderFleetReport } from '../src/fleet-command.mjs';
import { EventEmitter } from 'node:events';
import { validateObject } from '../../../contracts/product-surfaces/validate.mjs';

function contract(value) {
  const path = new URL(`../../../contracts/product-surfaces/schemas/${value.schema_version}.schema.json`, import.meta.url);
  assert.deepEqual(validateObject(JSON.parse(readFileSync(path)), value), []);
}

test('unconfirmed termination is bounded and keeps ownership for a retry', async t => {
  const f = setup(t), processes = [];
  const supervisor = createFleetSupervisor({ cli: { command: 'fixture', args: [] }, stopTimeout: 5,
    spawnImpl: () => { const child = new EventEmitter(); child.kill = () => { throw new Error('denied'); }; processes.push(child); return child; } });
  await supervisor.start(f.file, readProjectFleet(f.file).review_digest);
  await supervisor.stop();
  assert.ok(supervisor.status().every(item => item.status === 'stop_failed'));
  await assert.rejects(supervisor.start(f.file, readProjectFleet(f.file).review_digest), /Busy/);
  for (const child of processes) child.kill = () => { child.emit('exit', 0); return true; };
  await supervisor.stop();
  assert.ok(supervisor.status().every(item => item.status === 'stopped'));
});

function setup(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'touba-fleet-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projects = ['one', 'two'].map((id, index) => {
    const root = join(directory, id); mkdirSync(root); initProject({ root });
    mkdirSync(join(root, 'src/app'), { recursive: true });
    writeFileSync(join(root, 'src/app/main.tb'), 'module app.main\nskill Hello\n    gives Text\n    do\n        give "hello"\n');
    writeFileSync(join(root, 'touba.server.json'), JSON.stringify({ schema_version: 'touba-project-server-config-v1', host: '127.0.0.1', port: 28800 + index }));
    return { id, root, config: 'touba.server.json' };
  });
  const file = join(directory, 'fleet.json');
  const write = value => writeFileSync(file, JSON.stringify(value));
  write({ schema_version: 'touba-project-fleet-v1', projects });
  return { directory, projects, file, write };
}

test('fleet allowlist rejects duplicate roots, ports, changed profiles and unknown commands', async t => {
  const f = setup(t), plan = readProjectFleet(f.file);
  contract(JSON.parse(readFileSync(f.file))); contract(plan);
  assert.equal(plan.projects.length, 2);
  assert.equal(assertFleetReview(f.file, plan.review_digest).review_digest, plan.review_digest);
  const profile = join(f.projects[1].root, 'touba.server.json');
  const original = readFileSync(profile, 'utf8');
  writeFileSync(profile, original.replace('28801', '28800'));
  assert.throws(() => readProjectFleet(f.file), { code: 'ToubaFleetPortConflict' });
  writeFileSync(profile, original.replace('28801', '28802'));
  assert.throws(() => assertFleetReview(f.file, plan.review_digest), { code: 'ToubaFleetReviewRequired' });
  f.write({ schema_version: 'touba-project-fleet-v1', projects: [f.projects[0], { ...f.projects[0], id: 'other' }] });
  assert.throws(() => readProjectFleet(f.file), { code: 'ToubaFleetConfigInvalid' });
  assert.equal((await fleetCommand(['--help'])).exitCode, 0);
  await assert.rejects(fleetCommand(['start', '--config', f.file]), {code:'ToubaFleetReviewRequired'});
  assert.match((await fleetCommand(['--help'])).text,/--json/);
});

test('supervisor owns two real synthetic processes and stops only these children', async t => {
  const f = setup(t), events = [];
  const supervisor = createFleetSupervisor({ cli: { command: process.execPath,
    args: ['-e', 'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000)', '--'] }, notify: value => events.push(value) });
  t.after(() => supervisor.stop());
  await supervisor.start(f.file, readProjectFleet(f.file).review_digest);
  for (let i = 0; i < 50 && supervisor.status().some(item => item.status !== 'running'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(supervisor.status().filter(item => item.status === 'running').length, 2);
  await assert.rejects(supervisor.start(f.file, readProjectFleet(f.file).review_digest), /Busy/);
  await supervisor.stop();
  assert.equal(supervisor.status().filter(item => item.status === 'stopped').length, 2);
  assert.equal(events.filter(item => item.status === 'starting').length, 2);
});

test('supervisor retains a bounded known startup diagnosis without copying stderr secrets', async t => {
  const f=setup(t),events=[];
  const supervisor=createFleetSupervisor({cli:{command:process.execPath,args:['-e',
    'process.stderr.write("secret-never-record-this\\nproject server error [ToubaServePortInUse]: private path");process.exit(2);','--']},notify:event=>events.push(event)});
  t.after(()=>supervisor.stop());
  await supervisor.start(f.file,readProjectFleet(f.file).review_digest);
  for(let i=0;i<100&&supervisor.status().some(row=>row.status!=='exited');i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(supervisor.status().every(row=>row.code==='ToubaServePortInUse'));
  assert.equal(JSON.stringify(events).includes('secret-never-record-this'),false);
  assert.equal(JSON.stringify(events).includes('private path'),false);
});

test('deployment targets are explicitly reviewed, bounded and share the port namespace', async t => {
  const f = setup(t), storage = join(f.directory, 'deployment'); mkdirSync(storage);
  const target = { id: 'target', storage, port: 28802, auth_token_env: 'QA_DEPLOY_TOKEN' };
  f.write({ schema_version: 'touba-project-fleet-v1', projects: f.projects, deployment_targets: [target] });
  const plan = readProjectFleet(f.file);
  assert.equal(plan.deployment_targets[0].storage, storage);
  const human=renderFleetReport(plan);
  assert.ok(human.includes('target: deployment target'));
  assert.ok(human.includes(storage));
  assert.ok(human.includes('Target build:'));
  const calls = [], supervisor = createFleetSupervisor({ cli: { command: 'fixture', args: [] }, stopTimeout: 5,
    spawnImpl: (command, args) => { calls.push(args); const child = new EventEmitter(); child.kill = () => { child.emit('exit', 0); return true; }; return child; } });
  await supervisor.start(f.file, plan.review_digest); await supervisor.stop();
  assert.deepEqual(calls[0], ['deploy','target','serve','--storage',storage,'--host','127.0.0.1','--port','28802','--auth-token-env','QA_DEPLOY_TOKEN']);
  for (const changed of [{ port:28800 }, { auth_token_env:'SECRET; command' }, { auth_token:'value' }]) {
    f.write({ schema_version: 'touba-project-fleet-v1', projects: f.projects, deployment_targets: [{ ...target,...changed }] });
    assert.throws(() => readProjectFleet(f.file));
  }
});

test('upgrade blocks only the project with an active operation and prepares the other without executing it', async t => {
  const f = setup(t), [blocked, ready] = f.projects;
  const path = join(blocked.root, '.touba/interaction-sessions.sqlite');
  const session = createInteractionSession({ sessionsPath: path, request: { target_ref: 'skill:app.main/Hello', target_kind: 'skill', presentation: 'conversation', effect_policy: 'runtime_only', requested_by: { kind: 'studio', id: 'fixture' } } });
  enqueueInteractionOperation({ sessionsPath: path, sessionId: session.session_id, runId: 'waiting', message: { message_id: 'm', display_text: 'hello', attachments: [], requested_by: { kind: 'studio', id: 'fixture' } } });
  const before = readFileSync(path), installs = [];
  writeFileSync(join(ready.root, '.touba/current-run-summary.json'), '{}\n');
  const upgrade = fleetUpgrade({ sdk: () => ({ name: '@touba/sdk', version: 'fixture', sha256: 'a'.repeat(64) }),
    install: (language, options) => { installs.push([language, options.root]); } });
  const plan = upgrade.plan(f.file);
  contract(plan);
  const human=renderFleetReport(plan);
  assert.match(human,/SDK: @touba\/sdk@fixture/);
  assert.match(human,/State: \d+ files to archive/);
  assert.equal(plan.projects[0].code, 'ToubaStateNotQuiescent'); assert.equal(plan.projects[1].status, 'ready');
  const result = await upgrade.apply(f.file, plan.review_digest);
  contract(result);
  assert.equal(result.projects[0].status, 'blocked'); assert.equal(result.projects[1].status, 'complete', JSON.stringify(result));
  assert.deepEqual(installs, [['javascript', ready.root]]); assert.deepEqual(readFileSync(path), before);
  const receipt = JSON.parse(readFileSync(join(ready.root, '.touba/fleet-upgrade.json')));
  contract(receipt);
  assert.deepEqual(JSON.parse(readFileSync(join(ready.root, '.touba/fleet-upgrade-receipts', receipt.id + '.json'))), receipt);
  assert.equal(receipt.status, 'complete'); assert.ok(receipt.archive_id);
  assert.equal(readFileSync(join(ready.root, '.touba/state-archives', receipt.archive_id, 'current-run-summary.json'), 'utf8'), '{}\n');
});

test('upgrade refuses stale sources, live servers and forged held leases', async t => {
  const f = setup(t), options = { projectRoot: f.projects[0].root };
  const upgrade = fleetUpgrade({ sdk: () => ({ name: 'fixture', version: '1', sha256: 'a'.repeat(64) }), install: () => { throw new Error('must not run'); } });
  const plan = upgrade.plan(f.file);
  writeFileSync(join(f.projects[0].root, 'src/app/main.tb'), 'module app.main\n');
  await assert.rejects(upgrade.apply(f.file, plan.review_digest), { code: 'ToubaFleetReviewRequired' });
  const release = acquireStateLease(options.projectRoot);
  try {
    assert.equal(upgrade.plan(f.file).projects[0].code, 'ToubaStateInUse');
    assert.throws(() => archiveProjectState(options, checkToubaProjectState, () => {}), { code: 'ToubaStateLeaseInvalid' });
  } finally { release(); }
  assert.throws(() => archiveProjectState(options, checkToubaProjectState, release), { code: 'ToubaStateLeaseInvalid' });
});
