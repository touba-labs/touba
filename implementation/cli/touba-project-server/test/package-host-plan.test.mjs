import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { newPackage, packPackage, addPackage } from '../../touba-project/src/packages.mjs';
import { initProject, prepareProject } from '../../touba-project/src/project.mjs';
import { packageHostInventory, readPackageHostPlan, validatePackageHostPlan } from '../../touba-project/src/package-host-plan.mjs';
import { createHostModuleLoader } from '../../touba-run/src/host-modules.mjs';
import { proposeProjectChange, applyProjectChange } from '../src/serve.mjs';
import { createProjectPackageSurface } from '../src/package-surface.mjs';
import { validateObject } from '../../../contracts/product-surfaces/validate.mjs';
import schema from '../../../contracts/product-surfaces/schemas/touba-project-packages-v1.schema.json' with { type: 'json' };

test('host plan is reviewed without executing code; explicit next-start loader rechecks package integrity', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-host-plan-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'consumer'); initProject({ root: project });
  // Isolated SDK source installation, like the package-host transport tests.
  // No network, no user interpreter/package environment is modified.
  const python = process.env.TOUBA_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const venv = spawnSync(python, ['-m', 'venv', '--without-pip', join(project, '.venv')], { encoding: 'utf8' });
  assert.equal(venv.status, 0, venv.stderr);
  const interpreter = join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const site = spawnSync(interpreter, ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { encoding: 'utf8' });
  assert.equal(site.status, 0, site.stderr);
  cpSync(fileURLToPath(new URL('../../../runtime/touba-python-sdk/src/touba_sdk', import.meta.url)), join(site.stdout.trim(), 'touba_sdk'), { recursive: true });
  const marker = join(root, 'executed');
  const pythonMarker = join(root, 'python-executed');
  const pkg = newPackage('fixture.identity', { root, publisher: 'Fixture', description: 'Isolated host', license: 'Apache-2.0', version: '1.0.0' });
  mkdirSync(join(pkg.path, 'host'));
  writeFileSync(join(pkg.path, 'host/decision.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export function decideAgentCapability() { return { action: 'answer_directly', result: 'reviewed' }; }`);
  writeFileSync(join(pkg.path, 'host/approval.py'), `from pathlib import Path\nPath(${JSON.stringify(pythonMarker)}).write_text("loaded")\ndef attest_human_approval(payload):\n    return {"fixture": "python-host"}\n`);
  const manifest = JSON.parse(readFileSync(join(pkg.path, 'touba.package.json')));
  Object.assign(manifest, { exports: {}, files: ['host', 'README.md'], contract_tests: [], hosts: [
    { id: 'decision', kind: 'decision_provider', path: 'host/decision.mjs' },
    { id: 'approval', kind: 'human_approval', path: 'host/approval.py' },
  ] });
  writeFileSync(join(pkg.path, 'touba.package.json'), JSON.stringify(manifest));
  const archive = await packPackage(pkg.path, { output: join(root, 'hosts.tar.gz') });
  await addPackage(archive.output, { root: project });
  const inventory = packageHostInventory(project);
  assert.equal(inventory.hosts.length, 2);
  assert.deepEqual(new Set(inventory.hosts.map(host => host.language)), new Set(['javascript', 'python']));
  const plan = { schema_version: 'touba-package-host-plan-v1', package_lock_digest: inventory.package_lock_digest,
    hosts: { decision_provider: 'pkg:fixture.identity/decision', human_approval: 'pkg:fixture.identity/approval' } };
  const options = { projectRoot: project, changeProposalsPath: join(project, '.touba/project-change-proposals.sqlite') };
  assert.equal(readPackageHostPlan(project), null);
  assert.throws(() => readPackageHostPlan(project, { required: true }), { code: 'PackageHostPlanInvalid' });
  for (const invalid of [ { ...plan, grants: ['network'] }, { ...plan, package_lock_digest: 'sha256:changed' },
    { ...plan, hosts: { human_approval: 'pkg:fixture.identity/decision' } },
    { ...plan, hosts: { decision_provider: '/tmp/foreign.mjs' } } ]) {
    assert.throws(() => validatePackageHostPlan(invalid, project), { code: 'PackageHostPlanInvalid' });
  }
  proposeProjectChange({ ...options, proposal: { schema_version: 'touba-project-change-proposal-v1', proposal_id: 'review-hosts',
    action: 'write_text_file', target: { path: 'touba.hosts.json' }, requested_by: { kind: 'studio', id: 'reviewer' },
    reason: 'Explicit operator restart', content: JSON.stringify(plan) } });
  assert.equal(readPackageHostPlan(project), null);
  applyProjectChange({ ...options, applyRequest: { schema_version: 'touba-project-change-apply-v1', proposal_id: 'review-hosts', decision: 'apply', decided_by: { kind: 'studio', id: 'owner' } } });
  assert.deepEqual(readPackageHostPlan(project), plan);
  const surface = createProjectPackageSurface(project); t.after(() => surface.close());
  assert.deepEqual(validateObject(schema, surface.inventory()), []);
  assert.equal(existsSync(marker), false, 'install, list, review and apply never load host code');
  assert.equal(existsSync(pythonMarker), false);
  const loader = createHostModuleLoader(); t.after(() => loader.close());
  const loadedPlan = readPackageHostPlan(project, { required: true });
  assert.equal((await loader.decisionProvider(loadedPlan.hosts.decision_provider, { projectRoot: project }))().result, 'reviewed');
  assert.equal(existsSync(marker), true);
  const approval = await loader.approvalHost(loadedPlan.hosts.human_approval, { projectRoot: project });
  assert.deepEqual(await approval.humanApprovalAuthority({}), { fixture: 'python-host' });
  assert.equal(existsSync(pythonMarker), true);
  rmSync(marker);
  rmSync(pythonMarker);
  mkdirSync(join(project, 'src/fixture'), { recursive: true });
  writeFileSync(join(project, 'src/fixture/host.tb'), `module fixture.host
agent Answer
    gives Text
    responsibility "Return the configured answer."
    callable_by strategy Run
strategy Run
    gives Text
    uses Answer
    do
        Answer
            into answer
        give answer
`);
  const configPath = join(project, 'touba.project.json');
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath)), entry: 'strategy:fixture.host/Run' }));
  assert.equal((await prepareProject({ root: project, mode: 'write' })).status, 'success');
  for (const activate of [false, true]) {
    // The actual public CLI is restarted, not an in-process loader surrogate.
    const cli = new URL('../../touba-project/src/main.mjs', import.meta.url).pathname;
    const child = spawn(process.execPath, [cli, 'serve', '--project-root', project, '--port', '0', ...(activate ? ['--package-hosts'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close'); let errors = '', output = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
    try {
      const started = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI startup timeout: ' + errors)), 15000);
        child.once('exit', () => { clearTimeout(timer); reject(new Error('CLI exited: ' + errors)); });
        child.stdout.on('data', chunk => {
          output += chunk;
          for (const line of output.split('\n')) {
            try { const event = JSON.parse(line); if (event.event === 'touba_project_server_started') { clearTimeout(timer); resolve(event); } } catch {}
          }
        });
      });
      assert.equal(existsSync(marker), activate, 'reviewed host loads only on explicit CLI activation');
      assert.equal(existsSync(pythonMarker), activate, 'Python host also requires explicit CLI activation');
      if (activate) {
        const response = await fetch(`http://127.0.0.1:${started.port}/runs/sandbox`, { method: 'POST',
          signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            schema_version: 'touba-sandbox-run-request-v1', execution_kind: 'entrypoint', target_ref: 'strategy:fixture.host/Run',
            inputs: {}, effect_policy: 'runtime_only', requested_by: { kind: 'service', id: 'fixture' }, reason: 'Check reviewed startup plan',
          }) });
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.equal(result.status, 'success', JSON.stringify(result));
        assert.equal(result.result, 'reviewed');
      }
    } finally {
      child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      await closed; clearTimeout(deadline);
    }
  }
  const planPath = join(project, 'touba.hosts.json');
  writeFileSync(planPath, JSON.stringify({ ...plan, package_lock_digest: 'sha256:' + '0'.repeat(64) }));
  assert.throws(() => readPackageHostPlan(project), { code: 'PackageHostPlanInvalid' });
  assert.equal(surface.inventory().host_plan_error.code, 'PackageHostPlanInvalid');
  writeFileSync(planPath, JSON.stringify(plan));
  writeFileSync(join(project, 'packages/fixture.identity/host/decision.mjs'), 'throw new Error("altered")');
  assert.throws(() => readPackageHostPlan(project), /changed|digest|integrity|drift/i);
  rmSync(planPath); symlinkSync(join(root, 'hosts.tar.gz'), planPath);
  assert.throws(() => readPackageHostPlan(project), { code: 'PackageSymlinkForbidden' });
});
